import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { SseConnection } from "../lib/sse.js";
import { HttpError } from "../lib/errors.js";
import { AppServerClient } from "../appserver/client.js";
import { RpcError } from "../appserver/rpc.js";
import type { CyraThread, CyraThreadSummary, Notebook, NotebookStore } from "./store.js";
import { toCyraThreadSummary } from "./store.js";
import type { SettingsStore } from "./settings.js";
import { buildCyraCatchUpBlock, buildCyraInstructions, deriveCyraTitle, renderCyraRetrievalBlock } from "./cyra.js";
import { buildRagQuery, buildRetrievalBlockWith } from "./rag.js";
import type {
  AgentMessageDeltaNotification,
  ErrorNotification,
  ItemNotification,
  ThreadStartParams,
  TurnCompletedNotification,
} from "../appserver/protocol.js";

type TurnState = "idle" | "starting" | "streaming" | "interrupting";

// Mirrors session.ts:41-42 — same inactivity and overload posture as Aria turns.
const TURN_INACTIVITY_MS = 5 * 60_000;
const OVERLOAD_RETRY_DELAYS_MS = [1000, 4000];

interface CyraSession {
  notebookId: string;
  cyraThreadId: string;
  clients: Set<SseConnection>;
  seq: number;
  state: TurnState;
  turnId: string | null;
  partials: Map<string, string>;
  finalizedItems: Set<string>;
  threadGeneration: number;
  catchUpNeeded: boolean;
  /** Set by interrupt() while a turn is still "starting"; aborts before turn/start. */
  cancelRequested: boolean;
  unsubscribe: (() => void) | null;
  watchdog: NodeJS.Timeout | null;
  forceResetTimer: NodeJS.Timeout | null;
}

/**
 * Sessions for the "Ask Cyra" expert threads. A deliberate lean MIRROR of
 * SessionManager (session.ts) rather than a refactor of it: the Aria session
 * is dense with invariants (kickoff buffering, evaluator pass, pending-source
 * notes, belief blocks) that simply don't exist here, and sharing code would
 * couple the two lifecycles. Each mirrored block cites its session.ts source.
 * Cyra turns run CONCURRENTLY with Aria turns — separate codex threads,
 * separate state machines, same per-notebook store save chain.
 */
export class CyraSessionManager {
  /** Keyed by cyraThreadId (uuid — globally unique, no notebook prefix needed). */
  private sessions = new Map<string, CyraSession>();

  constructor(
    private client: AppServerClient,
    private store: NotebookStore,
    private settings: SettingsStore,
  ) {
    // Mirrors session.ts:85.
    client.on("crashed", () => this.failAllActiveTurns("Cyra's connection dropped."));
  }

  private findThread(notebookId: string, cyraThreadId: string): { nb: Notebook; ct: CyraThread } {
    const nb = this.store.get(notebookId);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const ct = nb.cyraThreads?.find((t) => t.id === cyraThreadId);
    if (!ct) throw new HttpError(404, "cyra_thread_not_found");
    return { nb, ct };
  }

  // ---------- SSE (mirrors session.ts:90-107, minus kickoff/intake fields) ----------

  attach(notebookId: string, cyraThreadId: string, res: Response): void {
    const { ct } = this.findThread(notebookId, cyraThreadId);
    const session = this.ensureSession(notebookId, cyraThreadId);
    const conn = new SseConnection(res, () => session.clients.delete(conn));
    session.clients.add(conn);
    conn.send(
      "state",
      {
        turnActive: session.state !== "idle",
        turnId: session.turnId,
        partials: Object.fromEntries(session.partials),
        messageCount: ct.messages.length,
      },
      ++session.seq,
    );
  }

  getState(cyraThreadId: string): { turnActive: boolean } {
    const session = this.sessions.get(cyraThreadId);
    return { turnActive: session ? session.state !== "idle" : false };
  }

  // ---------- turns ----------

  /**
   * Start a Cyra turn. cyraThreadId null = create-on-first-send: the thread
   * record, the seed user message, and the first turn happen atomically — any
   * failure rolls the whole thread back so abandoned/failed asks leave nothing.
   */
  async startTurn(
    notebookId: string,
    opts: {
      cyraThreadId: string | null;
      text?: string;
      retry?: boolean;
      clientMessageId?: string;
      sourceMessageId?: string | null;
    },
  ): Promise<{ thread: CyraThreadSummary; turnId: string | null }> {
    const nb = this.store.get(notebookId);
    if (!nb) throw new HttpError(404, "notebook_not_found");

    let ct: CyraThread;
    let created = false;
    let retryMsg: { id: string; text: string } | null = null;
    let text: string;

    if (opts.cyraThreadId === null) {
      if (!opts.text || !opts.text.trim()) throw new HttpError(400, "empty_message");
      text = opts.text.trim();
      const now = new Date().toISOString();
      ct = {
        id: randomUUID(),
        threadId: null,
        title: deriveCyraTitle(text),
        sourceMessageId: opts.sourceMessageId ?? null,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      nb.cyraThreads = [...(nb.cyraThreads ?? []), ct];
      created = true; // persisted below together with the seed message
    } else {
      ct = this.findThread(notebookId, opts.cyraThreadId).ct;
      if (opts.retry) {
        // Mirrors session.ts:153-156 — re-answer the last persisted user
        // message without persisting a duplicate.
        retryMsg = [...ct.messages].reverse().find((m) => m.role === "user") ?? null;
        if (!retryMsg) throw new HttpError(400, "nothing_to_retry");
        text = retryMsg.text;
      } else {
        if (!opts.text || !opts.text.trim()) throw new HttpError(400, "empty_message");
        text = opts.text.trim();
      }
    }

    const session = this.ensureSession(notebookId, ct.id);
    if (session.state !== "idle") throw new HttpError(409, "turn_active", "Cyra is already answering.");

    session.state = "starting";
    session.turnId = null;
    session.partials.clear();
    session.finalizedItems.clear();
    session.cancelRequested = false;

    let userMessageId: string | null = null;
    try {
      await this.ensureCyraThread(nb, ct, session);

      // Snapshot the catch-up BEFORE persisting the new user message (and
      // excluding a retried one) — mirrors session.ts:173-180.
      let catchUp = "";
      if (session.catchUpNeeded) {
        const history = retryMsg ? ct.messages.filter((m) => m.id !== retryMsg.id) : ct.messages;
        catchUp = buildCyraCatchUpBlock(history);
      }

      if (!opts.retry) {
        // Optimistic persist + SSE echo, rolled back on failure — mirrors
        // session.ts:207-219. For a created thread this single save also
        // persists the thread record itself.
        userMessageId = opts.clientMessageId ?? randomUUID();
        ct.messages.push({ id: userMessageId, role: "user", text, turnId: null, createdAt: new Date().toISOString() });
        ct.updatedAt = new Date().toISOString();
        await this.store.save(nb);
        this.broadcast(session, "message", { id: userMessageId, role: "user", text });
      }

      // Same grounding as the student turns, expert framing. buildRagQuery
      // keys off role "student", so Cyra degrades to question-only — fine.
      // Unlike Aria, Cyra also recalls from just-uploaded sources: the
      // pendingNewSources gate is student fiction ("I haven't been told about
      // that reading yet") and asking the expert about new material is the
      // whole point of this thread.
      const ragBlock = await buildRetrievalBlockWith(
        this.store,
        this.settings,
        nb,
        buildRagQuery([], text),
        renderCyraRetrievalBlock,
        { excludePendingSources: false },
      );
      if (session.cancelRequested) {
        throw new HttpError(409, "turn_cancelled", "Stopped before Cyra replied.");
      }

      const s = this.settings.get();
      const turn = await this.turnStartWithRetry(ct.threadId!, catchUp + ragBlock + text, s.model, s.effort);
      session.catchUpNeeded = false;
      session.turnId = turn.id;
      session.state = "streaming";
      this.resetWatchdog(session);
      this.broadcast(session, "turn-started", { turnId: turn.id });
      return { thread: toCyraThreadSummary(ct), turnId: turn.id };
    } catch (err) {
      session.state = "idle";
      this.clearWatchdog(session);
      // Mirrors session.ts:283-300, plus whole-thread rollback on first-send
      // failure so no empty Cyra threads exist.
      if (userMessageId) {
        const idx = ct.messages.findIndex((m) => m.id === userMessageId);
        if (idx >= 0) ct.messages.splice(idx, 1);
      }
      if (created) {
        nb.cyraThreads = (nb.cyraThreads ?? []).filter((t) => t.id !== ct.id);
        this.disposeSession(ct.id);
      }
      if (userMessageId || created) await this.store.save(nb).catch(() => {});
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : "Failed to start the turn";
      this.broadcast(session, "error", { message, retryable: true });
      throw new HttpError(502, "turn_start_failed", message);
    }
  }

  /**
   * Rewind-and-resend inside a Cyra conversation (mirrors session.ts
   * editTurn, minus the belief machinery — Cyra has none): the edited user
   * message and everything after it are deleted, and the codex thread is
   * rebuilt from a catch-up of the surviving prefix. Editing the seed
   * question also re-derives the thread title.
   */
  async editTurn(
    notebookId: string,
    cyraThreadId: string,
    messageId: string,
    text: string | undefined,
    clientMessageId?: string,
  ): Promise<{ thread: CyraThreadSummary; turnId: string | null }> {
    const { nb, ct } = this.findThread(notebookId, cyraThreadId);
    const session = this.ensureSession(notebookId, ct.id);
    if (session.state !== "idle") throw new HttpError(409, "turn_active", "Cyra is already answering.");
    if (!text || !text.trim()) throw new HttpError(400, "empty_message");
    const idx = ct.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) throw new HttpError(404, "message_not_found");
    if (ct.messages[idx]!.role !== "user") {
      throw new HttpError(400, "not_editable", "Only your own messages can be edited.");
    }

    // Occupy the state machine while truncating — a concurrent send must not
    // land on a half-rewound thread.
    session.state = "starting";
    try {
      ct.messages = ct.messages.slice(0, idx);
      ct.threadId = null; // Cyra must not remember the deleted turns
      if (idx === 0) ct.title = deriveCyraTitle(text.trim());
      ct.updatedAt = new Date().toISOString();
      await this.store.save(nb);
    } finally {
      // startTurn re-checks idle synchronously right after this — no interleave.
      session.state = "idle";
    }

    try {
      return await this.startTurn(notebookId, { cyraThreadId: ct.id, text, clientMessageId });
    } finally {
      // Other attached tabs still hold the deleted tail — make them refetch.
      this.broadcastState(session, ct);
    }
  }

  /** The attach() snapshot, pushed mid-session — clients refetch when messageCount drifts. */
  private broadcastState(session: CyraSession, ct: CyraThread): void {
    this.broadcast(session, "state", {
      turnActive: session.state !== "idle",
      turnId: session.turnId,
      partials: Object.fromEntries(session.partials),
      messageCount: ct.messages.length,
    });
  }

  /** Mirrors session.ts:303-324. */
  async interrupt(notebookId: string, cyraThreadId: string): Promise<boolean> {
    const session = this.sessions.get(cyraThreadId);
    const nb = this.store.get(notebookId);
    const ct = nb?.cyraThreads?.find((t) => t.id === cyraThreadId);
    if (!session || !ct || session.state === "idle") return false;
    if (session.state === "starting") {
      session.cancelRequested = true;
      return true;
    }
    if (!session.turnId || !ct.threadId) return false;
    session.state = "interrupting";
    try {
      await this.client.turnInterrupt(ct.threadId, session.turnId);
    } catch (err) {
      console.error("[aria] cyra turn/interrupt failed:", err);
    }
    return true;
  }

  /** Tear down every Cyra session of a notebook being deleted (mirrors session.ts:326-334). */
  async disposeNotebook(notebookId: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.notebookId !== notebookId) continue;
      if (session.state !== "idle") await this.interrupt(notebookId, id).catch(() => {});
      this.disposeSession(id);
    }
  }

  // ---------- internals ----------

  private disposeSession(cyraThreadId: string): void {
    const session = this.sessions.get(cyraThreadId);
    if (!session) return;
    session.unsubscribe?.();
    this.clearWatchdog(session);
    for (const c of session.clients) c.close();
    this.sessions.delete(cyraThreadId);
  }

  private ensureSession(notebookId: string, cyraThreadId: string): CyraSession {
    let s = this.sessions.get(cyraThreadId);
    if (!s) {
      s = {
        notebookId,
        cyraThreadId,
        clients: new Set(),
        seq: 0,
        state: "idle",
        turnId: null,
        partials: new Map(),
        finalizedItems: new Set(),
        threadGeneration: -1,
        catchUpNeeded: false,
        cancelRequested: false,
        unsubscribe: null,
        watchdog: null,
        forceResetTimer: null,
      };
      this.sessions.set(cyraThreadId, s);
    }
    return s;
  }

  /**
   * Mirrors session.ts ensureThread (648-694) without the style machinery —
   * Cyra's instructions never change, so a live thread only needs resuming
   * across app-server respawns.
   */
  private async ensureCyraThread(nb: Notebook, ct: CyraThread, session: CyraSession): Promise<void> {
    const s = this.settings.get();
    if (ct.threadId && session.threadGeneration === this.client.generation) return;

    const threadConfig: Omit<ThreadStartParams, "ephemeral"> = {
      cwd: this.store.sourcesDir(nb.id),
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: buildCyraInstructions(nb),
      personality: "none",
      model: s.model,
    };

    const startFresh = async () => {
      const res = await this.client.threadStart({ ...threadConfig, ephemeral: false });
      ct.threadId = res.thread.id;
      await this.store.save(nb);
      if (ct.messages.length > 0) session.catchUpNeeded = true;
    };

    if (!ct.threadId) {
      await startFresh();
    } else {
      try {
        await this.client.threadResume({ threadId: ct.threadId, ...threadConfig });
      } catch (err) {
        console.error(`[aria] cyra thread/resume failed for ${ct.threadId}; starting fresh thread:`, err);
        await startFresh();
      }
    }

    session.unsubscribe?.();
    session.unsubscribe = this.client.subscribeThread(ct.threadId!, (method, params) =>
      this.onThreadNotification(session, method, params),
    );
    session.threadGeneration = this.client.generation;
  }

  /** Mirrors session.ts:696-717 verbatim. */
  private async turnStartWithRetry(threadId: string, text: string, model: string | null, effort: string | null) {
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.client.turnStart({
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          model,
          effort,
        });
        return res.turn;
      } catch (err) {
        const overloaded = err instanceof RpcError && (err.code === -32001 || /overload/i.test(err.message));
        const delay = OVERLOAD_RETRY_DELAYS_MS[attempt];
        if (!overloaded || delay === undefined) throw err;
        attempt++;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** Mirrors session.ts:719-780, minus the kickoff and learning-state branches. */
  private onThreadNotification(session: CyraSession, method: string, params: unknown): void {
    if (session.state === "idle") return;
    this.resetWatchdog(session);

    switch (method) {
      case "item/agentMessage/delta": {
        const p = params as AgentMessageDeltaNotification;
        if (session.turnId === null || p.turnId !== session.turnId) return;
        session.partials.set(p.itemId, (session.partials.get(p.itemId) ?? "") + p.delta);
        this.broadcast(session, "delta", { itemId: p.itemId, delta: p.delta });
        return;
      }
      case "item/started": {
        const p = params as ItemNotification;
        if (p.item.type === "commandExecution") {
          this.broadcast(session, "activity", { kind: "reading-sources" });
        } else if (p.item.type === "reasoning") {
          this.broadcast(session, "activity", { kind: "thinking" });
        }
        return;
      }
      case "item/completed": {
        const p = params as ItemNotification;
        if (session.turnId === null || p.turnId !== session.turnId) return;
        if (p.item.type !== "agentMessage") return;
        const text = typeof p.item.text === "string" ? p.item.text : "";
        session.finalizedItems.add(p.item.id);
        session.partials.delete(p.item.id);
        void this.persistCyraMessage(session, { id: p.item.id, text, turnId: p.turnId }).catch((err) =>
          console.error("[aria] persistCyraMessage failed:", err),
        );
        return;
      }
      case "turn/completed": {
        const p = params as TurnCompletedNotification;
        if (session.turnId === null || p.turn.id !== session.turnId) return;
        void this.onTurnCompleted(session, p).catch((err) => console.error("[aria] cyra onTurnCompleted failed:", err));
        return;
      }
      case "error": {
        const p = params as ErrorNotification;
        if (!p.willRetry) {
          this.broadcast(session, "error", {
            message: p.error.message,
            code: typeof p.error.codexErrorInfo === "string" ? p.error.codexErrorInfo : undefined,
            retryable: true,
          });
        }
        return;
      }
    }
  }

  /** Mirrors session.ts persistStudentMessage (782-805) with role "cyra". */
  private async persistCyraMessage(
    session: CyraSession,
    msg: { id: string; text: string; turnId: string | null; interrupted?: true },
  ): Promise<void> {
    const nb = this.store.get(session.notebookId);
    const ct = nb?.cyraThreads?.find((t) => t.id === session.cyraThreadId);
    if (!nb || !ct || !msg.text.trim()) return;
    ct.messages.push({
      id: msg.id,
      role: "cyra",
      text: msg.text,
      turnId: msg.turnId,
      ...(msg.interrupted ? { interrupted: true as const } : {}),
      createdAt: new Date().toISOString(),
    });
    ct.updatedAt = new Date().toISOString();
    await this.store.save(nb);
    this.broadcast(session, "message", {
      id: msg.id,
      role: "cyra",
      text: msg.text,
      interrupted: msg.interrupted ?? false,
    });
  }

  /** Mirrors session.ts onTurnCompleted (807-852) minus the kickoff branch. */
  private async onTurnCompleted(session: CyraSession, p: TurnCompletedNotification): Promise<void> {
    this.clearWatchdog(session);

    if (p.turn.status === "interrupted" || p.turn.status === "failed") {
      for (const [itemId, text] of session.partials) {
        if (!session.finalizedItems.has(itemId) && text.trim()) {
          await this.persistCyraMessage(session, { id: itemId, text, turnId: p.turn.id, interrupted: true });
        }
      }
    }

    const error =
      p.turn.status === "failed"
        ? {
            message: p.turn.error?.message ?? "The turn failed.",
            code: typeof p.turn.error?.codexErrorInfo === "string" ? p.turn.error.codexErrorInfo : undefined,
          }
        : undefined;

    session.state = "idle";
    session.turnId = null;
    session.partials.clear();
    session.finalizedItems.clear();
    if (error) this.broadcast(session, "error", { ...error, retryable: true });
    this.broadcast(session, "turn-completed", { turnId: p.turn.id, status: p.turn.status, error });
  }

  /** Mirrors session.ts:854-876. */
  private failAllActiveTurns(message: string): void {
    for (const session of this.sessions.values()) {
      if (session.state === "idle") continue;
      void (async () => {
        for (const [itemId, text] of session.partials) {
          if (!session.finalizedItems.has(itemId) && text.trim()) {
            await this.persistCyraMessage(session, { id: itemId, text, turnId: session.turnId, interrupted: true });
          }
        }
        session.state = "idle";
        session.turnId = null;
        session.partials.clear();
        session.finalizedItems.clear();
        this.clearWatchdog(session);
        this.broadcast(session, "error", { message, retryable: true });
        this.broadcast(session, "turn-completed", { turnId: null, status: "failed", error: { message } });
      })().catch((err) => console.error("[aria] cyra failAllActiveTurns failed:", err));
    }
  }

  /** Mirrors session.ts resetWatchdog (878-918). */
  private resetWatchdog(session: CyraSession): void {
    this.clearWatchdog(session);
    session.watchdog = setTimeout(() => {
      console.error(`[aria] cyra turn watchdog fired for thread ${session.cyraThreadId}`);
      const nb = this.store.get(session.notebookId);
      const ct = nb?.cyraThreads?.find((t) => t.id === session.cyraThreadId);
      const armedTurnId = session.turnId;
      if (ct?.threadId && armedTurnId) {
        void this.client.turnInterrupt(ct.threadId, armedTurnId).catch(() => {});
      }
      session.forceResetTimer = setTimeout(() => {
        session.forceResetTimer = null;
        if (session.state === "idle" || session.turnId !== armedTurnId) return;
        const partials = [...session.partials.entries()];
        const finalized = new Set(session.finalizedItems);
        session.state = "idle";
        session.turnId = null;
        session.partials.clear();
        session.finalizedItems.clear();
        void (async () => {
          for (const [itemId, text] of partials) {
            if (!finalized.has(itemId) && text.trim()) {
              await this.persistCyraMessage(session, { id: itemId, text, turnId: armedTurnId, interrupted: true });
            }
          }
          this.broadcast(session, "error", { message: "Cyra stopped responding.", retryable: true });
          this.broadcast(session, "turn-completed", { turnId: null, status: "failed", error: { message: "timeout" } });
        })().catch((err) => console.error("[aria] cyra watchdog force-reset failed:", err));
      }, 15_000);
    }, TURN_INACTIVITY_MS);
  }

  private clearWatchdog(session: CyraSession): void {
    if (session.watchdog) {
      clearTimeout(session.watchdog);
      session.watchdog = null;
    }
    if (session.forceResetTimer) {
      clearTimeout(session.forceResetTimer);
      session.forceResetTimer = null;
    }
  }

  private broadcast(session: CyraSession, event: string, data: unknown): void {
    const id = ++session.seq;
    for (const conn of session.clients) conn.send(event, data, id);
  }
}
