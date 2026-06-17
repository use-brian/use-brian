"use client";

/**
 * Force-directed graph view of the workspace brain (canvas-web).
 *
 * The REAL force-directed canvas — ported from apps/web's `graph-view.tsx`.
 * This is the DEFAULT entries surface: the Brain opens on this node/edge
 * canvas (in group colors); the grouped list (`grouped-view.tsx`) is the
 * view-toggle's alternate behind the topbar's List tab.
 *
 * Renders every visible entity as a node, every active entity↔entity edge
 * as a line. Sized by connection count, colored by entity kind. Click →
 * opens the shared `BrainDetailDrawer` (the parent owns the drawer state;
 * this component just calls `onSelect(row)`).
 *
 * Spec: docs/architecture/brain/graph-view.md.
 *
 * Implementation notes (legibility-first rendering — the pure math lives
 * in `lib/graph-canvas.ts`, unit-tested under [COMP:app-web/graph-canvas]):
 *
 * - The module is imported in an effect (NOT `next/dynamic` — dynamic()
 *   drops refs, and this canvas needs the instance for force tuning +
 *   `zoomToFit`; same pattern as `connections-graph.tsx`). The import
 *   only runs client-side, so SSR stays safe.
 * - Node sizing: flat log curve clamped to [2.5, 7] graph units
 *   (`nodeRadius`). The old `sqrt(1+min(d,12))*4` curve drew hubs as
 *   ~14-unit discs that blobbed in dense areas.
 * - A custom collision force (`makeCollideForce`) keeps discs from ever
 *   overlapping; charge/link-distance are tuned so clusters separate at
 *   80+ nodes instead of hairballing.
 * - `zoomToFit` on the first engine settle frames the whole layout —
 *   the old canvas opened wherever d3's initial transform landed.
 * - Warm start: node positions carry across snapshot refreshes
 *   (`mergePositions`), so a brain-write → refresh nudges the layout
 *   instead of re-scrambling the user's mental map. (This replaced the
 *   `key={nodes:edges}` remount, which threw away every position.)
 * - Labels: zoom-tiered with a background-color halo. Hubs (top-decile
 *   degree) fade in near fit zoom, everything else fades in by ~2×;
 *   small graphs (≤30 nodes) label everything from fit. Emphasized
 *   nodes (hover / search match + their neighbours) are always labelled.
 * - Hover/search dim transitions EASE (per-frame lerp via `stepToward`
 *   driven by a bounded rAF tick) instead of snapping; the hovered
 *   node's incident edges run directional particles and emphasized
 *   discs get a soft kind-colored glow (`shadowBlur` — device-space,
 *   so it reads the same at any zoom).
 * - Theme colors flow through CSS variables — read at mount via
 *   `getComputedStyle(document.documentElement)`, re-read on theme
 *   change so dark-mode toggles recolor without a remount. Hard-coded
 *   hex would break the project-wide "tokens only" rule.
 * - Visual treatment (the "neural canvas" pass — every shade derives
 *   from a theme token via `shadeHex`/`withAlpha`, no second palette).
 *   The canvas has its own theme-ADAPTIVE token set (`--graph-*`);
 *   both themes anchor the ground to the PAGE background (a hue-shifted
 *   ground read as a foreign surface next to the neutral chrome), and
 *   `hexLuma` classifies the live ground so every effect self-tunes.
 *   Everything below is deliberately SUBTLE — atmosphere the eye finds,
 *   never a poster effect. `onRenderFramePre` paints, in order: drifting
 *   aurora glows (screen space, brand hues, long offset periods), a
 *   world-locked dot grid (pattern tile, `gridStep` tiling), a corner
 *   vignette (darkened background ink), then soft BREATHING
 *   per-community washes (`communityHalos` over live positions).
 *   Discs are orb-shaded cached radial gradients over a cached bloom
 *   sprite (hubs bloom stronger) with a rim (lit on dark, tonal on
 *   light) and a per-node `nodePhase` twinkle; rest-state edges whose
 *   endpoints resolve to the SAME color render as tinted threads
 *   (mixed endpoints stay neutral so bridges don't blend muddy) and
 *   carry a slow ambient particle (≤ AMBIENT_PARTICLE_EDGE_CAP edges);
 *   the hovered node runs a `pulsePhase` expanding ring.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import type {
  BrainGraph,
  BrainGraphEdge,
  BrainGraphNode,
  BrainGraphNodeKind,
  BrainRow,
} from "@/lib/api/brain";
import { BRAIN_ENTITY_COLORS } from "@/lib/brain-colors";
import {
  CLUSTER_LABEL_FONT_PX,
  CLUSTER_LABEL_MAX_CHARS,
  CLUSTER_MIN_SIZE,
  LABEL_FONT_PX,
  LABEL_FONT_PX_EMPHASIZED,
  clusterLabelAlpha,
  communityHalos,
  communityLabels,
  gridStep,
  hexLuma,
  hubDegreeThreshold,
  labelAlpha,
  makeAnchorForce,
  makeClusterForce,
  makeCollideForce,
  mergePositions,
  nodePhase,
  nodeRadius,
  pulsePhase,
  shadeHex,
  stepToward,
  truncateLabel,
  withAlpha,
  type CommunityHalo,
  type NodePosition,
} from "@/lib/graph-canvas";
import { detectCommunities } from "@/lib/graph-communities";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Props = {
  graph: BrainGraph;
  /** Click handler — receives a synthetic BrainRow so the parent
   *  can hand it straight to `BrainDetailDrawer` without re-fetching.
   *  Only fired for `BrainRow`-shaped node kinds (entities + knowledge);
   *  skill nodes route through `onSelectSkillNode` instead (a skill is a
   *  different data shape than a `BrainRow`). */
  onSelect: (row: BrainRow) => void;
  /** Click handler for a `skill` node — receives the skill row id so the
   *  parent can resolve + open it from the workspace skill list. Connector
   *  nodes have no detail surface in v1, so they no-op. */
  onSelectSkillNode?: (skillRowId: string) => void;
  /** Free-text focus query (the Brain search box). Unlike the list — which
   *  hard-filters rows — the graph uses the query as a SPOTLIGHT: nodes whose
   *  name matches stay fully opaque, their 1st-degree neighbours dim slightly
   *  (still legible — "this is relevant"), and everything else fades back, so
   *  the user sees what's connected to their search without the non-matches
   *  disappearing. Empty query OR zero matches → no dimming (the graph is left
   *  untouched rather than fully greyed). Independent of hover, which still
   *  works as a transient inspect gesture on top. */
  focusQuery?: string;
  loading?: boolean;
};

type GraphNodeWithPos = BrainGraphNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  /** Per-node twinkle phase, precomputed once per snapshot (nodePhase). */
  __phase?: number;
};

type GraphEdgeWithRefs = Omit<BrainGraphEdge, "source" | "target"> & {
  // react-force-graph rewrites these to point at the resolved node objects
  // once the layout has run; the original ids are kept on `__sourceId`/
  // `__targetId` for our own bookkeeping.
  source: string | GraphNodeWithPos;
  target: string | GraphNodeWithPos;
  __sourceId: string;
  __targetId: string;
};

/** The slice of the force-graph instance this canvas drives via ref. */
type ForceGraphInstance = {
  d3Force(name: string):
    | {
        strength?: (n: number) => unknown;
        distance?: (n: number | ((link: unknown) => number)) => unknown;
      }
    | undefined;
  d3Force(name: string, force: ((alpha: number) => void) | null): unknown;
  zoomToFit(durationMs?: number, paddingPx?: number): void;
  zoom(): number;
};

/** Node color source — detected community (default, the Obsidian
 *  path-groups look) or kind (entity-type hues + legend). */
type GraphColorMode = "kind" | "group";

const COLOR_MODE_STORAGE_KEY = "brain:graph-color-mode";

export type ThemeColors = {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  kinds: Record<BrainGraphNodeKind, string>;
};

export const FALLBACK_COLORS: ThemeColors = {
  // Light-mode graph ground — mirrors the :root --graph-* tokens in
  // globals.css (--graph-bg anchors to the page background in both
  // themes; the support tokens are canvas-tuned). Light is the app
  // default, so it's the pre-mount/SSR fallback; readThemeColors swaps
  // in the live values right after mount.
  background: "#FFFFFF",
  foreground: "#1F2737",
  muted: "#6B7691",
  border: "#D7DDEA",
  // Light entity palette — source of truth in lib/brain-colors.ts
  // (mirrors --graph-entity-* / --entity-*); the vivid dark set is
  // BRAIN_ENTITY_COLORS_VIVID, applied via the .dark tokens at runtime.
  kinds: BRAIN_ENTITY_COLORS,
};

// Stable display order for the legend — common entity kinds first, the
// generic `other` bucket last. The legend renders only the kinds actually
// present in the current snapshot, in this order.
const KIND_ORDER: BrainGraphNodeKind[] = [
  "person",
  "company",
  "project",
  "deal",
  "product",
  "repository",
  "knowledge",
  "memory",
  "skill",
  "connector",
  "other",
];

// Force tuning — stronger repulsion + longer links than the d3 defaults so
// clusters separate visually at 80+ nodes; the collide force (with the
// node radii from graph-canvas) guarantees discs never overlap. Numbers
// from a screenshot pass against the 12/90/500-node Graph Lab fixtures.
const CHARGE_STRENGTH = -55;
// Intra/inter link split: edges WITHIN a detected community stay short and
// stiff (tight "firework" blobs); bridge edges between communities stretch
// long and go LOOSE (low spring strength), so they read as connective
// threads instead of pulling the blobs back into one mass. This split plus
// the cluster-gravity force is what separates the communities spatially —
// the Obsidian vault-graph look.
const LINK_DISTANCE_INTRA = 28;
const LINK_DISTANCE_INTER = 160;
const LINK_STRENGTH_INTRA = 0.7;
const LINK_STRENGTH_INTER = 0.08;

// Ambient particle flow runs on every edge at rest (the "data moving
// through the brain" cue) up to this edge count; past it, particles stay
// hover-only — per-edge photon simulation is per-frame work and a dense
// graph would melt the frame budget for a cue nobody can read anyway.
const AMBIENT_PARTICLE_EDGE_CAP = 400;

// Exported for the entry reader's mini connections graph
// (`connections-graph.tsx`) so both canvases read the same `--graph-*`
// palette and re-theme together.
export function readThemeColors(): ThemeColors {
  if (typeof window === "undefined") return FALLBACK_COLORS;
  const css = getComputedStyle(document.documentElement);
  const read = (token: string, fallback: string) => {
    const v = css.getPropertyValue(token).trim();
    return v.length > 0 ? v : fallback;
  };
  // Each kind reads a dedicated --graph-entity-* token (globals.css) so
  // the node types stay visually separable on the graph's own ground.
  // The set is theme-adaptive: standard hues in light, the vivid
  // (brightened) palette on the dark canvas.
  const kind = (k: BrainGraphNodeKind) =>
    read(`--graph-entity-${k}`, FALLBACK_COLORS.kinds[k]);
  return {
    background: read("--graph-bg", FALLBACK_COLORS.background),
    foreground: read("--graph-fg", FALLBACK_COLORS.foreground),
    muted: read("--graph-muted", FALLBACK_COLORS.muted),
    border: read("--graph-border", FALLBACK_COLORS.border),
    kinds: {
      person: kind("person"),
      company: kind("company"),
      project: kind("project"),
      deal: kind("deal"),
      product: kind("product"),
      repository: kind("repository"),
      other: kind("other"),
      knowledge: kind("knowledge"),
      memory: kind("memory"),
      skill: kind("skill"),
      connector: kind("connector"),
    },
  };
}

/**
 * Map a graph node back to the `BrainRow` shape the detail drawer
 * expects. The drawer fetches its own rollup, so the only fields
 * that matter on click are `id`, `kind`, and `name` (the rest is
 * pure projection-side decoration).
 */
function nodeToRow(
  node: BrainGraphNode & {
    kind: Exclude<BrainGraphNodeKind, "skill" | "connector" | "memory">;
  },
): BrainRow {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    sensitivity: node.sensitivity,
  };
}

export function BrainGraphView({
  graph,
  onSelect,
  onSelectSkillNode,
  focusQuery,
  loading,
}: Props) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphInstance | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [colors, setColors] = useState<ThemeColors>(FALLBACK_COLORS);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Imported in an effect instead of `next/dynamic` — dynamic() does not
  // forward refs, and this canvas needs the instance for zoomToFit + force
  // tuning. The import only runs client-side, so SSR stays safe.
  const [ForceGraph2D, setForceGraph2D] = useState<ComponentType<
    Record<string, unknown>
  > | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("react-force-graph-2d").then((mod) => {
      if (!cancelled) {
        setForceGraph2D(
          () => mod.default as ComponentType<Record<string, unknown>>,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Read theme colors after mount + on theme change. The user can
  // toggle dark mode via the locale switcher / OS preference; without
  // this listener the canvas would stay light-mode after a switch.
  useEffect(() => {
    setColors(readThemeColors());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setColors(readThemeColors());
    mq.addEventListener("change", onChange);
    // Also re-read when the documentElement class changes (manual
    // theme override path). MutationObserver on class attr is cheap.
    const obs = new MutationObserver(onChange);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-palette"],
    });
    return () => {
      mq.removeEventListener("change", onChange);
      obs.disconnect();
    };
  }, []);

  // Observe container size — ForceGraph2D wants explicit width/height
  // numbers. ResizeObserver matches the parent flex layout without
  // needing the parent to plumb dimensions through.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      setDims({ w: Math.max(200, r.width), h: Math.max(200, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Precompute neighbor index — keyed by node id, value is the Set of
  // neighbor ids. Used for hover-dim. O(E) on rebuild; recomputed only
  // when the graph identity changes.
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const node of graph.nodes) m.set(node.id, new Set());
    for (const edge of graph.edges) {
      m.get(edge.source)?.add(edge.target);
      m.get(edge.target)?.add(edge.source);
    }
    return m;
  }, [graph]);

  // Search-focus spotlight. `focusMatchIds` = nodes whose name contains the
  // query (case-insensitive); `null` when the query is empty OR matched nothing
  // (a no-match search must NOT grey the whole graph — it just doesn't focus).
  const focusMatchIds = useMemo(() => {
    const q = (focusQuery ?? "").trim().toLowerCase();
    if (q.length === 0) return null;
    const s = new Set<string>();
    for (const n of graph.nodes) {
      if (n.name.toLowerCase().includes(q)) s.add(n.id);
    }
    return s.size > 0 ? s : null;
  }, [graph, focusQuery]);

  // 1st-degree neighbours of the matched nodes — the "relevant" tier. These are
  // the connections that explain why a node is related to the search, so they
  // stay legible (dimmed less than the rest).
  const focusNeighborIds = useMemo(() => {
    if (!focusMatchIds) return null;
    const s = new Set<string>();
    for (const id of focusMatchIds) {
      for (const nb of neighbors.get(id) ?? []) {
        if (!focusMatchIds.has(nb)) s.add(nb);
      }
    }
    return s;
  }, [focusMatchIds, neighbors]);

  // id → kind, so an emphasised edge can borrow the colour of the node it
  // anchors to (a hovered/matched hub's incident edges read as soft threads in
  // that node's hue, not a black scaffold).
  const kindById = useMemo(() => {
    const m = new Map<string, BrainGraphNodeKind>();
    for (const n of graph.nodes) m.set(n.id, n.kind);
    return m;
  }, [graph]);

  // Hub cut for label tiering — top-decile degree (0 on small graphs, so
  // everything is labelled from fit zoom).
  const hubThreshold = useMemo(
    () => hubDegreeThreshold(graph.nodes.map((n) => n.degree)),
    [graph],
  );

  // Connectivity communities (deterministic label propagation). Feed the
  // cluster-gravity force + the intra/inter link-distance split, and the
  // optional group color mode. The ref carries the latest result into the
  // d3 force closures installed once at bind time.
  const communities = useMemo(
    () => detectCommunities(graph.nodes, graph.edges),
    [graph],
  );
  const communitiesRef = useRef(communities);
  communitiesRef.current = communities;

  // Node color source. Defaults to "group" (detected communities — the
  // Obsidian look the Brain opens on); "kind" recolors by entity type and
  // brings the legend back. Persisted per browser; read in an effect so
  // SSR/first paint stay deterministic.
  const [colorMode, setColorMode] = useState<GraphColorMode>("group");
  useEffect(() => {
    if (window.localStorage.getItem(COLOR_MODE_STORAGE_KEY) === "kind") {
      setColorMode("kind");
    }
  }, []);
  const pickColorMode = (mode: GraphColorMode) => {
    setColorMode(mode);
    window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, mode);
  };

  // Group palette — the theme's categorical hues, re-sequenced for
  // adjacent-cluster contrast and deduped (two kinds may share a hue in a
  // custom palette). Community index cycles through it; communities too
  // small for gravity render muted grey, the Obsidian "ungrouped" tier.
  const groupPalette = useMemo(() => {
    const seq: BrainGraphNodeKind[] = [
      "company",
      "product",
      "knowledge",
      "person",
      "deal",
      "repository",
      "skill",
      "memory",
      "connector",
      "project",
    ];
    const out: string[] = [];
    for (const k of seq) {
      const c = colors.kinds[k];
      if (!out.includes(c)) out.push(c);
    }
    return out.length > 0 ? out : [colors.foreground];
  }, [colors]);

  /** One color resolver for discs, glow, edge tints, and particles, so
   *  every emphasis cue agrees with the active color mode. Stable
   *  (useCallback) so the derived edge/halo memos can depend on it. */
  const nodeColor = useCallback(
    (id: string, kind: BrainGraphNodeKind): string => {
      if (colorMode === "group") {
        const c = communities.byId.get(id);
        if (c == null || (communities.sizes[c] ?? 0) < CLUSTER_MIN_SIZE) {
          return colors.muted;
        }
        return groupPalette[c % groupPalette.length];
      }
      return colors.kinds[kind] ?? colors.kinds.other;
    },
    [colorMode, communities, groupPalette, colors],
  );

  // Dark-background detection for the backdrop layers (vignette depth,
  // halo strength, dot-grid alpha). Luma of the resolved token — no
  // theme prop needed, custom palettes classify themselves.
  const isDark = useMemo(() => hexLuma(colors.background) < 0.5, [colors]);

  // Halo tint per community — group mode mirrors the disc palette; kind
  // mode uses the community's plurality kind, so the wash still says
  // "what lives here" while discs encode kinds. Communities too small
  // for cluster gravity get no halo (their members scatter — a wash
  // over the scatter would read as a phantom group).
  const haloColors = useMemo(() => {
    const m = new Map<number, string>();
    if (colorMode === "group") {
      communities.sizes.forEach((size, c) => {
        if (size >= CLUSTER_MIN_SIZE) {
          m.set(c, groupPalette[c % groupPalette.length]);
        }
      });
      return m;
    }
    const counts = new Map<number, Map<BrainGraphNodeKind, number>>();
    for (const n of graph.nodes) {
      const c = communities.byId.get(n.id);
      if (c == null || (communities.sizes[c] ?? 0) < CLUSTER_MIN_SIZE) continue;
      const kindCounts = counts.get(c) ?? new Map<BrainGraphNodeKind, number>();
      kindCounts.set(n.kind, (kindCounts.get(n.kind) ?? 0) + 1);
      counts.set(c, kindCounts);
    }
    for (const [c, kindCounts] of counts) {
      let best: BrainGraphNodeKind = "other";
      let bestN = -1;
      for (const [k, count] of kindCounts) {
        if (count > bestN) {
          bestN = count;
          best = k;
        }
      }
      m.set(c, colors.kinds[best] ?? colors.kinds.other);
    }
    return m;
  }, [colorMode, communities, groupPalette, graph, colors]);

  // Group headings — each community's most-connected member name, the
  // topic anchor of the cluster ("Memory system", "Context engine", …).
  // Membership-derived (stable across the sim's per-frame position churn),
  // so it's a memo, not per-frame work; the live centroid/radius it's
  // drawn at comes from `communityHalos` via `lastHalosRef`. Only built in
  // group mode — the heading annotates the colored groups.
  const communityLabelText = useMemo(
    () =>
      colorMode === "group"
        ? communityLabels(graph.nodes, (id) => communities.byId.get(id))
        : new Map<number, string>(),
    [colorMode, graph, communities],
  );

  // Rest-state edge tint — an edge whose endpoints resolve to the SAME
  // color (intra-community in group mode, same-kind pairs in kind mode)
  // carries that color as a soft thread; mixed endpoints stay on the
  // neutral border so bridges don't render as muddy blends.
  const edgeRestColors = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of graph.edges) {
      const sc = nodeColor(e.source, kindById.get(e.source) ?? "other");
      const tc = nodeColor(e.target, kindById.get(e.target) ?? "other");
      m.set(e.id, sc === tc ? sc : colors.border);
    }
    return m;
  }, [graph, kindById, nodeColor, colors]);

  // Vignette ink — the background token darkened toward black, so the
  // corner falloff stays in the active palette's hue family. Null when
  // the token didn't resolve to hex (withAlpha couldn't tag it) — then
  // the vignette is skipped rather than painted solid.
  const vignette = useMemo(() => {
    const ink = shadeHex(colors.background, -0.85);
    const edge = withAlpha(ink, isDark ? 0.28 : 0.05);
    return edge === ink
      ? null
      : { edge, transparent: withAlpha(ink, 0) };
  }, [colors, isDark]);

  // Live node objects from the PREVIOUS snapshot (the sim mutates x/y in
  // place, so these always hold the settled positions). Feeds the warm
  // start: a refresh keeps every surviving node where the user left it.
  const lastNodesRef = useRef<Map<string, GraphNodeWithPos>>(new Map());

  // Live community halos from the most recent frame's `paintHalos` pass
  // (centroid + bounding radius over the sim-mutated positions). Stashed
  // so the cluster-heading pass in `onRenderFramePost` reuses them instead
  // of recomputing `communityHalos` a second time per frame. Pre runs
  // before Post each frame, so this always holds the current frame's data.
  const lastHalosRef = useRef<CommunityHalo[]>([]);

  // ForceGraph2D mutates the links array in place (rewrites source/target
  // string ids to node refs after the first layout pass). Copying once
  // here prevents the mutation from leaking into the props we received.
  const graphData = useMemo(() => {
    const nodes = graph.nodes.map(
      (n) => ({ ...n, __phase: nodePhase(n.id) }) as GraphNodeWithPos,
    );
    // Warm-start from the previous layout; new nodes spawn at their
    // positioned-neighbour centroid instead of the origin.
    const prev = new Map<string, NodePosition>();
    for (const [id, node] of lastNodesRef.current) {
      if (node.x != null && node.y != null) {
        prev.set(id, { x: node.x, y: node.y, vx: node.vx, vy: node.vy });
      }
    }
    mergePositions(nodes, graph.edges, prev);
    lastNodesRef.current = new Map(nodes.map((n) => [n.id, n]));
    return {
      nodes,
      links: graph.edges.map((e) => ({
        ...e,
        __sourceId: e.source,
        __targetId: e.target,
      })) as unknown as GraphEdgeWithRefs[],
    };
  }, [graph]);

  // Kinds actually present in the current snapshot, in display order.
  // Drives the legend so a CRM-only brain doesn't advertise a "Knowledge"
  // swatch (and a KB-only brain doesn't advertise "Deals").
  const presentKinds = useMemo(() => {
    const seen = new Set<BrainGraphNodeKind>();
    for (const n of graph.nodes) seen.add(n.kind);
    return KIND_ORDER.filter((k) => seen.has(k));
  }, [graph]);

  // ── Eased dim transitions ─────────────────────────────────────────────
  // Per-node and per-edge CURRENT alphas, stepped toward their targets each
  // painted frame (stepToward in the canvas callbacks below). The canvas
  // renders continuously (`autoPauseRedraw={false}` on the graph), so the
  // easing — and anything else that changes how a frame LOOKS without
  // changing props, like the captured fit scale — takes effect on the next
  // frame. (A React-state "repaint pump" was tried first and does NOT
  // work: prop updates don't mark the lib's halted canvas dirty, so the
  // stale frame stays frozen on screen.)
  const nodeAlphaRef = useRef<Map<string, number>>(new Map());
  const edgeAlphaRef = useRef<Map<string, number>>(new Map());
  const edgeWidthRef = useRef<Map<string, number>>(new Map());

  // ── Visual-treatment caches ──────────────────────────────────────────
  // Orb gradients per (fill, radius-bucket) and the backdrop dot tile.
  // Both are theme-derived, so a palette change invalidates them below.
  const gradientCacheRef = useRef<Map<string, CanvasGradient>>(new Map());
  const dotPatternRef = useRef<{ color: string; pattern: CanvasPattern } | null>(
    null,
  );
  useEffect(() => {
    gradientCacheRef.current.clear();
    dotPatternRef.current = null;
  }, [colors]);

  /** Cached radial "orb" gradient — hot highlight up-left, token color
   *  in the body, darker limb at the edge (tuned for the deep canvas:
   *  the highlight runs brighter so each node reads as a light source).
   *  Built relative to the origin so one gradient serves every node
   *  drawn under a translate; bucketed to quarter graph units, so the
   *  cache stays bounded (palette × ~18 buckets). */
  const discGradient = (
    ctx: CanvasRenderingContext2D,
    fill: string,
    r: number,
  ): CanvasGradient => {
    const rb = Math.round(r * 4) / 4;
    const key = `disc|${fill}|${rb}`;
    const cache = gradientCacheRef.current;
    const hit = cache.get(key);
    if (hit) return hit;
    const g = ctx.createRadialGradient(
      -rb * 0.35,
      -rb * 0.4,
      rb * 0.1,
      0,
      0,
      rb * 1.05,
    );
    g.addColorStop(0, shadeHex(fill, 0.45));
    g.addColorStop(0.55, fill);
    g.addColorStop(1, shadeHex(fill, -0.18));
    cache.set(key, g);
    return g;
  };

  /** Cached bloom sprite behind every disc — a radial falloff in the
   *  node's own hue, drawn as an arc fill instead of `shadowBlur`
   *  (shadow blurs are device-space Gaussian passes; a cached gradient
   *  is ~free and zoom-stable). Hubs bloom stronger — the "important
   *  at rest" cue. Dark mode blooms a touch harder (light on a dark
   *  ground); light mode keeps it a faint tint. The cache is cleared
   *  on theme change, so closing over isDark is safe. */
  const glowGradient = (
    ctx: CanvasRenderingContext2D,
    fill: string,
    r: number,
    strong: boolean,
  ): CanvasGradient => {
    const rb = Math.round(r * 4) / 4;
    const key = `glow|${fill}|${rb}|${strong ? 1 : 0}`;
    const cache = gradientCacheRef.current;
    const hit = cache.get(key);
    if (hit) return hit;
    const g = ctx.createRadialGradient(0, 0, rb * 0.4, 0, 0, rb * 2.3);
    const a = isDark ? (strong ? 0.2 : 0.1) : strong ? 0.13 : 0.07;
    g.addColorStop(0, withAlpha(fill, a));
    g.addColorStop(1, withAlpha(fill, 0));
    cache.set(key, g);
    return g;
  };

  /** Screen-space backdrop — world-locked dot grid + corner vignette,
   *  painted under everything each frame (the lib wipes the canvas,
   *  fires onRenderFramePre, then draws links/nodes; the background
   *  color itself is CSS on the canvas element). */
  const paintBackdrop = (
    ctx: CanvasRenderingContext2D,
    globalScale: number,
  ) => {
    const m = ctx.getTransform();
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Aurora — large brand-hue glows drifting on long offset periods,
    // the "alive AI surface" cue. Screen space, BEHIND the grid, so it
    // reads as atmosphere rather than data. Each blob's drift period is
    // co-prime-ish with the others so the composition never visibly
    // loops. The ground in BOTH themes is the page background, so the
    // aurora must stay a whisper — atmosphere, never a stain on the
    // app surface.
    {
      const t = performance.now();
      const auroraScale = isDark ? 1 : 0.45;
      const blobs: Array<[string, number, number, number, number]> = [
        // [color, cx fraction, cy fraction, radius fraction, alpha]
        [
          colors.kinds.knowledge,
          0.26 + 0.07 * Math.sin(t / 9300),
          0.32 + 0.05 * Math.cos(t / 7600),
          0.52,
          0.05 * auroraScale,
        ],
        [
          colors.kinds.person,
          0.74 + 0.06 * Math.cos(t / 11200),
          0.62 + 0.07 * Math.sin(t / 8400),
          0.46,
          0.04 * auroraScale,
        ],
        [
          colors.kinds.company,
          0.5 + 0.08 * Math.sin(t / 13600),
          0.88 + 0.04 * Math.cos(t / 10100),
          0.4,
          0.035 * auroraScale,
        ],
      ];
      for (const [color, fx, fy, fr, fa] of blobs) {
        const inner = withAlpha(color, fa);
        if (inner === color) continue; // non-hex token — skip
        const r = Math.max(w, h) * fr;
        const g = ctx.createRadialGradient(w * fx, h * fy, 0, w * fx, h * fy, r);
        g.addColorStop(0, inner);
        g.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    }
    try {
      let entry = dotPatternRef.current;
      if (!entry || entry.color !== colors.muted) {
        const tile = document.createElement("canvas");
        tile.width = 16;
        tile.height = 16;
        const tctx = tile.getContext("2d");
        if (tctx) {
          tctx.fillStyle = colors.muted;
          tctx.beginPath();
          tctx.arc(8, 8, 0.75, 0, 2 * Math.PI);
          tctx.fill();
          const pattern = ctx.createPattern(tile, "repeat");
          if (pattern) {
            entry = { color: colors.muted, pattern };
            dotPatternRef.current = entry;
          }
        }
      }
      if (entry) {
        // One tile = one grid step. Scaling the PATTERN (not redrawing
        // dots) keeps this a single fillRect; translating it by the
        // world transform locks the grid to graph space, so it pans and
        // zooms with the layout instead of floating over it.
        const pitch = gridStep(globalScale) * m.a;
        entry.pattern.setTransform(
          new DOMMatrix([pitch / 16, 0, 0, pitch / 16, m.e, m.f]),
        );
        ctx.globalAlpha = isDark ? 0.18 : 0.3;
        ctx.fillStyle = entry.pattern;
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
      }
    } catch {
      // Pattern transforms are progressive enhancement — a runtime
      // without DOMMatrix/setTransform paints no grid, never breaks
      // the frame.
    }
    if (vignette) {
      const cx = w / 2;
      const cy = h * 0.42;
      const vr = Math.max(w, h) * 0.75;
      const vg = ctx.createRadialGradient(cx, cy, vr * 0.45, cx, cy, vr);
      vg.addColorStop(0, vignette.transparent);
      vg.addColorStop(1, vignette.edge);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  };

  /** Soft community washes behind the clusters — graph space,
   *  recomputed from the live (sim-mutated) node positions each frame
   *  so the wash tracks the layout as it settles. */
  const paintHalos = (ctx: CanvasRenderingContext2D) => {
    const byId = communitiesRef.current.byId;
    const halos = communityHalos(graphData.nodes, (id) => byId.get(id));
    // Reused by the cluster-heading pass (onRenderFramePost) this frame.
    lastHalosRef.current = halos;
    const t = performance.now();
    for (const h of halos) {
      const color = haloColors.get(h.community);
      if (!color) continue;
      // Slow breathing, phase-offset per community, so the field feels
      // alive without the clusters pulsing in lockstep.
      const breath = 0.88 + 0.12 * Math.sin(t / 2600 + h.community * 1.7);
      const inner = withAlpha(color, (isDark ? 0.09 : 0.06) * breath);
      if (inner === color) continue; // non-hex token — skip, never paint solid
      const g = ctx.createRadialGradient(h.x, h.y, h.r * 0.1, h.x, h.y, h.r);
      g.addColorStop(0, inner);
      g.addColorStop(0.7, withAlpha(color, (isDark ? 0.05 : 0.035) * breath));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(h.x, h.y, h.r, 0, 2 * Math.PI);
      ctx.fill();
    }
  };

  /** Group headings — the topic-anchor name floating above each cluster,
   *  an OVERVIEW affordance: full at fit, fading to 0 as the user zooms
   *  in to read individual nodes (`clusterLabelAlpha`), so it never
   *  competes with the per-node labels underneath. Drawn in
   *  `onRenderFramePost` (above the discs) at the live halo centroid/
   *  radius stashed by `paintHalos`. Group mode only (the caller gates
   *  the prop), in a legible shade of the group hue with a bg halo. */
  const paintClusterLabels = (
    ctx: CanvasRenderingContext2D,
    globalScale: number,
  ) => {
    const alpha = clusterLabelAlpha(globalScale / (fitScaleRef.current || 1));
    if (alpha <= 0.02) return;
    const halos = lastHalosRef.current;
    if (halos.length === 0) return;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.lineJoin = "round";
    ctx.lineWidth = 4 / globalScale;
    ctx.font = `600 ${CLUSTER_LABEL_FONT_PX / globalScale}px ui-sans-serif, system-ui, sans-serif`;
    ctx.globalAlpha = alpha;
    for (const h of halos) {
      const text = communityLabelText.get(h.community);
      if (!text) continue;
      // Heading in a legible shade of the group's hue — brightened on the
      // dark ground, darkened on light; foreground token when the halo
      // color didn't resolve to hex (shadeHex would no-op it).
      const hue = haloColors.get(h.community);
      const fill = hue
        ? shadeHex(hue, isDark ? 0.5 : -0.45)
        : colors.foreground;
      const label = truncateLabel(text, CLUSTER_LABEL_MAX_CHARS);
      const ly = h.y - h.r - 4 / globalScale; // just above the wash
      ctx.strokeStyle = colors.background;
      ctx.strokeText(label, h.x, ly);
      ctx.fillStyle = fill;
      ctx.fillText(label, h.x, ly);
    }
    ctx.restore();
  };

  // Frame the whole layout once the first simulation settles. Subsequent
  // settles (snapshot refreshes reheat the sim) deliberately do NOT re-fit:
  // the warm start means the layout barely moved, and yanking the camera
  // away from where the user zoomed would destroy the mental map the warm
  // start just preserved.
  const didFitRef = useRef(false);
  // The scale zoomToFit chose — the label tiers are FIT-RELATIVE (see
  // graph-canvas.ts ramps), so the renderer divides the live globalScale
  // by this. 1 until the first fit completes (hub labels still render
  // during the settle because the hub ramp passes at zoomRel ≥ ~1).
  const fitScaleRef = useRef(1);

  /** Ref callback — fires when the instance exists, i.e. when the d3
   *  forces are live. Tunes charge/link and installs the collision
   *  force (radii + padding from graph-canvas). */
  const bindFg = (instance: ForceGraphInstance | null) => {
    fgRef.current = instance;
    if (!instance) return;
    instance.d3Force("charge")?.strength?.(CHARGE_STRENGTH);
    // Short links inside a community, long bridges between communities —
    // the closures read communitiesRef so a snapshot refresh (new
    // communities) re-resolves without re-binding the forces.
    const sameCommunity = (link: unknown): boolean => {
      const l = link as GraphEdgeWithRefs;
      const byId = communitiesRef.current.byId;
      const a = byId.get(l.__sourceId);
      return a != null && a === byId.get(l.__targetId);
    };
    instance.d3Force("link")?.distance?.((link: unknown) =>
      sameCommunity(link) ? LINK_DISTANCE_INTRA : LINK_DISTANCE_INTER,
    );
    instance.d3Force("link")?.strength?.(((link: unknown) =>
      sameCommunity(link)
        ? LINK_STRENGTH_INTRA
        : LINK_STRENGTH_INTER) as never);
    instance.d3Force(
      "collide",
      makeCollideForce((n) =>
        nodeRadius((n as GraphNodeWithPos).degree ?? 0),
      ),
    );
    // Weak pull-to-origin so isolated nodes / disconnected fragments stop
    // drifting off and ballooning the zoomToFit bounding box.
    instance.d3Force("anchor", makeAnchorForce());
    // Community gravity — members pull toward their cluster's centroid.
    instance.d3Force(
      "cluster",
      makeClusterForce((n) =>
        communitiesRef.current.byId.get((n as GraphNodeWithPos).id),
      ),
    );
  };

  if (graph.nodes.length === 0 && !loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 py-12 text-muted-foreground">
        <p className="text-sm">{t.brainPage.graphView.empty}</p>
        <p className="text-xs mt-2 opacity-70 max-w-md">
          {t.brainPage.graphView.emptyHint}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative flex-1 min-h-0 overflow-hidden bg-[var(--graph-bg)]"
    >
      {graph.truncated && (
        <div className="absolute top-2 left-2 z-10 px-2.5 py-1 rounded-md border border-[var(--graph-overlay-border)] bg-[var(--graph-overlay)] text-[11px] text-[var(--graph-overlay-fg)] shadow-sm backdrop-blur-md">
          {t.brainPage.graphView.truncated.replace(
            "{count}",
            String(graph.nodes.length),
          )}
        </div>
      )}
      {/* Kind legend — only meaningful while colors encode kinds. Glass
          chip over the canvas, themed by the --graph-overlay* tokens so it
          sits on the graph ground, not the page surface. */}
      {colorMode === "kind" && presentKinds.length > 1 && (
        <div className="absolute bottom-2 left-2 z-10 flex max-w-[70%] flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--graph-overlay-border)] bg-[var(--graph-overlay)] px-2.5 py-1.5 text-[11px] text-[var(--graph-overlay-fg)] shadow-sm backdrop-blur-md">
          {presentKinds.map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: colors.kinds[k] }}
              />
              {t.brainPage.graphView.legend[k]}
            </span>
          ))}
        </div>
      )}
      {/* Color-mode toggle — Type (kind hues, legend on) | Groups (detected
          communities, the Obsidian look). Overlays the canvas like the
          legend; persisted per browser. */}
      {graph.nodes.length > 0 && (
        <div className="absolute top-2 right-2 z-10 inline-flex rounded-md border border-[var(--graph-overlay-border)] bg-[var(--graph-overlay)] p-0.5 text-[11px] shadow-sm backdrop-blur-md">
          {/* Groups leads — it is the color-mode default. */}
          <button
            type="button"
            aria-label={t.brainPage.graphView.colorMode.groupAria}
            aria-pressed={colorMode === "group"}
            onClick={() => pickColorMode("group")}
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              colorMode === "group"
                ? "bg-[var(--graph-overlay-active)] text-[var(--graph-fg)] shadow-sm"
                : "text-[var(--graph-overlay-fg)] hover:text-[var(--graph-fg)]",
            )}
          >
            {t.brainPage.graphView.colorMode.group}
          </button>
          <button
            type="button"
            aria-label={t.brainPage.graphView.colorMode.kindAria}
            aria-pressed={colorMode === "kind"}
            onClick={() => pickColorMode("kind")}
            className={cn(
              "rounded px-2 py-0.5 transition-colors",
              colorMode === "kind"
                ? "bg-[var(--graph-overlay-active)] text-[var(--graph-fg)] shadow-sm"
                : "text-[var(--graph-overlay-fg)] hover:text-[var(--graph-fg)]",
            )}
          >
            {t.brainPage.graphView.colorMode.kind}
          </button>
        </div>
      )}
      {dims && ForceGraph2D && graph.nodes.length > 0 && (
        <ForceGraph2D
          ref={bindFg as never}
          graphData={graphData}
          width={dims.w}
          height={dims.h}
          backgroundColor={colors.background}
          // Continuous redraw — the eased dim transitions and the
          // fit-relative label tiers change frame appearance without prop
          // changes, which the lib's auto-pause would freeze (see the
          // eased-transitions note above).
          autoPauseRedraw={false}
          // Warm-started reheats settle fast; the synchronous warmup hides
          // most of the initial churn on a cold layout.
          warmupTicks={60}
          cooldownTicks={200}
          d3VelocityDecay={0.32}
          onEngineStop={() => {
            // Guard on node count: the brain page mounts this canvas with an
            // EMPTY graph while the snapshot loads, and the engine "settles"
            // instantly on 0 nodes — consuming the one-shot fit before any
            // data exists would leave the real layout unframed.
            if (!didFitRef.current && graph.nodes.length > 0) {
              didFitRef.current = true;
              fgRef.current?.zoomToFit(400, 60);
              // Capture the fit scale once the 400ms zoom animation lands —
              // it anchors the fit-relative label tiers.
              window.setTimeout(() => {
                const z = fgRef.current?.zoom();
                if (typeof z === "number" && z > 0) fitScaleRef.current = z;
              }, 450);
            }
          }}
          // Backdrop layers under the graph: screen-space dot grid +
          // vignette, then the graph-space community washes.
          onRenderFramePre={(
            ctx: CanvasRenderingContext2D,
            globalScale: number,
          ) => {
            paintBackdrop(ctx, globalScale);
            paintHalos(ctx);
          }}
          // Group headings ABOVE the discs (post pass), group mode only —
          // fade out as the user zooms into individual nodes.
          onRenderFramePost={
            colorMode === "group"
              ? (ctx: CanvasRenderingContext2D, globalScale: number) =>
                  paintClusterLabels(ctx, globalScale)
              : undefined
          }
          nodeLabel={(n: GraphNodeWithPos) => n.name}
          // Custom node renderer — orb-shaded disc + zoom-tiered haloed
          // label + eased dim + glow on emphasis + hover pulse ring.
          // Per-frame math lives in lib/graph-canvas.ts.
          nodeCanvasObject={(
            node: GraphNodeWithPos,
            ctx: CanvasRenderingContext2D,
            globalScale: number,
          ) => {
            const n = node;
            const r = nodeRadius(n.degree);
            const isHovered = hoverId === n.id;
            const isHoverNeighbor =
              hoverId !== null && (neighbors.get(hoverId)?.has(n.id) ?? false);
            const isMatch = focusMatchIds?.has(n.id) ?? false;
            const isFocusNeighbor = focusNeighborIds?.has(n.id) ?? false;

            // Alpha tiers. A hover (transient pointer gesture) wins; otherwise
            // the search-focus spotlight (match 1 · relevant neighbour 0.5 ·
            // rest 0.12); otherwise fully opaque. `focusMatchIds` is null when
            // the query is empty or matched nothing, so a no-match search never
            // greys the graph. The DRAWN alpha eases toward this target.
            let target = 1;
            if (hoverId !== null) {
              target = isHovered || isHoverNeighbor ? 1 : 0.18;
            } else if (focusMatchIds) {
              target = isMatch ? 1 : isFocusNeighbor ? 0.5 : 0.12;
            }
            const alpha = stepToward(
              nodeAlphaRef.current.get(n.id) ?? target,
              target,
            );
            nodeAlphaRef.current.set(n.id, alpha);

            // Ring + glow the anchor of attention — the hovered node and every
            // matched node — so it reads as the focus, not merely "less dim".
            const emphasize = isHovered || isMatch;
            const fillColor = nodeColor(n.id, n.kind);
            const isHub = hubThreshold > 0 && n.degree >= hubThreshold;

            // Ambient twinkle — slow per-node luminance shimmer, phase
            // offset by the precomputed id hash so the field never blinks
            // in lockstep. Discs + bloom only; labels stay steady.
            const twinkle =
              0.93 +
              0.07 * Math.sin(performance.now() / 1500 + (n.__phase ?? 0));

            ctx.globalAlpha = alpha * twinkle;
            ctx.save();
            ctx.translate(n.x ?? 0, n.y ?? 0);
            // Bloom — every node is a small light source on the deep
            // ground; hubs bloom stronger. Cached sprite gradient, not
            // shadowBlur (a per-node Gaussian pass would dominate the
            // frame budget at 500+ nodes).
            ctx.beginPath();
            ctx.arc(0, 0, r * 2.3, 0, 2 * Math.PI);
            ctx.fillStyle = glowGradient(ctx, fillColor, r, isHub);
            ctx.fill();
            if (emphasize) {
              // shadowBlur is device-space (unscaled by the zoom transform),
              // so the focus glow reads identically at any zoom level.
              ctx.shadowColor = fillColor;
              ctx.shadowBlur = 14;
            }
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, 2 * Math.PI);
            ctx.fillStyle = discGradient(ctx, fillColor, r);
            ctx.fill();
            ctx.shadowBlur = 0;
            // Rim — a thin ring in the node's own hue keeping the orb
            // crisp over the washes: lit ("neon edge") on the dark
            // ground, tonal-darker on the light one.
            ctx.lineWidth = Math.min(0.8, Math.max(0.3, r * 0.14));
            ctx.strokeStyle = isDark
              ? withAlpha(shadeHex(fillColor, 0.45), 0.4)
              : withAlpha(shadeHex(fillColor, -0.28), 0.6);
            ctx.stroke();
            ctx.restore();
            ctx.globalAlpha = alpha;
            if (emphasize) {
              ctx.lineWidth = 1.5 / globalScale;
              ctx.strokeStyle = colors.foreground;
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
              ctx.stroke();
            }
            if (isHovered) {
              // Expanding pulse ring — radius offset is screen-constant
              // (divided by the zoom) and the continuous-redraw canvas
              // animates it for free.
              const p = pulsePhase(performance.now());
              ctx.globalAlpha = (1 - p) * 0.45 * alpha;
              ctx.lineWidth = 1.4 / globalScale;
              ctx.strokeStyle = fillColor;
              ctx.beginPath();
              ctx.arc(
                n.x ?? 0,
                n.y ?? 0,
                r + (3 + p * 11) / globalScale,
                0,
                2 * Math.PI,
              );
              ctx.stroke();
              ctx.globalAlpha = alpha;
            }

            // Zoom-tiered label: hubs near fit zoom, everyone by reading
            // zoom, emphasized always. Halo in the background color keeps
            // the text legible over edges and neighbouring discs.
            const la =
              labelAlpha({
                zoomRel: globalScale / (fitScaleRef.current || 1),
                degree: n.degree,
                hubThreshold,
                emphasized:
                  isHovered || isHoverNeighbor || isMatch || isFocusNeighbor,
              }) * alpha;
            if (la > 0.03) {
              const px = emphasize ? LABEL_FONT_PX_EMPHASIZED : LABEL_FONT_PX;
              const fontSize = px / globalScale;
              ctx.font = `${emphasize ? 600 : 500} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.globalAlpha = la;
              const label = truncateLabel(n.name);
              const ly = (n.y ?? 0) + r + 3 / globalScale;
              ctx.lineJoin = "round";
              ctx.lineWidth = 3.5 / globalScale;
              ctx.strokeStyle = colors.background;
              ctx.strokeText(label, n.x ?? 0, ly);
              ctx.fillStyle = colors.foreground;
              ctx.fillText(label, n.x ?? 0, ly);
            }
            ctx.globalAlpha = 1;
          }}
          // Pointer area mirrors the visible disc (plus a small grace ring)
          // so clicks land on the node, not the whitespace around the label.
          nodePointerAreaPaint={(
            node: GraphNodeWithPos,
            color: string,
            ctx: CanvasRenderingContext2D,
          ) => {
            const n = node;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, nodeRadius(n.degree) + 2, 0, 2 * Math.PI);
            ctx.fill();
          }}
          // Edges at rest carry their community/kind tint when both
          // endpoints agree (edgeRestColors), neutral border otherwise.
          // Emphasised edges are translucent threads tinted with their anchor
          // node's colour (blue threads off a blue hub), not solid black
          // spokes — soft, legible, and visually tied to the node in focus.
          // Alphas ease through the same stepToward driver as the discs.
          linkColor={(link: GraphEdgeWithRefs) => {
            const l = link;
            let color = edgeRestColors.get(l.id) ?? colors.border;
            // Tinted threads sit softer than neutral bridges — saturated
            // hues need less alpha to read.
            let target = color === colors.border ? 0.65 : 0.5;
            if (hoverId !== null) {
              if (l.__sourceId === hoverId || l.__targetId === hoverId) {
                color = nodeColor(hoverId, kindById.get(hoverId) ?? "other");
                target = 0.7;
              } else {
                target = 0.12;
              }
            } else if (focusMatchIds) {
              // Tint by the matched endpoint's color; the match is the anchor
              // the edge radiates from.
              const matchId = focusMatchIds.has(l.__sourceId)
                ? l.__sourceId
                : focusMatchIds.has(l.__targetId)
                  ? l.__targetId
                  : null;
              if (matchId) {
                color = nodeColor(matchId, kindById.get(matchId) ?? "other");
                target = 0.4;
              } else {
                target = 0.08;
              }
            }
            const alpha = stepToward(
              edgeAlphaRef.current.get(l.id) ?? target,
              target,
            );
            edgeAlphaRef.current.set(l.id, alpha);
            return withAlpha(color, alpha);
          }}
          linkWidth={(link: GraphEdgeWithRefs) => {
            const l = link;
            let target = 0.6;
            if (hoverId !== null) {
              target =
                l.__sourceId === hoverId || l.__targetId === hoverId
                  ? 1.2
                  : 0.4;
            } else if (focusMatchIds) {
              target =
                focusMatchIds.has(l.__sourceId) ||
                focusMatchIds.has(l.__targetId)
                  ? 1.1
                  : 0.35;
            }
            const width = stepToward(
              edgeWidthRef.current.get(l.id) ?? target,
              target,
            );
            edgeWidthRef.current.set(l.id, width);
            return width;
          }}
          // Directional particles: a slow AMBIENT photon drifts along every
          // edge at rest (capped at AMBIENT_PARTICLE_EDGE_CAP edges, and
          // muted while the search spotlight is active); hovering a node
          // swaps its incident edges to a faster two-photon stream. The
          // hover stream is brighter and quicker, so it still reads as the
          // focus cue over the ambient flow.
          linkDirectionalParticles={(link: GraphEdgeWithRefs) => {
            if (hoverId !== null) {
              return link.__sourceId === hoverId ||
                link.__targetId === hoverId
                ? 2
                : 0;
            }
            if (focusMatchIds) return 0;
            return graph.edges.length <= AMBIENT_PARTICLE_EDGE_CAP ? 1 : 0;
          }}
          linkDirectionalParticleWidth={(link: GraphEdgeWithRefs) => {
            const hovered =
              hoverId !== null &&
              (link.__sourceId === hoverId || link.__targetId === hoverId);
            return hovered ? 2.2 : 1.1;
          }}
          linkDirectionalParticleSpeed={(link: GraphEdgeWithRefs) => {
            const hovered =
              hoverId !== null &&
              (link.__sourceId === hoverId || link.__targetId === hoverId);
            return hovered ? 0.006 : 0.002;
          }}
          linkDirectionalParticleColor={(link: GraphEdgeWithRefs) => {
            const anchor =
              hoverId !== null &&
              (link.__sourceId === hoverId || link.__targetId === hoverId)
                ? hoverId
                : null;
            if (anchor) {
              return withAlpha(
                nodeColor(anchor, kindById.get(anchor) ?? "other"),
                0.9,
              );
            }
            // Ambient photons glow in their edge's rest tint.
            return withAlpha(
              edgeRestColors.get(link.id) ?? colors.border,
              0.65,
            );
          }}
          // Click → open the existing detail drawer through the parent.
          // Skill nodes route to the skill detail panel (different data
          // shape); connector nodes have no detail surface in v1. Memory nodes
          // map back to the `memories` primitive row the drawer already renders
          // (graph kind is singular `memory`, the BrainRow kind is `memories`).
          onNodeClick={(node: GraphNodeWithPos) => {
            const n = node;
            if (n.kind === "skill") {
              onSelectSkillNode?.(n.id);
              return;
            }
            if (n.kind === "connector") return;
            if (n.kind === "memory") {
              onSelect({
                id: n.id,
                kind: "memories",
                name: n.name,
                sensitivity: n.sensitivity,
              });
              return;
            }
            onSelect(
              nodeToRow(
                n as GraphNodeWithPos & {
                  kind: Exclude<
                    BrainGraphNodeKind,
                    "skill" | "connector" | "memory"
                  >;
                },
              ),
            );
          }}
          onNodeHover={(node: GraphNodeWithPos | null) => {
            setHoverId(node?.id ?? null);
          }}
        />
      )}
    </div>
  );
}
