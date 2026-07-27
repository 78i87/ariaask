import assert from "node:assert/strict";
import test from "node:test";
import { parseNotebookPatch } from "./notebook-patch.js";

test("notebook patches trim valid titles and accept archive state", () => {
  assert.deepEqual(parseNotebookPatch({ title: "  Harmony  ", archived: true }), {
    ok: true,
    value: { title: "Harmony", archived: true },
  });
});

test("notebook patches reject empty, oversized, and invalid values", () => {
  assert.equal(parseNotebookPatch({}).ok, false);
  assert.equal(parseNotebookPatch({ title: "   " }).ok, false);
  assert.equal(parseNotebookPatch({ title: "x".repeat(141) }).ok, false);
  assert.equal(parseNotebookPatch({ archived: "yes" }).ok, false);
});
