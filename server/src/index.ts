import fs from "node:fs/promises";
import { config } from "./config.js";
import { AppServerClient, CodexNotFoundError } from "./appserver/client.js";
import { NotebookStore } from "./domain/store.js";
import { SessionManager } from "./domain/session.js";
import { SettingsStore } from "./domain/settings.js";
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

  const sessions = new SessionManager(client, store, settings, config);
  const logins = new LoginTracker(client);
  const app = createApp({ config, client, store, sessions, logins, settings });

  const server = app.listen(config.port, () => {
    console.log(`[aria] server listening on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    console.log("[aria] shutting down");
    server.close();
    await store.flush();
    await settings.flush();
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
