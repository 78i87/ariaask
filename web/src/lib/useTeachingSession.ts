import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { ChatMessage, DiscoverFailure, Intake, IntakeAnswerPayload, KnowledgeState, Notebook, SessionStateEvent, SourceFile } from "./types";

export type SessionStatus = "loading" | "idle" | "waiting" | "streaming" | "error";
export type SessionActivity = "reading-sources" | "thinking" | "researching" | null;

export interface TeachingSession {
  notebook: Notebook | null;
  messages: ChatMessage[];
  status: SessionStatus;
  /** True while the hidden kickoff turn runs (sources being read). */
  kickoffRunning: boolean;
  activity: SessionActivity;
  error: string | null;
  /** The setup form; null on pre-feature notebooks. */
  intake: Intake | null;
  /** The user's inferred knowledge map; null when absent or disabled. */
  knowledgeState: KnowledgeState | null;
  /** One-shot non-fatal message from the server (e.g. research failed). */
  notice: string | null;
  /** True while Aria is finding and downloading online sources. */
  discovering: boolean;
  /** True while the reading-recall index is being (re)built. */
  ragBuilding: boolean;
  /** True when the most recent index build failed — "ready" must not show. */
  ragBuildFailed: boolean;
  clearNotice: () => void;
  submitIntake: (payload: { skip?: boolean; answers?: IntakeAnswerPayload }) => void;
  discoverSources: (query: string) => void;
  send: (text: string) => void;
  /** Rewind-and-resend: replaces the message and deletes everything after it. */
  editMessage: (messageId: string, text: string) => void;
  interrupt: () => void;
  retry: () => void;
  /** Replace the notebook summary (e.g. after adding sources). */
  updateNotebook: (nb: Notebook) => void;
}

const STREAMING_ID_PREFIX = "streaming:";

export function useTeachingSession(notebookId: string): TeachingSession {
  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [kickoffRunning, setKickoffRunning] = useState(false);
  const [activity, setActivity] = useState<SessionActivity>(null);
  const [error, setError] = useState<string | null>(null);
  const [intake, setIntake] = useState<Intake | null>(null);
  const [knowledgeState, setKnowledgeState] = useState<KnowledgeState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [ragBuilding, setRagBuilding] = useState(false);
  const [ragBuildFailed, setRagBuildFailed] = useState(false);

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
    setIntake(res.intake);
    setKnowledgeState(res.knowledgeState);
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
    setDiscovering(false);
    setRagBuilding(false);
    setRagBuildFailed(false);
    void (async () => {
      try {
        const res = await loadNotebook();
        initialLoaded.current = true;
        if (cancelled) return;
        const intakePending = res.intake !== null && res.intake.status === "pending";
        if (res.turnActive) {
          setStatus("waiting");
        } else if (res.messages.length === 0 && intakePending) {
          // The setup form renders instead of auto-starting the kickoff.
          setStatus("idle");
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
        setKickoffRunning(data.kickoffRunning || data.intakeRunning);
        if (data.intakeRunning) setActivity("researching"); // restore indicator on reconnect mid-research
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
      setDiscovering(data.discoveryRunning === true);
      setRagBuilding(data.ragBuilding === true);
      setRagBuildFailed(data.ragBuildFailed === true);
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
      const data = JSON.parse((e as MessageEvent).data) as { kind: "reading-sources" | "thinking" | "researching" };
      setActivity(data.kind);
    });

    es.addEventListener("sources-updated", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { notebook: Notebook };
      setNotebook(data.notebook);
    });

    es.addEventListener("discover-completed", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        notebook: Notebook;
        added: SourceFile[];
        failures: DiscoverFailure[];
      };
      setNotebook(data.notebook);
      setDiscovering(false);
      if (data.added.length > 0 && data.failures.length > 0) {
        const total = data.added.length + data.failures.length;
        setNotice(`Added ${data.added.length} of ${total} sources — ${data.failures.length} pages couldn't be fetched.`);
      } else if (data.added.length > 0) {
        setNotice(`Added ${data.added.length} source${data.added.length === 1 ? "" : "s"} from the web.`);
      } else {
        // Distinguish "the search found nothing" from "all downloads failed" —
        // the latter is the sites' fault, not the query's.
        const reason = data.failures[0]?.reason;
        setNotice(
          reason
            ? `Aria couldn't add sources — ${reason}${data.failures.length > 1 ? ` (${data.failures.length} pages failed)` : ""}.`
            : "Aria couldn't find usable sources — try a more specific search.",
        );
      }
    });

    es.addEventListener("notice", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { message: string };
      setNotice(data.message);
    });

    // User-knowledge map updates (teacher-message evaluator, bootstrap, rewind re-derivation).
    // Safe mid-stream: touches no delta buffers, just swaps the map's data. A
    // drop spanning evaluator-broadcast → student-reply-persist can leave the
    // map one pass stale until the next teacher message forces a refetch via
    // messageCount drift — acceptable for a passive visualization.
    es.addEventListener("knowledge-state", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { state: KnowledgeState };
      setKnowledgeState(data.state);
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

  const editMessage = useCallback(
    (messageId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx < 0) return;
      // Optimistic rewind: drop the tail locally and show the edited message;
      // the server truncates, rebuilds the student's thread, and answers.
      const kept = messages.slice(0, idx).filter((m) => m.status === "complete");
      const optimisticId = crypto.randomUUID();
      knownIds.current = new Set(kept.map((m) => m.id));
      knownIds.current.add(optimisticId);
      persistedCount.current = kept.length + 1;
      deltaBuffers.current.clear();
      setMessages([...kept, { id: optimisticId, role: "teacher", text: trimmed, status: "complete" }]);
      setError(null);
      setStatus("waiting");
      void api.editMessage(notebookId, messageId, trimmed, optimisticId).catch((err) => {
        // Unlike send(), a rejected edit (incl. turn_active) leaves this tab's
        // optimistic truncation wrong — resync the real transcript, then surface it.
        void loadNotebook().catch(() => {});
        setStatus("error");
        setError(err instanceof Error ? err.message : "Couldn't edit the message");
      });
    },
    [messages, notebookId, loadNotebook],
  );

  const interrupt = useCallback(() => {
    void api.interrupt(notebookId).catch(() => {});
  }, [notebookId]);

  const retry = useCallback(() => {
    void startTurn(undefined, true);
  }, [startTurn]);

  const submitIntake = useCallback(
    (payload: { skip?: boolean; answers?: IntakeAnswerPayload }) => {
      const researching =
        payload.skip === true
          ? (notebook?.sourceFiles.length ?? 0) === 0
          : payload.answers?.research?.value !== "no";
      // Optimistic: the form yields to the progress indicator immediately.
      setIntake((prev) => (prev ? { ...prev, status: "done" } : prev));
      setError(null);
      setStatus("waiting");
      setKickoffRunning(true);
      if (researching) setActivity("researching");
      void api.submitIntake(notebookId, payload).catch((err) => {
        setIntake((prev) => (prev ? { ...prev, status: "pending" } : prev));
        setStatus("idle");
        setKickoffRunning(false);
        setActivity(null);
        setError(err instanceof Error ? err.message : "Couldn't start the session");
      });
    },
    [notebookId, notebook],
  );

  const clearNotice = useCallback(() => setNotice(null), []);

  const discoverSources = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (!trimmed || discovering) return;
      setDiscovering(true);
      void api.discoverSources(notebookId, { query: trimmed }).catch((err) => {
        if (err instanceof ApiError && err.code === "discover_active") {
          setNotice("Aria is already looking for sources.");
          setDiscovering(true);
          return;
        }
        setDiscovering(false);
        setNotice(err instanceof Error ? err.message : "Couldn't start source discovery.");
      });
    },
    [discovering, notebookId],
  );

  return {
    notebook,
    messages,
    status,
    kickoffRunning,
    activity,
    error,
    intake,
    knowledgeState,
    notice,
    discovering,
    ragBuilding,
    ragBuildFailed,
    clearNotice,
    submitIntake,
    discoverSources,
    send,
    editMessage,
    interrupt,
    retry,
    updateNotebook: setNotebook,
  };
}
