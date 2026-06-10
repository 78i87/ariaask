import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { CyraChatMessage, CyraThreadSummary } from "./types";

export type CyraStatus = "idle" | "loading" | "waiting" | "streaming" | "error";
export type CyraActivity = "reading-sources" | "thinking" | null;

export interface CyraThreadSession {
  messages: CyraChatMessage[];
  status: CyraStatus;
  activity: CyraActivity;
  error: string | null;
  send: (text: string) => void;
  interrupt: () => void;
  retry: () => void;
}

const STREAMING_ID_PREFIX = "streaming:";

/** The notebook's list of Cyra conversations, newest first. */
export function useCyraThreads(notebookId: string): { threads: CyraThreadSummary[]; refresh: () => Promise<void> } {
  const [threads, setThreads] = useState<CyraThreadSummary[]>([]);
  const refresh = useCallback(async () => {
    try {
      const res = await api.listCyraThreads(notebookId);
      setThreads([...res.threads].reverse());
    } catch {
      /* the bar just shows what it last knew */
    }
  }, [notebookId]);
  useEffect(() => {
    setThreads([]);
    void refresh();
  }, [refresh]);
  return { threads, refresh };
}

/**
 * One Cyra conversation's live state — a lean mirror of useTeachingSession
 * (same rAF delta buffering, optimistic send + SSE echo dedupe) with no
 * kickoff/intake machinery. Inert while threadId is null (the new-question
 * composer view owns that state).
 */
export function useCyraThread(notebookId: string, threadId: string | null): CyraThreadSession {
  const [messages, setMessages] = useState<CyraChatMessage[]>([]);
  const [status, setStatus] = useState<CyraStatus>(threadId ? "loading" : "idle");
  const [activity, setActivity] = useState<CyraActivity>(null);
  const [error, setError] = useState<string | null>(null);

  const deltaBuffers = useRef(new Map<string, string>());
  const rafPending = useRef(false);
  const rafId = useRef(0);
  const persistedCount = useRef(0);
  const initialLoaded = useRef(false);
  const knownIds = useRef(new Set<string>());

  const flushDeltas = useCallback(() => {
    rafPending.current = false;
    const buffers = deltaBuffers.current;
    if (buffers.size === 0) return;
    setMessages((prev) => {
      let next = [...prev];
      for (const [itemId, text] of buffers) {
        const id = STREAMING_ID_PREFIX + itemId;
        const idx = next.findIndex((m) => m.id === id);
        if (idx >= 0) {
          next[idx] = { ...next[idx]!, text };
        } else {
          next = [...next, { id, role: "cyra", text, status: "streaming" }];
        }
      }
      return next;
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (!rafPending.current) {
      rafPending.current = true;
      rafId.current = requestAnimationFrame(flushDeltas);
    }
  }, [flushDeltas]);

  const loadThread = useCallback(async () => {
    if (!threadId) return null;
    const res = await api.getCyraThread(notebookId, threadId);
    persistedCount.current = res.messages.length;
    knownIds.current = new Set(res.messages.map((m) => m.id));
    setMessages(
      res.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        status: "complete" as const,
        interrupted: m.interrupted,
      })),
    );
    return res;
  }, [notebookId, threadId]);

  // Initial load (and full reset when switching threads).
  useEffect(() => {
    initialLoaded.current = false;
    persistedCount.current = 0;
    knownIds.current = new Set();
    deltaBuffers.current.clear();
    setMessages([]);
    setError(null);
    setActivity(null);
    setStatus(threadId ? "loading" : "idle");
    if (!threadId) return;
    let cancelled = false;
    void loadThread()
      .then((res) => {
        if (cancelled || !res) return;
        initialLoaded.current = true;
        setStatus(res.turnActive ? "waiting" : "idle");
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus("error");
          setError(err instanceof Error ? err.message : "Failed to load the conversation");
        }
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId.current);
      rafPending.current = false;
      deltaBuffers.current.clear();
    };
  }, [threadId, loadThread]);

  // SSE channel — one per open Cyra thread, closed on switch.
  useEffect(() => {
    if (!threadId) return;
    const es = new EventSource(api.cyraEventsUrl(notebookId, threadId));

    es.addEventListener("state", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        turnActive: boolean;
        partials: Record<string, string>;
        messageCount: number;
      };
      if (initialLoaded.current && data.messageCount !== persistedCount.current) {
        void loadThread().then(() => setStatus(data.turnActive ? "waiting" : "idle"));
      }
      if (data.turnActive) {
        const entries = Object.entries(data.partials ?? {});
        if (entries.length > 0) {
          for (const [itemId, text] of entries) deltaBuffers.current.set(itemId, text);
          setStatus("streaming");
          scheduleFlush();
        } else {
          setStatus((s) => (s === "loading" || s === "idle" ? "waiting" : s));
        }
      }
    });

    es.addEventListener("turn-started", () => {
      setStatus("waiting");
      setActivity(null);
    });

    es.addEventListener("delta", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { itemId: string; delta: string };
      const buf = deltaBuffers.current;
      buf.set(data.itemId, (buf.get(data.itemId) ?? "") + data.delta);
      setStatus("streaming");
      scheduleFlush();
    });

    es.addEventListener("activity", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { kind: "reading-sources" | "thinking" };
      setActivity(data.kind);
    });

    es.addEventListener("message", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        id: string;
        role?: "user" | "cyra";
        text: string;
        interrupted?: boolean;
      };
      if (knownIds.current.has(data.id)) return;
      knownIds.current.add(data.id);
      persistedCount.current += 1;
      const role = data.role ?? "cyra";
      if (role === "cyra") {
        deltaBuffers.current.clear();
        setMessages((prev) => {
          const withoutStreaming = prev.filter((m) => m.status !== "streaming");
          return [
            ...withoutStreaming,
            { id: data.id, role: "cyra", text: data.text, status: "complete", interrupted: data.interrupted },
          ];
        });
      } else {
        setMessages((prev) => [...prev, { id: data.id, role: "user", text: data.text, status: "complete" }]);
      }
    });

    es.addEventListener("turn-completed", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        status: "completed" | "interrupted" | "failed";
        error?: { message: string };
      };
      deltaBuffers.current.clear();
      setActivity(null);
      setMessages((prev) =>
        prev
          .filter((m) => !(m.status === "streaming" && !m.text.trim()))
          .map((m) => (m.status === "streaming" ? { ...m, status: "complete" as const, interrupted: true } : m)),
      );
      if (data.status === "failed") {
        setStatus("error");
        setError(data.error?.message ?? "Cyra lost her train of thought.");
      } else {
        setStatus("idle");
      }
    });

    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data;
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data) as { message: string };
          setError(parsed.message);
        } catch {
          /* transport error — EventSource will reconnect */
        }
      }
    });

    return () => es.close();
  }, [notebookId, threadId, loadThread, scheduleFlush]);

  const send = useCallback(
    (text: string) => {
      if (!threadId) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      const optimisticId = crypto.randomUUID();
      knownIds.current.add(optimisticId);
      setMessages((prev) => [...prev, { id: optimisticId, role: "user", text: trimmed, status: "complete" }]);
      persistedCount.current += 1;
      setError(null);
      setStatus("waiting");
      void api.sendCyraMessage(notebookId, threadId, { text: trimmed, clientMessageId: optimisticId }).catch((err) => {
        if (err instanceof ApiError && err.code === "turn_active") return; // SSE will drive the UI
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        knownIds.current.delete(optimisticId);
        persistedCount.current -= 1;
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to reach Cyra");
      });
    },
    [notebookId, threadId],
  );

  const interrupt = useCallback(() => {
    if (threadId) void api.interruptCyra(notebookId, threadId).catch(() => {});
  }, [notebookId, threadId]);

  const retry = useCallback(() => {
    if (!threadId) return;
    setError(null);
    setStatus("waiting");
    void api.sendCyraMessage(notebookId, threadId, { retry: true }).catch((err) => {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to reach Cyra");
    });
  }, [notebookId, threadId]);

  return { messages, status, activity, error, send, interrupt, retry };
}
