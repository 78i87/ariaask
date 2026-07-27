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
