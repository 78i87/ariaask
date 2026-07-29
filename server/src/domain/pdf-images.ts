import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Server-side PDF page rendering (guided reading's "eyes"): pages become PNGs
 * that ride along on the annotation one-shot as localImage inputs, so the
 * model can see figures, diagrams and slide layouts that text extraction
 * drops. Everything here fails open — a missing native dep or a page that
 * won't render just means fewer/no images.
 */

const require = createRequire(import.meta.url);

const RENDER_WIDTH = 1024;
const MAX_PDF_PAGES = 200;
const MAX_CANVAS_DIMENSION = 8192;
const MAX_CANVAS_PIXELS = 12_000_000;
const MAX_TOTAL_CANVAS_PIXELS = 64_000_000;

interface PdfjsBundle {
  getDocument: (typeof import("pdfjs-dist"))["getDocument"];
  createCanvas: (typeof import("@napi-rs/canvas"))["createCanvas"];
}

let bundlePromise: Promise<PdfjsBundle> | null = null;

function getBundle(): Promise<PdfjsBundle> {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const canvas = await import("@napi-rs/canvas");
      // pdf.js expects these DOM globals; @napi-rs/canvas provides Node ports.
      const g = globalThis as Record<string, unknown>;
      g.DOMMatrix ??= canvas.DOMMatrix;
      g.ImageData ??= canvas.ImageData;
      g.Path2D ??= canvas.Path2D;
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      return { getDocument: pdfjs.getDocument, createCanvas: canvas.createCanvas };
    })().catch((err) => {
      bundlePromise = null;
      throw err;
    });
  }
  return bundlePromise;
}

/**
 * Render the given 1-based pages to PNGs in a fresh temp dir. Pages that fail
 * to render are skipped. The caller owns the returned dir (remove when done).
 */
export async function renderPdfPageImages(
  pdfPath: string,
  pageNumbers: number[],
): Promise<{ dir: string; images: Map<number, string> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-reading-"));
  const images = new Map<number, string>();
  try {
    const { getDocument, createCanvas } = await getBundle();
    const data = new Uint8Array(await fs.readFile(pdfPath));
    const doc = await getDocument({
      data,
      disableFontFace: true,
      useSystemFonts: true,
      maxImageSize: MAX_CANVAS_PIXELS,
      verbosity: 0,
      standardFontDataUrl: path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts/"),
    }).promise;
    try {
      if (doc.numPages > MAX_PDF_PAGES) throw new Error(`PDF exceeds the ${MAX_PDF_PAGES}-page render limit`);
      let totalPixels = 0;
      for (const pageNum of pageNumbers) {
        if (pageNum < 1 || pageNum > doc.numPages) continue;
        try {
          const page = await doc.getPage(pageNum);
          const base = page.getViewport({ scale: 1 });
          if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) {
            throw new Error("invalid PDF page geometry");
          }
          const scale = Math.min(RENDER_WIDTH / base.width, 2);
          const vp = page.getViewport({ scale });
          const width = Math.ceil(vp.width);
          const height = Math.ceil(vp.height);
          const pixels = width * height;
          if (
            width <= 0 ||
            height <= 0 ||
            width > MAX_CANVAS_DIMENSION ||
            height > MAX_CANVAS_DIMENSION ||
            pixels > MAX_CANVAS_PIXELS ||
            totalPixels + pixels > MAX_TOTAL_CANVAS_PIXELS
          ) {
            throw new Error("PDF page exceeds the canvas geometry budget");
          }
          totalPixels += pixels;
          const canvas = createCanvas(width, height);
          const ctx = canvas.getContext("2d");
          await page.render({
            // @napi-rs/canvas structurally matches the browser canvas pdf.js expects.
            canvas: canvas as unknown as HTMLCanvasElement,
            canvasContext: ctx as unknown as CanvasRenderingContext2D,
            viewport: vp,
          }).promise;
          const file = path.join(dir, `page-${pageNum}.png`);
          await fs.writeFile(file, canvas.toBuffer("image/png"));
          images.set(pageNum, file);
        } catch (err) {
          console.error(`[aria] reading: page ${pageNum} image render failed:`, err instanceof Error ? err.message : err);
        }
      }
    } finally {
      await doc.cleanup().catch(() => {});
    }
  } catch (err) {
    console.error("[aria] reading: page image rendering unavailable:", err instanceof Error ? err.message : err);
  }
  return { dir, images };
}
