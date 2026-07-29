import { HttpError } from "../lib/errors.js";

export const MAX_SOURCES_PER_NOTEBOOK = 100;
export const MAX_SOURCE_BYTES_PER_NOTEBOOK = 250 * 1024 * 1024;

interface SizedSource {
  size: number;
}

export function assertSourceQuota(existing: readonly SizedSource[], incoming: readonly SizedSource[]): void {
  const count = existing.length + incoming.length;
  const bytes =
    existing.reduce((sum, file) => sum + file.size, 0) + incoming.reduce((sum, file) => sum + file.size, 0);
  if (count > MAX_SOURCES_PER_NOTEBOOK || bytes > MAX_SOURCE_BYTES_PER_NOTEBOOK) {
    throw new HttpError(
      413,
      "source_quota_exceeded",
      `A notebook can contain at most ${MAX_SOURCES_PER_NOTEBOOK} sources and 250MB of source files.`,
    );
  }
}
