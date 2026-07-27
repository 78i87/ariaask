import assert from "node:assert/strict";
import test from "node:test";
import { AppServerClient } from "../appserver/client.js";
import { SessionManager } from "./session.js";

test("intentional restart aborts every pre-stream branch before the main session becomes idle", async () => {
  const client = new AppServerClient("/unused");
  const manager = new SessionManager(
    client,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
  );
  const session = (
    manager as unknown as {
      ensureSession: (notebookId: string) => {
        state: "idle" | "starting";
        cancelRequested: boolean;
        startAbort: AbortController | null;
        researchAbort: AbortController | null;
      };
    }
  ).ensureSession("notebook-1");
  const startAbort = new AbortController();
  const researchAbort = new AbortController();
  session.state = "starting";
  session.startAbort = startAbort;
  session.researchAbort = researchAbort;

  client.emit("restarting");

  assert.equal(session.cancelRequested, true);
  assert.equal(startAbort.signal.aborted, true);
  assert.equal(researchAbort.signal.aborted, true);
  assert.equal(session.startAbort, null);
  assert.equal(session.researchAbort, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.state, "idle");
});
