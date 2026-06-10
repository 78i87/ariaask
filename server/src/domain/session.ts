import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { SseConnection } from "../lib/sse.js";
import { HttpError } from "../lib/errors.js";
import { AppServerClient } from "../appserver/client.js";
import { RpcError } from "../appserver/rpc.js";
import type { Config } from "../config.js";
import type { ChatMessage, Notebook, NotebookStore } from "./store.js";
import type { SettingsStore } from "./settings.js";
import { buildCatchUpBlock, buildDeveloperInstructions, buildKickoffPrompt } from "./persona.js";
import type {
  AgentMessageDeltaNotification,
  ErrorNotification,
  ItemNotification,
  ThreadStartParams,
  TurnCompletedNotification,
} from "../appserver/protocol.js";

type TurnState = "idle" | "starting" | "streaming" | "interrupting";

/** A turn that produces no notifications for this long is force-failed. */
const TURN_INACTIVITY_MS = 5 * 60_000;
const OVERLOAD_RETRY_DELAYS_MS = [1000, 4000];

interface NotebookSession {
  notebookId: string;
  clients: Set<SseConnection>;
  seq: number;
  state: TurnState;
  turnId: string | null;
  /** Whether the in-flight turn is the hidden kickoff turn. */
  kickoffTurn: boolean;
  /** Accumulated streamed text per agentMessage itemId. */
  partials: Map<string, string>;
  /** itemIds whose final item/completed arrived (already persisted or buffered). */
  finalizedItems: Set<string>;
  /** Completed agentMessages buffered during a kickoff turn. */
  kickoffMessages: { id: string; text: string }[];
  /** Re-resume the codex thread when this doesn't match client.generation. */
  threadGeneration: number;
  /** When the thread was recreated after a lost rollout, prepend a transcript catch-up. */
  catchUpNeeded: boolean;
  unsubscribe: (() => void) | null;
  watchdog: NodeJS.Timeout | null;
  /** Inner watchdog timer that force-resets a wedged turn; tracked so it can be cancelled. */
  forceResetTimer: NodeJS.Timeout | null;
}

export class SessionManager {
  private sessions = new Map<string, NotebookSession>();

  constructor(
    private client: AppServerClient,
    private store: NotebookStore,
    private settings: SettingsStore,
    private config: Config,
  ) {
    client.on("crashed", () => this.failAllActiveTurns("The student's connection dropped."));
  }

  // ---------- SSE ----------

  attach(notebookId: string, res: Response): void {
    const session = this.ensureSession(notebookId);
    const conn = new SseConnection(res, () => session.clients.delete(conn));
    session.clients.add(conn);
    const nb = this.store.get(notebookId);
    conn.send(
      "state",
      {
        turnActive: session.state !== "idle",
        turnId: session.turnId,
        kickoffRunning: session.state !== "idle" && session.kickoffTurn,
        partials: session.kickoffTurn ? {} : Object.fromEntries(session.partials),
        messageCount: nb?.messages.length ?? 0,
      },
      ++session.seq,
    );
  }

  getState(notebookId: string): { turnActive: boolean } {
    const session = this.sessions.get(notebookId);
    return { turnActive: session ? session.state !== "idle" : false };
  }

  // ---------- turns ----------

  async startTurn(
    notebookId: string,
    text: string | undefined,
    retry = false,
    clientMessageId?: string,
  ): Promise<{ turnId: string | null }> {
    const nb = this.store.get(notebookId);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const session = this.ensureSession(notebookId);
    if (session.state !== "idle") throw new HttpError(409, "turn_active", "The student is already responding.");

    let input: string;
    let kickoff = false;
    let retryTeacher: ChatMessage | null = null;
    if (!nb.kickoffDone) {
      // First turn of the notebook: the hidden kickoff. An accompanying user
      // text should not occur (the UI disables the composer until the opener
      // arrives), so any provided text is ignored.
      kickoff = true;
      input = buildKickoffPrompt(nb);
    } else if (retry) {
      retryTeacher = [...nb.messages].reverse().find((m) => m.role === "teacher") ?? null;
      if (!retryTeacher) throw new HttpError(400, "nothing_to_retry");
      input = retryTeacher.text;
    } else {
      if (!text || !text.trim()) throw new HttpError(400, "empty_message");
      input = text.trim();
    }

    session.state = "starting";
    session.kickoffTurn = kickoff;
    session.turnId = null;
    session.partials.clear();
    session.finalizedItems.clear();
    session.kickoffMessages = [];

    let teacherMessageId: string | null = null;
    try {
      await this.ensureThread(nb, session);

      // Snapshot the catch-up transcript BEFORE persisting the new teacher
      // message (and excluding a retried one), so the live prompt can't also
      // appear inside the transcript block on a recreated thread.
      let catchUp = "";
      if (session.catchUpNeeded) {
        const history = retryTeacher ? nb.messages.filter((m) => m.id !== retryTeacher.id) : nb.messages;
        catchUp = buildCatchUpBlock(history);
      }

      if (!kickoff && !retry) {
        teacherMessageId = clientMessageId ?? randomUUID();
        nb.messages.push({
          id: teacherMessageId,
          role: "teacher",
          text: input,
          turnId: null,
          createdAt: new Date().toISOString(),
        });
        await this.store.save(nb);
        // Keep other attached tabs coherent; the sender dedupes by id.
        this.broadcast(session, "message", { id: teacherMessageId, role: "teacher", text: input, turnId: null });
      }

      const s = this.settings.get();
      const effort = kickoff ? this.kickoffEffort(s.effort) : s.effort;
      const turn = await this.turnStartWithRetry(nb.threadId!, catchUp + input, s.model, effort);
      // Only clear once the turn actually started — a failed turn/start must
      // not cost the fresh thread its transcript catch-up.
      session.catchUpNeeded = false;
      session.turnId = turn.id;
      session.state = "streaming";
      this.resetWatchdog(session);
      this.broadcast(session, "turn-started", { turnId: turn.id, kickoff });
      return { turnId: turn.id };
    } catch (err) {
      session.state = "idle";
      session.kickoffTurn = false;
      this.clearWatchdog(session);
      // Roll back the optimistically-persisted teacher message so a failed
      // turn/start doesn't leave a dangling, unanswered message.
      if (teacherMessageId) {
        const idx = nb.messages.findIndex((m) => m.id === teacherMessageId);
        if (idx >= 0) {
          nb.messages.splice(idx, 1);
          await this.store.save(nb).catch(() => {});
        }
      }
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : "Failed to start the turn";
      this.broadcast(session, "error", { message, retryable: true });
      throw new HttpError(502, "turn_start_failed", message);
    }
  }

  async interrupt(notebookId: string): Promise<boolean> {
    const session = this.sessions.get(notebookId);
    const nb = this.store.get(notebookId);
    if (!session || !nb || session.state === "idle") return false;
    if (!session.turnId || !nb.threadId) return false;
    session.state = "interrupting";
    try {
      await this.client.turnInterrupt(nb.threadId, session.turnId);
    } catch (err) {
      console.error("[aria] turn/interrupt failed:", err);
      // The turn may already be finishing; turn/completed will clean up.
    }
    return true;
  }

  async dispose(notebookId: string): Promise<void> {
    const session = this.sessions.get(notebookId);
    if (!session) return;
    if (session.state !== "idle") await this.interrupt(notebookId);
    session.unsubscribe?.();
    this.clearWatchdog(session);
    for (const c of session.clients) c.close();
    this.sessions.delete(notebookId);
  }

  // ---------- internals ----------

  private ensureSession(notebookId: string): NotebookSession {
    let s = this.sessions.get(notebookId);
    if (!s) {
      s = {
        notebookId,
        clients: new Set(),
        seq: 0,
        state: "idle",
        turnId: null,
        kickoffTurn: false,
        partials: new Map(),
        finalizedItems: new Set(),
        kickoffMessages: [],
        threadGeneration: -1,
        catchUpNeeded: false,
        unsubscribe: null,
        watchdog: null,
        forceResetTimer: null,
      };
      this.sessions.set(notebookId, s);
    }
    return s;
  }

  private static readonly EFFORT_LADDER = ["low", "medium", "high", "xhigh"];

  /**
   * The kickoff turn reads sources and designs misconceptions — never run it
   * below medium, but honor a user who chose high/xhigh.
   */
  private kickoffEffort(chosen: string | null): string {
    if (this.config.kickoffEffortOverride) return this.config.kickoffEffortOverride;
    if (!chosen) return "medium";
    const ladder = SessionManager.EFFORT_LADDER;
    return ladder.indexOf(chosen) > ladder.indexOf("medium") ? chosen : "medium";
  }

  private async ensureThread(nb: Notebook, session: NotebookSession): Promise<void> {
    const s = this.settings.get();
    // developerInstructions are pinned at thread creation — resume does NOT
    // re-apply them (verified behaviorally). A style change therefore requires
    // a fresh thread, rebuilt from the transcript catch-up block.
    const applied = nb.appliedStyle ?? { replyLength: "default", probing: "default" };
    const styleCurrent = applied.replyLength === s.replyLength && applied.probing === s.probing;

    if (nb.threadId && styleCurrent && session.threadGeneration === this.client.generation) return;

    const threadConfig: Omit<ThreadStartParams, "ephemeral"> = {
      cwd: this.store.sourcesDir(nb.id),
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: buildDeveloperInstructions(nb, s),
      personality: "none",
      model: s.model,
    };

    const startFresh = async () => {
      const res = await this.client.threadStart({ ...threadConfig, ephemeral: false });
      nb.threadId = res.thread.id;
      nb.appliedStyle = { replyLength: s.replyLength, probing: s.probing };
      await this.store.save(nb);
      if (nb.messages.length > 0) session.catchUpNeeded = true;
    };

    if (!nb.threadId) {
      await startFresh();
    } else if (!styleCurrent) {
      console.log(`[aria] student style changed — restarting thread for notebook ${nb.id} with transcript catch-up`);
      await startFresh();
    } else {
      try {
        await this.client.threadResume({ threadId: nb.threadId, ...threadConfig });
      } catch (err) {
        console.error(`[aria] thread/resume failed for ${nb.threadId}; starting fresh thread:`, err);
        await startFresh();
      }
    }

    session.unsubscribe?.();
    session.unsubscribe = this.client.subscribeThread(nb.threadId!, (method, params) =>
      this.onThreadNotification(session, method, params),
    );
    session.threadGeneration = this.client.generation;
  }

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
        const overloaded =
          err instanceof RpcError &&
          (err.code === -32001 || /overload/i.test(err.message));
        const delay = OVERLOAD_RETRY_DELAYS_MS[attempt];
        if (!overloaded || delay === undefined) throw err;
        attempt++;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private onThreadNotification(session: NotebookSession, method: string, params: unknown): void {
    if (session.state === "idle") return;
    this.resetWatchdog(session);

    switch (method) {
      case "item/agentMessage/delta": {
        const p = params as AgentMessageDeltaNotification;
        // Reject when turnId is unset (the new turn hasn't started yet) or
        // belongs to a prior turn — guards against late/duplicate events.
        if (session.turnId === null || p.turnId !== session.turnId) return;
        session.partials.set(p.itemId, (session.partials.get(p.itemId) ?? "") + p.delta);
        if (!session.kickoffTurn) {
          this.broadcast(session, "delta", { itemId: p.itemId, delta: p.delta });
        }
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
        if (session.kickoffTurn) {
          session.kickoffMessages.push({ id: p.item.id, text });
        } else {
          void this.persistStudentMessage(session, { id: p.item.id, text, turnId: p.turnId }).catch((err) =>
            console.error("[aria] persistStudentMessage failed:", err),
          );
        }
        return;
      }
      case "turn/completed": {
        const p = params as TurnCompletedNotification;
        if (session.turnId === null || p.turn.id !== session.turnId) return;
        void this.onTurnCompleted(session, p).catch((err) =>
          console.error("[aria] onTurnCompleted failed:", err),
        );
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

  private async persistStudentMessage(
    session: NotebookSession,
    msg: { id: string; text: string; turnId: string | null; interrupted?: true },
  ): Promise<void> {
    const nb = this.store.get(session.notebookId);
    if (!nb || !msg.text.trim()) return;
    const record: ChatMessage = {
      id: msg.id,
      role: "student",
      text: msg.text,
      turnId: msg.turnId,
      createdAt: new Date().toISOString(),
    };
    if (msg.interrupted) record.interrupted = true;
    nb.messages.push(record);
    await this.store.save(nb);
    this.broadcast(session, "message", {
      id: record.id,
      role: "student",
      text: record.text,
      turnId: record.turnId,
      interrupted: record.interrupted ?? false,
    });
  }

  private async onTurnCompleted(session: NotebookSession, p: TurnCompletedNotification): Promise<void> {
    const nb = this.store.get(session.notebookId);
    this.clearWatchdog(session);

    let kickoffEmpty = false;
    if (session.kickoffTurn) {
      // Render only the final agent message — anything earlier is preamble.
      const finalMsg = [...session.kickoffMessages].reverse().find((m) => m.text.trim());
      if (p.turn.status === "completed" && finalMsg && nb) {
        nb.kickoffDone = true;
        await this.persistStudentMessage(session, { id: finalMsg.id, text: finalMsg.text, turnId: p.turn.id });
        await this.store.save(nb);
      } else if (p.turn.status === "completed" && !finalMsg) {
        // Kickoff finished but produced no opener — leave kickoffDone false so a
        // retry re-runs it, and surface a retryable error rather than a blank chat.
        kickoffEmpty = true;
      }
    } else if (p.turn.status === "interrupted" || p.turn.status === "failed") {
      // Persist any partial text that never got its item/completed.
      for (const [itemId, text] of session.partials) {
        if (!session.finalizedItems.has(itemId) && text.trim()) {
          await this.persistStudentMessage(session, { id: itemId, text, turnId: p.turn.id, interrupted: true });
        }
      }
    }

    const error =
      p.turn.status === "failed"
        ? {
            message: p.turn.error?.message ?? "The turn failed.",
            code: typeof p.turn.error?.codexErrorInfo === "string" ? p.turn.error.codexErrorInfo : undefined,
          }
        : kickoffEmpty
          ? { message: "The student didn't manage to introduce themselves. Try again." }
          : undefined;

    session.state = "idle";
    session.kickoffTurn = false;
    session.turnId = null;
    session.partials.clear();
    session.finalizedItems.clear();
    session.kickoffMessages = [];
    const status = kickoffEmpty ? "failed" : p.turn.status;
    if (error) this.broadcast(session, "error", { ...error, retryable: true });
    this.broadcast(session, "turn-completed", { turnId: p.turn.id, status, error });
  }

  private failAllActiveTurns(message: string): void {
    for (const session of this.sessions.values()) {
      if (session.state === "idle") continue;
      void (async () => {
        if (!session.kickoffTurn) {
          for (const [itemId, text] of session.partials) {
            if (!session.finalizedItems.has(itemId) && text.trim()) {
              await this.persistStudentMessage(session, { id: itemId, text, turnId: session.turnId, interrupted: true });
            }
          }
        }
        session.state = "idle";
        session.kickoffTurn = false;
        session.turnId = null;
        session.partials.clear();
        session.finalizedItems.clear();
        session.kickoffMessages = [];
        this.clearWatchdog(session);
        this.broadcast(session, "error", { message, retryable: true });
        this.broadcast(session, "turn-completed", { turnId: null, status: "failed", error: { message } });
      })().catch((err) => console.error("[aria] failAllActiveTurns failed:", err));
    }
  }

  private resetWatchdog(session: NotebookSession): void {
    this.clearWatchdog(session);
    session.watchdog = setTimeout(() => {
      console.error(`[aria] turn watchdog fired for notebook ${session.notebookId}`);
      const nb = this.store.get(session.notebookId);
      // Capture the turn being watched so a force-reset can only ever affect
      // THIS turn — never a subsequent turn that started in the meantime.
      const armedTurnId = session.turnId;
      if (nb?.threadId && armedTurnId) {
        void this.client.turnInterrupt(nb.threadId, armedTurnId).catch(() => {});
      }
      // If interrupt produces no turn/completed within 15s, force-reset — but
      // only if it's still the same turn we armed for.
      session.forceResetTimer = setTimeout(() => {
        session.forceResetTimer = null;
        if (session.state === "idle" || session.turnId !== armedTurnId) return;
        const partials = [...session.partials.entries()];
        const finalized = new Set(session.finalizedItems);
        const wasKickoff = session.kickoffTurn;
        session.state = "idle";
        session.kickoffTurn = false;
        session.turnId = null;
        session.partials.clear();
        session.finalizedItems.clear();
        session.kickoffMessages = [];
        void (async () => {
          // Like every other failure path: streamed-but-unfinalized text is
          // the student's answer so far — keep it.
          if (!wasKickoff) {
            for (const [itemId, text] of partials) {
              if (!finalized.has(itemId) && text.trim()) {
                await this.persistStudentMessage(session, { id: itemId, text, turnId: armedTurnId, interrupted: true });
              }
            }
          }
          this.broadcast(session, "error", { message: "The student stopped responding.", retryable: true });
          this.broadcast(session, "turn-completed", { turnId: null, status: "failed", error: { message: "timeout" } });
        })().catch((err) => console.error("[aria] watchdog force-reset failed:", err));
      }, 15_000);
    }, TURN_INACTIVITY_MS);
  }

  private clearWatchdog(session: NotebookSession): void {
    if (session.watchdog) {
      clearTimeout(session.watchdog);
      session.watchdog = null;
    }
    if (session.forceResetTimer) {
      clearTimeout(session.forceResetTimer);
      session.forceResetTimer = null;
    }
  }

  private broadcast(session: NotebookSession, event: string, data: unknown): void {
    const id = ++session.seq;
    for (const c of session.clients) c.send(event, data, id);
  }
}
