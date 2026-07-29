import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 5275),
  /** Local-first security boundary: never bind the unauthenticated app to LAN interfaces. */
  host: "127.0.0.1",
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
  /** Kill switch for the learning/knowledge-state layers: no state generation, evaluator, map, or belief blocks. */
  learningStateDisabled: process.env.ARIA_NO_LEARNING_STATE === "1",
  /** Reasoning effort for the online source discovery turn. */
  researchEffort: process.env.ARIA_RESEARCH_EFFORT ?? "medium",
  /** Maximum sources to auto-add from each online discovery run (clamped 1–10; malformed → 5). */
  discoverMax: (() => {
    const n = Math.floor(Number(process.env.ARIA_DISCOVER_MAX ?? 5));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : 5;
  })(),
  /** Kill switch for the setup form: new notebooks get no intake (auto-kickoff; research defaults silently). */
  intakeDisabled: process.env.ARIA_NO_INTAKE === "1",
  /** Kill switch for the retrieval layer (rag.ts): no index builds, no recall blocks. */
  ragDisabled: process.env.ARIA_NO_RAG === "1",
  /** The learning-coach knowledge base corpus (kb.ts); indexed globally to dataDir/kb-index.json. */
  kbDir: process.env.ARIA_KB_DIR ?? path.resolve(here, "../../kb"),
  /** Kill switch for the knowledge base: no index build, no coaching-notes blocks (persona-only coach). */
  kbDisabled: process.env.ARIA_NO_KB === "1",
  /** Reasoning effort for coach turns. null = the chat effort from settings. */
  coachEffort: process.env.ARIA_COACH_EFFORT ?? null,
  /** Reasoning effort for the guided-reading annotation pass (reading.ts). */
  readingEffort: process.env.ARIA_READING_EFFORT ?? "medium",
  /** Embedding model for source retrieval (a transformers.js model id; cached under dataDir/models). */
  ragModel: process.env.ARIA_RAG_MODEL ?? "Xenova/bge-small-en-v1.5",
  /** The "auto" recall threshold: sources must hold at least this many extracted words. */
  ragMinWords: Number(process.env.ARIA_RAG_MIN_WORDS ?? 4000),
  /** Hard cap on the whole per-turn retrieval path; past it the turn proceeds without excerpts. */
  ragQueryTimeoutMs: Number(process.env.ARIA_RAG_WAIT_MS ?? 2000),
};

export type Config = typeof config;
