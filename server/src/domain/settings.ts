import path from "node:path";
import fs from "node:fs/promises";
import { writeFileAtomic } from "../lib/atomic.js";
import type { Probing, ReplyLength } from "./persona.js";
import type { RagMode, RagRecall } from "./rag.js";

export interface Settings {
  schemaVersion: 1;
  /** Model slug for thread/turn overrides; null = account default. */
  model: string | null;
  /** Chat reasoning effort; null = the model's default effort. */
  effort: string | null;
  replyLength: ReplyLength;
  probing: Probing;
  /** Reading recall (rag.ts): off / auto (large readings only) / always. */
  ragMode: RagMode;
  /** How much reading the student recalls per turn. */
  ragRecall: RagRecall;
}

export interface SelectableModel {
  model: string;
  isDefault: boolean;
  supportedReasoningEfforts?: readonly (string | { effort?: string; reasoningEffort?: string })[];
}

const REPLY_LENGTHS: ReplyLength[] = ["concise", "default", "chatty"];
const PROBINGS: Probing[] = ["gentle", "default", "relentless"];
const RAG_MODES: RagMode[] = ["off", "auto", "always"];
const RAG_RECALLS: RagRecall[] = ["light", "default", "generous"];

export class SettingsStore {
  private settings: Settings;
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private dataDir: string,
    seed: { model: string | null; effort: string | null },
  ) {
    this.settings = {
      schemaVersion: 1,
      model: seed.model,
      effort: seed.effort,
      replyLength: "default",
      probing: "default",
      ragMode: "auto",
      ragRecall: "default",
    };
  }

  private get file(): string {
    return path.join(this.dataDir, "settings.json");
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<Settings>;
      if (parsed.schemaVersion === 1) {
        this.settings = {
          schemaVersion: 1,
          model: typeof parsed.model === "string" ? parsed.model : null,
          effort: typeof parsed.effort === "string" ? parsed.effort : null,
          replyLength: REPLY_LENGTHS.includes(parsed.replyLength as ReplyLength)
            ? (parsed.replyLength as ReplyLength)
            : "default",
          probing: PROBINGS.includes(parsed.probing as Probing) ? (parsed.probing as Probing) : "default",
          ragMode: RAG_MODES.includes(parsed.ragMode as RagMode) ? (parsed.ragMode as RagMode) : "auto",
          ragRecall: RAG_RECALLS.includes(parsed.ragRecall as RagRecall) ? (parsed.ragRecall as RagRecall) : "default",
        };
        return;
      }
    } catch {
      /* missing or unreadable — fall through to materialize env-seeded defaults */
    }
    await this.persist();
  }

  get(): Settings {
    return this.settings;
  }

  /**
   * Keep the persisted selection concrete so a turn cannot silently inherit a
   * different model from the user's global Codex configuration.
   */
  async reconcileModel(models: readonly SelectableModel[]): Promise<Settings> {
    if (models.length === 0) return this.settings;
    const selected =
      (this.settings.model ? models.find((entry) => entry.model === this.settings.model) : null) ??
      models.find((entry) => entry.isDefault) ??
      models[0];
    if (!selected) return this.settings;

    const supportedEfforts = new Set(
      (selected.supportedReasoningEfforts ?? []).flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        const effort = entry.reasoningEffort ?? entry.effort;
        return effort ? [effort] : [];
      }),
    );
    const effortUnsupported = this.settings.effort !== null && !supportedEfforts.has(this.settings.effort);
    if (selected.model === this.settings.model && !effortUnsupported) return this.settings;
    return this.update({
      model: selected.model,
      ...(effortUnsupported ? { effort: null } : {}),
    });
  }

  async update(
    patch: Partial<Pick<Settings, "model" | "effort" | "replyLength" | "probing" | "ragMode" | "ragRecall">>,
  ): Promise<Settings> {
    this.settings = { ...this.settings, ...patch };
    await this.persist();
    return this.settings;
  }

  /** Wait for in-flight saves to land. Used to drain before shutdown. */
  flush(): Promise<void> {
    return this.saveChain.catch(() => {});
  }

  private persist(): Promise<void> {
    // Snapshot synchronously so a queued save can't serialize a later mutation.
    const json = JSON.stringify(this.settings, null, 2);
    this.saveChain = this.saveChain.catch(() => {}).then(() => writeFileAtomic(this.file, json));
    return this.saveChain;
  }
}
