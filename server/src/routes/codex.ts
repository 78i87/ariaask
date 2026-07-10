import { Router, type Request } from "express";
import type { CodexCliUpdater } from "../domain/codex-update.js";
import { HttpError } from "../lib/errors.js";

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase();
  if (/^\[::1\](?::\d+)?$/.test(normalized)) return true;
  const hostname = normalized.replace(/:\d+$/, "");
  return hostname === "localhost" || isLoopbackAddress(hostname);
}

export function isDirectLoopbackRequest(req: Pick<Request, "socket" | "headers">): boolean {
  const forwarded =
    req.headers.forwarded ??
    req.headers["x-forwarded-for"] ??
    req.headers["x-real-ip"] ??
    req.headers["cf-connecting-ip"];
  return isLoopbackAddress(req.socket.remoteAddress) && isLoopbackHost(req.headers.host) && !forwarded;
}

export function isAuthorizedLocalUpdate(req: Pick<Request, "socket" | "headers" | "is">): boolean {
  return (
    isDirectLoopbackRequest(req) &&
    req.headers["x-aria-local-action"] === "codex-update" &&
    Boolean(req.is("application/json"))
  );
}

export function codexRoutes(updater: CodexCliUpdater): Router {
  const router = Router();

  router.get("/status", async (req, res) => {
    if (!isDirectLoopbackRequest(req)) throw new HttpError(403, "local_only");
    res.json(await updater.getStatus());
  });

  router.post("/update", async (req, res) => {
    if (!isAuthorizedLocalUpdate(req)) throw new HttpError(403, "local_only");
    res.json(await updater.update());
  });

  return router;
}
