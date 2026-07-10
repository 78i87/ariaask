import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { CoachChatMessage } from "./types";

export type CoachStatus = "loading" | "idle" | "waiting" | "streaming" | "error";
export type CoachActivity = "reading-sources" | "thinking" | null;

export interface CoachThreadSession {
  messages: CoachChatMessage[];
  status: CoachStatus;
  activity: CoachActivity;
  error: string | null;
  send: (text: string) => void;
  /** Rewind-and-resend: replaces the message and deletes everything after it. */
  editMessage: (messageId: string, text: string, onSuccess?: () => void) => void;
  interrupt: () => void;
  retry: () => void;
}

const STREAMING_ID_PREFIX = "streaming:";

/**
 * The notebook's coach conversation — a mirror of useCyraThread keyed by
 * notebookId only (one coach per notebook), plus a once-guarded auto-kickoff:
 * a fresh coach greets the user without them having to type first.
 */
export function useCoachThread(notebookId: string): CoachThreadSession {
  const [messages, setMessages] = useState<CoachChatMessage[]>([]);
  const [status, setStatus] = useState<CoachStatus>("loading");
  const [activity, setActivity] = useState<CoachActivity>(null);
  const [error, setError] = useState<string | null>(null);

  const deltaBuffers = useRef(new Map<string, string>());
  const rafPending = useRef(false);
  const rafId = useRef(0);
  const persistedCount = useRef(0);
  const initialLoaded = useRef(false);
  const knownIds = useRef(new Set<string>());
  const kickoffTried = useRef(false);

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
          next = [...next, { id, role: "coach", text, status: "streaming" }];
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

  const loadCoach = useCallback(async () => {
    const res = await api.getCoach(notebookId);
    persistedCount.current = res.messages.length;
    knownIds.current = new Set(res.messages.map((m) => m.id));
    setMessages(
      res.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        status: "complete" as const,
        interrupted: m.interrupted,
        createdAt: m.createdAt,
      })),
    );
    return res;
  }, [notebookId]);

  // Initial load (and full reset when switching projects), plus auto-kickoff.
  useEffect(() => {
    initialLoaded.current = false;
    kickoffTried.current = false;
    persistedCount.current = 0;
    knownIds.current = new Set();
    deltaBuffers.current.clear();
    setMessages([]);
    setError(null);
    setActivity(null);
    setStatus("loading");
    let cancelled = false;
    void loadCoach()
      .then((res) => {
        if (cancelled) return;
        initialLoaded.current = true;
        setStatus(res.turnActive ? "waiting" : "idle");
        if (!res.coach.kickoffDone && res.messages.length === 0 && !res.turnActive && !kickoffTried.current) {
          kickoffTried.current = true;
          setStatus("waiting");
          void api.coachKickoff(notebookId).catch((err) => {
            if (cancelled) return;
            setStatus("error");
            setError(err instanceof Error ? err.message : "The coach couldn't start");
          });
        }
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
  }, [notebookId, loadCoach]);

  // SSE channel — one per open project.
  useEffect(() => {
    const es = new EventSource(api.coachEventsUrl(notebookId));

    es.addEventListener("state", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        turnActive: boolean;
        partials: Record<string, string>;
        messageCount: number;
      };
      if (initialLoaded.current && data.messageCount !== persistedCount.current) {
        void loadCoach().then(() => setStatus(data.turnActive ? "waiting" : "idle"));
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
        role?: "user" | "coach";
        text: string;
        interrupted?: boolean;
      };
      if (knownIds.current.has(data.id)) return;
      knownIds.current.add(data.id);
      persistedCount.current += 1;
      const role = data.role ?? "coach";
      // SSE message events carry no timestamp — they just happened.
      const createdAt = new Date().toISOString();
      if (role === "coach") {
        deltaBuffers.current.clear();
        setMessages((prev) => {
          const withoutStreaming = prev.filter((m) => m.status !== "streaming" && !m.id.startsWith(STREAMING_ID_PREFIX));
          return [
            ...withoutStreaming,
            { id: data.id, role: "coach", text: data.text, status: "complete", interrupted: data.interrupted, createdAt },
          ];
        });
      } else {
        setMessages((prev) => [...prev, { id: data.id, role: "user", text: data.text, status: "complete", createdAt }]);
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
          .map((m) =>
            m.status === "streaming"
              ? { ...m, status: "complete" as const, interrupted: data.status !== "completed" }
              : m,
          ),
      );
      if (data.status === "failed") {
        setStatus("error");
        setError(data.error?.message ?? "The coach lost their train of thought.");
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
  }, [notebookId, loadCoach, scheduleFlush]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const optimisticId = crypto.randomUUID();
      knownIds.current.add(optimisticId);
      setMessages((prev) => [
        ...prev,
        { id: optimisticId, role: "user", text: trimmed, status: "complete", createdAt: new Date().toISOString() },
      ]);
      persistedCount.current += 1;
      setError(null);
      setStatus("waiting");
      void api.sendCoachMessage(notebookId, { text: trimmed, clientMessageId: optimisticId }).catch((err) => {
        if (err instanceof ApiError && err.code === "turn_active") return; // SSE will drive the UI
        setMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        knownIds.current.delete(optimisticId);
        persistedCount.current -= 1;
        setStatus("error");
        setError(err instanceof Error ? err.message : "Failed to reach the coach");
      });
    },
    [notebookId],
  );

  const editMessage = useCallback(
    (messageId: string, text: string, onSuccess?: () => void) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      // Optimistic rewind, mirroring useCyraThread.editMessage.
      const kept = messages.slice(0, idx).filter((m) => m.status === "complete");
      const optimisticId = crypto.randomUUID();
      knownIds.current = new Set(kept.map((m) => m.id));
      knownIds.current.add(optimisticId);
      persistedCount.current = kept.length + 1;
      deltaBuffers.current.clear();
      setMessages([
        ...kept,
        { id: optimisticId, role: "user", text: trimmed, status: "complete", createdAt: new Date().toISOString() },
      ]);
      setError(null);
      setStatus("waiting");
      void api.editCoachMessage(notebookId, messageId, trimmed, optimisticId).then(
        () => onSuccess?.(),
        (err) => {
          // A rejected edit leaves this tab's optimistic truncation wrong — resync.
          void loadCoach().catch(() => {});
          setStatus("error");
          setError(err instanceof Error ? err.message : "Couldn't edit the message");
        },
      );
    },
    [notebookId, messages, loadCoach],
  );

  const interrupt = useCallback(() => {
    void api.interruptCoach(notebookId).catch(() => {});
  }, [notebookId]);

  const retry = useCallback(() => {
    setError(null);
    setStatus("waiting");
    // A failed kickoff has no user message to retry — re-kickoff instead.
    const hasUserMessage = messages.some((m) => m.role === "user");
    const call = hasUserMessage ? api.sendCoachMessage(notebookId, { retry: true }) : api.coachKickoff(notebookId);
    void call.catch((err) => {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Failed to reach the coach");
    });
  }, [notebookId, messages]);

  return { messages, status, activity, error, send, editMessage, interrupt, retry };
}
