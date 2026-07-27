import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsStore } from "./settings.js";

test("model reconciliation persists a concrete default and preserves valid selections", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-settings-"));
  try {
    const store = new SettingsStore(dir, { model: null, effort: "xhigh" });
    await store.init();
    assert.equal(store.get().model, null);

    await store.reconcileModel([
      { model: "gpt-5.5", isDefault: true, supportedReasoningEfforts: ["medium", "high"] },
      { model: "gpt-5.4", isDefault: false, supportedReasoningEfforts: ["xhigh"] },
    ]);
    assert.equal(store.get().model, "gpt-5.5");
    assert.equal(store.get().effort, null);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, "settings.json"), "utf8")).model, "gpt-5.5");

    await store.reconcileModel([
      { model: "gpt-5.5", isDefault: false, supportedReasoningEfforts: ["medium", "high"] },
      { model: "gpt-5.4", isDefault: true, supportedReasoningEfforts: ["xhigh"] },
    ]);
    assert.equal(store.get().model, "gpt-5.5");

    await store.reconcileModel([{ model: "gpt-5.4", isDefault: true, supportedReasoningEfforts: ["xhigh"] }]);
    assert.equal(store.get().model, "gpt-5.4");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("model reconciliation does not guess when discovery returns no models", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-settings-empty-"));
  try {
    const store = new SettingsStore(dir, { model: null, effort: null });
    await store.init();
    await store.reconcileModel([]);
    assert.equal(store.get().model, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
