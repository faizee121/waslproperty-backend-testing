import type { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { getObjectBytes } from '../../lib/s3.js';
import { recordActivity } from '../activity/activity.js';
import { assembleStrataPlanExtraction } from './nsw-strata-plan/assemble.js';
import { classificationConfidenceLevel } from './nsw-strata-plan/confidence.js';
import { classifyNswStrataPlan } from './nsw-strata-plan/classifier.js';
import { seedDraftFromExtraction, validateDraft } from './nsw-strata-plan/draft.js';
import {
  InterpretationFailedError,
  InterpretationUnavailableError,
  interpretStrataPlan,
} from './nsw-strata-plan/interpreter.js';
import { runVisionFallbackIfNeeded } from './nsw-strata-plan/vision-fallback.js';
import { PdfOcrExtractionProvider } from './providers/pdf-ocr-extraction.provider.js';
import type { DocumentExtractionProvider } from './extraction-provider.interface.js';

const extractionProvider: DocumentExtractionProvider = new PdfOcrExtractionProvider();

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * The async analysis lifecycle — classify -> extract pages -> interpret ->
 * validate -> persist. No queue infrastructure exists in this stack (see
 * the M15 report's honest documentation of this), so this runs as a
 * single-process, fire-and-forget background task kicked off right after
 * upload (see property-documents.service.ts). The durable state is the DB
 * row itself: PropertyDocument.status is what a polling frontend reads,
 * and DocumentAnalysis is the append-only record of this attempt. A
 * server restart mid-run leaves the document stuck in ANALYSING — see
 * PropertyDocumentsService's "stuck analysis" self-healing read-path
 * check, the documented mitigation for not having real job recovery.
 */
export async function runStrataPlanAnalysis(
  prisma: PrismaClient,
  propertyDocumentId: string,
): Promise<void> {
  const document = await prisma.propertyDocument.findUnique({ where: { id: propertyDocumentId } });
  if (!document) return;

  const analysis = await prisma.documentAnalysis.create({
    data: {
      organisationId: document.organisationId,
      propertyDocumentId: document.id,
      status: 'RUNNING',
      startedAt: new Date(),
    },
  });

  await prisma.propertyDocument.update({
    where: { id: document.id },
    data: { status: 'ANALYSING' },
  });
  await recordActivity(prisma, {
    organisationId: document.organisationId,
    actorUserId: document.uploadedByUserId,
    eventType: 'STRATA_PLAN_ANALYSIS_STARTED',
    entityType: 'PropertyDocument',
    entityId: document.id,
    title: `Analysis started for ${document.fileName}`,
  });

  try {
    await withTimeout(
      runPipeline(prisma, document.organisationId, document.id, document.storageKey, analysis.id),
      env.DOCUMENT_ANALYSIS_TOTAL_TIMEOUT_MS,
      'Document analysis',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown analysis error';
    await prisma.documentAnalysis.update({
      where: { id: analysis.id },
      data: { status: 'FAILED', errorMessage: message, completedAt: new Date() },
    });
    await prisma.propertyDocument.update({
      where: { id: document.id },
      data: { status: 'FAILED' },
    });
    await recordActivity(prisma, {
      organisationId: document.organisationId,
      actorUserId: document.uploadedByUserId,
      eventType: 'STRATA_PLAN_ANALYSIS_FAILED',
      entityType: 'PropertyDocument',
      entityId: document.id,
      title: `Analysis failed for ${document.fileName}`,
      description: message,
    });
  }
}

async function runPipeline(
  prisma: PrismaClient,
  organisationId: string,
  propertyDocumentId: string,
  storageKey: string,
  analysisId: string,
): Promise<void> {
  const bytes = await getObjectBytes(storageKey);

  const extraction = await extractionProvider.extract(bytes, env.DOCUMENT_ANALYSIS_MAX_PAGES);

  const classification = classifyNswStrataPlan(extraction.pages);
  if (classification.documentType === null) {
    await prisma.documentAnalysis.update({
      where: { id: analysisId },
      data: {
        status: 'FAILED',
        classifiedDocumentType: null,
        classificationConfidence: classification.confidence,
        classificationEvidence: classification.evidence,
        extractionProvider: extractionProvider.name,
        ocrEngine: extraction.engine,
        errorMessage: "We couldn't confidently identify this as a supported NSW Strata Plan.",
        completedAt: new Date(),
      },
    });
    await prisma.propertyDocument.update({
      where: { id: propertyDocumentId },
      data: { status: 'FAILED', pageCount: extraction.pageCount },
    });
    return;
  }

  let rawInterpretation;
  try {
    rawInterpretation = await interpretStrataPlan(extraction.pages);
  } catch (err) {
    if (err instanceof InterpretationUnavailableError || err instanceof InterpretationFailedError) {
      await prisma.documentAnalysis.update({
        where: { id: analysisId },
        data: {
          status: 'FAILED',
          classifiedDocumentType: classification.documentType,
          classificationConfidence: classification.confidence,
          classificationEvidence: classification.evidence,
          extractionProvider: extractionProvider.name,
          ocrEngine: extraction.engine,
          errorMessage: err.message,
          completedAt: new Date(),
        },
      });
      await prisma.propertyDocument.update({
        where: { id: propertyDocumentId },
        data: { status: 'FAILED', pageCount: extraction.pageCount },
      });
      return;
    }
    throw err;
  }

  const ocrOnlyExtraction = assembleStrataPlanExtraction(rawInterpretation, extraction.pages);

  // Bounded AI-vision fallback — only runs when a critical field (the
  // entitlement schedule, plan number, or address) is missing/unreliable
  // AND vision was explicitly configured (DOCUMENT_ANALYSIS_VISION_ENABLED).
  // See nsw-strata-plan/vision-fallback.ts for the full trigger/merge/
  // confidence policy. Never throws — a vision failure just leaves the
  // OCR-only extraction in place, with visionAssist.outcome = FAILED.
  const { extraction: structuredExtraction, visionAssist } = await runVisionFallbackIfNeeded({
    pdfBytes: bytes,
    extraction: ocrOnlyExtraction,
    ocrRotationDeg: extraction.ocrRotationDeg,
  });

  const draft = seedDraftFromExtraction(structuredExtraction);
  const draftValidation = validateDraft(draft);

  await prisma.documentAnalysis.update({
    where: { id: analysisId },
    data: {
      status: 'SUCCEEDED',
      classifiedDocumentType: classification.documentType,
      classificationConfidence: classification.confidence,
      classificationEvidence: classification.evidence,
      extraction: structuredExtraction as unknown as object,
      issues: structuredExtraction.issues as unknown as object,
      extractionProvider: extractionProvider.name,
      extractionModel:
        visionAssist.outcome === 'SUCCEEDED'
          ? `deepseek (analysis tier) + ${visionAssist.provider}/${visionAssist.model} (vision)`
          : 'deepseek (analysis tier)',
      ocrEngine: extraction.engine,
      completedAt: new Date(),
    },
  });

  const hasBlocking = draftValidation.issues.some((i) => i.severity === 'BLOCKING');
  await prisma.propertyDocument.update({
    where: { id: propertyDocumentId },
    data: {
      status: hasBlocking ? 'REVIEW_REQUIRED' : 'READY',
      documentType: classification.documentType,
      draft: draft as unknown as object,
      pageCount: extraction.pageCount,
    },
  });

  await recordActivity(prisma, {
    organisationId,
    actorUserId: null,
    eventType: 'STRATA_PLAN_ANALYSIS_COMPLETED',
    entityType: 'PropertyDocument',
    entityId: propertyDocumentId,
    title: `Analysis completed — ${structuredExtraction.entitlementSchedule.lots.length} lots identified`,
    metadata: {
      reconciliationStatus: structuredExtraction.entitlementSchedule.reconciliationStatus,
      classificationConfidence: classificationConfidenceLevel(classification.confidence),
    },
  });
}
