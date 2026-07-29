import assert from "node:assert/strict";
import test from "node:test";
import { chunkFile } from "./rag.js";

test("chunkFile stops at the caller's retained-chunk ceiling", () => {
  const text = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n${"content ".repeat(900)}`).join("\n\n");
  const chunks = chunkFile("source.md", "source.md", text, 3);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => chunk.seq), [0, 1, 2]);
});
