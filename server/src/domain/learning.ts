import type { ChatMessage } from "./store.js";

/**
 * The learning state: a server-owned inventory of what the student currently
 * believes, including its prescribed misconceptions. It is the WHAT to the
 * persona's HOW — the persona never decides what the student knows.
 *
 * Two invariants this module exists to enforce:
 * - The student consults the inventory before every reply and may not display
 *   understanding beyond it (an unrestrained model knows everything and leaks it).
 * - The inventory changes only when the teacher's explanation actually
 *   justifies it, as judged by a separate strict evaluator pass — a lazy
 *   explanation must not flip a misconception to "understood".
 */

export type BeliefStatus = "unknown" | "misconception" | "partial" | "understood";

export interface Belief {
  /** Short stable slug, e.g. "entropy-disorder". */
  id: string;
  /** Concept label, a few words. */
  concept: string;
  status: BeliefStatus;
  /**
   * One sentence, addressed to the student ("You believe ..."): what they
   * currently believe — for misconceptions this IS the prescribed wrong claim.
   */
  belief: string;
  /** The teacher pushed on this without justifying a change; the student still holds it. */
  challenged?: true;
  /** One-line justification from the change that last touched this belief. */
  note?: string;
}

export interface BeliefChange {
  beliefId: string;
  concept: string;
  from: BeliefStatus;
  to: BeliefStatus;
  /** Rewritten belief text, when the evaluator supplied one. */
  belief?: string;
  /** One line: what in the teacher's message justified the change. */
  justification: string;
}

export interface LearningState {
  version: 1;
  /** Capped at MAX_BELIEFS — the whole inventory rides every student turn. */
  beliefs: Belief[];
  /** Changes from the most recent evaluator pass only; drives the "JUST NOW" realization block, cleared once delivered. */
  lastChanges: BeliefChange[];
  /** Teacher message id of the last successful evaluation — guards double-applying updates when a failed turn/start is retried. */
  lastEvaluatedMessageId: string | null;
  updatedAt: string;
}

const MAX_BELIEFS = 12;
const MAX_TEXT = 300;
const MAX_NEW_BELIEFS_PER_TURN = 2;

const STATUSES: ReadonlySet<string> = new Set(["unknown", "misconception", "partial", "understood"]);

// ---------- prompts ----------

const STATE_SCHEMA = `{"beliefs": [{"id": "short-kebab-slug", "concept": "concept label, a few words", "status": "unknown" | "misconception" | "partial" | "understood", "belief": "one sentence addressed to the student as 'you': what they currently believe, or for unknown entries what they have no grasp of"}]}`;

const MISCONCEPTION_QUALITY = `A good misconception is plausible enough that a smart
person could believe it; actually common among real beginners; falsifiable by a good
explanation; and one that, when corrected, exposes a deep principle of the subject. Avoid
silly errors, trivia slips, and strawmen.`;

/** Initial inventory for a topic notebook (no assigned reading). */
export function buildInitialStatePromptTopic(topic: string): string {
  return `You are designing the starting knowledge of a simulated student for a teaching session
where a human teaches the student. You are a course designer, not the student. Output JSON
only — no prose, no code fences.

Topic: ${topic}

Design the student's starting belief inventory:
- 5 to 8 entries covering the key concepts a session on this topic would visit.
- Most entries: status "unknown" — no real grasp yet; the "belief" sentence states what
  they don't know ("You have no idea what X actually is.").
- 1 or 2 entries: status "partial" — true facts a curious newcomer picks up from a podcast
  or a pop-science article, put in plain words.
- Exactly 2 to 4 entries: status "misconception", whose "belief" is the explicit wrong
  claim the student holds. ${MISCONCEPTION_QUALITY}
- No entry may have status "understood".

Output exactly this JSON shape:
${STATE_SCHEMA}`;
}

/** Initial inventory grounded in assigned reading; runs with cwd = the notebook's sources dir. */
export function buildInitialStatePromptSources(manifest: string, topic: string | null): string {
  return `You are designing the starting knowledge of a simulated student for a teaching session
where a human teaches the student${topic ? ` about: ${topic}` : ""}. You are a course designer, not the
student. First read the assigned material — the files in your working directory:

${manifest}

Where a .txt sits alongside a PDF of the same name, read the .txt. If a file will not open
or is empty, work with what you can read.

Then design the student's starting belief inventory: a partial and slightly wrong
understanding from one honest novice read of this material. Output JSON only — no prose,
no code fences.

- 5 to 8 entries covering the key ideas of the material.
- Most entries: status "unknown" or "partial" — things the student didn't absorb, or
  absorbed correctly but shallowly (true, put in plain words).
- Exactly 2 to 4 entries: status "misconception" — plausible misreadings of THIS material:
  overgeneralizing one of its claims, fusing two ideas it keeps adjacent, taking an example
  as the general rule, or missing a stated condition. Anchor each to something the reading
  actually says. ${MISCONCEPTION_QUALITY}
- No entry may have status "understood".

Output exactly this JSON shape:
${STATE_SCHEMA}`;
}

/** Reconstruct an inventory for a pre-feature notebook from its transcript. */
export function buildBootstrapPrompt(messages: ChatMessage[], contextDescription: string): string {
  const transcript = messages
    .slice(-30)
    .map((m) => `${m.role === "teacher" ? "Teacher" : "Student"}: ${m.text}`)
    .join("\n\n");
  return `You are reconstructing the belief state of a simulated student midway through a teaching
session where a human teaches the student. You are an analyst, not the student. Output
JSON only — no prose, no code fences.

${contextDescription}

The transcript so far:

${transcript}

Build the student's CURRENT belief inventory (5 to 8 entries):
- Concepts the teacher explained well and the student visibly absorbed: "understood".
- Concepts touched on but only partly landed: "partial".
- Wrong beliefs the student has voiced that the teacher has NOT yet corrected: keep them,
  status "misconception", with the wrong claim as the belief.
- Key concepts of the subject not yet covered: "unknown". If the student has voiced no
  uncorrected misconceptions, add 1 or 2 plausible new ones consistent with everything the
  student has said so far. ${MISCONCEPTION_QUALITY}

Output exactly this JSON shape:
${STATE_SCHEMA}`;
}

/**
 * The strict gate: decides which beliefs the teacher's newest message
 * justifies changing. Biased toward changing nothing.
 */
export function buildEvaluatorPrompt(state: LearningState, teacherMessage: string, recentMessages: ChatMessage[]): string {
  const inventory = JSON.stringify(
    state.beliefs.map(({ id, concept, status, belief, challenged }) => ({
      id,
      concept,
      status,
      belief,
      ...(challenged ? { challenged } : {}),
    })),
    null,
    1,
  );
  const context =
    recentMessages.length > 0
      ? recentMessages
          .slice(-6)
          .map((m) => `${m.role === "teacher" ? "Teacher" : "Student"}: ${m.text}`)
          .join("\n\n")
      : "(start of session)";
  return `You are strictly grading one teaching move in a tutoring session where a human teaches a
simulated student. You are a grader, not the student. Output JSON only — no prose, no code
fences.

The student's current belief inventory:

${inventory}

Recent conversation, for context:

${context}

The teacher's newest message:

"""
${teacherMessage}
"""

Decide which beliefs this one message JUSTIFIES changing. Be strict:
- A "misconception" becomes "understood" ONLY if the message directly addresses that
  specific wrong belief with a substantive, correct explanation — a mechanism or reason the
  student could rebuild in their own words. A bare assertion ("no, that's wrong",
  "actually it's Y"), vagueness, or "just trust me" justifies NOTHING: list that belief's
  id under "challenged" instead and leave its status alone.
- A partial or incomplete explanation moves a belief at most to "partial".
- "unknown" to "partial" or "understood" clears the same bar: the message must actually
  teach the concept, not merely mention or name it.
- If the teacher convincingly teaches something that is actually false, the student would
  believe it: rewrite the belief text to the new wrong claim but set status
  "misconception".
- Never change a belief the message does not address.
- You may add at most ${MAX_NEW_BELIEFS_PER_TURN} entries under "newBeliefs" for genuinely new concepts the
  teacher introduced AND actually explained.
- An empty "changes" list is the common, correct outcome — greetings, questions, chit-chat
  and weak explanations change nothing.

Output exactly this JSON shape (omit or leave empty what doesn't apply):
{"changes": [{"beliefId": "existing-id", "to": "unknown" | "misconception" | "partial" | "understood", "belief": "rewritten one-sentence belief, optional", "justification": "one line: what in the message justified this"}], "challenged": ["existing-id"], "newBeliefs": [{"id": "new-kebab-slug", "concept": "...", "status": "partial", "belief": "..."}]}`;
}

// ---------- rendering ----------

/** One compact line per belief — used in the per-turn block and the kickoff prompt. */
export function renderBeliefLines(state: LearningState): string {
  return state.beliefs
    .map((b) => `- ${b.concept} [${b.status}${b.challenged ? ", challenged but unconvinced" : ""}]: ${b.belief}`)
    .join("\n");
}

function renderChangeLine(c: BeliefChange): string {
  const verb =
    c.from === "misconception"
      ? "you just realized you had this wrong"
      : c.to === "understood"
        ? "this just clicked for you"
        : "you just made progress on this";
  return `- ${c.concept} — ${verb}: ${c.justification}`;
}

/**
 * The hidden block prepended to every student turn. Self-instructing on
 * purpose: it must also work on threads whose pinned persona predates the
 * belief contract.
 */
export function buildBeliefBlock(state: LearningState, opts: { includeChanges: boolean }): string {
  let block = `[BELIEF STATE — the teacher never sees this block. This inventory is the complete extent
of your understanding of the subject. Never display knowledge, vocabulary, or certainty
beyond it. Entries marked "misconception" are things you genuinely believe — reason from
them with confidence. Entries marked "challenged but unconvinced" are beliefs the teacher
has pushed on without convincing you: you still hold them.

${renderBeliefLines(state)}
`;
  if (opts.includeChanges && state.lastChanges.length > 0) {
    block += `
JUST NOW — the teacher's latest message genuinely changed your mind about the following
(the inventory above already reflects it). React to it in your reply as your own
realization, in your own words:

${state.lastChanges.map(renderChangeLine).join("\n")}
`;
  }
  block += `
The teacher's message follows.]

`;
  return block;
}

// ---------- parsing (defensive: any failure returns null, caller keeps prior state) ----------

function clip(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + "…" : s;
}

function slugify(s: string, used: Set<string>): string {
  const base =
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "belief";
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/** Tolerates code fences and surrounding prose: parses the first {...last} span. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseBelief(v: unknown, used: Set<string>): Belief | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.concept !== "string" || !o.concept.trim()) return null;
  if (typeof o.belief !== "string" || !o.belief.trim()) return null;
  if (typeof o.status !== "string" || !STATUSES.has(o.status)) return null;
  const id = typeof o.id === "string" && o.id.trim() ? slugify(o.id, used) : slugify(o.concept, used);
  return {
    id,
    concept: clip(o.concept.trim()),
    status: o.status as BeliefStatus,
    belief: clip(o.belief.trim()),
  };
}

/** Parse a generated initial (or bootstrapped) inventory. */
export function parseInitialState(raw: string): LearningState | null {
  const obj = extractJsonObject(raw);
  if (!obj || !Array.isArray(obj.beliefs)) return null;
  const used = new Set<string>();
  const beliefs: Belief[] = [];
  for (const item of obj.beliefs.slice(0, MAX_BELIEFS)) {
    const b = parseBelief(item, used);
    if (b) beliefs.push(b);
  }
  // A state without misconceptions defeats the feature's purpose — treat it
  // as a failed generation rather than running with it.
  if (beliefs.length < 3 || !beliefs.some((b) => b.status === "misconception")) return null;
  return {
    version: 1,
    beliefs,
    lastChanges: [],
    lastEvaluatedMessageId: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Apply an evaluator response to the previous state. The evaluator emits
 * changes only; this is where they're validated (existing ids, legal
 * statuses) and applied — it can never silently rewrite the whole inventory.
 */
export function applyEvaluatorOutput(raw: string, prev: LearningState): LearningState | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;

  const beliefs = prev.beliefs.map((b) => ({ ...b }));
  const byId = new Map(beliefs.map((b) => [b.id, b]));
  const changes: BeliefChange[] = [];

  for (const c of Array.isArray(obj.changes) ? obj.changes : []) {
    if (typeof c !== "object" || c === null) continue;
    const o = c as Record<string, unknown>;
    const b = typeof o.beliefId === "string" ? byId.get(o.beliefId) : undefined;
    if (!b) continue;
    if (typeof o.to !== "string" || !STATUSES.has(o.to)) continue;
    const to = o.to as BeliefStatus;
    const newText = typeof o.belief === "string" && o.belief.trim() ? clip(o.belief.trim()) : undefined;
    if (to === b.status && (!newText || newText === b.belief)) continue;
    const justification = clip(typeof o.justification === "string" && o.justification.trim() ? o.justification.trim() : "the teacher's explanation");
    changes.push({ beliefId: b.id, concept: b.concept, from: b.status, to, belief: newText, justification });
    b.status = to;
    if (newText) b.belief = newText;
    b.note = justification;
    if (to !== "misconception") delete b.challenged;
  }

  for (const id of Array.isArray(obj.challenged) ? obj.challenged : []) {
    const b = typeof id === "string" ? byId.get(id) : undefined;
    if (b && b.status === "misconception") b.challenged = true;
  }

  const used = new Set(beliefs.map((b) => b.id));
  for (const item of (Array.isArray(obj.newBeliefs) ? obj.newBeliefs : []).slice(0, MAX_NEW_BELIEFS_PER_TURN)) {
    if (beliefs.length >= MAX_BELIEFS) break;
    const b = parseBelief(item, used);
    if (!b) continue;
    beliefs.push(b);
    changes.push({
      beliefId: b.id,
      concept: b.concept,
      from: "unknown",
      to: b.status,
      belief: b.belief,
      justification: "the teacher just introduced this",
    });
  }

  return {
    version: 1,
    beliefs,
    lastChanges: changes,
    lastEvaluatedMessageId: prev.lastEvaluatedMessageId,
    updatedAt: new Date().toISOString(),
  };
}
