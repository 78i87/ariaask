import type { ReadingAnnotation } from "../../lib/types";

/**
 * Anchor location + highlight marking for guided reading, for both document
 * renderers: the pdf.js text layer (line spans) and rendered prose blocks
 * (react-markdown output). Matching is whitespace-tolerant with a looser
 * punctuation-tolerant fallback — rendered text can differ slightly from what
 * the server verified against.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strict (whitespace-tolerant) and loose (punctuation-tolerant) anchor patterns. */
function buildAnchorPatterns(anchor: string): { strict: RegExp; loose: RegExp | null } | null {
  const words = anchor.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const strict = new RegExp(words.map(escapeRegExp).join("[\\s\\u00A0]+"));
  const looseWords = words.map((w) => w.replace(/[^\p{L}\p{N}]+/gu, "")).filter(Boolean);
  const loose = looseWords.length > 0 ? new RegExp(looseWords.map(escapeRegExp).join("[^\\p{L}\\p{N}]+"), "u") : null;
  return { strict, loose };
}

/** Length-preserving punctuation strip (char-for-char) so loose-match indices stay aligned. */
const stripPunct = (s: string) => s.replace(/[^\p{L}\p{N} ]/gu, " ");

/**
 * Highlight one span's share of a matched quote. Boundary spans where the
 * quote starts/ends mid-line get an inline wrapper around just the matched
 * substring, so the highlight hugs the quote instead of painting the whole
 * line. Falls back to whole-span marking when the span's content is already
 * split by an earlier annotation's wrapper.
 */
function markSpanRange(el: HTMLElement, ann: ReadingAnnotation, localStart: number, localEnd: number, len: number): void {
  const wholeSpan = localStart <= 0 && localEnd >= len;
  const textNode = el.firstChild;
  if (!wholeSpan && el.childNodes.length === 1 && textNode?.nodeType === Node.TEXT_NODE) {
    const range = document.createRange();
    range.setStart(textNode, Math.max(0, localStart));
    range.setEnd(textNode, Math.min(localEnd, len));
    const wrap = document.createElement("span");
    wrap.className = `rd-hl rd-hl--inline rd-hl--${ann.kind}`;
    wrap.dataset.ann = ann.id;
    try {
      range.surroundContents(wrap);
      return;
    } catch {
      /* fall through to whole-span marking */
    }
  }
  el.dataset.ann = ann.id;
  el.classList.add("rd-hl", `rd-hl--${ann.kind}`);
}

/**
 * PDF text layer: locate the annotation's anchor quote in the rendered line
 * spans and mark the covering spans/substrings.
 */
export function markAnchor(container: HTMLElement, ann: ReadingAnnotation): boolean {
  // Idempotent: an anchor whose spans are already marked IS found — re-runs
  // (late-generation passes, session state changes) must not re-flag it.
  if (container.querySelector(`[data-ann="${ann.id}"]`)) return true;
  // Line spans only: markedContent wrappers would duplicate their children's
  // text in the join, and highlight wrappers aren't part of the line grid.
  const spans = Array.from(container.querySelectorAll<HTMLElement>('span[role="presentation"]'));
  if (spans.length === 0) return false;
  const pieces = spans.map((s) => s.textContent ?? "");
  const full = pieces.join(" ").toLowerCase();

  const patterns = buildAnchorPatterns(ann.anchor);
  if (!patterns) return false;
  let match = patterns.strict.exec(full);
  if (!match && patterns.loose) match = patterns.loose.exec(stripPunct(full));
  if (!match) return false;

  // Map the match range back to span indices ([offset, offset+len) per piece, +1 joiner).
  const start = match.index;
  const end = match.index + match[0].length;
  let offset = 0;
  let marked = false;
  for (let i = 0; i < pieces.length; i++) {
    const len = pieces[i]!.length;
    const spanStart = offset;
    const spanEnd = offset + len;
    if (spanEnd > start && spanStart < end && len > 0) {
      const el = spans[i]!;
      if (!el.dataset.ann) {
        markSpanRange(el, ann, start - spanStart, end - spanStart, len);
        marked = true;
      }
    }
    offset = spanEnd + 1; // the " " joiner
  }
  return marked;
}

/**
 * Prose blocks (rendered markdown): locate the anchor across the block's text
 * nodes and wrap each covered portion. Text nodes join with "" — markdown
 * splits words across nodes (`wor**king**` → "wor" + "king"), so any joiner
 * would break both the words and the offset math.
 */
export function markAnchorProse(container: HTMLElement, ann: ReadingAnnotation): boolean {
  if (container.querySelector(`[data-ann="${ann.id}"]`)) return true;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.parentElement?.closest(".rd-hl") ?? null) === null ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const nodes: { node: Text; start: number; end: number }[] = [];
  let full = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent ?? "";
    if (text.length === 0) continue;
    nodes.push({ node: n as Text, start: full.length, end: full.length + text.length });
    full += text;
  }
  if (full.length === 0) return false;
  const lower = full.toLowerCase();

  const patterns = buildAnchorPatterns(ann.anchor);
  if (!patterns) return false;
  let match = patterns.strict.exec(lower);
  if (!match && patterns.loose) match = patterns.loose.exec(stripPunct(lower));
  if (!match) return false;

  const start = match.index;
  const end = match.index + match[0].length;
  let marked = false;
  // Forward iteration: wrapping node i splits only node i, so later node
  // references and their global offsets stay valid.
  for (const { node, start: nodeStart, end: nodeEnd } of nodes) {
    if (nodeEnd <= start || nodeStart >= end) continue;
    const localStart = Math.max(0, start - nodeStart);
    const localEnd = Math.min(nodeEnd, end) - nodeStart;
    if (localEnd <= localStart) continue;
    const range = document.createRange();
    range.setStart(node, localStart);
    range.setEnd(node, localEnd);
    const wrap = document.createElement("span");
    wrap.className = `rd-hl rd-hl--inline rd-hl--${ann.kind}`;
    wrap.dataset.ann = ann.id;
    try {
      range.surroundContents(wrap);
      marked = true;
    } catch {
      /* single-text-node ranges shouldn't throw; skip this node if one does */
    }
  }
  return marked;
}
