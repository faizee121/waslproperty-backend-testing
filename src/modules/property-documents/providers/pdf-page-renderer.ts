import * as mupdf from 'mupdf';

/**
 * Shared PDF-page-to-PNG rendering — the one place a page's pixels get
 * produced, reused by both the OCR provider (pdf-ocr-extraction.provider.ts)
 * and the vision fallback (nsw-strata-plan/vision-fallback.ts). Neither
 * caller knows anything about mupdf's Matrix/Pixmap API beyond this
 * function's signature.
 */
export function renderPageToPng(page: mupdf.Page, scale: number, rotationDeg: number): Buffer {
  const matrix = mupdf.Matrix.concat(
    mupdf.Matrix.scale(scale, scale),
    mupdf.Matrix.rotate(rotationDeg),
  );
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
  return Buffer.from(pixmap.asPNG());
}
