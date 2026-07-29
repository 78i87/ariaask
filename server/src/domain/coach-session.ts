import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { SseConnection } from "../lib/sse.js";
import { HttpError } from "../lib/errors.js";
import { AppServerClient } from "../appserver/client.js";
import { RpcError } from "../appserver/rpc.js";
import { config } from "../config.js";
import type { CoachSourceNotice, CoachState, Notebook, NotebookStore } from "./store.js";
import { ensureCoachState } from "./store.js";
import type { SettingsStore } from "./settings.js";
import type { UsageStore } from "./usage.js";
import {
  buildCoachCatchUpBlock,
  buildCoachInstructions,
  buildCoachKickoffPrompt,
  buildCoachRagQuery,
  renderCoachKbBlock,
  renderCoachSourcesBlock,
} from "./coach.js";
import { buildKbBlock } from "./kb.js";
import { buildSessionBlock, renderPlanBlock } from "./journey.js";
import { buildRetrievalBlockWith } from "./rag.js";
import type {
  AgentMessageDeltaNotification,
  ErrorNotification,
  ItemNotification,
  ThreadStartParams,
  TurnCompletedNotification,
} from "../appserver/protocol.js";

type PersistedCoachSourceNotice = string | CoachSourceNotice;

export function renderCoachSourceNotesBlock(notes: PersistedCoachSourceNotice[]): string {
  const added: string[] = [];
  const removed: string[] = [];
  for (const note of notes) {
    if (typeof note === "string") added.push(note);
    else if (note.kind === "added") added.push(note.name);
    else removed.push(note.name);
  }
  const updates: string[] = [];
  if (added.length > 0) {
    updates.push(
      `Since your last turn the user added new study material: ${added.join(", ")}. Relevant excerpts are included below when retrieval finds a match.`,
    );
  }
  if (removed.length > 0) {
    updates.push(
      `Since your last turn the user removed study material: ${removed.join(", ")}. It is no longer available, so do not cite or rely on it.`,
    );
  }
  if (updates.length === 0) return "";
  return `[${updates.join(" ")} Acknowledge source changes naturally if relevant, but do all inspection silently and never mention this note or narrate tool use. The user's message follows.]\n\n`;
}

type TurnState = "idle" | "starting" | "streaming" | "interrupting";

// Mirrors cyra-session.ts:23-24 / session.ts — same inactivity and overload posture.
const TURN_INACTIVITY_MS = 5 * 60_000;
const OVERLOAD_RETRY_DELAYS_MS = [1000, 4000];

interface CoachSession {
  notebookId: string;
  clients: Set<SseConnection>;
  seq: number;
  state: TurnState;
  turnId: string | null;
  partials: Map<string, string>;
  finalizedItems: Set<string>;
  threadGeneration: number;
  catchUpNeeded: boolean;
  /** The in-flight turn is the visible kickoff turn. */
  kickoffTurn: boolean;
  /** Completed messages since the latest tool call; only the final response is persisted. */
  responseMessages: { id: string; text: string }[];
  /** Set by interrupt() while a turn is still "starting"; aborts before turn/start. */
  cancelRequested: boolean;
  /** Cancels pre-stream retrieval/setup work when Stop is pressed. */
  startAbort: AbortController | null;
  unsubscribe: (() => void) | null;
  watchdog: NodeJS.Timeout | null;
  forceResetTimer: NodeJS.Timeout | null;
}

/**
 * Sessions for the learning-coach threads: one conversation per notebook,
 * keyed by notebookId. A lean MIRROR of CyraSessionManager (itself a mirror
 * of SessionManager) rather than a refactor — see the rationale at
 * cyra-session.ts:44-52. Coach turns run CONCURRENTLY with Aria and Cyra
 * turns: separate codex threads, separate state machines, same per-notebook
 * store save chain. The only structural additions over Cyra are the singular
 * thread, the visible kickoff turn, and the knowledge-base retrieval block.
 */
export class CoachSessionManager {
  /** Keyed by notebookId — exactly one coach conversation per notebook. */
  private sessions = new Map<string, CoachSession>();

  private getNotebook(id: string): Notebook | undefined {
    const compatible = this.store as NotebookStore & { getSession?: (key: string) => Notebook | undefined };
    return compatible.getSession?.(id) ?? this.store.get(id);
  }

  constructor(
    private client: AppServerClient,
    private store: NotebookStore,
    private settings: SettingsStore,
    private usage: UsageStore,
  ) {
    client.on("crashed", () => this.failAllActiveTurns("The coach's connection dropped."));
    client.on("restarting", () =>
      this.failAllActiveTurns("The Codex CLI restarted during this response. Please retry."),
    );
  }

  private findCoach(notebookId: string): { nb: Notebook; coach: CoachState } {
    const nb = this.getNotebook(notebookId);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    if (!nb.coach) throw new HttpError(404, "coach_not_initialized");
    return { nb, coach: nb.coach };
  }

  // ---------- SSE (mirrors cyra-session.ts:76-96, plus kickoffDone) ----------

  attach(notebookId: string, res: Response): void {
    const { coach } = this.findCoach(notebookId);
    const session = this.ensureSession(notebookId);
    const conn = new SseConnection(res, () => session.clients.delete(conn));
    session.clients.add(conn);
    conn.send(
      "state",
      {
        turnActive: session.state !== "idle",
        turnId: session.turnId,
        // Agent messages are buffered until they are known to be final, so a
        // reconnect must not surface an operational preamble as chat content.
        partials: {},
        messageCount: coach.messages.length,
        kickoffDone: coach.kickoffDone,
      },
      ++session.seq,
    );
  }

  getState(notebookId: string): { turnActive: boolean } {
    const session = this.sessions.get(notebookId);
    return { turnActive: session ? session.state !== "idle" : false };
  }

  // ---------- turns ----------

  /**
   * Start a coach turn. `kickoff: true` = the visible first turn: no user
   * message is persisted and the hidden kickoff prompt is the input; the
   * final buffered reply lands as an ordinary coach message and flips
   * kickoffDone.
   */
  async startTurn(
    notebookId: string,
    opts: { text?: string; retry?: boolean; kickoff?: boolean; sourcesPending?: boolean; clientMessageId?: string },
  ): Promise<{ turnId: string | null }> {
    const nb = this.getNotebook(notebookId);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const coach = ensureCoachState(nb);

    let retryMsg: { id: string; text: string } | null = null;
    let text: string;
    if (opts.kickoff) {
      text = buildCoachKickoffPrompt(nb, { sourcesPending: opts.sourcesPending === true });
    } else if (opts.retry) {
      // Re-answer the last persisted user message without persisting a duplicate.
      retryMsg = [...coach.messages].reverse().find((m) => m.role === "user") ?? null;
      if (!retryMsg) throw new HttpError(400, "nothing_to_retry");
      text = retryMsg.text;
    } else {
      if (!opts.text || !opts.text.trim()) throw new HttpError(400, "empty_message");
      text = opts.text.trim();
    }

    const session = this.ensureSession(notebookId);
    if (session.state !== "idle") throw new HttpError(409, "turn_active", "The coach is already replying.");

    session.state = "starting";
    session.turnId = null;
    session.partials.clear();
    session.finalizedItems.clear();
    session.cancelRequested = false;
    session.startAbort = new AbortController();
    session.kickoffTurn = opts.kickoff === true;
    session.responseMessages = [];

    let userMessageId: string | null = null;
    try {
      await this.ensureCoachThread(nb, coach, session);

      // Snapshot the catch-up BEFORE persisting the new user message (and
      // excluding a retried one) — mirrors cyra-session.ts:166-171.
      let catchUp = "";
      if (session.catchUpNeeded) {
        const history = retryMsg ? coach.messages.filter((m) => m.id !== retryMsg.id) : coach.messages;
        catchUp = buildCoachCatchUpBlock(history);
      }

      if (!opts.kickoff && !opts.retry) {
        // Optimistic persist + SSE echo, rolled back on failure.
        const idTaken = opts.clientMessageId
          ? coach.messages.some((message) => message.id === opts.clientMessageId)
          : false;
        userMessageId = opts.clientMessageId && !idTaken ? opts.clientMessageId : randomUUID();
        coach.messages.push({ id: userMessageId, role: "user", text, turnId: null, createdAt: new Date().toISOString() });
        coach.updatedAt = new Date().toISOString();
        await this.store.save(nb);
        this.broadcast(session, "message", { id: userMessageId, role: "user", text });
      }

      // Hidden preambles: the session-ritual block (only after a >4h silence),
      // new-source notes (the pinned manifest can't change), the usage profile
      // (adaptive scaffold-fading), plus two fail-open retrievals (the coach's
      // knowledge base and the learner's own materials). Skipped for the
      // kickoff turn — a greeting.
      let sessionBlock = "";
      let planBlock = "";
      let notesBlock = "";
      let profileBlock = "";
      let kbBlock = "";
      let sourcesBlock = "";
      const pendingNotes = opts.kickoff ? [] : [...(coach.pendingSourceNotes ?? [])];
      if (!opts.kickoff) {
        // Stateless and idempotent: computed from message timestamps and the
        // log; a retried turn excludes the retried message (like the catch-up),
        // and the second message after a gap sees no gap and injects nothing.
        sessionBlock = buildSessionBlock(nb, { excludeMessageId: retryMsg?.id ?? userMessageId ?? undefined });
        planBlock = renderPlanBlock(nb);
        notesBlock = renderCoachSourceNotesBlock(pendingNotes);
        profileBlock = this.usage.renderProfileBlock();
        const query = buildCoachRagQuery(coach.messages, text);
        [kbBlock, sourcesBlock] = await Promise.all([
          buildKbBlock(query, renderCoachKbBlock, { signal: session.startAbort?.signal }),
          buildRetrievalBlockWith(this.store, this.settings, nb, query, renderCoachSourcesBlock, {
            excludePendingSources: false,
            signal: session.startAbort?.signal,
          }),
        ]);
      }
      if (session.cancelRequested) {
        throw new HttpError(409, "turn_cancelled", "Stopped before the coach replied.");
      }

      const s = this.settings.get();
      const effort = config.coachEffort ?? s.effort;
      const turn = await this.turnStartWithRetry(coach.threadId!, catchUp + sessionBlock + planBlock + notesBlock + profileBlock + kbBlock + sourcesBlock + text, s.model, effort);
      if (pendingNotes.length > 0 && coach.pendingSourceNotes) {
        // Consume exactly what was included; notes landing mid-turn survive.
        coach.pendingSourceNotes = coach.pendingSourceNotes.filter((n) => !pendingNotes.includes(n));
        if (coach.pendingSourceNotes.length === 0) delete coach.pendingSourceNotes;
        await this.store.save(nb);
      }
      session.catchUpNeeded = false;
      session.turnId = turn.id;
      session.state = "streaming";
      session.startAbort = null;
      this.resetWatchdog(session);
      this.broadcast(session, "turn-started", { turnId: turn.id });
      return { turnId: turn.id };
    } catch (err) {
      session.state = "idle";
      session.startAbort = null;
      session.kickoffTurn = false;
      session.responseMessages = [];
      this.clearWatchdog(session);
      const cancelled = err instanceof HttpError && err.code === "turn_cancelled";
      if (userMessageId && !cancelled) {
        const idx = coach.messages.findIndex((m) => m.id === userMessageId);
        if (idx >= 0) coach.messages.splice(idx, 1);
        await this.store.save(nb).catch(() => {});
      } else if (userMessageId && cancelled) {
        // The saved message never reached Codex. Recreate the coach thread on
        // the next send so catch-up includes this valid stopped message.
        coach.threadId = null;
        await this.store.save(nb).catch(() => {});
      }
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : "Failed to start the turn";
      this.broadcast(session, "error", { message, retryable: true });
      throw new HttpError(502, "turn_start_failed", message);
    }
  }

  /**
   * Rewind-and-resend inside the coach conversation (mirrors cyra-session.ts
   * editTurn): the edited user message and everything after it are deleted,
   * and the codex thread is rebuilt from a catch-up of the surviving prefix.
   */
  async editTurn(
    notebookId: string,
    messageId: string,
    text: string | undefined,
    clientMessageId?: string,
  ): Promise<{ turnId: string | null }> {
    const { nb, coach } = this.findCoach(notebookId);
    const session = this.ensureSession(notebookId);
    if (session.state !== "idle") throw new HttpError(409, "turn_active", "The coach is already replying.");
    if (!text || !text.trim()) throw new HttpError(400, "empty_message");
    const idx = coach.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) throw new HttpError(404, "message_not_found");
    if (coach.messages[idx]!.role !== "user") {
      throw new HttpError(400, "not_editable", "Only your own messages can be edited.");
    }

    // Occupy the state machine while truncating — a concurrent send must not
    // land on a half-rewound thread.
    session.state = "starting";
    try {
      coach.messages = coach.messages.slice(0, idx);
      coach.threadId = null; // the coach must not remember the deleted turns
      coach.updatedAt = new Date().toISOString();
      await this.store.save(nb);
    } finally {
      session.state = "idle";
    }

    try {
      return await this.startTurn(notebookId, { text, clientMessageId });
    } finally {
      // Other attached tabs still hold the deleted tail — make them refetch.
      this.broadcastState(session, coach);
    }
  }

  /** The attach() snapshot, pushed mid-session — clients refetch when messageCount drifts. */
  private broadcastState(session: CoachSession, coach: CoachState): void {
    this.broadcast(session, "state", {
      turnActive: session.state !== "idle",
      turnId: session.turnId,
      partials: {},
      messageCount: coach.messages.length,
      kickoffDone: coach.kickoffDone,
    });
  }

  /** Mirrors cyra-session.ts:288-305. */
  async interrupt(notebookId: string): Promise<boolean> {
    const session = this.sessions.get(notebookId);
    const nb = this.getNotebook(notebookId);
    const coach = nb?.coach;
    if (!session || !coach || session.state === "idle") return false;
    if (session.state === "starting") {
      session.cancelRequested = true;
      session.startAbort?.abort();
      return true;
    }
    if (!session.turnId || !coach.threadId) return false;
    session.state = "interrupting";
    try {
      await this.client.turnInterrupt(coach.threadId, session.turnId);
    } catch (err) {
      console.error("[aria] coach turn/interrupt failed:", err);
    }
    return true;
  }

  /** Tear down the coach session of a notebook being deleted. */
  async disposeNotebook(notebookId: string): Promise<void> {
    const session = this.sessions.get(notebookId);
    if (!session) return;
    if (session.state !== "idle") await this.interrupt(notebookId).catch(() => {});
    this.disposeSession(notebookId);
  }

  // ---------- internals ----------

  private disposeSession(notebookId: string): void {
    const session = this.sessions.get(notebookId);
    if (!session) return;
    session.unsubscribe?.();
    this.clearWatchdog(session);
    for (const c of session.clients) c.close();
    this.sessions.delete(notebookId);
  }

  private ensureSession(notebookId: string): CoachSession {
    let s = this.sessions.get(notebookId);
    if (!s) {
      s = {
        notebookId,
        clients: new Set(),
        seq: 0,
        state: "idle",
        turnId: null,
        partials: new Map(),
        finalizedItems: new Set(),
        threadGeneration: -1,
        catchUpNeeded: false,
        kickoffTurn: false,
        responseMessages: [],
        cancelRequested: false,
        startAbort: null,
        unsubscribe: null,
        watchdog: null,
        forceResetTimer: null,
      };
      this.sessions.set(notebookId, s);
    }
    return s;
  }

  /**
   * Mirrors cyra-session.ts ensureCyraThread (356-392), plus the coaching-mode
   * drift check (the appliedStyle pattern from session.ts): instructions are
   * pinned per thread, so a mode change starts a FRESH thread and the next
   * turn carries a transcript catch-up.
   */
  private async ensureCoachThread(nb: Notebook, coach: CoachState, session: CoachSession): Promise<void> {
    const s = this.settings.get();
    const mode = this.usage.get().coachMode;
    const modeDrifted = (coach.appliedMode ?? "guided") !== mode;
    if (coach.threadId && session.threadGeneration === this.client.generation && !modeDrifted) return;

    const threadConfig: Omit<ThreadStartParams, "ephemeral"> = {
      cwd: this.store.sourcesDir(nb.id),
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: buildCoachInstructions(nb, mode),
      personality: "none",
      model: s.model,
    };

    const startFresh = async () => {
      const res = await this.client.threadStart({ ...threadConfig, ephemeral: false });
      coach.threadId = res.thread.id;
      coach.appliedMode = mode;
      await this.store.save(nb);
      if (coach.messages.length > 0) session.catchUpNeeded = true;
    };

    if (!coach.threadId || modeDrifted) {
      await startFresh();
    } else {
      try {
        await this.client.threadResume({ threadId: coach.threadId, ...threadConfig });
      } catch (err) {
        console.error(`[aria] coach thread/resume failed for ${coach.threadId}; starting fresh thread:`, err);
        await startFresh();
      }
    }

    session.unsubscribe?.();
    session.unsubscribe = this.client.subscribeThread(coach.threadId!, (method, params) =>
      this.onThreadNotification(session, method, params),
    );
    session.threadGeneration = this.client.generation;
  }

  /** Mirrors cyra-session.ts:395-414 verbatim. */
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

  /** Mirrors cyra-session.ts:417-468. */
  private onThreadNotification(session: CoachSession, method: string, params: unknown): void {
    if (session.state === "idle") return;
    this.resetWatchdog(session);

    switch (method) {
      case "item/agentMessage/delta": {
        const p = params as AgentMessageDeltaNotification;
        if (session.turnId === null || p.turnId !== session.turnId) return;
        session.partials.set(p.itemId, (session.partials.get(p.itemId) ?? "") + p.delta);
        return;
      }
      case "item/started": {
        const p = params as ItemNotification;
        if (session.turnId === null || p.turnId !== session.turnId) return;
        if (p.item.type === "commandExecution") {
          // Any completed agent message before a tool call is an operational
          // prelude ("I'll inspect…"), not the answer to persist in chat.
          session.responseMessages = [];
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
        session.responseMessages.push({ id: p.item.id, text });
        return;
      }
      case "turn/completed": {
        const p = params as TurnCompletedNotification;
        if (session.turnId === null || p.turn.id !== session.turnId) return;
        void this.onTurnCompleted(session, p).catch((err) => console.error("[aria] coach onTurnCompleted failed:", err));
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

  /** Mirrors cyra-session.ts persistCyraMessage (471-494) with role "coach". */
  private async persistCoachMessage(
    session: CoachSession,
    msg: { id: string; text: string; turnId: string | null; interrupted?: true },
  ): Promise<void> {
    const nb = this.getNotebook(session.notebookId);
    const coach = nb?.coach;
    if (!nb || !coach || !msg.text.trim()) return;
    coach.messages.push({
      id: msg.id,
      role: "coach",
      text: msg.text,
      turnId: msg.turnId,
      ...(msg.interrupted ? { interrupted: true as const } : {}),
      createdAt: new Date().toISOString(),
    });
    coach.updatedAt = new Date().toISOString();
    await this.store.save(nb);
    this.broadcast(session, "message", {
      id: msg.id,
      role: "coach",
      text: msg.text,
      interrupted: msg.interrupted ?? false,
    });
  }

  /**
   * Mirrors cyra-session.ts onTurnCompleted (497-522), plus the kickoff
   * bookkeeping: a completed kickoff turn that produced a reply flips
   * kickoffDone; an empty one stays retryable (the client re-kickoffs).
   */
  private async onTurnCompleted(session: CoachSession, p: TurnCompletedNotification): Promise<void> {
    this.clearWatchdog(session);

    const finalMsg = [...session.responseMessages].reverse().find((message) => message.text.trim());
    let kickoffEmpty = false;
    if (p.turn.status === "completed") {
      if (finalMsg) {
        await this.persistCoachMessage(session, { id: finalMsg.id, text: finalMsg.text, turnId: p.turn.id });
      }
      if (session.kickoffTurn && finalMsg) {
        const nb = this.getNotebook(session.notebookId);
        if (nb?.coach && !nb.coach.kickoffDone) {
          nb.coach.kickoffDone = true;
          await this.store.save(nb);
        }
      } else if (session.kickoffTurn && !finalMsg) {
        kickoffEmpty = true;
      }
    } else if (!session.kickoffTurn) {
      const partial = [...session.partials.entries()]
        .reverse()
        .find(([itemId, text]) => !session.finalizedItems.has(itemId) && text.trim());
      if (partial) {
        await this.persistCoachMessage(session, {
          id: partial[0],
          text: partial[1],
          turnId: p.turn.id,
          interrupted: true,
        });
      } else if (finalMsg) {
        // A completed response remains valid even when the surrounding turn
        // later reports interrupted/failed.
        await this.persistCoachMessage(session, { id: finalMsg.id, text: finalMsg.text, turnId: p.turn.id });
      }
    }

    const error =
      p.turn.status === "failed"
        ? {
            message: p.turn.error?.message ?? "The turn failed.",
            code: typeof p.turn.error?.codexErrorInfo === "string" ? p.turn.error.codexErrorInfo : undefined,
          }
        : kickoffEmpty
          ? { message: "The coach didn't reply.", code: undefined }
          : undefined;
    session.kickoffTurn = false;

    session.state = "idle";
    session.turnId = null;
    session.partials.clear();
    session.finalizedItems.clear();
    session.responseMessages = [];
    if (error) this.broadcast(session, "error", { ...error, retryable: true });
    this.broadcast(session, "turn-completed", {
      turnId: p.turn.id,
      status: kickoffEmpty ? "failed" : p.turn.status,
      error,
    });
  }

  /** Mirrors cyra-session.ts:525-543. */
  private failAllActiveTurns(message: string): void {
    for (const session of this.sessions.values()) {
      if (session.state === "idle") continue;
      session.cancelRequested = true;
      session.startAbort?.abort();
      session.startAbort = null;
      void (async () => {
        if (!session.kickoffTurn) {
          const partial = [...session.partials.entries()]
            .reverse()
            .find(([itemId, text]) => !session.finalizedItems.has(itemId) && text.trim());
          const finalMsg = [...session.responseMessages].reverse().find((message) => message.text.trim());
          if (partial) {
            await this.persistCoachMessage(session, {
              id: partial[0],
              text: partial[1],
              turnId: session.turnId,
              interrupted: true,
            });
          } else if (finalMsg) {
            await this.persistCoachMessage(session, {
              id: finalMsg.id,
              text: finalMsg.text,
              turnId: session.turnId,
            });
          }
        }
        session.state = "idle";
        session.turnId = null;
        session.kickoffTurn = false;
        session.partials.clear();
        session.finalizedItems.clear();
        session.responseMessages = [];
        this.clearWatchdog(session);
        this.broadcast(session, "error", { message, retryable: true });
        this.broadcast(session, "turn-completed", { turnId: null, status: "failed", error: { message } });
      })().catch((err) => console.error("[aria] coach failAllActiveTurns failed:", err));
    }
  }

  /** Mirrors cyra-session.ts resetWatchdog (546-576). */
  private resetWatchdog(session: CoachSession): void {
    this.clearWatchdog(session);
    session.watchdog = setTimeout(() => {
      console.error(`[aria] coach turn watchdog fired for notebook ${session.notebookId}`);
      const nb = this.getNotebook(session.notebookId);
      const coach = nb?.coach;
      const armedTurnId = session.turnId;
      if (coach?.threadId && armedTurnId) {
        void this.client.turnInterrupt(coach.threadId, armedTurnId).catch(() => {});
      }
      session.forceResetTimer = setTimeout(() => {
        session.forceResetTimer = null;
        if (session.state === "idle" || session.turnId !== armedTurnId) return;
        const partials = [...session.partials.entries()];
        const finalized = new Set(session.finalizedItems);
        const responseMessages = [...session.responseMessages];
        const wasKickoff = session.kickoffTurn;
        session.state = "idle";
        session.turnId = null;
        session.kickoffTurn = false;
        session.partials.clear();
        session.finalizedItems.clear();
        session.responseMessages = [];
        void (async () => {
          if (!wasKickoff) {
            const partial = partials.reverse().find(([itemId, text]) => !finalized.has(itemId) && text.trim());
            const finalMsg = responseMessages.reverse().find((message) => message.text.trim());
            if (partial) {
              await this.persistCoachMessage(session, {
                id: partial[0],
                text: partial[1],
                turnId: armedTurnId,
                interrupted: true,
              });
            } else if (finalMsg) {
              await this.persistCoachMessage(session, {
                id: finalMsg.id,
                text: finalMsg.text,
                turnId: armedTurnId,
              });
            }
          }
          this.broadcast(session, "error", { message: "The coach stopped responding.", retryable: true });
          this.broadcast(session, "turn-completed", { turnId: null, status: "failed", error: { message: "timeout" } });
        })().catch((err) => console.error("[aria] coach watchdog force-reset failed:", err));
      }, 15_000);
    }, TURN_INACTIVITY_MS);
  }

  private clearWatchdog(session: CoachSession): void {
    if (session.watchdog) {
      clearTimeout(session.watchdog);
      session.watchdog = null;
    }
    if (session.forceResetTimer) {
      clearTimeout(session.forceResetTimer);
      session.forceResetTimer = null;
    }
  }

  private broadcast(session: CoachSession, event: string, data: unknown): void {
    const id = ++session.seq;
    for (const conn of session.clients) conn.send(event, data, id);
  }
}
