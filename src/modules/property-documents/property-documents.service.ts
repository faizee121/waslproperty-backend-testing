import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../errors/AppError.js';
import { withPublicReference } from '../../lib/public-reference.js';
import { recordActivity } from '../activity/activity.js';
import { presignPut } from '../../lib/s3.js';
import { env } from '../../config/env.js';
import type { AuthContext } from '../../middlewares/auth.middleware.js';
import { assertOrganisationFeature } from '../organisations/organisation-features.js';
import { runStrataPlanAnalysis } from './analysis-runner.js';
import {
  applyDraftUpdate,
  validateDraft,
  type StrataPlanDraft,
  type UpdateDraftInput,
} from './nsw-strata-plan/draft.js';
import type { StrataPlanExtraction } from './nsw-strata-plan/extraction.types.js';
import type {
  PresignPropertyDocumentInput,
  RegisterPropertyDocumentInput,
} from './property-documents.schemas.js';

const MAX_ANALYSIS_ATTEMPTS = 3;

/**
 * Specifically a collision on Property's own (organisationId, code) unique
 * constraint — the one that can genuinely fire when two confirm() calls
 * for the SAME document race each other (see confirm()'s doc comment).
 * Prisma reports a P2002 on a schema-declared @@unique as a field-name
 * array in meta.target (confirmed empirically — unlike a hand-written
 * raw-SQL index, see lib/public-reference.ts's isPublicReferenceCollision
 * for that other shape), so this never mistakes an unrelated P2002 (e.g.
 * on publicReference, which withPublicReference already owns) for this one.
 */
function isPropertyCodeConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  if ((err as { code: unknown }).code !== 'P2002') return false;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  return Array.isArray(target) && target.includes('code');
}

function storageKeyPrefix(organisationId: string): string {
  return `organisations/${organisationId}/property-documents/`;
}

function assertWithinFileLimits(fileSize: number) {
  const maxBytes = env.DOCUMENT_ANALYSIS_MAX_FILE_SIZE_MB * 1024 * 1024;
  if (fileSize > maxBytes) {
    throw new ValidationError(
      `The document must be ${env.DOCUMENT_ANALYSIS_MAX_FILE_SIZE_MB} MB or smaller`,
    );
  }
}

export class PropertyDocumentsService {
  constructor(private readonly prisma: PrismaClient) {}

  async presign(organisationId: string, input: PresignPropertyDocumentInput) {
    assertWithinFileLimits(input.fileSize);
    const storageKey = `${storageKeyPrefix(organisationId)}${randomBytes(16).toString('hex')}.pdf`;
    const uploadUrl = await presignPut(storageKey, input.contentType);
    return { storageKey, uploadUrl };
  }

  async register(organisationId: string, auth: AuthContext, input: RegisterPropertyDocumentInput) {
    assertWithinFileLimits(input.fileSize);
    if (!input.storageKey.startsWith(storageKeyPrefix(organisationId))) {
      // A client trying to register a key it was never issued a presigned
      // PUT for — see MaintenanceAttachmentsService's identical rule.
      throw new ValidationError('Invalid document reference');
    }

    const document = await this.prisma.propertyDocument.create({
      data: {
        organisationId,
        uploadedByUserId: auth.userId,
        storageKey: input.storageKey,
        fileName: input.fileName,
        contentType: input.contentType,
        fileSize: input.fileSize,
        status: 'UPLOADED',
      },
    });

    await recordActivity(this.prisma, {
      organisationId,
      actorUserId: auth.userId,
      eventType: 'STRATA_PLAN_UPLOADED',
      entityType: 'PropertyDocument',
      entityId: document.id,
      title: `${document.fileName} uploaded for strata onboarding`,
    });

    // Fire-and-forget — see analysis-runner.ts's own doc comment for why
    // this is a deliberately simple, single-process async pattern rather
    // than a real job queue.
    void runStrataPlanAnalysis(this.prisma, document.id).catch(() => {
      // runStrataPlanAnalysis already persists FAILED state on any error;
      // nothing further to do with a rejection reaching here.
    });

    return document;
  }

  /** Self-heals a document stuck in ANALYSING past the configured
   * threshold (e.g. the process restarted mid-run) — see the M15 report's
   * documented limitation: there is no real job-recovery mechanism, only
   * this read-path check. */
  private async healStuckAnalysis(document: { id: string; status: string; updatedAt: Date }) {
    if (document.status !== 'ANALYSING') return;
    const stuckForMs = Date.now() - document.updatedAt.getTime();
    if (stuckForMs < env.DOCUMENT_ANALYSIS_STUCK_THRESHOLD_MS) return;

    await this.prisma.propertyDocument.update({
      where: { id: document.id },
      data: { status: 'FAILED' },
    });
    await this.prisma.documentAnalysis.updateMany({
      where: { propertyDocumentId: document.id, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        errorMessage: 'Analysis did not complete in time.',
        completedAt: new Date(),
      },
    });
  }

  private async getOwned(organisationId: string, documentId: string) {
    const document = await this.prisma.propertyDocument.findFirst({
      where: { id: documentId, organisationId },
    });
    if (!document) throw new NotFoundError('Document not found');
    return document;
  }

  async getById(organisationId: string, documentId: string) {
    const document = await this.getOwned(organisationId, documentId);
    await this.healStuckAnalysis(document);
    const fresh =
      document.status === 'ANALYSING' ? await this.getOwned(organisationId, documentId) : document;

    const latestAnalysis = await this.prisma.documentAnalysis.findFirst({
      where: { propertyDocumentId: documentId },
      orderBy: { createdAt: 'desc' },
    });

    const draft = fresh.draft as unknown as StrataPlanDraft | null;
    const validation = draft ? validateDraft(draft) : null;

    return {
      document: fresh,
      draft,
      validation,
      extraction: (latestAnalysis?.extraction ?? null) as unknown as StrataPlanExtraction | null,
      classification:
        latestAnalysis === null
          ? null
          : {
              documentType: latestAnalysis.classifiedDocumentType,
              confidence: latestAnalysis.classificationConfidence,
              evidence: latestAnalysis.classificationEvidence,
            },
      errorMessage: latestAnalysis?.errorMessage ?? null,
      canRetry: fresh.status === 'FAILED',
    };
  }

  async updateDraft(organisationId: string, documentId: string, input: UpdateDraftInput) {
    const document = await this.getOwned(organisationId, documentId);
    if (!document.draft) {
      throw new ConflictError('This document has no draft to edit yet');
    }
    if (document.status === 'CONFIRMED') {
      throw new ConflictError(
        'This document has already been confirmed and can no longer be edited',
      );
    }
    if (document.status !== 'REVIEW_REQUIRED' && document.status !== 'READY') {
      throw new ConflictError(`Cannot edit a document while it is ${document.status}`);
    }

    const current = document.draft as unknown as StrataPlanDraft;
    const updated = applyDraftUpdate(current, input);
    const validation = validateDraft(updated);

    const newStatus = validation.canConfirm ? 'READY' : 'REVIEW_REQUIRED';
    await this.prisma.propertyDocument.update({
      where: { id: document.id },
      data: { draft: updated as unknown as object, status: newStatus },
    });

    return { draft: updated, validation };
  }

  async retry(organisationId: string, auth: AuthContext, documentId: string) {
    const document = await this.getOwned(organisationId, documentId);
    if (document.status !== 'FAILED') {
      throw new ConflictError('Only a failed analysis can be retried');
    }
    const attempts = await this.prisma.documentAnalysis.count({
      where: { propertyDocumentId: document.id },
    });
    if (attempts >= MAX_ANALYSIS_ATTEMPTS) {
      throw new ConflictError(
        `This document has already been analysed ${attempts} times — set the property up manually instead.`,
      );
    }

    await this.prisma.propertyDocument.update({
      where: { id: document.id },
      data: { status: 'UPLOADED' },
    });
    void runStrataPlanAnalysis(this.prisma, document.id).catch(() => {});
    return this.getOwned(organisationId, document.id);
  }

  async confirm(organisationId: string, auth: AuthContext, documentId: string) {
    await assertOrganisationFeature(this.prisma, organisationId, 'STRATA_MANAGEMENT');
    const document = await this.getOwned(organisationId, documentId);

    // Idempotent — a repeated confirm (double-click, retried request)
    // after the property already exists simply returns it, never creates
    // a second one. See Section 28.
    if (document.createdPropertyId) {
      const property = await this.prisma.property.findUnique({
        where: { id: document.createdPropertyId },
      });
      if (property) return property;
    }
    if (document.status === 'CONFIRMED') {
      throw new ConflictError('This document has already been confirmed');
    }
    if (!document.draft) {
      throw new ConflictError('This document has no draft ready to confirm');
    }
    if (document.status !== 'REVIEW_REQUIRED' && document.status !== 'READY') {
      throw new ConflictError(`Cannot confirm a document while it is ${document.status}`);
    }

    const draft = document.draft as unknown as StrataPlanDraft;
    const validation = validateDraft(draft);
    if (!validation.canConfirm) {
      throw new ConflictError('Resolve the outstanding issues before creating this property', {
        issues: validation.issues,
      });
    }

    const codeClash = await this.prisma.property.findUnique({
      where: { organisationId_code: { organisationId, code: draft.code as string } },
    });
    if (codeClash) {
      throw new ConflictError(`A property with code "${draft.code}" already exists`);
    }

    let property;
    try {
      property = await this.prisma.$transaction(async (tx) => {
        // Public reference generated here, the same trusted backend flow as
        // every other creation path — never derived from the strata plan
        // number, the confirmed name, the document id, or the organisation
        // id (see M15.2 Public Reference spec Section 17).
        const createdProperty = await withPublicReference('PROP', (publicReference) =>
          tx.property.create({
            data: {
              organisationId,
              publicReference,
              name: draft.propertyName as string,
              code: draft.code as string,
              addressLine1: draft.addressLine1 ?? 'Not provided',
              addressLine2: draft.addressLine2 ?? undefined,
              city: draft.city ?? 'Not provided',
              state: draft.state ?? undefined,
              country: draft.country,
              postalCode: draft.postalCode ?? undefined,
              propertyType: draft.propertyType,
              isStrataManaged: true,
              strataStatus: 'ACTIVE',
              strataPlanNumber: draft.strataPlanNumber ?? undefined,
              strataSchemeName: draft.strataSchemeName ?? undefined,
              strataPlanDeclaredUnitsOfEntitlement:
                draft.strataPlanDeclaredUnitsOfEntitlement ?? undefined,
            },
          }),
        );

        for (const lot of draft.lots) {
          await withPublicReference('LOT', (publicReference) =>
            tx.space.create({
              data: {
                organisationId,
                propertyId: createdProperty.id,
                publicReference,
                name: `Lot ${lot.lotNumber}`,
                code: `LOT-${lot.lotNumber}`,
                spaceType: 'APARTMENT',
                isStrataLot: true,
                strataClassification: 'LOT',
                lotNumber: lot.lotNumber,
                entitlementValue: lot.unitsOfEntitlement,
              },
            }),
          );
        }

        await tx.propertyDocument.update({
          where: { id: document.id },
          data: {
            status: 'CONFIRMED',
            createdPropertyId: createdProperty.id,
            confirmedByUserId: auth.userId,
            confirmedAt: new Date(),
          },
        });

        await recordActivity(tx, {
          organisationId,
          propertyId: createdProperty.id,
          actorUserId: auth.userId,
          eventType: 'PROPERTY_CREATED',
          entityType: 'Property',
          entityId: createdProperty.id,
          title: `${createdProperty.name} created`,
        });
        await recordActivity(tx, {
          organisationId,
          propertyId: createdProperty.id,
          actorUserId: auth.userId,
          eventType: 'STRATA_PROPERTY_CREATED_FROM_PLAN',
          entityType: 'Property',
          entityId: createdProperty.id,
          title:
            `${createdProperty.name} created from Strata Plan ${draft.strataPlanNumber ?? ''}`.trim(),
        });
        await recordActivity(tx, {
          organisationId,
          propertyId: createdProperty.id,
          actorUserId: auth.userId,
          eventType: 'STRATA_PLAN_CONFIRMED',
          entityType: 'PropertyDocument',
          entityId: document.id,
          title: `Strata plan confirmed — ${draft.lots.length} lots created`,
        });

        return createdProperty;
      });
    } catch (err) {
      // A concurrent confirm() for the SAME document can lose the race on
      // Property's (organisationId, code) unique constraint — both calls
      // pass the codeClash pre-check (neither has committed yet), both
      // enter the transaction, and Postgres accepts only one INSERT.
      // Recover exactly like the idempotent re-confirm path at the top of
      // this method: hand the loser back the winner's already-committed
      // property, never a raw Prisma/Postgres error surfacing as an
      // opaque 500. See isPropertyCodeConflict's doc comment for why this
      // can only match this specific constraint, never an unrelated one.
      if (isPropertyCodeConflict(err)) {
        const refetched = await this.prisma.propertyDocument.findUnique({
          where: { id: document.id },
        });
        if (refetched?.createdPropertyId) {
          const winnerProperty = await this.prisma.property.findUnique({
            where: { id: refetched.createdPropertyId },
          });
          if (winnerProperty) return winnerProperty;
        }
        // The code collision wasn't actually this document's own confirm
        // winning the race (e.g. a genuinely different property already
        // held this code and codeClash's pre-check simply lost a narrower
        // race) — a clean, expected conflict, not a bug.
        throw new ConflictError(`A property with code "${draft.code}" already exists`);
      }
      throw err;
    }

    return property;
  }
}
