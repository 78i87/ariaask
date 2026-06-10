import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcStdioConnection, RpcError } from "./rpc.js";
import type {
  AccountLoginCompletedNotification,
  GetAccountResponse,
  LoginChatGptResponse,
  ModelListResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
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
    if (this.stopping || this.stateValue === "stopped") return;

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
