import fs from "node:fs/promises";
import { config } from "./config.js";
import { AppServerClient, CodexNotFoundError } from "./appserver/client.js";
import { NotebookStore } from "./domain/store.js";
import { SessionManager } from "./domain/session.js";
import { CyraSessionManager } from "./domain/cyra-session.js";
import { CoachSessionManager } from "./domain/coach-session.js";
import { ensureKbIndex } from "./domain/kb.js";
import { SettingsStore } from "./domain/settings.js";
import { UsageStore } from "./domain/usage.js";
import { CodexCliUpdater } from "./domain/codex-update.js";
import { LoginTracker } from "./routes/auth.js";
import { createApp } from "./app.js";

async function main(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });

  const store = new NotebookStore(config.dataDir);
  await store.init();

  const client = new AppServerClient(config.codexBin);
  try {
    await client.start();
    console.log("[aria] codex app-server running");
  } catch (err) {
    if (err instanceof CodexNotFoundError) {
      console.error(`[aria] ${err.message}`);
    } else {
      console.error("[aria] failed to start codex app-server:", err);
    }
  }

  const settings = new SettingsStore(config.dataDir, { model: config.envModel, effort: config.envEffort });
  await settings.init();
  try {
    const listed = await client.listModels();
    await settings.reconcileModel(listed.data.filter((model) => !model.hidden));
  } catch (err) {
    console.error("[aria] couldn't reconcile the selected model; keeping persisted settings:", err);
  }

  const usage = new UsageStore(config.dataDir);
  await usage.init();
  const codexUpdater = new CodexCliUpdater({
    codexBin: config.codexBin,
    restartAppServer: () => client.restart(),
  });

  // Build (or freshness-check) the knowledge-base index in the background;
  // also pre-warms the shared embedding model for notebook retrieval.
  if (!config.kbDisabled) void ensureKbIndex();

  const sessions = new SessionManager(client, store, settings, config);
  const cyra = new CyraSessionManager(client, store, settings);
  const coach = new CoachSessionManager(client, store, settings, usage);
  const logins = new LoginTracker(client);
  const app = createApp({ config, client, store, sessions, cyra, coach, logins, settings, usage, codexUpdater });

  const server = app.listen(config.port, () => {
    console.log(`[aria] server listening on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    console.log("[aria] shutting down");
    server.close();
    await store.flush();
    await settings.flush();
    await usage.flush();
    await client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[aria] fatal:", err);
  process.exit(1);
});
