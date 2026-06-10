import type { Excerpt } from "./rag.js";
import { sourcesManifest } from "./persona.js";
import type { CyraMessage, Notebook } from "./store.js";

/**
 * Cyra — the expert teacher the user can consult when the student asks
 * something they can't answer. The inverse of the Aria persona: here the AI
 * is the authority and the human is the one learning. Cyra knows nothing
 * about Aria or the teaching session; each Cyra thread is a standalone
 * conversation rooted in one question (see cyra-session.ts).
 */

const CYRA_PERSONA = `You are Cyra, an expert teacher. The person you're talking to is studying a subject and
brings you the questions they couldn't answer on their own. You are the authority in this
conversation — never roleplay being a student, never feign uncertainty you don't have, and
never quiz them back as a teaching device.

How you answer:
- Answer the question directly first, in plain language. Then the reasoning, sized to the
  question — one sentence for a simple fact, a short structured explanation for a deep one.
- Prefer intuition and concrete examples over formalism, but give the precise form (the
  equation, the exact definition) when that IS the answer.
- End with at most ONE pointer deeper — a sharper question, a connection, or what to look
  at next. One or none; never a list of follow-ups.
- If the question is ambiguous, answer the most useful reading and say in one clause what
  you assumed.
- If you genuinely don't know, or the question rests on a false premise, say so plainly.`;

const CYRA_SOURCES_CONTEXT = (manifest: string) => `

# The reading

The user's study material is available to you as files in your working directory
(read-only):

${manifest}

Where a .txt sits alongside a PDF of the same name, read the .txt. Ground claims about the
material in what it actually says, and refer to it as "the reading" or by section — never
by file names or paths. When your own expertise and the reading disagree, say so explicitly
and explain the difference.`;

export function buildCyraInstructions(nb: Notebook): string {
  let text = CYRA_PERSONA;
  if (nb.type === "topic" || nb.topic) {
    text += `\n\nThe subject they are studying: ${nb.topic ?? nb.title}.`;
  }
  if (nb.sourceFiles.length > 0) {
    text += CYRA_SOURCES_CONTEXT(sourcesManifest(nb.sourceFiles));
  }
  return text;
}

/** Thread title shown in the switcher, derived from the seed question. */
export function deriveCyraTitle(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim())?.trim() ?? "Question";
  return firstLine.length <= 60 ? firstLine : `${firstLine.slice(0, 59).trimEnd()}…`;
}

/**
 * Prepended to the next turn when a Cyra codex thread had to be recreated
 * (lost rollout). Mirrors persona.buildCatchUpBlock; callers pass the
 * transcript EXCLUDING the message being sent as the live prompt.
 */
export function buildCyraCatchUpBlock(messages: CyraMessage[]): string {
  const recent = messages.slice(-30);
  const lines = recent.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`);
  return `[SYSTEM: your earlier conversation with this user was lost. Here is the transcript so far — everything in it still stands. Do not mention this interruption. The user's next message follows after the transcript.]

${lines.join("\n\n")}

[End of transcript. Reply to the user's next message:]

`;
}

/**
 * Expert-framed wrapper for retrieved passages — the Aria renderer's wording
 * ("your one honest read", belief-inventory limits) is student-persona text
 * and must not leak into Cyra's prompt.
 */
export function renderCyraRetrievalBlock(excerpts: Excerpt[]): string {
  const body = excerpts
    .map((e) => `${e.heading ? `From the part about "${e.heading}":` : "From the reading:"}\n${e.text}`)
    .join("\n\n");
  return `[REFERENCE — the user never sees this block. These are the passages of their study material
most relevant to their message. Ground your answer in them where they apply: prefer the
reading's terminology and notation so your answer connects to what they're studying, and
point at the relevant part ("the section on X") rather than quoting at length. If they
don't bear on the question, ignore them entirely. Never mention this block.

${body}

The user's message follows.]

`;
}
