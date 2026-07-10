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
