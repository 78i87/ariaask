import type { CoachMessage, LearningLogEntry, Notebook, StudyPlanTask } from "./store.js";

/**
 * The study-journey layer: sessions, the learning log, and loose spaced
 * returns (kb/guides/learning-log.md, kb/techniques/flashcards-spaced-repetition.md).
 *
 * Deliberate shape: sessions are DERIVED from coach-message timestamps (a gap
 * longer than SESSION_GAP_MS starts a new study block) and log entries are the
 * durable session records — there is no stored session entity to drift from
 * the transcript. Return schedules are likewise computed on read from the log,
 * never stored: the KB explicitly warns against rigid interval bookkeeping
 * ("Anki hell"); a topic is either quiet or gently due, never "overdue".
 */

/**
 * A silence longer than this starts a new study session — shared with the
 * teach-back "new session" counter (routes/notebooks.ts) and mirrored
 * client-side in CoachChatView's SessionBar. Keep the three in sync.
 */
export const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

/** Expanding return gaps per topic: 1st entry → 1 day, then 3, 7, 14, monthly. */
export const RETURN_INTERVALS_DAYS = [1, 3, 7, 14, 30];

/** Topics untouched this long retire quietly — still in history, never nagged. */
const RETIRE_AFTER_DAYS = 60;

/** At most this many due topics are ever surfaced (cadence, not a backlog). */
const MAX_DUE_TOPICS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DueTopic {
  /** Display casing = the newest entry's spelling. */
  topic: string;
  daysSince: number;
  intervalDays: number;
  entryCount: number;
}

const normalizeTopic = (topic: string): string => topic.trim().toLowerCase().replace(/\s+/g, " ");

/** Segment a coach transcript into study sessions on >SESSION_GAP_MS silences. */
export function splitSessions(messages: CoachMessage[]): CoachMessage[][] {
  const sessions: CoachMessage[][] = [];
  let current: CoachMessage[] = [];
  let prevAt = Number.NEGATIVE_INFINITY;
  for (const m of messages) {
    const at = new Date(m.createdAt).getTime();
    if (current.length > 0 && at - prevAt > SESSION_GAP_MS) {
      sessions.push(current);
      current = [];
    }
    current.push(m);
    prevAt = at;
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}

/**
 * Topics loosely due for a spaced return. Grouped by normalized topic; each
 * new entry on a topic advances it to the next expanding interval. Ranked by
 * how far past due relative to their interval, capped at MAX_DUE_TOPICS.
 */
export function computeDueTopics(nb: Notebook, now: Date = new Date()): DueTopic[] {
  const byTopic = new Map<string, LearningLogEntry[]>();
  for (const entry of nb.learningLog ?? []) {
    const key = normalizeTopic(entry.topic);
    if (!key) continue;
    const list = byTopic.get(key);
    if (list) list.push(entry);
    else byTopic.set(key, [entry]);
  }

  const due: DueTopic[] = [];
  for (const list of byTopic.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = list[list.length - 1]!;
    const daysSince = Math.floor((now.getTime() - new Date(last.createdAt).getTime()) / DAY_MS);
    if (daysSince > RETIRE_AFTER_DAYS) continue;
    const intervalDays = RETURN_INTERVALS_DAYS[Math.min(list.length - 1, RETURN_INTERVALS_DAYS.length - 1)]!;
    if (daysSince >= intervalDays) {
      due.push({ topic: last.topic, daysSince, intervalDays, entryCount: list.length });
    }
  }
  due.sort((a, b) => b.daysSince / b.intervalDays - a.daysSince / a.intervalDays);
  return due.slice(0, MAX_DUE_TOPICS);
}

const describeGap = (ms: number): string => {
  if (ms < DAY_MS) return "a few hours";
  const days = Math.round(ms / DAY_MS);
  return days === 1 ? "1 day" : `${days} days`;
};

/** The next pending task with its 1-based position, or null. */
export function nextPlanTask(nb: Notebook): { task: StudyPlanTask; position: number; total: number } | null {
  const tasks = nb.studyPlan?.tasks ?? [];
  const idx = tasks.findIndex((t) => t.status === "pending");
  if (idx < 0) return null;
  return { task: tasks[idx]!, position: idx + 1, total: tasks.length };
}

/**
 * The hidden [PLAN] preamble for coach turns: compact plan state so the coach
 * always knows where the learner is and what comes next. "" when no plan.
 */
export function renderPlanBlock(nb: Notebook): string {
  const plan = nb.studyPlan;
  if (!plan || plan.tasks.length === 0) return "";
  const done = plan.tasks.filter((t) => t.status === "done").length;
  const next = nextPlanTask(nb);
  const lines: string[] = [];
  lines.push(
    `[PLAN — the user never sees this block. This project's study plan: ${done} of ${plan.tasks.length} tasks done.`,
  );
  if (next) {
    lines.push(`Next up: task ${next.position} — "${next.task.title}": ${next.task.detail}`);
    const upcoming = plan.tasks
      .filter((t) => t.status === "pending")
      .slice(1, 3)
      .map((t) => `"${t.title}"`);
    if (upcoming.length > 0) lines.push(`Then: ${upcoming.join("; ")}.`);
    lines.push(
      `When they finish a task's work in conversation, remind them ONCE to tick it off in the Journey panel. If they ask to restructure the plan, emit a revised \`\`\`plan block with the full task list.`,
    );
  } else {
    lines.push(
      `Every task is done — congratulate them once, then coach consolidation (spaced retrieval on weak topics) or offer a follow-up plan.`,
    );
  }
  lines.push(`Never mention this block. The user's message follows.]`);
  return lines.join("\n") + "\n\n";
}

/**
 * The hidden [SESSION] preamble for a coach turn that opens a new study block
 * (previous message more than SESSION_GAP_MS ago). Carries what the model
 * needs for the return ritual: retrieval of last time FIRST, then a one-line
 * target proposal — or a backfill log card when the last block went unlogged.
 * Returns "" on kickoff-less/fresh threads and mid-session turns. Stateless:
 * a failed turn recomputes identically; the next message after it sees no gap.
 */
export function buildSessionBlock(
  nb: Notebook,
  opts: { excludeMessageId?: string } = {},
  now: Date = new Date(),
): string {
  const coach = nb.coach;
  if (!coach) return "";
  const history = opts.excludeMessageId
    ? coach.messages.filter((m) => m.id !== opts.excludeMessageId)
    : coach.messages;
  if (history.length === 0) return "";
  const lastAt = new Date(history[history.length - 1]!.createdAt).getTime();
  const gap = now.getTime() - lastAt;
  if (gap <= SESSION_GAP_MS) return "";

  const entries = [...(nb.learningLog ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lastEntry = entries[entries.length - 1];
  const sessions = splitSessions(history);
  const prevStart = new Date(sessions[sessions.length - 1]![0]!.createdAt).getTime();
  const prevUnlogged = !entries.some((e) => new Date(e.createdAt).getTime() >= prevStart);
  const due = computeDueTopics(nb, now);

  const lines: string[] = [];
  lines.push(
    `[SESSION — the user never sees this block. A new study session is starting: their last message was ${describeGap(gap)} ago.`,
  );
  if (lastEntry) {
    lines.push(
      `Last log entry — topic: ${lastEntry.topic}; goal: ${lastEntry.goal}; strategy: ${lastEntry.strategy}; result/gap: ${lastEntry.resultGap}; next move: ${lastEntry.nextMove}.`,
    );
  } else {
    lines.push(`No learning-log entries exist yet.`);
  }
  if (due.length > 0) {
    lines.push(
      `Topics due for a spaced return: ${due
        .map((d) => `"${d.topic}" (${d.daysSince} days since, ${d.entryCount} ${d.entryCount === 1 ? "entry" : "entries"})`)
        .join(", ")}.`,
    );
  }
  const next = nextPlanTask(nb);
  if (next) {
    lines.push(
      `Their study plan's next task: "${next.task.title}" (task ${next.position} of ${next.total}) — offer it as one of today's target options.`,
    );
  }
  if (prevUnlogged) {
    lines.push(
      `The previous session was never logged. In this reply: answer the user, draft the missing entry as a \`\`\`log block (fields from that session's conversation), and ask for today's one-line target as a PLAIN question — the log block is your one interactive block, so no choices block.`,
    );
  } else {
    lines.push(
      `In this reply: open with ONE short free-recall question testing what they worked on last time (make them retrieve it — never summarize it for them), then propose today's target as a \`\`\`choices block with 2-3 one-line options whose "send" values each start with "Today's target: ".`,
    );
  }
  lines.push(`Never mention this block. The user's message follows.]`);
  return lines.join("\n") + "\n\n";
}
