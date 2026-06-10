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
};

export type Config = typeof config;
