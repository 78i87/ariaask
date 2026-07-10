import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { useSnackbar } from "../../components/Snackbar";
import { api } from "../../lib/api";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { useNotebooks } from "../../lib/useNotebooks";
import type { ReadingAnnotation, ReadingAnnotationKind, ReadingSession } from "../../lib/types";
import { markAnchor, markAnchorProse } from "./anchors";
import { TechText } from "../coach/TechTerm";
import "./ReadingView.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const KIND_LABELS: Record<ReadingAnnotationKind, string> = {
  pause: "Pause",
  simplify: "Simplify",
  compare: "Compare",
  connect: "Connect",
  judge: "Judge",
  apply: "Apply",
  technique: "Technique",
};

/** Whether the prompt expects the learner to produce something jottable. */
const RESPONDABLE: Set<ReadingAnnotationKind> = new Set(["simplify", "compare", "connect", "judge", "apply"]);

/**
 * Strip a "Pause here." style lead-in — the card itself is the pause, so the
 * preamble is pure noise. Newer sessions are generated without it; this keeps
 * older sessions consistent.
 */
function concisePrompt(text: string): string {
  const stripped = text.replace(/^\s*(?:pause|stop)(?:\s+here)?\s*[.:;,—–-]\s*/i, "");
  if (stripped === text || stripped.length === 0) return text;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

// ---------- floating-gutter layout constants ----------

/** Body width below which we don't even reserve gutters for floating cards. */
const BREAK_WIDE = 1180;
/** Width kept free on each side of the page for a card column. */
const GUTTER_RESERVE = 320;
const CARD_W = 280;
/** Minimum measured gutter for the floating tier to engage. */
const GUTTER_MIN = 312;
/** Vertical gap between stacked cards in a gutter. */
const CARD_GAP = 12;
/** Connector dot's distance outside the page edge. */
const EDGE_GAP = 10;
/** Where the connector line attaches on the card's edge (below its top). */
const ATTACH_Y = 18;

interface FloatLine {
  id: string;
  d: string;
  dotX: number;
  dotY: number;
}

interface FloatLayout {
  cards: Record<string, { left: number; top: number }>;
  lines: FloatLine[];
}

/**
 * One rendered prose pseudo-page. memo with immutable text is load-bearing,
 * not an optimization: highlight wrappers are imperative DOM mutations inside
 * React-owned nodes, and any re-render would reconcile them away — memo keeps
 * React out after mount (the same contract as the pdf.js text layer).
 */
const ProseBlock = memo(function ProseBlock({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>;
});

interface PageState {
  /** CSS size at the chosen scale. */
  width: number;
  height: number;
  rendered: boolean;
}

/**
 * Guided reading of one PDF source: pdf.js pages (canvas + text layer) with
 * annotation highlights, and the coach's prompts. On wide screens the document
 * sits centered with prompt cards floating in the side gutters, each tied to
 * its highlight by a faint connector line; narrower screens fall back to a
 * side rail, then a stacked layout. Scaffolding amount came from the session's
 * level at generation time; here we only render what the server produced and
 * persist the learner's responses.
 */
export function ReadingView() {
  const { id, rid } = useParams<{ id: string; rid: string }>();
  const navigate = useNavigate();
  const snackbar = useSnackbar();
  const { notebooks } = useNotebooks();

  const [session, setSession] = useState<ReadingSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageState[]>([]);
  const [scale, setScale] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  /** Annotation ids whose anchor couldn't be located in the text layer. */
  const [unanchored, setUnanchored] = useState<Set<string>>(new Set());
  /** Wide tier: cards float in the page gutters instead of the rail. */
  const [floating, setFloating] = useState(false);
  const [layout, setLayout] = useState<FloatLayout | null>(null);

  const pagesRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const renderingRef = useRef(new Set<number>());
  const sessionRef = useRef<ReadingSession | null>(null);
  sessionRef.current = session;

  const wideViewport = useMediaQuery(`(min-width: ${BREAK_WIDE}px)`);
  const wideRef = useRef(wideViewport);
  wideRef.current = wideViewport;
  const floatingRef = useRef(false);

  const notebook = useMemo(() => notebooks?.find((n) => n.id === id) ?? null, [notebooks, id]);
  const sourceName = useMemo(() => {
    const f = notebook?.sourceFiles.find((s) => s.storedName === session?.source);
    return f?.originalName ?? session?.source ?? "";
  }, [notebook, session]);

  // ---------- session load + generation polling ----------

  useEffect(() => {
    if (!id || !rid) return;
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const res = await api.getReading(id, rid);
        if (cancelled) return;
        setSession(res.session);
        if (res.session.status === "generating") {
          timer = window.setTimeout(() => void load(), 3000);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Couldn't load the reading");
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [id, rid]);

  const docType: "pdf" | "prose" = session?.docType === "prose" ? "prose" : "pdf";

  // ---------- pdf load (independent of generation status; pdf docs only) ----------

  useEffect(() => {
    if (!id || !session?.source || session.docType === "prose") return;
    let cancelled = false;
    const task = getDocument({ url: api.sourceUrl(id, session.source) });
    task.promise.then(
      (doc) => {
        if (cancelled) return; // the cleanup's task.destroy() tears the doc down
        pdfRef.current = doc;
        setPdf(doc);
      },
      (err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Couldn't open the PDF");
      },
    );
    return () => {
      cancelled = true;
      void task.destroy();
    };
    // session.source is stable per session id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, session?.source]);

  // Measure pages at scale 1, pick a fit-width scale, set placeholder sizes.
  // On wide screens with prompts (existing or incoming) the fit reserves a
  // card gutter on each side so the document doesn't jump when cards appear.
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    void (async () => {
      const first = await pdf.getPage(1);
      const base = first.getViewport({ scale: 1 });
      const scroller = pagesRef.current;
      const bodyWidth = scroller?.parentElement?.clientWidth ?? 800;
      const sess = sessionRef.current;
      const reserve =
        bodyWidth >= BREAK_WIDE && (sess?.status === "generating" || (sess?.annotations.length ?? 0) > 0);
      const avail = (reserve ? bodyWidth : scroller?.clientWidth ?? 800) - 32 - (reserve ? GUTTER_RESERVE * 2 : 0);
      const s = Math.min(Math.max(avail / base.width, 0.5), 2.5);
      const states: PageState[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = i === 1 ? first : await pdf.getPage(i);
        const vp = page.getViewport({ scale: s });
        states.push({ width: vp.width, height: vp.height, rendered: false });
        if (cancelled) return;
      }
      setScale(s);
      setPages(states);
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf]);

  const applyAnnotations = useCallback((pageNum: number, container: HTMLElement) => {
    const current = sessionRef.current;
    if (!current) return;
    const mark = current.docType === "prose" ? markAnchorProse : markAnchor;
    const missing: string[] = [];
    const found: string[] = [];
    for (const ann of current.annotations) {
      if (ann.page !== pageNum) continue;
      if (mark(container, ann)) found.push(ann.id);
      else missing.push(ann.id);
    }
    setUnanchored((prev) => {
      const changed = missing.some((m) => !prev.has(m)) || found.some((f) => prev.has(f));
      if (!changed) return prev;
      const next = new Set(prev);
      for (const f of found) next.delete(f); // a later pass finding it heals an earlier miss
      for (const m of missing) next.add(m);
      return next;
    });
  }, []);

  const renderPage = useCallback(
    async (pageNum: number, host: HTMLDivElement) => {
      const doc = pdfRef.current;
      if (!doc || renderingRef.current.has(pageNum)) return;
      renderingRef.current.add(pageNum);
      try {
        const page = await doc.getPage(pageNum);
        const vp = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;

        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${vp.width}px`;
        canvas.style.height = `${vp.height}px`;
        const ctx = canvas.getContext("2d")!;
        await page.render({ canvas, canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;

        const textLayerDiv = document.createElement("div");
        textLayerDiv.className = "textLayer";
        textLayerDiv.style.setProperty("--scale-factor", String(scale));
        textLayerDiv.style.setProperty("--total-scale-factor", String(scale));
        // Attach BEFORE render: pdf.js calibrates each span's scaleX by
        // measuring text in place, and a detached div measures as zero —
        // leaving spans uncalibrated (up to ~40% over-wide), which made
        // highlights spill past the quote and across column gaps.
        host.replaceChildren(canvas, textLayerDiv);
        const textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerDiv,
          viewport: vp,
        });
        await textLayer.render();

        applyAnnotations(pageNum, textLayerDiv);
        setPages((prev) => prev.map((p, i) => (i === pageNum - 1 ? { ...p, rendered: true } : p)));
      } catch (err) {
        console.error(`[reading] page ${pageNum} render failed:`, err);
        renderingRef.current.delete(pageNum); // allow a retry when re-observed
      }
    },
    [scale, applyAnnotations],
  );

  // Lazy page rendering via IntersectionObserver over the placeholder hosts.
  useEffect(() => {
    if (pages.length === 0) return;
    const root = pagesRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const host = e.target as HTMLDivElement;
          const pageNum = Number(host.dataset.page);
          observer.unobserve(host);
          void renderPage(pageNum, host);
        }
      },
      { root, rootMargin: "600px" },
    );
    root.querySelectorAll<HTMLDivElement>(".rd-page__host").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pages.length, renderPage]);

  // Late annotations (generation finishing after pages rendered) get applied
  // on arrival. Keyed on status + count, NOT session identity — response
  // saves recreate the session object and must not re-trigger this pass.
  // For prose this is also the PRIMARY application path: blocks mount with the
  // session, there is no per-page render callback.
  const annotationCount = session?.annotations.length ?? 0;
  const sessionStatus = session?.status;
  useEffect(() => {
    if (sessionStatus !== "ready" && sessionStatus !== "generating") return;
    if (annotationCount === 0) return;
    const root = pagesRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>(".textLayer").forEach((layer) => {
      const host = layer.parentElement as HTMLDivElement | null;
      const pageNum = Number(host?.dataset.page);
      if (Number.isFinite(pageNum)) applyAnnotations(pageNum, layer);
    });
    root.querySelectorAll<HTMLElement>(".rd-block").forEach((block) => {
      const pageNum = Number(block.dataset.page);
      if (Number.isFinite(pageNum)) applyAnnotations(pageNum, block);
    });
  }, [sessionStatus, annotationCount, applyAnnotations]);

  // ---------- floating layout pass ----------

  /** Card wrapper elements by annotation id, for height measurement + resize observation. */
  const cardEls = useRef(new Map<string, HTMLElement>());
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  const layoutRafRef = useRef(0);
  const layoutSigRef = useRef("");

  /**
   * Measure highlights and card heights, then place cards in the gutters:
   * alternate sides, head-aligned to the highlight (the connector attaches
   * ATTACH_Y below the card top), a top-down sweep to resolve overlaps and a
   * bottom-up relaxation so nothing spills past the stage. Also decides
   * whether the floating tier is on at all, from the measured gutter width.
   */
  const performLayout = useCallback(() => {
    const stage = stageRef.current;
    const current = sessionRef.current;
    if (!stage || !current) return;
    const anns = current.annotations;
    const pageEls = Array.from(stage.querySelectorAll<HTMLElement>(".rd-page, .rd-block"));
    const stageRect = stage.getBoundingClientRect();

    let shouldFloat = false;
    if (wideRef.current && anns.length > 0 && pageEls.length > 0) {
      // Judge the gutter against the width the stage WOULD have with the rail
      // unmounted — measuring the current stage would make the decision
      // depend on which tier is showing (the rail eats 340px, so floating
      // could never engage from the rail tier).
      const scroller = pagesRef.current;
      const scrollbar = scroller ? scroller.offsetWidth - scroller.clientWidth : 0;
      const prospectiveW = scroller?.parentElement
        ? scroller.parentElement.clientWidth - scrollbar - 32
        : stageRect.width;
      const gutter = (prospectiveW - pageEls[0]!.getBoundingClientRect().width) / 2;
      shouldFloat = gutter >= GUTTER_MIN;
    }
    if (shouldFloat !== floatingRef.current) {
      floatingRef.current = shouldFloat;
      setFloating(shouldFloat);
      if (shouldFloat) {
        // Let the rail unmount and the cards mount first — the layout effect
        // re-runs this pass against the post-flip geometry, so cards never
        // flash at rail-tier coordinates.
        layoutSigRef.current = "";
        setLayout(null);
        return;
      }
    }
    if (!shouldFloat) {
      layoutSigRef.current = "";
      setLayout(null);
      return;
    }

    const pageRect = pageEls[0]!.getBoundingClientRect();
    const stageTop = stageRect.top;
    const pageLeftX = pageRect.left - stageRect.left;
    const pageRightX = pageLeftX + pageRect.width;
    const stageH = stageRect.height;

    interface Item {
      ann: ReadingAnnotation;
      anchorCY: number;
      noLine: boolean;
      h: number;
      top: number;
      side: "left" | "right";
      /** Column the highlight sits in — cards go to the near gutter. */
      sideHint: "left" | "right" | null;
    }
    const items: Item[] = [];
    for (const ann of anns) {
      const span = stage.querySelector(`[data-ann="${CSS.escape(ann.id)}"]`);
      let anchorCY: number;
      let noLine = false;
      let sideHint: Item["sideHint"] = null;
      if (span) {
        const r = span.getBoundingClientRect();
        anchorCY = r.top + r.height / 2 - stageTop;
        // Two-column pages: a highlight clearly left/right of the page center
        // wants its card in the near gutter (full-width lines stay neutral).
        const relX = (r.left + r.width / 2 - stageRect.left - pageLeftX) / pageRect.width;
        sideHint = relX < 0.44 ? "left" : relX > 0.56 ? "right" : null;
      } else {
        // Page not rendered yet, or the quote never anchored: estimate near
        // the top of its page and skip the line (nothing to point at).
        const pageEl = pageEls[ann.page - 1];
        if (!pageEl) continue;
        const pr = pageEl.getBoundingClientRect();
        anchorCY = pr.top - stageTop + Math.min(80, pr.height * 0.1);
        noLine = true;
      }
      const h = cardEls.current.get(ann.id)?.offsetHeight ?? 160;
      items.push({ ann, anchorCY, noLine, h, top: 0, side: "left", sideHint });
    }
    items.sort((a, b) => a.anchorCY - b.anchorCY || a.ann.page - b.ann.page);
    // Hinted items take their column's gutter; neutral ones fill the lighter side.
    let leftCount = 0;
    let rightCount = 0;
    for (const it of items) {
      it.side = it.sideHint ?? (leftCount <= rightCount ? "left" : "right");
      if (it.side === "left") leftCount++;
      else rightCount++;
    }

    for (const side of ["left", "right"] as const) {
      const col = items.filter((it) => it.side === side);
      // Head-align: the card's line-attachment point sits at the highlight's
      // center, so a growing textarea only pushes neighbors below.
      let prevBottom = -Infinity;
      for (const it of col) {
        it.top = Math.max(it.anchorCY - ATTACH_Y, prevBottom + CARD_GAP, 8);
        prevBottom = it.top + it.h;
      }
      // Bottom-up relaxation: pull cards up if the sweep pushed any past the end.
      let nextTop = stageH - 8;
      for (let i = col.length - 1; i >= 0; i--) {
        const it = col[i]!;
        const maxTop = nextTop - it.h;
        if (it.top > maxTop) it.top = Math.max(8, maxTop);
        nextTop = it.top - CARD_GAP;
      }
    }

    const cards: FloatLayout["cards"] = {};
    const lines: FloatLine[] = [];
    for (const it of items) {
      const left = Math.round(
        it.side === "left"
          ? Math.max(4, pageLeftX - EDGE_GAP - 8 - CARD_W)
          : Math.min(stageRect.width - CARD_W - 4, pageRightX + EDGE_GAP + 8),
      );
      const top = Math.round(it.top);
      cards[it.ann.id] = { left, top };
      if (it.noLine) continue;
      const dotX = Math.round(it.side === "left" ? pageLeftX - EDGE_GAP : pageRightX + EDGE_GAP);
      const dotY = Math.round(it.anchorCY);
      const startX = it.side === "left" ? left + CARD_W : left;
      const startY = top + ATTACH_Y;
      // Cubic bezier with horizontal tangents at both ends, card edge → dot.
      const dx = (dotX - startX) / 2;
      const d = `M ${startX} ${startY} C ${Math.round(startX + dx)} ${startY}, ${Math.round(dotX - dx)} ${dotY}, ${dotX} ${dotY}`;
      lines.push({ id: it.ann.id, d, dotX, dotY });
    }

    const next: FloatLayout = { cards, lines };
    const sig = JSON.stringify(next);
    if (sig === layoutSigRef.current) return; // equality guard: no churn, no loops
    layoutSigRef.current = sig;
    setLayout(next);
  }, []);

  /** rAF-coalesced: many triggers (resize, renders, healing) → one measure pass. */
  const requestLayout = useCallback(() => {
    if (layoutRafRef.current) return;
    layoutRafRef.current = requestAnimationFrame(() => {
      layoutRafRef.current = 0;
      performLayout();
    });
  }, [performLayout]);

  // Reset the guard after cancelling: StrictMode runs this cleanup between
  // its double-mount, and a stale id would block every later requestLayout.
  useEffect(
    () => () => {
      cancelAnimationFrame(layoutRafRef.current);
      layoutRafRef.current = 0;
    },
    [],
  );

  const annotations = session?.annotations;
  useLayoutEffect(() => {
    requestLayout();
  }, [pages, scale, annotations, unanchored, wideViewport, floating, requestLayout]);

  // One observer covers the stage (width changes) and every card (textarea
  // growth, content changes). Positions come from the layout pass, so moved
  // cards don't re-fire it — only real size changes do.
  const hasSession = session !== null;
  useEffect(() => {
    const ro = new ResizeObserver(() => requestLayout());
    resizeObsRef.current = ro;
    if (stageRef.current) ro.observe(stageRef.current);
    cardEls.current.forEach((el) => ro.observe(el));
    return () => {
      ro.disconnect();
      resizeObsRef.current = null;
    };
  }, [hasSession, floating, requestLayout]);

  const setCardEl = useCallback((annId: string, el: HTMLElement | null) => {
    const prev = cardEls.current.get(annId);
    if (prev) resizeObsRef.current?.unobserve(prev);
    if (el) {
      cardEls.current.set(annId, el);
      resizeObsRef.current?.observe(el);
    } else {
      cardEls.current.delete(annId);
    }
  }, []);

  // Highlight click → select the annotation; in the rail tiers also scroll its
  // card into view (floating cards already sit beside their highlight).
  // (An onClick prop, not an addEventListener effect: the pages container only
  // exists once the session has loaded, so a mount-time effect would miss it.
  // Floating-card clicks bubble here too but have no [data-ann] ancestor.)
  const onPagesClick = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-ann]");
    if (!target?.dataset.ann) return;
    setSelected(target.dataset.ann);
    if (floating) return;
    railRef.current
      ?.querySelector(`[data-card="${target.dataset.ann}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const jumpToAnnotation = (ann: ReadingAnnotation) => {
    setSelected(ann.id);
    const root = pagesRef.current;
    if (!root) return;
    const span = root.querySelector<HTMLElement>(`[data-ann="${ann.id}"]`);
    const target = span ?? root.querySelector<HTMLElement>(`[data-page="${ann.page}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (span) {
      root.querySelectorAll(".rd-hl--flash").forEach((el) => el.classList.remove("rd-hl--flash"));
      root.querySelectorAll(`[data-ann="${ann.id}"]`).forEach((el) => el.classList.add("rd-hl--flash"));
      window.setTimeout(() => {
        root.querySelectorAll(`[data-ann="${ann.id}"]`).forEach((el) => el.classList.remove("rd-hl--flash"));
      }, 1600);
    }
  };

  // Selected-annotation emphasis on the highlights themselves.
  useEffect(() => {
    const root = pagesRef.current;
    if (!root) return;
    root.querySelectorAll(".rd-hl--selected").forEach((el) => el.classList.remove("rd-hl--selected"));
    if (selected) {
      root.querySelectorAll(`[data-ann="${selected}"]`).forEach((el) => el.classList.add("rd-hl--selected"));
    }
  }, [selected]);

  // ---------- annotation actions ----------

  const patchAnnotation = (aid: string, patch: { userResponse?: string; resolved?: boolean }) => {
    if (!id || !rid) return;
    setSession((prev) =>
      prev
        ? { ...prev, annotations: prev.annotations.map((a) => (a.id === aid ? { ...a, ...patch } : a)) }
        : prev,
    );
    void api.updateReadingAnnotation(id, rid, aid, patch).catch(() => snackbar.show("Couldn't save"));
  };

  const discussWithCoach = (ann: ReadingAnnotation, draft: string) => {
    if (!id) return;
    if (draft.trim() && draft !== ann.userResponse) patchAnnotation(ann.id, { userResponse: draft });
    const text = [
      `From my guided reading of "${sourceName}" (page ${ann.page}):`,
      `> ${ann.anchor}`,
      `The prompt (${KIND_LABELS[ann.kind]}): ${ann.prompt}`,
      draft.trim() ? `My answer: ${draft.trim()}` : "I'm stuck on this one — can you scaffold it for me?",
    ].join("\n\n");
    void api
      .sendCoachMessage(id, { text, clientMessageId: crypto.randomUUID() })
      .then(() => navigate(`/learn/${id}`))
      .catch((err) => snackbar.show(err instanceof Error ? err.message : "Couldn't reach the coach"));
  };

  const finishWithCoach = () => {
    if (!id || !session) return;
    const done = session.annotations.filter((a) => a.resolved).length;
    const text = [
      `I've finished the guided reading of "${sourceName}" (${done}/${session.annotations.length} prompts worked through).`,
      session.afterReading.length > 0 ? `The suggested next steps were:\n${session.afterReading.map((s) => `- ${s}`).join("\n")}` : "",
      "What should I start with?",
    ]
      .filter(Boolean)
      .join("\n\n");
    void api
      .sendCoachMessage(id, { text, clientMessageId: crypto.randomUUID() })
      .then(() => navigate(`/learn/${id}`))
      .catch((err) => snackbar.show(err instanceof Error ? err.message : "Couldn't reach the coach"));
  };

  // ---------- render ----------

  if (loadError) {
    return (
      <div className="rd rd--message">
        <Icon name="error" size={32} />
        <p className="body-large">{loadError}</p>
        <Button onClick={() => navigate(`/learn/${id}`)}>Back to your coach</Button>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="rd rd--message">
        <ProgressIndicator />
      </div>
    );
  }
  if (session.status === "failed") {
    return (
      <div className="rd rd--message">
        <Icon name="error" size={32} />
        <p className="body-large">{session.error ?? "The coach couldn't prepare this reading."}</p>
        <Button onClick={() => navigate(`/learn/${id}`)}>Back to your coach</Button>
      </div>
    );
  }

  const generating = session.status === "generating";
  const byPage = session.annotations;
  const total = byPage.length;
  const done = byPage.filter((a) => a.resolved).length;

  const afterBlock = session.afterReading.length > 0 && (
    <div className={`rd__after${floating ? " rd__after--stage" : ""}`}>
      <div className="rd__rail-header title-small">
        <Icon name="checklist" size={18} />
        After you finish
      </div>
      <ul className="rd__after-list body-medium">
        {session.afterReading.map((s, i) => (
          <li key={i}>
            <TechText text={s} />
          </li>
        ))}
      </ul>
      <Button icon="send" onClick={finishWithCoach}>
        Take this to your coach
      </Button>
    </div>
  );

  return (
    <div className="rd">
      <header className="rd__header">
        <IconButton icon="arrow_back" ariaLabel="Back to your coach" onClick={() => navigate(`/learn/${id}`)} />
        <div className="rd__title">
          <span className="title-medium">{sourceName}</span>
          <span className="rd__subtitle label-medium">
            Guided reading · {session.level}
            {generating
              ? " · the coach is still marking key passages…"
              : total > 0
                ? ` · ${done} of ${total} done`
                : ""}
          </span>
        </div>
        {generating && <ProgressIndicator size={22} />}
        {total > 0 && (
          <div
            className="rd__progress"
            role="progressbar"
            aria-label="Prompts completed"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
          >
            <div className="rd__progress-fill" style={{ width: `${(done / total) * 100}%` }} />
          </div>
        )}
      </header>

      <div className="rd__body">
        <div className="rd__pages" ref={pagesRef} onClick={onPagesClick}>
          {docType === "pdf" && pages.length === 0 && (
            <div className="rd__pdf-loading">
              <ProgressIndicator />
              <span className="body-medium">Opening the document…</span>
            </div>
          )}
          <div
            className={`rd__stage${
              docType === "prose" && wideViewport && (generating || byPage.length > 0) ? " rd__stage--reserve" : ""
            }`}
            ref={stageRef}
          >
            {floating && layout && (
              <svg className="rd__overlay" aria-hidden="true">
                {layout.lines.map((l) => (
                  <g key={l.id} className={`rd-line${selected === l.id ? " rd-line--selected" : ""}`}>
                    <path d={l.d} />
                    <circle cx={l.dotX} cy={l.dotY} r={3} />
                  </g>
                ))}
              </svg>
            )}
            {(session.priming?.length ?? 0) > 0 && (
              <div className="rd__priming">
                <div className="rd__rail-header title-small">
                  <Icon name="psychology" size={18} />
                  Before you read
                </div>
                <ul className="rd__after-list body-medium">
                  {session.priming!.map((q, i) => (
                    <li key={i}>
                      <TechText text={q} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {docType === "pdf" &&
              pages.map((p, i) => (
                <div key={i} className="rd-page" style={{ width: p.width, height: p.height }}>
                  <div className="rd-page__host" data-page={i + 1} style={{ width: p.width, height: p.height }} />
                  <span className="rd-page__num label-medium">{i + 1}</span>
                </div>
              ))}
            {docType === "prose" &&
              (session.textPages ?? []).map((text, i) => (
                <div key={i} className="rd-block" data-page={i + 1}>
                  <ProseBlock text={text} />
                </div>
              ))}
            {floating && afterBlock}
            {floating &&
              byPage.map((ann) => {
                const pos = layout?.cards[ann.id];
                return (
                  <div
                    key={ann.id}
                    className="rd-float"
                    ref={(el) => setCardEl(ann.id, el)}
                    style={
                      pos
                        ? { left: pos.left, top: pos.top, visibility: "visible" }
                        : { left: 0, top: 0, visibility: "hidden" }
                    }
                  >
                    <AnnotationCard
                      ann={ann}
                      compact
                      pageLabel={docType === "prose" ? `§ ${ann.page}` : `p. ${ann.page}`}
                      selected={selected === ann.id}
                      unanchored={unanchored.has(ann.id)}
                      onJump={() => jumpToAnnotation(ann)}
                      onResolve={(resolved) => patchAnnotation(ann.id, { resolved })}
                      onSaveResponse={(text) => patchAnnotation(ann.id, { userResponse: text })}
                      onDiscuss={(draft) => discussWithCoach(ann, draft)}
                    />
                  </div>
                );
              })}
          </div>
        </div>

        {!floating && (
          <aside className="rd__rail" ref={railRef}>
            <div className="rd__rail-header title-small">
              <Icon name="psychology" size={18} />
              Coach prompts
            </div>
            {generating && byPage.length === 0 && (
              <p className="rd__rail-empty body-medium">
                Read on — prompts will appear here once the coach has been through the document.
              </p>
            )}
            {!generating && byPage.length === 0 && (
              <p className="rd__rail-empty body-medium">
                No in-document prompts at this level — find the key passages yourself, then use the
                after-reading steps below.
              </p>
            )}
            {byPage.map((ann) => (
              <AnnotationCard
                key={ann.id}
                ann={ann}
                pageLabel={docType === "prose" ? `§ ${ann.page}` : `p. ${ann.page}`}
                selected={selected === ann.id}
                unanchored={unanchored.has(ann.id)}
                onJump={() => jumpToAnnotation(ann)}
                onResolve={(resolved) => patchAnnotation(ann.id, { resolved })}
                onSaveResponse={(text) => patchAnnotation(ann.id, { userResponse: text })}
                onDiscuss={(draft) => discussWithCoach(ann, draft)}
              />
            ))}

            {afterBlock}
          </aside>
        )}
      </div>
    </div>
  );
}

interface AnnotationCardProps {
  ann: ReadingAnnotation;
  selected: boolean;
  unanchored: boolean;
  /** Floating-gutter cards start slim (one-line response box) until engaged. */
  compact?: boolean;
  /** "p. 3" for PDFs, "§ 3" for prose pseudo-pages. */
  pageLabel: string;
  onJump: () => void;
  onResolve: (resolved: boolean) => void;
  onSaveResponse: (text: string) => void;
  onDiscuss: (draft: string) => void;
}

function AnnotationCard({ ann, selected, unanchored, compact, pageLabel, onJump, onResolve, onSaveResponse, onDiscuss }: AnnotationCardProps) {
  const [draft, setDraft] = useState(ann.userResponse ?? "");
  const [editing, setEditing] = useState(false);
  const respondable = RESPONDABLE.has(ann.kind);
  const slim = Boolean(compact) && !editing && draft.trim() === "";

  return (
    <div
      className={`rd-card${selected ? " rd-card--selected" : ""}${ann.resolved ? " rd-card--resolved" : ""}`}
      data-card={ann.id}
    >
      <button type="button" className="rd-card__head" onClick={onJump}>
        <span className={`rd-card__kind rd-card__kind--${ann.kind} label-medium`}>{KIND_LABELS[ann.kind]}</span>
        <span className="rd-card__page label-medium">{pageLabel}</span>
        {ann.resolved && <Icon name="check" size={16} className="rd-card__check" />}
      </button>
      <blockquote className="rd-card__anchor body-medium">
        “{ann.anchor}”{unanchored && <span className="rd-card__unanchored label-medium"> (couldn't locate on the page)</span>}
      </blockquote>
      <p className="rd-card__prompt body-medium">
        <TechText text={concisePrompt(ann.prompt)} />
      </p>
      {ann.followUps?.map((f, i) => (
        <p key={i} className="rd-card__followup body-medium">
          <span className="rd-card__followup-marker">then</span>
          <TechText text={f} />
        </p>
      ))}
      {respondable && (
        <textarea
          className="rd-card__response body-medium"
          placeholder="Work it out here — in your own words…"
          rows={slim ? 1 : compact ? 3 : 2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => {
            setEditing(false);
            if (draft !== (ann.userResponse ?? "")) onSaveResponse(draft);
          }}
        />
      )}
      <div className="rd-card__actions">
        <button type="button" className="msg-action" onClick={() => onResolve(!ann.resolved)}>
          <Icon name="check" size={16} />
          <span className="label-medium">{ann.resolved ? "Undo" : "Done"}</span>
        </button>
        <button type="button" className="msg-action" onClick={() => onDiscuss(draft)}>
          <Icon name="psychology" size={16} />
          <span className="label-medium">Discuss with coach</span>
        </button>
      </div>
    </div>
  );
}
