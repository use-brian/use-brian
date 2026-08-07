/**
 * Pure wiring + layout logic for the drag-to-wire workflow canvas
 * (`workflow-board.tsx` renders it; this module owns the graph edits so
 * they stay unit-testable without a DOM).
 *
 * The edge model mirrors the executor exactly (core `workflow/graph.ts`):
 * branch steps expose two ports (true / false, scalar targets); every other
 * step exposes one output port whose `nextStepId` may be a scalar (sequence),
 * an ARRAY (parallel fan-out, joined implicitly downstream), `null`
 * (terminal), or absent (implicit sequential fall-through — rendered as a
 * real edge, made explicit the moment the user rewires anything on that
 * port). The trigger node's edges ARE `startStepId` — scalar, or an array
 * (trigger fan-out: one edge per entry step, all started in parallel).
 *
 * Spec: docs/architecture/features/workflow.md → "Web builder UI".
 * [COMP:app-web/workflow-canvas]
 */

import type {
  WorkflowDefinition,
  WorkflowNodePosition,
  WorkflowStep,
} from "@/lib/api/workflow";

/** Mirrors core `MAX_FAN_OUT_WIDTH` (schemas.ts) — schema-enforced on save. */
export const MAX_FAN_OUT_WIDTH = 5;

/** Reserved layout key for the trigger node. */
export const TRIGGER_KEY = "__trigger";

// ── Node geometry (shared with the board renderer) ──────────────────────

export const NODE_W = 210;
export const NODE_H = 84;
const GAP_X = 80;
const GAP_Y = 32;
export const PAD = 40;

// ── Edges ───────────────────────────────────────────────────────────────

export type EdgeTone = "default" | "true" | "false";

/** One rendered/editable edge on the canvas. */
export type CanvasEdge = {
  /** Stable identity for selection. */
  key: string;
  /** Source node key — a step id or TRIGGER_KEY. */
  from: string;
  to: string;
  tone: EdgeTone;
  /**
   * Where this edge lives in the definition: `trigger` = startStepId;
   * `next` = an explicit scalar/array nextStepId entry; `fallthrough` = the
   * implicit sequential edge (nextStepId absent); `true`/`false` = a branch
   * arm.
   */
  source: "trigger" | "next" | "fallthrough" | "true" | "false";
};

/** The port a wire-drag starts from. */
export type PortRef =
  | { kind: "trigger" }
  | { kind: "step"; stepId: string; port?: "true" | "false" };

/** Entry-step ids, normalized (mirrors core `startStepIds` in graph.ts). */
function startIds(def: WorkflowDefinition): string[] {
  return Array.isArray(def.startStepId) ? def.startStepId : [def.startStepId];
}

function explicitTargets(step: WorkflowStep): string[] | null {
  if (step.type === "branch") return null;
  if (step.nextStepId === undefined || step.nextStepId === null) return null;
  return Array.isArray(step.nextStepId) ? step.nextStepId : [step.nextStepId];
}

/** Every edge of the definition, in render order. */
export function canvasEdges(def: WorkflowDefinition): CanvasEdge[] {
  const known = new Set(def.steps.map((s) => s.id));
  const orderedIds = def.steps.map((s) => s.id);
  const edges: CanvasEdge[] = [];
  for (const start of startIds(def)) {
    if (!known.has(start)) continue;
    edges.push({
      key: `trigger->${start}`,
      from: TRIGGER_KEY,
      to: start,
      tone: "default",
      source: "trigger",
    });
  }
  for (const step of def.steps) {
    if (step.type === "branch") {
      if (step.nextStepIdIfTrue && known.has(step.nextStepIdIfTrue)) {
        edges.push({
          key: `${step.id}:true->${step.nextStepIdIfTrue}`,
          from: step.id,
          to: step.nextStepIdIfTrue,
          tone: "true",
          source: "true",
        });
      }
      if (step.nextStepIdIfFalse && known.has(step.nextStepIdIfFalse)) {
        edges.push({
          key: `${step.id}:false->${step.nextStepIdIfFalse}`,
          from: step.id,
          to: step.nextStepIdIfFalse,
          tone: "false",
          source: "false",
        });
      }
      continue;
    }
    const explicit = explicitTargets(step);
    if (explicit) {
      for (const to of explicit) {
        if (!known.has(to)) continue;
        edges.push({
          key: `${step.id}->${to}`,
          from: step.id,
          to,
          tone: "default",
          source: "next",
        });
      }
      continue;
    }
    if (step.nextStepId === null) continue;
    // Implicit sequential fall-through.
    const idx = orderedIds.indexOf(step.id);
    const to = idx >= 0 ? orderedIds[idx + 1] : undefined;
    if (to && known.has(to)) {
      edges.push({
        key: `${step.id}->${to}`,
        from: step.id,
        to,
        tone: "default",
        source: "fallthrough",
      });
    }
  }
  return edges;
}

// ── Reachability (cycle guard) ──────────────────────────────────────────

/** Static successor ids of one step (branch = both arms; mirrors core). */
function staticSuccessors(step: WorkflowStep, orderedIds: string[]): string[] {
  if (step.type === "branch") {
    return [step.nextStepIdIfTrue, step.nextStepIdIfFalse].filter(
      (v): v is string => !!v,
    );
  }
  const explicit = explicitTargets(step);
  if (explicit) return explicit;
  if (step.nextStepId === null) return [];
  const idx = orderedIds.indexOf(step.id);
  return idx >= 0 && idx < orderedIds.length - 1 ? [orderedIds[idx + 1]] : [];
}

/** Is `target` reachable from `fromId` (inclusive of fromId itself)? */
function reaches(
  def: WorkflowDefinition,
  fromId: string,
  target: string,
): boolean {
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const orderedIds = def.steps.map((s) => s.id);
  const seen = new Set<string>([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === target) return true;
    const step = byId.get(cur);
    if (!step) continue;
    for (const next of staticSuccessors(step, orderedIds)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * Step ids no run can ever visit: not the start step and not reachable from
 * it (the trigger fires `startStepId`; the scheduler only walks successors,
 * so everything else is dead by construction — legal, but never executed).
 * The board dims these and badges them "Never runs".
 */
export function unreachableStepIds(def: WorkflowDefinition): Set<string> {
  const orderedIds = def.steps.map((s) => s.id);
  const known = new Set(orderedIds);
  const starts = startIds(def).filter((id) => known.has(id));
  if (starts.length === 0) return new Set(orderedIds);
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const seen = new Set<string>(starts);
  const queue = [...starts];
  while (queue.length > 0) {
    const step = byId.get(queue.shift()!);
    if (!step) continue;
    for (const next of staticSuccessors(step, orderedIds)) {
      if (known.has(next) && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return new Set(orderedIds.filter((id) => !seen.has(id)));
}

// ── Connect / disconnect ────────────────────────────────────────────────

type ConnectRefusal = "self" | "cycle" | "duplicate" | "width";

export type ConnectResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; reason: ConnectRefusal };

/**
 * Wire `from`'s port to `toId`. The trigger port ADDS an entry step — the
 * existing start(s) stay and `startStepId` becomes a trigger fan-out array;
 * branch ports replace their arm (scalar by schema); a normal step's port
 * ADDS a target — an existing target (explicit or fall-through) stays and
 * the result becomes a parallel fan-out array. Refuses self-edges, dupes,
 * fan-out past MAX_FAN_OUT_WIDTH (trigger included), and any edge that
 * would close a cycle (the trigger cannot — nothing points at it).
 */
export function connectEdge(
  def: WorkflowDefinition,
  from: PortRef,
  toId: string,
): ConnectResult {
  if (from.kind === "trigger") {
    const current = startIds(def);
    if (current.includes(toId)) return { ok: false, reason: "duplicate" };
    const next = [...current, toId];
    if (next.length > MAX_FAN_OUT_WIDTH) return { ok: false, reason: "width" };
    return {
      ok: true,
      definition: { ...def, startStepId: next.length === 1 ? next[0] : next },
    };
  }
  const { stepId, port } = from;
  if (stepId === toId) return { ok: false, reason: "self" };
  // A new edge stepId → toId closes a cycle iff stepId is reachable FROM toId.
  if (reaches(def, toId, stepId)) return { ok: false, reason: "cycle" };

  const orderedIds = def.steps.map((s) => s.id);
  const steps = def.steps.map((step): WorkflowStep => {
    if (step.id !== stepId) return step;
    if (step.type === "branch") {
      if (port === "false") {
        if (step.nextStepIdIfFalse === toId) return step;
        return { ...step, nextStepIdIfFalse: toId };
      }
      if (step.nextStepIdIfTrue === toId) return step;
      return { ...step, nextStepIdIfTrue: toId };
    }
    // Normalize the current targets (fall-through becomes explicit) and add.
    const current =
      explicitTargets(step) ??
      (step.nextStepId === null
        ? []
        : staticSuccessors(step, orderedIds));
    if (current.includes(toId)) return step;
    const next = [...current, toId];
    return {
      ...step,
      nextStepId: next.length === 1 ? next[0] : next,
    };
  });

  const target = steps.find((s) => s.id === stepId);
  if (target && target.type !== "branch") {
    const width = Array.isArray(target.nextStepId) ? target.nextStepId.length : 1;
    if (width > MAX_FAN_OUT_WIDTH) return { ok: false, reason: "width" };
    const before = def.steps.find((s) => s.id === stepId);
    if (before === target) return { ok: false, reason: "duplicate" };
  }
  if (target && target.type === "branch") {
    const before = def.steps.find((s) => s.id === stepId);
    if (before === target) return { ok: false, reason: "duplicate" };
  }
  return { ok: true, definition: { ...def, steps } };
}

/**
 * Remove one edge. A trigger edge is removable only while another remains
 * (narrowing the start array — a workflow always keeps at least one entry
 * step; re-target the last one by wiring the trigger port elsewhere).
 * Removing a fall-through edge pins an explicit `nextStepId: null`;
 * removing a fan-out entry narrows the array (1 left → scalar, 0 → null);
 * removing a branch arm nulls that arm.
 */
export function removeEdge(
  def: WorkflowDefinition,
  edge: CanvasEdge,
): WorkflowDefinition {
  if (edge.source === "trigger") {
    const next = startIds(def).filter((id) => id !== edge.to);
    if (next.length === 0) return def;
    return { ...def, startStepId: next.length === 1 ? next[0] : next };
  }
  const steps = def.steps.map((step): WorkflowStep => {
    if (step.id !== edge.from) return step;
    if (step.type === "branch") {
      if (edge.source === "true" && step.nextStepIdIfTrue === edge.to) {
        return { ...step, nextStepIdIfTrue: null };
      }
      if (edge.source === "false" && step.nextStepIdIfFalse === edge.to) {
        return { ...step, nextStepIdIfFalse: null };
      }
      return step;
    }
    if (edge.source === "fallthrough") {
      return { ...step, nextStepId: null };
    }
    const current = explicitTargets(step);
    if (!current) return step;
    const next = current.filter((id) => id !== edge.to);
    return {
      ...step,
      nextStepId: next.length === 0 ? null : next.length === 1 ? next[0] : next,
    };
  });
  return { ...def, steps };
}

// ── Edge geometry (shared by the board renderer + insertion hit test) ──

/** Source-port anchor for an edge (branch arms leave at 1/3 and 2/3 height). */
export function portAnchor(
  pos: WorkflowNodePosition,
  tone: EdgeTone,
  isBranch: boolean,
): { x: number; y: number } {
  const x = pos.x + NODE_W;
  if (!isBranch) return { x, y: pos.y + NODE_H / 2 };
  return { x, y: pos.y + (tone === "false" ? (NODE_H * 2) / 3 : NODE_H / 3) };
}

/** Horizontal control-point offset of the edge cubic (renderer + hit test). */
export function edgeCurveOffset(sx: number, tx: number): number {
  return Math.max(36, Math.abs(tx - sx) / 2);
}

// ── Drop-on-wire insertion (rearrange) ──────────────────────────────────

/** How close (px) the dragged node's center must come to a wire's curve. */
const INSERT_HIT_RADIUS = 40;

/**
 * The wire a node-drag at center (cx, cy) would insert into: the nearest
 * edge whose rendered cubic passes within INSERT_HIT_RADIUS. Edges adjacent
 * to the dragged node are never candidates; the trigger node and branch
 * steps cannot be edge-inserted (a branch has no unambiguous arm for the
 * wire's old target — its arms rewire by port).
 */
export function edgeInsertionCandidate(
  def: WorkflowDefinition,
  positions: Record<string, WorkflowNodePosition>,
  draggedKey: string,
  cx: number,
  cy: number,
): CanvasEdge | null {
  if (draggedKey === TRIGGER_KEY) return null;
  const dragged = def.steps.find((s) => s.id === draggedKey);
  if (!dragged || dragged.type === "branch") return null;
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  let best: CanvasEdge | null = null;
  let bestDist = INSERT_HIT_RADIUS;
  for (const edge of canvasEdges(def)) {
    if (edge.from === draggedKey || edge.to === draggedKey) continue;
    const src = positions[edge.from];
    const tgt = positions[edge.to];
    if (!src || !tgt) continue;
    const isBranch = byId.get(edge.from)?.type === "branch";
    const { x: sx, y: sy } = portAnchor(src, edge.tone, !!isBranch);
    const tx = tgt.x;
    const ty = tgt.y + NODE_H / 2;
    const curve = edgeCurveOffset(sx, tx);
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const u = 1 - t;
      const x =
        u * u * u * sx +
        3 * u * u * t * (sx + curve) +
        3 * u * t * t * (tx - curve) +
        t * t * t * tx;
      const y = u * u * u * sy + 3 * u * u * t * sy + 3 * u * t * t * ty + t * t * t * ty;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < bestDist) {
        bestDist = dist;
        best = edge;
      }
    }
  }
  return best;
}

export type InsertResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; reason: "adjacent" | "branch" | "width" };

/**
 * Drop a step onto an existing edge: splice it OUT of its current wiring —
 * every predecessor (fan-out entry, branch arm, implicit fall-through,
 * trigger-fan-out entry; all made explicit) is bypassed to the step's own
 * successors, a moved start step handing its seat to them — then IN between
 * the edge's endpoints (`from → step → to`; a trigger edge swaps its entry
 * of the start set). Branch steps are refused (no unambiguous arm for the edge's
 * old target), edges adjacent to the step are no-ops, and a bypass that
 * would widen a predecessor past MAX_FAN_OUT_WIDTH refuses whole. No cycle
 * can result: the step is fully detached before reinsertion, so the new
 * edges only ride the pre-existing `from → to` path.
 */
export function insertStepIntoEdge(
  def: WorkflowDefinition,
  stepId: string,
  edge: CanvasEdge,
): InsertResult {
  if (edge.from === stepId || edge.to === stepId) {
    return { ok: false, reason: "adjacent" };
  }
  const moving = def.steps.find((s) => s.id === stepId);
  if (!moving) return { ok: false, reason: "adjacent" };
  if (moving.type === "branch") return { ok: false, reason: "branch" };

  const orderedIds = def.steps.map((s) => s.id);
  const known = new Set(orderedIds);
  const succ = staticSuccessors(moving, orderedIds).filter(
    (id) => known.has(id) && id !== stepId,
  );

  // Splice out: bypass every edge into the moving step to its successors,
  // and point the moving step at the drop edge's target.
  let steps = def.steps.map((step): WorkflowStep => {
    if (step.id === stepId) {
      return step.type === "branch" ? step : { ...step, nextStepId: edge.to };
    }
    if (step.type === "branch") {
      let next = step;
      if (next.nextStepIdIfTrue === stepId) {
        next = { ...next, nextStepIdIfTrue: succ[0] ?? null };
      }
      if (next.nextStepIdIfFalse === stepId) {
        next = { ...next, nextStepIdIfFalse: succ[0] ?? null };
      }
      return next;
    }
    const effective = staticSuccessors(step, orderedIds);
    if (!effective.includes(stepId)) return step;
    const bypassed: string[] = [];
    for (const id of effective) {
      for (const r of id === stepId ? succ : [id]) {
        if (r !== step.id && !bypassed.includes(r)) bypassed.push(r);
      }
    }
    return {
      ...step,
      nextStepId:
        bypassed.length === 0
          ? null
          : bypassed.length === 1
            ? bypassed[0]
            : bypassed,
    };
  });

  // Splice the moving step out of the start set (its seat passes to its
  // successors), keeping at least one entry step.
  let nextStarts = startIds(def);
  if (nextStarts.includes(stepId)) {
    const replaced: string[] = [];
    for (const id of nextStarts) {
      for (const r of id === stepId ? succ : [id]) {
        if (!replaced.includes(r)) replaced.push(r);
      }
    }
    nextStarts = replaced.length === 0 ? [stepId] : replaced;
  }

  // Splice in on the drop edge.
  if (edge.source === "trigger") {
    // Replace that trigger edge's entry; other entry steps keep their seat.
    const replaced = nextStarts.map((id) => (id === edge.to ? stepId : id));
    nextStarts = replaced.includes(stepId) ? replaced : [...replaced, stepId];
  } else {
    steps = steps.map((step): WorkflowStep => {
      if (step.id !== edge.from) return step;
      if (step.type === "branch") {
        if (edge.source === "false") return { ...step, nextStepIdIfFalse: stepId };
        return { ...step, nextStepIdIfTrue: stepId };
      }
      const effective = staticSuccessors(step, orderedIds);
      const replaced = effective.map((id) => (id === edge.to ? stepId : id));
      const targets = replaced.includes(stepId) ? replaced : [...replaced, stepId];
      const deduped = targets.filter((id, i) => targets.indexOf(id) === i);
      return {
        ...step,
        nextStepId: deduped.length === 1 ? deduped[0] : deduped,
      };
    });
  }

  if (nextStarts.length > MAX_FAN_OUT_WIDTH) return { ok: false, reason: "width" };
  for (const step of steps) {
    if (step.type === "branch") continue;
    if (
      Array.isArray(step.nextStepId) &&
      step.nextStepId.length > MAX_FAN_OUT_WIDTH
    ) {
      return { ok: false, reason: "width" };
    }
  }
  return {
    ok: true,
    definition: {
      ...def,
      steps,
      startStepId: nextStarts.length === 1 ? nextStarts[0] : nextStarts,
    },
  };
}

// ── Layout ──────────────────────────────────────────────────────────────

/**
 * Auto-layout every node (trigger at column 0, steps by longest path from
 * the start step), exactly the pre-drag board algorithm. Used to seed
 * positions for nodes with no `definition.layout` entry.
 */
export function autoLayoutPositions(
  def: WorkflowDefinition,
): Record<string, WorkflowNodePosition> {
  const steps = def.steps;
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const orderedIds = steps.map((s) => s.id);

  const colMap = new Map<string, number>();
  for (const start of startIds(def)) {
    if (stepById.has(start)) colMap.set(start, 0);
  }
  for (let pass = 0; pass <= steps.length; pass++) {
    let changed = false;
    for (const step of steps) {
      const c = colMap.get(step.id);
      if (c === undefined) continue;
      for (const to of staticSuccessors(step, orderedIds)) {
        if (!stepById.has(to)) continue;
        if ((colMap.get(to) ?? -1) < c + 1) {
          colMap.set(to, c + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  let maxReached = 0;
  for (const c of colMap.values()) maxReached = Math.max(maxReached, c);
  for (const s of steps) {
    if (!colMap.has(s.id)) colMap.set(s.id, maxReached + 1);
  }

  const byColumn = new Map<number, string[]>();
  for (const s of steps) {
    const c = colMap.get(s.id)!;
    const bucket = byColumn.get(c);
    if (bucket) bucket.push(s.id);
    else byColumn.set(c, [s.id]);
  }
  const rowMap = new Map<string, number>();
  for (const ids of byColumn.values()) {
    ids.forEach((id, row) => rowMap.set(id, row));
  }

  const colX = (col: number) => PAD + col * (NODE_W + GAP_X);
  const rowY = (row: number) => PAD + row * (NODE_H + GAP_Y);

  const out: Record<string, WorkflowNodePosition> = {
    [TRIGGER_KEY]: { x: colX(0), y: rowY(0) },
  };
  for (const s of steps) {
    out[s.id] = { x: colX(colMap.get(s.id)! + 1), y: rowY(rowMap.get(s.id)!) };
  }
  return out;
}

/**
 * Final node positions: persisted `definition.layout` entries win; every
 * node without one gets its auto-layout seat.
 */
export function resolvePositions(
  def: WorkflowDefinition,
): Record<string, WorkflowNodePosition> {
  const auto = autoLayoutPositions(def);
  const out = { ...auto };
  for (const [key, pos] of Object.entries(def.layout ?? {})) {
    if (key in auto) out[key] = pos;
  }
  return out;
}

/** Board extent for a resolved position map (content + padding). */
export function boardExtent(
  positions: Record<string, WorkflowNodePosition>,
): { width: number; height: number } {
  let maxX = 0;
  let maxY = 0;
  for (const pos of Object.values(positions)) {
    maxX = Math.max(maxX, pos.x + NODE_W);
    maxY = Math.max(maxY, pos.y + NODE_H);
  }
  return { width: maxX + PAD, height: maxY + PAD };
}

/**
 * Drop layout entries whose step no longer exists (schema rejects phantom
 * keys). Call after step removal/rename.
 */
export function pruneLayout(def: WorkflowDefinition): WorkflowDefinition {
  if (!def.layout) return def;
  const known = new Set(def.steps.map((s) => s.id));
  const pruned = Object.fromEntries(
    Object.entries(def.layout).filter(
      ([key]) => key === TRIGGER_KEY || known.has(key),
    ),
  );
  if (Object.keys(pruned).length === 0) {
    const { layout: _dropped, ...rest } = def;
    return rest;
  }
  return { ...def, layout: pruned };
}
