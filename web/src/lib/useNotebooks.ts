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

  return { notebooks, error, refresh, create, remove };
}
