import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../lib/atomic.js";
import type { LearningState } from "./learning.js";
import type { Intake } from "./intake.js";

export interface SourceFile {
  originalName: string;
  storedName: string;
  /** Text-extracted sibling for PDFs (e.g. "chapter-2.extracted.txt"); null if extraction failed or not a PDF. */
  extractedName: string | null;
  mimeType: string;
  size: number;
  approxWords: number | null;
  /** "research" = server-discovered online source; absent = user upload. */
  origin?: "research";
  /** Original public URL for server-discovered online sources. */
  originUrl?: string;
}

/** Collision-free, sandbox-safe file name within a notebook's sources dir. */
export function sanitizeName(original: string, used: Set<string>): string {
  const ext = path.extname(original).toLowerCase();
  const stem =
    path
      .basename(original, path.extname(original))
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "source";
  let candidate = stem + ext;
  let n = 1;
  while (used.has(candidate)) candidate = `${stem}-${n++}${ext}`;
  used.add(candidate);
  return candidate;
}

export interface ChatMessage {
  id: string;
  role: "teacher" | "student";
  text: string;
  turnId: string | null;
  interrupted?: true;
  createdAt: string;
}

export interface CyraMessage {
  id: string;
  /**
   * "user" = the human asking; "cyra" = the AI expert. Deliberately NOT
   * teacher/student — the Aria thread uses those with the human↔AI mapping
   * inverted (there the human is the teacher), so reusing them here would
   * silently flip every consumer that keys rendering off the role.
   */
  role: "user" | "cyra";
  text: string;
  turnId: string | null;
  interrupted?: true;
  createdAt: string;
}

/**
 * One "Ask Cyra" conversation: a separate codex thread where the human asks an
 * expert teacher. Fresh thread per forwarded question; follow-ups stay inside.
 */
export interface CyraThread {
  id: string;
  /** Codex thread id; null until the first turn starts. */
  threadId: string | null;
  /** Derived from the seed question; shown in the thread switcher. */
  title: string;
  /** The Aria student message the question was lifted from, if any. */
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  messages: CyraMessage[];
}

export interface CyraThreadSummary {
  id: string;
  title: string;
  sourceMessageId: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toCyraThreadSummary(ct: CyraThread): CyraThreadSummary {
  return {
    id: ct.id,
    title: ct.title,
    sourceMessageId: ct.sourceMessageId,
    messageCount: ct.messages.length,
    createdAt: ct.createdAt,
    updatedAt: ct.updatedAt,
  };
}

export interface Notebook {
  schemaVersion: 1;
  id: string;
  title: string;
  type: "topic" | "files";
  topic: string | null;
  sourceFiles: SourceFile[];
  threadId: string | null;
  /** Legacy (pre-settings); superseded by the global settings model. Kept so old files parse. */
  model: string | null;
  /**
   * Student style baked into the current thread's developerInstructions at
   * thread creation (instruction overrides cannot be changed on an existing
   * thread). Absent on pre-settings notebooks = default/default.
   */
  appliedStyle?: { replyLength: string; probing: string };
  /** storedNames added after thread creation that the student hasn't been told about yet. */
  pendingNewSources?: string[];
  /** originalNames of deleted sources the student still believes are assigned reading. */
  pendingRemovedSources?: string[];
  /**
   * The student's belief inventory (see learning.ts) — what it currently
   * knows, including prescribed misconceptions. Server-owned: injected into
   * every student turn, updated only by the evaluator pass. Absent on
   * pre-feature notebooks and when generation failed (full fallback to the
   * self-invented-misconceptions behavior).
   */
  learningState?: LearningState;
  /**
   * Pre-session setup form state (see intake.ts). Absent on pre-feature
   * notebooks and when ARIA_NO_INTAKE=1 — absence means auto-kickoff as before.
   */
  intake?: Intake;
  /** "Ask Cyra" expert conversations (see cyra-session.ts). Absent = none yet. */
  cyraThreads?: CyraThread[];
  kickoffDone: boolean;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface NotebookSummary {
  id: string;
  title: string;
  type: "topic" | "files";
  topic: string | null;
  sourceFiles: SourceFile[];
  createdAt: string;
  lastTaughtAt: string | null;
  messageCount: number;
}

export function toSummary(nb: Notebook): NotebookSummary {
  const lastMsg = nb.messages[nb.messages.length - 1];
  return {
    id: nb.id,
    title: nb.title,
    type: nb.type,
    topic: nb.topic,
    sourceFiles: nb.sourceFiles,
    createdAt: nb.createdAt,
    lastTaughtAt: lastMsg ? lastMsg.createdAt : null,
    messageCount: nb.messages.length,
  };
}

export class NotebookStore {
  private notebooks = new Map<string, Notebook>();
  /** Per-notebook promise chain so saves apply in order (no last-writer-wins loss). */
  private saveChains = new Map<string, Promise<void>>();

  constructor(private dataDir: string) {}

  get notebooksDir(): string {
    return path.join(this.dataDir, "notebooks");
  }

  notebookDir(id: string): string {
    return path.join(this.notebooksDir, id);
  }

  sourcesDir(id: string): string {
    return path.join(this.notebookDir(id), "sources");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.notebooksDir, { recursive: true });
    const entries = await fs.readdir(this.notebooksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.notebooksDir, entry.name, "notebook.json");
      try {
        const raw = await fs.readFile(file, "utf8");
        const nb = JSON.parse(raw) as Notebook;
        if (nb.schemaVersion === 1 && nb.id) this.notebooks.set(nb.id, nb);
      } catch {
        console.error(`[aria] skipping unreadable notebook at ${file}`);
      }
    }
  }

  list(): NotebookSummary[] {
    return [...this.notebooks.values()]
      .map(toSummary)
      .sort((a, b) => (b.lastTaughtAt ?? b.createdAt).localeCompare(a.lastTaughtAt ?? a.createdAt));
  }

  get(id: string): Notebook | undefined {
    return this.notebooks.get(id);
  }

  /** Create the notebook directory structure and register an empty notebook. */
  async create(fields: { title: string; type: "topic" | "files"; topic: string | null }, id: string = randomUUID()): Promise<Notebook> {
    const now = new Date().toISOString();
    const nb: Notebook = {
      schemaVersion: 1,
      id,
      title: fields.title,
      type: fields.type,
      topic: fields.topic,
      sourceFiles: [],
      threadId: null,
      model: null,
      kickoffDone: false,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    await fs.mkdir(this.sourcesDir(id), { recursive: true });
    this.notebooks.set(id, nb);
    await this.save(nb);
    return nb;
  }

  /** Pre-create the sources directory so uploads can stream straight into it. */
  async prepareDir(id: string): Promise<void> {
    await fs.mkdir(this.sourcesDir(id), { recursive: true });
  }

  async save(nb: Notebook): Promise<void> {
    nb.updatedAt = new Date().toISOString();
    // Snapshot synchronously so a queued save can't serialize a later mutation.
    const json = JSON.stringify(nb, null, 2);
    const file = path.join(this.notebookDir(nb.id), "notebook.json");
    const prev = this.saveChains.get(nb.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => writeFileAtomic(file, json));
    this.saveChains.set(nb.id, next);
    await next;
  }

  /** Wait for all in-flight saves to land. Used to drain before shutdown. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.saveChains.values()]);
  }

  async delete(id: string): Promise<void> {
    this.notebooks.delete(id);
    await fs.rm(this.notebookDir(id), { recursive: true, force: true });
  }
}
