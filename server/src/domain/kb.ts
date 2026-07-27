import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { writeFileAtomic } from "../lib/atomic.js";
import {
  CHUNKER_VERSION,
  QUERY_PREFIXES,
  chunkFile,
  decodeVectors,
  embedBatched,
  encodeVectors,
  joinAdjacent,
  type Excerpt,
  type RagChunk,
  type RagIndexFile,
} from "./rag.js";

/**
 * The learning-coach knowledge base: a static, repo-checked-in corpus of
 * learning-science docs (kb/ at the repo root — curated principle/technique
 * docs plus cleaned transcripts) indexed once, globally, to
 * data/kb-index.json. Per coach turn the most relevant passages are retrieved
 * and injected as a hidden "coaching notes" block.
 *
 * This deliberately mirrors rag.ts (whose chunker/embedder/scoring internals
 * it imports) but swaps the per-notebook lifecycle for a build-once global
 * one: the corpus fingerprint is derived from the kb/ file stats, rebuilds
 * happen on boot when the corpus/model/chunker drifts, and retrieval has no
 * per-source filtering. Everything fails open — a missing kb/ dir, a corrupt
 * index, or a slow query degrade to "no block". Kill switch: ARIA_NO_KB=1.
 */

/** Chunk cap: the KB corpus (curated docs + transcripts) is bigger than a typical notebook. */
const MAX_KB_CHUNKS = 4000;

// The KB corpus is homogeneous (everything is about learning), so absolute
// similarity runs higher than notebook RAG. A tighter relative floor plus a
// modestly lower absolute floor keeps recall useful without dredging.
const TOP_CANDIDATES = 12;
const MIN_SCORE = 0.4;
const RELATIVE_FLOOR = 0.82;
const MAX_PER_FILE = 2;
const TOP_K = 4;
const BUDGET_CHARS = 3500;

interface LoadedKbIndex {
  model: string;
  dims: number;
  chunkerVersion: number;
  corpus: string[];
  chunks: RagChunk[];
  vec: Float32Array;
}

let loaded: LoadedKbIndex | null = null;
let loadTried = false;
/** Single build chain: concurrent triggers coalesce, builds never overlap. */
let buildChain: Promise<void> = Promise.resolve();

function kbIndexPath(): string {
  return path.join(config.dataDir, "kb-index.json");
}

/** Repo-relative .md paths under kb/, sorted; README.md is curation docs, not coach knowledge. */
async function listKbFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing dir = empty corpus
    }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), relPath);
      else if (e.isFile() && e.name.endsWith(".md") && relPath !== "README.md") out.push(relPath);
    }
  }
  await walk(config.kbDir, "");
  return out.sort();
}

async function kbFingerprint(files: string[]): Promise<string[]> {
  const lines = await Promise.all(
    files.map(async (rel) => {
      const st = await fs.stat(path.join(config.kbDir, rel));
      return `${rel}|${st.size}|${Math.floor(st.mtimeMs)}`;
    }),
  );
  return lines.sort();
}

function sameCorpus(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** YAML frontmatter is curation metadata; chunked as body text it would pollute retrieval. */
function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

async function loadFromDisk(): Promise<LoadedKbIndex | null> {
  let raw: string;
  try {
    raw = await fs.readFile(kbIndexPath(), "utf8");
  } catch {
    return null;
  }
  try {
    const idx = JSON.parse(raw) as RagIndexFile;
    if (
      idx.version !== 1 ||
      typeof idx.model !== "string" ||
      typeof idx.dims !== "number" ||
      typeof idx.chunkerVersion !== "number" ||
      !Array.isArray(idx.corpus) ||
      !Array.isArray(idx.chunks) ||
      typeof idx.vectors !== "string"
    ) {
      throw new Error("unexpected shape");
    }
    const vec = decodeVectors(idx.vectors);
    if (vec.length !== idx.chunks.length * idx.dims) throw new Error("vector/chunk length mismatch");
    return { model: idx.model, dims: idx.dims, chunkerVersion: idx.chunkerVersion, corpus: idx.corpus, chunks: idx.chunks, vec };
  } catch (err) {
    console.error("[aria] kb: index unreadable; rebuilding:", err);
    await fs.rm(kbIndexPath(), { force: true }).catch(() => {});
    return null;
  }
}

async function syncKbIndex(): Promise<void> {
  const files = await listKbFiles();
  const corpus = await kbFingerprint(files);

  if (!loaded && !loadTried) {
    loadTried = true;
    loaded = await loadFromDisk();
  }
  if (
    loaded &&
    loaded.model === config.ragModel &&
    loaded.chunkerVersion === CHUNKER_VERSION &&
    sameCorpus(loaded.corpus, corpus)
  ) {
    return; // fresh
  }

  const t0 = Date.now();
  let chunks: RagChunk[] = [];
  for (const rel of files) {
    try {
      const text = await fs.readFile(path.join(config.kbDir, rel), "utf8");
      chunks.push(...chunkFile(rel, rel, stripFrontmatter(text)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  if (chunks.length > MAX_KB_CHUNKS) {
    console.error(`[aria] kb: corpus too large; indexing first ${MAX_KB_CHUNKS} of ${chunks.length} chunks`);
    chunks = chunks.slice(0, MAX_KB_CHUNKS);
  }

  const { dims, vectors } =
    chunks.length > 0 ? await embedBatched(chunks.map((c) => c.text)) : { dims: 0, vectors: new Float32Array(0) };

  const file: RagIndexFile = {
    version: 1,
    model: config.ragModel,
    dims,
    pooling: "mean",
    chunkerVersion: CHUNKER_VERSION,
    corpus,
    builtAt: new Date().toISOString(),
    chunks,
    vectors: encodeVectors(vectors),
  };
  // Memory first: a failed disk write must not strand a fresh embed.
  loaded = { model: file.model, dims, chunkerVersion: CHUNKER_VERSION, corpus, chunks, vec: vectors };
  await writeFileAtomic(kbIndexPath(), JSON.stringify(file));
  console.log(`[aria] kb: indexed ${chunks.length} chunks from ${files.length} docs in ${Date.now() - t0}ms`);
}

/**
 * Bring the KB index in line with the kb/ corpus. Fire-and-forget safe:
 * never rejects, serializes, and coalesces concurrent triggers. Called on
 * boot (which also pre-warms the shared embedder) and lazily per retrieval.
 */
export function ensureKbIndex(): Promise<void> {
  if (config.kbDisabled) return Promise.resolve();
  buildChain = buildChain
    .catch(() => {})
    .then(() =>
      syncKbIndex().catch((err) => {
        console.error("[aria] kb: index build failed:", err);
      }),
    );
  return buildChain;
}

async function selectKbExcerpts(query: string): Promise<Excerpt[]> {
  await ensureKbIndex();
  const idx = loaded;
  if (!idx || idx.chunks.length === 0 || idx.model !== config.ragModel) return [];

  const prefix = QUERY_PREFIXES[config.ragModel] ?? "";
  const { dims, vectors: qv } = await embedBatched([prefix + query]);
  if (dims !== idx.dims) return [];

  const scored: { i: number; score: number }[] = [];
  for (let i = 0; i < idx.chunks.length; i++) {
    let dot = 0;
    const base = i * dims;
    for (let d = 0; d < dims; d++) dot += idx.vec[base + d]! * qv[d]!;
    scored.push({ i, score: dot });
  }
  if (scored.length === 0) return [];

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]!.score;
  const floor = Math.max(MIN_SCORE, top * RELATIVE_FLOOR);
  const perFile = new Map<string, number>();
  const kept: { chunk: RagChunk; score: number }[] = [];
  for (const { i, score } of scored.slice(0, TOP_CANDIDATES)) {
    if (score < floor) break;
    const chunk = idx.chunks[i]!;
    const used = perFile.get(chunk.file) ?? 0;
    if (used >= MAX_PER_FILE) continue;
    perFile.set(chunk.file, used + 1);
    kept.push({ chunk, score });
  }
  if (kept.length === 0) return [];

  // Merge adjacent chunks of the same file into one continuous excerpt.
  const byFile = new Map<string, { chunk: RagChunk; score: number }[]>();
  for (const k of kept) {
    const list = byFile.get(k.chunk.file) ?? [];
    list.push(k);
    byFile.set(k.chunk.file, list);
  }
  const excerpts: Excerpt[] = [];
  for (const list of byFile.values()) {
    list.sort((a, b) => a.chunk.seq - b.chunk.seq);
    let current: (Excerpt & { lastSeq: number }) | null = null;
    for (const { chunk, score } of list) {
      if (current && chunk.seq === current.lastSeq + 1) {
        current.text = joinAdjacent(current.text, chunk.text);
        current.score = Math.max(current.score, score);
        current.heading = current.heading ?? chunk.heading;
        current.lastSeq = chunk.seq;
      } else {
        if (current) excerpts.push(current);
        current = { heading: chunk.heading, text: chunk.text, score, lastSeq: chunk.seq };
      }
    }
    if (current) excerpts.push(current);
  }

  excerpts.sort((a, b) => b.score - a.score);
  const final: Excerpt[] = [];
  let budget = BUDGET_CHARS;
  for (const e of excerpts) {
    if (final.length >= TOP_K) break;
    if (e.text.length > budget) {
      if (final.length === 0) {
        final.push({ ...e, text: e.text.slice(0, budget) });
        budget = 0;
      }
      continue;
    }
    budget -= e.text.length;
    final.push(e);
  }
  if (final.length > 0) {
    console.log(
      `[aria] kb: ${final.length} excerpt(s) (scores ${final[0]!.score.toFixed(2)}–${final[final.length - 1]!.score.toFixed(2)})`,
    );
  }
  return final;
}

/**
 * The hidden per-turn knowledge-base block, or "" whenever anything —
 * kill switch, missing corpus, cold model, slow query, any error — says no.
 * Races the same hard cap as notebook retrieval; a lost race keeps working
 * in the background so the next turn is warm.
 */
export async function buildKbBlock(
  query: string,
  render: (excerpts: Excerpt[]) => string,
  opts: { signal?: AbortSignal } = {},
): Promise<string> {
  if (config.kbDisabled || !query.trim()) return "";
  try {
    return await Promise.race([
      selectKbExcerpts(query)
        .then((excerpts) => (excerpts.length > 0 ? render(excerpts) : ""))
        .catch((err) => {
          console.error("[aria] kb: retrieval failed; turn proceeds without coaching notes:", err);
          return "";
        }),
      new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve(""), config.ragQueryTimeoutMs);
        t.unref();
      }),
      ...(opts.signal
        ? [
            new Promise<string>((resolve) => {
              if (opts.signal!.aborted) resolve("");
              else opts.signal!.addEventListener("abort", () => resolve(""), { once: true });
            }),
          ]
        : []),
    ]);
  } catch {
    return "";
  }
}
