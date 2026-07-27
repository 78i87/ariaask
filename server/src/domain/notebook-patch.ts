export interface NotebookPatch {
  title?: string;
  archived?: boolean;
}

export type NotebookPatchResult =
  | { ok: true; value: NotebookPatch }
  | { ok: false; code: string; message: string };

export function parseNotebookPatch(body: unknown): NotebookPatchResult {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (input.title === undefined && input.archived === undefined) {
    return { ok: false, code: "empty_patch", message: "Provide a title or archive state." };
  }

  const value: NotebookPatch = {};
  if (input.title !== undefined) {
    if (typeof input.title !== "string") {
      return { ok: false, code: "invalid_title", message: "Title must be text." };
    }
    const title = input.title.trim();
    if (!title || title.length > 140) {
      return { ok: false, code: "invalid_title", message: "Title must be between 1 and 140 characters." };
    }
    value.title = title;
  }

  if (input.archived !== undefined) {
    if (typeof input.archived !== "boolean") {
      return { ok: false, code: "invalid_archive_state", message: "Archived must be true or false." };
    }
    value.archived = input.archived;
  }

  return { ok: true, value };
}
