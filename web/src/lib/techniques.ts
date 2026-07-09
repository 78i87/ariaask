/**
 * Technique-name annotation for coach messages: known study-technique terms
 * get wrapped as `[term](#tech-slug)` so the markdown renderer can turn them
 * into highlighted, hoverable chips (like the guided-reading highlights, but
 * in chat). Tips are one-line distillations of the kb/ docs.
 */

export interface TechniqueInfo {
  slug: string;
  /** Word-boundary, case-insensitive alternatives that name the technique. */
  pattern: string;
  tip: string;
}

// Longer/more specific patterns first — first match wins per slug per message.
export const TECHNIQUES: TechniqueInfo[] = [
  {
    slug: "deep-processing",
    pattern:
      "pause[,–-]?\\s*simplify[,–-]?\\s*compare[,–-]?\\s*connect(?:[,–-]?\\s*(?:group[,–-]?\\s*)?(?:and\\s+)?judge)?|deep[- ]processing(?: loop)?",
    tip: "The core encoding habit: stop consuming, re-say it plainly, compare it to what you know, link it to the big picture, then judge what matters most.",
  },
  {
    slug: "closed-book-summarization",
    pattern: "closed[- ]book summar\\w+|sneaky plagiarism",
    tip: "Summarize from memory (book closed) and restructure it so the original author wouldn't recognize it — retrieval plus reorganization.",
  },
  {
    slug: "distraction-cheat-sheet",
    pattern: "distraction cheat[- ]?sheet",
    tip: "Keep paper beside you during a focus session and log everything that pulls you out — then eliminate the distractors one by one.",
  },
  {
    slug: "delayed-note-taking",
    pattern: "delayed note[- ]?taking",
    tip: "Listen/read longer before writing anything, so your brain has to organize instead of transcribe. Then write less, structurally.",
  },
  {
    slug: "worked-examples",
    pattern: "worked[- ]examples?(?:\\s*(?:→|->|then)\\s*(?:faded )?practice)?",
    tip: "Study solved examples while a problem type is new; the moment they feel obvious, switch to solving problems yourself — the benefit reverses with skill.",
  },
  {
    slug: "practice-problems",
    pattern: "practice (?:problems|questions|papers)|past[- ]papers?",
    tip: "Solve under realistic conditions, then study exactly what your misses reveal — align practice with how you'll be tested.",
  },
  {
    slug: "retrieval",
    pattern: "free recall|active recall|retrieval practice|brain[- ]?dump",
    tip: "Pull knowledge out of memory without looking — the pulling itself strengthens it, and the gaps it exposes are your study plan.",
  },
  {
    slug: "spaced-repetition",
    pattern: "spaced? repetition|spaced retrieval|spacing effect|flashcards?|anki",
    tip: "Spaced drills for exact, isolated facts. Powerful but narrow — a last resort after encoding, never the whole system.",
  },
  {
    slug: "interleaving",
    pattern: "interleav\\w+",
    tip: "Hit the same topic from different cognitive angles (answer questions, write questions, write the answer key, teach) instead of repeating one method.",
  },
  {
    slug: "mind-mapping",
    pattern: "mind[- ]?map\\w*|GRINDE|chunk[- ]?map\\w*",
    tip: "Nonlinear notes that group, relate and connect ideas (GRINDE: Grouped, Relational, Interconnected, Nonverbal, Directional, Emphasized). The thinking builds the map; the map is a by-product.",
  },
  {
    slug: "pacer",
    pattern: "PACER",
    tip: "Classify what you read — Procedural, Analogous, Conceptual, Evidence, Reference — and digest each differently: practice it, critique it, map it, or just store it.",
  },
  {
    slug: "perrio",
    pattern: "PERRIO",
    tip: "The whole-system frame: Priming, Encoding, Reference, Retrieval, Interleaving, Overlearning. Fix the weakest slot, not the loudest.",
  },
  {
    slug: "priming",
    pattern: "priming|pre[- ]?stud\\w+|scoping",
    tip: "A quick big-picture pass before real studying — map the main ideas so new details have somewhere to attach.",
  },
  {
    slug: "teach-back",
    pattern: "teach[- ]?back|teach it back|learn(?:ing)? by teaching",
    tip: "Explain it from memory to a student (Aria, here) and field their questions — the fastest way to find what you can't actually explain.",
  },
  {
    slug: "ladder-method",
    pattern: "ladder method",
    tip: "Several low-effort passes over the whole topic, taking only what feels easy each time — the scaffold from pass one makes pass two cheap.",
  },
  {
    slug: "thinner-layers",
    pattern: "thinner layers",
    tip: "When overwhelmed, don't chop the topic into isolated pieces — connect the easiest ideas first and layer detail onto the growing structure.",
  },
  {
    slug: "analogy-critique",
    pattern: "analog(?:y|ies)(?: critique)?",
    tip: "Build an analogy to something you know, then stress-test where it breaks — the critique is where most of the learning happens.",
  },
  {
    slug: "peer-testing",
    pattern: "peer testing|practice (?:exams?|tests?) for (?:each other|friends)",
    tip: "Make practice exams for each other from memory, swap, and discuss where your answers diverge — the differences mark deep gaps.",
  },
  {
    slug: "error-log",
    pattern: "error log",
    tip: "Record each mistake with its type and cause, build a targeted drill for it, and retest later — 'silly mistakes' are real gaps.",
  },
  {
    slug: "learning-log",
    pattern: "learning log",
    tip: "One short entry per study block: goal, strategy, result/gap, next move. Change strategy only when the bottleneck changes.",
  },
  {
    slug: "cognitive-load",
    pattern: "cognitive load",
    tip: "Mental effort. Learning needs it high but within capacity — studying that feels easy is a red flag; feeling stuck means overload, not stupidity.",
  },
  {
    slug: "desirable-difficulty",
    pattern: "desirable difficult\\w+",
    tip: "The productive struggle just past your comfort zone — effort is the mechanism of learning, not a sign the method is failing.",
  },
  {
    slug: "overlearning",
    pattern: "overlearning",
    tip: "Drilling beyond the required standard for speed and fluency. Optional — only worth it for elite bars, and never the first move.",
  },
  {
    slug: "encoding",
    pattern: "encoding",
    tip: "Organizing new information into a connected structure during the first exposure — what actually creates memory. Weak encoding is what repetition tries (expensively) to patch.",
  },
  {
    slug: "focus-training",
    pattern: "focus (?:muscle|training)|mindfulness meditation",
    tip: "Daily reps of noticing your mind drift and bringing it back (10–15 min of mindfulness). Trains focus-on-command over ~a month.",
  },
  {
    slug: "attention-management",
    pattern: "attention management",
    tip: "Manage where your mind is, not the clock: intentional attention handoffs between tasks, and use dead time (commutes, queues) for attention-only work.",
  },
];

const TIP_BY_SLUG = new Map(TECHNIQUES.map((t) => [t.slug, t.tip]));

export function techniqueTip(slug: string): string | undefined {
  return TIP_BY_SLUG.get(slug);
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
