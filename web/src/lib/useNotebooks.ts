import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { evictNotebookCache } from "./useTeachingSession";
import type { Notebook } from "./types";

let cachedNotebooks: Notebook[] | null = null;

export function clearNotebooksListCache(): void {
  cachedNotebooks = null;
}

export function useNotebooks() {
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(cachedNotebooks);
  const [error, setError] = useState<string | null>(null);

  const commit = useCallback((next: Notebook[]) => {
    cachedNotebooks = next;
    setNotebooks(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listNotebooks();
      commit(res.notebooks);
      setError(null);
    } catch (err) {
      if (cachedNotebooks === null) {
        setError(err instanceof Error ? err.message : "Failed to load notebooks");
      }
    }
  }, [commit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (form: FormData) => {
      const res = await api.createNotebook(form);
      commit([res.notebook, ...(cachedNotebooks ?? [])]);
      return res;
    },
    [commit],
  );

  const remove = useCallback(
    async (id: string) => {
      commit((cachedNotebooks ?? []).filter((n) => n.id !== id));
      evictNotebookCache(id);
      await api.deleteNotebook(id);
    },
    [commit],
  );

  const update = useCallback(async (id: string, patch: { title?: string; archived?: boolean }) => {
    const res = await api.updateNotebook(id, patch);
    setNotebooks((prev) => prev?.map((notebook) => (notebook.id === id ? res.notebook : notebook)) ?? null);
    return res.notebook;
  }, []);

  return { notebooks, error, refresh, create, remove, update };
}
