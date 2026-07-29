import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "../appserver/client.js";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { extractPdfPageTexts } from "./extract.js";
import { extractJsonObject } from "./learning.js";
import { renderPdfPageImages } from "./pdf-images.js";
import { splitProsePages, stripInlineMarkdown } from "./prose.js";
import type { Notebook, NotebookStore, ReadingAnnotation, ReadingAnnotationKind, ReadingLevel, ReadingSession } from "./store.js";
import type { SettingsStore } from "./settings.js";

/**
 * Guided reading: a one-shot AI pass over a document — a PDF's per-page text
 * or a prose (markdown/text) source's pseudo-pages — that marks the
 * load-bearing passages where the learner should run the deep-processing loop
 * (a primary move plus follow-ups; kb: deep-processing-loop), preceded by
 * priming questions and followed by post-reading suggestions. The prompts
 * scaffold thinking and NEVER contain answers (kb: scaffolds-to-independence),
 * and the amount of scaffolding fades with the chosen level.
 *
 * Anchoring is text-quote based: every annotation carries an exact snippet of
 * the page's text; the client matches it against the PDF.js text layer (or
 * the rendered prose blocks). Prose anchors are projected to VISIBLE text
 * server-side (stripInlineMarkdown) since the model quotes raw markdown.
 * Anchors that don't verify against the page text are dropped server-side (a
 * highlight that can't land is worse than none). Generation is async: the
 * session persists as "generating" and flips to "ready"/"failed".
 */

/** Accepted generation kinds — "pause" is legacy-only (the card IS the pause). */
const KINDS: ReadingAnnotationKind[] = ["simplify", "compare", "connect", "judge", "apply", "technique"];

/** Per one-shot-call char budget over page texts; long documents get batched. */
const BATCH_CHAR_BUDGET = 45_000;
const ONE_SHOT_TIMEOUT_MS = 180_000;
const MAX_ANNOTATIONS = 60;
/** Page-image caps: enough for a paper or deck section, bounded for huge docs. */
const MAX_IMAGE_PAGES = 24;
const MAX_IMAGES_PER_BATCH = 12;

/** Annotation density guidance per level (kb: scaffolds-to-independence). */
const LEVEL_RULES: Record<ReadingLevel, string> = {
  beginner: `LEVEL: BEGINNER (full scaffolding). Mark every load-bearing passage — roughly 2-4
annotations per content-dense page, fewer on sparse pages, none where nothing is
load-bearing. Most annotations should carry 1-2 followUps so the learner runs several
loop moves on each key point, not just one. Prompts are concrete and instructional
("Re-explain X in your own words before reading on."); follow-ups chain naturally from
the primary move.`,
  intermediate: `LEVEL: INTERMEDIATE (reduced scaffolding). Mark only the most load-bearing passages —
roughly 1 annotation per content-dense page, none on sparse ones. Prompts name the
thinking move but leave the how to the learner ("This is a judging point — what matters
most here, and why?"). Use followUps sparingly: at most one, and only where the passage
anchors a large part of the document. The learner should be finding some key points
themselves.`,
  experienced: `LEVEL: EXPERIENCED (minimal scaffolding). The learner finds key information themselves.
Mark at most 3-5 passages in the WHOLE document — only ones where a reader is likely to
miss something that the rest of the document depends on (a buried assumption, a
deceptively skippable definition, a judging point that changes the meaning of everything
after it). Prompts are terse nudges ("Don't skim this — it's load-bearing."). No
followUps. Put your effort into the afterReading suggestions instead.`,
};

const READING_PROMPT_HEADER = `You are a learning coach preparing a guided reading of a document for a learner. Ground
truth from the knowledge base: memory forms in the ~15-30s working-memory window, so key
information must be digested the moment it is met — everything consumed must be digested
(PACER). Your job is to choose the FEW passages that carry this document and tell the
learner exactly what thinking to do at each one.

STEP 1 — FIND THE BACKBONE (before choosing any anchor):
Work out the document's main claim or purpose, the 3-6 moves its structure makes, and
its load-bearing points: core claims, definitions later material depends on, key
relationships between ideas, turning points in the argument, surprising or
counterintuitive results. Importance is relational — a passage matters because of what
depends on it. Apply this test to every candidate anchor: "if the reader missed this,
would their understanding of the whole document break?" If not, do not annotate it.
NEVER anchor examples, transitions, restatements, or filler — those are what key points
are explained WITH, not the keys.

STEP 2 — CLASSIFY the passage, then pick the primary move (PACER):
- Conceptual (facts, theories, relationships — the "what") → simplify, connect, or judge.
- Analogous (resembles something the learner already knows, or a pattern from earlier in
  the document) → compare — and make them critique the analogy: where does it break down?
- Procedural (how to do something) → apply: have them use or rehearse it right now.
- Evidence (statistics, cases, results that make a concept concrete) → judge: what does
  this number or case actually establish, and how strongly?
- Reference details (constants, identifiers, parameter lists) → never annotate; reading
  time does not go there.

STEP 3 — WRITE THE PROMPTS (the deep-processing loop):
The loop — simplify, compare, connect, group, judge — runs as a WHOLE on each key piece,
not one move per piece. So an annotation has a primary "kind" plus optional "followUps":
1-2 short chained questions applying DIFFERENT moves to the same passage (e.g. kind
simplify: "Re-say this in one plain sentence.", followUps: "How does it differ from X on
the previous page?", "Why does the argument need it?"). Rules:
- Prompts are QUESTIONS or INSTRUCTIONS that make the learner think. NEVER include the
  answer, a summary, or an explanation of the passage — the learner must do that work.
- The annotation IS the pause — never write "Pause here" or "Stop and think"; say only
  what to DO. Main prompt under ~20 words; each follow-up under ~15.
- "kind" must be one of: simplify, compare, connect, judge, apply, technique.
- "technique" is for a named technique where it genuinely fits: sketch a quick map of a
  relationship-dense section, GROUP an accumulating list of ideas into 2-3 named
  clusters, make an analogy and critique it, do a 30-second brain dump after a dense
  stretch.
- "anchor" must be an EXACT, VERBATIM quote of 4-15 consecutive words copied from that
  page's text (it becomes the highlight — it must match character-for-character; prefer
  distinctive phrases, avoid ones that appear multiple times).

ALSO PRODUCE:
- "afterReading": 3-5 concrete post-reading actions for THIS document (a retrieval
  attempt, mapping it from memory, teach-back, real application), each one sentence.

Output JSON only — no prose, no code fences. Omit "priming" unless instructed below;
"followUps" is optional:
{"priming":["<question>"],"annotations":[{"page":<1-based page number>,"anchor":"<exact quote>","kind":"<kind>","prompt":"<prompt>","followUps":["<question>"]}],"afterReading":["<suggestion>", ...]}`;

/** Level-dependent priming instruction (kb: priming-pre-study; fades with level). */
function primingNote(level: ReadingLevel): string {
  if (level === "experienced") {
    return `

Also produce "priming": exactly 1 item telling the learner to prime themselves — skim the
structure and pose the three priming questions (why does this matter / how would I use it /
what's the main point, simply) on their own — in one sentence.`;
  }
  return `

Also produce "priming": 2-3 before-you-read questions for THIS document — document-specific
versions of "why does this matter", "how would you use it", "what is the main point in its
simplest form" — plus one line on the structure to expect. The learner reads these before
starting, to build the schema the details will hang on.`;
}

/**
 * Deterministic document skeleton so CONCURRENT batches judge importance
 * against the same big picture (each batch only sees its own pages): heading
 * lines for prose, the first non-empty line per page for PDFs.
 */
function buildOutline(pages: string[], docType: "pdf" | "prose"): string | null {
  const lines: string[] = [];
  pages.forEach((text, i) => {
    if (docType === "prose") {
      for (const line of text.split("\n")) {
        if (/^#{1,6}\s/.test(line)) lines.push(`p${i + 1}: ${stripInlineMarkdown(line).slice(0, 80)}`);
      }
    } else {
      const first = text.split("\n").find((l) => l.trim().length > 0);
      if (first) lines.push(`p${i + 1}: ${first.trim().slice(0, 80)}`);
    }
  });
  const capped = lines.slice(0, 40);
  const joined = capped.join("\n").slice(0, 1500);
  return joined.trim().length > 0 ? joined : null;
}

function buildBatchPrompt(
  nb: Notebook,
  level: ReadingLevel,
  pages: string[],
  startPage: number,
  batch: string[],
  imageCount: number,
  opts: { docType: "pdf" | "prose"; outline: string | null; includePriming: boolean },
): string {
  const pageBlocks = batch
    .map((text, i) => `--- PAGE ${startPage + i} ---\n${text.trim() || "(no extractable text on this page)"}`)
    .join("\n\n");
  const context = nb.goal ?? nb.topic ?? nb.title;
  const imagesNote =
    imageCount > 0
      ? `

Attached are rendered images of pages ${startPage}-${startPage + imageCount - 1}, in order. Use
them to SEE what text extraction drops: figures, diagrams, charts, equations, slide layouts.
When a visual deserves the learner's attention, add an annotation about it — the prompt should
address the visual ("the diagram of X on this page…"), the kind is usually connect, judge or
apply, and the anchor must still be an exact quote of nearby text (the figure caption, or the
closest distinctive line on that page) since highlights attach to text.`
      : "";
  const proseNote =
    opts.docType === "prose"
      ? `

The "text pages" are sections of one continuous document (a web article, transcript, or
notes) written in markdown. Quote anchors as the READER SEES THE TEXT: never include
markdown syntax characters (#, *, _, backticks, image/link URLs) — quote the visible
words only — and never let an anchor span two paragraphs.`
      : "";
  const outlineNote = opts.outline
    ? `

DOCUMENT OUTLINE (for judging importance — you are annotating only your assigned pages,
but weigh them against the whole):
${opts.outline}`
    : "";
  return `${READING_PROMPT_HEADER}

${LEVEL_RULES[level]}${opts.includePriming ? primingNote(level) : ""}

The learner is studying: ${context}.${proseNote}${outlineNote}
This batch covers pages ${startPage}-${startPage + batch.length - 1} of ${pages.length}. Annotate ONLY these pages.${imagesNote}

${pageBlocks}`;
}

/** Whitespace-insensitive check that the anchor really occurs in the page text. */
function anchorOccursIn(anchor: string, pageText: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(pageText).includes(norm(anchor));
}

function parseBatchOutput(
  raw: string,
  pages: string[],
  startPage: number,
  batchLen: number,
  opts: { prose: boolean; level: ReadingLevel },
): { annotations: ReadingAnnotation[]; afterReading: string[]; priming: string[] } {
  const obj = extractJsonObject(raw);
  const annotations: ReadingAnnotation[] = [];
  const afterReading: string[] = [];
  const priming: string[] = [];
  if (!obj) return { annotations, afterReading, priming };

  if (Array.isArray(obj.annotations)) {
    for (const a of obj.annotations) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const page = Math.floor(Number(rec.page));
      // Prose: the model quotes raw markdown but the reader sees rendered
      // text — store and verify the VISIBLE projection of the anchor.
      const rawAnchor = typeof rec.anchor === "string" ? rec.anchor.trim() : "";
      const anchor = opts.prose ? stripInlineMarkdown(rawAnchor) : rawAnchor;
      const kind = rec.kind as ReadingAnnotationKind;
      const prompt = typeof rec.prompt === "string" ? rec.prompt.trim() : "";
      if (!Number.isFinite(page) || page < startPage || page >= startPage + batchLen) continue;
      if (!anchor || anchor.length < 8 || anchor.length > 300 || !prompt || !KINDS.includes(kind)) continue;
      const pageText = pages[page - 1] ?? "";
      const landed = opts.prose
        ? anchorOccursIn(anchor, stripInlineMarkdown(pageText)) || anchorOccursIn(anchor, pageText)
        : anchorOccursIn(anchor, pageText);
      if (!landed) continue; // a highlight that can't land is worse than none
      // The loop runs as a whole per key piece — but scaffolds fade: no
      // follow-ups at the experienced level regardless of what the model sent.
      const followUps =
        opts.level !== "experienced" && Array.isArray(rec.followUps)
          ? rec.followUps
              .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
              .slice(0, 2)
              .map((f) => f.trim().slice(0, 200))
          : [];
      annotations.push({
        id: randomUUID(),
        page,
        anchor,
        kind,
        prompt: prompt.slice(0, 600),
        ...(followUps.length > 0 ? { followUps } : {}),
      });
    }
  }
  if (Array.isArray(obj.afterReading)) {
    for (const s of obj.afterReading) {
      if (typeof s === "string" && s.trim()) afterReading.push(s.trim().slice(0, 400));
    }
  }
  if (Array.isArray(obj.priming)) {
    for (const s of obj.priming.slice(0, 3)) {
      if (typeof s === "string" && s.trim()) priming.push(s.trim().slice(0, 300));
    }
  }
  return { annotations, afterReading, priming };
}

/** Sessions currently generating in this process — crash recovery marks orphans failed. */
const generatingNow = new Set<string>();

export function isGenerationOrphaned(rs: ReadingSession): boolean {
  return rs.status === "generating" && !generatingNow.has(rs.id);
}

/**
 * Create a reading session and start the async annotation pass. Returns the
 * persisted "generating" session immediately; generation flips it to
 * "ready"/"failed" through the per-notebook save chain.
 */
export async function createReadingSession(
  client: AppServerClient,
  store: NotebookStore,
  settings: SettingsStore,
  nb: Notebook,
  storedName: string,
  level: ReadingLevel,
): Promise<ReadingSession> {
  const file = nb.sourceFiles.find((f) => f.storedName === storedName);
  if (!file) throw new HttpError(404, "source_not_found");
  const isPdf = file.storedName.toLowerCase().endsWith(".pdf");
  const isProse =
    !isPdf &&
    (/\.(md|txt)$/i.test(file.storedName) || file.mimeType === "text/markdown" || file.mimeType === "text/plain");
  if (!isPdf && !isProse) {
    throw new HttpError(400, "unsupported_source", "Guided reading works with PDF, web, and text sources.");
  }
  if (isPdf && !file.extractedName) {
    throw new HttpError(400, "pdf_not_readable", "This PDF has no extractable text (it may be scanned).");
  }
  if ((nb.readingSessions ?? []).some((rs) => rs.status === "generating" && generatingNow.has(rs.id))) {
    throw new HttpError(409, "reading_generation_active", "A guided reading is already being prepared.");
  }

  // Prose: split into pseudo-pages NOW and store them — the client renders
  // the document immediately (while annotations generate) from this split,
  // and generation anchors against exactly the same pages.
  let textPages: string[] | undefined;
  if (isProse) {
    const raw = await fs.readFile(path.join(store.sourcesDir(nb.id), storedName), "utf8").catch(() => "");
    if (raw.trim().length < 200) {
      throw new HttpError(400, "source_too_short", "This source has too little text for a guided reading.");
    }
    textPages = splitProsePages(raw);
  }

  const now = new Date().toISOString();
  const session: ReadingSession = {
    id: randomUUID(),
    source: storedName,
    level,
    status: "generating",
    ...(isProse ? { docType: "prose" as const, textPages } : { docType: "pdf" as const }),
    annotations: [],
    afterReading: [],
    createdAt: now,
    updatedAt: now,
  };
  nb.readingSessions = [...(nb.readingSessions ?? []), session];
  await store.save(nb);

  generatingNow.add(session.id);
  void runGeneration(client, store, settings, nb.id, session.id, storedName, level)
    .catch((err) => console.error(`[aria] reading generation crashed for session ${session.id}:`, err))
    .finally(() => generatingNow.delete(session.id));

  return session;
}

async function runGeneration(
  client: AppServerClient,
  store: NotebookStore,
  settings: SettingsStore,
  notebookId: string,
  sessionId: string,
  storedName: string,
  level: ReadingLevel,
): Promise<void> {
  const finish = async (patch: Partial<ReadingSession>) => {
    const nb = store.get(notebookId);
    const rs = nb?.readingSessions?.find((r) => r.id === sessionId);
    if (!nb || !rs) return; // session or notebook deleted mid-generation
    Object.assign(rs, patch, { updatedAt: new Date().toISOString() });
    await store.save(nb);
  };

  try {
    const nb = store.get(notebookId);
    if (!nb) return;
    const session = nb.readingSessions?.find((r) => r.id === sessionId);
    const docType: "pdf" | "prose" = session?.docType === "prose" ? "prose" : "pdf";
    const pages =
      docType === "prose"
        ? (session?.textPages ?? null)
        : await extractPdfPageTexts(path.join(store.sourcesDir(notebookId), storedName));
    if (!pages || pages.length === 0) {
      await finish({ status: "failed", error: "Couldn't extract text from this document." });
      return;
    }

    // Batch pages so each one-shot call stays within a sane prompt budget.
    const batches: { startPage: number; texts: string[] }[] = [];
    let current: string[] = [];
    let currentStart = 1;
    let currentChars = 0;
    pages.forEach((text, i) => {
      if (current.length > 0 && currentChars + text.length > BATCH_CHAR_BUDGET) {
        batches.push({ startPage: currentStart, texts: current });
        current = [];
        currentStart = i + 1;
        currentChars = 0;
      }
      current.push(text);
      currentChars += text.length;
    });
    if (current.length > 0) batches.push({ startPage: currentStart, texts: current });

    // Page images give the model eyes for figures/diagrams/slides; fail-open,
    // capped, cleaned up after the calls land — PDFs only (prose has no render).
    const wantedPages =
      docType === "pdf" ? batches.flatMap((b) => b.texts.map((_, i) => b.startPage + i)).slice(0, MAX_IMAGE_PAGES) : [];
    const { dir: imageDir, images } =
      docType === "pdf"
        ? await renderPdfPageImages(path.join(store.sourcesDir(notebookId), storedName), wantedPages)
        : { dir: null, images: new Map<number, string>() };

    const outline = batches.length > 1 ? buildOutline(pages, docType) : null;
    const s = settings.get();
    const t0 = Date.now();
    const annotations: ReadingAnnotation[] = [];
    const afterByBatch: string[][] = batches.map(() => []);

    try {
      // Batches run CONCURRENTLY (independent ephemeral one-shots), and each
      // batch's annotations persist as soon as it lands — the reading view
      // polls, so prompts appear incrementally instead of all at the end.
      const results = await Promise.allSettled(
        batches.map(async (batch, bi) => {
          const batchImages = batch.texts
            .map((_, i) => images.get(batch.startPage + i))
            .filter((p): p is string => p !== undefined)
            .slice(0, MAX_IMAGES_PER_BATCH);
          const run = (withImages: boolean) =>
            client.runOneShotTurn({
              prompt: buildBatchPrompt(nb, level, pages, batch.startPage, batch.texts, withImages ? batchImages.length : 0, {
                docType,
                outline,
                includePriming: batch.startPage === 1,
              }),
              model: s.model,
              effort: config.readingEffort,
              cwd: store.sourcesDir(notebookId),
              timeoutMs: ONE_SHOT_TIMEOUT_MS,
              images: withImages ? batchImages : undefined,
            });
          let raw: string;
          try {
            raw = await run(batchImages.length > 0);
          } catch (err) {
            if (batchImages.length === 0) throw err;
            // Image inputs are newer protocol surface — degrade to text-only
            // rather than failing the batch.
            console.error(`[aria] reading: batch with images failed, retrying text-only:`, err instanceof Error ? err.message : err);
            raw = await run(false);
          }
          const parsed = parseBatchOutput(raw, pages, batch.startPage, batch.texts.length, { prose: docType === "prose", level });
          annotations.push(...parsed.annotations);
          afterByBatch[bi] = parsed.afterReading;
          annotations.sort((a, b) => a.page - b.page);
          await finish({
            annotations: annotations.slice(0, MAX_ANNOTATIONS),
            ...(parsed.priming.length > 0 ? { priming: parsed.priming } : {}),
          }); // incremental delivery
        }),
      );
      if (results.every((r) => r.status === "rejected")) {
        const first = results[0] as PromiseRejectedResult | undefined;
        throw first?.reason instanceof Error ? first.reason : new Error("annotation pass failed");
      }
    } finally {
      if (imageDir) await fs.rm(imageDir, { recursive: true, force: true }).catch(() => {});
    }

    // The last batch's suggestions win (it has seen the document's end).
    const afterReading = [...afterByBatch].reverse().find((a) => a.length > 0) ?? [];

    annotations.sort((a, b) => a.page - b.page);
    console.log(
      `[aria] reading: ${annotations.length} annotation(s) across ${pages.length} page(s) (${images.size} page image(s)) for session ${sessionId} in ${Date.now() - t0}ms`,
    );
    if (annotations.length === 0 && afterReading.length === 0) {
      await finish({ status: "failed", error: "The coach couldn't prepare this reading. Try again." });
      return;
    }
    await finish({ status: "ready", annotations: annotations.slice(0, MAX_ANNOTATIONS), afterReading });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    await finish({ status: "failed", error: message }).catch(() => {});
  }
}
