import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { ChatMessage, Notebook, SessionStateEvent } from "./types";

export type SessionStatus = "loading" | "idle" | "waiting" | "streaming" | "error";

export interface TeachingSession {
  notebook: Notebook | null;
  messages: ChatMessage[];
  status: SessionStatus;
  /** True while the hidden kickoff turn runs (sources being read). */
  kickoffRunning: boolean;
  activity: "reading-sources" | "thinking" | null;
  error: string | null;
  send: (text: string) => void;
  interrupt: () => void;
  retry: () => void;
}

const STREAMING_ID_PREFIX = "streaming:";

export function useTeachingSession(notebookId: string): TeachingSession {
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [kickoffRunning, setKickoffRunning] = useState(false);
  const [activity, setActivity] = useState<"reading-sources" | "thinking" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const deltaBuffers = useRef(new Map<string, string>());
  const rafPending = useRef(false);
  const kickoffTriggered = useRef(false);
  const persistedCount = useRef(0);
  const initialLoaded = useRef(false);
  /** Ids of messages already in local state — dedupes SSE echoes of our own sends. */
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
          next = [...next, { id, role: "student", text, status: "streaming" }];
        }
      }
      return next;
    });
  }, []);

  const rafId = useRef(0);
  const scheduleFlush = useCallback(() => {
    if (!rafPending.current) {
      rafPending.current = true;
      rafId.current = requestAnimationFrame(flushDeltas);
    }
  }, [flushDeltas]);

  // Cancel any pending flush and clear buffers when leaving a notebook.
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafId.current);
      rafPending.current = false;
      deltaBuffers.current.clear();
    };
  }, [notebookId]);

  const loadNotebook = useCallback(async () => {
    const res = await api.getNotebook(notebookId);
    setNotebook(res.notebook);
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
  }, [notebookId]);

  const startTurn = useCallback(
    async (text?: string, retry?: boolean, clientMessageId?: string): Promise<boolean> => {
      setError(null);
      setStatus("waiting");
      try {
        await api.sendMessage(notebookId, text, retry, clientMessageId);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === "turn_active") return true; // already running; SSE will drive UI
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to reach the student");
        return false;
      }
    },
    [notebookId],
  );

  // Initial load + kickoff auto-trigger.
  useEffect(() => {
    let cancelled = false;
    kickoffTriggered.current = false;
    initialLoaded.current = false;
    setStatus("loading");
    void (async () => {
      try {
        const res = await loadNotebook();
        initialLoaded.current = true;
        if (cancelled) return;
        if (res.turnActive) {
          setStatus("waiting");
        } else if (res.messages.length === 0 && !kickoffTriggered.current) {
          kickoffTriggered.current = true;
          setKickoffRunning(true);
          void startTurn();
        } else {
          setStatus("idle");
        }
      } catch (err) {
        if (!cancelled) {
          setStatus("error");
          setError(err instanceof Error ? err.message : "Failed to load notebook");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadNotebook, startTurn]);

  // SSE channel.
  useEffect(() => {
    const es = new EventSource(`/api/notebooks/${notebookId}/events`);

    es.addEventListener("state", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as SessionStateEvent;
      // Only resync once the initial load has set persistedCount — otherwise a
      // "state" arriving first would spuriously reload against a stale count of 0.
      if (initialLoaded.current && data.messageCount !== persistedCount.current) {
        void loadNotebook().then(() => {
          setStatus(data.turnActive ? "waiting" : "idle");
        });
      }
      if (data.turnActive) {
        setKickoffRunning(data.kickoffRunning);
        const entries = Object.entries(data.partials ?? {});
        if (entries.length > 0) {
          for (const [itemId, text] of entries) {
            deltaBuffers.current.set(itemId, text);
          }
          setStatus("streaming");
          scheduleFlush();
        } else {
          setStatus((s) => (s === "loading" || s === "idle" ? "waiting" : s));
        }
      }
    });

    es.addEventListener("turn-started", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { turnId: string; kickoff: boolean };
      setKickoffRunning(data.kickoff);
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
        role?: "teacher" | "student";
        text: string;
        interrupted?: boolean;
      };
      // Echo of a message this tab already has (e.g. its own optimistic send).
      if (knownIds.current.has(data.id)) return;
      knownIds.current.add(data.id);
      persistedCount.current += 1;
      const role = data.role ?? "student";
      if (role === "student") {
        deltaBuffers.current.clear();
        setMessages((prev) => {
          const withoutStreaming = prev.filter((m) => m.status !== "streaming");
          return [
            ...withoutStreaming,
            { id: data.id, role: "student", text: data.text, status: "complete", interrupted: data.interrupted },
          ];
        });
      } else {
        setMessages((prev) => [...prev, { id: data.id, role: "teacher", text: data.text, status: "complete" }]);
      }
    });

    es.addEventListener("turn-completed", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        status: "completed" | "interrupted" | "failed";
        error?: { message: string };
      };
      deltaBuffers.current.clear();
      setKickoffRunning(false);
      setActivity(null);
      // Reconcile any leftover streaming bubble: drop it if empty (no real text
      // ever arrived), otherwise mark it complete-but-interrupted.
      setMessages((prev) =>
        prev
          .filter((m) => !(m.status === "streaming" && !m.text.trim()))
          .map((m) => (m.status === "streaming" ? { ...m, status: "complete" as const, interrupted: true } : m)),
      );
      if (data.status === "failed") {
        setStatus("error");
        setError(data.error?.message ?? "The student lost their train of thought.");
      } else {
        setStatus("idle");
      }
    });

    es.addEventListener("error", (e) => {
      // Custom server "error" events carry data; EventSource transport errors don't.
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
  }, [notebookId, loadNotebook, scheduleFlush]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // The server persists under this same id, so the SSE broadcast of this
      // message dedupes against the optimistic copy in this tab.
      const optimisticId = crypto.randomUUID();
      knownIds.current.add(optimisticId);
      setMessages((prev) => [...prev, { id: optimisticId, role: "teacher", text: trimmed, status: "complete" }]);
      persistedCount.current += 1;
      void startTurn(trimmed, false, optimisticId).then((ok) => {
        if (!ok) {
          // Turn never started (the server rolled back its copy too): remove the orphan bubble.
          setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
          knownIds.current.delete(optimisticId);
          persistedCount.current -= 1;
        }
      });
    },
    [startTurn],
  );

  const interrupt = useCallback(() => {
    void api.interrupt(notebookId).catch(() => {});
  }, [notebookId]);

  const retry = useCallback(() => {
    void startTurn(undefined, true);
  }, [startTurn]);

  return { notebook, messages, status, kickoffRunning, activity, error, send, interrupt, retry };
}
