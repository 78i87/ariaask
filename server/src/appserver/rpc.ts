import type { ChildProcessWithoutNullStreams } from "node:child_process";

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcHandlers {
  onNotification(method: string, params: unknown): void;
  onServerRequest(id: number | string, method: string, params: unknown): void;
  onClose(code: number | null): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * JSON-RPC over the app-server's stdio: newline-delimited JSON, one message
 * per line. The 0.138.0 wire format omits the `"jsonrpc":"2.0"` field; we do
 * the same on send and tolerate either on receive.
 */
export class JsonRpcStdioConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private handlers: RpcHandlers,
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.error(`[codex] ${line}`);
      }
    });
    child.on("close", (code) => this.handlers.onClose(code));
  }

  request<T>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-32000, `request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  failAllPending(reason: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  private write(msg: Record<string, unknown>): void {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`[codex] unparseable line: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if ("error" in msg && msg.error) {
        const e = msg.error as { code?: number; message?: string; data?: unknown };
        p.reject(new RpcError(e.code ?? -32000, e.message ?? "unknown RPC error", e.data));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (hasId && typeof msg.method === "string") {
      this.handlers.onServerRequest(msg.id as number | string, msg.method, msg.params);
      return;
    }
    if (typeof msg.method === "string") {
      this.handlers.onNotification(msg.method, msg.params);
    }
  }
}
