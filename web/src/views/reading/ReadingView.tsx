import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { useSnackbar } from "../../components/Snackbar";
import { api } from "../../lib/api";
import { useNotebooks } from "../../lib/useNotebooks";
import type { ReadingAnnotation, ReadingAnnotationKind, ReadingSession } from "../../lib/types";
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locate the annotation's anchor quote in a rendered text layer and mark the
 * covering spans. Matching is whitespace-tolerant (exact words joined by any
 * whitespace), with a looser punctuation-tolerant fallback — pdf.js text-layer
 * text can differ slightly from the server-side extraction.
 */
function markAnchor(container: HTMLElement, ann: ReadingAnnotation): boolean {
  const spans = Array.from(container.querySelectorAll<HTMLElement>(":scope > span, :scope span"));
  if (spans.length === 0) return false;
  const pieces = spans.map((s) => s.textContent ?? "");
  const full = pieces.join(" ").toLowerCase();

  const words = ann.anchor.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const strict = new RegExp(words.map(escapeRegExp).join("[\\s\\u00A0]+"));
  const looseWords = words.map((w) => w.replace(/[^\p{L}\p{N}]+/gu, "")).filter(Boolean);
  const loose = looseWords.length > 0 ? new RegExp(looseWords.map(escapeRegExp).join("[^\\p{L}\\p{N}]+"), "u") : null;

  let match = strict.exec(full);
  if (!match && loose) match = loose.exec(full.replace(/[^\p{L}\p{N} ]+/gu, " "));
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
        el.dataset.ann = ann.id;
        el.classList.add("rd-hl", `rd-hl--${ann.kind}`);
        marked = true;
      }
    }
    offset = spanEnd + 1; // the " " joiner
  }
  return marked;
}

interface PageState {
  /** CSS size at the chosen scale. */
  width: number;
  height: number;
  rendered: boolean;
}

/**
 * Guided reading of one PDF source: pdf.js pages (canvas + text layer) with
 * annotation highlights, and a rail of the coach's prompts. Scaffolding
 * amount came from the session's level at generation time; here we only
 * render what the server produced and persist the learner's responses.
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

  const pagesRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const renderingRef = useRef(new Set<number>());
  const sessionRef = useRef<ReadingSession | null>(null);
  sessionRef.current = session;

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

  // ---------- pdf load (independent of generation status) ----------

  useEffect(() => {
    if (!id || !session?.source) return;
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
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    void (async () => {
      const first = await pdf.getPage(1);
      const base = first.getViewport({ scale: 1 });
      const containerWidth = pagesRef.current?.clientWidth ?? 800;
      const s = Math.min(Math.max((containerWidth - 32) / base.width, 0.5), 2.5);
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

  const applyAnnotations = useCallback((pageNum: number, textLayerDiv: HTMLElement) => {
    const current = sessionRef.current;
    if (!current) return;
    const missing: string[] = [];
    for (const ann of current.annotations) {
      if (ann.page !== pageNum) continue;
      if (!markAnchor(textLayerDiv, ann)) missing.push(ann.id);
    }
    if (missing.length > 0) {
      setUnanchored((prev) => {
        const next = new Set(prev);
        for (const m of missing) next.add(m);
        return next;
      });
    }
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
        const textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textLayerDiv,
          viewport: vp,
        });
        await textLayer.render();

        host.replaceChildren(canvas, textLayerDiv);
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

  // Late annotations (generation finishing after pages rendered) get applied on arrival.
  useEffect(() => {
    if (!session || session.status !== "ready") return;
    const root = pagesRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>(".textLayer").forEach((layer) => {
      const host = layer.parentElement as HTMLDivElement | null;
      const pageNum = Number(host?.dataset.page);
      if (Number.isFinite(pageNum)) applyAnnotations(pageNum, layer);
    });
  }, [session, applyAnnotations]);

  // Highlight click → select the annotation and scroll its card into view.
  // (An onClick prop, not an addEventListener effect: the pages container only
  // exists once the session has loaded, so a mount-time effect would miss it.)
  const onPagesClick = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-ann]");
    if (!target?.dataset.ann) return;
    setSelected(target.dataset.ann);
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

  return (
    <div className="rd">
      <header className="rd__header">
        <IconButton icon="arrow_back" ariaLabel="Back to your coach" onClick={() => navigate(`/learn/${id}`)} />
        <div className="rd__title">
          <span className="title-medium">{sourceName}</span>
          <span className="rd__subtitle label-medium">
            Guided reading · {session.level}
            {generating ? " · the coach is still marking key passages…" : ` · ${session.annotations.length} prompts`}
          </span>
        </div>
        {generating && <ProgressIndicator size={22} />}
      </header>

      <div className="rd__body">
        <div className="rd__pages" ref={pagesRef} onClick={onPagesClick}>
          {pages.length === 0 && (
            <div className="rd__pdf-loading">
              <ProgressIndicator />
              <span className="body-medium">Opening the document…</span>
            </div>
          )}
          {pages.map((p, i) => (
            <div key={i} className="rd-page" style={{ width: p.width, height: p.height }}>
              <div className="rd-page__host" data-page={i + 1} style={{ width: p.width, height: p.height }} />
              <span className="rd-page__num label-medium">{i + 1}</span>
            </div>
          ))}
        </div>

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
              selected={selected === ann.id}
              unanchored={unanchored.has(ann.id)}
              onJump={() => jumpToAnnotation(ann)}
              onResolve={(resolved) => patchAnnotation(ann.id, { resolved })}
              onSaveResponse={(text) => patchAnnotation(ann.id, { userResponse: text })}
              onDiscuss={(draft) => discussWithCoach(ann, draft)}
            />
          ))}

          {session.afterReading.length > 0 && (
            <div className="rd__after">
              <div className="rd__rail-header title-small">
                <Icon name="checklist" size={18} />
                After you finish
              </div>
              <ul className="rd__after-list body-medium">
                {session.afterReading.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <Button icon="send" onClick={finishWithCoach}>
                Take this to your coach
              </Button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

interface AnnotationCardProps {
  ann: ReadingAnnotation;
  selected: boolean;
  unanchored: boolean;
  onJump: () => void;
  onResolve: (resolved: boolean) => void;
  onSaveResponse: (text: string) => void;
  onDiscuss: (draft: string) => void;
}

function AnnotationCard({ ann, selected, unanchored, onJump, onResolve, onSaveResponse, onDiscuss }: AnnotationCardProps) {
  const [draft, setDraft] = useState(ann.userResponse ?? "");
  const respondable = RESPONDABLE.has(ann.kind);

  return (
    <div
      className={`rd-card${selected ? " rd-card--selected" : ""}${ann.resolved ? " rd-card--resolved" : ""}`}
      data-card={ann.id}
    >
      <button type="button" className="rd-card__head" onClick={onJump}>
        <span className={`rd-card__kind rd-card__kind--${ann.kind} label-medium`}>{KIND_LABELS[ann.kind]}</span>
        <span className="rd-card__page label-medium">p. {ann.page}</span>
        {ann.resolved && <Icon name="check" size={16} className="rd-card__check" />}
      </button>
      <blockquote className="rd-card__anchor body-medium">
        “{ann.anchor}”{unanchored && <span className="rd-card__unanchored label-medium"> (couldn't locate on the page)</span>}
      </blockquote>
      <p className="rd-card__prompt body-large">{ann.prompt}</p>
      {respondable && (
        <textarea
          className="rd-card__response body-medium"
          placeholder="Work it out here — in your own words…"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
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
