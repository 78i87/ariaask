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
  /** Cluster label for the knowledge map, e.g. "Kinetics". Absent on pre-feature beliefs. */
  area?: string;
  /** Ids of prerequisite beliefs in this inventory — the knowledge map's edges. */
  deps?: string[];
  /** When the evaluator last touched this belief; recency signal for working-set selection. */
  touchedAt?: string;
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
  /**
   * Capped at MAX_BELIEFS. Inventories within WORKING_SET_CAP ride every
   * student turn in full; larger ones ride as a two-tier block — a relevant
   * working set in full detail plus a name-only roll-up of the rest.
   */
  beliefs: Belief[];
  /** Changes from the most recent evaluator pass only; drives the "JUST NOW" realization block, cleared once delivered. */
  lastChanges: BeliefChange[];
  /** Teacher message id of the last successful evaluation — guards double-applying updates when a failed turn/start is retried. */
  lastEvaluatedMessageId: string | null;
  updatedAt: string;
}

const MAX_BELIEFS = 40;
const MAX_TEXT = 300;
const MAX_NEW_BELIEFS_PER_TURN = 2;
const MAX_DEPS_PER_BELIEF = 4;
const MAX_AREA_LEN = 40;
/** Beliefs that ride a turn in full detail; the rest are rolled up by name. */
export const WORKING_SET_CAP = 14;

const STATUSES: ReadonlySet<string> = new Set(["unknown", "misconception", "partial", "understood"]);

// ---------- prompts ----------

const STATE_SCHEMA = `{"beliefs": [{"id": "short-kebab-slug", "concept": "concept label, a few words", "status": "unknown" | "misconception" | "partial" | "understood", "belief": "one sentence addressed to the student as 'you': what they currently believe, or for unknown entries what they have no grasp of", "area": "short cluster label shared by related entries", "deps": ["ids of entries that are prerequisites for this one"]}]}`;

/** Area/deps rules shared by every inventory-shaped prompt. */
const GRAPH_RULES = `- Group the entries: every entry gets an "area" — a one-or-two-word cluster label shared
  by related entries, 3 to 6 distinct areas overall. Spell and case a label identically
  everywhere it is used.
- Mark prerequisites with "deps": the ids of entries a student should grasp before this
  one. Most entries have 0 to 2 deps, never more than 4, and only ids from this inventory.`;

const MISCONCEPTION_QUALITY = `A good misconception is plausible enough that a smart
person could believe it; actually common among real beginners; falsifiable by a good
explanation; and one that, when corrected, exposes a deep principle of the subject. Avoid
silly errors, trivia slips, and strawmen.`;

/** Initial inventory for a topic notebook (no assigned reading). `tuning` = intake calibration block. */
export function buildInitialStatePromptTopic(topic: string, tuning = ""): string {
  return `You are designing the starting knowledge of a simulated student for a teaching session
where a human teaches the student. You are a course designer, not the student. Output JSON
only — no prose, no code fences.

Topic: ${topic}
${tuning ? `\n${tuning}\n` : ""}
Design the student's starting belief inventory — a map of the territory this topic
covers, not just the first conversation's worth:
- 10 to 25 entries, scaled to the topic's breadth: ~10 for a narrow technique or single
  phenomenon, ~25 for a broad field. Together they should cover the key concepts a
  teacher could plausibly visit across several sessions on this topic.
${GRAPH_RULES}
- Most entries: status "unknown" — no real grasp yet; the "belief" sentence states what
  they don't know ("You have no idea what X actually is.").
- 2 to 4 entries: status "partial" — true facts a curious newcomer picks up from a podcast
  or a pop-science article, put in plain words.
- Exactly 2 to 4 entries: status "misconception", whose "belief" is the explicit wrong
  claim the student holds. ${MISCONCEPTION_QUALITY}
- No entry may have status "understood".

Output exactly this JSON shape:
${STATE_SCHEMA}`;
}

/** Initial inventory grounded in assigned reading; runs with cwd = the notebook's sources dir. */
export function buildInitialStatePromptSources(manifest: string, topic: string | null, tuning = ""): string {
  return `You are designing the starting knowledge of a simulated student for a teaching session
where a human teaches the student${topic ? ` about: ${topic}` : ""}. You are a course designer, not the
student. First read the assigned material — the files in your working directory:

${manifest}

Where a .txt sits alongside a PDF of the same name, read the .txt. If a file will not open
or is empty, work with what you can read.
${tuning ? `\n${tuning}\n` : ""}
Then design the student's starting belief inventory: a partial and slightly wrong
understanding from one honest novice read of this material. Output JSON only — no prose,
no code fences.

- 10 to 25 entries covering the key ideas of the material, scaled to its size and breadth.
${GRAPH_RULES}
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

Build the student's CURRENT belief inventory (10 to 20 entries):
- Concepts the teacher explained well and the student visibly absorbed: "understood".
- Concepts touched on but only partly landed: "partial".
- Wrong beliefs the student has voiced that the teacher has NOT yet corrected: keep them,
  status "misconception", with the wrong claim as the belief.
- Key concepts of the subject not yet covered: "unknown". If the student has voiced no
  uncorrected misconceptions, add 1 or 2 plausible new ones consistent with everything the
  student has said so far. ${MISCONCEPTION_QUALITY}
${GRAPH_RULES}

Output exactly this JSON shape:
${STATE_SCHEMA}`;
}

/**
 * The strict gate: decides which beliefs the teacher's newest message
 * justifies changing. Biased toward changing nothing.
 */
export function buildEvaluatorPrompt(state: LearningState, teacherMessage: string, recentMessages: ChatMessage[]): string {
  const { working, rest } = selectWorkingSet(state, teacherMessage);
  const inventory = JSON.stringify(
    working.map(({ id, concept, status, belief, challenged }) => ({
      id,
      concept,
      status,
      belief,
      ...(challenged ? { challenged } : {}),
    })),
    null,
    1,
  );
  // The header must not imply an unseen remainder when the JSON IS the whole
  // inventory — the evaluator might otherwise guess ids "out of view".
  const header =
    rest.length > 0
      ? "The student's current belief inventory — the entries most relevant to this message, in full:"
      : "The student's current belief inventory:";
  const roster =
    rest.length > 0
      ? `\nThe rest of the inventory, one entry per line. You may change these by id too, if the
teacher's message clearly addresses one. Their current text is not shown: whenever you
change one of these, you must include the rewritten "belief" sentence — the old text must
not survive the change:

${rest.map((b) => `- ${b.id} — ${b.concept} [${b.status}]`).join("\n")}\n`
      : "";
  const areas = [...new Set(state.beliefs.map((b) => b.area).filter((a): a is string => !!a))];
  const areasLine = areas.length > 0 ? `\nExisting areas: ${areas.join(", ")}\n` : "";
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

${header}

${inventory}
${roster}${areasLine}
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
  teacher introduced AND actually explained. Give each an "area" — reuse one of the
  existing area labels when it fits — and "deps" listing the ids of prerequisite entries,
  if any.
- An empty "changes" list is the common, correct outcome — greetings, questions, chit-chat
  and weak explanations change nothing.

Output exactly this JSON shape (omit or leave empty what doesn't apply):
{"changes": [{"beliefId": "existing-id", "to": "unknown" | "misconception" | "partial" | "understood", "belief": "rewritten one-sentence belief, optional", "justification": "one line: what in the message justified this"}], "challenged": ["existing-id"], "newBeliefs": [{"id": "new-kebab-slug", "concept": "...", "status": "partial", "belief": "...", "area": "...", "deps": ["existing-id"]}]}`;
}

// ---------- working-set selection ----------

export interface WorkingSetSplit {
  /** Rides the turn in full detail, in inventory order. */
  working: Belief[];
  /** Rolled up by name only, in inventory order. Never contains misconceptions. */
  rest: Belief[];
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4),
  );
}

/** Exact matches plus mutual-prefix matches (≥5 chars) — cheap plural/inflection handling. */
function overlapScore(msgTokens: Set<string>, beliefTokens: Set<string>): number {
  let n = 0;
  for (const t of msgTokens) {
    if (beliefTokens.has(t)) {
      n++;
      continue;
    }
    if (t.length >= 5) {
      for (const b of beliefTokens) {
        if (b.length >= 5 && (b.startsWith(t) || t.startsWith(b))) {
          n++;
          break;
        }
      }
    }
  }
  return n;
}

const STATUS_WEIGHT: Record<BeliefStatus, number> = { partial: 2, unknown: 1, misconception: 0, understood: 0 };

/**
 * Split the inventory into the beliefs that ride this turn in full detail and
 * the rest. Misconceptions are ALWAYS in full — a wrong claim compressed to its
 * name is a broken one — as are beliefs the evaluator just changed. Remaining
 * slots go to the beliefs most relevant to the teacher's message (lexical
 * overlap), breaking ties by status (partials are the live frontier), recency,
 * then inventory order. Deterministic; an inventory within the cap passes
 * through whole, which is also the pre-feature path.
 */
export function selectWorkingSet(state: LearningState, teacherMessage: string, cap = WORKING_SET_CAP): WorkingSetSplit {
  const beliefs = state.beliefs;
  if (beliefs.length <= cap) return { working: beliefs, rest: [] };

  const justChanged = new Set(state.lastChanges.map((c) => c.beliefId));
  const chosen = new Set<string>();
  for (const b of beliefs) {
    if (b.status === "misconception" || justChanged.has(b.id)) chosen.add(b.id);
  }

  const msgTokens = tokenize(teacherMessage);
  const candidates = beliefs
    .map((b, index) => {
      const overlap = overlapScore(msgTokens, tokenize(`${b.concept} ${b.belief} ${b.area ?? ""}`));
      return { b, index, overlap, score: overlap * 4 + STATUS_WEIGHT[b.status] + (b.touchedAt ? 1 : 0) };
    })
    .filter((c) => !chosen.has(c.b.id));
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      b.overlap - a.overlap ||
      (b.b.touchedAt ?? "").localeCompare(a.b.touchedAt ?? "") ||
      a.index - b.index,
  );
  for (const c of candidates) {
    if (chosen.size >= cap) break;
    chosen.add(c.b.id);
  }

  const working: Belief[] = [];
  const rest: Belief[] = [];
  for (const b of beliefs) (chosen.has(b.id) ? working : rest).push(b);
  return { working, rest };
}

// ---------- rendering ----------

function renderLines(beliefs: Belief[]): string {
  return beliefs
    .map((b) => `- ${b.concept} [${b.status}${b.challenged ? ", challenged but unconvinced" : ""}]: ${b.belief}`)
    .join("\n");
}

/** One compact line per belief — used in the per-turn block and the kickoff prompt. */
export function renderBeliefLines(state: LearningState): string {
  return renderLines(state.beliefs);
}

/** Name-only roll-up of the out-of-focus beliefs, grouped by status. */
function renderRollup(rest: Belief[]): string {
  const groups: [string, string[]][] = [
    [
      "you understand (your teacher's earlier explanations in this conversation still stand)",
      rest.filter((b) => b.status === "understood").map((b) => b.concept),
    ],
    ["you have a rough, partial sense of", rest.filter((b) => b.status === "partial").map((b) => b.concept)],
    ["you have essentially nothing on", rest.filter((b) => b.status === "unknown").map((b) => b.concept)],
  ];
  return groups
    .filter(([, names]) => names.length > 0)
    .map(([label, names]) => `- ${label}: ${names.join("; ")}`)
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
 * belief contract. Inventories within WORKING_SET_CAP render exactly as they
 * always have; larger ones render two-tier — the working set in full plus a
 * name-only roll-up whose wording keeps the "complete extent" invariant sound.
 */
export function buildBeliefBlock(state: LearningState, opts: { includeChanges: boolean; teacherMessage?: string }): string {
  const { working, rest } = selectWorkingSet(state, opts.teacherMessage ?? "");
  let block: string;
  if (rest.length === 0) {
    block = `[BELIEF STATE — the teacher never sees this block. This inventory is the complete extent
of your understanding of the subject. Never display knowledge, vocabulary, or certainty
beyond it. Entries marked "misconception" are things you genuinely believe — reason from
them with confidence. Entries marked "challenged but unconvinced" are beliefs the teacher
has pushed on without convincing you: you still hold them.

${renderBeliefLines(state)}
`;
  } else {
    block = `[BELIEF STATE — the teacher never sees this block. This inventory — the detailed entries
and the brief lists together — is the complete extent of your understanding of the
subject. Never display knowledge, vocabulary, or certainty beyond it. Entries marked
"misconception" are things you genuinely believe — reason from them with confidence.
Entries marked "challenged but unconvinced" are beliefs the teacher has pushed on without
convincing you: you still hold them.

In focus right now:

${renderLines(working)}

The rest of your inventory, in brief. A name listed here is the FULL extent of what you
have on that concept — there is no hidden detail behind it:
${renderRollup(rest)}
`;
  }
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
export function extractJsonObject(raw: string): Record<string, unknown> | null {
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

/**
 * A parsed belief plus the raw id/deps the model emitted. slugify can RENAME
 * ids (collisions, illegal characters, truncation), so deps must be resolved
 * after all ids are final, through the raw→final map — never against raw ids.
 */
interface ParsedBelief {
  belief: Belief;
  rawId: string | null;
  rawDeps: string[];
}

function parseBelief(v: unknown, used: Set<string>): ParsedBelief | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.concept !== "string" || !o.concept.trim()) return null;
  if (typeof o.belief !== "string" || !o.belief.trim()) return null;
  if (typeof o.status !== "string" || !STATUSES.has(o.status)) return null;
  const rawId = typeof o.id === "string" && o.id.trim() ? o.id.trim() : null;
  const id = rawId ? slugify(rawId, used) : slugify(o.concept, used);
  const belief: Belief = {
    id,
    concept: clip(o.concept.trim()),
    status: o.status as BeliefStatus,
    belief: clip(o.belief.trim()),
  };
  if (typeof o.area === "string" && o.area.trim()) belief.area = o.area.trim().slice(0, MAX_AREA_LEN);
  const rawDeps = Array.isArray(o.deps) ? o.deps.filter((d): d is string => typeof d === "string") : [];
  return { belief, rawId, rawDeps };
}

/** Case-insensitive area canonicalization: first-seen casing wins. */
function canonArea(area: string, canon: Map<string, string>): string {
  const key = area.toLowerCase();
  const existing = canon.get(key);
  if (existing) return existing;
  canon.set(key, area);
  return area;
}

/** Resolve raw deps to final ids; drops dangling refs, self-loops and dupes. */
function resolveDeps(rawDeps: string[], selfId: string, idMap: Map<string, string>, validIds: Set<string>): string[] | undefined {
  const out: string[] = [];
  for (const raw of rawDeps) {
    const id = idMap.get(raw) ?? (validIds.has(raw) ? raw : undefined);
    if (!id || id === selfId || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_DEPS_PER_BELIEF) break;
  }
  return out.length > 0 ? out : undefined;
}

/** Parse a generated initial (or bootstrapped) inventory. */
export function parseInitialState(raw: string): LearningState | null {
  const obj = extractJsonObject(raw);
  if (!obj || !Array.isArray(obj.beliefs)) return null;
  const used = new Set<string>();
  const areaCanon = new Map<string, string>();
  const parsed: ParsedBelief[] = [];
  // Slice at the hard cap, not the prompt's 10–25 ask: an over-producing model
  // whose misconceptions land late must not have them truncated away and then
  // fail the quality gate below — rejecting a usable inventory entirely.
  for (const item of obj.beliefs.slice(0, MAX_BELIEFS)) {
    const p = parseBelief(item, used);
    if (!p) continue;
    if (p.belief.area) p.belief.area = canonArea(p.belief.area, areaCanon);
    parsed.push(p);
  }
  const idMap = new Map<string, string>();
  // First-wins: if the model duplicated a raw id, references mean the first
  // (canonical) entry, not the slug-renamed duplicate.
  for (const p of parsed) if (p.rawId && !idMap.has(p.rawId)) idMap.set(p.rawId, p.belief.id);
  const validIds = new Set(parsed.map((p) => p.belief.id));
  for (const p of parsed) {
    const deps = resolveDeps(p.rawDeps, p.belief.id, idMap, validIds);
    if (deps) p.belief.deps = deps;
  }
  const beliefs = parsed.map((p) => p.belief);
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
 *
 * `teacherMessage` must be the same text the evaluator prompt was built from:
 * selectWorkingSet is pure, so recomputing the split here reproduces exactly
 * which entries the evaluator saw only as a name/status roster line.
 */
export function applyEvaluatorOutput(raw: string, prev: LearningState, teacherMessage = ""): LearningState | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;

  const rolledUp = new Set(selectWorkingSet(prev, teacherMessage).rest.map((b) => b.id));

  const beliefs = prev.beliefs.map((b) => ({ ...b }));
  const byId = new Map(beliefs.map((b) => [b.id, b]));
  const changes: BeliefChange[] = [];
  const now = new Date().toISOString();

  for (const c of Array.isArray(obj.changes) ? obj.changes : []) {
    if (typeof c !== "object" || c === null) continue;
    const o = c as Record<string, unknown>;
    const b = typeof o.beliefId === "string" ? byId.get(o.beliefId) : undefined;
    if (!b) continue;
    if (typeof o.to !== "string" || !STATUSES.has(o.to)) continue;
    const to = o.to as BeliefStatus;
    const newText = typeof o.belief === "string" && o.belief.trim() ? clip(o.belief.trim()) : undefined;
    // The evaluator never saw a rolled-up entry's sentence — applying a
    // status-only change would leave stale text ("You have no idea...")
    // under the new status. The prompt demands a rewrite for roster ids;
    // a change arriving without one isn't trustworthy enough to apply.
    if (rolledUp.has(b.id) && !newText) continue;
    if (to === b.status && (!newText || newText === b.belief)) continue;
    const justification = clip(typeof o.justification === "string" && o.justification.trim() ? o.justification.trim() : "the teacher's explanation");
    changes.push({ beliefId: b.id, concept: b.concept, from: b.status, to, belief: newText, justification });
    b.status = to;
    if (newText) b.belief = newText;
    b.note = justification;
    b.touchedAt = now;
    if (to !== "misconception") delete b.challenged;
  }

  for (const id of Array.isArray(obj.challenged) ? obj.challenged : []) {
    const b = typeof id === "string" ? byId.get(id) : undefined;
    if (b && b.status === "misconception") {
      b.challenged = true;
      b.touchedAt = now;
    }
  }

  const used = new Set(beliefs.map((b) => b.id));
  const areaCanon = new Map<string, string>();
  for (const b of beliefs) if (b.area) canonArea(b.area, areaCanon);
  const idMap = new Map<string, string>();
  // A raw id that already names an EXISTING inventory entry must keep meaning
  // that entry (resolveDeps consults idMap before validIds) — only genuinely
  // new raw ids may map to their renamed slugs.
  const prevIds = new Set(beliefs.map((b) => b.id));
  for (const item of (Array.isArray(obj.newBeliefs) ? obj.newBeliefs : []).slice(0, MAX_NEW_BELIEFS_PER_TURN)) {
    if (beliefs.length >= MAX_BELIEFS) break;
    const p = parseBelief(item, used);
    if (!p) continue;
    if (p.belief.area) p.belief.area = canonArea(p.belief.area, areaCanon);
    if (p.rawId && !idMap.has(p.rawId) && !prevIds.has(p.rawId)) idMap.set(p.rawId, p.belief.id);
    // Deps may reference any existing belief, including one added earlier in this same pass.
    const deps = resolveDeps(p.rawDeps, p.belief.id, idMap, new Set(beliefs.map((b) => b.id)));
    if (deps) p.belief.deps = deps;
    p.belief.touchedAt = now;
    beliefs.push(p.belief);
    changes.push({
      beliefId: p.belief.id,
      concept: p.belief.concept,
      from: "unknown",
      to: p.belief.status,
      belief: p.belief.belief,
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
