import type { Response } from "express";

const HEARTBEAT_MS = 15_000;

/** A single Server-Sent-Events connection with heartbeat and JSON framing. */
export class SseConnection {
  private heartbeat: NodeJS.Timeout;
  private open = true;

  constructor(
    private res: Response,
    onClose?: () => void,
  ) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(":connected\n\n");

    this.heartbeat = setInterval(() => this.res.write(":hb\n\n"), HEARTBEAT_MS);
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
    this.res.write(frame);
  }

  close(): void {
    if (!this.open) return;
    this.dispose();
    this.res.end();
  }

  private dispose(): void {
    this.open = false;
    clearInterval(this.heartbeat);
  }
}
