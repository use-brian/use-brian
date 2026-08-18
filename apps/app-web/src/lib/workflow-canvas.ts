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
 * The splice-OUT half shared by `insertStepIntoEdge` (which reinserts the
 * step elsewhere) and `removeStep` (which drops it): detach `stepId` from its
 * wiring without touching the step itself.
 *
 * Every predecessor — fan-out entry, branch arm, implicit fall-through,
 * trigger-fan-out entry; all made explicit — is bypassed to the step's own
 * successors, so a `A → step → C` path collapses to `A → C`. Making
 * fall-throughs explicit is what keeps the result stable when the caller then
 * changes the steps array (removal shifts every later index, and an implicit
 * edge is index-derived).
 *
 * The returned `starts` may be EMPTY (the step was the sole entry and has no
 * successors); each caller applies its own fallback, because they differ —
 * `insertStepIntoEdge` gives the seat back to the step it is about to rewire,
 * `removeStep` cannot and hands it to the first survivor.
 */
function bypassStep(
  def: WorkflowDefinition,
  stepId: string,
): { steps: WorkflowStep[]; starts: string[]; successors: string[] } | null {
  const target = def.steps.find((s) => s.id === stepId);
  if (!target) return null;

  const orderedIds = def.steps.map((s) => s.id);
  const known = new Set(orderedIds);
  const successors = staticSuccessors(target, orderedIds).filter(
    (id) => known.has(id) && id !== stepId,
  );

  const steps = def.steps.map((step): WorkflowStep => {
    // The detached step is left exactly as it was — the caller owns it.
    if (step.id === stepId) return step;
    if (step.type === "branch") {
      let next = step;
      if (next.nextStepIdIfTrue === stepId) {
        next = { ...next, nextStepIdIfTrue: successors[0] ?? null };
      }
      if (next.nextStepIdIfFalse === stepId) {
        next = { ...next, nextStepIdIfFalse: successors[0] ?? null };
      }
      return next;
    }
    const effective = staticSuccessors(step, orderedIds);
    if (!effective.includes(stepId)) return step;
    const bypassed: string[] = [];
    for (const id of effective) {
      for (const r of id === stepId ? successors : [id]) {
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

  // The start seat passes to the step's successors.
  let starts = startIds(def);
  if (starts.includes(stepId)) {
    const replaced: string[] = [];
    for (const id of starts) {
      for (const r of id === stepId ? successors : [id]) {
        if (!replaced.includes(r)) replaced.push(r);
      }
    }
    starts = replaced;
  }

  return { steps, starts, successors };
}

/** Every fan-out (and the start set) must stay within the schema's width cap. */
function withinFanOutCap(steps: WorkflowStep[], starts: string[]): boolean {
  if (starts.length > MAX_FAN_OUT_WIDTH) return false;
  for (const step of steps) {
    if (step.type === "branch") continue;
    if (
      Array.isArray(step.nextStepId) &&
      step.nextStepId.length > MAX_FAN_OUT_WIDTH
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Drop a step onto an existing edge: splice it OUT of its current wiring
 * (`bypassStep`) — then IN between the edge's endpoints (`from → step → to`;
 * a trigger edge swaps its entry of the start set). Branch steps are refused
 * (no unambiguous arm for the edge's old target), edges adjacent to the step
 * are no-ops, and a bypass that would widen a predecessor past
 * MAX_FAN_OUT_WIDTH refuses whole. No cycle can result: the step is fully
 * detached before reinsertion, so the new edges only ride the pre-existing
 * `from → to` path.
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

  const detached = bypassStep(def, stepId);
  if (!detached) return { ok: false, reason: "adjacent" };

  const orderedIds = def.steps.map((s) => s.id);
  // Point the detached step at the drop edge's target.
  let steps = detached.steps.map((step): WorkflowStep =>
    step.id === stepId && step.type !== "branch"
      ? { ...step, nextStepId: edge.to }
      : step,
  );
  // A sole entry step with no successors keeps its seat — it is about to be
  // rewired back into the graph, not removed.
  let nextStarts =
    detached.starts.length === 0 ? [stepId] : detached.starts;

  // Splice the step in on the drop edge.
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

  if (!withinFanOutCap(steps, nextStarts)) {
    return { ok: false, reason: "width" };
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

export type RemoveStepResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; reason: "last" | "width" };

/**
 * Remove a step and HEAL the graph around it. Every predecessor is bridged to
 * the step's own successors (`bypassStep`, shared with the drop-on-wire
 * rearrange), so `A → step → C` becomes `A → C`.
 *
 * Healing is not a nicety — it is what keeps the definition saveable. Core's
 * schema hard-rejects any reference to a step that no longer exists
 * (`nextStepId`, branch arms, `startStepId`, `layout` keys, `page.fromStep`,
 * `deliver.thread.fromStep`), and the board cannot show the user a stale
 * pointer to repair by hand: `canvasEdges` skips edges whose target is
 * unknown, so an unhealed removal renders as a clean flow that fails Save
 * naming a step nobody can see. See docs/architecture/features/workflow.md
 * → "Web builder UI" → step removal.
 *
 * Refuses `"last"` for the only step (a workflow always keeps one) and
 * `"width"` when a bridge would push a predecessor's fan-out — or the start
 * set — past MAX_FAN_OUT_WIDTH. Refusing is honest; silently dropping the
 * overflow edges would lose wiring the user authored.
 *
 * Bridging can never create a cycle: a new `A → C` edge replaces an
 * `A → step → C` path that already existed.
 */
export function removeStep(
  def: WorkflowDefinition,
  stepId: string,
): RemoveStepResult {
  if (def.steps.length <= 1) return { ok: false, reason: "last" };
  const detached = bypassStep(def, stepId);
  if (!detached) return { ok: false, reason: "last" };

  const steps = detached.steps
    .filter((s) => s.id !== stepId)
    .map((step) => clearStepReferencesTo(step, stepId));

  // The removed step cannot keep a start seat, so an emptied start set falls
  // back to the first survivor rather than to the step itself.
  const starts =
    detached.starts.length === 0 ? [steps[0].id] : detached.starts;

  if (!withinFanOutCap(steps, starts)) return { ok: false, reason: "width" };

  return {
    ok: true,
    definition: pruneLayout({
      ...def,
      steps,
      startStepId: starts.length === 1 ? starts[0] : starts,
    }),
  };
}

/**
 * Drop the non-wiring step-id references a removed step leaves behind. These
 * are separate from `nextStepId` and each one is schema-fatal on its own:
 * `page.fromStep` (edit the page an earlier step created) and
 * `deliver.thread.fromStep` (reply under an earlier step's message).
 *
 * `thread` is read defensively: the app-web `deliver` type does not declare
 * it (the builder cannot author a thread reply), but a workflow authored in
 * chat can carry one and this editor round-trips the field, so the reference
 * is reachable here even though the type says otherwise.
 */
function clearStepReferencesTo(step: WorkflowStep, removedId: string): WorkflowStep {
  if (step.type !== "assistant_call") return step;
  let next = step;
  if (next.page && "fromStep" in next.page && next.page.fromStep === removedId) {
    const { page: _dropped, ...rest } = next;
    next = rest;
  }
  const deliver = next.deliver as
    | { thread?: { fromStep?: string } }
    | undefined;
  if (deliver?.thread?.fromStep === removedId) {
    const { thread: _dropped, ...restDeliver } = deliver;
    next = { ...next, deliver: restDeliver as typeof next.deliver };
  }
  return next;
}

// ── Join legibility ─────────────────────────────────────────────────────

/**
 * Inbound wire count per step (trigger wires included). A step with ≥ 2 is
 * a fan-in — the implicit join: it runs once, after every inbound path that
 * can still reach it settles. The board chips these "Joins N paths".
 */
export function joinFanIn(def: WorkflowDefinition): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of canvasEdges(def)) {
    counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1);
  }
  return counts;
}

/**
 * Join steps a live run has parked: the step has not started (no step-run
 * row → absent from `stepStates`), at least one inbound path has settled
 * (a trigger wire settles the moment the run starts; a step settles on
 * `completed`), and at least one other inbound source is still pending.
 * Rendered as the "Waiting for other paths to finish" badge — the live
 * demonstration of the wait-for-all rule. Call only while a run is active.
 */
export function parkedJoinStepIds(
  def: WorkflowDefinition,
  stepStates: Record<string, string | undefined>,
): Set<string> {
  const inbound = new Map<string, CanvasEdge[]>();
  for (const edge of canvasEdges(def)) {
    const bucket = inbound.get(edge.to);
    if (bucket) bucket.push(edge);
    else inbound.set(edge.to, [edge]);
  }
  const out = new Set<string>();
  for (const [stepId, edges] of inbound) {
    if (edges.length < 2) continue;
    if (stepStates[stepId] !== undefined) continue;
    let settled = 0;
    let pending = 0;
    for (const edge of edges) {
      if (edge.from === TRIGGER_KEY) {
        settled++;
        continue;
      }
      const state = stepStates[edge.from];
      if (state === "completed") settled++;
      else if (state === "failed" || state === "skipped") continue;
      else pending++;
    }
    if (settled >= 1 && pending >= 1) out.add(stepId);
  }
  return out;
}

/**
 * Trigger wires that change nothing: their entry step is also reachable
 * from another entry step, so the join rule always defers it and execution
 * is identical without the wire. Drawn with the dead-wire treatment; stays
 * selectable and removable.
 */
export function redundantTriggerEdgeKeys(def: WorkflowDefinition): Set<string> {
  const known = new Set(def.steps.map((s) => s.id));
  const starts = startIds(def).filter((id) => known.has(id));
  const out = new Set<string>();
  if (starts.length < 2) return out;
  for (const entry of starts) {
    const covered = starts.some(
      (other) => other !== entry && reaches(def, other, entry),
    );
    if (covered) out.add(`trigger->${entry}`);
  }
  return out;
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
