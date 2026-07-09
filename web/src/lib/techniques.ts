/**
 * Technique-name annotation for coach messages: known study-technique terms
 * get wrapped as `[term](#tech-slug)` so the markdown renderer can turn them
 * into highlighted, hoverable chips (like the guided-reading highlights, but
 * in chat). Each entry carries WHY the technique works and WHEN to reach for
 * it — one-line distillations of the kb/ docs, shown in the hover tooltip.
 */

export interface TechniqueInfo {
  slug: string;
  /** Human-readable name shown as the tooltip title. */
  label: string;
  /** Word-boundary, case-insensitive alternatives that name the technique. */
  pattern: string;
  /** Why it works / what it buys you. */
  why: string;
  /** When to reach for it (trigger conditions / learning stage). */
  when: string;
}

// Longer/more specific patterns first — first match wins per slug per message.
export const TECHNIQUES: TechniqueInfo[] = [
  {
    slug: "deep-processing",
    label: "Deep processing loop",
    pattern:
      "pause[,–-]?\\s*simplify[,–-]?\\s*compare[,–-]?\\s*connect(?:[,–-]?\\s*(?:group[,–-]?\\s*)?(?:and\\s+)?judge)?|deep[- ]processing(?: loop)?",
    why: "Memory forms in the ~15–30s working-memory window — processing information the moment you meet it (re-say it plainly, compare, link it, judge what matters) is what encodes it.",
    when: "On every key piece of information while reading or listening — especially dense, confusing, or exam-likely ideas.",
  },
  {
    slug: "closed-book-summarization",
    label: "Closed-book summarization",
    pattern: "closed[- ]book summar\\w+|sneaky plagiarism",
    why: "Summarizing from memory is free retrieval, and restructuring (not shortening) forces you to reorganize the ideas — both strengthen the network.",
    when: "Consolidating after a reading or lecture; condensing notes before an exam; whenever you're tempted to 'summarize' with the book open.",
  },
  {
    slug: "distraction-cheat-sheet",
    label: "Distraction cheat sheet",
    pattern: "distraction cheat[- ]?sheet",
    why: "You can't remove distractors you haven't named — logging each flow-break reveals your personal list, including 'someone might interrupt me' type distractors people never fix.",
    when: "First step whenever focus sessions keep breaking down; repeat until the list stops growing.",
  },
  {
    slug: "delayed-note-taking",
    label: "Delayed note-taking",
    pattern: "delayed note[- ]?taking",
    why: "Widening the gap between hearing and writing pushes the brain out of transcription into organizing mode — the organizing is the learning.",
    when: "Lectures and reading whenever you catch yourself copying continuously; the on-ramp to mind mapping.",
  },
  {
    slug: "worked-examples",
    label: "Worked examples → practice",
    pattern: "worked[- ]examples?(?:\\s*(?:→|->|then)\\s*(?:faded )?practice)?",
    why: "Novices learn a problem type fastest by studying solved examples (no working memory wasted on blind search) — but the effect reverses once the basics click.",
    when: "First exposure to a new problem type; switch to solving problems yourself the moment examples feel obvious.",
  },
  {
    slug: "practice-problems",
    label: "Practice problems / past papers",
    pattern: "practice (?:problems|questions|papers)|past[- ]papers?",
    why: "Solving under realistic conditions tests the knowledge in the exact form you'll need it, and every miss is a precise gap to study.",
    when: "After the basics are in place, through exam/performance prep — matched to the level and format you'll be tested at.",
  },
  {
    slug: "retrieval",
    label: "Retrieval practice (free recall)",
    pattern: "free recall|active recall|retrieval practice|brain[- ]?dump",
    why: "Pulling knowledge out of memory strengthens it far more than re-reading, and the gaps it exposes are your study plan. Free recall beats cued recall for transfer.",
    when: "Continuously — end of each week on that week's material, end of month on the month's. Exam results should never be a surprise.",
  },
  {
    slug: "spaced-repetition",
    label: "Flashcards & spaced repetition",
    pattern: "spaced? repetition|spaced retrieval|spacing effect|flashcards?|anki",
    why: "Spacing reviews out fights the forgetting curve efficiently — for exact, isolated facts. Cards can't build understanding, and every card is future review debt.",
    when: "Last resort, after encoding: the residue of genuinely arbitrary facts (terminology, formulas, doses). Never as the whole system.",
  },
  {
    slug: "interleaving",
    label: "Interleaving",
    pattern: "interleav\\w+",
    why: "Hitting the same topic from different cognitive angles keeps knowledge from locking onto one cue or format — that's what survives curveball questions.",
    when: "Review passes: never repeat the same method twice (answer questions → write questions → write the answer key → teach it).",
  },
  {
    slug: "mind-mapping",
    label: "Mind mapping (GRINDE)",
    pattern: "mind[- ]?map\\w*|GRINDE|chunk[- ]?map\\w*",
    why: "Knowledge lives in networks, not lists — the grouping, relating and judging you do while building the map IS the encoding (the map itself is a by-product).",
    when: "Conceptual material with many related parts: systems, theories, multi-lecture topics; also planning essays.",
  },
  {
    slug: "pacer",
    label: "PACER reading framework",
    pattern: "PACER",
    why: "Different information types need different digestion — practicing procedures, critiquing analogies, mapping concepts, and merely storing reference details stops you wasting deep effort on shallow facts.",
    when: "Any reading session: classify each piece as Procedural / Analogous / Conceptual / Evidence / Reference and act accordingly.",
  },
  {
    slug: "perrio",
    label: "PERRIO system",
    pattern: "PERRIO",
    why: "Learning is a pipeline — Priming, Encoding, Reference, Retrieval, Interleaving, Overlearning — and results are set by the weakest slot, not the strongest.",
    when: "Diagnosing a whole study system: find the empty or weak slot before optimizing anything else.",
  },
  {
    slug: "priming",
    label: "Priming (pre-study)",
    pattern: "priming|pre[- ]?stud\\w+|scoping",
    why: "The brain keeps what it can place — a quick big-picture pass builds the shelf so new details have somewhere to land instead of being discarded.",
    when: "Before any lecture, chapter, or new topic — 5–10 minutes of skimming structure and listing the main ideas.",
  },
  {
    slug: "teach-back",
    label: "Teach-back",
    pattern: "teach[- ]?back|teach it back|learn(?:ing)? by teaching",
    why: "Teaching forces free retrieval, ruthless simplification, and a coherent structure at once — the fastest way to find what you can't actually explain.",
    when: "After first exposure, when understanding feels 'probably fine' — press Teach it back and teach Aria; also great pre-exam consolidation.",
  },
  {
    slug: "ladder-method",
    label: "Ladder method",
    pattern: "ladder method",
    why: "Several low-effort passes beat one grinding pass: each pass's scaffold makes the previously-hard parts cheap, and no session ever feels heavy.",
    when: "Dense material, tired days, or any topic that triggers 'there's so much here' procrastination.",
  },
  {
    slug: "thinner-layers",
    label: "Thinner layers",
    pattern: "thinner layers",
    why: "Chopping a topic into isolated pieces destroys the connections that make it learnable; layering — easiest links first, detail on top — keeps the big picture intact.",
    when: "Overwhelm: many concepts that obviously relate but you can't see how (multi-lecture blocks, big chapters).",
  },
  {
    slug: "analogy-critique",
    label: "Analogy & critique",
    pattern: "analog(?:y|ies)(?: critique)?",
    why: "Building an analogy forces deep comparison with what you know; critiquing where it breaks forces re-examining the real structure — that critique is where most of the learning is.",
    when: "Abstract or mechanism-heavy concepts; whenever you 'sort of get it' but couldn't explain it.",
  },
  {
    slug: "peer-testing",
    label: "Peer testing",
    pattern: "peer testing|practice (?:exams?|tests?) for (?:each other|friends)",
    why: "Writing an exam from memory is retrieval plus judgment; swapping with friends multiplies practice papers, and answer disagreements mark deep, nuanced gaps.",
    when: "Group study and exam prep with 2–4 people on the same material — structured, with roles.",
  },
  {
    slug: "error-log",
    label: "Error log",
    pattern: "error log",
    why: "'Silly mistakes' are almost always real gaps — labeling each error's cause and drilling it turns your mistakes into a targeted syllabus.",
    when: "Whenever the same kinds of mistakes repeat in practice work, math, coding, or exams.",
  },
  {
    slug: "learning-log",
    label: "Learning log",
    pattern: "learning log",
    why: "You can only change 1–2 habits at a time; logging goal → strategy → result → next move stops practice from being random and compounds improvement.",
    when: "One 1–3 minute entry per study block; change strategy only when the bottleneck changes.",
  },
  {
    slug: "cognitive-load",
    label: "Cognitive load",
    pattern: "cognitive load",
    why: "All effective learning is effortful — low load means passive studying (a red flag), while overload (stuck, fog) produces nothing either. The zone just past comfort is where learning happens.",
    when: "Use it as a dashboard: bored/autopilot → make the work harder; stuck/rereading → shrink what you're holding and pause intake.",
  },
  {
    slug: "desirable-difficulty",
    label: "Desirable difficulty",
    pattern: "desirable difficult\\w+",
    why: "Productive struggle is the mechanism of learning, not a malfunction — people who mistake effort for ineffectiveness retreat to comfortable, useless methods.",
    when: "Whenever a good technique 'feels hard' or you're tempted to make learning easier; aim for meaningful mistakes, not comfort.",
  },
  {
    slug: "overlearning",
    label: "Overlearning",
    pattern: "overlearning",
    why: "Drilling past the required standard buys speed and effortless fluency — at a heavy time cost that's wasted if encoding is still weak.",
    when: "Only for elite bars (top-percentile exams, performance under pressure), and only as the LAST slot of the system.",
  },
  {
    slug: "encoding",
    label: "Encoding",
    pattern: "encoding",
    why: "Memory and understanding are by-products of organized networks — encode well the first time and the forgetting curve flattens, cancelling most future review.",
    when: "The long-game skill to build after enablers and retrieval are in place; the fix when you 'forget everything despite constant review'.",
  },
  {
    slug: "focus-training",
    label: "Focus training",
    pattern: "focus (?:muscle|training)|mindfulness meditation",
    why: "Focus is a trainable snap-back reflex, not willpower — daily reps of noticing drift and returning shrink your re-entry time until focus comes on command.",
    when: "10–15 min of mindfulness daily, after external distractors are removed; expect the payoff after ~a month, compounding for years.",
  },
  {
    slug: "attention-management",
    label: "Attention management",
    pattern: "attention management",
    why: "'No time' is usually misdirected attention — humans barely sense time, and schedules break, but deciding where your mind goes at each transition doesn't.",
    when: "When schedules never stick, and for mobilizing dead space (commutes, queues) with attention-only work like planning or review.",
  },
];

const BY_SLUG = new Map(TECHNIQUES.map((t) => [t.slug, t]));

export function techniqueInfo(slug: string): TechniqueInfo | undefined {
  return BY_SLUG.get(slug);
}

/** Fenced blocks and inline code must never be rewritten. */
const CODE_SPLIT = /(```[\s\S]*?```|`[^`\n]*`)/g;

/**
 * Wrap the first occurrence of each known technique term as
 * `[term](#tech-slug)`. Idempotent enough for chat text; code segments are
 * left untouched.
 */
export function annotateTechniques(text: string): string {
  const seen = new Set<string>();
  return text
    .split(CODE_SPLIT)
    .map((segment, i) => {
      if (i % 2 === 1) return segment; // code segment
      let out = segment;
      for (const t of TECHNIQUES) {
        if (seen.has(t.slug)) continue;
        const re = new RegExp(`\\b(${t.pattern})\\b`, "i");
        const m = re.exec(out);
        if (!m) continue;
        // Don't annotate inside an existing markdown link label.
        const before = out.slice(0, m.index);
        if ((before.match(/\[/g)?.length ?? 0) > (before.match(/\]/g)?.length ?? 0)) continue;
        seen.add(t.slug);
        out = `${before}[${m[0]}](#tech-${t.slug})${out.slice(m.index + m[0].length)}`;
      }
      return out;
    })
    .join("");
}
