import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcStdioConnection, RpcError } from "./rpc.js";
import type {
  AccountLoginCompletedNotification,
  GetAccountResponse,
  ItemNotification,
  LoginChatGptResponse,
  ModelListResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
} from "./protocol.js";

export class CodexNotFoundError extends Error {
  constructor(bin: string) {
    super(`Codex CLI not found ("${bin}"). Install it with: npm install -g @openai/codex`);
    this.name = "CodexNotFoundError";
  }
}

export class AppServerCrashedError extends Error {
  constructor() {
    super("Codex app-server exited unexpectedly");
    this.name = "AppServerCrashedError";
  }
}

export type AppServerState = "starting" | "running" | "restarting" | "dead" | "codex-not-found" | "stopped";

type ThreadSubscriber = (method: string, params: unknown) => void;

const RESTART_DELAYS_MS = [1000, 2000, 5000];
const FAILURE_WINDOW_MS = 60_000;

/**
 * Owns the `codex app-server` child process: spawn + initialize handshake,
 * typed method wrappers, notification routing, auto-declining approval
 * requests, and crash supervision with backoff.
 *
 * Events: "login-completed" (AccountLoginCompletedNotification),
 * "account-updated", "crashed", "restarted", "state" (AppServerState).
 */
export class AppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private conn: JsonRpcStdioConnection | null = null;
  private threadSubs = new Map<string, Set<ThreadSubscriber>>();
  private failures: number[] = [];
  private stopping = false;
  private generationCounter = 0;
  private stateValue: AppServerState = "starting";

  constructor(private codexBin: string) {
    super();
  }

  get state(): AppServerState {
    return this.stateValue;
  }

  /** Increments on every (re)spawn; used to detect when threads need thread/resume. */
  get generation(): number {
    return this.generationCounter;
  }

  async start(): Promise<void> {
    this.setState("starting");
    await this.spawnAndInitialize();
    this.setState("running");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    this.setState("stopped");
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("close", () => {
        clearTimeout(killTimer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.child = null;
    this.conn = null;
  }

  // ---------- typed methods ----------

  readAccount(): Promise<GetAccountResponse> {
    return this.rpc().request("account/read", { refreshToken: false });
  }

  loginStart(): Promise<LoginChatGptResponse> {
    return this.rpc().request("account/login/start", { type: "chatgpt" });
  }

  loginCancel(loginId: string): Promise<unknown> {
    return this.rpc().request("account/login/cancel", { loginId });
  }

  logout(): Promise<unknown> {
    return this.rpc().request("account/logout");
  }

  listModels(): Promise<ModelListResponse> {
    return this.rpc().request("model/list", {});
  }

  threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.rpc().request("thread/start", params);
  }

  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.rpc().request("thread/resume", params);
  }

  turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.rpc().request("turn/start", params);
  }

  turnInterrupt(threadId: string, turnId: string): Promise<unknown> {
    return this.rpc().request("turn/interrupt", { threadId, turnId });
  }

  /**
   * Run a single prompt on a throwaway ephemeral thread and return the final
   * agent message text. Used for side calls (belief-state generation and the
   * per-turn evaluator) that must not touch the student's long-lived thread.
   * Throws on turn failure, timeout, or an app-server crash mid-call.
   */
  async runOneShotTurn(opts: {
    prompt: string;
    model: string | null;
    effort: string | null;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const started = await this.threadStart({
      ephemeral: true,
      cwd: opts.cwd ?? null,
      sandbox: "read-only",
      approvalPolicy: "never",
      personality: "none",
      model: opts.model,
    });
    const threadId = started.thread.id;

    let resolveDone!: (text: string) => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<string>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const timer = setTimeout(() => rejectDone(new RpcError(-32000, `one-shot turn timed out after ${timeoutMs}ms`)), timeoutMs);
    // failAllPending only rejects in-flight RPCs — the wait for the
    // turn/completed notification needs its own crash handler.
    const onCrash = () => rejectDone(new AppServerCrashedError());
    this.once("crashed", onCrash);

    // A fresh ephemeral thread carries exactly one turn, so no turnId
    // filtering is needed (which also sidesteps any response/notification
    // ordering race with turn/start).
    const texts: string[] = [];
    const unsubscribe = this.subscribeThread(threadId, (method, params) => {
      if (method === "item/completed") {
        const p = params as ItemNotification;
        if (p.item.type === "agentMessage" && typeof p.item.text === "string") texts.push(p.item.text);
      } else if (method === "turn/completed") {
        const p = params as TurnCompletedNotification;
        if (p.turn.status !== "completed") {
          rejectDone(new Error(p.turn.error?.message ?? `one-shot turn ${p.turn.status}`));
          return;
        }
        let text = texts.join("\n").trim();
        if (!text) {
          // Whether the notification's turn.items is populated is
          // version-dependent — fall back to it only when streaming
          // item/completed events produced nothing.
          text = (p.turn.items ?? [])
            .filter((i) => i.type === "agentMessage" && typeof i.text === "string")
            .map((i) => i.text as string)
            .join("\n")
            .trim();
        }
        if (text) resolveDone(text);
        else rejectDone(new Error("one-shot turn produced no agent message"));
      }
    });

    try {
      this.turnStart({
        threadId,
        input: [{ type: "text", text: opts.prompt, text_elements: [] }],
        model: opts.model,
        effort: opts.effort,
      }).catch(rejectDone);
      return await done;
    } finally {
      clearTimeout(timer);
      unsubscribe();
      this.off("crashed", onCrash);
    }
  }

  // ---------- notification routing ----------

  subscribeThread(threadId: string, fn: ThreadSubscriber): () => void {
    let subs = this.threadSubs.get(threadId);
    if (!subs) {
      subs = new Set();
      this.threadSubs.set(threadId, subs);
    }
    subs.add(fn);
    return () => {
      subs.delete(fn);
      if (subs.size === 0) this.threadSubs.delete(threadId);
    };
  }

  // ---------- internals ----------

  private rpc(): JsonRpcStdioConnection {
    if (!this.conn || this.stateValue !== "running") {
      throw new RpcError(-32000, `Codex app-server is not available (state: ${this.stateValue})`);
    }
    return this.conn;
  }

  private setState(s: AppServerState): void {
    this.stateValue = s;
    this.emit("state", s);
  }

  private spawnAndInitialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.codexBin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
      let settled = false;

      child.once("error", (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        if (err.code === "ENOENT") {
          this.setState("codex-not-found");
          reject(new CodexNotFoundError(this.codexBin));
        } else {
          reject(err);
        }
      });

      const conn = new JsonRpcStdioConnection(child, {
        onNotification: (method, params) => this.onNotification(method, params),
        onServerRequest: (id, method, params) => this.onServerRequest(id, method, params),
        onClose: (code) => this.onChildClose(code),
      });

      this.child = child;
      this.conn = conn;
      this.generationCounter++;

      conn
        .request(
          "initialize",
          {
            clientInfo: { name: "aria", title: "Aria", version: "0.1.0" },
            capabilities: {
              experimentalApi: true,
              requestAttestation: false,
              optOutNotificationMethods: [
                "rawResponseItem/completed",
                "thread/tokenUsage/updated",
                "account/rateLimits/updated",
              ],
            },
          },
          15_000,
        )
        .then(() => {
          conn.notify("initialized");
          if (!settled) {
            settled = true;
            resolve();
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            // Don't leave a half-initialized child alive and unusable; killing
            // it fires onChildClose, which retries with backoff or gives up.
            child.kill("SIGKILL");
            reject(err);
          }
        });
    });
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "account/login/completed") {
      this.emit("login-completed", params as AccountLoginCompletedNotification);
      return;
    }
    if (method === "account/updated") {
      this.emit("account-updated", params);
      return;
    }
    const threadId = (params as { threadId?: string } | undefined)?.threadId;
    if (threadId) {
      const subs = this.threadSubs.get(threadId);
      if (subs) {
        for (const fn of subs) fn(method, params);
      }
    }
  }

  /**
   * Approval requests should never occur (read-only sandbox + approvalPolicy
   * "never") — auto-decline so a misconfiguration can't hang a turn.
   */
  private onServerRequest(id: number | string, method: string, params: unknown): void {
    console.error(`[aria] unexpected server request "${method}" — auto-declining`, JSON.stringify(params)?.slice(0, 300));
    const conn = this.conn;
    if (!conn) return;
    switch (method) {
      case "execCommandApproval":
      case "applyPatchApproval":
        conn.respond(id, { decision: "denied" });
        break;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        conn.respond(id, { decision: "decline" });
        break;
      default:
        conn.respondError(id, -32601, `aria does not support "${method}"`);
    }
  }

  private onChildClose(code: number | null): void {
    this.conn?.failAllPending(new AppServerCrashedError());
    // codex-not-found: restarting would respawn the same missing binary forever.
    if (this.stopping || this.stateValue === "stopped" || this.stateValue === "codex-not-found") return;

    console.error(`[aria] codex app-server exited (code ${code})`);
    this.emit("crashed");

    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length > RESTART_DELAYS_MS.length) {
      console.error("[aria] codex app-server crashing repeatedly; giving up");
      this.setState("dead");
      return;
    }

    const delay = RESTART_DELAYS_MS[Math.min(this.failures.length - 1, RESTART_DELAYS_MS.length - 1)] ?? 5000;
    this.setState("restarting");
    setTimeout(() => {
      if (this.stopping) return;
      this.spawnAndInitialize()
        .then(() => {
          this.failures = [];
          this.setState("running");
          this.emit("restarted");
        })
        .catch((err) => {
          console.error("[aria] app-server restart failed:", err);
          this.onChildClose(null);
        });
    }, delay);
  }
}
