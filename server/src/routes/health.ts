import { Router } from "express";
import type { AppServerClient } from "../appserver/client.js";
import type { Config } from "../config.js";

export function healthRoutes(client: AppServerClient, config: Config): Router {
  const router = Router();
  router.get("/", (_req, res) => {
    res.json({
      ok: client.state === "running",
      codexFound: client.state !== "codex-not-found",
      appServerState: client.state,
      dataDir: config.dataDir,
    });
  });
  return router;
}
