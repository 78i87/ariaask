import path from "node:path";
import fs from "node:fs/promises";
import { writeFileAtomic } from "../lib/atomic.js";
import type { Probing, ReplyLength } from "./persona.js";

export interface Settings {
  schemaVersion: 1;
  /** Model slug for thread/turn overrides; null = account default. */
  model: string | null;
  /** Chat reasoning effort; null = the model's default effort. */
  effort: string | null;
  replyLength: ReplyLength;
  probing: Probing;
}

const REPLY_LENGTHS: ReplyLength[] = ["concise", "default", "chatty"];
const PROBINGS: Probing[] = ["gentle", "default", "relentless"];

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

  async update(patch: Partial<Pick<Settings, "model" | "effort" | "replyLength" | "probing">>): Promise<Settings> {
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
