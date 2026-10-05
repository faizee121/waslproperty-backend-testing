import * as mupdf from 'mupdf';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  PdfPageTooLargeError,
  renderPageToPng,
} from '../../src/modules/property-documents/providers/pdf-page-renderer.js';

async function buildSinglePagePdf(widthPt: number, heightPt: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([widthPt, heightPt]);
  return Buffer.from(await doc.save());
}

async function loadFirstPage(widthPt: number, heightPt: number): Promise<mupdf.Page> {
  const bytes = await buildSinglePagePdf(widthPt, heightPt);
  const mupdfDoc = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
  return mupdfDoc.loadPage(0);
}

describe('renderPageToPng — resource bounds', () => {
  it('renders a normal A4 page at OCR scale (3x) without throwing', async () => {
    const page = await loadFirstPage(595, 842); // A4 in points
    const png = renderPageToPng(page, 3, 0);
    expect(png.length).toBeGreaterThan(0);
    // PNG magic bytes — confirms a real image was produced, not a stub.
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('renders a large A0 page at vision scale (4x) without throwing', async () => {
    const page = await loadFirstPage(2384, 3370); // A0 in points
    const png = renderPageToPng(page, 4, 0);
    expect(png.length).toBeGreaterThan(0);
  });

  it('rejects a page whose declared size would produce an oversized single dimension, before attempting to render', async () => {
    const page = await loadFirstPage(50_000, 100); // absurdly wide, modest height
    expect(() => renderPageToPng(page, 3, 0)).toThrow(PdfPageTooLargeError);
  });

  it('rejects a page whose declared size would exceed the maximum safe total pixel count, before attempting to render', async () => {
    const page = await loadFirstPage(10_000, 10_000); // within per-side cap, but 10000*3=30000px/side, area far over the pixel cap
    expect(() => renderPageToPng(page, 3, 0)).toThrow(PdfPageTooLargeError);
  });

  it('rejects a genuinely pathological page (200,000 x 200,000pt) instantly, never attempting to allocate a pixmap', async () => {
    const page = await loadFirstPage(200_000, 200_000);
    const start = Date.now();
    expect(() => renderPageToPng(page, 3, 0)).toThrow(PdfPageTooLargeError);
    // A rejection that actually happens before allocation is near-instant;
    // one that fell through to toPixmap would hang or crash the process
    // on a page this large, not return quickly.
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
