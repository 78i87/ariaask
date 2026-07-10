import path from "node:path";
import fs from "node:fs/promises";
import { writeFileAtomic } from "../lib/atomic.js";

/**
 * App-wide technique-usage tracking and the adaptive coaching mode — the
 * learner's built-in learning log (kb: guides/learning-log.md) and the data
 * behind scaffold fading (kb: principles/scaffolds-to-independence.md).
 * Deliberately GLOBAL (data/usage.json, SettingsStore pattern): the skill of
 * learning belongs to the user, not to one notebook.
 *
 * Technique keys are free-form slugs; current instrumentation:
 *   "guided-reading:beginner|intermediate|experienced"  (reading session created)
 *   "teach-back"                                        (a teaching session — first
 *                                                        Aria message after a gap)
 *   "ask-expert"                                        (a Cyra thread created)
 */

export type CoachMode = "guided" | "intermediate" | "experienced";

const COACH_MODES: CoachMode[] = ["guided", "intermediate", "experienced"];

export interface TechniqueUse {
  uses: number;
  lastUsedAt: string;
}

interface UsageFile {
  schemaVersion: 1;
  coachMode: CoachMode;
  techniques: Record<string, TechniqueUse>;
}

export class UsageStore {
  private usage: UsageFile = { schemaVersion: 1, coachMode: "guided", techniques: {} };
  private saveChain: Promise<void> = Promise.resolve();

  constructor(private dataDir: string) {}

  private get file(): string {
    return path.join(this.dataDir, "usage.json");
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<UsageFile>;
      if (parsed.schemaVersion === 1) {
        this.usage = {
          schemaVersion: 1,
          coachMode: COACH_MODES.includes(parsed.coachMode as CoachMode) ? (parsed.coachMode as CoachMode) : "guided",
          techniques: typeof parsed.techniques === "object" && parsed.techniques !== null ? parsed.techniques : {},
        };
        return;
      }
    } catch {
      /* missing or unreadable — first boot keeps the defaults */
    }
    await this.persist();
  }

  get(): { coachMode: CoachMode; techniques: Record<string, TechniqueUse> } {
    return this.usage;
  }

  /** Fire-and-forget safe: usage tracking must never fail a user action. */
  recordUse(technique: string): void {
    const entry = this.usage.techniques[technique] ?? { uses: 0, lastUsedAt: "" };
    entry.uses += 1;
    entry.lastUsedAt = new Date().toISOString();
    this.usage.techniques[technique] = entry;
    void this.persist().catch((err) => console.error("[aria] usage save failed:", err));
  }

  async setCoachMode(mode: CoachMode): Promise<void> {
    this.usage.coachMode = mode;
    await this.persist();
  }

  /** Wait for in-flight saves to land. Used to drain before shutdown. */
  flush(): Promise<void> {
    return this.saveChain.catch(() => {});
  }

  /**
   * The hidden per-turn profile block for coach turns, or "" when there is
   * nothing worth telling the coach yet.
   */
  renderProfileBlock(): string {
    const entries = Object.entries(this.usage.techniques);
    if (entries.length === 0) return "";
    const lines = entries
      .sort((a, b) => b[1].uses - a[1].uses)
      .map(([slug, t]) => `- ${slug}: ${t.uses}× (last ${t.lastUsedAt.slice(0, 10)})`)
      .join("\n");
    return `[USER PROFILE — the user never sees this block. App-wide technique usage so far:

${lines}

Coaching mode: ${this.usage.coachMode}. Scaffolds should fade as habits internalize: when a
scaffolded technique has been used ~5+ times at the same level (e.g. guided-reading:beginner
at 5×), suggest stepping down to lighter scaffolding at a natural moment — ONCE, not every
turn (check the conversation; if you already suggested it recently, drop it). Level changes
are the user's call: reading level is picked per reading, and coaching mode lives in
Settings → Coaching style. The log ritual fades too: once learning-log reaches ~10+ uses,
stop drafting \`\`\`log entries unprompted — ask "want to log it?" or expect them to log it
themselves. The user's message follows.]

`;
  }

  private persist(): Promise<void> {
    // Snapshot synchronously so a queued save can't serialize a later mutation.
    const json = JSON.stringify(this.usage, null, 2);
    this.saveChain = this.saveChain.catch(() => {}).then(() => writeFileAtomic(this.file, json));
    return this.saveChain;
  }
}
