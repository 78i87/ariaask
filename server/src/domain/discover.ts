import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { extractJsonObject } from "./learning.js";
import { approxWordCount, extractPdfText } from "./extract.js";
import { assertSourceQuota } from "./source-quota.js";
import { htmlTableToMarkdown, normalizeResearchMarkdown, usefulMediaAlt } from "./source-normalize.js";
import { sanitizeName, type NotebookStore, type SourceFile } from "./store.js";

/**
 * Online source discovery. A web-search-enabled Codex turn finds public URLs;
 * this module downloads and extracts the sources server-side so they become
 * ordinary notebook files: previewable, deletable, and RAG-indexed.
 *
 * The downloader is fail-open per URL. Bad pages, paywalls, unsupported
 * content, and network failures are reported as failures without aborting the
 * run. Already-downloaded sources are kept.
 */

const FETCH_TIMEOUT_MS = 20_000;
/** Wall-clock budget per source: headers, redirects, AND body download. */
const SOURCE_BUDGET_MS = 45_000;
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MIN_KEEP_WORDS = 150;
const MAX_KEEP_WORDS = 30_000;
const DNS_TIMEOUT_MS = 5_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AriaSourceDiscovery/1.0 Safari/537.36";

export interface DiscoveredSource {
  title: string;
  url: string;
  why: string | null;
}

export interface DiscoverFailure {
  url: string;
  reason: string;
}

export interface DiscoveryClarificationOption {
  value: string;
  label: string;
}

export interface DiscoveryClarificationQuestion {
  id: string;
  question: string;
  options: DiscoveryClarificationOption[];
  allowsCustom: true;
}

export interface DiscoveryRefinement {
  question: string;
  answer: string;
}

interface DownloadedContent {
  title: string;
  url: string;
  kind: "pdf" | "markdown";
  bytes?: Buffer;
  text?: string;
  mimeType: string;
}

type HtmlTools = {
  JSDOM: typeof import("jsdom").JSDOM;
  Readability: typeof import("@mozilla/readability").Readability;
  TurndownService: new (opts?: { headingStyle?: "setext" | "atx"; codeBlockStyle?: "indented" | "fenced" }) => {
    turndown(html: string): string;
    addRule(
      key: string,
      rule: {
        filter: string[];
        replacement: (content: string, node: { nodeName: string; getAttribute(name: string): string | null }) => string;
      },
    ): unknown;
  };
};

let htmlToolsPromise: Promise<HtmlTools> | null = null;

function loadHtmlTools(): Promise<HtmlTools> {
  htmlToolsPromise ??= Promise.all([import("jsdom"), import("@mozilla/readability"), import("turndown")]).then(
    ([jsdom, readability, turndown]) => {
      const TurndownService =
        (turndown as unknown as { default?: HtmlTools["TurndownService"] }).default ??
        (turndown as unknown as HtmlTools["TurndownService"]);
      return {
        JSDOM: jsdom.JSDOM,
        Readability: readability.Readability,
        TurndownService,
      };
    },
  );
  return htmlToolsPromise;
}

export function buildDiscoveryClarificationPrompt(opts: {
  topic: string;
  activity: "workspace" | "coach" | "reverse-tutor" | "interview";
  activityTitle: string | null;
  interviewTarget: string | null;
  focus: string | null;
  request: string;
  manifest: string | null;
}): string {
  return `You are shaping an online source search for a learning project. The user has described
what they want sources to help with. Ask at most two short multiple-choice clarification
questions only when the answers would materially improve which sources should be selected.
Output JSON only — no prose and no markdown fence.

Project goal: ${opts.topic}
Search request: ${opts.request}
Originating activity: ${opts.activity}${opts.activityTitle ? ` ("${opts.activityTitle}")` : ""}
${opts.interviewTarget ? `Interview target: ${opts.interviewTarget}` : ""}
${opts.focus ? `Existing session focus: ${opts.focus}` : ""}
${opts.manifest ? `Existing project sources:\n${opts.manifest}` : ""}

Good clarification targets include the concrete outcome, desired depth, source type, or
which part of a broad subject matters now. Do not ask for information already explicit
above. Do not ask about search keywords, number of sources, or permission to search.
For interview work, prioritize the interview stage, competency, or company/role evidence
the candidate wants. For teaching or coaching, prioritize what the learner needs to
understand, practise, or produce.

Rules:
- Return zero questions when the request is already specific enough. This is a normal outcome.
- Otherwise return one or two questions, each under 100 characters.
- Give each question 3 to 5 distinct, concise options under 70 characters.
- The UI adds an "Other…" option, so do not include one.
- Use stable kebab-case ids.

Output exactly:
{"questions":[{"id":"short-id","question":"...","options":["...","...","..."]}]}`;
}

function clarificationSlug(value: string, used: Set<string>): string {
  const base =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "question";
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

/** [] is a valid, specific-enough response; null means malformed model output. */
export function parseDiscoveryClarificationQuestions(raw: string): DiscoveryClarificationQuestion[] | null {
  const obj = extractJsonObject(raw);
  if (!obj || !Array.isArray(obj.questions)) return null;
  const used = new Set<string>();
  const questions: DiscoveryClarificationQuestion[] = [];
  for (const item of obj.questions.slice(0, 2)) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.question !== "string" || !candidate.question.trim()) continue;
    if (!Array.isArray(candidate.options)) continue;
    const seen = new Set<string>();
    const options: DiscoveryClarificationOption[] = [];
    for (const rawOption of candidate.options.slice(0, 5)) {
      if (typeof rawOption !== "string") continue;
      const label = rawOption.trim().slice(0, 70);
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      options.push({ value: label, label });
    }
    if (options.length < 3) continue;
    questions.push({
      id: clarificationSlug(
        typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : candidate.question,
        used,
      ),
      question: candidate.question.trim().slice(0, 100),
      options,
      allowsCustom: true,
    });
  }
  return questions;
}

function renderDiscoveryBrief(request: string | null, refinements: DiscoveryRefinement[]): string {
  const lines = [
    request ? `What the user needs these sources to help with: ${request}` : null,
    ...refinements.map(({ question, answer }) => `- ${question}: ${answer}`),
  ].filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join("\n") : "No additional request; infer the best source mix from the project context.";
}

export function buildDiscoverPrompt(opts: {
  topic: string;
  focus: string | null;
  note: string | null;
  request: string | null;
  refinements?: DiscoveryRefinement[];
  manifest: string | null;
  knownUrls: string[];
  max: number;
}): string {
  const known = opts.knownUrls.length > 0 ? opts.knownUrls.map((u) => `- ${u}`).join("\n") : "None.";
  return `You are finding source readings for a teaching session. A human teacher is about to
teach a simulated student named Aria. Use the web search tool now and return real,
publicly available source URLs that the server can download into the session.

Subject: ${opts.topic}
Search brief:
${renderDiscoveryBrief(opts.request, opts.refinements ?? [])}
${opts.focus ? `The teacher plans to focus the session on: ${opts.focus}.` : ""}
${opts.note ? `The teacher's note about what to find: ${opts.note}` : ""}
${
  opts.manifest
    ? `
The teacher already has these materials:

${opts.manifest}

Find sources that complement them: fill gaps, add context, or provide a clearer primary
explanation. Do not just duplicate the uploaded material.`
    : ""
}

Already saved URLs, which you must not repeat:
${known}

Return at most ${opts.max} sources. Rules:
- Every URL must come from this turn's web search results. Do not rely on memory alone.
- Prefer substantive text-first pages: documentation, public articles, course notes,
  explainers, papers, and arXiv/PDF sources are fine.
- Skip videos, podcasts, forums, social media threads, search result pages, paywalls,
  login-gated pages, home pages, landing pages, and pages that are mostly product copy.
- Use at most two sources from the same site.
- Prefer sources that can stand alone as assigned reading for a student.
- Output ONLY JSON. No prose, no markdown fence.

Output exactly this shape:
{"sources":[{"title":"short human-readable title","url":"https://...","why":"one short reason this helps the session"}]}`;
}

/**
 * Interview-mode variant. Deliberately NOT a query pass-through into
 * buildDiscoverPrompt: that prompt's "skip forums, social media threads" and
 * assigned-reading framing actively fight interview research, where candid
 * forum/Q&A accounts of real interviews are exactly what's wanted.
 */
export function buildInterviewDiscoverPrompt(opts: {
  role: string;
  company: string | null;
  note: string | null;
  request: string | null;
  refinements?: DiscoveryRefinement[];
  manifest: string | null;
  knownUrls: string[];
  max: number;
}): string {
  const known = opts.knownUrls.length > 0 ? opts.knownUrls.map((u) => `- ${u}`).join("\n") : "None.";
  const target = `${opts.role}${opts.company ? ` at ${opts.company}` : ""}`;
  return `You are gathering background material for a simulated job interview. An AI interviewer is
about to interview a human candidate for: ${target}. Use the web search tool now and return
real, publicly available URLs that the server can download to prepare the interviewer.
Search brief:
${renderDiscoveryBrief(opts.request, opts.refinements ?? [])}
${opts.note ? `The candidate's note about what to find: ${opts.note}` : ""}

Find, in order of value:
1. Accounts of real interview experiences and commonly asked questions for ${target} —
   candid first-person accounts and substantive Q&A or forum threads count, as long as the
   page is openly accessible.
2. ${opts.company ? `Background on ${opts.company} and this team — engineering/company blog posts, product or values pages with real substance.` : "Background on how companies typically run interviews for this role."}
3. Role-specific preparation guides or question banks.
${
  opts.manifest
    ? `
The interviewer already has these materials:

${opts.manifest}

Find pages that complement them — do not duplicate what is already there.`
    : ""
}

Already saved URLs, which you must not repeat:
${known}

Return at most ${opts.max} sources. Rules:
- Every URL must come from this turn's web search results. Do not rely on memory alone.
- Substantive text-first pages only. Skip videos, podcasts, search result pages, home
  pages, landing pages, and pages that are mostly product copy.
- Skip paywalls and login-gated pages (most Glassdoor and Blind pages are — prefer openly
  readable alternatives).
- Use at most two sources from the same site.
- Output ONLY JSON. No prose, no markdown fence.

Output exactly this shape:
{"sources":[{"title":"short human-readable title","url":"https://...","why":"one short reason this helps the interview"}]}`;
}

export function parseDiscoveredSources(raw: string, max: number): DiscoveredSource[] | null {
  const obj = extractJsonObject(raw);
  if (!obj || !Array.isArray(obj.sources)) return null;
  const seen = new Set<string>();
  const out: DiscoveredSource[] = [];
  for (const item of obj.sources) {
    if (out.length >= max) break;
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.url !== "string" || !o.url.trim()) continue;
    try {
      const u = canonicalUrl(new URL(o.url.trim()));
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const key = u.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const title =
        typeof o.title === "string" && o.title.trim()
          ? o.title.trim().slice(0, 120)
          : u.hostname.replace(/^www\./, "").slice(0, 120);
      const why = typeof o.why === "string" && o.why.trim() ? o.why.trim().slice(0, 240) : null;
      out.push({ title, url: key, why });
    } catch {
      /* invalid URL */
    }
  }
  return out.length > 0 ? out : null;
}

export function canonicalUrl(u: URL): URL {
  const next = new URL(u.toString());
  next.hash = "";
  next.username = "";
  next.password = "";
  next.hostname = next.hostname.toLowerCase();
  return next;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b, c] = parts as [number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b >= 18 && b <= 19) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Expand an IPv6 literal into 8 16-bit groups; null when unparseable. */
function parseIpv6Groups(ip: string): number[] | null {
  let s = ip.split("%")[0]!; // strip any zone index
  // Trailing dotted-quad (mapped/compatible forms) → two hex groups.
  const v4 = /^(.*):(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const parts = v4[2]!.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    s = `${v4[1]}:${(((parts[0]! << 8) | parts[1]!) >>> 0).toString(16)}:${(((parts[2]! << 8) | parts[3]!) >>> 0).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 0 : head.length !== 8) return null;
  const groupsStr = halves.length === 2 ? [...head, ...Array<string>(fill).fill("0"), ...tail] : head;
  const groups: number[] = [];
  for (const g of groupsStr) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  return groups.length === 8 ? groups : null;
}

/**
 * Works on the PARSED address, not string prefixes — compressed forms of the
 * IPv4-mapped range (::ffff:7f00:1) must not slip past. Every IPv6 shape that
 * embeds an IPv4 address (mapped, IPv4-compatible, NAT64, 6to4) defers to the
 * IPv4 check. Unparseable input is rejected.
 */
function isPrivateIpv6(ip: string): boolean {
  const g = parseIpv6Groups(ip.toLowerCase());
  if (!g) return true;
  const embeddedV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  const zeroThrough = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroThrough(5) && g[5] === 0xffff) return isPrivateIpv4(embeddedV4(g[6]!, g[7]!)); // ::ffff:0:0/96 mapped
  if (zeroThrough(6)) {
    if (g[6] === 0 && g[7]! <= 1) return true; // :: and ::1
    return isPrivateIpv4(embeddedV4(g[6]!, g[7]!)); // ::/96 IPv4-compatible (deprecated)
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isPrivateIpv4(embeddedV4(g[6]!, g[7]!)); // 64:ff9b::/96 NAT64
  }
  if (g[0] === 0x2002) return isPrivateIpv4(embeddedV4(g[1]!, g[2]!)); // 2002::/16 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  return false;
}

async function lookupAll(hostname: string): Promise<{ address: string; family: number }[]> {
  return await Promise.race([
    lookup(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS);
      t.unref();
    }),
  ]);
}

async function assertPublicUrl(u: URL): Promise<{ address: string; family: 4 | 6 }[]> {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("unsupported URL scheme");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("private host rejected");
  }

  const literal = net.isIP(host);
  const addresses = literal ? [{ address: host, family: literal }] : await lookupAll(host);
  if (addresses.length === 0) throw new Error("host has no public addresses");
  for (const addr of addresses) {
    if (addr.family === 4 && isPrivateIpv4(addr.address)) throw new Error("private IPv4 address rejected");
    if (addr.family === 6 && isPrivateIpv6(addr.address)) throw new Error("private IPv6 address rejected");
  }
  return addresses.map((addr) => ({ address: addr.address, family: addr.family as 4 | 6 }));
}

type PinnedLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;

/** Match both scalar and `all: true` lookup callback shapes used by Node/Undici. */
export function createPinnedLookup(target: { address: string; family: 4 | 6 }) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: PinnedLookupCallback,
  ): void => {
    if (options.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };
}

function withTimeout(signal: AbortSignal | undefined): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  timer.unref();
  const signals = signal ? [signal, ctrl.signal] : [ctrl.signal];
  return {
    signal: AbortSignal.any(signals),
    done: () => clearTimeout(timer),
  };
}

async function fetchWithRedirects(
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ response: Awaited<ReturnType<typeof undiciFetch>>; url: string; close: () => Promise<void> }> {
  let current = canonicalUrl(new URL(url));
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const [target] = await assertPublicUrl(current);
    if (!target) throw new Error("host has no public addresses");
    const dispatcher = new Agent({
      connect: {
        // The original URL still supplies Host and TLS SNI, but the socket can
        // connect only to the address that passed the private-range policy.
        lookup: createPinnedLookup(target),
      },
    });
    const timeout = withTimeout(signal);
    const close = async () => {
      timeout.done();
      await dispatcher.close();
    };
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      response = await undiciFetch(current, {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/pdf,text/plain,text/markdown,*/*;q=0.8" },
        signal: timeout.signal,
        dispatcher,
      });
    } catch (err) {
      await close().catch(() => {});
      throw err;
    }
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      if (redirects === MAX_REDIRECTS) {
        await response.body?.cancel().catch(() => {});
        await close().catch(() => {});
        throw new Error("too many redirects");
      }
      current = canonicalUrl(new URL(response.headers.get("location")!, current));
      await response.body?.cancel().catch(() => {});
      await close().catch(() => {});
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      await close().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    return { response, url: current.toString(), close };
  }
  throw new Error("too many redirects");
}

async function readCapped(response: Awaited<ReturnType<typeof undiciFetch>>): Promise<Buffer> {
  const len = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(len) && len > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("response too large");
  }
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > MAX_RESPONSE_BYTES) throw new Error("response too large");
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function decodeText(bytes: Buffer, contentType: string): string {
  const charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim();
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function cleanTitle(title: string, fallback: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, 140) || fallback;
}

export function preferReadableTitle(title: string, fallback: string): string {
  const cleaned = cleanTitle(title, fallback);
  const looksLikeUiToken = /^[a-z0-9]+(?:[-_][a-z0-9]+){2,}$/i.test(cleaned);
  const containsPlaceholder = /(?:^|[-_\s])(empty|undefined|null)(?:$|[-_\s])/i.test(cleaned);
  return looksLikeUiToken || containsPlaceholder ? fallback : cleaned;
}

/**
 * Sources are text-only for the student: media markdown is dead weight, and a
 * single inline data-URI image can be megabytes of base64 that word-count
 * truncation can't catch (it's one "word"). The turndown rule below drops
 * media elements; this pass catches what slips through other paths (raw .md
 * downloads, data-URI link targets).
 */
function stripMediaMarkdown(text: string): string {
  return text
    .replace(/!\[[\s\S]*?\]\([^)]*\)/g, "") // images, whatever the src scheme (alts may contain "]")
    .replace(/\]\(data:[^)]*\)/g, "]()") // data-URI link targets
    .replace(/\n{3,}/g, "\n\n");
}

export function markdownWithSource(title: string, url: string, text: string): string {
  const body = text.trim();
  if (/^#\s+.+/.test(body)) {
    // Replacement FUNCTION: a "$1"/"$&" in the URL must stay literal.
    return body.replace(/^([^\n]+)\n?/, (_m, first: string) => `${first}\n\nSource: ${url}\n\n`);
  }
  return `# ${title}\n\nSource: ${url}\n\n${body}\n`;
}

export function truncateWords(text: string, url: string): string {
  if (approxWordCount(text) <= MAX_KEEP_WORDS) return text;
  // Slice the ORIGINAL string at the cap'th word — split/join would collapse
  // newlines and flatten the document's structure.
  const re = /\S+/g;
  let count = 0;
  let end = text.length;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (++count === MAX_KEEP_WORDS) {
      end = m.index + m[0].length;
      break;
    }
  }
  let clipped = text.slice(0, end);
  const boundary = clipped.lastIndexOf("\n\n");
  if (boundary > clipped.length * 0.75) clipped = clipped.slice(0, boundary);
  return `${clipped.trim()}\n\n[Truncated - full text at ${url}]`;
}

async function fetchSourcePage(
  url: string,
  fallbackTitle: string,
  signal?: AbortSignal,
  opts: { minWords?: number } = {},
): Promise<DownloadedContent> {
  const { response, url: finalUrl, close } = await fetchWithRedirects(url, signal);
  const contentType = response.headers.get("content-type") ?? "";
  let bytes: Buffer;
  try {
    bytes = await readCapped(response);
  } finally {
    await close().catch(() => {});
  }
  const sniff = bytes.subarray(0, 5).toString("latin1");
  const final = new URL(finalUrl);
  const fallback = cleanTitle(fallbackTitle, final.hostname.replace(/^www\./, ""));

  // The .pdf extension only counts when the server doesn't claim text — an
  // HTML page served at a .pdf path must take the readable-article branch.
  const ct = contentType.toLowerCase();
  const claimsText = ct.includes("text/html") || ct.includes("text/plain");
  if (ct.includes("application/pdf") || sniff === "%PDF-" || (final.pathname.toLowerCase().endsWith(".pdf") && !claimsText)) {
    return { title: fallback, url: finalUrl, kind: "pdf", bytes, mimeType: "application/pdf" };
  }

  if (
    contentType.toLowerCase().includes("text/html") ||
    contentType === "" ||
    final.pathname.toLowerCase().endsWith(".html") ||
    final.pathname.toLowerCase().endsWith(".htm")
  ) {
    const { JSDOM, Readability, TurndownService } = await loadHtmlTools();
    const dom = new JSDOM(bytes, { url: finalUrl });
    try {
      const article = new Readability(dom.window.document).parse();
      if (!article || !article.textContent || approxWordCount(article.textContent) < (opts.minWords ?? MIN_KEEP_WORDS)) {
        throw new Error("no readable article text");
      }
      const title = preferReadableTitle(article.title || dom.window.document.title, fallback);
      const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
      turndown.addRule("tables", {
        filter: ["table"],
        replacement: (_content, node) => htmlTableToMarkdown(node as unknown as Element),
      });
      turndown.addRule("dropMedia", {
        filter: ["img", "picture", "source", "svg", "video", "audio", "iframe", "object", "embed", "canvas"],
        replacement: (_content, node) => {
          // MediaWiki renders math as an <img> whose alt IS the TeX — keep a
          // short alt as plain text so formulas survive; data-URI bloat lives
          // in src, never alt, so the original fix is preserved.
          if (node.nodeName === "IMG") {
            const alt = usefulMediaAlt(node.getAttribute("alt") ?? "");
            if (alt) return ` ${alt} `;
          }
          return "";
        },
      });
      const markdown = normalizeResearchMarkdown(stripMediaMarkdown(turndown.turndown(article.content || article.textContent)));
      return {
        title,
        url: finalUrl,
        kind: "markdown",
        text: markdownWithSource(title, finalUrl, truncateWords(markdown, finalUrl)),
        mimeType: "text/markdown",
      };
    } finally {
      dom.window.close();
    }
  }

  if (
    contentType.toLowerCase().includes("text/plain") ||
    contentType.toLowerCase().includes("text/markdown") ||
    final.pathname.toLowerCase().endsWith(".txt") ||
    final.pathname.toLowerCase().endsWith(".md")
  ) {
    const title = fallback;
    const text = normalizeResearchMarkdown(stripMediaMarkdown(decodeText(bytes, contentType)));
    return {
      title,
      url: finalUrl,
      kind: "markdown",
      text: markdownWithSource(title, finalUrl, truncateWords(text, finalUrl)),
      mimeType: "text/markdown",
    };
  }

  throw new Error(`unsupported content type${contentType ? ` (${contentType})` : ""}`);
}

/**
 * Known URL shapes where the obvious link is not the real reading: an arXiv
 * /abs/ page is a ~300-word abstract stub, while /pdf/<id> is the paper —
 * and the PDF branch already extracts it with its own too-little-text guard.
 */
function rewriteKnownUrl(u: URL): URL {
  if (/^(www\.)?arxiv\.org$/.test(u.hostname)) {
    const m = /^\/abs\/(.+)$/.exec(u.pathname);
    if (m) return new URL(`https://arxiv.org/pdf/${m[1]}`);
  }
  return u;
}

function usedSourceNames(files: SourceFile[]): Set<string> {
  return new Set(files.flatMap((f) => (f.extractedName ? [f.storedName, f.extractedName] : [f.storedName])));
}

function reserveExtractedName(storedName: string, used: Set<string>): string {
  const ext = path.extname(storedName);
  const stem = path.basename(storedName, ext);
  let name = `${stem}.extracted.txt`;
  let n = 1;
  while (used.has(name)) name = `${stem}.extracted-${n++}.txt`;
  used.add(name);
  return name;
}

function failure(url: string, err: unknown): DiscoverFailure {
  const reason =
    err instanceof Error && err.name === "TimeoutError"
      ? "timed out"
      : err instanceof Error && err.name === "AbortError"
        ? "cancelled"
        : err instanceof Error
          ? err.message
          : "couldn't fetch source";
  return { url, reason: reason.slice(0, 240) };
}

export async function downloadDiscoveredSources(
  store: NotebookStore,
  notebookId: string,
  sources: DiscoveredSource[],
  opts: {
    signal?: AbortSignal;
    onSource?: (nb: NonNullable<ReturnType<NotebookStore["get"]>>, file: SourceFile) => void | Promise<void>;
    onProgress?: (completed: number, total: number) => void | Promise<void>;
  } = {},
): Promise<{ added: SourceFile[]; failures: DiscoverFailure[] }> {
  const added: SourceFile[] = [];
  const failures: DiscoverFailure[] = [];

  let completed = 0;
  for (const src of sources) {
    if (opts.signal?.aborted) break;
    const nb = store.get(notebookId);
    if (!nb) break;
    try {
      const existingUrls = new Set(
        nb.sourceFiles
          .map((f) => f.originUrl)
          .filter((u): u is string => typeof u === "string" && u.length > 0)
          .map((u) => {
            try {
              return canonicalUrl(new URL(u)).toString();
            } catch {
              return u;
            }
          }),
      );
      const requestedUrl = canonicalUrl(rewriteKnownUrl(new URL(src.url))).toString();
      if (existingUrls.has(requestedUrl)) continue;

      // Wall-clock budget for headers + redirects + body: the per-hop header
      // timeout alone can't bound a slow-drip body download.
      const budget = AbortSignal.timeout(SOURCE_BUDGET_MS);
      const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;
      const content = await fetchSourcePage(requestedUrl, src.title, signal);
      const finalUrl = canonicalUrl(new URL(content.url)).toString();
      if (existingUrls.has(finalUrl)) continue;
      const used = usedSourceNames(nb.sourceFiles);
      const title = cleanTitle(content.title, new URL(finalUrl).hostname.replace(/^www\./, ""));

      let file: SourceFile;
      if (content.kind === "pdf") {
        const bytes = content.bytes!;
        assertSourceQuota(nb.sourceFiles, [{ size: bytes.byteLength }]);
        const storedName = sanitizeName(`${title}.pdf`, used);
        const pdfPath = path.join(store.sourcesDir(notebookId), storedName);
        await fs.writeFile(pdfPath, bytes);
        const extracted = await extractPdfText(pdfPath);
        if (!extracted || approxWordCount(extracted) < MIN_KEEP_WORDS) {
          await fs.rm(pdfPath, { force: true }).catch(() => {});
          throw new Error("PDF had too little readable text");
        }
        const extractedName = reserveExtractedName(storedName, used);
        const extractedText = truncateWords(extracted, finalUrl);
        await fs.writeFile(path.join(store.sourcesDir(notebookId), extractedName), extractedText, "utf8");
        file = {
          originalName: title,
          storedName,
          extractedName,
          mimeType: content.mimeType,
          size: bytes.byteLength,
          approxWords: approxWordCount(extractedText),
          origin: "research",
          originUrl: finalUrl,
        };
      } else {
        const text = content.text!;
        if (approxWordCount(text) < MIN_KEEP_WORDS) throw new Error("page had too little readable text");
        assertSourceQuota(nb.sourceFiles, [{ size: Buffer.byteLength(text, "utf8") }]);
        const storedName = sanitizeName(`${title}.md`, used);
        await fs.writeFile(path.join(store.sourcesDir(notebookId), storedName), text, "utf8");
        file = {
          originalName: title,
          storedName,
          extractedName: null,
          mimeType: content.mimeType,
          size: Buffer.byteLength(text, "utf8"),
          approxWords: approxWordCount(text),
          origin: "research",
          originUrl: finalUrl,
        };
      }

      nb.sourceFiles.push(file);
      await opts.onSource?.(nb, file);
      try {
        await store.save(nb);
      } catch (err) {
        nb.sourceFiles = nb.sourceFiles.filter((f) => f.storedName !== file.storedName);
        await fs.rm(path.join(store.sourcesDir(notebookId), file.storedName), { force: true }).catch(() => {});
        if (file.extractedName) await fs.rm(path.join(store.sourcesDir(notebookId), file.extractedName), { force: true }).catch(() => {});
        throw err;
      }
      added.push(file);
    } catch (err) {
      failures.push(failure(src.url, err));
    } finally {
      completed += 1;
      await opts.onProgress?.(completed, sources.length);
    }
  }

  return { added, failures };
}

/** Sanity floor for a fetched job posting — enough to reject cookie walls and empty shells. */
const JD_MIN_WORDS = 30;

/**
 * Interview mode: fetch a user-provided job-posting URL at notebook creation
 * and write it into the sources dir as the job description. Single URL, same
 * SSRF/redirect/size guards as discovery, but no discovery-grade minimum
 * length (a terse posting is still the posting) and flagged kind: "jd".
 * Throws on failure — the caller downgrades it to a creation warning.
 */
export async function downloadJobDescriptionFile(
  sourcesDir: string,
  url: string,
  usedNames: Set<string>,
): Promise<SourceFile> {
  const requested = canonicalUrl(rewriteKnownUrl(new URL(url))).toString();
  const signal = AbortSignal.timeout(SOURCE_BUDGET_MS);
  const content = await fetchSourcePage(requested, "Job description", signal, { minWords: JD_MIN_WORDS });
  const finalUrl = canonicalUrl(new URL(content.url)).toString();

  if (content.kind === "pdf") {
    const bytes = content.bytes!;
    const storedName = sanitizeName("job-description.pdf", usedNames);
    const pdfPath = path.join(sourcesDir, storedName);
    let extractedName: string | null = null;
    try {
      await fs.writeFile(pdfPath, bytes);
      // Extraction failure keeps the PDF (mirrors uploads): the kickoff read may
      // still manage, and the preview shows the original either way.
      const extracted = await extractPdfText(pdfPath);
      let approxWords: number | null = null;
      if (extracted && extracted.trim()) {
        extractedName = reserveExtractedName(storedName, usedNames);
        const extractedText = truncateWords(extracted, finalUrl);
        await fs.writeFile(path.join(sourcesDir, extractedName), extractedText, "utf8");
        approxWords = approxWordCount(extractedText);
      }
      return {
        originalName: "Job description",
        storedName,
        extractedName,
        mimeType: "application/pdf",
        size: bytes.byteLength,
        approxWords,
        originUrl: finalUrl,
        kind: "jd",
      };
    } catch (err) {
      await fs.rm(pdfPath, { force: true }).catch(() => {});
      if (extractedName) await fs.rm(path.join(sourcesDir, extractedName), { force: true }).catch(() => {});
      throw err;
    }
  }

  const text = content.text!;
  const storedName = sanitizeName("job-description.md", usedNames);
  const storedPath = path.join(sourcesDir, storedName);
  try {
    await fs.writeFile(storedPath, text, "utf8");
  } catch (err) {
    await fs.rm(storedPath, { force: true }).catch(() => {});
    throw err;
  }
  return {
    originalName: "Job description",
    storedName,
    extractedName: null,
    mimeType: "text/markdown",
    size: Buffer.byteLength(text, "utf8"),
    approxWords: approxWordCount(text),
    originUrl: finalUrl,
    kind: "jd",
  };
}
