import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Prisma } from '@prisma/client';

export interface QuoteAcceptanceDocumentInput {
  organisationName: string;
  propertyName: string;
  spaceName?: string | null;
  workOrderTitle: string;
  workOrderId: string;
  maintenanceRequestId?: string | null;
  contractorName: string;
  scopeOfWork: string;
  amount: string;
  currencyCode: string;
  scheduledAt?: string | null;
}

export interface NormalizedSignatureField {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QuoteAcceptanceDocument {
  bytes: Uint8Array;
  /** [0] = authorised signatory's box, [1] = contractor's box — same order
   * as the two signature lines drawn on the document, in WaslSign's
   * normalized (0-1, origin top-left) field coordinates. Computed from the
   * exact pixel position those lines ended up at, so a signature field
   * placed at these coordinates lands exactly on its line — never
   * hardcoded/guessed independently by the caller. */
  signatureFields: [NormalizedSignatureField, NormalizedSignatureField];
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
/** Height of the clickable signature box sitting just above its line. */
const SIGNATURE_BOX_HEIGHT = 36;

/** Converts a box anchored by its bottom-left corner in pdf-lib's
 * bottom-left-origin point space into WaslSign's normalized (0-1),
 * top-left-origin field space (see utils/pdf.ts's renderPlaceholders,
 * which does the exact inverse of this when actually drawing a field). */
function toNormalizedField(
  bottomLeftX: number,
  bottomY: number,
  widthPt: number,
  heightPt: number,
): NormalizedSignatureField {
  return {
    page: 1,
    x: bottomLeftX / PAGE_WIDTH,
    y: 1 - heightPt / PAGE_HEIGHT - bottomY / PAGE_HEIGHT,
    width: widthPt / PAGE_WIDTH,
    height: heightPt / PAGE_HEIGHT,
  };
}

/**
 * Generates the simple, single-page Work Order / Quote Acceptance document
 * used for SIGNATURE_ONLY and the signature phase of APPROVAL_THEN_SIGNATURE.
 * Deliberately plain — no branding system, no layout engine. Returns the
 * raw PDF bytes plus where the two signature fields actually landed, so the
 * caller can tell WaslSign exactly where each signer's box belongs instead
 * of the two ever being computed independently and drifting apart.
 */
export async function generateQuoteAcceptanceDocument(
  input: QuoteAcceptanceDocumentInput,
): Promise<QuoteAcceptanceDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const left = 56;
  const lineGap = 20;

  const drawTitle = (text: string) => {
    page.drawText(text, { x: left, y, size: 18, font: bold, color: rgb(0.15, 0.1, 0.2) });
    y -= 32;
  };
  const drawLabelValue = (label: string, value: string) => {
    page.drawText(label, { x: left, y, size: 10, font: bold, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(value, { x: left + 160, y, size: 11, font, color: rgb(0, 0, 0) });
    y -= lineGap;
  };
  const drawParagraph = (text: string) => {
    const words = text.split(' ');
    let line = '';
    const maxWidth = 500;
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, 11) > maxWidth) {
        page.drawText(line, { x: left, y, size: 11, font });
        y -= 16;
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) {
      page.drawText(line, { x: left, y, size: 11, font });
      y -= 16;
    }
  };

  drawTitle('Work Order Acceptance');
  drawLabelValue('Organisation', input.organisationName);
  drawLabelValue('Property', input.propertyName);
  if (input.spaceName) drawLabelValue('Space / Unit', input.spaceName);
  drawLabelValue('Work Order', `${input.workOrderTitle} (${input.workOrderId})`);
  if (input.maintenanceRequestId) drawLabelValue('Originating request', input.maintenanceRequestId);
  drawLabelValue('Contractor', input.contractorName);
  drawLabelValue('Amount', `${input.amount} ${input.currencyCode}`);
  if (input.scheduledAt) drawLabelValue('Scheduled', input.scheduledAt);

  y -= 12;
  page.drawText('Scope of work', { x: left, y, size: 12, font: bold });
  y -= 18;
  drawParagraph(input.scopeOfWork);

  y -= 20;
  page.drawText('Acknowledgement', { x: left, y, size: 12, font: bold });
  y -= 18;
  drawParagraph(
    'By signing below, the parties acknowledge the scope of work and amount stated above and authorise the work to proceed.',
  );

  // Leave room above each line for the signature box itself, then draw the
  // line right under it — the box's bottom edge sits exactly on the line.
  y -= 60 + SIGNATURE_BOX_HEIGHT;
  const signatoryLineY = y;
  const signatoryWidth = 220;
  page.drawLine({
    start: { x: left, y: signatoryLineY },
    end: { x: left + signatoryWidth, y: signatoryLineY },
    thickness: 1,
    color: rgb(0.5, 0.5, 0.5),
  });
  page.drawText('Authorised signatory', {
    x: left,
    y: signatoryLineY - 14,
    size: 9,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  const contractorX = left + 280;
  const contractorWidth = 220;
  page.drawLine({
    start: { x: contractorX, y: signatoryLineY },
    end: { x: contractorX + contractorWidth, y: signatoryLineY },
    thickness: 1,
    color: rgb(0.5, 0.5, 0.5),
  });
  page.drawText('Contractor', {
    x: contractorX,
    y: signatoryLineY - 14,
    size: 9,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  const bytes = await doc.save();
  return {
    bytes,
    signatureFields: [
      toNormalizedField(left, signatoryLineY, signatoryWidth, SIGNATURE_BOX_HEIGHT),
      toNormalizedField(contractorX, signatoryLineY, contractorWidth, SIGNATURE_BOX_HEIGHT),
    ],
  };
}

export interface VariationAcceptanceDocumentInput {
  organisationName: string;
  propertyName: string;
  spaceName?: string | null;
  workOrderTitle: string;
  workOrderId: string;
  contractorName: string;
  /** The original authorised amount, before this variation. */
  originalAmount: string;
  /** Every previously APPROVED variation's amount, summed — 0 if none. */
  previouslyApprovedVariationsTotal: string;
  variationDescription: string;
  variationAmount: string;
  currencyCode: string;
}

/**
 * The Work Order Variation counterpart to generateQuoteAcceptanceDocument
 * above — same page geometry, same signature-box mechanism (a variation
 * signature workflow reuses the identical WaslSign integration and field-
 * normalization math), but genuinely different content: a variation isn't
 * "the quote," it's a change on top of an already-authorised amount, so
 * the document must show the arithmetic (original + variation = proposed
 * new total), never just the variation figure in isolation.
 */
export async function generateVariationAcceptanceDocument(
  input: VariationAcceptanceDocumentInput,
): Promise<QuoteAcceptanceDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const left = 56;
  const lineGap = 20;

  const drawTitle = (text: string) => {
    page.drawText(text, { x: left, y, size: 18, font: bold, color: rgb(0.15, 0.1, 0.2) });
    y -= 32;
  };
  const drawLabelValue = (label: string, value: string) => {
    page.drawText(label, { x: left, y, size: 10, font: bold, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(value, { x: left + 200, y, size: 11, font, color: rgb(0, 0, 0) });
    y -= lineGap;
  };
  const drawParagraph = (text: string) => {
    const words = text.split(' ');
    let line = '';
    const maxWidth = 500;
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, 11) > maxWidth) {
        page.drawText(line, { x: left, y, size: 11, font });
        y -= 16;
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) {
      page.drawText(line, { x: left, y, size: 11, font });
      y -= 16;
    }
  };

  const approvedVariations = Number(input.previouslyApprovedVariationsTotal);
  const variationAmount = Number(input.variationAmount);
  // Summed as Prisma.Decimal, not plain JS numbers — this total is printed
  // verbatim into a legally-signed WaslSign document, so IEEE-754 drift
  // (e.g. 0.1 + 0.2 !== 0.3) is never acceptable here even though it's
  // rounded for display immediately after.
  const proposedNewTotal = new Prisma.Decimal(input.originalAmount)
    .plus(input.previouslyApprovedVariationsTotal)
    .plus(input.variationAmount)
    .toNumber();

  drawTitle('Work Order Variation — Acceptance');
  drawLabelValue('Organisation', input.organisationName);
  drawLabelValue('Property', input.propertyName);
  if (input.spaceName) drawLabelValue('Space / Unit', input.spaceName);
  drawLabelValue('Work Order', `${input.workOrderTitle} (${input.workOrderId})`);
  drawLabelValue('Contractor', input.contractorName);

  y -= 8;
  page.drawText('Commercial summary', { x: left, y, size: 12, font: bold });
  y -= 18;
  drawLabelValue('Original authorised amount', `${input.originalAmount} ${input.currencyCode}`);
  if (approvedVariations !== 0) {
    drawLabelValue(
      'Previously approved variations',
      `${approvedVariations >= 0 ? '+' : ''}${input.previouslyApprovedVariationsTotal} ${input.currencyCode}`,
    );
  }
  drawLabelValue(
    'This variation',
    `${variationAmount >= 0 ? '+' : ''}${input.variationAmount} ${input.currencyCode}`,
  );
  drawLabelValue(
    'Proposed new authorised total',
    `${proposedNewTotal.toFixed(2)} ${input.currencyCode}`,
  );

  y -= 12;
  page.drawText('Variation scope', { x: left, y, size: 12, font: bold });
  y -= 18;
  drawParagraph(input.variationDescription);

  y -= 20;
  page.drawText('Acknowledgement', { x: left, y, size: 12, font: bold });
  y -= 18;
  drawParagraph(
    'By signing below, the parties acknowledge the additional scope and amount stated above and authorise the variation to proceed.',
  );

  y -= 60 + SIGNATURE_BOX_HEIGHT;
  const signatoryLineY = y;
  const signatoryWidth = 220;
  page.drawLine({
    start: { x: left, y: signatoryLineY },
    end: { x: left + signatoryWidth, y: signatoryLineY },
    thickness: 1,
    color: rgb(0.5, 0.5, 0.5),
  });
  page.drawText('Authorised signatory', {
    x: left,
    y: signatoryLineY - 14,
    size: 9,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  const contractorX = left + 280;
  const contractorWidth = 220;
  page.drawLine({
    start: { x: contractorX, y: signatoryLineY },
    end: { x: contractorX + contractorWidth, y: signatoryLineY },
    thickness: 1,
    color: rgb(0.5, 0.5, 0.5),
  });
  page.drawText('Contractor', {
    x: contractorX,
    y: signatoryLineY - 14,
    size: 9,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  const bytes = await doc.save();
  return {
    bytes,
    signatureFields: [
      toNormalizedField(left, signatoryLineY, signatoryWidth, SIGNATURE_BOX_HEIGHT),
      toNormalizedField(contractorX, signatoryLineY, contractorWidth, SIGNATURE_BOX_HEIGHT),
    ],
  };
}
