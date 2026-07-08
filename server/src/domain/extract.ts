import fs from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// pdf-parse's index.js runs a debug block when it can't detect a parent module
// (always the case under ESM) — import the implementation directly instead.
const pdfParse: (
  buf: Buffer,
  options?: { pagerender?: (pageData: PdfPageData) => Promise<string> },
) => Promise<{ text: string; numpages: number }> = require("pdf-parse/lib/pdf-parse.js");

interface PdfTextItem {
  str: string;
  transform: number[];
}

interface PdfPageData {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

/** Line-aware page text: newline on vertical movement, space otherwise. */
function renderPageText(pageData: PdfPageData): Promise<string> {
  return pageData.getTextContent().then((tc) => {
    let lastY: number | null = null;
    let text = "";
    for (const item of tc.items) {
      const y = item.transform[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 1) {
        if (!text.endsWith("\n")) text += "\n";
      } else if (text && !text.endsWith("\n") && !text.endsWith(" ")) {
        text += " ";
      }
      text += item.str;
      lastY = y;
    }
    return text;
  });
}

/**
 * Extract plain text from a PDF. Returns null when the PDF yields no usable
 * text (e.g. scanned/image-only documents) or cannot be parsed.
 */
export async function extractPdfText(pdfPath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(pdfPath);
    const result = await pdfParse(buf);
    const text = result.text?.trim();
    return text && text.length >= 50 ? text : null;
  } catch (err) {
    console.error(`[aria] pdf extraction failed for ${pdfPath}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Extract text per page (1-based order). Used by guided reading (reading.ts)
 * to anchor annotations to pages; computed on demand, never persisted.
 * Returns null when the PDF can't be parsed or yields no usable text.
 */
export async function extractPdfPageTexts(pdfPath: string): Promise<string[] | null> {
  try {
    const buf = await fs.readFile(pdfPath);
    const pages: string[] = [];
    await pdfParse(buf, {
      pagerender: (pageData) =>
        renderPageText(pageData).then((text) => {
          pages.push(text);
          return text;
        }),
    });
    const total = pages.reduce((sum, p) => sum + p.trim().length, 0);
    return total >= 50 ? pages : null;
  } catch (err) {
    console.error(`[aria] per-page pdf extraction failed for ${pdfPath}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export function approxWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
