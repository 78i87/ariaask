import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSourceQuota,
  MAX_SOURCE_BYTES_PER_NOTEBOOK,
  MAX_SOURCES_PER_NOTEBOOK,
} from "./source-quota.js";

test("source quota accepts the exact count and byte ceilings", () => {
  const sources = Array.from({ length: MAX_SOURCES_PER_NOTEBOOK }, (_, index) => ({
    size: index === 0 ? MAX_SOURCE_BYTES_PER_NOTEBOOK : 0,
  }));
  assert.doesNotThrow(() => assertSourceQuota([], sources));
});

test("source quota rejects count and aggregate-byte overflow", () => {
  assert.throws(
    () => assertSourceQuota(Array.from({ length: MAX_SOURCES_PER_NOTEBOOK }, () => ({ size: 0 })), [{ size: 0 }]),
    /at most 100 sources/i,
  );
  assert.throws(
    () => assertSourceQuota([{ size: MAX_SOURCE_BYTES_PER_NOTEBOOK }], [{ size: 1 }]),
    /250MB/i,
  );
});
