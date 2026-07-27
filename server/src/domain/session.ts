import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Response } from "express";
import { SseConnection } from "../lib/sse.js";
import { HttpError } from "../lib/errors.js";
import { AppServerClient } from "../appserver/client.js";
import { RpcError } from "../appserver/rpc.js";
import type { Config } from "../config.js";
import type { ChatMessage, Notebook, NotebookStore, SourceFile } from "./store.js";
import type { SettingsStore } from "./settings.js";
import {
  buildCatchUpBlock,
  buildDeveloperInstructions,
  buildKickoffPrompt,
  buildNewSourcesNote,
  buildRemovedSourcesNote,
  sourcesManifest,
} from "./persona.js";
import {
  buildInterviewCatchUpBlock,
  buildInterviewerInstructions,
  buildInterviewKickoffPrompt,
  buildInterviewNewSourcesNote,
  buildInterviewRemovedSourcesNote,
  interviewMaterialsManifest,
  renderInterviewerRetrievalBlock,
} from "./interviewer.js";
import {
  buildCoverageEvaluatorPrompt,
  buildCoverageGraphPrompt,
  buildCoverageTranscriptPrompt,
  emptyCoverageState,
  resetCoverageEvidence,
} from "./coverage.js";
import {
  applyEvaluatorOutput,
  buildBeliefBlock,
  buildBootstrapPrompt,
  buildEvaluatorPrompt,
  buildInitialStatePromptSources,
  buildInitialStatePromptTopic,
  parseInitialState,
  type LearningState,
} from "./learning.js";
import {
  applyKnowledgeEvaluatorOutput,
  buildKnowledgeEvaluatorPrompt,
  buildKnowledgeGraphPromptSources,
  buildKnowledgeGraphPromptTopic,
  buildKnowledgeTranscriptPrompt,
  carryForwardKnowledgeEvidence,
  emptyKnowledgeState,
  knowledgeFromConceptState,
  mergeKnowledgeEvidence,
  parseKnowledgeState,
  resetKnowledgeEvidence,
  type KnowledgeState,
} from "./knowledge.js";
import { buildIntakeQuestionsPrompt, buildIntakeTuning, intakeFocus, parseIntakeQuestions } from "./intake.js";
import {
  buildRagQuery,
  buildRetrievalBlock,
  buildRetrievalBlockWith,
  didLastRagBuildFail,
  ensureRagIndex,
  isRagIndexBuilding,
  setRagBuildListener,
} from "./rag.js";
import {
  buildDiscoverPrompt,
  buildInterviewDiscoverPrompt,
  downloadDiscoveredSources,
  parseDiscoveredSources,
  type DiscoverFailure,
} from "./discover.js";
import { isInterview, toSummary } from "./store.js";
import type {
  AgentMessageDeltaNotification,
  ErrorNotification,
  ItemNotification,
  ThreadStartParams,
  TurnCompletedNotification,
} from "../appserver/protocol.js";

type TurnState = "idle" | "starting" | "streaming" | "interrupting";

export type SessionActivity =
  | { kind: "researching"; phase: "searching" | "downloading"; completed?: number; total?: number }
  | { kind: "building-student-profile" }
  | { kind: "building-knowledge-map" }
  | { kind: "preparing-opening-question" }
  | { kind: "evaluating-teaching" }
  | { kind: "reading-sources" }
  | { kind: "writing-response" };

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
  /** Belief-state bootstrap for a pre-feature notebook is tried once per session, not per turn. */
  learningBootstrapAttempted: boolean;
  /** Set by interrupt() while a turn is still "starting" (belief evaluator running); aborts before turn/start. */
  cancelRequested: boolean;
  /**
   * Aborts pre-stream one-shots (evaluators, belief/graph generation) when
   * Stop is pressed before the app-server turn has started.
   */
  startAbort: AbortController | null;
  /** True while the pre-kickoff online source discovery is running. */
  intakeResearch: boolean;
  /** Aborts the in-flight research one-shot when the user presses Stop. */
  researchAbort: AbortController | null;
  /** Last structured activity, replayed in the state snapshot on reconnect. */
  activity: SessionActivity | null;
  unsubscribe: (() => void) | null;
  watchdog: NodeJS.Timeout | null;
  /** Inner watchdog timer that force-resets a wedged turn; tracked so it can be cancelled. */
  forceResetTimer: NodeJS.Timeout | null;
}

export class SessionManager {
  private sessions = new Map<string, NotebookSession>();
  private discoveries = new Map<string, AbortController>();

  constructor(
    private client: AppServerClient,
    private store: NotebookStore,
    private settings: SettingsStore,
    private config: Config,
  ) {
    client.on("crashed", () => this.failAllActiveTurns("The student's connection dropped."));
    client.on("restarting", () => this.failAllActiveTurns("The Codex CLI restarted during this response. Please retry."));
    // Index builds surface as a status line; nobody attached → nobody to tell.
    setRagBuildListener((notebookId) => {
      const session = this.sessions.get(notebookId);
      if (session) this.broadcastState(session);
    });
  }

  // ---------- SSE ----------

  attach(notebookId: string, res: Response): void {
    const session = this.ensureSession(notebookId);
    const conn = new SseConnection(res, () => session.clients.delete(conn));
    session.clients.add(conn);
    const nb = this.store.get(notebookId);
    // Pre-warm the retrieval index (pre-existing notebooks have none) while
    // the user reads and types; fire-and-forget, fails open.
    if (nb) void ensureRagIndex(this.store, this.settings, nb);
    conn.send(
      "state",
      {
        turnActive: session.state !== "idle",
        turnId: session.turnId,
        kickoffRunning: session.state !== "idle" && session.kickoffTurn,
        intakeRunning: session.intakeResearch,
        discoveryRunning: this.discoveries.has(notebookId),
        ragBuilding: isRagIndexBuilding(notebookId),
        ragBuildFailed: didLastRagBuildFail(notebookId),
        activity: session.state !== "idle" || this.discoveries.has(notebookId) ? session.activity : null,
        partials: session.kickoffTurn ? {} : Object.fromEntries(session.partials),
        messageCount: nb?.messages.length ?? 0,
      },
      ++session.seq,
    );
    if (!this.config.learningStateDisabled && nb?.userKnowledgeState) {
      conn.send("knowledge-state", { state: nb.userKnowledgeState }, ++session.seq);
    }
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
    if (session.state !== "idle") {
      throw new HttpError(
        409,
        "turn_active",
        isInterview(nb) ? "The interviewer is already responding." : "The student is already responding.",
      );
    }

    // A kickoff before the setup form is submitted would lock the intake out
    // forever (its answers could no longer apply) — stale clients and direct
    // API calls must go through POST /intake first.
    if (!nb.kickoffDone && nb.intake?.status === "pending") {
      throw new HttpError(409, "intake_pending", "Finish the setup form before starting the session.");
    }

    // Head start for the retrieval block below: build/refresh the index while
    // the evaluator pass runs. Fire-and-forget, fails open.
    void ensureRagIndex(this.store, this.settings, nb);

    let input: string;
    let kickoff = false;
    let retryTeacher: ChatMessage | null = null;
    if (!nb.kickoffDone) {
      // First turn of the notebook: the hidden kickoff, which builds its own
      // prompt. A teacher message can't ride it — accepting text here would
      // silently discard what the user typed. The UI keeps the composer
      // disabled until the opener exists; reject stale clients that don't.
      if (text && text.trim()) {
        throw new HttpError(
          409,
          "kickoff_pending",
          isInterview(nb)
            ? "The interviewer hasn't opened the session yet — retry the kickoff first."
            : "Aria hasn't introduced herself yet — retry the kickoff first.",
        );
      }
      kickoff = true;
      input = isInterview(nb) ? buildInterviewKickoffPrompt(nb) : buildKickoffPrompt(nb);
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
    session.cancelRequested = false;
    session.startAbort = new AbortController();
    const startSignal = session.startAbort.signal;

    let teacherMessageId: string | null = null;
    let stateBeforeEval: LearningState | undefined;
    let knowledgeBeforeEval: KnowledgeState | undefined;
    try {
      if (kickoff && isInterview(nb)) {
        // No belief inventory in interview mode — the interviewer is not a
        // calibrated student. Only the coverage map is generated, so it exists
        // when the opener lands. Fail-open inside rebuildKnowledgeState.
        if (!nb.userKnowledgeState && !this.config.learningStateDisabled) {
          this.setActivity(session, { kind: "building-knowledge-map" });
          await this.rebuildKnowledgeState(nb, session, { forceGraphGeneration: true, signal: startSignal });
        }
      } else if (kickoff && !nb.learningState && !this.config.learningStateDisabled) {
        // The belief inventory must exist before ensureThread pins the
        // persona (the belief contract is part of developerInstructions) and
        // before the kickoff prompt is built from it. Fail-open: without a
        // state the kickoff falls back to self-invented misconceptions.
        this.setActivity(session, { kind: "building-student-profile" });
        await this.generateInitialState(nb, startSignal);
        input = buildKickoffPrompt(nb);
        if (nb.learningState) {
          nb.userKnowledgeState = knowledgeFromConceptState(nb.learningState);
          await this.store.save(nb);
          this.broadcast(session, "knowledge-state", { state: nb.userKnowledgeState });
        } else {
          this.setActivity(session, { kind: "building-knowledge-map" });
          await this.rebuildKnowledgeState(nb, session, { forceGraphGeneration: true, signal: startSignal });
        }
      }
      if (kickoff && nb.learningState && !nb.userKnowledgeState && !this.config.learningStateDisabled) {
        nb.userKnowledgeState = knowledgeFromConceptState(nb.learningState);
        await this.store.save(nb);
        this.broadcast(session, "knowledge-state", { state: nb.userKnowledgeState });
      }

      await this.ensureThread(nb, session);

      // Snapshot the catch-up transcript BEFORE persisting the new teacher
      // message (and excluding a retried one), so the live prompt can't also
      // appear inside the transcript block on a recreated thread.
      let catchUp = "";
      if (session.catchUpNeeded) {
        const history = retryTeacher ? nb.messages.filter((m) => m.id !== retryTeacher.id) : nb.messages;
        catchUp = isInterview(nb) ? buildInterviewCatchUpBlock(history) : buildCatchUpBlock(history);
      }

      // Reading added/removed after the thread was created is delivered as
      // hidden notes (instructions are pinned). Kickoff turns carry a fresh
      // manifest in their own prompt, so they just absorb the pendings.
      // `addedCovered`/`removedCovered` snapshot what THIS turn accounts for —
      // pendings appended while the turn is starting stay queued.
      let sourcesNote = "";
      const addedCovered = new Set<string>();
      const removedCovered = new Set<string>(nb.pendingRemovedSources ?? []);
      if (kickoff) {
        for (const name of nb.pendingNewSources ?? []) addedCovered.add(name);
      } else {
        if (removedCovered.size > 0) {
          sourcesNote += isInterview(nb)
            ? buildInterviewRemovedSourcesNote([...removedCovered])
            : buildRemovedSourcesNote([...removedCovered]);
        }
        if (nb.pendingNewSources && nb.pendingNewSources.length > 0) {
          const pending = new Set(nb.pendingNewSources);
          const newFiles = nb.sourceFiles.filter((f) => pending.has(f.storedName));
          if (newFiles.length > 0) {
            sourcesNote += isInterview(nb) ? buildInterviewNewSourcesNote(newFiles) : buildNewSourcesNote(newFiles);
          }
          // Pending names without a matching source file are stale — drop those too.
          for (const name of pending) {
            if (newFiles.some((f) => f.storedName === name) || !nb.sourceFiles.some((f) => f.storedName === name)) {
              addedCovered.add(name);
            }
          }
        }
      }

      if (!kickoff && !retry) {
        const idTaken = clientMessageId ? nb.messages.some((m) => m.id === clientMessageId) : false;
        teacherMessageId = clientMessageId && !idTaken ? clientMessageId : randomUUID();
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

      // The strict gate: a separate evaluator pass decides whether the
      // teacher's message justifies updating the student's beliefs, BEFORE
      // the student replies — so the reply already reflects (only) the
      // justified changes. Snapshot the pre-evaluation state (the evaluator
      // replaces the object, never mutates it) so a failed turn/start that
      // rolls the teacher message back can withdraw the credit too — the map
      // must not show beliefs earned by a message that no longer exists.
      stateBeforeEval = nb.learningState;
      if (!kickoff && !this.config.learningStateDisabled) {
        if (!nb.userKnowledgeState) {
          await this.rebuildKnowledgeState(nb, session, {
            excludeMessageId: retryTeacher?.id ?? teacherMessageId!,
            forceGraphGeneration: true,
            signal: startSignal,
          });
        }
        knowledgeBeforeEval = nb.userKnowledgeState;
        // Interview notebooks never run the belief evaluator — even its
        // bootstrap path would mint a learningState the mode must not have.
        await Promise.all([
          this.runKnowledgeEvaluator(nb, session, input, retryTeacher?.id ?? teacherMessageId!),
          ...(isInterview(nb) ? [] : [this.runEvaluator(nb, session, input, retryTeacher?.id ?? teacherMessageId!)]),
        ]);
      }
      if (session.cancelRequested) {
        throw new HttpError(
          409,
          "turn_cancelled",
          isInterview(nb) ? "Stopped before the interviewer replied." : "Stopped before the student replied.",
        );
      }

      const s = this.settings.get();
      const effort = kickoff ? this.kickoffEffort(s.effort) : s.effort;
      // The kickoff prompt already carries the belief inventory; every later
      // turn gets it as a prepended block — after the catch-up transcript, so
      // on a recreated thread the inventory overrides anything the transcript
      // replay might suggest the student should know.
      const beliefBlock =
        !kickoff && nb.learningState
          ? buildBeliefBlock(nb.learningState, { includeChanges: true, teacherMessage: input })
          : "";
      // Retrieved-passage grounding (rag.ts): hidden excerpts go after the
      // belief block so the inventory still bounds what the student
      // understands. Never on kickoff — its prompt directs a full agentic
      // read instead. Bounded internally; "" on any failure.
      const ragBlock = !kickoff
        ? isInterview(nb)
          ? // Interviewer framing, and no pending-source exclusion: the
            // interviewer has no "one honest read" fiction to protect (same
            // rationale as Cyra).
            await buildRetrievalBlockWith(
              this.store,
              this.settings,
              nb,
              buildRagQuery(nb.messages, input),
              renderInterviewerRetrievalBlock,
              { excludePendingSources: false },
            )
          : await buildRetrievalBlock(this.store, this.settings, nb, buildRagQuery(nb.messages, input))
        : "";
      if (session.cancelRequested) {
        // Retrieval is the only await between the pre-evaluator cancel check
        // and turn/start — don't let a Stop pressed during it be lost.
        throw new HttpError(
          409,
          "turn_cancelled",
          isInterview(nb) ? "Stopped before the interviewer replied." : "Stopped before the student replied.",
        );
      }
      if (kickoff) this.setActivity(session, { kind: "preparing-opening-question" });
      const turn = await this.turnStartWithRetry(nb.threadId!, catchUp + sourcesNote + beliefBlock + ragBlock + input, s.model, effort);
      // Only clear once the turn actually started — a failed turn/start must
      // not cost the fresh thread its transcript catch-up or the new-reading note.
      session.catchUpNeeded = false;
      // Arm notification handling immediately after turn/start returns. Codex
      // can stream while the bookkeeping saves below are in flight.
      session.turnId = turn.id;
      session.state = "streaming";
      session.startAbort = null;
      this.resetWatchdog(session);
      this.setActivity(session, { kind: "writing-response" });
      this.broadcast(session, "turn-started", { turnId: turn.id, kickoff });
      // Stop may have arrived while the turn/start RPC itself was in flight,
      // when there was no turn id to interrupt yet. Honor it now.
      if (session.cancelRequested) void this.interrupt(nb.id);
      if (nb.learningState && nb.learningState.lastChanges.length > 0) {
        // The realizations were delivered with this turn — don't replay them
        // on the next one. (A failed turn/start keeps them for the retry.)
        nb.learningState.lastChanges = [];
        await this.store.save(nb);
      }
      if (addedCovered.size > 0 || removedCovered.size > 0) {
        // Remove only what this turn covered — pendings appended while the
        // turn was starting stay queued for the next one.
        nb.pendingNewSources = (nb.pendingNewSources ?? []).filter((s) => !addedCovered.has(s));
        nb.pendingRemovedSources = (nb.pendingRemovedSources ?? []).filter((s) => !removedCovered.has(s));
        await this.store.save(nb);
      }
      return { turnId: turn.id };
    } catch (err) {
      session.state = "idle";
      session.kickoffTurn = false;
      session.startAbort = null;
      this.clearWatchdog(session);
      // Roll back the optimistically-persisted teacher message so a failed
      // turn/start doesn't leave a dangling, unanswered message — and restore
      // the pre-evaluation beliefs alongside it (skipped when the evaluator
      // BOOTSTRAPPED a previously-stateless notebook: that state derives from
      // the transcript, and the once-per-session flag would block a redo).
      const cancelled = err instanceof HttpError && err.code === "turn_cancelled";
      if (teacherMessageId && !cancelled) {
        const idx = nb.messages.findIndex((m) => m.id === teacherMessageId);
        if (idx >= 0) {
          nb.messages.splice(idx, 1);
          if (stateBeforeEval && nb.learningState !== stateBeforeEval) {
            nb.learningState = stateBeforeEval;
          }
          if (knowledgeBeforeEval && nb.userKnowledgeState !== knowledgeBeforeEval) {
            nb.userKnowledgeState = knowledgeBeforeEval;
            this.broadcast(session, "knowledge-state", { state: knowledgeBeforeEval });
          }
          await this.store.save(nb).catch(() => {});
          this.broadcastState(session);
        }
      }
      if (cancelled && teacherMessageId) {
        // Stop keeps the visible teacher/candidate message, but a pre-stream
        // cancellation means Codex never received it. Abandon the stale
        // persistent thread so the next send recreates it and catches up from
        // the saved transcript exactly once.
        nb.threadId = null;
        await this.store.save(nb).catch(() => {});
      }
      if (cancelled) {
        this.broadcast(session, "turn-completed", { turnId: null, status: "interrupted" });
      }
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : "Failed to start the turn";
      this.broadcast(session, "error", { message, retryable: true });
      throw new HttpError(502, "turn_start_failed", message);
    }
  }

  /**
   * Rewind-and-resend: replace a past teacher message with new text. The
   * edited message and EVERYTHING after it are deleted, the codex thread is
   * abandoned (a fresh one rebuilds from a catch-up of the surviving prefix),
   * and the belief inventory is re-derived from that prefix — the old one
   * reflects turns that no longer exist. Destructive by design: if the resend
   * fails, the transcript stays truncated (consistent) and the user retries.
   */
  async editTurn(
    notebookId: string,
    messageId: string,
    text: string | undefined,
    clientMessageId?: string,
  ): Promise<{ turnId: string | null }> {
    const nb = this.store.get(notebookId);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    const session = this.ensureSession(notebookId);
    if (session.state !== "idle") {
      throw new HttpError(
        409,
        "turn_active",
        isInterview(nb) ? "The interviewer is already responding." : "The student is already responding.",
      );
    }
    if (!text || !text.trim()) throw new HttpError(400, "empty_message");
    const idx = nb.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) throw new HttpError(404, "message_not_found");
    if (nb.messages[idx]!.role !== "teacher") {
      throw new HttpError(400, "not_editable", "Only your own messages can be edited.");
    }

    // Occupy the turn state machine while rewinding — a concurrent /messages
    // POST must not start a turn against a half-truncated transcript.
    session.state = "starting";
    session.cancelRequested = false;
    session.startAbort = new AbortController();
    const editSignal = session.startAbort.signal;
    try {
      nb.messages = nb.messages.slice(0, idx);
      // Abandon the thread: the student must not remember the deleted turns.
      // ensureThread starts fresh and prepends the surviving transcript.
      nb.threadId = null;

      if (nb.learningState && !this.config.learningStateDisabled) {
        // Stale realizations from deleted turns must never replay.
        nb.learningState.lastChanges = [];
        if (nb.messages.length > 0) {
          try {
            const s = this.settings.get();
            this.setActivity(session, { kind: "evaluating-teaching" });
            const raw = await this.client.runOneShotTurn({
              prompt: buildBootstrapPrompt(nb.messages, this.learningContext(nb)),
              model: s.model,
              // Medium, unlike runEvaluator's bootstrap: the re-derived state
              // REPLACES the inventory wholesale after a deliberate edit, so
              // quality beats the extra seconds here.
              effort: "medium",
              timeoutMs: 120_000,
              signal: editSignal,
            });
            const state = parseInitialState(raw);
            if (state) {
              nb.learningState = state;
            }
          } catch (err) {
            // Fail-open: the old inventory may credit deleted turns, but a
            // wrong-ish state beats no state; the evaluator corrects over time.
            console.error(`[aria] belief re-derivation after edit failed for notebook ${nb.id}; keeping prior state:`, err);
          }
        }
      }
      if (!this.config.learningStateDisabled) {
        await this.rebuildKnowledgeState(nb, session, {
          forceGraphGeneration: true,
          carryForwardOnTruncation: false,
          signal: editSignal,
        });
      }
      await this.store.save(nb);
      if (session.cancelRequested) {
        throw new HttpError(
          409,
          "turn_cancelled",
          isInterview(nb) ? "Stopped before the interviewer replied." : "Stopped before the student replied.",
        );
      }
    } finally {
      // startTurn re-checks idle synchronously right after this — no interleave.
      session.state = "idle";
      session.startAbort = null;
    }

    try {
      return await this.startTurn(notebookId, text, false, clientMessageId);
    } finally {
      // Other attached tabs still hold the deleted tail; a state snapshot
      // with the new messageCount makes them refetch the transcript.
      this.broadcastState(session);
    }
  }

  async startDiscovery(notebookId: string, query: string | null): Promise<{ accepted: true }> {
    const nb = this.store.get(notebookId);
    if (!nb) throw new HttpError(404, "notebook_not_found");
    if (!nb.kickoffDone && nb.intake?.status === "pending") {
      throw new HttpError(409, "intake_pending", "Finish the setup form before finding sources.");
    }
    const session = this.ensureSession(notebookId);
    if (this.discoveries.has(notebookId) || session.intakeResearch) {
      throw new HttpError(
        409,
        "discover_active",
        `${isInterview(nb) ? "Cyra" : "Aria"} is already looking for sources.`,
      );
    }

    const controller = new AbortController();
    this.discoveries.set(notebookId, controller);
    void this.runDiscoveryBackground(notebookId, query, session, controller).catch((err) => {
      console.error(`[aria] source discovery background failed for notebook ${notebookId}:`, err);
    });
    return { accepted: true };
  }

  private async runDiscoveryBackground(
    notebookId: string,
    query: string | null,
    session: NotebookSession,
    controller: AbortController,
  ): Promise<void> {
    const initial = this.store.get(notebookId);
    const addedNames: string[] = [];
    let added: SourceFile[] = [];
    let failures: DiscoverFailure[] = [];

    this.setActivity(session, { kind: "researching", phase: "searching" });
    this.broadcastState(session);
    try {
      if (!initial) return;
      const s = this.settings.get();
      const knownUrls = initial.sourceFiles
        .map((f) => f.originUrl)
        .filter((u): u is string => typeof u === "string" && u.length > 0);
      const raw = await this.client.runOneShotTurn({
        prompt: isInterview(initial)
          ? buildInterviewDiscoverPrompt({
              role: initial.interview?.role ?? initial.title,
              company: initial.interview?.company ?? null,
              note: null,
              query,
              manifest: initial.sourceFiles.length > 0 ? interviewMaterialsManifest(initial.sourceFiles) : null,
              knownUrls,
              max: this.config.discoverMax,
            })
          : buildDiscoverPrompt({
              topic: initial.topic ?? initial.title,
              focus: initial.intake?.answers ? intakeFocus(initial.intake.answers) : null,
              note: null,
              query,
              manifest: initial.sourceFiles.length > 0 ? sourcesManifest(initial.sourceFiles) : null,
              knownUrls,
              max: this.config.discoverMax,
            }),
        model: s.model,
        effort: this.config.researchEffort,
        timeoutMs: 120_000,
        config: { web_search: "live" },
        cwd: initial.sourceFiles.length > 0 ? this.store.sourcesDir(initial.id) : undefined,
        signal: controller.signal,
      });
      const discovered = parseDiscoveredSources(raw, this.config.discoverMax);
      if (!discovered || discovered.length === 0) {
        failures = [{ url: query ?? initial.topic ?? initial.title, reason: "the web search found no usable pages" }];
      } else {
        this.setActivity(session, { kind: "researching", phase: "downloading", completed: 0, total: discovered.length });
        const result = await downloadDiscoveredSources(this.store, notebookId, discovered, {
          signal: controller.signal,
          onSource: (fresh, file) => {
            fresh.pendingNewSources = [...(fresh.pendingNewSources ?? []), file.storedName];
            if (fresh.coach?.kickoffDone) {
              fresh.coach.pendingSourceNotes = [...(fresh.coach.pendingSourceNotes ?? []), file.originalName].slice(-10);
            }
            addedNames.push(file.storedName);
            this.broadcast(session, "sources-updated", { notebook: toSummary(fresh) });
          },
          onProgress: (completed, total) =>
            this.setActivity(session, { kind: "researching", phase: "downloading", completed, total }),
        });
        added = result.added;
        failures = result.failures;
      }

      const fresh = this.store.get(notebookId);
      if (fresh && added.length > 0) {
        // The downloader saves per source. This final save is a cheap
        // persistence point for pendingNewSources mutations made above.
        const pending = new Set(fresh.pendingNewSources ?? []);
        for (const name of addedNames) pending.add(name);
        fresh.pendingNewSources = [...pending];
        await this.store.save(fresh);
        void ensureRagIndex(this.store, this.settings, fresh, { retryNow: true });
        void this.rebuildKnowledgeState(fresh, session, { forceGraphGeneration: true }).catch((err) =>
          console.error(`[aria] user knowledge rebuild after discovery failed for notebook ${notebookId}:`, err),
        );
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(`[aria] source discovery failed for notebook ${notebookId}:`, err);
        failures = [
          {
            url: query ?? initial?.topic ?? initial?.title ?? "online search",
            reason: err instanceof Error ? err.message : "Discovery failed.",
          },
        ];
      }
    } finally {
      this.discoveries.delete(notebookId);
      const fresh = this.store.get(notebookId);
      if (fresh) {
        this.broadcast(session, "discover-completed", { notebook: toSummary(fresh), added, failures });
      }
      this.broadcastState(session);
    }
  }

  async interrupt(notebookId: string): Promise<boolean> {
    const session = this.sessions.get(notebookId);
    const nb = this.store.get(notebookId);
    if (!session || !nb || session.state === "idle") return false;
    if (session.state === "starting") {
      // The student turn hasn't reached Codex yet (the belief evaluator or
      // pre-kickoff research may be running) — flag it so the pipeline aborts
      // before turn/start, and cut the research one-shot short server-side.
      session.cancelRequested = true;
      session.researchAbort?.abort();
      session.startAbort?.abort();
      return true;
    }
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
    this.discoveries.get(notebookId)?.abort();
    this.discoveries.delete(notebookId);
    const session = this.sessions.get(notebookId);
    if (!session) return;
    if (session.state !== "idle") await this.interrupt(notebookId);
    session.unsubscribe?.();
    this.clearWatchdog(session);
    for (const c of session.clients) c.close();
    this.sessions.delete(notebookId);
  }

  // ---------- internals ----------

  /** The attach() snapshot, pushed mid-session — clients refetch when messageCount drifts. */
  private broadcastState(session: NotebookSession): void {
    const nb = this.store.get(session.notebookId);
    this.broadcast(session, "state", {
      turnActive: session.state !== "idle",
      turnId: session.turnId,
      kickoffRunning: session.state !== "idle" && session.kickoffTurn,
      intakeRunning: session.intakeResearch,
      discoveryRunning: this.discoveries.has(session.notebookId),
      ragBuilding: isRagIndexBuilding(session.notebookId),
      ragBuildFailed: didLastRagBuildFail(session.notebookId),
      activity: session.state !== "idle" || this.discoveries.has(session.notebookId) ? session.activity : null,
      partials: session.kickoffTurn ? {} : Object.fromEntries(session.partials),
      messageCount: nb?.messages.length ?? 0,
    });
  }

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
        learningBootstrapAttempted: false,
        cancelRequested: false,
        startAbort: null,
        intakeResearch: false,
        researchAbort: null,
        activity: null,
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
   * The kickoff turn reads sources and composes the opener from its assigned
   * beliefs (or, in the fallback, designs misconceptions itself) — never run
   * it below medium, but honor a user who chose high/xhigh.
   */
  private kickoffEffort(chosen: string | null): string {
    if (this.config.kickoffEffortOverride) return this.config.kickoffEffortOverride;
    if (!chosen) return "medium";
    const ladder = SessionManager.EFFORT_LADDER;
    return ladder.indexOf(chosen) > ladder.indexOf("medium") ? chosen : "medium";
  }

  // ---------- intake (setup form + pre-kickoff research) ----------

  private intakeGenerations = new Map<string, Promise<void>>();

  /**
   * Generate the model-authored setup questions, at most once per notebook.
   * Memoized so concurrent GETs share one in-flight generation. Fail-open:
   * any failure persists [] (deterministic-only form, never retried).
   */
  ensureIntakeQuestions(nb: Notebook): Promise<void> {
    if (!nb.intake || nb.intake.status !== "pending" || nb.intake.generatedQuestions !== null) {
      return Promise.resolve();
    }
    const existing = this.intakeGenerations.get(nb.id);
    if (existing) return existing;

    const run = (async () => {
      let questions: ReturnType<typeof parseIntakeQuestions> = [];
      try {
        const s = this.settings.get();
        const topic = nb.type === "topic" ? (nb.topic ?? nb.title) : nb.title;
        const manifest = nb.sourceFiles.length > 0 ? sourcesManifest(nb.sourceFiles) : null;
        const raw = await this.client.runOneShotTurn({
          prompt: buildIntakeQuestionsPrompt(topic, manifest, await this.readSourceHeads(nb)),
          model: s.model,
          effort: this.config.evaluatorEffort,
          timeoutMs: 30_000,
        });
        questions = parseIntakeQuestions(raw) ?? [];
      } catch (err) {
        console.error(`[aria] intake question generation failed for notebook ${nb.id}; deterministic-only form:`, err);
        questions = [];
      }
      const fresh = this.store.get(nb.id);
      // A late resolution must never change a form the user may already be
      // reading (GET persists [] after its cap) or has already submitted.
      if (fresh?.intake && fresh.intake.status === "pending" && fresh.intake.generatedQuestions === null) {
        fresh.intake.generatedQuestions = questions ?? [];
        await this.store.save(fresh);
      }
    })().finally(() => this.intakeGenerations.delete(nb.id));

    this.intakeGenerations.set(nb.id, run);
    return run;
  }

  /**
   * Runs after the setup form is submitted: optional online source discovery,
   * then the kickoff. The synchronous prefix occupies the turn state machine,
   * so callers must invoke this BEFORE responding.
   */
  async runIntakePipeline(notebookId: string): Promise<void> {
    const nb = this.store.get(notebookId);
    const session = this.ensureSession(notebookId);
    if (!nb || !nb.intake || session.state !== "idle") return;

    if (nb.intake.answers?.research) {
      session.state = "starting";
      session.intakeResearch = true;
      session.cancelRequested = false;
      session.researchAbort = new AbortController();
      this.setActivity(session, { kind: "researching", phase: "searching" });
      try {
        await this.runResearch(nb, session);
      } finally {
        session.intakeResearch = false;
        session.researchAbort = null;
        session.state = "idle";
      }
      if (session.cancelRequested) {
        session.cancelRequested = false;
        this.broadcast(session, "turn-completed", { turnId: null, status: "interrupted" });
        return; // already-downloaded sources are kept; reopening auto-kickoffs since intake is done
      }
    }
    try {
      await this.startTurn(notebookId, undefined);
    } catch (err) {
      if (!(err instanceof HttpError && err.code === "turn_active")) {
        console.error(`[aria] intake kickoff failed for notebook ${notebookId}:`, err);
      }
    }
  }

  /** Fail-open: any failure marks intake.research "failed" and the session proceeds without discovered sources. */
  private async runResearch(nb: Notebook, session: NotebookSession): Promise<void> {
    const s = this.settings.get();
    const answers = nb.intake!.answers!;
    try {
      const raw = await this.client.runOneShotTurn({
        prompt: isInterview(nb)
          ? buildInterviewDiscoverPrompt({
              role: nb.interview?.role ?? nb.title,
              company: nb.interview?.company ?? null,
              note: answers.researchNote,
              query: null,
              manifest: nb.sourceFiles.length > 0 ? interviewMaterialsManifest(nb.sourceFiles) : null,
              knownUrls: [],
              max: this.config.discoverMax,
            })
          : buildDiscoverPrompt({
              topic: nb.topic ?? nb.title,
              focus: intakeFocus(answers),
              note: answers.researchNote,
              query: null,
              manifest: nb.sourceFiles.length > 0 ? sourcesManifest(nb.sourceFiles) : null,
              knownUrls: [],
              max: this.config.discoverMax,
            }),
        model: s.model,
        effort: this.config.researchEffort,
        timeoutMs: 120_000,
        config: { web_search: "live" },
        cwd: nb.sourceFiles.length > 0 ? this.store.sourcesDir(nb.id) : undefined,
        signal: session.researchAbort?.signal,
      });
      const discovered = parseDiscoveredSources(raw, this.config.discoverMax);
      if (!discovered || discovered.length === 0) throw new Error("no usable discovered URLs");
      this.setActivity(session, { kind: "researching", phase: "downloading", completed: 0, total: discovered.length });
      const result = await downloadDiscoveredSources(this.store, nb.id, discovered, {
        signal: session.researchAbort?.signal,
        onSource: (fresh) => this.broadcast(session, "sources-updated", { notebook: toSummary(fresh) }),
        onProgress: (completed, total) =>
          this.setActivity(session, { kind: "researching", phase: "downloading", completed, total }),
      });
      if (result.added.length === 0) throw new Error("no discovered sources could be downloaded");
      const fresh = this.store.get(nb.id);
      if (!fresh) return; // notebook deleted mid-research
      fresh.intake!.research = "done";
      await this.store.save(fresh);
      // Index the discovered sources while the kickoff turn runs (kickoff never retrieves).
      void ensureRagIndex(this.store, this.settings, fresh);
    } catch (err) {
      const aborted = session.researchAbort?.signal.aborted === true;
      if (!aborted) console.error(`[aria] online source discovery failed for notebook ${nb.id}; proceeding without it:`, err);
      const fresh = this.store.get(nb.id);
      if (fresh?.intake) {
        fresh.intake.research = "failed";
        await this.store.save(fresh);
      }
      // A deliberate Stop needs no apology toast.
      if (!aborted) {
        this.broadcast(session, "notice", {
          message: isInterview(nb)
            ? "Cyra couldn't finish the background research — starting without it."
            : "Aria couldn't finish her online reading — starting without it.",
        });
      }
    }
  }

  /**
   * The opening lines of each readable source, for prompts that must know what
   * the corpus is actually about without spending a tool-using read (file
   * names and titles alone invite wrong guesses — "CRE" could be catalysis or
   * religious education). Fail-open: unreadable files are skipped; null when
   * nothing is readable.
   */
  private async readSourceHeads(nb: Notebook, perFileChars = 600, maxFiles = 8): Promise<string | null> {
    const parts: string[] = [];
    for (const f of nb.sourceFiles.slice(0, maxFiles)) {
      const name = f.extractedName ?? (f.storedName.endsWith(".pdf") ? null : f.storedName);
      if (!name) continue;
      try {
        const fh = await fs.open(path.join(this.store.sourcesDir(nb.id), name), "r");
        try {
          const buf = Buffer.alloc(perFileChars);
          const { bytesRead } = await fh.read(buf, 0, perFileChars, 0);
          // A multibyte char cut at the boundary decodes to U+FFFD — drop it.
          const text = buf.subarray(0, bytesRead).toString("utf8").replace(/�/g, "").trim();
          if (text) parts.push(`— ${f.originalName}:\n${text}`);
        } finally {
          await fh.close();
        }
      } catch {
        // unreadable file — the prompt just gets fewer excerpts
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  /** One-line description of what the session is about, for the state-manager prompts. */
  private learningContext(nb: Notebook): string {
    const parts: string[] = [];
    if (nb.type === "topic" || nb.topic) parts.push(`The subject being taught: ${nb.topic ?? nb.title}.`);
    if (nb.sourceFiles.length > 0) parts.push(`The session has assigned reading:\n${sourcesManifest(nb.sourceFiles)}`);
    return parts.join("\n\n") || `The subject being taught: ${nb.title}.`;
  }

  private knowledgeBuilds = new Map<string, Promise<unknown>>();

  ensureKnowledgeState(notebookId: string): KnowledgeState | null {
    if (this.config.learningStateDisabled) return null;
    const nb = this.store.get(notebookId);
    if (!nb) return null;
    if (nb.userKnowledgeState) return nb.userKnowledgeState;
    if (this.client.state !== "running") return null;
    if (!this.knowledgeBuilds.has(notebookId)) {
      const run = this.rebuildKnowledgeState(nb, this.ensureSession(notebookId), { forceGraphGeneration: true })
        .catch((err) => {
          console.error(`[aria] background knowledge build failed for notebook ${notebookId}:`, err);
        })
        .finally(() => this.knowledgeBuilds.delete(notebookId));
      this.knowledgeBuilds.set(notebookId, run);
    }
    return null;
  }

  async rebuildKnowledgeStateForNotebook(notebookId: string): Promise<KnowledgeState | null> {
    if (this.config.learningStateDisabled) return null;
    const nb = this.store.get(notebookId);
    if (!nb) return null;
    return this.rebuildKnowledgeState(nb, this.sessions.get(notebookId), { forceGraphGeneration: true });
  }

  private async buildKnowledgeGraph(nb: Notebook, forceGeneration = false, signal?: AbortSignal): Promise<KnowledgeState> {
    if (isInterview(nb)) {
      // Interview coverage map: competencies from role + CV/JD/research.
      const raw = await this.client.runOneShotTurn({
        prompt: buildCoverageGraphPrompt({
          role: nb.interview?.role ?? nb.title,
          company: nb.interview?.company ?? null,
          manifest: nb.sourceFiles.length > 0 ? interviewMaterialsManifest(nb.sourceFiles) : null,
          format: nb.intake?.answers?.interviewFormat ?? null,
          round: nb.intake?.answers?.interviewRound ?? null,
        }),
        model: this.settings.get().model,
        effort: "medium",
        ...(nb.sourceFiles.length > 0 ? { cwd: this.store.sourcesDir(nb.id) } : {}),
        timeoutMs: 120_000,
        signal,
      });
      const parsed = parseKnowledgeState(raw);
      if (!parsed) throw new Error("coverage graph generation produced unusable state");
      return resetCoverageEvidence(parsed);
    }
    if (!forceGeneration && nb.learningState) return knowledgeFromConceptState(nb.learningState);

    const s = this.settings.get();
    const raw =
      nb.sourceFiles.length > 0
        ? await this.client.runOneShotTurn({
            prompt: buildKnowledgeGraphPromptSources(
              sourcesManifest(nb.sourceFiles),
              nb.type === "topic" ? (nb.topic ?? nb.title) : null,
            ),
            model: s.model,
            effort: "medium",
            cwd: this.store.sourcesDir(nb.id),
            timeoutMs: 120_000,
            signal,
          })
        : await this.client.runOneShotTurn({
            prompt: buildKnowledgeGraphPromptTopic(nb.topic ?? nb.title),
            model: s.model,
            effort: "medium",
            timeoutMs: 120_000,
            signal,
          });
    const parsed = parseKnowledgeState(raw);
    if (!parsed) throw new Error("knowledge graph generation produced unusable state");
    return resetKnowledgeEvidence(parsed);
  }

  private async rebuildKnowledgeState(
    nb: Notebook,
    session?: NotebookSession,
    opts: {
      excludeMessageId?: string;
      forceGraphGeneration?: boolean;
      carryForwardOnTruncation?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<KnowledgeState> {
    let base: KnowledgeState;
    try {
      base = await this.buildKnowledgeGraph(nb, opts.forceGraphGeneration, opts.signal);
    } catch (err) {
      console.error(`[aria] user knowledge graph generation failed for notebook ${nb.id}; falling back:`, err);
      base = isInterview(nb)
        ? nb.userKnowledgeState
          ? resetCoverageEvidence(nb.userKnowledgeState)
          : emptyCoverageState(nb.interview?.role ?? nb.title)
        : nb.learningState
          ? knowledgeFromConceptState(nb.learningState)
          : nb.userKnowledgeState
            ? resetKnowledgeEvidence(nb.userKnowledgeState)
            : emptyKnowledgeState(nb.topic ?? nb.title);
    }

    const messages = nb.messages.filter((m) => m.id !== opts.excludeMessageId);
    const lastTeacherId = [...messages].reverse().find((m) => m.role === "teacher")?.id ?? null;
    let state = base;
    if (messages.some((m) => m.role === "teacher")) {
      const { prompt, truncated } = isInterview(nb)
        ? buildCoverageTranscriptPrompt(base, messages)
        : buildKnowledgeTranscriptPrompt(base, messages);
      let evaluated: KnowledgeState | null = null;
      try {
        const s = this.settings.get();
        const raw = await this.client.runOneShotTurn({
          prompt,
          model: s.model,
          effort: this.config.evaluatorEffort,
          timeoutMs: 120_000,
          signal: opts.signal,
        });
        evaluated = parseKnowledgeState(raw);
        if (!evaluated) console.error(`[aria] user knowledge transcript rebuild for notebook ${nb.id} was unusable`);
      } catch (err) {
        console.error(`[aria] user knowledge transcript rebuild failed for notebook ${nb.id}:`, err);
      }
      if (evaluated) {
        state = mergeKnowledgeEvidence(base, evaluated);
        if (truncated && opts.carryForwardOnTruncation !== false && nb.userKnowledgeState) {
          state = carryForwardKnowledgeEvidence(nb.userKnowledgeState, state);
        }
        state.lastEvaluatedMessageId = lastTeacherId;
      } else if (nb.userKnowledgeState) {
        return nb.userKnowledgeState;
      }
    }

    nb.userKnowledgeState = state;
    await this.store.save(nb);
    if (session) this.broadcast(session, "knowledge-state", { state });
    return state;
  }

  /**
   * Generate the kickoff belief inventory via a one-shot side call. Fail-open:
   * on any failure the notebook stays stateless and the whole learning-state
   * layer is skipped, reproducing pre-feature behavior exactly.
   */
  private async generateInitialState(nb: Notebook, signal?: AbortSignal): Promise<void> {
    const s = this.settings.get();
    const tuning = nb.intake?.answers ? buildIntakeTuning(nb.intake.answers) : "";
    try {
      const raw =
        nb.sourceFiles.length > 0
          ? await this.client.runOneShotTurn({
              prompt: buildInitialStatePromptSources(
                sourcesManifest(nb.sourceFiles),
                nb.type === "topic" ? (nb.topic ?? nb.title) : null,
                tuning,
              ),
              model: s.model,
              // It has to actually read the sources — low effort skimps on that.
              effort: "medium",
              cwd: this.store.sourcesDir(nb.id),
              timeoutMs: 120_000,
              signal,
            })
          : await this.client.runOneShotTurn({
              prompt: buildInitialStatePromptTopic(nb.topic ?? nb.title, tuning),
              model: s.model,
              // Staking out 10–25 structured entries at low effort yields thin
              // misconceptions — this one-time call earns medium.
              effort: "medium",
              timeoutMs: 120_000,
              signal,
            });
      const state = parseInitialState(raw);
      if (!state) {
        console.error(`[aria] initial belief state for notebook ${nb.id} was unusable; falling back to stateless kickoff`);
        return;
      }
      nb.learningState = state;
      await this.store.save(nb);
    } catch (err) {
      console.error(`[aria] initial belief state generation failed for notebook ${nb.id}; falling back:`, err);
    }
  }

  private async runKnowledgeEvaluator(
    nb: Notebook,
    session: NotebookSession,
    teacherText: string,
    teacherMessageId: string,
  ): Promise<void> {
    try {
      if (!nb.userKnowledgeState) return;
      const state = nb.userKnowledgeState;
      if (state.lastEvaluatedMessageId === teacherMessageId) return;
      const s = this.settings.get();
      this.setActivity(session, { kind: "evaluating-teaching" });
      const context = nb.messages.filter((m) => m.id !== teacherMessageId).slice(-6);
      const raw = await this.client.runOneShotTurn({
        prompt: isInterview(nb)
          ? buildCoverageEvaluatorPrompt(state, teacherText, context)
          : buildKnowledgeEvaluatorPrompt(state, teacherText, context),
        model: s.model,
        effort: this.config.evaluatorEffort,
        timeoutMs: 60_000,
        signal: session.startAbort?.signal,
      });
      const next = applyKnowledgeEvaluatorOutput(raw, state, teacherText);
      if (!next) {
        state.lastChanges = [];
        console.error(`[aria] user knowledge evaluator output for notebook ${nb.id} was unparseable; map unchanged`);
        return;
      }
      next.lastEvaluatedMessageId = teacherMessageId;
      nb.userKnowledgeState = next;
      await this.store.save(nb);
      this.broadcast(session, "knowledge-state", { state: next });
    } catch (err) {
      if (nb.userKnowledgeState) nb.userKnowledgeState.lastChanges = [];
      console.error(`[aria] user knowledge evaluator failed for notebook ${nb.id}; map unchanged:`, err);
    }
  }

  /**
   * The gatekeeper between the teacher's message and the student's beliefs:
   * a strict one-shot evaluator decides which belief changes the message
   * justifies — and usually that is none. Never throws; any failure leaves
   * the beliefs unchanged and the turn proceeds.
   */
  private async runEvaluator(
    nb: Notebook,
    session: NotebookSession,
    teacherText: string,
    teacherMessageId: string,
  ): Promise<void> {
    try {
      const s = this.settings.get();
      if (!nb.learningState) {
        // Pre-feature notebook: reconstruct an inventory from the transcript,
        // at most once per session so a persistent failure doesn't tax every turn.
        if (session.learningBootstrapAttempted || nb.messages.length === 0) return;
        session.learningBootstrapAttempted = true;
        this.setActivity(session, { kind: "evaluating-teaching" });
        // Stays at evaluator effort (default low), unlike the kickoff/edit
        // generations: this runs inside a normal teaching turn the user is
        // waiting on, and a thinner legacy map grows via the evaluator anyway.
        const raw = await this.client.runOneShotTurn({
          prompt: buildBootstrapPrompt(nb.messages, this.learningContext(nb)),
          model: s.model,
          effort: this.config.evaluatorEffort,
          timeoutMs: 120_000,
          signal: session.startAbort?.signal,
        });
        const state = parseInitialState(raw);
        if (!state) return;
        nb.learningState = state;
        await this.store.save(nb);
      }

      const state = nb.learningState;
      if (state.lastEvaluatedMessageId === teacherMessageId) return; // retry of an already-evaluated message
      this.setActivity(session, { kind: "evaluating-teaching" });
      const context = nb.messages.filter((m) => m.id !== teacherMessageId).slice(-6);
      const raw = await this.client.runOneShotTurn({
        prompt: buildEvaluatorPrompt(state, teacherText, context),
        model: s.model,
        effort: this.config.evaluatorEffort,
        timeoutMs: 60_000,
        signal: session.startAbort?.signal,
      });
      const next = applyEvaluatorOutput(raw, state, teacherText);
      if (!next) {
        state.lastChanges = [];
        console.error(`[aria] belief evaluator output for notebook ${nb.id} was unparseable; beliefs unchanged`);
        return;
      }
      next.lastEvaluatedMessageId = teacherMessageId;
      nb.learningState = next;
      await this.store.save(nb);
    } catch (err) {
      // Stale realizations from an earlier turn must not be replayed as new.
      if (nb.learningState) nb.learningState.lastChanges = [];
      console.error(`[aria] belief evaluator failed for notebook ${nb.id}; beliefs unchanged:`, err);
    }
  }

  private async ensureThread(nb: Notebook, session: NotebookSession): Promise<void> {
    const s = this.settings.get();
    // developerInstructions are pinned at thread creation — resume does NOT
    // re-apply them (verified behaviorally). A style change therefore requires
    // a fresh thread, rebuilt from the transcript catch-up block.
    const applied = nb.appliedStyle ?? { replyLength: "default", probing: "default" };
    // The interviewer persona has no replyLength/probing slots — a Settings
    // change must never silently restart an interview thread mid-session.
    const styleCurrent =
      isInterview(nb) || (applied.replyLength === s.replyLength && applied.probing === s.probing);

    if (nb.threadId && styleCurrent && session.threadGeneration === this.client.generation) return;

    const threadConfig: Omit<ThreadStartParams, "ephemeral"> = {
      cwd: this.store.sourcesDir(nb.id),
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: isInterview(nb) ? buildInterviewerInstructions(nb) : buildDeveloperInstructions(nb, s),
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
          this.setActivity(session, { kind: "reading-sources" });
        } else if (p.item.type === "reasoning") {
          this.setActivity(session, { kind: "writing-response" });
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
          ? {
              message:
                nb && isInterview(nb)
                  ? "The interviewer didn't manage to open the session. Try again."
                  : "The student didn't manage to introduce themselves. Try again.",
            }
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
      // An intentional app-server replacement suppresses the generic crash
      // event. Stop every pre-stream branch before exposing an idle session:
      // otherwise a retry can overlap the old evaluator/research pipeline and
      // the late pipeline can reset or roll back the new turn.
      session.cancelRequested = true;
      session.startAbort?.abort();
      session.startAbort = null;
      session.researchAbort?.abort();
      session.researchAbort = null;
      // The caller's wording assumes the Aria student; interview notebooks
      // get the interviewer equivalent.
      const nb = this.store.get(session.notebookId);
      const sessionMessage = nb && isInterview(nb) ? message.replace("The student's", "The interviewer's") : message;
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
        this.broadcast(session, "error", { message: sessionMessage, retryable: true });
        this.broadcast(session, "turn-completed", { turnId: null, status: "failed", error: { message: sessionMessage } });
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
          this.broadcast(session, "error", {
            message: nb && isInterview(nb) ? "The interviewer stopped responding." : "The student stopped responding.",
            retryable: true,
          });
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

  private setActivity(session: NotebookSession, activity: SessionActivity): void {
    session.activity = activity;
    this.broadcast(session, "activity", activity);
  }

  /** Notify shell clients after sources change in pipelines outside this manager. */
  broadcastSourcesUpdated(notebookId: string): void {
    const nb = this.store.get(notebookId);
    if (!nb) return;
    this.broadcast(this.ensureSession(notebookId), "sources-updated", { notebook: toSummary(nb) });
  }
}
