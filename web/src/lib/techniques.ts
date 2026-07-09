/**
 * Technique-name annotation for coach messages: known study-technique terms
 * get wrapped as `[term](#tech-slug)` so the markdown renderer can turn them
 * into highlighted, hoverable chips (like the guided-reading highlights, but
 * in chat). Each entry carries WHAT the technique is, WHY it works and WHEN
 * to reach for it — one-liners distilled from the kb/ docs, shown in the
 * hover tooltip. `**bold**` marks the key words the tooltip emphasizes.
 */

export interface TechniqueInfo {
  slug: string;
  /** Human-readable name shown as the tooltip title. */
  label: string;
  /** Word-boundary, case-insensitive alternatives that name the technique. */
  pattern: string;
  /** What it is — a plain one-line definition. */
  what: string;
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
    what: "A mental habit run on every key idea: **pause**, **simplify** it in your own words, **compare** it to what you know, **connect** it to the big picture, **judge** what matters most.",
    why: "Memory forms in a **15–30 second window** — working with an idea the moment you meet it is what stores it; passively reading past it is what loses it.",
    when: "**While reading or listening**, on ideas that are important, confusing, or exam-likely.",
  },
  {
    slug: "closed-book-summarization",
    label: "Closed-book summarization",
    pattern: "closed[- ]book summar\\w+|sneaky plagiarism",
    what: "Summarizing **from memory** — book closed — and **restructuring** the material instead of shortening it.",
    why: "Recalling is **free retrieval** and reorganizing forces real processing; open-book condensing is just editing.",
    when: "**After** a reading or lecture; before exams; any time you're tempted to 'summarize' with the source open.",
  },
  {
    slug: "distraction-cheat-sheet",
    label: "Distraction cheat sheet",
    pattern: "distraction cheat[- ]?sheet",
    what: "A paper beside you during focused work where you **log every distraction** that pulls you out.",
    why: "You can't remove distractors you haven't **named** — the list reveals your personal pattern, including 'someone might interrupt me' ones people never fix.",
    when: "**First step** whenever focus sessions keep breaking down; repeat until the list stops growing.",
  },
  {
    slug: "delayed-note-taking",
    label: "Delayed note-taking",
    pattern: "delayed note[- ]?taking",
    what: "Listening or reading for **minutes before writing anything**, then noting less, structurally.",
    why: "The delay pushes your brain out of **transcribing** into **organizing** — and the organizing is the learning.",
    when: "Lectures and reading, whenever you catch yourself **copying continuously**.",
  },
  {
    slug: "worked-examples",
    label: "Worked examples → practice",
    pattern: "worked[- ]examples?(?:\\s*(?:→|->|then)\\s*(?:faded )?practice)?",
    what: "Studying **solved example problems** step-by-step before attempting problems yourself.",
    why: "Novices learn a problem type fastest from examples (no working memory burned on blind search) — but the benefit **reverses once basics click**.",
    when: "**First exposure** to a new problem type; switch to solving problems the moment examples feel obvious.",
  },
  {
    slug: "practice-problems",
    label: "Practice problems / past papers",
    pattern: "practice (?:problems|questions|papers)|past[- ]papers?",
    what: "Solving **real questions under realistic conditions** and studying what your misses reveal.",
    why: "It tests knowledge in the **exact form you'll need it**, and every miss is a precise gap to fix.",
    when: "After the basics, through **exam or performance prep** — matched to the level you'll be tested at.",
  },
  {
    slug: "retrieval",
    label: "Retrieval practice (free recall)",
    pattern: "free recall|active recall|retrieval practice|brain[- ]?dump",
    what: "**Pulling knowledge out of memory** without looking — writing or explaining everything you remember.",
    why: "The act of recalling **strengthens the memory** far more than re-reading, and the gaps it exposes become your study plan.",
    when: "**Continuously** — end of each week on that week's material. Exam results should never be a surprise.",
  },
  {
    slug: "spaced-repetition",
    label: "Flashcards & spaced repetition",
    pattern: "spaced? repetition|spaced retrieval|spacing effect|flashcards?|anki",
    what: "**Card-based drills** repeated at growing intervals (e.g. Anki).",
    why: "Spacing fights the forgetting curve efficiently — for **exact, isolated facts**. Cards can't build understanding, and every card is future review **debt**.",
    when: "**Last resort, after encoding**: the residue of genuinely arbitrary facts (terminology, formulas). Never the whole system.",
  },
  {
    slug: "interleaving",
    label: "Interleaving",
    pattern: "interleav\\w+",
    what: "Covering the same topic through **different cognitive angles** — answer questions, write questions, write the answer key, teach it.",
    why: "Varied angles keep knowledge from **locking onto one cue or format** — that's what survives curveball questions.",
    when: "**Review passes**: never repeat the same method twice in a row.",
  },
  {
    slug: "mind-mapping",
    label: "Mind mapping (GRINDE)",
    pattern: "mind[- ]?map\\w*|GRINDE|chunk[- ]?map\\w*",
    what: "**Nonlinear notes** that group related ideas, draw their relationships, and mark what matters most (GRINDE: Grouped, Relational, Interconnected, Nonverbal, Directional, Emphasized).",
    why: "Knowledge lives in **networks, not lists** — the grouping and judging you do while building the map IS the encoding; the map itself is a by-product.",
    when: "**Conceptual material** with many related parts: systems, theories, multi-lecture topics, essay planning.",
  },
  {
    slug: "pacer",
    label: "PACER reading framework",
    pattern: "PACER",
    what: "Classifying what you read as **P**rocedural, **A**nalogous, **C**onceptual, **E**vidence or **R**eference — and digesting each differently.",
    why: "Different information needs different handling — **practice** procedures, **critique** analogies, **map** concepts, just **store** reference details. Deep effort goes where it pays.",
    when: "**Any reading session** — textbook, paper, documentation.",
  },
  {
    slug: "perrio",
    label: "PERRIO system",
    pattern: "PERRIO",
    what: "The whole-system frame: **P**riming, **E**ncoding, **R**eference, **R**etrieval, **I**nterleaving, **O**verlearning.",
    why: "Learning is a pipeline — results are set by the **weakest slot**, not the strongest.",
    when: "**Diagnosing a study system**: find the empty slot before optimizing anything else.",
  },
  {
    slug: "priming",
    label: "Priming (pre-study)",
    pattern: "priming|pre[- ]?stud\\w+|scoping",
    what: "A quick **big-picture pass** before real studying — skim the structure, list the main ideas.",
    why: "The brain keeps what it can **place** — priming builds the shelf so new details land instead of being discarded.",
    when: "**Before** any lecture, chapter, or new topic — 5–10 minutes is enough.",
  },
  {
    slug: "teach-back",
    label: "Teach-back",
    pattern: "teach[- ]?back|teach it back|learn(?:ing)? by teaching",
    what: "**Explaining the topic from memory** to a student — here, the built-in AI student Aria — and fielding their questions.",
    why: "Teaching forces **free retrieval**, ruthless **simplification**, and a coherent structure at once — the fastest way to find what you can't actually explain.",
    when: "After first exposure, when understanding feels **'probably fine'**; also great pre-exam consolidation.",
  },
  {
    slug: "ladder-method",
    label: "Ladder method",
    pattern: "ladder method",
    what: "Several **low-effort passes** over the whole topic, taking only what feels easy each time.",
    why: "Each pass's scaffold makes the previously-hard parts cheap — and **no session ever feels heavy**.",
    when: "Dense material, **tired days**, or any topic that triggers 'there's so much here' procrastination.",
  },
  {
    slug: "thinner-layers",
    label: "Thinner layers",
    pattern: "thinner layers",
    what: "Breaking an overwhelming topic into **layers, not pieces**: connect the easiest ideas first, add detail on top.",
    why: "Chopping into isolated chunks destroys the **connections** that make material learnable; layering keeps the big picture intact.",
    when: "**Overwhelm**: many concepts that obviously relate but you can't see how.",
  },
  {
    slug: "analogy-critique",
    label: "Analogy & critique",
    pattern: "analog(?:y|ies)(?: critique)?",
    what: "Building an **analogy** to something you know — then **stress-testing where it breaks**.",
    why: "The analogy forces deep comparison; the critique forces re-examining the real structure — most of the learning is in the **critique**.",
    when: "**Abstract or mechanism-heavy concepts**; whenever you 'sort of get it' but couldn't explain it.",
  },
  {
    slug: "peer-testing",
    label: "Peer testing",
    pattern: "peer testing|practice (?:exams?|tests?) for (?:each other|friends)",
    what: "Friends **write practice exams for each other from memory**, swap, and discuss the differences.",
    why: "Writing an exam is retrieval plus judgment, swapping **multiplies practice papers**, and answer disagreements mark deep gaps.",
    when: "**Group study and exam prep** with 2–4 people on the same material — structured, with roles.",
  },
  {
    slug: "error-log",
    label: "Error log",
    pattern: "error log",
    what: "A running list of your mistakes with each one's **type and cause**, plus a targeted drill for it.",
    why: "'Silly mistakes' are almost always **real gaps** — logged and drilled, your mistakes become a personal syllabus.",
    when: "Whenever the **same kinds of mistakes repeat** in practice work or exams.",
  },
  {
    slug: "learning-log",
    label: "Learning log",
    pattern: "learning log",
    what: "One short entry per study block: **goal → strategy → result → next move**.",
    why: "You can only change **1–2 habits at a time** — logging stops practice from being random and compounds improvement.",
    when: "**Every study block**, 1–3 minutes; change strategy only when the bottleneck changes.",
  },
  {
    slug: "cognitive-load",
    label: "Cognitive load",
    pattern: "cognitive load",
    what: "The **mental effort** your working memory is spending right now.",
    why: "All effective learning is effortful — **low load means passive studying** (a red flag), while overload (stuck, fog) produces nothing either.",
    when: "Use it as a **dashboard**: bored → make the work harder; stuck → shrink what you're holding and pause intake.",
  },
  {
    slug: "desirable-difficulty",
    label: "Desirable difficulty",
    pattern: "desirable difficult\\w+",
    what: "The **productive struggle** just past your comfort zone — effortful, error-prone, and exactly right.",
    why: "Struggle is the **mechanism** of learning, not a malfunction; mistaking effort for ineffectiveness leads to comfortable, useless methods.",
    when: "Whenever a good technique **'feels hard'** or you're tempted to make learning easier.",
  },
  {
    slug: "overlearning",
    label: "Overlearning",
    pattern: "overlearning",
    what: "Drilling **past the required standard** — extra reps after you can already do it.",
    why: "It buys **speed and effortless fluency** — at a heavy time cost that's wasted if encoding is still weak.",
    when: "Only for **elite bars** (top-percentile exams, performance under pressure), and only as the last step.",
  },
  {
    slug: "encoding",
    label: "Encoding",
    pattern: "encoding",
    what: "**Organizing new information into a connected structure** during first exposure — the process that actually creates memory.",
    why: "Memory and understanding are **by-products of organization**; encode well once and the forgetting curve flattens, cancelling most review.",
    when: "The **long-game skill**; the fix when you 'forget everything despite constant review'.",
  },
  {
    slug: "focus-training",
    label: "Focus training",
    pattern: "focus (?:muscle|training)|mindfulness meditation",
    what: "Daily **mindfulness reps**: notice your mind drift, bring it back — each return is one rep of the focus muscle.",
    why: "Focus is a trainable **snap-back reflex**, not willpower; training shrinks your re-entry time until focus comes on command.",
    when: "**10–15 min daily**, after external distractors are removed; payoff after ~a month, compounding for years.",
  },
  {
    slug: "attention-management",
    label: "Attention management",
    pattern: "attention management",
    what: "Deciding **where your mind goes at each transition**, instead of scheduling the clock.",
    why: "'No time' is usually **misdirected attention** — schedules break, but intentional attention handoffs don't.",
    when: "When schedules never stick, and for mobilizing **dead space** (commutes, queues) with attention-only work.",
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
