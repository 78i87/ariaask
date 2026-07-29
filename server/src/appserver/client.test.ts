import assert from "node:assert/strict";
import test from "node:test";
import { AppServerClient } from "./client.js";

test("intentional restart announces itself before replacing the app-server", async () => {
  const client = new AppServerClient("/definitely/missing/aria-codex");
  let restarting = 0;
  client.on("restarting", () => {
    restarting++;
  });

  await assert.rejects(client.restart());
  assert.equal(restarting, 1);
});

test("intentional restart promptly rejects a one-shot waiting for completion", async () => {
  const client = new AppServerClient("/unused");
  client.threadStart = async () => ({ thread: { id: "thread-1" } }) as never;
  client.turnStart = async () => ({ turn: { id: "turn-1" } }) as never;

  const pending = client.runOneShotTurn({
    prompt: "test",
    model: null,
    effort: null,
    timeoutMs: 60_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  client.emit("restarting");

  await assert.rejects(pending, /app-server exited/i);
});

test("one-shot timeout interrupts a turn that has already started", async () => {
  const client = new AppServerClient("/unused");
  client.threadStart = async () => ({ thread: { id: "thread-1" } }) as never;
  client.turnStart = async () => ({ turn: { id: "turn-1" } }) as never;
  const interrupted: Array<[string, string]> = [];
  client.turnInterrupt = async (threadId, turnId) => {
    interrupted.push([threadId, turnId]);
    return {};
  };

  await assert.rejects(
    client.runOneShotTurn({ prompt: "test", model: null, effort: null, timeoutMs: 5 }),
    /timed out/i,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interrupted, [["thread-1", "turn-1"]]);
});

test("one-shot timeout interrupts a turn that starts after the timeout race", async () => {
  const client = new AppServerClient("/unused");
  client.threadStart = async () => ({ thread: { id: "thread-1" } }) as never;
  let finishStart!: (value: never) => void;
  client.turnStart = () =>
    new Promise((resolve) => {
      finishStart = resolve;
    });
  const interrupted: Array<[string, string]> = [];
  client.turnInterrupt = async (threadId, turnId) => {
    interrupted.push([threadId, turnId]);
    return {};
  };

  const pending = client.runOneShotTurn({ prompt: "test", model: null, effort: null, timeoutMs: 5 });
  await assert.rejects(pending, /timed out/i);
  finishStart({ turn: { id: "turn-late" } } as never);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interrupted, [["thread-1", "turn-late"]]);
});

test("one-shot threads disable host tools even when callers provide config", async () => {
  const client = new AppServerClient("/unused");
  let captured: Record<string, unknown> | undefined;
  client.threadStart = async (params) => {
    captured = params as unknown as Record<string, unknown>;
    return { thread: { id: "thread-1" } } as never;
  };
  client.turnStart = async () => ({ turn: { id: "turn-1" } }) as never;

  const pending = client.runOneShotTurn({
    prompt: "test",
    model: null,
    effort: null,
    timeoutMs: 60_000,
    config: { web_search: "live", features: { shell_tool: true } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  client.emit("restarting");
  await assert.rejects(pending);

  const config = captured?.config as { web_search?: string; features?: Record<string, unknown> };
  assert.equal(config.web_search, "live");
  assert.equal(config.features?.shell_tool, false);
  assert.equal(config.features?.unified_exec, false);
  assert.match(String(captured?.developerInstructions), /do not call host tools/i);
});
