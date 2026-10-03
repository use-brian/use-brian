"use client";

/**
 * Force-directed graph view of the workspace brain (app-web).
 *
 * The DEFAULT entries surface: the Brain opens on this node/edge canvas (in
 * group colors); the grouped list (`grouped-view.tsx`) is the view-toggle's
 * alternate behind the topbar's List tab. Renders one bounded server
 * projection at a time: overview groups unfold into child groups or real
 * entries through explicit group clicks, while the force simulation never
 * receives the workspace-wide source graph. Real-entry clicks open the
 * shared `BrainDetailDrawer`.
 *
 * Spec: docs/architecture/brain/graph-view.md.
 *
 * Implementation notes (the pure math lives in `lib/graph-canvas.ts`,
 * unit-tested under [COMP:app-web/graph-canvas]; the frame-budget decision
 * in `lib/graph-motion.ts`, [COMP:app-web/graph-motion]):
 *
 * - The module is imported in an effect (NOT `next/dynamic` — dynamic()
 *   drops refs, and this canvas needs the instance for force tuning, camera
 *   framing and the motion lease). The import only runs client-side.
 * - MOTION LEASE. The canvas no longer renders continuously. The library's
 *   own dirty tracking (`autoPauseRedraw`) paints on pointer moves, zoom,
 *   engine ticks and prop changes; the ONE thing it cannot see is an eased
 *   alpha/width that has not reached its target, so the paint callbacks flag
 *   `easePendingRef` and the post-frame pass flips the library to continuous
 *   painting until every ease converges. With the pointer gone, the layout
 *   settled and nothing easing, the animation loop is stopped outright
 *   (`pauseAnimation`); hidden tabs and off-screen canvases stop too. Any
 *   input, data or visual-state change wakes it (`wake()`). The always-on
 *   decorations that forced continuous frames (per-node twinkle, breathing
 *   halos, drifting aurora, ambient photons, the hover pulse ring) are gone
 *   or moved: the atmosphere (dot grid / vignette) is CSS behind a
 *   transparent canvas (`.graph-backdrop`), so at rest the canvas costs
 *   nothing and looks the same.
 * - Node sizing: flat log curve clamped to [2.5, 7] graph units
 *   (`nodeRadius`); a collision force keeps discs apart; charge / link
 *   distance tuned so communities separate at 80+ nodes.
 * - Bounded one-time fit after the hidden warmup; scope changes never re-fit.
 * - Warm start: positions carry across scope and snapshot refreshes
 *   (`mergePositions`), so a brain-write nudges the layout instead of
 *   re-scrambling the user's mental map.
 * - Labels: zoom-tiered with a background halo; hubs near fit, everyone by
 *   ~2×; small graphs label everything; emphasized nodes always.
 * - Emphasis tiers, in precedence: hover > audit highlight > search
 *   spotlight > groups-legend spotlight; the sidebar filter chips CAP the
 *   tier from below (ghost, never unmount). All transitions ease through
 *   `stepToward`; `prefers-reduced-motion` snaps them.
 * - INFORMATION LAYER: a stats strip (entries / links / groups / scope /
 *   retrieved), a rich hover card (kind, connections, sensitivity, group
 *   composition), edge-type labels on the hovered node's threads, a
 *   groups legend (top communities, hover to spotlight), a selected-node
 *   ring, and +/−/fit zoom controls.
 * - AUDIT HIGHLIGHT (`highlightIds`, features/chat-audit.md): the ids a
 *   turn retrieved are sent to the server as an exact-id focus; matched
 *   entries render in the `--graph-highlight` accent with a glow and a
 *   permanent label, group bubbles that hold matches carry a count badge,
 *   and the parent is told which ids the canvas could place.
 * - Group-overview (bubble map) regime: a projection containing GROUP nodes
 *   gets radius-aware springs, bigger collide padding, no community gravity
 *   on containers, always-on two-line labels, the group fit ceiling, and no
 *   community halos / cluster headings (each bubble labels itself).
 * - Theme colors flow through CSS variables, re-read on theme change.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentType } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import {
  getBrainGraph,
  isBrainGraphGroupNode,
  type BrainGraphGroupNode,
  type BrainGraph,
  type BrainGraphEdge,
  type BrainGraphNode,
  type BrainGraphNodeKind,
  type BrainRow,
} from "@/lib/api/brain";
import { BRAIN_ENTITY_COLORS } from "@/lib/brain-colors";
import {
  CLUSTER_LABEL_FONT_PX,
  CLUSTER_LABEL_MAX_CHARS,
  CLUSTER_MIN_SIZE,
  COLLIDE_PADDING,
  GROUP_COLLIDE_PADDING,
  GROUP_COUNT_FONT_PX,
  GROUP_NAME_MAX_CHARS,
  INITIAL_FIT_MAX_GROUP_RADIUS_PX,
  LABEL_FONT_PX,
  LABEL_FONT_PX_EMPHASIZED,
  NODE_RADIUS_MAX,
  aggregateEdgeWidth,
  boundedViewportFit,
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
  nodeRadius,
  radialSeedPositions,
  radiusAwareLinkDistance,
  shadeHex,
  stepToward,
  truncateLabel,
  withAlpha,
  type CommunityHalo,
  type NodePosition,
} from "@/lib/graph-canvas";
import {
  CAMERA_TWEEN_GRACE_MS,
  CAMERA_TWEEN_MS,
  MOTION_IDLE_GRACE_MS,
  applyCanvasMotion,
  easeRateFor,
  resolveCanvasMotion,
  type CanvasMotionMode,
} from "@/lib/graph-motion";
import { detectCommunities } from "@use-brian/shared";
import {
  graphScopeCacheKey,
  shouldShowGraphLoader,
} from "@/lib/graph-semantic-zoom";
import { format, useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { useCoarsePointer } from "@/lib/viewport";
import { BrainGraphLoadingSkeleton } from "@/components/brain/graph-loading";
import { AUDIT_ACCESS_STEP_MS } from "@/lib/turn-audit";

/**
 * Minimum pointer-area radius on a coarse (touch) pointer, in SCREEN px
 * (C 14 / M3): at the initial fit a leaf node is a 6-18px disc, so a finger
 * landed on whitespace or a neighbour. The paint radius is unchanged - only
 * the hit disc grows, divided by `globalScale` so it stays 22px on screen at
 * every zoom.
 */
const COARSE_POINTER_MIN_HIT_PX = 22;

type Props = {
  graph: BrainGraph;
  workspaceId: string;
  viewpointAssistantId?: string | null;
  showMemory?: boolean;
  /** Click handler — receives a synthetic BrainRow so the parent
   *  can hand it straight to `BrainDetailDrawer` without re-fetching.
   *  Only fired for `BrainRow`-shaped node kinds (entities + knowledge);
   *  skill nodes route through `onSelectSkillNode` instead. */
  onSelect: (row: BrainRow) => void;
  /** Click handler for a `skill` node — receives the skill row id. Connector
   *  nodes have no detail surface in v1, so they no-op. */
  onSelectSkillNode?: (skillRowId: string) => void;
  /** Free-text focus query (the Brain search box) — a SPOTLIGHT, not a
   *  filter: matches stay opaque, neighbours dim slightly, the rest fades.
   *  Empty query OR zero matches → no dimming. */
  focusQuery?: string;
  /** Selected node kinds from the sidebar's primitive filter chips. The
   *  graph GHOSTS the unselected kinds instead of unmounting them. A
   *  selection matching nothing on the canvas leaves the graph untouched.
   *  Spec: graph-view.md → "Filter dim". */
  filterKinds?: ReadonlySet<BrainGraphNodeKind> | null;
  /** The row currently open in the detail drawer — drawn with a selection
   *  ring and a permanent label so the canvas says what is open. */
  selectedId?: string | null;
  /**
   * Chat-audit retrieval highlight (features/chat-audit.md): the brain row
   * ids a turn retrieved. Requests an exact-id server focus (revealing the
   * scope with the most matches), lights matched entries in the highlight
   * accent, badges group bubbles with their match counts, and reports what
   * it could place through `onHighlightResolved`. `null`/empty = off.
   */
  highlightIds?: ReadonlySet<string> | null;
  /**
   * Entry NAMES (lower-cased) the turn's brain-row tools looked up
   * (`getEntity({ id_or_name })`). Matched client-side against the current
   * projection's node names - a name is not a pointer, so there is no
   * server reveal and no group counts for these; they simply join the
   * highlight tier when a visible node carries the name.
   */
  highlightNames?: ReadonlySet<string> | null;
  /** Re-scope the highlight projection around ONE id (the panel's Reveal). */
  highlightRevealId?: string | null;
  /**
   * Retrieved entries the caller resolved itself (clearance-scoped). Any the
   * current projection does not already draw join it as standalone nodes, so
   * a turn whose retrieval is all unlinked memories (which the graph route
   * never draws) still lights its entries instead of matching nothing.
   */
  auditEntries?: readonly BrainGraphNode[];
  /** Active recorded access, within the stable full-turn highlight projection. */
  accessIds?: readonly string[];
  accessNames?: readonly string[];
  /** A new key starts one finite pulse. Null pauses it; reduced motion is static. */
  accessPulseKey?: string | null;
  onAccessReady?: (ready: boolean) => void;
  /** Collapse the groups legend in the short Audit pane, preserving access. */
  auditMode?: boolean;
  onHighlightResolved?: (info: {
    visibleIds: string[];
    groupCounts: Record<string, number>;
  }) => void;
  loading?: boolean;
};

type GraphNodeWithPos = BrainGraphNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
};

function displayKind(node: BrainGraphNode): BrainGraphNodeKind {
  return node.kind;
}

function displayRadius(node: BrainGraphNode): number {
  if (!isBrainGraphGroupNode(node)) return nodeRadius(node.degree);
  // Count-bearing groups read as containers, but stay far below the old
  // 14-unit hub blobs. Log growth means a 40-entry chunk is only modestly
  // larger than a normal hub.
  return Math.min(11.5, 7 + Math.log2(Math.max(node.memberCount, 1)) * 0.75);
}

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
  zoom(): number;
  zoom(scale: number, durationMs?: number): void;
  centerAt(x: number, y: number, durationMs?: number): void;
  getGraphBbox(): { x: [number, number]; y: [number, number] } | null;
  // Methods only: the react-force-graph ref never exposes prop setters, so
  // `autoPauseRedraw` is driven as a React prop (see `continuousPaint`).
  pauseAnimation(): unknown;
  resumeAnimation(): unknown;
};

type ForceGraphComponent = ComponentType<Record<string, unknown>>;

// The effect import is browser-safe, but a route revisit should not briefly
// resurrect the skeleton while the already-loaded module resolves again.
let forceGraphComponentCache: ForceGraphComponent | null = null;
let forceGraphComponentPromise: Promise<ForceGraphComponent> | null = null;

function loadForceGraphComponent(): Promise<ForceGraphComponent> {
  if (forceGraphComponentCache) return Promise.resolve(forceGraphComponentCache);
  if (!forceGraphComponentPromise) {
    forceGraphComponentPromise = import("react-force-graph-2d").then((mod) => {
      forceGraphComponentCache = mod.default as ForceGraphComponent;
      return forceGraphComponentCache;
    });
  }
  return forceGraphComponentPromise;
}

/** Node color source — detected community (default, the Obsidian
 *  path-groups look) or kind (entity-type hues + legend). */
type GraphColorMode = "kind" | "group";

const COLOR_MODE_STORAGE_KEY = "brain:graph-color-mode";

export type ThemeColors = {
  background: string;
  foreground: string;
  muted: string;
  border: string;
  /** The audit-highlight accent (`--graph-highlight`). */
  highlight: string;
  kinds: Record<BrainGraphNodeKind, string>;
};

export const FALLBACK_COLORS: ThemeColors = {
  // Light-mode graph ground — mirrors the :root --graph-* tokens in
  // globals.css. Light is the app default, so it's the pre-mount/SSR
  // fallback; readThemeColors swaps in the live values right after mount.
  background: "#FFFFFF",
  foreground: "#1F2737",
  muted: "#6B7691",
  border: "#D7DDEA",
  highlight: "#D97706",
  kinds: BRAIN_ENTITY_COLORS,
};

// Stable display order for the legend — common entity kinds first, the
// generic `other` bucket last.
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
  "skill_file",
  "connector",
  "other",
];

// Force tuning — stronger repulsion + longer links than the d3 defaults so
// clusters separate visually at 80+ nodes; the collide force guarantees discs
// never overlap.
const CHARGE_STRENGTH = -55;
// Intra/inter link split: edges WITHIN a detected community stay short and
// stiff (tight "firework" blobs); bridge edges between communities stretch
// long and go LOOSE, so they read as connective threads.
const LINK_DISTANCE_INTRA = 28;
const LINK_DISTANCE_INTER = 160;
const LINK_STRENGTH_INTRA = 0.7;
const LINK_STRENGTH_INTER = 0.08;

// Filter-dim caps (graph-view.md → "Filter dim") — the ghost tier for node
// kinds outside the sidebar's primitive-chip selection.
const FILTER_DIM_NODE_ALPHA = 0.15;
const FILTER_DIM_EDGE_ALPHA = 0.08;
const FILTER_DIM_EDGE_WIDTH = 0.35;

// Emphasis tiers (node alpha targets): the anchor, its 1-hop context, the rest.
const TIER_REST_HOVER = 0.18;
const TIER_NEIGHBOR_FOCUS = 0.5;
const TIER_REST_FOCUS = 0.12;
const TIER_NEIGHBOR_HIGHLIGHT = 0.45;
const TIER_REST_HIGHLIGHT = 0.1;
// Audit replay: the turn's other matches step back while one access pulses.
const TIER_HIGHLIGHT_WAITING = 0.55;

/** How many incident edges get a type label while a node is hovered. */
const HOVER_EDGE_LABEL_CAP = 12;
/** Rows in the groups legend before the "+N more" line. */
const GROUP_LEGEND_ROWS = 8;
/** Zoom-button step (multiplicative). */
const ZOOM_STEP = 1.35;

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
  const kind = (k: BrainGraphNodeKind) =>
    read(`--graph-entity-${k}`, FALLBACK_COLORS.kinds[k]);
  return {
    background: read("--graph-bg", FALLBACK_COLORS.background),
    foreground: read("--graph-fg", FALLBACK_COLORS.foreground),
    muted: read("--graph-muted", FALLBACK_COLORS.muted),
    border: read("--graph-border", FALLBACK_COLORS.border),
    highlight: read("--graph-highlight", FALLBACK_COLORS.highlight),
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
      skill_file: kind("skill_file"),
      connector: kind("connector"),
    },
  };
}

/**
 * Map a graph node back to the `BrainRow` shape the detail drawer expects.
 * The drawer fetches its own rollup, so only `id`, `kind`, `name` matter.
 */
function nodeToRow(
  node: BrainGraphNode & {
    kind: Exclude<BrainGraphNodeKind, "skill" | "skill_file" | "connector" | "memory">;
  },
): BrainRow {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    sensitivity: node.sensitivity,
  };
}

/** `works_at` → "works at"; aggregate/related edges are labelled by the caller. */
function humanizeEdgeType(type: string): string {
  return type.replace(/[_\-]+/g, " ").trim();
}

function setKey(set: ReadonlySet<string> | null | undefined): string {
  if (!set || set.size === 0) return "";
  return [...set].sort().join(",");
}

export function BrainGraphView({
  graph: sourceGraph,
  workspaceId,
  viewpointAssistantId,
  showMemory = true,
  onSelect,
  onSelectSkillNode,
  focusQuery,
  filterKinds,
  selectedId,
  highlightIds,
  highlightNames,
  highlightRevealId,
  auditEntries,
  accessIds,
  accessNames,
  accessPulseKey,
  onAccessReady,
  auditMode = false,
  onHighlightResolved,
  loading,
}: Props) {
  const t = useT();
  const coarsePointer = useCoarsePointer();
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const hoverCardRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphInstance | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [colors, setColors] = useState<ThemeColors>(FALLBACK_COLORS);
  const [hoverNode, setHoverNode] = useState<GraphNodeWithPos | null>(null);
  const hoverId = hoverNode?.id ?? null;
  const [scopedGraph, setScopedGraph] = useState<BrainGraph | null>(null);
  const [scopeHistory, setScopeHistory] = useState<BrainGraph[]>([]);
  const [scopeLoading, setScopeLoading] = useState(false);
  const scopeCacheRef = useRef<Map<string, BrainGraph>>(new Map());
  const requestRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const transitionOriginRef = useRef<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  // Imported in an effect instead of `next/dynamic` — dynamic() does not
  // forward refs, and this canvas needs the instance for force + camera tuning.
  const [ForceGraph2D, setForceGraph2D] = useState<ForceGraphComponent | null>(
    () => forceGraphComponentCache,
  );

  useEffect(() => {
    let cancelled = false;
    void loadForceGraphComponent().then((component) => {
      if (!cancelled) setForceGraph2D(() => component);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A workspace/viewpoint switch invalidates every navigation scope.
  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    scopeCacheRef.current.clear();
    setScopedGraph(null);
    setScopeHistory([]);
    transitionOriginRef.current = null;
  }, [workspaceId, viewpointAssistantId, showMemory]);

  useEffect(
    () => () => {
      requestRef.current?.abort();
    },
    [],
  );

  // Theme colors after mount + on theme change; reduced-motion preference.
  useEffect(() => {
    setColors(readThemeColors());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setColors(readThemeColors());
    mq.addEventListener("change", onChange);
    const obs = new MutationObserver(onChange);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-palette"],
    });
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => setReducedMotion(motion.matches);
    onMotion();
    motion.addEventListener("change", onMotion);
    return () => {
      mq.removeEventListener("change", onChange);
      motion.removeEventListener("change", onMotion);
      obs.disconnect();
    };
  }, []);
  const easeRate = easeRateFor(reducedMotion);

  // Observe container size — ForceGraph2D wants explicit width/height.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const commitSize = (width: number, height: number) => {
      const next = { w: Math.max(200, width), h: Math.max(200, height) };
      setDims((current) =>
        current?.w === next.w && current.h === next.h ? current : next,
      );
    };
    const initial = el.getBoundingClientRect();
    commitSize(initial.width, initial.height);
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      commitSize(r.width, r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const loadProjection = useCallback(
    async (request: {
      scopeId?: string | null;
      focusQuery?: string | null;
      focusIds?: readonly string[] | null;
      revealFocus?: boolean;
    }) => {
      const cacheKey = graphScopeCacheKey({
        workspaceId,
        viewpointAssistantId,
        showMemory,
        scopeId: request.scopeId,
        focusQuery: request.focusQuery,
        focusIds: request.focusIds,
        revealFocus: request.revealFocus,
      });
      const cached = scopeCacheRef.current.get(cacheKey);
      if (cached) return cached;

      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      const sequence = ++requestSequenceRef.current;
      setScopeLoading(true);
      try {
        const next = await getBrainGraph({
          workspaceId,
          viewpointAssistantId,
          showMemory,
          scopeId: request.scopeId,
          focusQuery: request.focusQuery,
          focusIds: request.focusIds,
          revealFocus: request.revealFocus,
          failOnError: true,
          signal: controller.signal,
        });
        if (controller.signal.aborted || sequence !== requestSequenceRef.current) {
          return null;
        }
        scopeCacheRef.current.set(cacheKey, next);
        return next;
      } catch (error) {
        if (controller.signal.aborted) return null;
        console.error("[brain-graph] scope projection fetch failed", error);
        return null;
      } finally {
        if (sequence === requestSequenceRef.current) setScopeLoading(false);
      }
    },
    [workspaceId, viewpointAssistantId, showMemory],
  );

  const activeProjection = scopedGraph ?? sourceGraph;
  const graph = useMemo(() => {
    if (!auditEntries || auditEntries.length === 0) return activeProjection;
    const present = new Set(activeProjection.nodes.map((node) => node.id));
    const extra = auditEntries.filter((node) => !present.has(node.id));
    return extra.length === 0
      ? activeProjection
      : { ...activeProjection, nodes: [...activeProjection.nodes, ...extra] };
  }, [activeProjection, auditEntries]);
  const groupLabel = t.brainPage.graphView.density.groupLabel;
  const groupCountLabel = t.brainPage.graphView.density.groupCount;

  const hasGroupNodes = useMemo(
    () => graph.nodes.some(isBrainGraphGroupNode),
    [graph],
  );

  // ── Audit highlight ───────────────────────────────────────────────────
  const highlightKey = setKey(highlightIds);
  const highlightActive = highlightKey.length > 0;
  const highlightActiveRef = useRef(false);
  const queryActive = (focusQuery ?? "").trim().length > 0;

  const openGroup = useCallback(
    async (groupId: string) => {
      const group = graph.nodes.find(
        (node): node is BrainGraphGroupNode =>
          isBrainGraphGroupNode(node) && node.groupId === groupId,
      );
      if (!group || scopeLoading) return;
      transitionOriginRef.current = group.id;
      const next = await loadProjection({
        scopeId: group.groupId,
        // Keep the retrieved-entry marks alive inside the opened group.
        ...(highlightActive && highlightIds
          ? { focusIds: [...highlightIds] }
          : {}),
      });
      if (!next) {
        transitionOriginRef.current = null;
        return;
      }
      setScopeHistory((current) => [...current, activeProjection]);
      setScopedGraph(next);
    },
    [graph.nodes, scopeLoading, loadProjection, activeProjection, highlightActive, highlightIds],
  );

  const returnToPreviousScope = useCallback(() => {
    const previous = scopeHistory.at(-1);
    if (!previous) return;
    requestRef.current?.abort();
    transitionOriginRef.current = null;
    // Under an audit highlight the overview must still carry the per-group
    // match counts, which the page's cached overview does not have.
    if (highlightActive && highlightIds && !previous.scopeId) {
      void loadProjection({ focusIds: [...highlightIds] }).then((next) => {
        setScopedGraph(next ?? null);
      });
    } else {
      setScopedGraph(previous.scopeId ? previous : null);
    }
    setScopeHistory((current) => current.slice(0, -1));
  }, [scopeHistory, highlightActive, highlightIds, loadProjection]);

  // Search reveal is server-side and debounced. Clearing it restores the
  // cached overview immediately; obsolete requests are aborted.
  useEffect(() => {
    const query = (focusQuery ?? "").trim();
    if (query.length === 0) {
      // The audit highlight owns the scope while it is active.
      if (highlightActiveRef.current) return;
      requestRef.current?.abort();
      setScopedGraph(null);
      setScopeHistory([]);
      return;
    }
    requestRef.current?.abort();
    const timer = window.setTimeout(() => {
      void loadProjection({ focusQuery: query }).then((next) => {
        if (!next) return;
        transitionOriginRef.current = next.scopeId ?? null;
        setScopeHistory([sourceGraph]);
        setScopedGraph(next);
      });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [focusQuery, loadProjection, sourceGraph]);

  // Audit highlight projection: reveal the scope holding the most retrieved
  // entries (or the one entry the panel asked to reveal). Clearing the
  // highlight restores the overview. The search spotlight wins if both are
  // active (the audit section never passes a query).
  useEffect(() => {
    if (!highlightActive || !highlightIds) {
      if (highlightActiveRef.current) {
        highlightActiveRef.current = false;
        requestRef.current?.abort();
        setScopedGraph(null);
        setScopeHistory([]);
      }
      return;
    }
    if (queryActive) return;
    highlightActiveRef.current = true;
    const ids = highlightRevealId ? [highlightRevealId] : [...highlightIds];
    void loadProjection({ focusIds: ids, revealFocus: true }).then((next) => {
      if (!next) return;
      transitionOriginRef.current = next.scopeId ?? null;
      setScopeHistory([sourceGraph]);
      setScopedGraph(next);
    });
    // `highlightKey` is the order-insensitive identity of `highlightIds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey, highlightRevealId, queryActive, loadProjection, sourceGraph]);

  // Precompute neighbor index — keyed by node id → Set of neighbor ids.
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const node of graph.nodes) m.set(node.id, new Set());
    for (const edge of graph.edges) {
      m.get(edge.source)?.add(edge.target);
      m.get(edge.target)?.add(edge.source);
    }
    return m;
  }, [graph]);

  // Search-focus spotlight. `null` when the query is empty OR matched nothing.
  const focusMatchIds = useMemo(() => {
    const q = (focusQuery ?? "").trim().toLowerCase();
    if (q.length === 0) return null;
    const s = new Set<string>(activeProjection.focusNodeIds ?? []);
    for (const n of graph.nodes) {
      if (!isBrainGraphGroupNode(n) && n.name.toLowerCase().includes(q)) {
        s.add(n.id);
      }
    }
    return s.size > 0 ? s : null;
  }, [graph, focusQuery, activeProjection.focusNodeIds]);

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

  // Audit highlight — matched entries visible in this projection, plus the
  // group bubbles holding matches (they count as anchors too).
  const highlightGroupCounts = useMemo(
    () => (highlightActive ? activeProjection.focusGroupCounts ?? {} : {}),
    [highlightActive, activeProjection.focusGroupCounts],
  );
  const nameHighlightActive = (highlightNames?.size ?? 0) > 0;
  const highlightMatchIds = useMemo(() => {
    if (!highlightActive && !nameHighlightActive) return null;
    const s = new Set<string>();
    for (const n of graph.nodes) {
      if (highlightIds?.has(n.id)) s.add(n.id);
      // Name lookups (`getEntity({ id_or_name })`) match by display name;
      // group bubbles never match by name (their name is a member's).
      if (
        nameHighlightActive &&
        !isBrainGraphGroupNode(n) &&
        highlightNames!.has(n.name.trim().toLowerCase())
      ) {
        s.add(n.id);
      }
    }
    if (highlightIds) {
      for (const id of activeProjection.focusNodeIds ?? []) {
        if (highlightIds.has(id)) s.add(id);
      }
    }
    for (const groupId of Object.keys(highlightGroupCounts)) s.add(groupId);
    return s.size > 0 ? s : null;
  }, [
    graph,
    highlightActive,
    nameHighlightActive,
    highlightIds,
    highlightNames,
    activeProjection.focusNodeIds,
    highlightGroupCounts,
  ]);
  const highlightNeighborIds = useMemo(() => {
    if (!highlightMatchIds) return null;
    const s = new Set<string>();
    for (const id of highlightMatchIds) {
      for (const nb of neighbors.get(id) ?? []) {
        if (!highlightMatchIds.has(nb)) s.add(nb);
      }
    }
    return s;
  }, [highlightMatchIds, neighbors]);

  // Tell the parent which retrieved ids this projection could place.
  const onHighlightResolvedRef = useRef(onHighlightResolved);
  onHighlightResolvedRef.current = onHighlightResolved;
  useEffect(() => {
    if (!highlightActive && !nameHighlightActive) return;
    const visible: string[] = [];
    for (const n of graph.nodes) {
      if (highlightIds?.has(n.id)) visible.push(n.id);
      else if (
        nameHighlightActive &&
        !isBrainGraphGroupNode(n) &&
        highlightNames!.has(n.name.trim().toLowerCase())
      ) {
        visible.push(n.id);
      }
    }
    onHighlightResolvedRef.current?.({
      visibleIds: visible,
      groupCounts: highlightGroupCounts,
    });
  }, [graph, highlightActive, nameHighlightActive, highlightIds, highlightNames, highlightGroupCounts]);

  // id → kind, so an emphasised edge can borrow the colour of its anchor.
  const kindById = useMemo(() => {
    const m = new Map<string, BrainGraphNodeKind>();
    for (const n of graph.nodes) m.set(n.id, displayKind(n));
    return m;
  }, [graph]);

  // Filter-dim selection — nulled when nothing on the canvas matches.
  const activeFilterKinds = useMemo(() => {
    if (!filterKinds || filterKinds.size === 0) return null;
    return graph.nodes.some((n) => filterKinds.has(displayKind(n)))
      ? filterKinds
      : null;
  }, [graph, filterKinds]);

  const edgeFilteredOut = useCallback(
    (l: GraphEdgeWithRefs): boolean => {
      if (activeFilterKinds === null) return false;
      return (
        !activeFilterKinds.has(kindById.get(l.__sourceId) ?? "other") ||
        !activeFilterKinds.has(kindById.get(l.__targetId) ?? "other")
      );
    },
    [activeFilterKinds, kindById],
  );

  // Hub cut for label tiering — top-decile degree.
  const hubThreshold = useMemo(
    () => hubDegreeThreshold(graph.nodes.map((n) => n.degree)),
    [graph],
  );

  // Connectivity communities — feed the cluster-gravity force, the
  // intra/inter link split, group colors, and the groups legend.
  const communities = useMemo(
    () => detectCommunities(graph.nodes, graph.edges),
    [graph],
  );
  const communitiesRef = useRef(communities);
  communitiesRef.current = communities;

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

  /** One color resolver for discs, glow, edge tints, and particles. */
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

  const isDark = useMemo(() => hexLuma(colors.background) < 0.5, [colors]);

  // Halo tint per community — group mode mirrors the disc palette; kind
  // mode uses the community's plurality kind.
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
      const kind = displayKind(n);
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
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

  // Group headings — each community's most-connected member name.
  const communityLabelText = useMemo(
    () =>
      colorMode === "group" && !hasGroupNodes
        ? communityLabels(graph.nodes, (id) => communities.byId.get(id))
        : new Map<number, string>(),
    [colorMode, graph, communities, hasGroupNodes],
  );

  // Groups legend — the top communities by size with their heading, count
  // and color. Hovering a row spotlights that community on the canvas.
  const [legendSpotlight, setLegendSpotlight] = useState<number | null>(null);
  const [legendPinned, setLegendPinned] = useState<number | null>(null);
  useEffect(() => {
    setLegendSpotlight(null);
    setLegendPinned(null);
  }, [graph, colorMode]);
  const groupsLegend = useMemo(() => {
    if (colorMode !== "group" || hasGroupNodes) return { rows: [], more: 0 };
    const rows = communities.sizes
      .map((size, community) => ({ community, size }))
      .filter((r) => r.size >= CLUSTER_MIN_SIZE)
      .sort((a, b) => b.size - a.size || a.community - b.community)
      .map((r) => ({
        ...r,
        label: communityLabelText.get(r.community) ?? "",
        color: groupPalette[r.community % groupPalette.length],
      }))
      .filter((r) => r.label.length > 0);
    return {
      rows: rows.slice(0, GROUP_LEGEND_ROWS),
      more: Math.max(0, rows.length - GROUP_LEGEND_ROWS),
    };
  }, [colorMode, hasGroupNodes, communities, communityLabelText, groupPalette]);
  const legendCommunity = legendSpotlight ?? legendPinned;
  const legendMatchIds = useMemo(() => {
    if (legendCommunity === null) return null;
    const s = new Set<string>();
    for (const n of graph.nodes) {
      if (communities.byId.get(n.id) === legendCommunity) s.add(n.id);
    }
    return s.size > 0 ? s : null;
  }, [legendCommunity, graph, communities]);

  // Rest-state edge tint — same-colored endpoints carry the color as a
  // thread; mixed endpoints stay on the neutral border.
  const edgeRestColors = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of graph.edges) {
      const sc = nodeColor(e.source, kindById.get(e.source) ?? "other");
      const tc = nodeColor(e.target, kindById.get(e.target) ?? "other");
      m.set(e.id, sc === tc ? sc : colors.border);
    }
    return m;
  }, [graph, kindById, nodeColor, colors]);

  // Live node objects from the PREVIOUS snapshot (warm start).
  const lastNodesRef = useRef<Map<string, GraphNodeWithPos>>(new Map());

  // Per-node/edge current paint values (eased toward their targets).
  const nodeAlphaRef = useRef<Map<string, number>>(new Map());
  const edgeAlphaRef = useRef<Map<string, number>>(new Map());
  const edgeWidthRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    lastNodesRef.current.clear();
    nodeAlphaRef.current.clear();
    edgeAlphaRef.current.clear();
    edgeWidthRef.current.clear();
  }, [workspaceId, viewpointAssistantId, showMemory]);

  const lastHalosRef = useRef<CommunityHalo[]>([]);

  // ForceGraph2D mutates the links array in place; copy once here.
  const graphData = useMemo(() => {
    const nodes = graph.nodes.map((n) => ({ ...n }) as GraphNodeWithPos);
    const prev = new Map<string, NodePosition>();
    for (const [id, node] of lastNodesRef.current) {
      if (node.x != null && node.y != null) {
        prev.set(id, { x: node.x, y: node.y, vx: node.vx, vy: node.vy });
      }
    }
    const originId = transitionOriginRef.current;
    const origin = originId ? lastNodesRef.current.get(originId) : null;
    if (origin?.x != null && origin.y != null) {
      const revealed = nodes.filter((node) => !prev.has(node.id));
      const seeded = radialSeedPositions(revealed, {
        x: origin.x,
        y: origin.y,
      });
      for (const [id, position] of seeded) {
        prev.set(id, position);
        nodeAlphaRef.current.set(id, 0);
      }
      for (const edge of graph.edges) {
        if (edgeAlphaRef.current.has(edge.id)) continue;
        edgeAlphaRef.current.set(edge.id, 0);
        edgeWidthRef.current.set(edge.id, 0);
      }
    }
    mergePositions(nodes, graph.edges, prev);
    for (const node of nodes) lastNodesRef.current.set(node.id, node);
    transitionOriginRef.current = null;
    return {
      nodes,
      links: graph.edges.map((e) => ({
        ...e,
        __sourceId: e.source,
        __targetId: e.target,
      })) as unknown as GraphEdgeWithRefs[],
    };
  }, [graph]);

  const presentKinds = useMemo(() => {
    const seen = new Set<BrainGraphNodeKind>();
    for (const n of graph.nodes) seen.add(displayKind(n));
    return KIND_ORDER.filter((k) => seen.has(k));
  }, [graph]);

  // ── Motion lease ──────────────────────────────────────────────────────
  // See lib/graph-motion.ts. The refs are the live inputs; `settleMotion`
  // resolves + applies a mode, debouncing the transition INTO `paused` so a
  // quick re-entry or the tail of a hover-out ease never thrashes the loop.
  const easePendingRef = useRef(false);
  const pointerInsideRef = useRef(false);
  const engineSettledRef = useRef(false);
  const tweenUntilRef = useRef(0);
  const documentVisibleRef = useRef(true);
  const intersectingRef = useRef(true);
  const motionModeRef = useRef<CanvasMotionMode>("on-demand");
  const idleTimerRef = useRef<number | null>(null);
  // `autoPauseRedraw` is a PROP (the ref exposes methods only), so continuous
  // painting is React state: `autoPauseRedraw={!continuousPaint}`. The ref
  // mirror guards the setter so a repeated decision never re-renders.
  const [continuousPaint, setContinuousPaint] = useState(false);
  const continuousRef = useRef(false);
  const motionDriver = useCallback((instance: ForceGraphInstance) => ({
    setContinuous: (on: boolean) => {
      if (continuousRef.current === on) return;
      continuousRef.current = on;
      setContinuousPaint(on);
    },
    pauseAnimation: () => instance.pauseAnimation(),
    resumeAnimation: () => instance.resumeAnimation(),
  }), []);

  const clearIdleTimer = () => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  };

  const settleMotion = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const instance = motionDriver(fg);
    const mode = resolveCanvasMotion({
      documentVisible: documentVisibleRef.current,
      intersecting: intersectingRef.current,
      easePending: easePendingRef.current,
      tweenActive: performance.now() < tweenUntilRef.current,
      pointerInside: pointerInsideRef.current,
      engineSettled: engineSettledRef.current,
    });
    if (mode === "paused" && motionModeRef.current !== "paused") {
      // Hidden / off-screen pauses immediately; idle pauses after a grace.
      const immediate = !documentVisibleRef.current || !intersectingRef.current;
      if (immediate) {
        clearIdleTimer();
        motionModeRef.current = "paused";
        applyCanvasMotion(instance, "paused");
        return;
      }
      if (idleTimerRef.current === null) {
        idleTimerRef.current = window.setTimeout(() => {
          idleTimerRef.current = null;
          settleMotion();
        }, MOTION_IDLE_GRACE_MS);
      }
      // Until the grace expires, stay on-demand (the library skips idle frames).
      if (motionModeRef.current !== "on-demand") {
        motionModeRef.current = "on-demand";
        applyCanvasMotion(instance, "on-demand");
      }
      return;
    }
    if (mode !== "paused") clearIdleTimer();
    if (mode !== motionModeRef.current) {
      motionModeRef.current = mode;
      applyCanvasMotion(instance, mode);
    }
  }, [motionDriver]);

  /** Anything that changes how a frame looks calls this: the loop resumes
   *  (if paused) so the prop change the caller made can paint, and the
   *  post-frame pass then decides whether more frames are owed. */
  const wake = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    clearIdleTimer();
    if (motionModeRef.current === "paused") {
      motionModeRef.current = "on-demand";
      applyCanvasMotion(motionDriver(fg), "on-demand");
    }
  }, [motionDriver]);

  const accessNodes = useMemo(() => graphData.nodes.filter((node) =>
    !isBrainGraphGroupNode(node) && (accessIds?.includes(node.id) ||
      accessNames?.includes(node.name.trim().toLowerCase())),
  ), [graphData, accessIds, accessNames]);
  // The entries the current access lit, when a replay is running and at
  // least one of them is drawn - otherwise no match steps back.
  const accessFocusIds = useMemo(
    () => accessPulseKey && accessNodes.length > 0
      ? new Set(accessNodes.map((node) => node.id))
      : null,
    [accessPulseKey, accessNodes],
  );
  const accessPulseStartRef = useRef<number | null>(null);
  useEffect(() => {
    onAccessReady?.(!scopeLoading && !loading && Boolean(ForceGraph2D));
  }, [onAccessReady, scopeLoading, loading, ForceGraph2D]);
  useEffect(() => {
    accessPulseStartRef.current = accessPulseKey && !reducedMotion && !scopeLoading && accessNodes.length > 0
      ? performance.now() : null;
    wake();
    return () => { accessPulseStartRef.current = null; };
  }, [accessPulseKey, reducedMotion, scopeLoading, accessNodes, wake]);

  // Visual-state changes → one frame at least.
  useEffect(() => {
    wake();
  }, [
    wake,
    graphData,
    hoverId,
    focusMatchIds,
    highlightMatchIds,
    accessFocusIds,
    legendMatchIds,
    activeFilterKinds,
    colors,
    colorMode,
    selectedId,
    dims,
  ]);

  // Hidden tab / off-screen canvas → pause outright; back → resume.
  useEffect(() => {
    const el = containerRef.current;
    const onVisibility = () => {
      documentVisibleRef.current = document.visibilityState !== "hidden";
      if (documentVisibleRef.current) wake();
      settleMotion();
    };
    document.addEventListener("visibilitychange", onVisibility);
    let io: IntersectionObserver | null = null;
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        intersectingRef.current = entry.isIntersecting;
        if (entry.isIntersecting) wake();
        settleMotion();
      });
      io.observe(el);
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      io?.disconnect();
      clearIdleTimer();
    };
  }, [wake, settleMotion]);

  // A new projection re-runs the simulation: the engine is live again.
  useEffect(() => {
    engineSettledRef.current = false;
  }, [graphData]);

  // ── Hover card (imperative positioning; no React render per pointer move) ──
  const positionHoverCard = (clientX: number, clientY: number) => {
    const card = hoverCardRef.current;
    const el = containerRef.current;
    if (!card || !el) return;
    const box = el.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    const cw = card.offsetWidth || 220;
    const ch = card.offsetHeight || 80;
    const left = Math.min(Math.max(8, x + 14), Math.max(8, box.width - cw - 8));
    const top =
      y + 16 + ch > box.height - 8 ? Math.max(8, y - ch - 12) : y + 16;
    card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };

  // ── Visual caches ────────────────────────────────────────────────────
  const gradientCacheRef = useRef<Map<string, CanvasGradient>>(new Map());
  useEffect(() => {
    gradientCacheRef.current.clear();
  }, [colors]);

  /** Cached radial "orb" gradient — highlight up-left, token color in the
   *  body, darker limb. Built origin-relative under a translate; bucketed
   *  to quarter graph units so the cache stays bounded. */
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
    const g = ctx.createRadialGradient(-rb * 0.35, -rb * 0.4, rb * 0.1, 0, 0, rb * 1.05);
    g.addColorStop(0, shadeHex(fill, 0.45));
    g.addColorStop(0.55, fill);
    g.addColorStop(1, shadeHex(fill, -0.18));
    cache.set(key, g);
    return g;
  };

  /** Cached bloom sprite behind every disc — an arc fill of a radial
   *  falloff, NOT `shadowBlur` (a per-node device-space Gaussian pass).
   *  Hubs bloom stronger — the "important at rest" cue. */
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

  /** Soft community washes behind the clusters — graph space, over the live
   *  (sim-mutated) positions. Static alpha: the wash no longer breathes, so
   *  an idle canvas owes no frames on its account. */
  const paintHalos = (ctx: CanvasRenderingContext2D) => {
    if (hasGroupNodes) {
      lastHalosRef.current = [];
      return;
    }
    const byId = communitiesRef.current.byId;
    const halos = communityHalos(graphData.nodes, (id) => byId.get(id));
    lastHalosRef.current = halos;
    for (const h of halos) {
      const color = haloColors.get(h.community);
      if (!color) continue;
      const inner = withAlpha(color, isDark ? 0.09 : 0.06);
      if (inner === color) continue; // non-hex token — skip, never paint solid
      const g = ctx.createRadialGradient(h.x, h.y, h.r * 0.1, h.x, h.y, h.r);
      g.addColorStop(0, inner);
      g.addColorStop(0.7, withAlpha(color, isDark ? 0.05 : 0.035));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(h.x, h.y, h.r, 0, 2 * Math.PI);
      ctx.fill();
    }
  };

  /** Group headings above each cluster — full at fit, gone by ~1.8× fit. */
  const paintClusterLabels = (ctx: CanvasRenderingContext2D, globalScale: number) => {
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
      const hue = haloColors.get(h.community);
      const fill = hue ? shadeHex(hue, isDark ? 0.5 : -0.45) : colors.foreground;
      const label = truncateLabel(text, CLUSTER_LABEL_MAX_CHARS);
      const ly = h.y - h.r - 4 / globalScale;
      ctx.strokeStyle = colors.background;
      ctx.strokeText(label, h.x, ly);
      ctx.fillStyle = fill;
      ctx.fillText(label, h.x, ly);
    }
    ctx.restore();
  };

  /** Edge-type labels on the hovered node's incident threads — the one
   *  moment the relationship vocabulary is worth reading. Bounded by
   *  HOVER_EDGE_LABEL_CAP; aggregate group edges say how many links they
   *  stand for instead. */
  const paintHoverEdgeLabels = (ctx: CanvasRenderingContext2D, globalScale: number) => {
    if (hoverId === null) return;
    let drawn = 0;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 / globalScale;
    ctx.font = `500 ${9.5 / globalScale}px ui-sans-serif, system-ui, sans-serif`;
    for (const l of graphData.links) {
      if (l.__sourceId !== hoverId && l.__targetId !== hoverId) continue;
      if (typeof l.source !== "object" || typeof l.target !== "object") continue;
      const sx = l.source.x ?? 0;
      const sy = l.source.y ?? 0;
      const tx = l.target.x ?? 0;
      const ty = l.target.y ?? 0;
      const text =
        l.type === "aggregate"
          ? l.count && l.count > 1
            ? format(t.brainPage.graphView.stats.linksMany, { count: l.count })
            : t.brainPage.graphView.stats.linksOne
          : humanizeEdgeType(l.type);
      if (!text) continue;
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      ctx.strokeStyle = colors.background;
      ctx.strokeText(text, mx, my);
      ctx.fillStyle = colors.muted;
      ctx.fillText(text, mx, my);
      if (++drawn >= HOVER_EDGE_LABEL_CAP) break;
    }
    ctx.restore();
  };

  // Frame the first non-empty projection once, immediately after the hidden
  // warmup. Scope changes and refreshes preserve the camera.
  const didFitRef = useRef(false);
  const hasUserCameraIntentRef = useRef(false);
  const fitScaleRef = useRef(1);

  useEffect(() => {
    didFitRef.current = false;
    hasUserCameraIntentRef.current = false;
    fitScaleRef.current = 1;
  }, [workspaceId, viewpointAssistantId, showMemory]);

  const runBoundedFit = useCallback(
    (animate: boolean) => {
      const instance = fgRef.current;
      if (!instance || !dims || graphData.nodes.length === 0) return false;
      const bounds = instance.getGraphBbox();
      if (!bounds) return false;
      const fit = boundedViewportFit({
        width: dims.w,
        height: dims.h,
        bounds,
        maxNodeRadius: graphData.nodes.reduce(
          (max, node) => Math.max(max, displayRadius(node)),
          0,
        ),
        maxNodeRadiusPx: graphData.nodes.some(isBrainGraphGroupNode)
          ? INITIAL_FIT_MAX_GROUP_RADIUS_PX
          : undefined,
      });
      fitScaleRef.current = fit.scale;
      const ms = animate && !reducedMotion ? CAMERA_TWEEN_MS : 0;
      tweenUntilRef.current = performance.now() + (ms > 0 ? CAMERA_TWEEN_GRACE_MS : 0);
      wake();
      instance.centerAt(fit.center.x, fit.center.y, ms);
      instance.zoom(fit.scale, ms);
      return true;
    },
    [dims, graphData.nodes, reducedMotion, wake],
  );

  const fitInitialCamera = useCallback(() => {
    const instance = fgRef.current;
    if (didFitRef.current || !instance || !dims || graphData.nodes.length === 0) {
      return;
    }
    if (hasUserCameraIntentRef.current) {
      didFitRef.current = true;
      const currentScale = instance.zoom();
      if (currentScale > 0) fitScaleRef.current = currentScale;
      return;
    }
    if (runBoundedFit(true)) didFitRef.current = true;
  }, [dims, graphData.nodes, runBoundedFit]);

  const zoomBy = (factor: number) => {
    const instance = fgRef.current;
    if (!instance) return;
    hasUserCameraIntentRef.current = true;
    const ms = reducedMotion ? 0 : 200;
    tweenUntilRef.current = performance.now() + (ms > 0 ? ms + 80 : 0);
    wake();
    instance.zoom(Math.max(0.05, Math.min(12, instance.zoom() * factor)), ms);
  };

  const fitToView = () => {
    hasUserCameraIntentRef.current = false;
    if (runBoundedFit(true)) didFitRef.current = true;
  };

  /** Ref callback — tunes charge/link and installs the custom forces. */
  const bindFg = (instance: ForceGraphInstance | null) => {
    fgRef.current = instance;
    if (!instance) return;
    instance.d3Force("charge")?.strength?.(CHARGE_STRENGTH);
    const sameCommunity = (link: unknown): boolean => {
      const l = link as GraphEdgeWithRefs;
      const byId = communitiesRef.current.byId;
      const a = byId.get(l.__sourceId);
      return a != null && a === byId.get(l.__targetId);
    };
    const endpointNode = (id: string): GraphNodeWithPos | undefined =>
      lastNodesRef.current.get(id);
    instance.d3Force("link")?.distance?.((link: unknown) => {
      const l = link as GraphEdgeWithRefs;
      const base = sameCommunity(l) ? LINK_DISTANCE_INTRA : LINK_DISTANCE_INTER;
      const s = endpointNode(l.__sourceId);
      const tn = endpointNode(l.__targetId);
      return radiusAwareLinkDistance(
        base,
        s ? displayRadius(s) : NODE_RADIUS_MAX,
        tn ? displayRadius(tn) : NODE_RADIUS_MAX,
        Boolean(
          (s && isBrainGraphGroupNode(s)) || (tn && isBrainGraphGroupNode(tn)),
        ),
      );
    });
    instance.d3Force("link")?.strength?.(((link: unknown) =>
      sameCommunity(link) ? LINK_STRENGTH_INTRA : LINK_STRENGTH_INTER) as never);
    instance.d3Force(
      "collide",
      makeCollideForce((n) => displayRadius(n as GraphNodeWithPos), {
        padding: (n) =>
          isBrainGraphGroupNode(n as GraphNodeWithPos)
            ? GROUP_COLLIDE_PADDING
            : COLLIDE_PADDING,
      }),
    );
    instance.d3Force("anchor", makeAnchorForce());
    instance.d3Force(
      "cluster",
      makeClusterForce((n) => {
        const node = n as GraphNodeWithPos;
        if (isBrainGraphGroupNode(node)) return undefined;
        return communitiesRef.current.byId.get(node.id);
      }),
    );
    // Start on-demand: the library skips idle frames from the first tick.
    motionModeRef.current = "on-demand";
    applyCanvasMotion(motionDriver(instance), "on-demand");
  };

  if (graph.nodes.length === 0 && !loading && !scopeLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-8 py-12 text-muted-foreground">
        <p className="text-sm">{t.brainPage.graphView.empty}</p>
        <p className="text-xs mt-2 opacity-70 max-w-md">
          {t.brainPage.graphView.emptyHint}
        </p>
      </div>
    );
  }

  const showGraphLoader = shouldShowGraphLoader({
    initialLoading: Boolean(loading),
    scopeLoading,
    hasDimensions: dims !== null,
    hasRenderer: ForceGraph2D !== null,
  });
  const visibleGroupCount = graph.nodes.filter(isBrainGraphGroupNode).length;
  const totalNodeCount = activeProjection.totalNodes ?? graph.nodes.length;
  const linkCount = graph.edges.length;
  const highlightVisibleCount = highlightMatchIds
    ? [...highlightMatchIds].filter((id) => !(id in highlightGroupCounts)).length +
      Object.values(highlightGroupCounts).reduce((a, b) => a + b, 0)
    : 0;
  const statsCopy = t.brainPage.graphView.stats;
  const compactAudit = auditMode && dims !== null && (dims.w < 520 || dims.h < 360);
  const GroupsLegendContainer = compactAudit ? "details" : "div";
  const chipCls =
    "rounded-md border border-[var(--graph-overlay-border)] bg-[var(--graph-overlay)] text-[11px] text-[var(--graph-overlay-fg)] shadow-sm backdrop-blur-md";

  return (
    <div
      ref={containerRef}
      className="relative flex-1 min-h-0 overflow-hidden bg-[var(--graph-bg)]"
      aria-busy={Boolean(loading) || scopeLoading}
      onPointerEnter={() => {
        pointerInsideRef.current = true;
        wake();
      }}
      onPointerLeave={() => {
        pointerInsideRef.current = false;
        settleMotion();
      }}
      onPointerMove={(e) => positionHoverCard(e.clientX, e.clientY)}
      onPointerDownCapture={() => {
        hasUserCameraIntentRef.current = true;
        wake();
      }}
      onWheelCapture={() => {
        hasUserCameraIntentRef.current = true;
        wake();
      }}
    >
      {/* Atmosphere — CSS, not canvas (see the header note). */}
      <div className="graph-backdrop" aria-hidden>
        <div ref={gridRef} className="graph-backdrop__grid" />
        <div className="graph-backdrop__vignette" />
      </div>

      {showGraphLoader && (
        <div className="absolute inset-0 z-20">
          <BrainGraphLoadingSkeleton />
        </div>
      )}

      {/* Stats strip — the shape of the projection at a glance. */}
      {!showGraphLoader && graph.nodes.length > 0 && (
        <div className="absolute left-2 top-2 z-10 flex max-w-[70%] flex-col items-start gap-1.5">
          <div
            className={cn(chipCls, "flex flex-wrap items-center gap-x-2 px-2.5 py-1 tabular-nums")}
            title={
              activeProjection.truncated
                ? format(t.brainPage.graphView.truncated, { count: totalNodeCount })
                : undefined
            }
          >
            <span>
              {totalNodeCount === 1
                ? statsCopy.entriesOne
                : format(statsCopy.entriesMany, { count: totalNodeCount })}
              {activeProjection.truncated ? "+" : ""}
            </span>
            {visibleGroupCount > 0 ? (
              <>
                <span aria-hidden className="opacity-40">·</span>
                <span>
                  {visibleGroupCount === 1
                    ? statsCopy.groupsOne
                    : format(statsCopy.groupsMany, { count: visibleGroupCount })}
                </span>
              </>
            ) : (
              <>
                <span aria-hidden className="opacity-40">·</span>
                <span>
                  {linkCount === 1
                    ? statsCopy.linksOne
                    : format(statsCopy.linksMany, { count: linkCount })}
                </span>
              </>
            )}
            {(highlightActive || nameHighlightActive) && highlightVisibleCount > 0 && (
              <>
                <span aria-hidden className="opacity-40">·</span>
                <span style={{ color: colors.highlight }}>
                  {format(statsCopy.highlighted, { count: highlightVisibleCount })}
                </span>
              </>
            )}
          </div>
          {(activeProjection.scopeLabel || scopeHistory.length > 0) && (
            <div className="flex items-center gap-1.5">
              {activeProjection.scopeLabel && (
                <span className={cn(chipCls, "max-w-[220px] truncate px-2.5 py-1")}>
                  {format(statsCopy.inScope, { name: activeProjection.scopeLabel })}
                </span>
              )}
              {scopeHistory.length > 0 && (
                <button
                  type="button"
                  onClick={returnToPreviousScope}
                  // The only way out of a drilled-in group: `py-2 sm:py-1` (C 71).
                  className={cn(chipCls, "px-2.5 py-2 transition-colors hover:text-[var(--graph-fg)] sm:py-1")}
                >
                  {t.brainPage.graphView.semantic.back}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Kind legend (Type mode) or groups legend (Groups mode, entry-level). */}
      {!showGraphLoader && colorMode === "kind" && presentKinds.length > 1 && (
        <div className={cn(chipCls, "absolute bottom-2 left-2 z-10 flex max-w-[70%] flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5")}>
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
      {!showGraphLoader && colorMode === "group" && groupsLegend.rows.length > 1 && (
        <GroupsLegendContainer
          key={compactAudit ? "compact" : "expanded"}
          className={cn(chipCls, "absolute bottom-2 left-2 z-10 w-[200px] px-1.5 py-1.5")}
          onPointerLeave={() => setLegendSpotlight(null)}
        >
          {compactAudit ? <summary className="min-h-8 max-sm:min-h-11 cursor-pointer content-center px-1 text-xs font-medium">
            {t.brainPage.graphView.groupsLegend.heading}
          </summary> : <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">
            {t.brainPage.graphView.groupsLegend.heading}
          </div>}
          <ul className="flex flex-col">
            {groupsLegend.rows.map((row) => (
              <li key={row.community}>
                <button
                  type="button"
                  aria-label={format(t.brainPage.graphView.groupsLegend.rowAria, { name: row.label })}
                  aria-pressed={legendPinned === row.community}
                  onPointerEnter={() => setLegendSpotlight(row.community)}
                  onFocus={() => setLegendSpotlight(row.community)}
                  onBlur={() => setLegendSpotlight(null)}
                  onClick={() =>
                    setLegendPinned((prev) => (prev === row.community ? null : row.community))
                  }
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-[var(--graph-overlay-active)]",
                    legendPinned === row.community && "bg-[var(--graph-overlay-active)] text-[var(--graph-fg)]",
                  )}
                >
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: row.color }}
                  />
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  <span className="shrink-0 tabular-nums opacity-60">{row.size}</span>
                </button>
              </li>
            ))}
            {groupsLegend.more > 0 && (
              <li className="px-1 pt-0.5 text-[10px] opacity-60">
                {format(t.brainPage.graphView.groupsLegend.more, { count: groupsLegend.more })}
              </li>
            )}
          </ul>
        </GroupsLegendContainer>
      )}

      {/* Color-mode toggle — Groups | Type. */}
      {graph.nodes.length > 0 && (
        <div className={cn(chipCls, "absolute top-2 right-2 z-10 inline-flex p-0.5")}>
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

      {/* Zoom controls — top-right, stacked under the color-mode toggle. NOT
          bottom-right: the workspace chrome's floating chat dock owns that
          corner on every surface. */}
      {!showGraphLoader && graph.nodes.length > 0 && (
        <div className={cn(chipCls, "absolute right-2 top-11 z-10 flex flex-col p-0.5")}>
          <button
            type="button"
            aria-label={t.brainPage.graphView.zoom.inAria}
            title={t.brainPage.graphView.zoom.inAria}
            onClick={() => zoomBy(ZOOM_STEP)}
            className="inline-flex size-6 items-center justify-center rounded transition-colors hover:bg-[var(--graph-overlay-active)] hover:text-[var(--graph-fg)]"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t.brainPage.graphView.zoom.outAria}
            title={t.brainPage.graphView.zoom.outAria}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            className="inline-flex size-6 items-center justify-center rounded transition-colors hover:bg-[var(--graph-overlay-active)] hover:text-[var(--graph-fg)]"
          >
            <Minus className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t.brainPage.graphView.zoom.fitAria}
            title={t.brainPage.graphView.zoom.fitAria}
            onClick={fitToView}
            className="inline-flex size-6 items-center justify-center rounded transition-colors hover:bg-[var(--graph-overlay-active)] hover:text-[var(--graph-fg)]"
          >
            <Maximize2 className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      {/* Hover card — positioned imperatively from pointer moves. */}
      <div
        ref={hoverCardRef}
        aria-hidden
        className={cn(
          chipCls,
          "pointer-events-none absolute left-0 top-0 z-30 w-max max-w-[240px] px-2.5 py-1.5 transition-opacity duration-100",
          hoverNode ? "opacity-100" : "opacity-0",
        )}
      >
        {hoverNode && (
          <HoverCardBody
            node={hoverNode}
            colors={colors}
            nodeColor={nodeColor}
            highlighted={Boolean(
              highlightIds?.has(hoverNode.id) ||
                (nameHighlightActive &&
                  !isBrainGraphGroupNode(hoverNode) &&
                  highlightNames!.has(hoverNode.name.trim().toLowerCase())),
            )}
            highlightCount={highlightGroupCounts[hoverNode.id]}
          />
        )}
      </div>

      {dims && ForceGraph2D && graph.nodes.length > 0 && (
        <ForceGraph2D
          ref={bindFg as never}
          graphData={graphData}
          width={dims.w}
          height={dims.h}
          // Transparent: the ground and its atmosphere are CSS behind the canvas.
          backgroundColor="rgba(0,0,0,0)"
          // The motion lease owns this flag (lib/graph-motion.ts): `false`
          // only while an ease or camera tween is in flight, `true` otherwise
          // so the library skips idle frames. It is a prop because the ref
          // exposes methods only.
          autoPauseRedraw={!continuousPaint}
          warmupTicks={100}
          cooldownTicks={140}
          d3VelocityDecay={0.32}
          onEngineTick={fitInitialCamera}
          onEngineStop={() => {
            engineSettledRef.current = true;
            settleMotion();
          }}
          onZoom={(transform: { k: number; x: number; y: number }) => {
            // World-locked dot grid: pitch re-tiles at discrete zoom levels,
            // offset follows the pan. Two CSS vars, no repaint of our own.
            const grid = gridRef.current;
            if (!grid) return;
            const pitch = gridStep(transform.k) * transform.k;
            grid.style.setProperty("--graph-grid-pitch", `${pitch}px`);
            grid.style.setProperty(
              "--graph-grid-x",
              `${((transform.x % pitch) + pitch) % pitch}px`,
            );
            grid.style.setProperty(
              "--graph-grid-y",
              `${((transform.y % pitch) + pitch) % pitch}px`,
            );
          }}
          onRenderFramePre={(ctx: CanvasRenderingContext2D) => {
            easePendingRef.current = accessPulseStartRef.current !== null &&
              performance.now() - accessPulseStartRef.current < AUDIT_ACCESS_STEP_MS;
            paintHalos(ctx);
          }}
          onRenderFramePost={(ctx: CanvasRenderingContext2D, globalScale: number) => {
            if (colorMode === "group" && !hasGroupNodes) paintClusterLabels(ctx, globalScale);
            paintHoverEdgeLabels(ctx, globalScale);
            // Pulse only actual visible accesses, never invent a traversal of
            // the graph's relationships. The motion lease stops after one step.
            const elapsed = accessPulseStartRef.current === null ? null : performance.now() - accessPulseStartRef.current;
            ctx.save();
            ctx.strokeStyle = colors.highlight;
            ctx.lineWidth = 2 / globalScale;
            for (const node of accessNodes) {
              if (node.x === undefined || node.y === undefined) continue;
              const radius = displayRadius(node);
              ctx.globalAlpha = 0.9;
              ctx.beginPath();
              ctx.arc(node.x, node.y, radius + 5 / globalScale, 0, Math.PI * 2);
              ctx.stroke();
              if (elapsed === null || elapsed >= AUDIT_ACCESS_STEP_MS) continue;
              for (const delay of [0, 0.35]) {
                const progress = elapsed / AUDIT_ACCESS_STEP_MS - delay;
                if (progress < 0) continue;
                ctx.globalAlpha = (1 - progress) * 0.75;
                ctx.beginPath();
                ctx.arc(node.x, node.y, radius + (5 + 26 * progress) / globalScale, 0, Math.PI * 2);
                ctx.stroke();
              }
            }
            ctx.restore();
            // The one decision the library cannot make: are eases still moving?
            settleMotion();
          }}
          // The lib's own tooltip is replaced by the hover card above.
          nodeLabel={() => ""}
          nodeCanvasObject={(
            node: GraphNodeWithPos,
            ctx: CanvasRenderingContext2D,
            globalScale: number,
          ) => {
            const n = node;
            const r = displayRadius(n);
            const isGroup = isBrainGraphGroupNode(n);
            const isHovered = hoverId === n.id;
            const isHoverNeighbor =
              hoverId !== null && (neighbors.get(hoverId)?.has(n.id) ?? false);
            const isMatch = focusMatchIds?.has(n.id) ?? false;
            const isFocusNeighbor = focusNeighborIds?.has(n.id) ?? false;
            const isHighlight = highlightMatchIds?.has(n.id) ?? false;
            const isHighlightNeighbor = highlightNeighborIds?.has(n.id) ?? false;
            const isLegendMatch = legendMatchIds?.has(n.id) ?? false;
            const isSelected = selectedId != null && selectedId === n.id;

            // Alpha tiers: hover > audit highlight > search > legend > rest.
            let target = 1;
            if (hoverId !== null) {
              target = isHovered || isHoverNeighbor ? 1 : TIER_REST_HOVER;
            } else if (highlightMatchIds) {
              // In the Audit pane only the turn's own entries stay lit: a
              // neighbour of a retrieved entry was not retrieved. While one
              // access replays, the other matches step back so the order reads.
              target = isHighlight
                ? accessFocusIds && !accessFocusIds.has(n.id)
                  ? TIER_HIGHLIGHT_WAITING
                  : 1
                : isHighlightNeighbor && !auditMode
                  ? TIER_NEIGHBOR_HIGHLIGHT
                  : TIER_REST_HIGHLIGHT;
            } else if (focusMatchIds) {
              target = isMatch ? 1 : isFocusNeighbor ? TIER_NEIGHBOR_FOCUS : TIER_REST_FOCUS;
            } else if (legendMatchIds) {
              target = isLegendMatch ? 1 : TIER_REST_FOCUS;
            }
            const isFilteredOut =
              activeFilterKinds !== null && !activeFilterKinds.has(displayKind(n));
            if (isFilteredOut && !isHovered) {
              target = Math.min(target, FILTER_DIM_NODE_ALPHA);
            }
            const alpha = stepToward(nodeAlphaRef.current.get(n.id) ?? target, target, easeRate);
            if (alpha !== target) easePendingRef.current = true;
            nodeAlphaRef.current.set(n.id, alpha);

            const emphasize = isHovered || isMatch || isHighlight || isSelected;
            const fillColor = nodeColor(n.id, displayKind(n));
            const isHub = hubThreshold > 0 && n.degree >= hubThreshold;

            ctx.globalAlpha = alpha;
            ctx.save();
            ctx.translate(n.x ?? 0, n.y ?? 0);
            ctx.beginPath();
            ctx.arc(0, 0, r * 2.3, 0, 2 * Math.PI);
            ctx.fillStyle = glowGradient(ctx, isHighlight ? colors.highlight : fillColor, r, isHub || isHighlight);
            ctx.fill();
            if (emphasize) {
              // shadowBlur is device-space, so the focus glow reads the same at any zoom.
              ctx.shadowColor = isHighlight ? colors.highlight : fillColor;
              ctx.shadowBlur = 14;
            }
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, 2 * Math.PI);
            ctx.fillStyle = discGradient(ctx, fillColor, r);
            ctx.fill();
            ctx.shadowBlur = 0;
            // Rim — lit on the dark ground, tonal-darker on light.
            ctx.lineWidth = Math.min(0.8, Math.max(0.3, r * 0.14));
            ctx.strokeStyle = isDark
              ? withAlpha(shadeHex(fillColor, 0.45), 0.4)
              : withAlpha(shadeHex(fillColor, -0.28), 0.6);
            ctx.stroke();
            ctx.restore();
            ctx.globalAlpha = alpha;

            if (isHighlight) {
              // Retrieved-entry ring in the highlight accent.
              ctx.lineWidth = 2 / globalScale;
              ctx.strokeStyle = colors.highlight;
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, r + 1.5 / globalScale, 0, 2 * Math.PI);
              ctx.stroke();
            } else if (isHovered || isMatch) {
              ctx.lineWidth = 1.5 / globalScale;
              ctx.strokeStyle = colors.foreground;
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
              ctx.stroke();
            }
            if (isSelected) {
              // Selection ring — a thin offset halo so it reads under the
              // hover/highlight rings without hiding them.
              ctx.lineWidth = 1.2 / globalScale;
              ctx.setLineDash([3 / globalScale, 2.5 / globalScale]);
              ctx.strokeStyle = colors.foreground;
              ctx.beginPath();
              ctx.arc(n.x ?? 0, n.y ?? 0, r + 4 / globalScale, 0, 2 * Math.PI);
              ctx.stroke();
              ctx.setLineDash([]);
            }

            // Group bubbles that hold retrieved entries carry a count badge.
            const badgeCount = isGroup ? highlightGroupCounts[n.id] : undefined;
            if (badgeCount) {
              const bx = (n.x ?? 0) + r * 0.72;
              const by = (n.y ?? 0) - r * 0.72;
              const br = Math.max(3.2, 7.5 / globalScale);
              ctx.fillStyle = colors.highlight;
              ctx.beginPath();
              ctx.arc(bx, by, br, 0, 2 * Math.PI);
              ctx.fill();
              ctx.fillStyle = colors.background;
              ctx.font = `700 ${Math.max(4, 9 / globalScale)}px ui-sans-serif, system-ui, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillText(String(badgeCount), bx, by + 0.2 / globalScale);
            }

            // Zoom-tiered label with a background halo; emphasized always.
            const la =
              labelAlpha({
                zoomRel: globalScale / (fitScaleRef.current || 1),
                degree: n.degree,
                hubThreshold,
                emphasized:
                  isHovered ||
                  isHoverNeighbor ||
                  isMatch ||
                  isFocusNeighbor ||
                  isHighlight ||
                  isSelected ||
                  isGroup,
              }) * alpha;
            if (la > 0.03) {
              const px = emphasize ? LABEL_FONT_PX_EMPHASIZED : LABEL_FONT_PX;
              const fontSize = px / globalScale;
              ctx.font = `${emphasize || isGroup ? 600 : 500} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              ctx.globalAlpha = la;
              const label = truncateLabel(n.name, isGroup ? GROUP_NAME_MAX_CHARS : undefined);
              const ly = (n.y ?? 0) + r + 3 / globalScale;
              ctx.lineJoin = "round";
              ctx.lineWidth = 3.5 / globalScale;
              ctx.strokeStyle = colors.background;
              ctx.strokeText(label, n.x ?? 0, ly);
              ctx.fillStyle = isHighlight ? shadeHex(colors.highlight, isDark ? 0.25 : -0.3) : colors.foreground;
              ctx.fillText(label, n.x ?? 0, ly);
              if (isGroup) {
                const countLabel = format(groupCountLabel, { count: n.memberCount });
                const cy = ly + (px + 2.5) / globalScale;
                ctx.font = `500 ${GROUP_COUNT_FONT_PX / globalScale}px ui-sans-serif, system-ui, sans-serif`;
                ctx.strokeText(countLabel, n.x ?? 0, cy);
                ctx.fillStyle = colors.muted;
                ctx.fillText(countLabel, n.x ?? 0, cy);
              }
            }
            ctx.globalAlpha = 1;
          }}
          nodePointerAreaPaint={(
            node: GraphNodeWithPos,
            color: string,
            ctx: CanvasRenderingContext2D,
            globalScale: number,
          ) => {
            const n = node;
            const r = displayRadius(n) + 2;
            // Floor the hit disc to 22 screen px on touch (see the constant).
            const hit = coarsePointer
              ? Math.max(r, COARSE_POINTER_MIN_HIT_PX / (globalScale || 1))
              : r;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, hit, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkColor={(link: GraphEdgeWithRefs) => {
            const l = link;
            let color = edgeRestColors.get(l.id) ?? colors.border;
            let target = color === colors.border ? 0.65 : 0.5;
            if (hoverId !== null) {
              if (l.__sourceId === hoverId || l.__targetId === hoverId) {
                color = nodeColor(hoverId, kindById.get(hoverId) ?? "other");
                target = 0.7;
              } else {
                target = 0.12;
              }
            } else if (highlightMatchIds) {
              const anchor = highlightMatchIds.has(l.__sourceId)
                ? l.__sourceId
                : highlightMatchIds.has(l.__targetId)
                  ? l.__targetId
                  : null;
              if (anchor) {
                color = colors.highlight;
                target = 0.45;
              } else {
                target = 0.08;
              }
            } else if (focusMatchIds) {
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
            } else if (legendMatchIds) {
              target =
                legendMatchIds.has(l.__sourceId) && legendMatchIds.has(l.__targetId)
                  ? 0.6
                  : 0.08;
            }
            if (
              edgeFilteredOut(l) &&
              !(hoverId !== null && (l.__sourceId === hoverId || l.__targetId === hoverId))
            ) {
              target = Math.min(target, FILTER_DIM_EDGE_ALPHA);
            }
            const alpha = stepToward(edgeAlphaRef.current.get(l.id) ?? target, target, easeRate);
            if (alpha !== target) easePendingRef.current = true;
            edgeAlphaRef.current.set(l.id, alpha);
            return withAlpha(color, alpha);
          }}
          linkWidth={(link: GraphEdgeWithRefs) => {
            const l = link;
            const rest = aggregateEdgeWidth(l.count);
            let target = rest;
            if (hoverId !== null) {
              target =
                l.__sourceId === hoverId || l.__targetId === hoverId
                  ? Math.max(1.2, rest)
                  : 0.4;
            } else if (highlightMatchIds) {
              target =
                highlightMatchIds.has(l.__sourceId) || highlightMatchIds.has(l.__targetId)
                  ? Math.max(1.1, rest)
                  : 0.35;
            } else if (focusMatchIds) {
              target =
                focusMatchIds.has(l.__sourceId) || focusMatchIds.has(l.__targetId)
                  ? Math.max(1.1, rest)
                  : 0.35;
            }
            if (
              edgeFilteredOut(l) &&
              !(hoverId !== null && (l.__sourceId === hoverId || l.__targetId === hoverId))
            ) {
              target = Math.min(target, FILTER_DIM_EDGE_WIDTH);
            }
            const width = stepToward(edgeWidthRef.current.get(l.id) ?? target, target, easeRate);
            if (width !== target) easePendingRef.current = true;
            edgeWidthRef.current.set(l.id, width);
            return width;
          }}
          // Directional particles are HOVER-ONLY now: the hovered node's
          // incident edges run a two-photon stream in its color. (The ambient
          // one-photon-per-edge drift at rest is gone — it forced a frame
          // every 16ms for a cue nobody reads at rest.)
          linkDirectionalParticles={(link: GraphEdgeWithRefs) =>
            hoverId !== null &&
            !reducedMotion &&
            (link.__sourceId === hoverId || link.__targetId === hoverId)
              ? 2
              : 0
          }
          linkDirectionalParticleWidth={2.2}
          linkDirectionalParticleSpeed={0.006}
          linkDirectionalParticleColor={(link: GraphEdgeWithRefs) => {
            const anchor =
              hoverId !== null &&
              (link.__sourceId === hoverId || link.__targetId === hoverId)
                ? hoverId
                : null;
            return anchor
              ? withAlpha(nodeColor(anchor, kindById.get(anchor) ?? "other"), 0.9)
              : withAlpha(colors.border, 0);
          }}
          onNodeClick={(node: GraphNodeWithPos) => {
            const n = node;
            if (isBrainGraphGroupNode(n)) {
              void openGroup(n.groupId);
              return;
            }
            if (n.kind === "skill") {
              onSelectSkillNode?.(n.id);
              return;
            }
            if (n.kind === "skill_file") return;
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
                    "skill" | "skill_file" | "connector" | "memory"
                  >;
                },
              ),
            );
          }}
          onNodeHover={(node: GraphNodeWithPos | null) => {
            setHoverNode(node ?? null);
          }}
        />
      )}
    </div>
  );
}

/** The hover card's content — kind, connections, sensitivity, and for a
 *  group its size + composition; the audit badge when the node was
 *  retrieved for the turn under review. */
function HoverCardBody({
  node,
  colors,
  nodeColor,
  highlighted,
  highlightCount,
}: {
  node: GraphNodeWithPos;
  colors: ThemeColors;
  nodeColor: (id: string, kind: BrainGraphNodeKind) => string;
  highlighted: boolean;
  highlightCount: number | undefined;
}) {
  const t = useT();
  const copy = t.brainPage.graphView;
  const isGroup = isBrainGraphGroupNode(node);
  const composition = isGroup
    ? Object.entries(node.kindCounts)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .slice(0, 3)
    : [];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: nodeColor(node.id, node.kind) }}
        />
        <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--graph-fg)]">
          {node.name}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px]">
        {!isGroup && <span>{copy.legend[node.kind]}</span>}
        {isGroup ? (
          <span>{format(copy.density.groupCount, { count: node.memberCount })}</span>
        ) : (
          <span>
            {node.degree === 1
              ? copy.hoverCard.connectionsOne
              : format(copy.hoverCard.connectionsMany, { count: node.degree })}
          </span>
        )}
        {!isGroup && <span className="opacity-70">{copy.hoverCard.sensitivity[node.sensitivity]}</span>}
      </div>
      {isGroup && composition.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 text-[10.5px] opacity-80">
          {composition.map(([kind, count]) => (
            <span key={kind} className="inline-flex items-center gap-1">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: colors.kinds[kind as BrainGraphNodeKind] ?? colors.muted }}
              />
              {copy.legend[kind as BrainGraphNodeKind] ?? kind} {count}
            </span>
          ))}
        </div>
      )}
      {(highlighted || highlightCount) && (
        <div className="text-[10.5px] font-medium" style={{ color: colors.highlight }}>
          {highlightCount
            ? format(copy.hoverCard.containsRetrieved, { count: highlightCount })
            : copy.hoverCard.retrieved}
        </div>
      )}
      {isGroup && <div className="text-[10px] opacity-60">{copy.hoverCard.openGroup}</div>}
    </div>
  );
}
