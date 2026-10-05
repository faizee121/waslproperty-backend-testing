import * as mupdf from 'mupdf';

/**
 * Hand-crafted (or simply corrupted) PDFs can declare a MediaBox far
 * outside any real physical page — WASM mupdf has no built-in cap, and
 * toPixmap allocates its full RGB buffer up front, so an attacker-supplied
 * "PDF" with a pathological page size is a straightforward memory/CPU
 * exhaustion vector at upload time, before any human ever opens it.
 * Bounds chosen generously above any legitimate scan this product
 * handles — including oversized NSW strata plan sheets (up to A0,
 * ~2384x3370pt) at the highest scale factor in use (vision fallback's 4x,
 * ~129 megapixels) — while still rejecting anything order-of-magnitude
 * larger. A single page this large has never been a real NSW strata plan;
 * it is deliberately treated as hostile input, not a product limitation.
 */
const MAX_RENDER_DIMENSION_PX = 30_000;
const MAX_RENDER_PIXELS = 160_000_000;

export class PdfPageTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfPageTooLargeError';
  }
}

/** Checked by renderPageToPng before any rendering is attempted — never
 * trust a page's declared size as safe just because the PDF opened. */
function assertRenderableAtScale(page: mupdf.Page, scale: number): void {
  const [x0, y0, x1, y1] = page.getBounds();
  const widthPx = Math.abs(x1 - x0) * scale;
  const heightPx = Math.abs(y1 - y0) * scale;

  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
    throw new PdfPageTooLargeError('This page has invalid or missing dimensions');
  }
  if (widthPx > MAX_RENDER_DIMENSION_PX || heightPx > MAX_RENDER_DIMENSION_PX) {
    throw new PdfPageTooLargeError(
      `This page is too large to process safely (${Math.round(widthPx)}x${Math.round(heightPx)}px at the required scale)`,
    );
  }
  if (widthPx * heightPx > MAX_RENDER_PIXELS) {
    throw new PdfPageTooLargeError('This page exceeds the maximum safe pixel count to process');
  }
}

/**
 * Shared PDF-page-to-PNG rendering — the one place a page's pixels get
 * produced, reused by both the OCR provider (pdf-ocr-extraction.provider.ts)
 * and the vision fallback (nsw-strata-plan/vision-fallback.ts). Neither
 * caller knows anything about mupdf's Matrix/Pixmap API beyond this
 * function's signature.
 */
export function renderPageToPng(page: mupdf.Page, scale: number, rotationDeg: number): Buffer {
  assertRenderableAtScale(page, scale);
  const matrix = mupdf.Matrix.concat(
    mupdf.Matrix.scale(scale, scale),
    mupdf.Matrix.rotate(rotationDeg),
  );
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  return Buffer.from(pixmap.asPNG());
}
