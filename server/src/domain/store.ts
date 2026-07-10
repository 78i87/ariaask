import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../lib/atomic.js";
import type { LearningState } from "./learning.js";
import type { KnowledgeState } from "./knowledge.js";
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

export interface CoachMessage {
  id: string;
  /**
   * "user" = the human learner; "coach" = the AI learning coach. Deliberately
   * NOT teacher/student for the same reason as CyraMessage — the Aria thread
   * uses those with the human↔AI mapping inverted.
   */
  role: "user" | "coach";
  text: string;
  turnId: string | null;
  interrupted?: true;
  createdAt: string;
}

/**
 * The learning-coach conversation (see coach-session.ts): one long-lived
 * coach thread per notebook, foregrounded by the coach shell UI. The coach
 * advises on HOW to learn (technique selection, study planning) grounded in
 * the kb/ knowledge base — it is neither the Aria student nor the Cyra expert.
 */
export interface CoachState {
  /** Codex thread id; null until the first turn starts. */
  threadId: string | null;
  /** The visible streamed kickoff turn has completed with a non-empty reply. */
  kickoffDone: boolean;
  /**
   * Coaching mode baked into the current thread's instructions (mirrors
   * Notebook.appliedStyle — instructions are pinned, so a mode change starts
   * a fresh thread with a catch-up). Absent on pre-feature threads = "guided".
   */
  appliedMode?: string;
  /**
   * originalNames of sources added AFTER the coach's pinned manifest was
   * baked (uploads, discovery, link ingestion) — consumed as one hidden
   * preamble line on the next coach turn, then cleared. The coach-side
   * analogue of Aria's pendingNewSources (deliberately separate: session.ts
   * consumes and clears that one).
   */
  pendingSourceNotes?: string[];
  createdAt: string;
  updatedAt: string;
  messages: CoachMessage[];
}

export type ReadingLevel = "beginner" | "intermediate" | "experienced";

export type ReadingAnnotationKind = "pause" | "simplify" | "compare" | "connect" | "judge" | "apply" | "technique";

/**
 * One guided-reading prompt anchored to a passage. Anchoring is text-quote
 * based: `anchor` is an exact snippet from the page's extracted text, matched
 * client-side against the PDF.js text layer (robust to extraction drift).
 */
export interface ReadingAnnotation {
  id: string;
  /** 1-based page number. */
  page: number;
  /** Exact quote from the page (roughly 4–15 words) the highlight attaches to. */
  anchor: string;
  kind: ReadingAnnotationKind;
  /** The coach's prompt/instruction for this point — a question, never an answer. */
  prompt: string;
  /** The learner's jotted response, if any. */
  userResponse?: string;
  resolved?: boolean;
}

/**
 * One guided reading of a PDF source (see reading.ts). Generation is a
 * one-shot KB-grounded pass over the per-page text; `status` is "generating"
 * until annotations land.
 */
export interface ReadingSession {
  id: string;
  /** SourceFile.storedName of the PDF being read. */
  source: string;
  level: ReadingLevel;
  status: "generating" | "ready" | "failed";
  error?: string;
  annotations: ReadingAnnotation[];
  /** Post-reading suggestions ("what to do afterwards to drill it home"). */
  afterReading: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReadingSessionSummary {
  id: string;
  source: string;
  level: ReadingLevel;
  status: "generating" | "ready" | "failed";
  annotationCount: number;
  createdAt: string;
}

export function toReadingSummary(rs: ReadingSession): ReadingSessionSummary {
  return {
    id: rs.id,
    source: rs.source,
    level: rs.level,
    status: rs.status,
    annotationCount: rs.annotations.length,
    createdAt: rs.createdAt,
  };
}

/**
 * One learning-log entry — the durable record of one study block (see
 * journey.ts and kb/guides/learning-log.md: a 1-3 minute feedback tool, one
 * entry per meaningful study block, strategies never thinking moves). The
 * `topic` field is how multiple topics live inside one project: folders as a
 * view over the log, not containers.
 */
export interface LearningLogEntry {
  /**
   * "log:<coachMessageId>" for coach-drafted entries (dedupe key — confirming
   * the same in-chat card twice must not duplicate), randomUUID for manual.
   */
  id: string;
  topic: string;
  goal: string;
  strategy: string;
  resultGap: string;
  nextMove: string;
  source: "coach" | "user";
  createdAt: string;
  updatedAt?: string;
}

/**
 * One step of a study plan — one study block's worth of work (see
 * journey.ts). Tasks are sequenced by dependency; `topic` ties completed work
 * back into the learning log's topic space.
 */
export interface StudyPlanTask {
  id: string;
  title: string;
  /** What to do and with which technique/material. */
  detail: string;
  topic?: string;
  status: "pending" | "done";
  completedAt?: string;
}

/**
 * A coach-drafted (or user-built) study plan for the project's broad goal.
 * One plan per notebook; re-confirming a new ```plan block replaces it.
 */
export interface StudyPlan {
  /** "plan:<coachMessageId>" for coach-drafted (dedupe key), randomUUID for manual. */
  id: string;
  source: "coach" | "user";
  createdAt: string;
  updatedAt: string;
  tasks: StudyPlanTask[];
}

/** Lazily initialize a notebook's coach conversation (caller persists). */
export function ensureCoachState(nb: Notebook): CoachState {
  if (!nb.coach) {
    const now = new Date().toISOString();
    nb.coach = { threadId: null, kickoffDone: false, createdAt: now, updatedAt: now, messages: [] };
  }
  return nb.coach;
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
   * The user's visible knowledge map (see knowledge.ts) — what the system infers
   * the human teacher knows from teacher messages only. Kept separate from
   * learningState, which remains Aria's private student-belief inventory.
   */
  userKnowledgeState?: KnowledgeState;
  /**
   * Pre-session setup form state (see intake.ts). Absent on pre-feature
   * notebooks and when ARIA_NO_INTAKE=1 — absence means auto-kickoff as before.
   */
  intake?: Intake;
  /** "Ask Cyra" expert conversations (see cyra-session.ts). Absent = none yet. */
  cyraThreads?: CyraThread[];
  /** The learning-coach conversation. Absent = never opened in the coach shell. */
  coach?: CoachState;
  /**
   * Calibration answers gathered at project creation (coach shell). All
   * optional; woven into the coach's pinned context and kickoff so the coach
   * doesn't re-ask what's already answered.
   */
  coachIntake?: { goal?: string; current?: string; deadline?: string };
  /** Guided readings of PDF sources (see reading.ts). Absent = none yet. */
  readingSessions?: ReadingSession[];
  /** The learning log (see journey.ts). Absent = no entries yet. */
  learningLog?: LearningLogEntry[];
  /** The study plan (see journey.ts). Absent = none drafted yet. */
  studyPlan?: StudyPlan;
  /**
   * "coach" = created from the coach shell: Aria intake init is deferred until
   * the teach-back view is first opened (GET /:id), so a project that never
   * launches teach-back never generates intake questions.
   */
  createdVia?: "coach";
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
