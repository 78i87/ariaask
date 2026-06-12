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

// ---------- force simulation (hand-rolled; ≤40 nodes, n² is nothing) ----------

interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Visual + collision radius; scaled by degree. */
  r: number;
  /** Lowercased area key ("" = General). */
  area: string;
}

interface Sim {
  nodes: SimNode[];
  byId: Map<string, SimNode>;
  /** Index pairs into nodes. */
  edges: [number, number][];
  alpha: number;
}

const REPULSION = 3200;
const SPRING_K = 0.045;
const SPRING_LEN = 95;
const AREA_PULL = 0.014;
const CENTER_PULL = 0.0045;
const DAMPING = 0.8;
const ALPHA_DECAY = 0.993;
const ALPHA_MIN = 0.02;

function tick(sim: Sim): void {
  const { nodes, edges, alpha } = sim;
  const n = nodes.length;

  // Pairwise repulsion.
  for (let i = 0; i < n; i++) {
    const a = nodes[i]!;
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        // Coincident nodes: nudge apart deterministically.
        dx = (i - j) * 0.1;
        dy = 0.1;
        d2 = dx * dx + dy * dy;
      }
      const f = Math.min((REPULSION / d2) * alpha, 12);
      const d = Math.sqrt(d2);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // Springs along prerequisite edges.
  for (const [i, j] of edges) {
    const a = nodes[i]!;
    const b = nodes[j]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - SPRING_LEN) * SPRING_K * alpha;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  // Same-area cohesion (what turns areas into visible constellations) +
  // gentle global centering.
  const centroids = new Map<string, { x: number; y: number; n: number }>();
  for (const node of nodes) {
    const c = centroids.get(node.area) ?? { x: 0, y: 0, n: 0 };
    c.x += node.x;
    c.y += node.y;
    c.n++;
    centroids.set(node.area, c);
  }
  for (const node of nodes) {
    const c = centroids.get(node.area)!;
    if (c.n > 1) {
      node.vx += (c.x / c.n - node.x) * AREA_PULL * alpha;
      node.vy += (c.y / c.n - node.y) * AREA_PULL * alpha;
    }
    node.vx -= node.x * CENTER_PULL * alpha;
    node.vy -= node.y * CENTER_PULL * alpha;
  }

  for (const node of nodes) {
    node.vx *= DAMPING;
    node.vy *= DAMPING;
    node.x += node.vx;
    node.y += node.vy;
  }
  sim.alpha *= ALPHA_DECAY;
}

function areaKey(b: Belief): string {
  const a = b.area?.trim().toLowerCase();
  return a && a !== "general" ? a : "";
}

/** Deterministic seed positions: areas fan out around the origin, members spiral within. */
function seedPosition(areaIdx: number, areaCount: number, memberIdx: number): { x: number; y: number } {
  const baseAngle = (areaIdx / Math.max(areaCount, 1)) * Math.PI * 2;
  const angle = baseAngle + memberIdx * 0.9;
  const radius = 90 + memberIdx * 26;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

// ---------- component ----------

interface KnowledgeMapViewProps {
  state: LearningState;
}

/**
 * The knowledge map as a force-directed constellation: every belief is a
 * status-colored node, prerequisite deps are the links, and same-area nodes
 * pull together into visible clusters (faint area labels at their centroids).
 * Drag the background to pan, scroll to zoom, drag nodes to rearrange, hover
 * to spotlight a neighborhood, click for the detail strip.
 *
 * The simulation lives entirely in refs and writes positions straight to the
 * SVG elements each frame — React only re-renders on data/selection changes
 * and never owns transform/x/y attributes.
 */
export function KnowledgeMapView({ state }: KnowledgeMapViewProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  /** Area key spotlighted from the sidebar or a caption click; exclusive with node selection. */
  const [focusArea, setFocusArea] = useState<string | null>(null);
  /** Status spotlighted from the legend ("challenged" = the challenged flag, not a status). */
  const [focusStatus, setFocusStatus] = useState<BeliefStatus | "challenged" | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef(new Map<string, SVGLineElement>());
  const areaEls = useRef(new Map<string, SVGTextElement>());
  const simRef = useRef<Sim>({ nodes: [], byId: new Map(), edges: [], alpha: 0 });
  const viewRef = useRef({ x: -400, y: -300, w: 800, h: 600 });
  const viewFitted = useRef(false);
  const rafRef = useRef(0);
  const runningRef = useRef(false);

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

  /** Area display labels keyed by area key; insertion order = first appearance. */
  const areas = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of state.beliefs) {
      const key = areaKey(b);
      if (!m.has(key)) m.set(key, key === "" ? "General" : b.area!.trim());
    }
    return m;
  }, [state.beliefs]);

  /** Sidebar outline: areas with their member beliefs, "General" last. */
  const grouped = useMemo(() => {
    const m = new Map<string, { key: string; label: string; beliefs: Belief[] }>();
    for (const b of state.beliefs) {
      const key = areaKey(b);
      let g = m.get(key);
      if (!g) m.set(key, (g = { key, label: key === "" ? "General" : b.area!.trim(), beliefs: [] }));
      g.beliefs.push(b);
    }
    const arr = [...m.values()];
    const gi = arr.findIndex((g) => g.key === "");
    if (gi >= 0) arr.push(...arr.splice(gi, 1));
    return arr;
  }, [state.beliefs]);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of edgeList) {
      d.set(e.from, (d.get(e.from) ?? 0) + 1);
      d.set(e.to, (d.get(e.to) ?? 0) + 1);
    }
    return d;
  }, [edgeList]);

  /** Neighborhood for hover/selection spotlighting. */
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const b of state.beliefs) m.set(b.id, new Set([b.id]));
    for (const e of edgeList) {
      m.get(e.from)!.add(e.to);
      m.get(e.to)!.add(e.from);
    }
    return m;
  }, [state.beliefs, edgeList]);

  const counts = useMemo(() => {
    const c: Record<BeliefStatus, number> = { understood: 0, partial: 0, misconception: 0, unknown: 0 };
    for (const b of state.beliefs) c[b.status]++;
    return c;
  }, [state.beliefs]);

  useEffect(() => {
    if (selected && !byId.has(selected)) setSelected(null);
    // A removed node fires no pointerleave — a dead hovered id would shadow
    // the selection spotlight (focusId = hovered ?? selected).
    if (hovered && !byId.has(hovered)) setHovered(null);
    // A rewind re-derivation can rename every area.
    if (focusArea !== null && !areas.has(focusArea)) setFocusArea(null);
  }, [selected, hovered, focusArea, byId, areas]);

  /** Node, area, and status spotlights are mutually exclusive. */
  const selectNode = (id: string) => {
    setFocusArea(null);
    setFocusStatus(null);
    setSelected((prev) => (prev === id ? null : id));
  };
  const selectArea = (key: string) => {
    setSelected(null);
    setFocusStatus(null);
    setFocusArea((prev) => (prev === key ? null : key));
  };
  const selectStatus = (s: BeliefStatus | "challenged") => {
    setSelected(null);
    setFocusArea(null);
    setFocusStatus((prev) => (prev === s ? null : s));
  };

  /** Pan (keeping zoom) so a sidebar-picked node is actually on screen. */
  const ensureVisible = (id: string) => {
    const node = simRef.current.byId.get(id);
    if (!node) return;
    const v = viewRef.current;
    const m = 60;
    if (node.x < v.x + m || node.x > v.x + v.w - m || node.y < v.y + m || node.y > v.y + v.h - m) {
      viewRef.current = { ...v, x: node.x - v.w / 2, y: node.y - v.h / 2 };
      applyView();
    }
  };

  // ---- simulation lifecycle ----

  const applyPositions = () => {
    const sim = simRef.current;
    for (const node of sim.nodes) {
      const el = nodeEls.current.get(node.id);
      if (el) el.setAttribute("transform", `translate(${node.x} ${node.y})`);
    }
    for (const e of edgeEls.current) {
      const [key, el] = e;
      const sep = key.indexOf("->");
      const a = sim.byId.get(key.slice(0, sep));
      const b = sim.byId.get(key.slice(sep + 2));
      if (a && b) {
        el.setAttribute("x1", String(a.x));
        el.setAttribute("y1", String(a.y));
        el.setAttribute("x2", String(b.x));
        el.setAttribute("y2", String(b.y));
      }
    }
    // Area labels sit above their cluster.
    const centroids = new Map<string, { x: number; y: number; top: number; n: number }>();
    for (const node of sim.nodes) {
      const c = centroids.get(node.area) ?? { x: 0, y: 0, top: Infinity, n: 0 };
      c.x += node.x;
      c.y += node.y;
      c.top = Math.min(c.top, node.y);
      c.n++;
      centroids.set(node.area, c);
    }
    for (const [key, el] of areaEls.current) {
      const c = centroids.get(key);
      if (c && c.n > 0) {
        el.setAttribute("x", String(c.x / c.n));
        el.setAttribute("y", String(c.top - 34));
      }
    }
  };

  const applyView = () => {
    const v = viewRef.current;
    svgRef.current?.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  };

  /** Frame the whole constellation. Used on first layout and double-click. */
  const fitView = () => {
    const nodes = simRef.current.nodes;
    if (nodes.length === 0) return;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const pad = 110;
    viewRef.current = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
    applyView();
  };

  const startLoop = () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const step = () => {
      const sim = simRef.current;
      if (sim.alpha <= ALPHA_MIN) {
        runningRef.current = false;
        return;
      }
      tick(sim);
      // Pin the grabbed node: tick() applies forces to every node, and
      // pointermove only fires while the cursor moves — without this the
      // node slides out from under a stationary pointer mid-drag.
      const g = gesture.current;
      if (g?.kind === "node" && g.moved) {
        const node = sim.byId.get(g.id);
        if (node) {
          node.x = g.x;
          node.y = g.y;
          node.vx = 0;
          node.vy = 0;
        }
      } else if (g?.kind === "area" && g.moved) {
        for (const [id, pos] of g.positions) {
          const node = sim.byId.get(id);
          if (node) {
            node.x = pos.x;
            node.y = pos.y;
            node.vx = 0;
            node.vy = 0;
          }
        }
      }
      applyPositions();
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  const reheat = (alpha: number) => {
    simRef.current.alpha = Math.max(simRef.current.alpha, alpha);
    startLoop();
  };

  // Reconcile the simulation with the data: keep positions of surviving nodes
  // (the map must not rearrange wildly on every evaluator pass), seed new ones
  // near their area-mates, drop the gone.
  useLayoutEffect(() => {
    const sim = simRef.current;
    const prev = sim.byId;
    const areaKeys = [...areas.keys()];
    const memberCount = new Map<string, number>();
    const fresh = sim.nodes.length === 0;
    // A rewind re-derivation replaces the inventory wholesale (all-new ids) —
    // an incremental evaluator pass only ever adds; it never replaces them all.
    const wholesale = !fresh && state.beliefs.length > 0 && state.beliefs.every((b) => !prev.has(b.id));

    const nodes: SimNode[] = state.beliefs.map((b) => {
      const key = areaKey(b);
      const idx = memberCount.get(key) ?? 0;
      memberCount.set(key, idx + 1);
      const r = 6 + Math.min(Math.sqrt(degree.get(b.id) ?? 0) * 2.6, 8);
      const existing = prev.get(b.id);
      if (existing) {
        existing.r = r;
        existing.area = key;
        return existing;
      }
      // New node: drop it near its area's current centroid if one exists.
      const mates = sim.nodes.filter((n) => n.area === key);
      if (mates.length > 0) {
        const cx = mates.reduce((s, n) => s + n.x, 0) / mates.length;
        const cy = mates.reduce((s, n) => s + n.y, 0) / mates.length;
        return { id: b.id, x: cx + 18 * (idx + 1), y: cy + 14, vx: 0, vy: 0, r, area: key };
      }
      const p = seedPosition(areaKeys.indexOf(key), areaKeys.length, idx);
      return { id: b.id, x: p.x, y: p.y, vx: 0, vy: 0, r, area: key };
    });

    sim.nodes = nodes;
    sim.byId = new Map(nodes.map((n) => [n.id, n]));
    const indexOf = new Map(nodes.map((n, i) => [n.id, i]));
    sim.edges = edgeList.map((e) => [indexOf.get(e.from)!, indexOf.get(e.to)!]);

    if (fresh || wholesale) {
      // Pre-settle synchronously so the first paint is already a layout, not
      // an explosion; then frame it — on a wholesale replacement the user may
      // have panned/zoomed somewhere the new graph doesn't reach.
      sim.alpha = 1;
      for (let i = 0; i < 300 && sim.alpha > ALPHA_MIN; i++) tick(sim);
      sim.alpha = 0.08;
      fitView();
      viewFitted.current = true;
    } else {
      sim.alpha = Math.max(sim.alpha, 0.5);
    }
    applyView();
    applyPositions();
    startLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.beliefs, edgeList, areas, degree]);

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      runningRef.current = false;
    };
  }, []);

  // ---- pan / zoom / drag ----

  // Screen → world through the live CTM: the svg letterboxes the viewBox
  // (default preserveAspectRatio "xMidYMid meet"), so naive per-axis linear
  // mapping is wrong whenever the pane and viewBox aspects differ — which
  // after a fit they almost always do.
  const toWorld = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  };

  // React attaches wheel listeners passively, so preventDefault there is a
  // no-op — and a macOS trackpad pinch (wheel + ctrlKey) would zoom the whole
  // page on top of the map. Native non-passive listener instead.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(e.deltaY * 0.002);
      const v = viewRef.current;
      const p = toWorld(e.clientX, e.clientY);
      const w = Math.min(Math.max(v.w * factor, 220), 6000);
      const f = w / v.w;
      // Uniform scale around p keeps the world point under the cursor fixed
      // even with letterboxing (the viewBox aspect is preserved).
      viewRef.current = { x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, w, h: v.h * f };
      applyView();
    };
    svg.addEventListener("wheel", onWheelNative, { passive: false });
    return () => svg.removeEventListener("wheel", onWheelNative);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * null = no gesture. One pointer owns a gesture (a second touch is ignored
   * rather than clobbering it). A node/area press becomes a drag only after
   * ≥5px of SCREEN-space cursor travel — measured against the pointerdown
   * point, never sim positions, which drift while the layout settles.
   */
  const gesture = useRef<
    | { kind: "pan"; pointerId: number; startX: number; startY: number; view: { x: number; y: number; w: number; h: number }; worldPerPx: number }
    | { kind: "node"; pointerId: number; id: string; startX: number; startY: number; moved: boolean; dx: number; dy: number; x: number; y: number }
    | {
        kind: "area";
        pointerId: number;
        key: string;
        startX: number;
        startY: number;
        moved: boolean;
        lastX: number;
        lastY: number;
        /** Asserted positions of the cluster's nodes — the step loop re-pins them each tick. */
        positions: Map<string, { x: number; y: number }>;
      }
    | null
  >(null);

  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || gesture.current) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    // "meet" renders at the uniform scale min(px/world) — so world-per-px is
    // the max ratio, identical on both axes.
    const worldPerPx = Math.max(v.w / rect.width, v.h / rect.height);
    gesture.current = { kind: "pan", pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, view: { ...v }, worldPerPx };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onNodePointerDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0 || gesture.current) return;
    e.stopPropagation();
    const node = simRef.current.byId.get(id);
    if (!node) return;
    const p = toWorld(e.clientX, e.clientY);
    gesture.current = {
      kind: "node",
      pointerId: e.pointerId,
      id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      // Grab offset: the node must follow the cursor from where it was
      // grabbed, not teleport its center under the pointer.
      dx: node.x - p.x,
      dy: node.y - p.y,
      x: node.x,
      y: node.y,
    };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  /** Dragging an area caption moves its whole cluster rigidly; a plain click spotlights it. */
  const onAreaPointerDown = (key: string) => (e: React.PointerEvent) => {
    if (e.button !== 0 || gesture.current) return;
    e.stopPropagation();
    const p = toWorld(e.clientX, e.clientY);
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of simRef.current.nodes) {
      if (node.area === key) positions.set(node.id, { x: node.x, y: node.y });
    }
    gesture.current = {
      kind: "area",
      pointerId: e.pointerId,
      key,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      lastX: p.x,
      lastY: p.y,
      positions,
    };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    if (g.kind === "pan") {
      viewRef.current = {
        ...viewRef.current,
        x: g.view.x - (e.clientX - g.startX) * g.worldPerPx,
        y: g.view.y - (e.clientY - g.startY) * g.worldPerPx,
      };
      applyView();
    } else if (g.kind === "node") {
      if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 5) return;
      const node = simRef.current.byId.get(g.id);
      if (!node) return;
      g.moved = true;
      const p = toWorld(e.clientX, e.clientY);
      g.x = p.x + g.dx;
      g.y = p.y + g.dy;
      node.x = g.x;
      node.y = g.y;
      node.vx = 0;
      node.vy = 0;
      reheat(0.3);
      applyPositions();
    } else {
      if (!g.moved && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 5) return;
      g.moved = true;
      const p = toWorld(e.clientX, e.clientY);
      const dx = p.x - g.lastX;
      const dy = p.y - g.lastY;
      g.lastX = p.x;
      g.lastY = p.y;
      for (const node of simRef.current.nodes) {
        if (node.area !== g.key) continue;
        node.x += dx;
        node.y += dy;
        node.vx = 0;
        node.vy = 0;
        g.positions.set(node.id, { x: node.x, y: node.y });
      }
      reheat(0.25);
      applyPositions();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointerId) return;
    gesture.current = null;
    if (g.kind === "node" && !g.moved) selectNode(g.id);
    if (g.kind === "area" && !g.moved) selectArea(g.key);
  };

  // ---- render ----

  // Spotlight precedence: live hover > node selection > area focus > status filter.
  const focusId = hovered ?? selected;
  const focusSet = useMemo(() => {
    if (focusId) return neighbors.get(focusId) ?? null;
    if (focusArea !== null) return new Set(state.beliefs.filter((b) => areaKey(b) === focusArea).map((b) => b.id));
    if (focusStatus !== null) {
      return new Set(
        state.beliefs
          .filter((b) => (focusStatus === "challenged" ? b.challenged === true : b.status === focusStatus))
          .map((b) => b.id),
      );
    }
    return null;
  }, [focusId, focusArea, focusStatus, neighbors, state.beliefs]);
  const dimmed = (id: string) => (focusSet ? !focusSet.has(id) : false);

  const sel = selected ? byId.get(selected) : undefined;
  const selDeps = sel?.deps?.map((id) => byId.get(id)).filter((b): b is Belief => !!b) ?? [];
  const selLeads = sel ? state.beliefs.filter((b) => b.deps?.includes(sel.id)) : [];

  return (
    <div className="session__main kmap-view">
      <div className="kmap__body">
        <aside className="kmap__sidebar">
          {grouped.map((g) => (
            <div key={g.key || "general"} className="kmap__side-group">
              <button
                type="button"
                className={`kmap__side-area${focusArea === g.key ? " is-active" : ""}`}
                onClick={() => selectArea(g.key)}
                aria-pressed={focusArea === g.key}
              >
                <span className="kmap__side-area-label">{g.label}</span>
                <span className="kmap__side-count label-large">{g.beliefs.length}</span>
              </button>
              {g.beliefs.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`kmap__side-node body-medium${selected === b.id ? " is-active" : ""}${dimmed(b.id) ? " is-dim" : ""}`}
                  onClick={() => {
                    selectNode(b.id);
                    ensureVisible(b.id);
                  }}
                  onMouseEnter={() => setHovered(b.id)}
                  onMouseLeave={() => setHovered((h) => (h === b.id ? null : h))}
                  aria-pressed={selected === b.id}
                >
                  <span className={`kmap__dot kmap__dot--${b.status}`} />
                  <span className="kmap__side-label">{b.concept}</span>
                  {b.challenged && <Icon name="priority_high" size={12} />}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <div className="kgraph">
        <svg
          ref={svgRef}
          className="kgraph__svg"
          onPointerDown={onBackgroundPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            // Double-clicking a node or area caption is two select-toggles, not a refit.
            if ((e.target as Element).closest(".kgraph__node, .kgraph__area")) return;
            fitView();
          }}
          role="application"
          aria-label="Knowledge map graph"
        >
          <g>
            {edgeList.map((e) => {
              const dim = focusSet ? !(focusSet.has(e.from) && focusSet.has(e.to)) : false;
              const active = focusId !== null && (e.from === focusId || e.to === focusId);
              return (
                <line
                  key={`${e.from}->${e.to}`}
                  ref={(el) => {
                    const key = `${e.from}->${e.to}`;
                    if (el) edgeEls.current.set(key, el);
                    else edgeEls.current.delete(key);
                  }}
                  className={`kgraph__edge${active ? " kgraph__edge--active" : ""}${dim ? " kgraph__edge--dim" : ""}`}
                />
              );
            })}
          </g>
          <g>
            {[...areas.entries()].map(([key, label]) => (
              <text
                key={key || "general"}
                ref={(el) => {
                  if (el) areaEls.current.set(key, el);
                  else areaEls.current.delete(key);
                }}
                className={`kgraph__area${focusArea === key ? " kgraph__area--active" : ""}`}
                textAnchor="middle"
                onPointerDown={onAreaPointerDown(key)}
              >
                {label}
              </text>
            ))}
          </g>
          <g>
            {state.beliefs.map((b) => (
              <g
                key={b.id}
                ref={(el) => {
                  if (el) nodeEls.current.set(b.id, el);
                  else nodeEls.current.delete(b.id);
                }}
                className={`kgraph__node kgraph__node--${b.status}${selected === b.id ? " kgraph__node--selected" : ""}${dimmed(b.id) ? " kgraph__node--dim" : ""}`}
                onPointerDown={onNodePointerDown(b.id)}
                onPointerEnter={() => setHovered(b.id)}
                onPointerLeave={() => setHovered((h) => (h === b.id ? null : h))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    // Same path as pointer/sidebar selection — clears any
                    // active area/status filter instead of fighting it.
                    selectNode(b.id);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label={`${b.concept}, ${STATUS_LABEL[b.status].toLowerCase()}${b.challenged ? ", challenged" : ""}`}
                aria-pressed={selected === b.id}
              >
                <circle className="kgraph__dot" r={6 + Math.min(Math.sqrt(degree.get(b.id) ?? 0) * 2.6, 8)} />
                {b.challenged && (
                  <text className="kgraph__challenged-mark" textAnchor="middle" dy="-10">
                    !
                  </text>
                )}
                <text className="kgraph__label" textAnchor="middle" dy={6 + Math.min(Math.sqrt(degree.get(b.id) ?? 0) * 2.6, 8) + 14}>
                  {b.concept}
                </text>
              </g>
            ))}
          </g>
        </svg>

        <div className="kmap__header kgraph__overlay">
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
              <button
                key={s}
                type="button"
                className={`kmap__legend-item${focusStatus === s ? " is-active" : ""}`}
                onClick={() => selectStatus(s)}
                aria-pressed={focusStatus === s}
              >
                <span className={`kmap__dot kmap__dot--${s}`} />
                {STATUS_LABEL[s]}
              </button>
            ))}
            <button
              type="button"
              className={`kmap__legend-item${focusStatus === "challenged" ? " is-active" : ""}`}
              onClick={() => selectStatus("challenged")}
              aria-pressed={focusStatus === "challenged"}
            >
              <Icon name="priority_high" size={14} />
              Challenged
            </button>
          </div>
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
