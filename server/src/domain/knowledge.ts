import type { ChatMessage } from "./store.js";
import {
  applyEvaluatorOutput,
  parseInitialState,
  selectWorkingSet,
  type Belief,
  type BeliefStatus,
  type LearningState,
} from "./learning.js";

export type KnowledgeStatus = BeliefStatus;
export type KnowledgeBelief = Belief;
export type KnowledgeChange = LearningState["lastChanges"][number];
export type KnowledgeState = LearningState;

const KNOWLEDGE_SCHEMA = `{"beliefs": [{"id": "short-kebab-slug", "concept": "concept label, a few words", "status": "unknown" | "misconception" | "partial" | "understood", "belief": "one sentence addressed to the human teacher as 'you': what the system has evidence they know, misunderstand, or have not shown yet", "area": "short cluster label shared by related entries", "deps": ["ids of entries that are prerequisites for this one"]}]}`;

const GRAPH_RULES = `- Group the entries: every entry gets an "area" - a one-or-two-word cluster label shared
  by related entries, 3 to 6 distinct areas overall. Spell and case a label identically
  everywhere it is used.
- Mark prerequisites with "deps": the ids of entries a learner should grasp before this
  one. Most entries have 0 to 2 deps, never more than 4, and only ids from this inventory.`;

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "topic"
  );
}

function unknownText(concept: string): string {
  return `No evidence yet that you have explained ${concept}.`;
}

function stripPrivateFields(b: KnowledgeBelief): KnowledgeBelief {
  const next: KnowledgeBelief = {
    id: b.id,
    concept: b.concept,
    status: b.status,
    belief: b.belief,
  };
  if (b.area) next.area = b.area;
  if (b.deps && b.deps.length > 0) next.deps = b.deps;
  if (b.note) next.note = b.note;
  if (b.touchedAt) next.touchedAt = b.touchedAt;
  return next;
}

export function emptyKnowledgeState(label: string): KnowledgeState {
  const concept = label.trim() || "This topic";
  return {
    version: 1,
    beliefs: [
      {
        id: slugify(concept),
        concept,
        status: "unknown",
        belief: unknownText(concept),
        area: "General",
      },
    ],
    lastChanges: [],
    lastEvaluatedMessageId: null,
    updatedAt: new Date().toISOString(),
  };
}

export function knowledgeFromConceptState(state: LearningState): KnowledgeState {
  return {
    version: 1,
    beliefs: state.beliefs.map((b) => {
      const next = stripPrivateFields({
        ...b,
        status: "unknown",
        belief: unknownText(b.concept),
      });
      delete next.note;
      delete next.touchedAt;
      return next;
    }),
    lastChanges: [],
    lastEvaluatedMessageId: null,
    updatedAt: new Date().toISOString(),
  };
}

export function parseKnowledgeState(raw: string): KnowledgeState | null {
  const state = parseInitialState(raw, { requireMisconception: false });
  return state ? stripKnowledgeState(state) : null;
}

export function stripKnowledgeState(state: KnowledgeState): KnowledgeState {
  return {
    version: 1,
    beliefs: state.beliefs.map(stripPrivateFields),
    lastChanges: state.lastChanges.map((c) => ({ ...c })),
    lastEvaluatedMessageId: state.lastEvaluatedMessageId,
    updatedAt: state.updatedAt,
  };
}

export function resetKnowledgeEvidence(state: KnowledgeState): KnowledgeState {
  return knowledgeFromConceptState(state);
}

export function mergeKnowledgeEvidence(base: KnowledgeState, evaluated: KnowledgeState): KnowledgeState {
  const evaluatedById = new Map(evaluated.beliefs.map((b) => [b.id, b]));
  const used = new Set<string>();
  const beliefs: KnowledgeBelief[] = base.beliefs.map((b) => {
    used.add(b.id);
    const next = evaluatedById.get(b.id);
    if (!next) return stripPrivateFields(b);
    return stripPrivateFields({
      ...b,
      status: next.status,
      belief: next.belief,
      note: next.note,
      touchedAt: next.touchedAt,
    });
  });
  for (const b of evaluated.beliefs) {
    if (used.has(b.id) || beliefs.length >= 40) continue;
    beliefs.push(stripPrivateFields(b));
  }
  return {
    version: 1,
    beliefs,
    lastChanges: evaluated.lastChanges.map((c) => ({ ...c })),
    lastEvaluatedMessageId: evaluated.lastEvaluatedMessageId,
    updatedAt: new Date().toISOString(),
  };
}

export function buildKnowledgeGraphPromptTopic(topic: string): string {
  return `You are designing the concept graph for a human teacher's knowledge map in a teaching app.
The graph shows what the system has evidence the human teacher knows. The human has not taught
anything yet. Output JSON only - no prose, no code fences.

Topic: ${topic}

Design the map of concepts this topic covers:
- 10 to 25 entries, scaled to the topic's breadth: ~10 for a narrow technique or single
  phenomenon, ~25 for a broad field.
${GRAPH_RULES}
- Every entry MUST have status "unknown".
- Every "belief" sentence must say there is no evidence yet that the human has explained
  that concept. Do not assign partial knowledge, misconceptions, or understanding.

Output exactly this JSON shape:
${KNOWLEDGE_SCHEMA}`;
}

export function buildKnowledgeGraphPromptSources(manifest: string, topic: string | null): string {
  return `You are designing the concept graph for a human teacher's knowledge map in a teaching app${
    topic ? ` about: ${topic}` : ""
  }. The graph shows what the system has evidence the human teacher knows. Source files define
the territory of the map only; they are NOT evidence that the human understands anything.
Output JSON only - no prose, no code fences.

Read the assigned material - the files in your working directory:

${manifest}

Where a .txt sits alongside a PDF of the same name, read the .txt. If a file will not open
or is empty, work with what you can read.

Design the map of concepts covered by the material:
- 10 to 25 entries covering the key ideas of the material, scaled to its size and breadth.
${GRAPH_RULES}
- Every entry MUST have status "unknown".
- Every "belief" sentence must say there is no evidence yet that the human has explained
  that concept. Do not infer knowledge from the reading itself.

Output exactly this JSON shape:
${KNOWLEDGE_SCHEMA}`;
}

export function buildKnowledgeTranscriptPrompt(base: KnowledgeState, messages: ChatMessage[]): string {
  const transcript = messages
    .map((m) => `${m.role === "teacher" ? "Teacher" : "Aria student"}: ${m.text}`)
    .join("\n\n");
  return `You are rebuilding a knowledge map for the HUMAN TEACHER in a reverse-tutoring app.
You are an analyst, not the student. Output JSON only - no prose, no code fences.

The current concept graph. Keep these ids and concepts unless you add a genuinely missing
concept from the teacher's messages:

${JSON.stringify(base.beliefs.map(({ id, concept, status, belief, area, deps }) => ({ id, concept, status, belief, area, deps })), null, 1)}

Transcript:

${transcript || "(no messages)"}

Infer what the human teacher has shown they know:
- Teacher messages are the ONLY evidence. Source files, topic names, intake answers, and Aria's
  student replies are not evidence of the human's knowledge.
- Aria student replies may provide context for what the teacher was responding to, but never
  credit the human with knowledge.
- "understood" means the teacher clearly explained the concept accurately enough.
- "partial" means the teacher showed some correct but incomplete or shallow understanding.
- "misconception" means the teacher asserted or strongly implied an incorrect claim.
- "unknown" means there is no teacher-message evidence for this concept.
- If the teacher introduced an explained concept that is missing from the graph, add it.

Output the complete updated map in exactly this JSON shape:
${KNOWLEDGE_SCHEMA}`;
}

export function buildKnowledgeEvaluatorPrompt(state: KnowledgeState, teacherMessage: string, recentMessages: ChatMessage[]): string {
  const { working, rest } = selectWorkingSet(state, teacherMessage);
  const inventory = JSON.stringify(
    working.map(({ id, concept, status, belief }) => ({
      id,
      concept,
      status,
      belief,
    })),
    null,
    1,
  );
  const header =
    rest.length > 0
      ? "The human teacher's knowledge map - the entries most relevant to this message, in full:"
      : "The human teacher's knowledge map:";
  const roster =
    rest.length > 0
      ? `\nThe rest of the map, one entry per line. You may change these by id too, if the
teacher's message clearly demonstrates knowledge or a misconception. Their current text is
not shown: whenever you change one of these, include the rewritten "belief" sentence:

${rest.map((b) => `- ${b.id} - ${b.concept} [${b.status}]`).join("\n")}\n`
      : "";
  const areas = [...new Set(state.beliefs.map((b) => b.area).filter((a): a is string => !!a))];
  const areasLine = areas.length > 0 ? `\nExisting areas: ${areas.join(", ")}\n` : "";
  const context =
    recentMessages.length > 0
      ? recentMessages
          .slice(-6)
          .map((m) => `${m.role === "teacher" ? "Teacher" : "Aria student"}: ${m.text}`)
          .join("\n\n")
      : "(start of session)";
  return `You are strictly grading what the HUMAN TEACHER appears to know in a reverse-tutoring
session. You are a grader, not the student. Output JSON only - no prose, no code fences.

${header}

${inventory}
${roster}${areasLine}
Recent conversation, for context:

${context}

The teacher's newest message:

"""
${teacherMessage}
"""

Decide which map entries this one teacher message JUSTIFIES changing. Be strict:
- Teacher messages are the ONLY evidence. Aria student replies provide context only.
- "understood" requires a clear, correct explanation from the teacher.
- "partial" is for correct but incomplete, shallow, or uncertain explanations.
- "misconception" is for an incorrect claim the teacher asserted or strongly implied.
- "unknown" remains when the message only names, asks about, greets, or gestures at a concept.
- Never change a map entry the message does not address.
- You may add at most 2 entries under "newBeliefs" for genuinely new concepts the teacher
  introduced AND actually explained. Give each an "area" - reuse one of the existing labels
  when it fits - and "deps" listing prerequisite ids, if any.
- An empty "changes" list is the common, correct outcome.

Output exactly this JSON shape (omit or leave empty what doesn't apply):
{"changes": [{"beliefId": "existing-id", "to": "unknown" | "misconception" | "partial" | "understood", "belief": "rewritten one-sentence user-knowledge sentence, optional", "justification": "one line: what in the teacher message justified this"}], "newBeliefs": [{"id": "new-kebab-slug", "concept": "...", "status": "partial", "belief": "...", "area": "...", "deps": ["existing-id"]}]}`;
}

export function applyKnowledgeEvaluatorOutput(raw: string, prev: KnowledgeState, teacherMessage = ""): KnowledgeState | null {
  const next = applyEvaluatorOutput(raw, prev, teacherMessage);
  return next ? stripKnowledgeState(next) : null;
}
