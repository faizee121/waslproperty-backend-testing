import * as mupdf from 'mupdf';
import { createWorker, type Worker } from 'tesseract.js';
import { env } from '../../../config/env.js';
import type {
  DocumentExtractionProvider,
  DocumentExtractionResult,
  ExtractedPage,
} from '../extraction-provider.interface.js';
import { renderPageToPng } from './pdf-page-renderer.js';

/** Page rotations tried, in order, when hunting for the orientation that
 * actually reads correctly — bounded to the 4 cardinal rotations, never
 * an open-ended search. A scanned source document's pages are near-always
 * uniformly rotated relative to their page box, so only the FIRST page is
 * swept; every other page reuses whatever rotation won there (documented
 * limitation — see the M15 report). */
const CANDIDATE_ROTATIONS = [0, 90, 180, 270] as const;

/** Below this, a page's native embedded text layer is treated as
 * "nothing useful" and OCR takes over — real digitally-authored PDFs
 * (not scans) will usually have thousands of characters here and skip OCR
 * entirely; the M15 sample's text layer is just the word "SAMPLE". */
const NATIVE_TEXT_MIN_CHARS = 200;

const RENDER_SCALE = 3;

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
 * The concrete DocumentExtractionProvider for M15: renders each PDF page
 * with MuPDF's WASM build (no native binary, no system package dependency
 * — see the M15 report's "why mupdf, not poppler/node-canvas" section for
 * the alternatives this ruled out) and OCRs it with tesseract.js (also
 * pure WASM). Neither dependency can crash the host Node process the way
 * a native canvas binding did during evaluation; both are ordinary npm
 * installs with no apt/brew step required at deploy time.
 */
export class PdfOcrExtractionProvider implements DocumentExtractionProvider {
  readonly name = 'mupdf+tesseract.js';

  async extract(pdfBytes: Buffer, maxPages: number): Promise<DocumentExtractionResult> {
    const doc = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
    const totalPages = doc.countPages();
    const pageCount = Math.min(totalPages, maxPages);

    const nativePages = new Map<number, string>();
    const pagesNeedingOcr: number[] = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      const text = page.toStructuredText('').asText().trim();
      if (text.length >= NATIVE_TEXT_MIN_CHARS) {
        nativePages.set(i, text);
      } else {
        pagesNeedingOcr.push(i);
      }
    }

    const pages: ExtractedPage[] = [];
    for (const [index, text] of nativePages) {
      pages.push({ pageNumber: index + 1, text, confidence: 1, method: 'PDF_TEXT' });
    }

    let documentRotation: number | null = null;
    if (pagesNeedingOcr.length > 0) {
      const worker = await createWorker('eng');
      try {
        for (const index of pagesNeedingOcr) {
          const page = doc.loadPage(index);
          const ocrResult: { rotation: number; text: string; confidence: number } =
            documentRotation === null
              ? await this.sweepRotations(page, worker)
              : await this.ocrAtRotation(page, worker, documentRotation);
          const { rotation, text, confidence } = ocrResult;
          if (documentRotation === null) documentRotation = rotation;
          pages.push({ pageNumber: index + 1, text, confidence: confidence / 100, method: 'OCR' });
        }
      } finally {
        await worker.terminate();
      }
    }

    pages.sort((a, b) => a.pageNumber - b.pageNumber);
    return { pageCount, pages, engine: this.name, ocrRotationDeg: documentRotation };
  }

  private async ocrAtRotation(
    page: mupdf.Page,
    worker: Worker,
    rotationDeg: number,
  ): Promise<{ rotation: number; text: string; confidence: number }> {
    const png = renderPageToPng(page, RENDER_SCALE, rotationDeg);
    const { data } = await withTimeout(
      worker.recognize(png),
      env.DOCUMENT_ANALYSIS_OCR_TIMEOUT_MS,
      'OCR',
    );
    return { rotation: rotationDeg, text: data.text, confidence: data.confidence };
  }

  /** Bounded to exactly 4 attempts (the cardinal rotations), never an
   * open-ended search — picks whichever orientation OCR itself is most
   * confident about. */
  private async sweepRotations(
    page: mupdf.Page,
    worker: Worker,
  ): Promise<{ rotation: number; text: string; confidence: number }> {
    let best: { rotation: number; text: string; confidence: number } | null = null;
    for (const rotation of CANDIDATE_ROTATIONS) {
      const result = await this.ocrAtRotation(page, worker, rotation);
      if (!best || result.confidence > best.confidence) best = result;
    }
    return best as { rotation: number; text: string; confidence: number };
  }
}
