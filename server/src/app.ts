import express from "express";
import type { AppServerClient } from "./appserver/client.js";
import type { Config } from "./config.js";
import type { NotebookStore } from "./domain/store.js";
import type { SessionManager } from "./domain/session.js";
import type { CyraSessionManager } from "./domain/cyra-session.js";
import type { SettingsStore } from "./domain/settings.js";
import { errorHandler, HttpError } from "./lib/errors.js";
import { authRoutes, LoginTracker } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { notebookRoutes } from "./routes/notebooks.js";
import { settingsRoutes } from "./routes/settings.js";

export interface AppDeps {
  config: Config;
  client: AppServerClient;
  store: NotebookStore;
  sessions: SessionManager;
  cyra: CyraSessionManager;
  logins: LoginTracker;
  settings: SettingsStore;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.use("/api/health", healthRoutes(deps.client, deps.config));

  // Everything else needs a live codex app-server.
  app.use("/api", (_req, _res, next) => {
    if (deps.client.state === "codex-not-found") {
      next(new HttpError(503, "codex_not_found", 'Codex CLI not found. Install it with "npm install -g @openai/codex" and restart Aria.'));
    } else if (deps.client.state !== "running") {
      next(new HttpError(503, "appserver_unavailable", `Codex app-server is ${deps.client.state}; try again shortly.`));
    } else {
      next();
    }
  });

  app.use("/api/auth", authRoutes(deps.client, deps.logins));
  app.use("/api/notebooks", notebookRoutes(deps.store, deps.sessions, deps.settings, deps.cyra));
  app.use("/api/settings", settingsRoutes(deps.settings, deps.client));

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not_found")));
  app.use(errorHandler);
  return app;
}
