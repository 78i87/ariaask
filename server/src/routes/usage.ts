import { Router } from "express";
import { HttpError } from "../lib/errors.js";
import type { CoachMode, UsageStore } from "../domain/usage.js";

const COACH_MODES: CoachMode[] = ["guided", "intermediate", "experienced"];

export function usageRoutes(usage: UsageStore): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ usage: usage.get() });
  });

  // The only writable field is the coaching mode — technique counts come from
  // server-side instrumentation, never from the client.
  router.put("/", async (req, res) => {
    const body = (req.body ?? {}) as { coachMode?: unknown };
    if (!COACH_MODES.includes(body.coachMode as CoachMode)) {
      throw new HttpError(400, "invalid_mode", `coachMode must be one of ${COACH_MODES.join(", ")}`);
    }
    await usage.setCoachMode(body.coachMode as CoachMode);
    res.json({ usage: usage.get() });
  });

  return router;
}
