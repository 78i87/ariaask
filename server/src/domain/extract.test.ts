import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractPdfText } from "./extract.js";

test("PDF extraction worker contains malformed parser input", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-pdf-worker-test-"));
  const file = path.join(dir, "malformed.pdf");
  try {
    await fs.writeFile(file, "%PDF-1.7\nnot-a-valid-document");
    assert.equal(await extractPdfText(file), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
