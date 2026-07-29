import type { Response } from "express";
import { HttpError } from "./errors.js";

const HEARTBEAT_MS = 15_000;
const MAX_ACTIVE_CONNECTIONS = 64;
const MAX_QUEUED_BYTES = 256 * 1024;
const BACKPRESSURE_TIMEOUT_MS = 30_000;

/** A single Server-Sent-Events connection with heartbeat and JSON framing. */
export class SseConnection {
  private static activeConnections = 0;
  private heartbeat: NodeJS.Timeout;
  private open = true;
  private blocked = false;
  private queuedBytes = 0;
  private queue: string[] = [];
  private backpressureTimer: NodeJS.Timeout | null = null;

  constructor(
    private res: Response,
    onClose?: () => void,
  ) {
    if (SseConnection.activeConnections >= MAX_ACTIVE_CONNECTIONS) {
      throw new HttpError(429, "too_many_streams", "Too many live event streams; close another stream and retry.");
    }
    SseConnection.activeConnections++;
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    this.write(":connected\n\n");

    this.heartbeat = setInterval(() => this.write(":hb\n\n"), HEARTBEAT_MS);
    res.on("drain", this.flushQueue);
    res.on("error", this.onError);
    res.on("close", () => {
      this.dispose();
      onClose?.();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  send(event: string, data: unknown, id?: number): void {
    if (!this.open) return;
    let frame = "";
    if (id !== undefined) frame += `id: ${id}\n`;
    frame += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.write(frame);
  }

  close(): void {
    if (!this.open) return;
    this.dispose();
    this.res.end();
  }

  private dispose(): void {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.heartbeat);
    this.res.off("drain", this.flushQueue);
    this.res.off("error", this.onError);
    if (this.backpressureTimer) clearTimeout(this.backpressureTimer);
    this.backpressureTimer = null;
    this.queue = [];
    this.queuedBytes = 0;
    SseConnection.activeConnections--;
  }

  private write(frame: string): void {
    if (!this.open) return;
    if (this.blocked) {
      const bytes = Buffer.byteLength(frame);
      if (this.queuedBytes + bytes > MAX_QUEUED_BYTES) {
        this.close();
        return;
      }
      this.queue.push(frame);
      this.queuedBytes += bytes;
      return;
    }
    this.blocked = !this.res.write(frame);
    if (this.blocked) this.armBackpressureTimeout();
  }

  private flushQueue = (): void => {
    if (!this.open) return;
    if (this.backpressureTimer) clearTimeout(this.backpressureTimer);
    this.backpressureTimer = null;
    this.blocked = false;
    while (this.queue.length > 0 && !this.blocked) {
      const frame = this.queue.shift()!;
      this.queuedBytes -= Buffer.byteLength(frame);
      this.blocked = !this.res.write(frame);
    }
    if (this.blocked) this.armBackpressureTimeout();
  };

  private onError = (): void => this.close();

  private armBackpressureTimeout(): void {
    if (this.backpressureTimer) return;
    this.backpressureTimer = setTimeout(() => this.close(), BACKPRESSURE_TIMEOUT_MS);
    this.backpressureTimer.unref();
  }
}
