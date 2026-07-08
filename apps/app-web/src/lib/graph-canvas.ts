// [COMP:app-web/graph-canvas]
/**
 * Pure rendering math for the Brain force-graph canvases.
 *
 * Everything the `BrainGraphView` canvas renderer computes per frame or
 * per snapshot that does NOT touch the DOM lives here, so the legibility
 * rules (node sizing, label tiering, collision, warm-start layout) are
 * unit-testable without a canvas:
 *
 *   - `nodeRadius` — flat log curve, clamped to [2.5, 7] graph units. The
 *     old `sqrt(1 + min(d, 12)) * 4` curve drew hubs as ~14-unit discs
 *     that overlapped into blobs in dense areas.
 *   - `makeCollideForce` — a dependency-free d3-style collision force
 *     (the lib's force engine is d3-force, but `d3-force` itself is not a
 *     direct dependency; a force is just `(alpha) => void` with an
 *     `initialize(nodes)` hook). O(n²) per tick is fine at the graph's
 *     1000-node cap — pair distance checks are cheap and the simulation
 *     only runs during cooldown.
 *   - `hubDegreeThreshold` + `labelAlpha` — zoom-tiered labels: hubs
 *     (top-decile degree) fade in near fit zoom, everything else fades in
 *     past ~1.2×, emphasized nodes (hover / search match) are always
 *     labelled. Small graphs (≤ HUB_SMALL_GRAPH nodes) label everything
 *     from fit zoom — tiering exists to prevent label walls, and a small
 *     graph can't produce one.
 *   - `stepToward` — per-frame easing for the hover/search dim
 *     transitions (lerp instead of alpha snapping).
 *   - `mergePositions` — warm-start: carry node positions across snapshot
 *     refreshes and seed NEW nodes at their positioned-neighbour centroid,
 *     so a brain-refresh nudges the layout instead of re-scrambling it.
 *   - `mixHex` / `shadeHex` / `hexLuma` — palette-derived color math for
 *     the visual treatment (orb gradients, tinted edges, adaptive
 *     backdrop) so every shade traces back to a theme token.
 *   - `communityHalos` — live centroid + bounding radius per community,
 *     feeding the soft cluster washes painted behind the graph.
 *   - `gridStep` / `pulsePhase` — backdrop dot-grid tiling and the hover
 *     pulse-ring animation phase.
 *
 * Spec: docs/architecture/brain/graph-view.md → "Frontend".
 */

export const NODE_RADIUS_MIN = 2.5;
export const NODE_RADIUS_MAX = 7;
/** Degree at which the radius curve saturates. */
const NODE_DEGREE_CAP = 12;

/**
 * Node radius in graph units — log curve so the visual difference between
 * degree 0 and 3 is bigger than between 9 and 12 (a hub reads as "bigger",
 * not as a black hole).
 */
export function nodeRadius(degree: number): number {
  const d = Math.min(Math.max(degree, 0), NODE_DEGREE_CAP);
  const t = Math.log2(1 + d) / Math.log2(1 + NODE_DEGREE_CAP);
  return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * t;
}

/**
 * Per-disc gap kept by the collision force, in graph units. Sized for
 * LABEL clearance, not just disc clearance — adjacent nodes at similar y
 * draw their labels into each other when the discs are merely
 * non-overlapping.
 */
const COLLIDE_PADDING = 4;

type ForceNode = { x?: number; y?: number; degree?: number };

/**
 * Dependency-free d3-style collision force. Each tick, every overlapping
 * pair is pushed apart along its separation vector until discs (plus
 * padding) no longer intersect. Coincident nodes (zero distance — fresh
 * spawns) are separated along a caller-suppliable unit `jiggle` vector so
 * tests stay deterministic.
 */
export function makeCollideForce(
  getRadius: (node: ForceNode) => number,
  opts: { padding?: number; strength?: number; jiggle?: () => number } = {},
): ((alpha: number) => void) & { initialize: (nodes: ForceNode[]) => void } {
  const padding = opts.padding ?? COLLIDE_PADDING;
  const strength = opts.strength ?? 0.8;
  const jiggle = opts.jiggle ?? (() => Math.random() - 0.5);
  let nodes: ForceNode[] = [];

  const force = (_alpha: number) => {
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      const ra = getRadius(a) + padding;
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        // Per-disc padding on both endpoints — the rest gap between two
        // discs is 2 × padding.
        const r = ra + getRadius(b) + padding;
        let dx = (b.x ?? 0) - (a.x ?? 0);
        let dy = (b.y ?? 0) - (a.y ?? 0);
        let d2 = dx * dx + dy * dy;
        if (d2 >= r * r) continue;
        if (d2 === 0) {
          dx = jiggle();
          dy = jiggle();
          d2 = dx * dx + dy * dy;
          if (d2 === 0) {
            dx = 1;
            d2 = 1;
          }
        }
        const d = Math.sqrt(d2);
        // Half the overlap each, scaled by strength — converges over the
        // cooldown ticks without oscillating.
        const push = ((r - d) / d) * 0.5 * strength;
        const px = dx * push;
        const py = dy * push;
        a.x = (a.x ?? 0) - px;
        a.y = (a.y ?? 0) - py;
        b.x = (b.x ?? 0) + px;
        b.y = (b.y ?? 0) + py;
      }
    }
  };

  return Object.assign(force, {
    initialize: (ns: ForceNode[]) => {
      nodes = ns;
    },
  });
}

/** Default member-to-centroid strength for `makeClusterForce`. */
const CLUSTER_STRENGTH = 0.3;
/** Communities below this size get no gravity (anchor handles strays). */
export const CLUSTER_MIN_SIZE = 3;

/**
 * Community gravity — pulls every member of a community toward that
 * community's live centroid (recomputed each tick). Combined with the
 * intra/inter link-distance split in graph-view.tsx, this is what turns
 * connectivity clusters into the spatially separated "firework" blobs of
 * the Obsidian graph aesthetic, instead of one continuous mass.
 *
 * `communityOf` resolves a node to its community index (or undefined to
 * opt the node out). Tiny communities (< minSize) are skipped — the
 * anchor force already handles strays, and a 2-node "community" pulling
 * itself together just collapses onto the collide force.
 */
export function makeClusterForce(
  communityOf: (node: ForceNode) => number | undefined,
  opts: { strength?: number; minSize?: number } = {},
): ((alpha: number) => void) & { initialize: (nodes: ForceNode[]) => void } {
  const strength = opts.strength ?? CLUSTER_STRENGTH;
  const minSize = opts.minSize ?? CLUSTER_MIN_SIZE;
  let nodes: Array<ForceNode & { vx?: number; vy?: number }> = [];

  const force = (alpha: number) => {
    // Live centroids per community.
    const acc = new Map<number, { x: number; y: number; n: number }>();
    for (const node of nodes) {
      const c = communityOf(node);
      if (c == null) continue;
      const slot = acc.get(c) ?? { x: 0, y: 0, n: 0 };
      slot.x += node.x ?? 0;
      slot.y += node.y ?? 0;
      slot.n += 1;
      acc.set(c, slot);
    }
    for (const node of nodes) {
      const c = communityOf(node);
      if (c == null) continue;
      const slot = acc.get(c);
      if (!slot || slot.n < minSize) continue;
      const cx = slot.x / slot.n;
      const cy = slot.y / slot.n;
      node.vx = (node.vx ?? 0) + (cx - (node.x ?? 0)) * strength * alpha;
      node.vy = (node.vy ?? 0) + (cy - (node.y ?? 0)) * strength * alpha;
    }
  };

  return Object.assign(force, {
    initialize: (ns: ForceNode[]) => {
      nodes = ns;
    },
  });
}

/** Default pull-to-origin strength for `makeAnchorForce`. */
const ANCHOR_STRENGTH = 0.12;

/**
 * Weak radial pull toward the origin (the d3 `forceX`/`forceY` pattern,
 * inlined because d3-force isn't a direct dependency). Without it, charge
 * repulsion pushes ISOLATED nodes and small disconnected components
 * arbitrarily far from the main graph — the layout's bounding box balloons
 * and `zoomToFit` frames a mostly-empty canvas. The pull is too weak to
 * distort connected clusters; it only stops unconnected drift.
 */
export function makeAnchorForce(
  strength: number = ANCHOR_STRENGTH,
): ((alpha: number) => void) & { initialize: (nodes: ForceNode[]) => void } {
  let nodes: Array<ForceNode & { vx?: number; vy?: number }> = [];
  const force = (alpha: number) => {
    for (const n of nodes) {
      n.vx = (n.vx ?? 0) - (n.x ?? 0) * strength * alpha;
      n.vy = (n.vy ?? 0) - (n.y ?? 0) * strength * alpha;
    }
  };
  return Object.assign(force, {
    initialize: (ns: ForceNode[]) => {
      nodes = ns;
    },
  });
}

/** Graphs at or under this node count label every node from fit zoom. */
export const HUB_SMALL_GRAPH = 30;
/** A hub is top-decile by degree, but never below this floor. */
export const HUB_DEGREE_FLOOR = 3;

/**
 * Degree at/above which a node counts as a hub for label tiering.
 * Small graphs return 0 — every node is a "hub", so every node is
 * labelled from fit zoom.
 */
export function hubDegreeThreshold(degrees: number[]): number {
  if (degrees.length <= HUB_SMALL_GRAPH) return 0;
  const sorted = [...degrees].sort((a, b) => b - a);
  const decile = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  return Math.max(decile, HUB_DEGREE_FLOOR);
}

/** Hermite smoothstep — 0 below e0, 1 above e1, smooth in between. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

// Zoom ramps for the two label tiers, in FIT-RELATIVE zoom (zoomRel =
// globalScale / the scale zoomToFit chose). Absolute-scale ramps can't
// work across graph sizes: a 90-node layout fits at scale ~2 (an absolute
// ramp would label everything at fit → label wall), a 500-node layout
// fits at ~0.5 (an absolute ramp would label nothing until deep zoom).
// Relative to fit: hubs are fully on AT fit, everyone fades in by ~2×
// past fit (reading distance), regardless of graph size or canvas size.
const HUB_LABEL_RAMP: readonly [number, number] = [0.55, 0.95];
const ALL_LABEL_RAMP: readonly [number, number] = [1.4, 2.1];

/**
 * Target label opacity for a node at the current fit-relative zoom. The
 * caller multiplies this by the node's dim alpha so labels of dimmed
 * nodes dim with their disc.
 */
export function labelAlpha(opts: {
  /** Current zoom divided by the fit zoom (1 = the framed overview). */
  zoomRel: number;
  degree: number;
  hubThreshold: number;
  emphasized: boolean;
}): number {
  if (opts.emphasized) return 1;
  const all = smoothstep(ALL_LABEL_RAMP[0], ALL_LABEL_RAMP[1], opts.zoomRel);
  if (opts.degree >= opts.hubThreshold) {
    return Math.max(all, smoothstep(HUB_LABEL_RAMP[0], HUB_LABEL_RAMP[1], opts.zoomRel));
  }
  return all;
}

// Cluster (group) headings are the INVERSE of the per-node label tier:
// fully on at the framed overview, fading out as the user zooms in. The
// ramp ends at 1.8 — just before the per-node ALL_LABEL_RAMP (1.4–2.1)
// fills individual labels in — so a heading never competes with the node
// labels underneath it. Zoom out → topic map; zoom in → individual nodes.
const CLUSTER_LABEL_FADE: readonly [number, number] = [1.0, 1.8];

/**
 * Opacity of the cluster (group) headings at the current fit-relative
 * zoom: 1 at the framed overview, easing to 0 as the user zooms in to
 * read individual nodes (the inverse of `labelAlpha`).
 */
export function clusterLabelAlpha(zoomRel: number): number {
  return 1 - smoothstep(CLUSTER_LABEL_FADE[0], CLUSTER_LABEL_FADE[1], zoomRel);
}

/** On-screen label font size in CSS px (divide by globalScale to draw). */
export const LABEL_FONT_PX = 11;
export const LABEL_FONT_PX_EMPHASIZED = 12.5;
const LABEL_MAX_CHARS = 28;

/** On-screen cluster-heading font size in CSS px — larger than the node
 *  label so the group topic reads as a banner over the blob. */
export const CLUSTER_LABEL_FONT_PX = 15;
/** Hard cap for a derived group heading (a hub's name can run long). */
export const CLUSTER_LABEL_MAX_CHARS = 22;

/** Hard-truncate long display names so one entity can't paint a banner. */
export function truncateLabel(name: string, max: number = LABEL_MAX_CHARS): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

/** Per-frame easing rate for dim transitions (fraction of remaining gap). */
const ALPHA_EASE_RATE = 0.25;
/** Snap-to-target threshold — below this the transition is "done". */
export const ALPHA_EASE_EPSILON = 0.02;

/**
 * One easing step of `current` toward `target`. Snaps when within
 * epsilon so transitions terminate instead of asymptoting forever.
 */
export function stepToward(
  current: number,
  target: number,
  rate: number = ALPHA_EASE_RATE,
): number {
  const next = current + (target - current) * rate;
  return Math.abs(target - next) < ALPHA_EASE_EPSILON ? target : next;
}

export type NodePosition = { x: number; y: number; vx?: number; vy?: number };

/**
 * Warm-start a new snapshot's nodes from the previous layout:
 *   - a node that already existed keeps its position (velocity zeroed so
 *     the reheat settles fast instead of slingshotting);
 *   - a NEW node with positioned neighbours spawns at their centroid
 *     (plus a small deterministic offset so siblings don't stack);
 *   - a new node with no positioned neighbours is left unplaced — the
 *     engine's default placement handles it.
 *
 * Mutates and returns the passed nodes (they're this snapshot's fresh
 * copies — see the graphData memo in graph-view.tsx).
 */
export function mergePositions<T extends { id: string; x?: number; y?: number; vx?: number; vy?: number }>(
  nodes: T[],
  edges: Array<{ source: string; target: string }>,
  prev: Map<string, NodePosition>,
): T[] {
  const placedNew: T[] = [];
  for (const node of nodes) {
    const p = prev.get(node.id);
    if (p) {
      node.x = p.x;
      node.y = p.y;
      node.vx = 0;
      node.vy = 0;
    } else {
      placedNew.push(node);
    }
  }
  if (placedNew.length === 0 || prev.size === 0) return nodes;

  const neighborsOf = new Map<string, NodePosition[]>();
  for (const e of edges) {
    const s = prev.get(e.source);
    const t = prev.get(e.target);
    if (t) {
      const list = neighborsOf.get(e.source) ?? [];
      list.push(t);
      neighborsOf.set(e.source, list);
    }
    if (s) {
      const list = neighborsOf.get(e.target) ?? [];
      list.push(s);
      neighborsOf.set(e.target, list);
    }
  }
  placedNew.forEach((node, i) => {
    const anchors = neighborsOf.get(node.id);
    if (!anchors || anchors.length === 0) return;
    let cx = 0;
    let cy = 0;
    for (const a of anchors) {
      cx += a.x;
      cy += a.y;
    }
    cx /= anchors.length;
    cy /= anchors.length;
    // Deterministic ring offset so several new siblings of one hub don't
    // spawn coincident (the collide force would jiggle them randomly).
    const angle = (i * 2.399963) % (2 * Math.PI); // golden angle
    node.x = cx + Math.cos(angle) * 12;
    node.y = cy + Math.sin(angle) * 12;
    node.vx = 0;
    node.vy = 0;
  });
  return nodes;
}

/**
 * Append a 2-hex-digit alpha channel to a `#RRGGBB` color. Theme tokens
 * resolve to 6-digit hex (see `readThemeColors`); anything else is
 * returned untouched rather than corrupted.
 */
export function withAlpha(hexColor: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hexColor)) return hexColor;
  const a = Math.round(Math.min(Math.max(alpha, 0), 1) * 255);
  return `${hexColor}${a.toString(16).padStart(2, "0")}`;
}

/** Parse `#RRGGBB` → [r, g, b], or null when not 6-digit hex. */
function parseHex(hex: string): [number, number, number] | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Channel-wise blend of two `#RRGGBB` colors — `t` 0 returns `a`,
 * 1 returns `b`. Either input failing the hex check returns `a`
 * untouched (same degrade contract as `withAlpha`).
 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = Math.min(Math.max(t, 0), 1);
  const to2 = (i: number) =>
    Math.round(ca[i] + (cb[i] - ca[i]) * k)
      .toString(16)
      .padStart(2, "0");
  return `#${to2(0)}${to2(1)}${to2(2)}`;
}

/**
 * Shade a hex color toward white (`t` > 0) or black (`t` < 0). The disc
 * orb-gradient highlight/rim shades derive from the node's theme token
 * through this, so the shading always agrees with the active palette
 * instead of being a second hard-coded ramp.
 */
export function shadeHex(hex: string, t: number): string {
  return t >= 0 ? mixHex(hex, "#ffffff", t) : mixHex(hex, "#000000", -t);
}

/**
 * Relative luminance (0 dark – 1 light, sRGB/WCAG coefficients) of a hex
 * color; 0.5 for non-hex. Enough to classify the active background as
 * dark so the backdrop layers (vignette depth, halo strength) can adapt
 * without a theme prop.
 */
export function hexLuma(hex: string): number {
  const c = parseHex(hex);
  if (!c) return 0.5;
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** Extra graph units past a community's farthest member disc. */
export const HALO_PADDING = 16;

export type CommunityHalo = {
  community: number;
  x: number;
  y: number;
  r: number;
};

/**
 * Per-community centroid + bounding radius from LIVE node positions —
 * feeds the soft "nebula" wash painted behind each cluster every frame.
 * Communities under `minSize` are skipped: they get no cluster gravity
 * (see `makeClusterForce`), so their members scatter and a halo drawn
 * over the scatter would read as a phantom group. Unpositioned nodes
 * (pre-settle spawns) are ignored.
 */
export function communityHalos(
  nodes: Array<{ id: string; x?: number; y?: number }>,
  communityOf: (id: string) => number | undefined,
  opts: { minSize?: number; padding?: number } = {},
): CommunityHalo[] {
  const minSize = opts.minSize ?? CLUSTER_MIN_SIZE;
  const padding = opts.padding ?? HALO_PADDING;
  const acc = new Map<number, { x: number; y: number; n: number }>();
  for (const node of nodes) {
    if (node.x == null || node.y == null) continue;
    const c = communityOf(node.id);
    if (c == null) continue;
    const slot = acc.get(c) ?? { x: 0, y: 0, n: 0 };
    slot.x += node.x;
    slot.y += node.y;
    slot.n += 1;
    acc.set(c, slot);
  }
  const byCommunity = new Map<number, CommunityHalo>();
  for (const [community, slot] of acc) {
    if (slot.n < minSize) continue;
    byCommunity.set(community, {
      community,
      x: slot.x / slot.n,
      y: slot.y / slot.n,
      r: 0,
    });
  }
  if (byCommunity.size === 0) return [];
  for (const node of nodes) {
    if (node.x == null || node.y == null) continue;
    const c = communityOf(node.id);
    if (c == null) continue;
    const h = byCommunity.get(c);
    if (!h) continue;
    const d = Math.hypot(node.x - h.x, node.y - h.y);
    if (d > h.r) h.r = d;
  }
  const halos = [...byCommunity.values()];
  for (const h of halos) h.r += NODE_RADIUS_MAX + padding;
  return halos;
}

/**
 * Derive a human heading for each community from its members: the name of
 * the most-connected member — the hub that anchors the cluster's topic
 * (in practice "Memory system", "Context engine", …). Ties on degree
 * break toward the alphabetically-smaller name, so the label is
 * deterministic regardless of node order, matching the rest of this
 * module. Only communities at/over `minSize` get a heading — the same
 * gate as `communityHalos` and the cluster gravity, so a scattered
 * micro-community (no wash, no gravity) is never labelled as a "group".
 * Returns community index → heading. Membership-derived (no positions),
 * so the caller can memoise it instead of recomputing per frame.
 */
export function communityLabels(
  nodes: Array<{ id: string; name: string; degree: number }>,
  communityOf: (id: string) => number | undefined,
  opts: { minSize?: number } = {},
): Map<number, string> {
  const minSize = opts.minSize ?? CLUSTER_MIN_SIZE;
  const best = new Map<number, { name: string; degree: number }>();
  const sizes = new Map<number, number>();
  for (const node of nodes) {
    const c = communityOf(node.id);
    if (c == null) continue;
    sizes.set(c, (sizes.get(c) ?? 0) + 1);
    const cur = best.get(c);
    if (
      !cur ||
      node.degree > cur.degree ||
      (node.degree === cur.degree && node.name < cur.name)
    ) {
      best.set(c, { name: node.name, degree: node.degree });
    }
  }
  const out = new Map<number, string>();
  for (const [c, b] of best) {
    if ((sizes.get(c) ?? 0) >= minSize) out.set(c, b.name);
  }
  return out;
}

/** Target on-screen dot pitch for the backdrop grid, CSS px. */
export const GRID_TARGET_PX = 28;

/**
 * Backdrop dot-grid step in graph units for the current zoom — the power
 * of two whose on-screen pitch lands closest to `targetPx`. Powers of two
 * make zooming RE-TILE the grid at discrete levels (map-tile behaviour)
 * while pan keeps it world-locked, instead of the pitch sliding
 * continuously with the zoom.
 */
export function gridStep(
  scale: number,
  targetPx: number = GRID_TARGET_PX,
): number {
  const raw = targetPx / Math.max(scale, 1e-9);
  return 2 ** Math.round(Math.log2(raw));
}

/**
 * Deterministic per-node animation phase in [0, 2π) from the node id —
 * offsets the ambient luminance "twinkle" so the field shimmers
 * organically instead of breathing in lockstep. Pure string hash (djb2
 * over the id), no randomness, so a node keeps its phase across frames
 * and refreshes.
 */
export function nodePhase(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return (((h % 360) + 360) % 360) * (Math.PI / 180);
}

/** Hover pulse-ring period. */
export const PULSE_PERIOD_MS = 1400;

/**
 * Phase (0 → 1, wrapping each period) of the hover pulse ring at time
 * `tMs`. The renderer grows the ring radius with the phase and fades its
 * alpha with (1 - phase); pure so the animation timing is testable
 * without a canvas.
 */
export function pulsePhase(
  tMs: number,
  periodMs: number = PULSE_PERIOD_MS,
): number {
  const t = tMs % periodMs;
  return (t < 0 ? t + periodMs : t) / periodMs;
}
