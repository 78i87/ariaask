import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const MAX_PAGES = 200;
const MAX_PAGE_TEXT_CHARS = 500_000;
const MAX_TOTAL_TEXT_CHARS = 5_000_000;
const MAX_IMAGE_PIXELS = 16_000_000;

interface PdfTextItem {
  str?: unknown;
  transform?: unknown;
}

function renderPageText(items: PdfTextItem[]): string {
  let lastY: number | null = null;
  let text = "";
  for (const item of items) {
    const value = typeof item.str === "string" ? item.str : "";
    const transform = Array.isArray(item.transform) ? item.transform : [];
    const y = typeof transform[5] === "number" ? transform[5] : 0;
    if (lastY !== null && Math.abs(y - lastY) > 1) {
      if (!text.endsWith("\n")) text += "\n";
    } else if (text && !text.endsWith("\n") && !text.endsWith(" ")) {
      text += " ";
    }
    text += value;
    if (text.length > MAX_PAGE_TEXT_CHARS) throw new Error("PDF page text exceeds the extraction limit");
    lastY = y;
  }
  return text;
}

async function main(): Promise<string[]> {
  const pdfPath = process.argv[2];
  if (!pdfPath) throw new Error("Missing PDF path");
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const require = createRequire(import.meta.url);
  const loadingTask = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
    maxImageSize: MAX_IMAGE_PIXELS,
    verbosity: 0,
    standardFontDataUrl: path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts/"),
  });
  try {
    const doc = await loadingTask.promise;
    if (doc.numPages > MAX_PAGES) throw new Error(`PDF exceeds the ${MAX_PAGES}-page extraction limit`);
    const pages: string[] = [];
    let totalChars = 0;
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const text = renderPageText(content.items as PdfTextItem[]);
      totalChars += text.length;
      if (totalChars > MAX_TOTAL_TEXT_CHARS) throw new Error("PDF extracted text exceeds the total limit");
      pages.push(text);
      page.cleanup();
    }
    return pages;
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

if (!process.send) throw new Error("PDF worker requires an IPC channel");
main().then(
  (pages) => process.send!({ ok: true, pages }),
  (err: unknown) => process.send!({ ok: false, error: err instanceof Error ? err.message : String(err) }),
);
