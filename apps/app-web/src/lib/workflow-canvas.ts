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
 * port). The trigger node's single edge IS `startStepId`.
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
  if (known.has(def.startStepId)) {
    edges.push({
      key: `trigger->${def.startStepId}`,
      from: TRIGGER_KEY,
      to: def.startStepId,
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

// ── Connect / disconnect ────────────────────────────────────────────────

type ConnectRefusal = "self" | "cycle" | "duplicate" | "width";

export type ConnectResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; reason: ConnectRefusal };

/**
 * Wire `from`'s port to `toId`. Trigger port re-targets `startStepId`;
 * branch ports replace their arm (scalar by schema); a normal step's port
 * ADDS a target — an existing target (explicit or fall-through) stays and
 * the result becomes a parallel fan-out array. Refuses self-edges, dupes,
 * fan-out past MAX_FAN_OUT_WIDTH, and any edge that would close a cycle.
 */
export function connectEdge(
  def: WorkflowDefinition,
  from: PortRef,
  toId: string,
): ConnectResult {
  if (from.kind === "trigger") {
    if (def.startStepId === toId) return { ok: false, reason: "duplicate" };
    return { ok: true, definition: { ...def, startStepId: toId } };
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
 * Remove one edge. The trigger edge is not removable (a workflow always has
 * a start step — re-target it by wiring the trigger port elsewhere).
 * Removing a fall-through edge pins an explicit `nextStepId: null`;
 * removing a fan-out entry narrows the array (1 left → scalar, 0 → null);
 * removing a branch arm nulls that arm.
 */
export function removeEdge(
  def: WorkflowDefinition,
  edge: CanvasEdge,
): WorkflowDefinition {
  if (edge.source === "trigger") return def;
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
  if (stepById.has(def.startStepId)) colMap.set(def.startStepId, 0);
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
