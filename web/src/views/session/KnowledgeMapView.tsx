import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import type { Belief, BeliefStatus, LearningState } from "../../lib/types";
import "./KnowledgeMapView.css";

const STATUS_LABEL: Record<BeliefStatus, string> = {
  understood: "Understood",
  partial: "Partial",
  misconception: "Misconception",
  unknown: "Not yet taught",
};

interface AreaGroup {
  label: string;
  beliefs: Belief[];
}

/** Case-insensitive grouping (belt-and-braces over server canonicalization);
 *  pre-feature beliefs without an area land in a trailing "General" group. */
function groupByArea(beliefs: Belief[]): AreaGroup[] {
  const groups = new Map<string, AreaGroup>();
  const general: AreaGroup = { label: "General", beliefs: [] };
  for (const b of beliefs) {
    const area = b.area?.trim();
    // A model-emitted "General" area must merge into the synthetic group —
    // two sibling sections would collide on the lowercased React key.
    if (!area || area.toLowerCase() === "general") {
      general.beliefs.push(b);
      continue;
    }
    const key = area.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { label: area, beliefs: [] };
      groups.set(key, g);
    }
    g.beliefs.push(b);
  }
  const out = [...groups.values()];
  if (general.beliefs.length > 0) out.push(general);
  return out;
}

interface EdgeGeom {
  key: string;
  from: string;
  to: string;
  d: string;
}

function edgePath(x1: number, y1: number, x2: number, y2: number, vertical: boolean): string {
  if (vertical) {
    const bend = Math.min(Math.max(Math.abs(y2 - y1) / 2, 24), 60) * (y2 >= y1 ? 1 : -1);
    return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
  }
  const bend = Math.min(Math.max(Math.abs(x2 - x1) / 2, 24), 60) * (x2 >= x1 ? 1 : -1);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

interface KnowledgeMapViewProps {
  state: LearningState;
}

/**
 * The knowledge map: every belief is a status-colored node grouped by area,
 * with prerequisite edges drawn in an SVG overlay. Positions are MEASURED
 * (getBoundingClientRect diffs against the canvas), never computed from CSS —
 * a ResizeObserver plus document.fonts.ready keep the overlay glued through
 * re-wraps and late font loads. Scrolling needs no recompute: node and canvas
 * rects shift together.
 */
export function KnowledgeMapView({ state }: KnowledgeMapViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [edges, setEdges] = useState<EdgeGeom[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const rafRef = useRef(0);

  const groups = useMemo(() => groupByArea(state.beliefs), [state.beliefs]);
  const byId = useMemo(() => new Map(state.beliefs.map((b) => [b.id, b])), [state.beliefs]);
  const edgeList = useMemo(() => {
    const out: { from: string; to: string }[] = [];
    for (const b of state.beliefs) {
      for (const dep of b.deps ?? []) {
        if (byId.has(dep)) out.push({ from: dep, to: b.id });
      }
    }
    return out;
  }, [state.beliefs, byId]);

  const counts = useMemo(() => {
    const c: Record<BeliefStatus, number> = { understood: 0, partial: 0, misconception: 0, unknown: 0 };
    for (const b of state.beliefs) c[b.status]++;
    return c;
  }, [state.beliefs]);

  // A rewind re-derivation replaces the inventory wholesale — drop a selection
  // whose node no longer exists.
  useEffect(() => {
    if (selected && !byId.has(selected)) setSelected(null);
  }, [selected, byId]);

  useLayoutEffect(() => {
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const cRect = canvas.getBoundingClientRect();
      const out: EdgeGeom[] = [];
      for (const e of edgeList) {
        const fromEl = nodeRefs.current.get(e.from);
        const toEl = nodeRefs.current.get(e.to);
        if (!fromEl || !toEl) continue;
        const f = fromEl.getBoundingClientRect();
        const t = toEl.getBoundingClientRect();
        const fcx = f.left + f.width / 2 - cRect.left;
        const fcy = f.top + f.height / 2 - cRect.top;
        const tcx = t.left + t.width / 2 - cRect.left;
        const tcy = t.top + t.height / 2 - cRect.top;
        let d: string;
        if (Math.abs(tcy - fcy) > f.height) {
          // Mostly vertical: leave from the facing horizontal edge.
          const down = tcy > fcy;
          d = edgePath(fcx, down ? fcy + f.height / 2 : fcy - f.height / 2, tcx, down ? tcy - t.height / 2 : tcy + t.height / 2, true);
        } else {
          // Same row: side to side.
          const right = tcx > fcx;
          d = edgePath(right ? fcx + f.width / 2 : fcx - f.width / 2, fcy, right ? tcx - t.width / 2 : tcx + t.width / 2, tcy, false);
        }
        out.push({ key: `${e.from}->${e.to}`, from: e.from, to: e.to, d });
      }
      setEdges(out);
    };
    const schedule = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(measure);
    };
    measure();
    const ro = new ResizeObserver(schedule);
    if (canvasRef.current) ro.observe(canvasRef.current);
    // Late font loads re-wrap the pills after first paint.
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => {
      alive = false;
      ro.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [edgeList]);

  const sel = selected ? byId.get(selected) : undefined;
  const selDeps = sel?.deps?.map((id) => byId.get(id)).filter((b): b is Belief => !!b) ?? [];
  const selLeads = sel ? state.beliefs.filter((b) => b.deps?.includes(sel.id)) : [];

  return (
    <div className="session__main kmap-view">
      <div className="session__scroller">
        <div className="kmap" ref={canvasRef}>
          <svg className="kmap__edges" aria-hidden="true">
            {edges.map((e) => (
              <path
                key={e.key}
                className={`kmap__edge${selected && (e.from === selected || e.to === selected) ? " kmap__edge--active" : ""}`}
                d={e.d}
              />
            ))}
          </svg>

          <div className="kmap__header">
            <div className="kmap__progress">
              <span className="title-medium">
                {counts.understood} of {state.beliefs.length} understood
              </span>
              <span className="body-medium kmap__progress-sub">
                {counts.partial} partial · {counts.misconception} misconception{counts.misconception === 1 ? "" : "s"} ·{" "}
                {counts.unknown} not yet taught
              </span>
            </div>
            <div className="kmap__legend label-medium">
              {(["understood", "partial", "misconception", "unknown"] as const).map((s) => (
                <span key={s} className="kmap__legend-item">
                  <span className={`kmap__dot kmap__dot--${s}`} />
                  {STATUS_LABEL[s]}
                </span>
              ))}
              <span className="kmap__legend-item">
                <Icon name="priority_high" size={14} />
                Challenged
              </span>
            </div>
          </div>

          <div className="kmap__groups">
            {groups.map((g) => (
              <section key={g.label.toLowerCase()} className="kmap__group">
                <h3 className="title-small kmap__group-title">{g.label}</h3>
                <div className="kmap__nodes">
                  {g.beliefs.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      ref={(el) => {
                        if (el) nodeRefs.current.set(b.id, el);
                        else nodeRefs.current.delete(b.id);
                      }}
                      className={`kmap__node kmap__node--${b.status}${selected === b.id ? " kmap__node--selected" : ""}`}
                      onClick={() => setSelected((prev) => (prev === b.id ? null : b.id))}
                      aria-label={`${b.concept}, ${STATUS_LABEL[b.status].toLowerCase()}${b.challenged ? ", challenged" : ""}`}
                      aria-pressed={selected === b.id}
                    >
                      {b.challenged && <Icon name="priority_high" size={14} />}
                      <span className="label-large">{b.concept}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      {sel && (
        <div className="kmap__detail">
          <div className="kmap__detail-head">
            <span className={`kmap__dot kmap__dot--${sel.status}`} />
            <span className="title-small kmap__detail-concept">{sel.concept}</span>
            <span className={`kmap__status-chip kmap__status-chip--${sel.status} label-medium`}>
              {STATUS_LABEL[sel.status]}
            </span>
            {sel.challenged && (
              <span className="kmap__challenged label-medium">
                <Icon name="priority_high" size={14} />
                challenged, unconvinced
              </span>
            )}
            <IconButton icon="close" ariaLabel="Close details" onClick={() => setSelected(null)} />
          </div>
          <p className="body-medium kmap__detail-belief">{sel.belief}</p>
          {sel.note && <p className="body-medium kmap__detail-note">Last change: {sel.note}</p>}
          {(selDeps.length > 0 || selLeads.length > 0) && (
            <div className="kmap__detail-links body-medium">
              {selDeps.length > 0 && (
                <span>
                  Builds on:{" "}
                  {selDeps.map((d, i) => (
                    <span key={d.id}>
                      {i > 0 && ", "}
                      <button type="button" className="kmap__link" onClick={() => setSelected(d.id)}>
                        {d.concept}
                      </button>
                    </span>
                  ))}
                </span>
              )}
              {selLeads.length > 0 && (
                <span>
                  Leads to:{" "}
                  {selLeads.map((d, i) => (
                    <span key={d.id}>
                      {i > 0 && ", "}
                      <button type="button" className="kmap__link" onClick={() => setSelected(d.id)}>
                        {d.concept}
                      </button>
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
