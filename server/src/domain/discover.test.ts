import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadJobDescriptionFile } from "./discover.js";

test("source download rejects a loopback destination before connecting", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-discover-test-"));
  try {
    await assert.rejects(
      downloadJobDescriptionFile(dir, "http://127.0.0.1:1/internal", new Set()),
      /private IPv4 address rejected/i,
    );
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
