import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalUrl, cleanTitle, downloadDiscoveredSources, markdownWithSource, truncateWords } from "./discover.js";
import { approxWordCount } from "./extract.js";
import { ensureRagIndex } from "./rag.js";
import { sanitizeName, type Notebook, type NotebookStore, type SourceFile } from "./store.js";
import type { SettingsStore } from "./settings.js";

const execFileAsync = promisify(execFile);

/**
 * Creation-time link ingestion: URLs the user pastes when creating a project
 * become sources. Non-YouTube URLs ride the hardened discovery downloader
 * (SSRF guards, readability, PDF extraction); YouTube URLs get their
 * transcript via yt-dlp (optional dependency — fails open when missing).
 *
 * Deliberately does NOT stamp pendingNewSources: that stamp exists to notify
 * an already-running Aria thread, and at creation time no thread exists (the
 * manifest is baked later and will already include these files) — mirroring
 * the pre-kickoff intake-research precedent in session.ts.
 */

const MAX_LINKS = 5;
const MAX_LINK_CHARS = 500;
const YTDLP_TIMEOUT_MS = 90_000;
/** Transcripts shorter than this are junk (auto-captions failed, music video, …). */
const MIN_TRANSCRIPT_WORDS = 50;

/** Split pasted text into at most MAX_LINKS deduped http(s) URLs. */
export function parseLinks(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/[\n,]+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > MAX_LINK_CHARS) continue;
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const key = canonicalYouTubeUrl(candidate) ?? canonicalUrl(url).href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** Normalize watch/youtu.be/shorts/live/m. forms to a canonical watch URL, else null. */
export function canonicalYouTubeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (host === "youtube.com" || host === "music.youtube.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else if (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") id = parts[1] ?? null;
  }
  if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Strip VTT cue timing/tags and the rolling-cue duplicates of auto-subs. */
function vttToText(vtt: string): string {
  const lines: string[] = [];
  let last = "";
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.replace(/<[^>]+>/g, "").trim();
    if (!line) continue;
    if (/^WEBVTT|^Kind:|^Language:|^NOTE/.test(line)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3} --> /.test(line)) continue;
    if (line === last) continue;
    last = line;
    lines.push(line);
  }
  return lines.join(" ");
}

/** Fetch a video's (auto-)subtitles via yt-dlp. Throws on any failure, incl. yt-dlp missing. */
async function fetchYouTubeTranscript(watchUrl: string): Promise<{ title: string; text: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aria-yt-"));
  try {
    await execFileAsync(
      "yt-dlp",
      [
        "--no-playlist",
        "--write-subs",
        "--write-auto-subs",
        "--sub-lang",
        "en",
        "--skip-download",
        "-o",
        path.join(dir, "%(title)s.%(ext)s"),
        "--",
        watchUrl,
      ],
      { timeout: YTDLP_TIMEOUT_MS },
    );
    const vttFile = (await fs.readdir(dir)).find((f) => f.endsWith(".vtt"));
    if (!vttFile) throw new Error("no English subtitles available");
    const text = vttToText(await fs.readFile(path.join(dir, vttFile), "utf8"));
    const title = vttFile.replace(/\.[a-zA-Z0-9_-]+\.vtt$/, "");
    return { title, text };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ingestYouTube(
  store: NotebookStore,
  notebookId: string,
  watchUrl: string,
  onSource?: () => void,
): Promise<void> {
  const nb = store.get(notebookId);
  if (!nb) return;
  if (nb.sourceFiles.some((f) => f.originUrl === watchUrl)) return; // already have this video
  const { title, text } = await fetchYouTubeTranscript(watchUrl);
  const words = approxWordCount(text);
  if (words < MIN_TRANSCRIPT_WORDS) throw new Error("transcript too short to be useful");

  const fresh = store.get(notebookId);
  if (!fresh) return; // notebook deleted while yt-dlp ran
  const used = new Set(fresh.sourceFiles.flatMap((f) => (f.extractedName ? [f.storedName, f.extractedName] : [f.storedName])));
  const niceTitle = cleanTitle(title, "youtube-video");
  const storedName = sanitizeName(`${niceTitle}.md`, used);
  const markdown = markdownWithSource(niceTitle, watchUrl, truncateWords(text, watchUrl));
  await fs.writeFile(path.join(store.sourcesDir(notebookId), storedName), markdown, "utf8");

  const file: SourceFile = {
    originalName: `${niceTitle}.md`,
    storedName,
    extractedName: null,
    mimeType: "text/markdown",
    size: Buffer.byteLength(markdown),
    approxWords: approxWordCount(markdown),
    origin: "research",
    originUrl: watchUrl,
  };
  fresh.sourceFiles.push(file);
  noteForCoach(fresh, file.originalName);
  await store.save(fresh);
  onSource?.();
}

/** Tell an already-greeted coach about a source its pinned manifest predates. */
function noteForCoach(nb: Notebook, originalName: string): void {
  if (!nb.coach?.kickoffDone) return;
  nb.coach.pendingSourceNotes = [...(nb.coach.pendingSourceNotes ?? []), originalName].slice(-10);
}

/** In-flight ingestion per notebook, so the coach kickoff can wait for pasted links. */
const inflight = new Map<string, Promise<void>>();

/**
 * Wait (bounded) for a notebook's link ingestion. Never rejects; reports
 * whether ingestion is still running past the cap.
 */
export async function awaitLinkIngestion(notebookId: string, capMs: number): Promise<{ stillRunning: boolean }> {
  const job = inflight.get(notebookId);
  if (!job) return { stillRunning: false };
  const timeout = new Promise<"timeout">((resolve) => {
    const t = setTimeout(() => resolve("timeout"), capMs);
    t.unref();
  });
  const result = await Promise.race([job.then(() => "done" as const), timeout]);
  return { stillRunning: result === "timeout" && inflight.has(notebookId) };
}

/**
 * Download pasted links into notebook sources in the background. Fire-and-
 * forget safe: never rejects, per-link fail-open, registers itself so the
 * coach kickoff can await it.
 */
export function ingestLinks(
  store: NotebookStore,
  settings: SettingsStore,
  notebookId: string,
  urls: string[],
  opts: { onSource?: () => void } = {},
): Promise<void> {
  if (urls.length === 0) return Promise.resolve();
  const job = (async () => {
    const youtube: string[] = [];
    const other: string[] = [];
    for (const u of urls) {
      const watch = canonicalYouTubeUrl(u);
      if (watch) {
        if (!youtube.includes(watch)) youtube.push(watch);
      } else {
        other.push(u);
      }
    }

    for (const watchUrl of youtube) {
      try {
        await ingestYouTube(store, notebookId, watchUrl, opts.onSource);
      } catch (err) {
        const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "yt-dlp is not installed" : err instanceof Error ? err.message : String(err);
        console.error(`[aria] links: youtube ingestion failed for ${watchUrl}: ${reason}`);
      }
    }

    if (other.length > 0) {
      const { added, failures } = await downloadDiscoveredSources(
        store,
        notebookId,
        other.map((url) => ({ title: "", url, why: null })),
        {
          onSource: (fresh, file) => {
            noteForCoach(fresh, file.originalName);
            opts.onSource?.();
          },
        },
      );
      for (const f of failures) console.error(`[aria] links: download failed for ${f.url}: ${f.reason}`);
      void added;
    }

    const nb = store.get(notebookId);
    if (nb) void ensureRagIndex(store, settings, nb, { retryNow: true });
  })()
    .catch((err) => console.error(`[aria] links: ingestion crashed for notebook ${notebookId}:`, err))
    .finally(() => {
      if (inflight.get(notebookId) === job) inflight.delete(notebookId);
    });
  inflight.set(notebookId, job);
  return job;
}
