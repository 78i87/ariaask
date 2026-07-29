import fs from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const PDF_WORKER_TIMEOUT_MS = 30_000;
const MAX_CONCURRENT_PDF_WORKERS = 2;
const MAX_QUEUED_PDF_WORKERS = 16;

let activePdfWorkers = 0;
const pdfWorkerWaiters: Array<() => void> = [];

interface PdfWorkerSuccess {
  ok: true;
  pages: string[];
}

interface PdfWorkerFailure {
  ok: false;
  error: string;
}

async function withPdfWorkerPermit<T>(run: () => Promise<T>): Promise<T> {
  if (activePdfWorkers >= MAX_CONCURRENT_PDF_WORKERS) {
    if (pdfWorkerWaiters.length >= MAX_QUEUED_PDF_WORKERS) throw new Error("PDF parser is busy");
    await new Promise<void>((resolve) => pdfWorkerWaiters.push(resolve));
  } else {
    activePdfWorkers++;
  }
  try {
    return await run();
  } finally {
    const next = pdfWorkerWaiters.shift();
    if (next) next();
    else activePdfWorkers--;
  }
}

function runPdfWorker(pdfPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const worker = fork(fileURLToPath(new URL("./pdf-worker.ts", import.meta.url)), [pdfPath], {
      // A separate process contains parser crashes and native allocations.
      execArgv: ["--import", "tsx", "--max-old-space-size=256", "--max-semi-space-size=32", "--stack-size=4096"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        worker.kill("SIGKILL");
        reject(new Error(`PDF extraction exceeded ${PDF_WORKER_TIMEOUT_MS}ms`));
      });
    }, PDF_WORKER_TIMEOUT_MS);
    timer.unref();

    worker.once("message", (message: PdfWorkerSuccess | PdfWorkerFailure) => {
      finish(() => {
        worker.kill();
        if (message.ok) resolve(message.pages);
        else reject(new Error(message.error));
      });
    });
    worker.once("error", (err) => finish(() => reject(err)));
    worker.once("exit", (code) => {
      finish(() => reject(new Error(`PDF extraction worker exited before returning a result (code ${code ?? "unknown"})`)));
    });
  });
}

async function extractPdfPages(pdfPath: string): Promise<string[]> {
  const info = await fs.stat(pdfPath);
  if (!info.isFile() || info.size > MAX_PDF_BYTES) throw new Error("PDF exceeds the 25MB parser limit");
  return withPdfWorkerPermit(() => runPdfWorker(pdfPath));
}

/**
 * Extract plain text from a PDF. Parsing happens in a memory-limited,
 * killable worker with eval disabled and page/text ceilings.
 */
export async function extractPdfText(pdfPath: string): Promise<string | null> {
  try {
    const pages = await extractPdfPages(pdfPath);
    const text = pages.join("\n\n").trim();
    return text.length >= 50 ? text : null;
  } catch (err) {
    console.error(`[aria] pdf extraction failed for ${pdfPath}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Extract text per page (1-based order). Used by guided reading to anchor
 * annotations. Returns null when the bounded worker rejects the document.
 */
export async function extractPdfPageTexts(pdfPath: string): Promise<string[] | null> {
  try {
    const pages = await extractPdfPages(pdfPath);
    const total = pages.reduce((sum, page) => sum + page.trim().length, 0);
    return total >= 50 ? pages : null;
  } catch (err) {
    console.error(`[aria] per-page pdf extraction failed for ${pdfPath}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export function approxWordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
