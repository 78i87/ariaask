import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { TECHNIQUES, techniqueInfo } from "../../lib/techniques";
import "./TechTerm.css";

/**
 * The study-technique chip + floating What/Why/When tooltip, shared by coach
 * markdown, coach user bubbles, and guided-reading prompt cards.
 */

/** Render the `**bold**` markers the technique one-liners use for key words. */
export function emphasize(text: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part));
}

/**
 * A technique-name chip whose tooltip is position:fixed (escapes any
 * scroller's overflow clipping), measured after render, flipped below the
 * term near the viewport top, clamped to the viewport, and closed on any
 * scroll (fixed tooltips would otherwise detach from their scrolling term).
 */
export function TechTerm({ slug, children }: { slug: string; children: ReactNode }) {
  const info = techniqueInfo(slug);
  const termRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const term = termRef.current?.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    if (!term || !tip) return;
    const margin = 8;
    let top = term.top - tip.height - 6;
    if (top < margin) top = term.bottom + 6; // flip below when clipped by the viewport top / header
    // Final clamp: on short viewports even the flipped side can overflow.
    top = Math.min(Math.max(top, margin), Math.max(window.innerHeight - tip.height - margin, margin));
    let left = term.left;
    left = Math.min(Math.max(left, margin), window.innerWidth - tip.width - margin);
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const hide = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // Capture-phase catches inner scrollers' scrolls too.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!info) return <span className="tech-term">{children}</span>;
  const tipId = `tech-tip-${slug}`;
  return (
    <span
      ref={termRef}
      className="tech-term"
      tabIndex={0}
      aria-describedby={open ? tipId : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <div
          ref={tipRef}
          id={tipId}
          role="tooltip"
          className="tech-tooltip"
          style={pos ? { left: pos.left, top: pos.top, visibility: "visible" } : { left: 0, top: 0, visibility: "hidden" }}
        >
          <span className="tech-tooltip__title">{info.label}</span>
          <span className="tech-tooltip__row">
            <span className="tech-tooltip__eyebrow">What</span>
            <span className="tech-tooltip__text">{emphasize(info.what)}</span>
          </span>
          <span className="tech-tooltip__row">
            <span className="tech-tooltip__eyebrow">Why</span>
            <span className="tech-tooltip__text">{emphasize(info.why)}</span>
          </span>
          <span className="tech-tooltip__row">
            <span className="tech-tooltip__eyebrow">When</span>
            <span className="tech-tooltip__text">{emphasize(info.when)}</span>
          </span>
        </div>
      )}
    </span>
  );
}

/**
 * Plain-text technique annotator for places with no markdown pipeline
 * (guided-reading prompts, after-reading items, coach user bubbles): splits
 * the string into text segments and TechTerm chips. First occurrence per
 * technique; overlapping matches are dropped.
 */
export function TechText({ text }: { text: string }) {
  const matches: { start: number; end: number; slug: string }[] = [];
  const seen = new Set<string>();
  for (const t of TECHNIQUES) {
    if (seen.has(t.slug)) continue;
    const m = new RegExp(`\\b(${t.pattern})\\b`, "i").exec(text);
    if (!m) continue;
    seen.add(t.slug);
    matches.push({ start: m.index, end: m.index + m[0].length, slug: t.slug });
  }
  matches.sort((a, b) => a.start - b.start);

  const nodes: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((m, i) => {
    if (m.start < cursor) return; // overlaps a previous chip
    if (m.start > cursor) nodes.push(text.slice(cursor, m.start));
    nodes.push(
      <TechTerm key={`${m.slug}-${i}`} slug={m.slug}>
        {text.slice(m.start, m.end)}
      </TechTerm>,
    );
    cursor = m.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}
