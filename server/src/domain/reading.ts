import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "../appserver/client.js";
import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { extractPdfPageTexts } from "./extract.js";
import { extractJsonObject } from "./learning.js";
import { renderPdfPageImages } from "./pdf-images.js";
import type { Notebook, NotebookStore, ReadingAnnotation, ReadingAnnotationKind, ReadingLevel, ReadingSession } from "./store.js";
import type { SettingsStore } from "./settings.js";

/**
 * Guided reading: a one-shot AI pass over a PDF source's per-page text that
 * marks the key passages where the learner should run the deep-processing
 * loop (pause / simplify / compare / connect / judge), apply the knowledge,
 * or reach for another technique — plus post-reading suggestions. The prompts
 * scaffold thinking and NEVER contain answers (kb: scaffolds-to-independence),
 * and the amount of scaffolding fades with the chosen level.
 *
 * Anchoring is text-quote based: every annotation carries an exact snippet of
 * the page's text; the client matches it against the PDF.js text layer.
 * Anchors that don't verify against the extracted page text are dropped
 * server-side (a highlight that can't land is worse than none). Generation is
 * async: the session persists as "generating" and flips to "ready"/"failed".
 */

const KINDS: ReadingAnnotationKind[] = ["pause", "simplify", "compare", "connect", "judge", "apply", "technique"];

/** Per one-shot-call char budget over page texts; long documents get batched. */
const BATCH_CHAR_BUDGET = 45_000;
const ONE_SHOT_TIMEOUT_MS = 180_000;
const MAX_ANNOTATIONS = 60;
/** Page-image caps: enough for a paper or deck section, bounded for huge docs. */
const MAX_IMAGE_PAGES = 24;
const MAX_IMAGES_PER_BATCH = 12;

/** Annotation density guidance per level (kb: scaffolds-to-independence). */
const LEVEL_RULES: Record<ReadingLevel, string> = {
  beginner: `LEVEL: BEGINNER (full scaffolding). Mark every genuinely key passage — roughly 2-4
annotations per content-dense page, fewer on sparse pages. Cover the full deep-processing
loop across the document (pause, simplify, compare, connect, judge), plus apply points and
occasional technique suggestions. Prompts are concrete and instructional ("Pause here.
Re-explain X in your own words before reading on.").`,
  intermediate: `LEVEL: INTERMEDIATE (reduced scaffolding). Mark only the most important passages —
roughly 1 annotation per content-dense page, none on sparse ones. Prompts name the thinking
move but leave the how to the learner ("This is a judging point — what matters most here,
and why?"). Skip obvious spots; the learner should be finding some key points themselves.`,
  experienced: `LEVEL: EXPERIENCED (minimal scaffolding). The learner finds key information themselves.
Mark at most 3-5 passages in the WHOLE document — only ones where a reader is likely to miss
something important (a buried assumption, a deceptively skippable definition, a judging point
that changes the meaning of everything after it). Prompts are terse nudges ("Don't skim this
— it's load-bearing."). Put your effort into the afterReading suggestions instead.`,
};

const READING_PROMPT_HEADER = `You are a learning coach preparing a guided reading of a document for a learner. Your
knowledge base: memory forms in the ~15-30s working-memory window, so the learner must
process key information the moment they meet it by running the deep-processing loop —
PAUSE (stop reading, digest), SIMPLIFY (re-explain plainly), COMPARE (against prior/other
knowledge), CONNECT (link into the bigger picture), JUDGE (decide what matters most /
challenge the structure). They should also APPLY knowledge at natural points, and
sometimes a specific TECHNIQUE fits (make an analogy and critique it, sketch a quick map
of a relationship-dense section, do a 30-second brain dump after a dense stretch).

You will receive the document's text, page by page. Choose the passages where the learner
should act, and write a prompt for each. Rules:
- Prompts are QUESTIONS or INSTRUCTIONS that make the learner think. NEVER include the
  answer, a summary, or an explanation of the passage — the learner must do that work.
- "kind" must be one of: pause, simplify, compare, connect, judge, apply, technique.
- "anchor" must be an EXACT, VERBATIM quote of 4-15 consecutive words copied from that
  page's text (it becomes the highlight — it must match character-for-character; prefer
  distinctive phrases, avoid ones that appear multiple times).
- Spread kinds appropriately: simplify at dense/jargon points, compare where two ideas
  resemble or contrast, connect where a detail links to the big picture, judge where
  importance/validity must be weighed, pause after dense stretches, apply where the
  knowledge could be used, technique where a named technique genuinely fits.
- Also produce "afterReading": 3-5 concrete post-reading suggestions (retrieval, mapping,
  teach-back, application — what to do to drill this home), each one sentence.

Output JSON only — no prose, no code fences:
{"annotations":[{"page":<1-based page number>,"anchor":"<exact quote>","kind":"<kind>","prompt":"<prompt>"}],"afterReading":["<suggestion>", ...]}`;

function buildBatchPrompt(
  nb: Notebook,
  level: ReadingLevel,
  pages: string[],
  startPage: number,
  batch: string[],
  imageCount: number,
): string {
  const pageBlocks = batch
    .map((text, i) => `--- PAGE ${startPage + i} ---\n${text.trim() || "(no extractable text on this page)"}`)
    .join("\n\n");
  const context = nb.topic ?? nb.title;
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
  return `${READING_PROMPT_HEADER}

${LEVEL_RULES[level]}

The learner is studying: ${context}.
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
): { annotations: ReadingAnnotation[]; afterReading: string[] } {
  const obj = extractJsonObject(raw);
  const annotations: ReadingAnnotation[] = [];
  const afterReading: string[] = [];
  if (!obj) return { annotations, afterReading };

  if (Array.isArray(obj.annotations)) {
    for (const a of obj.annotations) {
      if (typeof a !== "object" || a === null) continue;
      const rec = a as Record<string, unknown>;
      const page = Math.floor(Number(rec.page));
      const anchor = typeof rec.anchor === "string" ? rec.anchor.trim() : "";
      const kind = rec.kind as ReadingAnnotationKind;
      const prompt = typeof rec.prompt === "string" ? rec.prompt.trim() : "";
      if (!Number.isFinite(page) || page < startPage || page >= startPage + batchLen) continue;
      if (!anchor || anchor.length < 8 || anchor.length > 300 || !prompt || !KINDS.includes(kind)) continue;
      const pageText = pages[page - 1] ?? "";
      if (!anchorOccursIn(anchor, pageText)) continue; // a highlight that can't land is worse than none
      annotations.push({ id: randomUUID(), page, anchor, kind, prompt: prompt.slice(0, 600) });
    }
  }
  if (Array.isArray(obj.afterReading)) {
    for (const s of obj.afterReading) {
      if (typeof s === "string" && s.trim()) afterReading.push(s.trim().slice(0, 400));
    }
  }
  return { annotations, afterReading };
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
  if (!file.storedName.toLowerCase().endsWith(".pdf")) {
    throw new HttpError(400, "not_a_pdf", "Guided reading currently works with PDF sources.");
  }
  if (!file.extractedName) {
    throw new HttpError(400, "pdf_not_readable", "This PDF has no extractable text (it may be scanned).");
  }
  if ((nb.readingSessions ?? []).some((rs) => rs.status === "generating" && generatingNow.has(rs.id))) {
    throw new HttpError(409, "reading_generation_active", "A guided reading is already being prepared.");
  }

  const now = new Date().toISOString();
  const session: ReadingSession = {
    id: randomUUID(),
    source: storedName,
    level,
    status: "generating",
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
    const pages = await extractPdfPageTexts(path.join(store.sourcesDir(notebookId), storedName));
    if (!pages) {
      await finish({ status: "failed", error: "Couldn't extract text from this PDF." });
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
    // capped, and cleaned up after the calls land.
    const wantedPages = batches.flatMap((b) => b.texts.map((_, i) => b.startPage + i)).slice(0, MAX_IMAGE_PAGES);
    const { dir: imageDir, images } = await renderPdfPageImages(
      path.join(store.sourcesDir(notebookId), storedName),
      wantedPages,
    );

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
              prompt: buildBatchPrompt(nb, level, pages, batch.startPage, batch.texts, withImages ? batchImages.length : 0),
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
          const parsed = parseBatchOutput(raw, pages, batch.startPage, batch.texts.length);
          annotations.push(...parsed.annotations);
          afterByBatch[bi] = parsed.afterReading;
          annotations.sort((a, b) => a.page - b.page);
          await finish({ annotations: annotations.slice(0, MAX_ANNOTATIONS) }); // incremental delivery
        }),
      );
      if (results.every((r) => r.status === "rejected")) {
        const first = results[0] as PromiseRejectedResult | undefined;
        throw first?.reason instanceof Error ? first.reason : new Error("annotation pass failed");
      }
    } finally {
      await fs.rm(imageDir, { recursive: true, force: true }).catch(() => {});
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
