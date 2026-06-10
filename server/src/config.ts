import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 5275),
  dataDir: process.env.ARIA_DATA_DIR ?? path.resolve(here, "../../data"),
  codexBin: process.env.CODEX_BIN ?? "codex",
  /** Seed data/settings.json on first boot only; after that the file wins. null = account default. */
  envModel: process.env.ARIA_MODEL ?? null,
  /** Seed for chat effort on first boot. null = the model's default effort. */
  envEffort: process.env.ARIA_EFFORT ?? null,
  /** When set, pins kickoff effort instead of the max(medium, chosen) rule. */
  kickoffEffortOverride: process.env.ARIA_KICKOFF_EFFORT ?? null,
  /** Reasoning effort for the belief-state side calls (initial state from a topic, per-turn evaluator). */
  evaluatorEffort: process.env.ARIA_EVALUATOR_EFFORT ?? "low",
  /** Kill switch for the learning-state layer: no state generation, no evaluator, no belief blocks. */
  learningStateDisabled: process.env.ARIA_NO_LEARNING_STATE === "1",
};

export type Config = typeof config;
