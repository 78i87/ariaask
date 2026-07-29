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
  /** Interview projects: candidate CV or job-description material. */
  kind?: "cv" | "jd";
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
   * Sources changed AFTER the coach's pinned manifest was baked — consumed
   * as one hidden preamble on the next coach turn, then cleared. Legacy
   * strings are additions from schema-v1 and remain readable.
   */
  pendingSourceNotes?: Array<string | CoachSourceNotice>;
  createdAt: string;
  updatedAt: string;
  messages: CoachMessage[];
}

export interface CoachSourceNotice {
  kind: "added" | "removed";
  name: string;
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
  /**
   * 1-2 chained follow-up questions applying DIFFERENT deep-processing moves
   * to the same passage (the loop runs as a whole on each key piece).
   */
  followUps?: string[];
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
  /** SourceFile.storedName of the document being read. */
  source: string;
  level: ReadingLevel;
  status: "generating" | "ready" | "failed";
  error?: string;
  /** Absent = "pdf" (legacy sessions predate prose reading). */
  docType?: "pdf" | "prose";
  /**
   * Prose only: the deterministic pseudo-page split, fixed at creation. The
   * client renders exactly these pages (so anchors can never drift), and the
   * reading keeps working even if the source file is later deleted.
   */
  textPages?: string[];
  /** "Before you read" priming questions (kb: priming-pre-study). */
  priming?: string[];
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

/** Lazily initialize a coach activity's conversation (caller persists). */
export function ensureCoachState(nb: Notebook): CoachState {
  if (!nb.coach) {
    const now = new Date().toISOString();
    nb.coach = { threadId: null, kickoffDone: false, createdAt: now, updatedAt: now, messages: [] };
  }
  return nb.coach;
}

/** Interview-activity identity collected when the activity is added. */
export interface InterviewSetup {
  role: string;
  company: string | null;
}

export type ActivityKind = "coach" | "reverse-tutor" | "interview";

interface ActivityBase {
  id: string;
  kind: ActivityKind;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface MainActivityState {
  threadId: string | null;
  model: string | null;
  appliedStyle?: { replyLength: string; probing: string };
  pendingNewSources?: string[];
  pendingRemovedSources?: string[];
  learningState?: LearningState;
  intake?: Intake;
  cyraThreads?: CyraThread[];
  kickoffDone: boolean;
  messages: ChatMessage[];
}

export interface CoachActivity extends ActivityBase {
  kind: "coach";
  state: CoachState;
}

export interface ReverseTutorActivity extends ActivityBase, MainActivityState {
  kind: "reverse-tutor";
}

export interface InterviewActivity extends ActivityBase, MainActivityState {
  kind: "interview";
  interview: InterviewSetup;
  /** Shared project source selected as the candidate CV. */
  cvSource: string | null;
  /** Optional shared project source selected as the job description. */
  jobDescriptionSource: string | null;
  /** Interview coverage is activity-local, unlike the shared learner map. */
  coverageState?: KnowledgeState;
}

export type NotebookActivity = CoachActivity | ReverseTutorActivity | InterviewActivity;

export interface ActivitySummary {
  id: string;
  kind: ActivityKind;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  setupComplete: boolean;
  interview?: InterviewSetup;
}

export function toActivitySummary(activity: NotebookActivity): ActivitySummary {
  const state = activity.kind === "coach" ? activity.state : activity;
  return {
    id: activity.id,
    kind: activity.kind,
    title: activity.title,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt,
    messageCount: state.messages.length,
    setupComplete: activity.kind !== "interview" || activity.cvSource !== null,
    ...(activity.kind === "interview" ? { interview: activity.interview } : {}),
  };
}

export interface Notebook {
  schemaVersion: 2;
  id: string;
  title: string;
  /** Immutable prompt context seeded from the creation field. */
  goal: string;
  sourceFiles: SourceFile[];
  activities: NotebookActivity[];
  /** Shared learner knowledge inferred across every reverse-tutor activity. */
  userKnowledgeState?: KnowledgeState;
  /** A timestamp hides this project from the active section without deleting it. */
  archivedAt?: string | null;
  /** Guided readings remain project-level and source-derived. */
  readingSessions?: ReadingSession[];
  /** Durable project-level learning memory shared by coach activities. */
  learningLog?: LearningLogEntry[];
  studyPlan?: StudyPlan;
  createdAt: string;
  updatedAt: string;

  /*
   * Activity-session facade fields. Raw schema-v2 project records do not
   * serialize these at the root. NotebookStore.getSession() exposes a proxy
   * that maps them to one concrete activity so the mature session engines can
   * stay focused on turn behavior while activities become first-class.
   */
  type: "topic" | "interview";
  topic: string | null;
  threadId: string | null;
  model: string | null;
  appliedStyle?: { replyLength: string; probing: string };
  pendingNewSources?: string[];
  pendingRemovedSources?: string[];
  learningState?: LearningState;
  intake?: Intake;
  cyraThreads?: CyraThread[];
  interview?: InterviewSetup;
  coach?: CoachState;
  coachIntake?: { goal?: string; current?: string; deadline?: string };
  kickoffDone: boolean;
  messages: ChatMessage[];
}

export interface NotebookSummary {
  id: string;
  title: string;
  goal: string;
  sourceFiles: SourceFile[];
  activities: ActivitySummary[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function isInterview(nb: Pick<Notebook, "type">): boolean {
  return nb.type === "interview";
}

export function toSummary(nb: Notebook): NotebookSummary {
  return {
    id: nb.id,
    title: nb.title,
    goal: nb.goal,
    sourceFiles: nb.sourceFiles,
    activities: nb.activities.map(toActivitySummary),
    createdAt: nb.createdAt,
    updatedAt: nb.updatedAt,
    archivedAt: nb.archivedAt ?? null,
  };
}

export class NotebookStore {
  private notebooks = new Map<string, Notebook>();
  /** Per-notebook promise chain so saves apply in order (no last-writer-wins loss). */
  private saveChains = new Map<string, Promise<void>>();
  /** Session proxies resolve back to their raw project for persistence. */
  private sessionRoots = new WeakMap<object, Notebook>();
  private sessionKeys = new WeakMap<object, string>();

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
        const parsed = JSON.parse(raw) as { schemaVersion?: number; id?: string; activities?: unknown };
        if (parsed.schemaVersion === 2 && parsed.id && Array.isArray(parsed.activities)) {
          const nb = parsed as unknown as Notebook;
          this.notebooks.set(nb.id, nb);
        } else if (parsed.schemaVersion === 1) {
          console.error(`[aria] skipping legacy project at ${file}; schema-v1 migration is intentionally unsupported`);
        }
      } catch {
        console.error(`[aria] skipping unreadable notebook at ${file}`);
      }
    }
  }

  list(): NotebookSummary[] {
    return [...this.notebooks.values()]
      .map(toSummary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Notebook | undefined {
    return this.notebooks.get(id);
  }

  /** Create the project directory structure and register a neutral project. */
  async create(fields: { title: string; goal: string }, id: string = randomUUID()): Promise<Notebook> {
    const now = new Date().toISOString();
    const nb = {
      schemaVersion: 2,
      id,
      title: fields.title,
      goal: fields.goal,
      sourceFiles: [],
      activities: [],
      createdAt: now,
      updatedAt: now,
    } as unknown as Notebook;
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
    const root = this.sessionRoots.get(nb) ?? nb;
    root.updatedAt = new Date().toISOString();
    // Snapshot synchronously so a queued save can't serialize a later mutation.
    const json = JSON.stringify(root, null, 2);
    const file = path.join(this.notebookDir(root.id), "notebook.json");
    const prev = this.saveChains.get(root.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => writeFileAtomic(file, json));
    this.saveChains.set(root.id, next);
    await next;
  }

  getActivity(projectId: string, activityId: string): NotebookActivity | undefined {
    return this.notebooks.get(projectId)?.activities.find((activity) => activity.id === activityId);
  }

  activityKey(projectId: string, activityId: string): string {
    return `${projectId}:${activityId}`;
  }

  parseActivityKey(key: string): { projectId: string; activityId: string } | null {
    const split = key.indexOf(":");
    if (split < 1) return null;
    return { projectId: key.slice(0, split), activityId: key.slice(split + 1) };
  }

  /**
   * Return an activity-scoped facade for the existing turn engines. Direct
   * project ids still resolve to the raw project for project SSE/discovery.
   */
  getSession(key: string): Notebook | undefined {
    const parsed = this.parseActivityKey(key);
    if (!parsed) return this.notebooks.get(key);
    const root = this.notebooks.get(parsed.projectId);
    const activity = root?.activities.find((candidate) => candidate.id === parsed.activityId);
    if (!root || !activity) return undefined;

    const main = activity.kind === "coach" ? null : activity;
    const proxy = new Proxy(root, {
      get: (target, property, receiver) => {
        if (property === "type") return activity.kind === "interview" ? "interview" : "topic";
        if (property === "topic") return target.goal;
        if (property === "coach") return activity.kind === "coach" ? activity.state : undefined;
        if (property === "coachIntake") return activity.kind === "coach" ? { goal: target.goal } : undefined;
        if (property === "interview") return activity.kind === "interview" ? activity.interview : undefined;
        if (property === "userKnowledgeState") {
          return activity.kind === "interview" ? activity.coverageState : target.userKnowledgeState;
        }
        if (property === "sourceFiles" && activity.kind === "interview") {
          return target.sourceFiles.map((source) => ({
            ...source,
            ...(source.storedName === activity.cvSource ? { kind: "cv" as const } : {}),
            ...(source.storedName === activity.jobDescriptionSource ? { kind: "jd" as const } : {}),
          }));
        }
        if (
          main &&
          [
            "threadId",
            "model",
            "appliedStyle",
            "pendingNewSources",
            "pendingRemovedSources",
            "learningState",
            "intake",
            "cyraThreads",
            "kickoffDone",
            "messages",
          ].includes(String(property))
        ) {
          return Reflect.get(main, property);
        }
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, value, receiver) => {
        if (property === "userKnowledgeState") {
          if (activity.kind === "interview") activity.coverageState = value as KnowledgeState | undefined;
          else target.userKnowledgeState = value as KnowledgeState | undefined;
          activity.updatedAt = new Date().toISOString();
          return true;
        }
        if (property === "coach" && activity.kind === "coach") {
          activity.state = value as CoachState;
          activity.updatedAt = new Date().toISOString();
          return true;
        }
        if (
          main &&
          [
            "threadId",
            "model",
            "appliedStyle",
            "pendingNewSources",
            "pendingRemovedSources",
            "learningState",
            "intake",
            "cyraThreads",
            "kickoffDone",
            "messages",
          ].includes(String(property))
        ) {
          Reflect.set(main, property, value);
          activity.updatedAt = new Date().toISOString();
          return true;
        }
        return Reflect.set(target, property, value, receiver);
      },
      deleteProperty: (target, property) => {
        if (property === "userKnowledgeState") {
          if (activity.kind === "interview") delete activity.coverageState;
          else delete target.userKnowledgeState;
          return true;
        }
        if (property === "coach" && activity.kind === "coach") return false;
        if (
          main &&
          [
            "appliedStyle",
            "pendingNewSources",
            "pendingRemovedSources",
            "learningState",
            "intake",
            "cyraThreads",
          ].includes(String(property))
        ) {
          return Reflect.deleteProperty(main, property);
        }
        return Reflect.deleteProperty(target, property);
      },
    });
    this.sessionRoots.set(proxy, root);
    this.sessionKeys.set(proxy, key);
    return proxy;
  }

  sessionKey(nb: Notebook): string {
    return this.sessionKeys.get(nb) ?? nb.id;
  }

  async createActivity(
    projectId: string,
    input:
      | { kind: "coach" | "reverse-tutor"; title?: string }
      | {
          kind: "interview";
          title?: string;
          interview: InterviewSetup;
          cvSource: string;
          jobDescriptionSource?: string | null;
        },
  ): Promise<NotebookActivity> {
    const project = this.notebooks.get(projectId);
    if (!project) throw new Error("notebook_not_found");
    const now = new Date().toISOString();
    const interviewInput = input.kind === "interview" ? input : null;
    const label =
      input.kind === "coach"
        ? "Learning coach"
        : input.kind === "reverse-tutor"
          ? "Reverse tutor"
          : interviewInput!.interview.company
            ? `${interviewInput!.interview.role} — ${interviewInput!.interview.company}`
            : interviewInput!.interview.role;
    const requested = input.title?.trim() || label;
    const used = new Set(project.activities.map((activity) => activity.title.toLocaleLowerCase()));
    let title = requested;
    let suffix = 2;
    while (used.has(title.toLocaleLowerCase())) title = `${requested} ${suffix++}`;

    const base = { id: randomUUID(), title, createdAt: now, updatedAt: now };
    const activity: NotebookActivity =
      input.kind === "coach"
        ? {
            ...base,
            kind: "coach",
            state: { threadId: null, kickoffDone: false, createdAt: now, updatedAt: now, messages: [] },
          }
        : input.kind === "reverse-tutor"
          ? {
              ...base,
              kind: "reverse-tutor",
              threadId: null,
              model: null,
              kickoffDone: false,
              messages: [],
            }
          : {
              ...base,
              kind: "interview",
              interview: interviewInput!.interview,
              cvSource: interviewInput!.cvSource,
              jobDescriptionSource: interviewInput!.jobDescriptionSource ?? null,
              threadId: null,
              model: null,
              kickoffDone: false,
              messages: [],
            };
    project.activities.push(activity);
    await this.save(project);
    return activity;
  }

  async renameActivity(projectId: string, activityId: string, title: string): Promise<NotebookActivity | undefined> {
    const project = this.notebooks.get(projectId);
    const activity = project?.activities.find((candidate) => candidate.id === activityId);
    if (!project || !activity) return undefined;
    activity.title = title;
    activity.updatedAt = new Date().toISOString();
    await this.save(project);
    return activity;
  }

  queueSourceAdditions(project: Notebook, files: SourceFile[]): void {
    for (const activity of project.activities) {
      if (activity.kind === "coach") {
        if (activity.state.kickoffDone) {
          activity.state.pendingSourceNotes = [
            ...(activity.state.pendingSourceNotes ?? []),
            ...files.map((file) => ({ kind: "added" as const, name: file.originalName })),
          ].slice(-10);
        }
      } else if (activity.kickoffDone || activity.threadId) {
        activity.pendingNewSources = [
          ...(activity.pendingNewSources ?? []),
          ...files.map((file) => file.storedName),
        ];
      }
    }
  }

  queueSourceRemoval(project: Notebook, file: SourceFile): void {
    for (const activity of project.activities) {
      if (activity.kind === "coach") {
        if (activity.state.kickoffDone) {
          activity.state.pendingSourceNotes = [
            ...(activity.state.pendingSourceNotes ?? []),
            { kind: "removed" as const, name: file.originalName },
          ].slice(-10);
        }
        continue;
      }
      const neverAnnounced = (activity.pendingNewSources ?? []).includes(file.storedName);
      if (activity.pendingNewSources?.length) {
        activity.pendingNewSources = activity.pendingNewSources.filter((name) => name !== file.storedName);
      }
      if (!neverAnnounced && (activity.kickoffDone || activity.threadId)) {
        activity.pendingRemovedSources = [...(activity.pendingRemovedSources ?? []), file.originalName];
      }
      if (activity.kind === "interview") {
        if (activity.cvSource === file.storedName) activity.cvSource = null;
        if (activity.jobDescriptionSource === file.storedName) activity.jobDescriptionSource = null;
      }
    }
  }

  async deleteActivity(projectId: string, activityId: string): Promise<NotebookActivity | undefined> {
    const project = this.notebooks.get(projectId);
    if (!project) return undefined;
    const index = project.activities.findIndex((candidate) => candidate.id === activityId);
    if (index < 0) return undefined;
    const [activity] = project.activities.splice(index, 1);
    await this.save(project);
    return activity;
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
