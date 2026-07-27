import type { ChatMessage } from "./store.js";
import { selectWorkingSet } from "./learning.js";
import { emptyKnowledgeState, GRAPH_RULES, resetKnowledgeEvidence, type KnowledgeState } from "./knowledge.js";

/**
 * Interview mode's coverage map — the interview analog of the teach-mode
 * knowledge map (knowledge.ts). Same KnowledgeState shape, same SSE event,
 * same map view; only the prompts differ. Nodes are competencies the
 * interviewer could probe; statuses are re-read semantically:
 *   unknown = not probed yet, partial = touched on / shallow answer,
 *   misconception = struggled or made a wrong claim, understood = strong answer.
 * All plumbing (parse, merge, reset, carry-forward, apply) is knowledge.ts's,
 * unchanged — these builders only swap the framing.
 */

// Must stay shape-identical to knowledge.ts's KNOWLEDGE_SCHEMA — the output is
// parsed by parseKnowledgeState. Only the description text differs.
const COVERAGE_SCHEMA = `{"beliefs": [{"id": "short-kebab-slug", "concept": "competency label, a few words", "status": "unknown" | "misconception" | "partial" | "understood", "belief": "one sentence addressed to the candidate as 'you': what the interview so far shows about them on this competency, or that it has not been probed yet", "area": "short cluster label shared by related entries", "deps": ["ids of entries that are prerequisites for this one"]}]}`;

function coverageUnknownText(concept: string): string {
  return `The interview hasn't probed ${concept} yet.`;
}

/** resetKnowledgeEvidence with interview wording — teach's "you have explained" text must not leak into coverage maps. */
export function resetCoverageEvidence(state: KnowledgeState): KnowledgeState {
  return resetKnowledgeEvidence(state, coverageUnknownText);
}

/** emptyKnowledgeState with interview wording, for the graph-generation-failed fallback. */
export function emptyCoverageState(label: string): KnowledgeState {
  return emptyKnowledgeState(label, coverageUnknownText);
}

export function buildCoverageGraphPrompt(opts: {
  role: string;
  company: string | null;
  /** interviewMaterialsManifest; the one-shot runs with cwd = sources dir when non-null. */
  manifest: string | null;
  format: string | null;
  round: string | null;
}): string {
  const target = `${opts.role}${opts.company ? ` at ${opts.company}` : ""}`;
  const tuning: string[] = [];
  if (opts.format) tuning.push(`The candidate asked for this kind of interview: ${opts.format}.`);
  if (opts.round) tuning.push(`The round being prepared for: ${opts.round}.`);
  const tuningBlock = tuning.length > 0 ? `\n${tuning.join("\n")}\nWeight the map toward what that kind of round actually probes.\n` : "";
  const materialsBlock = opts.manifest
    ? `
Read the interview materials - the files in your working directory:

${opts.manifest}

Where a .txt sits alongside a PDF of the same name, read the .txt. If a file will not open
or is empty, work with what you can read. The materials define the territory of the map
only; they are NOT evidence that the candidate can do anything.
`
    : "";
  return `You are designing the coverage map for a simulated job interview in an interview-practice
app. The map lists the competencies the interviewer could probe for this role; the app
tracks how the candidate performs on each as the interview runs. The interview has not
started yet. Output JSON only - no prose, no code fences.

The role: ${target}.
${tuningBlock}${materialsBlock}
Design the map of competencies this interview could cover:
- 10 to 25 entries: role-specific technical skills, behavioral competencies, domain
  knowledge the CV claims, and company/role fit - scaled to the breadth of the role.
${GRAPH_RULES}
- Every entry MUST have status "unknown".
- Every "belief" sentence must say the interview has not yet probed that competency. Do
  not assign strengths or weaknesses from the CV itself - claims are not demonstrations.

Output exactly this JSON shape:
${COVERAGE_SCHEMA}`;
}

const TRANSCRIPT_PROMPT_CHAR_BUDGET = 60_000;

export function buildCoverageTranscriptPrompt(
  base: KnowledgeState,
  messages: ChatMessage[],
): { prompt: string; truncated: boolean } {
  // Mirrors buildKnowledgeTranscriptPrompt's budget/truncation contract: long
  // interviews are the ones with the most evidence at stake, and `truncated`
  // tells the caller that "unknown" may mean "not in the window".
  const lines = messages.map((m) => `${m.role === "teacher" ? "Candidate" : "Interviewer"}: ${m.text}`);
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    total += line.length + 2;
    if (kept.length > 0 && total > TRANSCRIPT_PROMPT_CHAR_BUDGET) break;
    kept.unshift(line);
  }
  const omitted = lines.length - kept.length;
  const transcript = (omitted > 0 ? `[${omitted} earlier messages omitted]\n\n` : "") + kept.join("\n\n");
  const prompt = `You are rebuilding the coverage map for a simulated job interview in an interview-practice
app. You are an analyst, not the interviewer. Output JSON only - no prose, no code fences.

The current competency map. Keep these ids and concepts unless the interview genuinely
surfaced a missing competency:

${JSON.stringify(base.beliefs.map(({ id, concept, status, belief, area, deps }) => ({ id, concept, status, belief, area, deps })), null, 1)}

Transcript:

${transcript || "(no messages)"}

Infer how the candidate has performed so far:
- Candidate answers are the ONLY evidence. The interviewer's questions, the CV, and the
  job description are context, never evidence of ability.
- "understood" means a strong, specific answer that demonstrated the competency.
- "partial" means the competency was probed and the answer was correct but shallow,
  incomplete, or hesitant.
- "misconception" means the candidate made an incorrect claim or clearly mishandled a
  question on that competency.
- "unknown" means the interview has not meaningfully probed this competency.
- If the interview genuinely probed a competency missing from the map, add it.

Output the complete updated map in exactly this JSON shape:
${COVERAGE_SCHEMA}`;
  return { prompt, truncated: omitted > 0 };
}

export function buildCoverageEvaluatorPrompt(
  state: KnowledgeState,
  candidateMessage: string,
  recentMessages: ChatMessage[],
): string {
  const { working, rest } = selectWorkingSet(state, candidateMessage);
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
      ? "The interview coverage map - the entries most relevant to this answer, in full:"
      : "The interview coverage map:";
  const roster =
    rest.length > 0
      ? `\nThe rest of the map, one entry per line. You may change these by id too, if the
candidate's answer clearly demonstrates strength or weakness on them. Their current text is
not shown: whenever you change one of these, include the rewritten "belief" sentence:

${rest.map((b) => `- ${b.id} - ${b.concept} [${b.status}]`).join("\n")}\n`
      : "";
  const areas = [...new Set(state.beliefs.map((b) => b.area).filter((a): a is string => !!a))];
  const areasLine = areas.length > 0 ? `\nExisting areas: ${areas.join(", ")}\n` : "";
  const context =
    recentMessages.length > 0
      ? recentMessages
          .slice(-6)
          .map((m) => `${m.role === "teacher" ? "Candidate" : "Interviewer"}: ${m.text}`)
          .join("\n\n")
      : "(start of interview)";
  return `You are strictly grading the CANDIDATE's newest answer in a simulated job interview. You
are a grader, not the interviewer. Output JSON only - no prose, no code fences.

${header}

${inventory}
${roster}${areasLine}
Recent conversation, for context:

${context}

The candidate's newest message:

"""
${candidateMessage}
"""

Decide which map entries this one candidate message JUSTIFIES changing. Be strict:
- Candidate answers are the ONLY evidence. The interviewer's questions provide context
  only; a question being asked proves nothing about the candidate.
- "understood" requires a strong, specific, well-grounded answer demonstrating the
  competency.
- "partial" is for answers that touched the competency but stayed shallow, incomplete, or
  hesitant.
- "misconception" is for an incorrect claim, or a clearly weak or mishandled answer.
- "unknown" remains when the message only mentions, deflects, or gestures at a competency.
- A vague or evasive answer never earns "understood" - at most "partial".
- Never change a map entry the answer does not address.
- You may add at most 2 entries under "newBeliefs" for competencies the interview genuinely
  probed that are missing from the map. Give each an "area" - reuse one of the existing
  labels when it fits - and "deps" listing prerequisite ids, if any.
- An empty "changes" list is the common, correct outcome.

Output exactly this JSON shape (omit or leave empty what doesn't apply):
{"changes": [{"beliefId": "existing-id", "to": "unknown" | "misconception" | "partial" | "understood", "belief": "rewritten one-sentence coverage sentence, optional", "justification": "one line: what in the candidate's answer justified this"}], "newBeliefs": [{"id": "new-kebab-slug", "concept": "...", "status": "partial", "belief": "...", "area": "...", "deps": ["existing-id"]}]}`;
}
