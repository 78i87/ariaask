import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Response } from "express";
import { SseConnection } from "./sse.js";

class FakeResponse extends EventEmitter {
  writes: string[] = [];
  ended = false;
  block = false;

  status(): this {
    return this;
  }

  setHeader(): this {
    return this;
  }

  flushHeaders(): void {}

  write(frame: string): boolean {
    this.writes.push(frame);
    return !this.block;
  }

  end(): void {
    this.ended = true;
  }
}

test("a slow SSE reader is evicted once its bounded queue is exhausted", () => {
  const res = new FakeResponse();
  const conn = new SseConnection(res as unknown as Response);
  res.block = true;
  conn.send("delta", { text: "first" });
  for (let i = 0; i < 4; i++) conn.send("delta", { text: "x".repeat(90_000) });
  assert.equal(res.ended, true);
  assert.equal(conn.isOpen, false);
});

test("SSE queued frames resume only after drain", () => {
  const res = new FakeResponse();
  const conn = new SseConnection(res as unknown as Response);
  res.block = true;
  conn.send("delta", { text: "one" });
  conn.send("delta", { text: "two" });
  const beforeDrain = res.writes.length;
  res.block = false;
  res.emit("drain");
  assert.equal(res.writes.length, beforeDrain + 1);
  conn.close();
});

test("SSE admission rejects the first connection above the process cap", () => {
  const connections = Array.from(
    { length: 64 },
    () => new SseConnection(new FakeResponse() as unknown as Response),
  );
  try {
    assert.throws(
      () => new SseConnection(new FakeResponse() as unknown as Response),
      /too many live event streams/i,
    );
  } finally {
    for (const connection of connections) connection.close();
  }
});
