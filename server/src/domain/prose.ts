/**
 * Prose-source helpers for guided reading (see reading.ts): deterministic
 * pseudo-pagination of markdown/text documents, and a visible-text projection
 * used to keep model-quoted anchors matchable against the RENDERED document
 * (the model sees raw markdown; the reader sees rendered text).
 */

/** Soft target per pseudo-page; a page closes once it would exceed this. */
const PAGE_CHAR_TARGET = 3500;
/** Hard cap — single blocks larger than this get split. */
const PAGE_CHAR_MAX = 5500;

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const HEADING_RE = /^#{1,6}\s/;

/**
 * Split a markdown/text document into markdown blocks: headings, paragraphs,
 * list runs, tables — separated by blank lines — with fenced code blocks kept
 * atomic (blank lines inside a fence don't split it).
 */
function splitBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    while (current.length > 0 && current[current.length - 1]!.trim() === "") current.pop();
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== null) {
      current.push(line);
      // A fence closes only on a same-char marker at least as long as the opener.
      if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) {
        fence = null;
        flush();
      }
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1]!;
      current.push(line);
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush(); // an unterminated fence runs to EOF
  return blocks;
}

/** Split one oversized block at line → sentence → space boundaries, never mid-word. */
function splitOversized(block: string): string[] {
  const pieces: string[] = [];
  let rest = block;
  while (rest.length > PAGE_CHAR_MAX) {
    const window = rest.slice(0, PAGE_CHAR_TARGET);
    let cut = window.lastIndexOf("\n");
    if (cut < PAGE_CHAR_TARGET * 0.3) cut = window.lastIndexOf(". ") + 1;
    if (cut < PAGE_CHAR_TARGET * 0.3) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = PAGE_CHAR_TARGET; // no boundary at all — degenerate content
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * Deterministic pseudo-pagination: greedy-pack blocks to ~PAGE_CHAR_TARGET,
 * starting a fresh page at headings once a page is half full (sections open
 * pages). The split is computed ONCE at session creation and stored — the
 * client renders exactly these pages, so anchors can never drift.
 */
export function splitProsePages(text: string): string[] {
  const pages: string[] = [];
  let current = "";

  const push = (block: string) => {
    if (current.length > 0 && current.length + 2 + block.length > PAGE_CHAR_TARGET) {
      pages.push(current);
      current = block;
    } else {
      current = current.length > 0 ? `${current}\n\n${block}` : block;
    }
  };

  for (const block of splitBlocks(text.replace(/\r\n/g, "\n"))) {
    if (HEADING_RE.test(block) && current.length > PAGE_CHAR_TARGET * 0.5) {
      pages.push(current);
      current = "";
    }
    if (block.length > PAGE_CHAR_MAX) {
      for (const piece of splitOversized(block)) push(piece);
    } else {
      push(block);
    }
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

/**
 * Project markdown to the text a reader SEES: link/image syntax resolved to
 * their visible text, emphasis/code markers dropped, structural line prefixes
 * (headings, quotes, list bullets) removed. Deliberately conservative — a
 * rare miss only means one annotation is dropped server-side, which is the
 * designed failure mode for unanchorable highlights.
 */
export function stripInlineMarkdown(text: string): string {
  return (
    text
      // images first (their syntax nests link syntax): keep alt text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // links: keep the visible text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // emphasis/strong/strikethrough markers
      .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
      .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?=[^\w*]|$)/gm, "$1$2")
      // inline code
      .replace(/`([^`]*)`/g, "$1")
      // structural line prefixes
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
      // collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}
