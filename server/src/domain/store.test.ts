import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NotebookStore, toSummary } from "./store.js";

test("archivedAt stays backward compatible and persists through summaries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-store-"));
  try {
    const store = new NotebookStore(dir);
    await store.init();
    const notebook = await store.create({ title: "Interest", type: "topic", topic: "Interest" });
    assert.equal(toSummary(notebook).archivedAt, null);
    notebook.archivedAt = "2026-07-11T00:00:00.000Z";
    await store.save(notebook);

    const reloaded = new NotebookStore(dir);
    await reloaded.init();
    assert.equal(reloaded.list()[0]?.archivedAt, "2026-07-11T00:00:00.000Z");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("interview metadata and archive state survive persistence and summaries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-store-interview-"));
  try {
    const store = new NotebookStore(dir);
    await store.init();
    const notebook = await store.create({ title: "Frontend practice", type: "interview", topic: null });
    notebook.interview = { role: "Senior Frontend Engineer", company: "Meridian Labs" };
    notebook.archivedAt = "2026-07-11T00:00:00.000Z";
    await store.save(notebook);

    const reloaded = new NotebookStore(dir);
    await reloaded.init();
    const summary = reloaded.list()[0];
    assert.deepEqual(summary?.interview, { role: "Senior Frontend Engineer", company: "Meridian Labs" });
    assert.equal(summary?.type, "interview");
    assert.equal(summary?.archivedAt, "2026-07-11T00:00:00.000Z");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
