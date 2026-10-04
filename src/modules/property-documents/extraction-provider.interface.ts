/**
 * The seam between "get a bounded, trustworthy text representation of a
 * scanned document" and everything downstream (AI interpretation,
 * validation). Nothing above this interface knows HOW a page's text was
 * obtained (native PDF text layer vs rendered-and-OCR'd) — that is exactly
 * the replaceability the M15 spec asks for ("do not make the entire
 * feature depend on one giant prompt containing a PDF").
 */
export interface ExtractedPage {
  pageNumber: number;
  text: string;
  /** 0-1. For PDF_TEXT this is always 1 (no recognition uncertainty — the
   * text is literally embedded in the file). For OCR this is the OCR
   * engine's own mean confidence for the page, never AI-estimated. */
  confidence: number;
  method: 'PDF_TEXT' | 'OCR';
}

export interface DocumentExtractionResult {
  pageCount: number;
  pages: ExtractedPage[];
  /** Name of the concrete engine that produced this result (e.g.
   * "tesseract.js") — persisted onto DocumentAnalysis.ocrEngine for audit/
   * reprocessing provenance. */
  engine: string;
  /** The single rotation (0/90/180/270) the OCR pass settled on for this
   * document (null if no page needed OCR at all — pure PDF_TEXT). A
   * scanned source is near-always uniformly rotated (see
   * pdf-ocr-extraction.provider.ts's sweepRotations doc comment), so the
   * vision fallback reuses this instead of re-sweeping rotations itself. */
  ocrRotationDeg: number | null;
}

/**
 * Renders/reads a PDF's pages into bounded, per-page text — the ONLY
 * capability this interface exposes. A concrete implementation may use
 * native PDF text extraction, page-image rendering + OCR, or (for a future
 * provider) a vision model — callers never know or care which. Replaceable
 * without touching classification, interpretation, or validation code.
 */
export interface DocumentExtractionProvider {
  readonly name: string;
  extract(pdfBytes: Buffer, maxPages: number): Promise<DocumentExtractionResult>;
}
