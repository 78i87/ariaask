import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Notebook } from "./types";

export function useNotebooks() {
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listNotebooks();
      setNotebooks(res.notebooks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notebooks");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async (form: FormData) => {
    const res = await api.createNotebook(form);
    setNotebooks((prev) => (prev ? [res.notebook, ...prev] : [res.notebook]));
    return res;
  }, []);

  const remove = useCallback(async (id: string) => {
    setNotebooks((prev) => prev?.filter((n) => n.id !== id) ?? null);
    await api.deleteNotebook(id);
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    const res = await api.updateNotebook(id, { title });
    setNotebooks((prev) => prev?.map((notebook) => (notebook.id === id ? res.notebook : notebook)) ?? null);
    return res.notebook;
  }, []);

  const setArchived = useCallback(async (id: string, archived: boolean) => {
    const res = await api.updateNotebook(id, { archived });
    setNotebooks((prev) => prev?.map((notebook) => (notebook.id === id ? res.notebook : notebook)) ?? null);
    return res.notebook;
  }, []);

  return { notebooks, error, refresh, create, remove, rename, setArchived };
}

export type NotebooksController = ReturnType<typeof useNotebooks>;
