import type { Notebook } from "./store.js";
import { extractJsonObject } from "./learning.js";

/**
 * The pre-session setup form ("tune Aria"): a handful of MCQ questions —
 * always phrased as configuring the student, never as assessing the teacher —
 * answered once before the kickoff. Answers calibrate the learning-state
 * generation (level), gate the online-research step, and focus the session.
 */

export type IntakeLevel = "fundamental" | "standard" | "challenge";

export interface IntakeOption {
  value: string;
  label: string;
}

export interface IntakeQuestion {
  id: string; // "level" | "research" | generated kebab slug
  question: string;
  options: IntakeOption[];
  /** Every question also offers a free-text "Other" answer. */
  allowsCustom: boolean;
}

export interface IntakeAnswers {
  /** null = unspecified (skipped, or a custom answer captured in levelNote). */
  level: IntakeLevel | null;
  levelNote: string | null;
  research: boolean;
  researchNote: string | null;
  /** Generated-question id -> chosen option label or custom text. */
  focus: Record<string, string>;
  skipped: boolean;
}

export type ResearchStatus = "none" | "running" | "done" | "failed";

export interface Intake {
  status: "pending" | "done";
  /** null = generation not yet attempted; [] = attempted, deterministic-only (never retried). */
  generatedQuestions: IntakeQuestion[] | null;
  answers: IntakeAnswers | null;
  research: ResearchStatus;
  submittedAt: string | null;
}

// ---------- deterministic questions ----------

export const LEVEL_QUESTION: IntakeQuestion = {
  id: "level",
  question: "Pick Aria's starting point",
  options: [
    { value: "fundamental", label: "Keep it fundamental — I'm newer to this myself" },
    { value: "standard", label: "Standard student — I know this fairly well" },
    { value: "challenge", label: "Challenge me — I know this inside out" },
  ],
  allowsCustom: true,
};

export const RESEARCH_QUESTION: IntakeQuestion = {
  id: "research",
  question: "May Aria read up online before class?",
  options: [
    { value: "yes", label: "Yes — let Aria skim the web for background" },
    { value: "no", label: "No — stick to the materials I uploaded" },
  ],
  allowsCustom: true,
};

/** The form as the client sees it: deterministic questions + whatever generation produced. */
export function composeIntakeQuestions(nb: Notebook): IntakeQuestion[] {
  return [
    LEVEL_QUESTION,
    ...(nb.sourceFiles.length > 0 ? [RESEARCH_QUESTION] : []),
    ...(nb.intake?.generatedQuestions ?? []),
  ];
}

// ---------- generation ----------

export function buildIntakeQuestionsPrompt(topic: string | null, manifest: string | null): string {
  return `You are designing at most two multiple-choice setup questions for a teaching app. A human
is about to teach a simulated student named Aria; before the session starts, the teacher
fills in a short form that tunes Aria. You are a form designer, not the student. Output
JSON only — no prose, no code fences.

${topic ? `Topic the teacher will teach: ${topic}.` : ""}
${manifest ? `The teacher uploaded reading material for the session:\n${manifest}` : ""}

The form already asks two fixed questions — do not duplicate them:
1. Aria's starting point (how fundamental vs. advanced Aria's confusions should be).
2. Whether Aria may read up online beforehand.

Your job:
- Judge whether the topic is too broad or vague to start teaching directly ("music theory"
  is broad; "why parallel fifths are avoided in counterpoint" is not). If it is, write ONE
  question letting the teacher pick the concrete direction for Aria's curiosity, with 3 to
  5 distinct, concrete subtopic options. Phrase it as steering Aria, never as testing the
  teacher (good: "Where should Aria's questions focus first?").
- Optionally add ONE more tuning question, only if a genuinely useful one exists for this
  specific topic (e.g. theory-first vs. worked examples, historical vs. modern practice).
  Never ask about session length, format, or anything the fixed questions already cover.
  When in doubt, ask fewer questions.
- If the topic is already specific and no extra question would clearly help, return an
  empty list. An empty list is a common, correct outcome.

Rules: each "question" under 80 characters; each option a concise phrase under 60
characters; questions read as choices about Aria, not assessments of the teacher.

Output exactly this JSON shape:
{"questions": [{"id": "short-kebab-slug", "question": "...", "options": ["...", "..."]}]}`;
}

function slugify(s: string, used: Set<string>): string {
  const base =
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "question";
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/** Defensive parse of generated questions. [] is a legitimate result; null = unparseable. */
export function parseIntakeQuestions(raw: string): IntakeQuestion[] | null {
  const obj = extractJsonObject(raw);
  if (!obj || !Array.isArray(obj.questions)) return null;
  const used = new Set(["level", "research"]);
  const out: IntakeQuestion[] = [];
  for (const item of obj.questions.slice(0, 2)) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.question !== "string" || !o.question.trim()) continue;
    if (!Array.isArray(o.options)) continue;
    const seen = new Set<string>();
    const options: IntakeOption[] = [];
    for (const opt of o.options) {
      if (typeof opt !== "string") continue;
      const label = opt.trim();
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      options.push({ value: label, label });
    }
    if (options.length < 3) continue;
    const id = slugify(typeof o.id === "string" && o.id.trim() ? o.id : o.question, used);
    out.push({ id, question: o.question.trim().slice(0, 120), options: options.slice(0, 5), allowsCustom: true });
  }
  return out;
}

// ---------- answer effects ----------

const LEVEL_TUNING: Record<IntakeLevel, string> = {
  fundamental: `The teacher is newer to this subject themselves. Calibrate for that: misconceptions
should be the fundamental confusions every beginner hits — the kind an introductory FAQ
addresses — and "partial" entries should stay at surface level. Avoid subtleties only an
expert could untangle.`,
  // "standard" is the baseline — adds nothing so default answers produce
  // byte-identical prompts to the pre-intake behavior.
  standard: "",
  challenge: `The teacher knows this subject inside out. Calibrate for that: misconceptions should be
subtler and deeper — the kind that survive a first course and take real expertise to
untangle — and "partial" entries may sit at an intermediate level. Avoid confusions a
one-paragraph answer would fix.`,
};

export function intakeFocus(answers: IntakeAnswers): string | null {
  const parts = Object.values(answers.focus)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Calibration block for the learning-state generation prompts. "" when nothing to say. */
export function buildIntakeTuning(answers: IntakeAnswers): string {
  const parts: string[] = [];
  if (answers.level && LEVEL_TUNING[answers.level]) parts.push(LEVEL_TUNING[answers.level]);
  if (answers.levelNote) {
    parts.push(`The teacher described their own footing in this subject as: "${answers.levelNote}". Calibrate
the depth of the misconceptions and partial knowledge accordingly.`);
  }
  const focus = intakeFocus(answers);
  if (focus) {
    parts.push(`The teacher plans to focus the session on: ${focus}. Weight the inventory toward that focus.`);
  }
  return parts.join("\n\n");
}
