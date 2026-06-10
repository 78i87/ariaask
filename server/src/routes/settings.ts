import { Router } from "express";
import type { AppServerClient } from "../appserver/client.js";
import type { Model, ReasoningEffortOption } from "../appserver/protocol.js";
import type { Probing, ReplyLength } from "../domain/persona.js";
import type { SettingsStore } from "../domain/settings.js";
import { HttpError } from "../lib/errors.js";

export interface EffortInfo {
  effort: string;
  description: string | null;
}

export interface ModelInfo {
  model: string;
  displayName: string;
  description: string | null;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: EffortInfo[];
}

const REPLY_LENGTHS = new Set<ReplyLength>(["concise", "default", "chatty"]);
const PROBINGS = new Set<Probing>(["gentle", "default", "relentless"]);

/** model/list elements may carry efforts as plain strings or objects; normalize. */
function normalizeEfforts(raw: Model["supportedReasoningEfforts"]): EffortInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: EffortInfo[] = [];
  for (const e of raw) {
    if (typeof e === "string") {
      out.push({ effort: e, description: null });
    } else if (e && typeof e === "object") {
      const o = e as ReasoningEffortOption & { effort?: string };
      const effort = typeof o.reasoningEffort === "string" ? o.reasoningEffort : o.effort;
      if (typeof effort === "string") {
        out.push({ effort, description: typeof o.description === "string" ? o.description : null });
      }
    }
  }
  return out;
}

function toModelInfo(m: Model): ModelInfo {
  return {
    model: m.model,
    displayName: m.displayName,
    description: typeof m.description === "string" ? m.description : null,
    isDefault: m.isDefault,
    defaultReasoningEffort: m.defaultReasoningEffort,
    supportedReasoningEfforts: normalizeEfforts(m.supportedReasoningEfforts),
  };
}

export function settingsRoutes(settings: SettingsStore, client: AppServerClient): Router {
  const router = Router();

  // Cached per app-server generation — the list only changes with a codex
  // upgrade or account change, which coincide with a respawn.
  let cache: { generation: number; models: ModelInfo[] } | null = null;

  async function loadModels(): Promise<ModelInfo[]> {
    if (cache && cache.generation === client.generation) return cache.models;
    const res = await client.listModels();
    const models = res.data.filter((m) => !m.hidden).map(toModelInfo);
    cache = { generation: client.generation, models };
    return models;
  }

  router.get("/", async (_req, res) => {
    let models: ModelInfo[] = [];
    try {
      models = await loadModels();
    } catch (err) {
      console.error("[aria] model/list failed; settings UI degrades:", err);
    }
    const { schemaVersion: _v, ...rest } = settings.get();
    res.json({ settings: rest, models });
  });

  router.put("/", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<{ model: string | null; effort: string | null; replyLength: ReplyLength; probing: Probing }> =
      {};

    if ("replyLength" in body) {
      if (!REPLY_LENGTHS.has(body.replyLength as ReplyLength)) {
        throw new HttpError(400, "invalid_settings", `Invalid replyLength "${String(body.replyLength)}"`);
      }
      patch.replyLength = body.replyLength as ReplyLength;
    }
    if ("probing" in body) {
      if (!PROBINGS.has(body.probing as Probing)) {
        throw new HttpError(400, "invalid_settings", `Invalid probing "${String(body.probing)}"`);
      }
      patch.probing = body.probing as Probing;
    }

    const needsModels = "model" in body || "effort" in body;
    const models = needsModels ? await loadModels() : [];

    if ("model" in body) {
      if (body.model !== null && (typeof body.model !== "string" || !models.some((m) => m.model === body.model))) {
        throw new HttpError(400, "invalid_settings", `Unknown model "${String(body.model)}"`);
      }
      patch.model = body.model as string | null;
    }

    if ("effort" in body || "model" in body) {
      const current = settings.get();
      const targetModelSlug = "model" in body ? patch.model : current.model;
      const target =
        models.find((m) => m.model === targetModelSlug) ?? models.find((m) => m.isDefault) ?? models[0] ?? null;
      const supported = new Set(target?.supportedReasoningEfforts.map((e) => e.effort) ?? []);

      if ("effort" in body) {
        if (body.effort !== null && (typeof body.effort !== "string" || !supported.has(body.effort))) {
          throw new HttpError(400, "invalid_settings", `Effort "${String(body.effort)}" is not supported by ${target?.displayName ?? "the selected model"}`);
        }
        patch.effort = body.effort as string | null;
      } else if (current.effort !== null && !supported.has(current.effort)) {
        // Model changed and the stored effort isn't supported — coerce to model default.
        patch.effort = null;
      }
    }

    const updated = await settings.update(patch);
    const { schemaVersion: _v, ...rest } = updated;
    res.json({ settings: rest });
  });

  return router;
}
