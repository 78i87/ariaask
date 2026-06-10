import fs from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// pdf-parse's index.js runs a debug block when it can't detect a parent module
// (always the case under ESM) — import the implementation directly instead.
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = require("pdf-parse/lib/pdf-parse.js");

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

export function approxWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
