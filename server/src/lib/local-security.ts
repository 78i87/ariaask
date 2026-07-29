import net from "node:net";
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "./errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const LOCAL_ACTION_HEADER = "x-aria-local-action";

function normalizedAddress(value: string | undefined): string {
  if (!value) return "";
  const zone = value.indexOf("%");
  const withoutZone = zone >= 0 ? value.slice(0, zone) : value;
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice(7) : withoutZone;
}

export function isLoopbackAddress(value: string | undefined): boolean {
  const address = normalizedAddress(value);
  if (address === "::1") return true;
  if (net.isIP(address) === 4) {
    const first = Number(address.split(".", 1)[0]);
    return first === 127;
  }
  return false;
}

export function isLoopbackHostname(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost") || isLoopbackAddress(host);
}

function validateOrigin(req: Request): void {
  const origin = req.get("origin");
  if (!origin) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, "invalid_origin", "The request origin is invalid.");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !isLoopbackHostname(parsed.hostname)) {
    throw new HttpError(403, "cross_site_request", "Cross-site requests are not allowed.");
  }
}

/**
 * Aria is a single-user local app. Treat the loopback socket plus a
 * non-form-settable action header as its request boundary:
 * - LAN callers cannot reach protected API routes even if the listener is
 *   accidentally rebound by a wrapper.
 * - public-site form navigations cannot perform mutations because they cannot
 *   set X-Aria-Local-Action, and their Origin/Fetch-Metadata is rejected.
 */
export function enforceLocalApi(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      throw new HttpError(403, "local_only", "This API is available only from the local machine.");
    }
    if (!isLoopbackHostname(req.hostname)) {
      throw new HttpError(403, "invalid_host", "This API accepts only loopback hostnames.");
    }

    const fetchSite = req.get("sec-fetch-site")?.toLowerCase();
    if (fetchSite === "cross-site") {
      throw new HttpError(403, "cross_site_request", "Cross-site requests are not allowed.");
    }
    validateOrigin(req);

    const localAction = req.get(LOCAL_ACTION_HEADER);
    if (!SAFE_METHODS.has(req.method.toUpperCase()) && localAction !== "1" && localAction !== "codex-update") {
      throw new HttpError(403, "local_action_required", "Missing local action confirmation.");
    }
    next();
  } catch (err) {
    next(err);
  }
}
