/**
 * Workflow definition graph helpers — the shared static-analysis substrate
 * behind parallel fan-out (array `nextStepId`).
 *
 * Three consumers, one edge model:
 *  - `schemas.ts` superRefine — DAG enforcement (cycle rejection) and the
 *    wait-inside-parallel authoring error.
 *  - the executor's frontier scheduler — `buildReachability` powers the
 *    implicit-join rule ("a step runs once no other active cursor can still
 *    reach it").
 *  - the API-side authoring preflight — ask-policy `tool_call` steps inside a
 *    parallel region can never pause legally, so authoring rejects them.
 *
 * The edge model mirrors `nextStepIdFor` in `executor.ts` exactly: branch
 * steps contribute both arms, an explicit `nextStepId` wins (scalar or
 * fan-out array), and an absent `nextStepId` falls through to the next step
 * in `definition.steps[]` order. Unknown-step references are dropped here —
 * the schema's reference checks report them separately.
 *
 * See docs/architecture/features/workflow.md → "Parallel fan-out".
 *
 * [COMP:workflow/graph]
 */

import type { WorkflowDefinition, WorkflowStep } from './types.js'

/**
 * The definition's entry steps, normalized: scalar `startStepId` yields one
 * id, an array (trigger fan-out) yields all of them in order. Every consumer
 * of "where does a run enter" goes through this so the two shapes can never
 * diverge.
 */
export function startStepIds(def: WorkflowDefinition): string[] {
  return Array.isArray(def.startStepId) ? [...def.startStepId] : [def.startStepId]
}

/**
 * Static out-edges of one step, resolved exactly as the executor would.
 * Branch steps return both arms (either may fire); a fan-out array returns
 * every target. `null` entries (explicit terminal) contribute nothing.
 */
export function stepSuccessors(
  step: WorkflowStep,
  orderedIds: string[],
): string[] {
  if (step.type === 'branch') {
    const out: string[] = []
    if (step.nextStepIdIfTrue) out.push(step.nextStepIdIfTrue)
    if (step.nextStepIdIfFalse) out.push(step.nextStepIdIfFalse)
    return out
  }
  if (step.nextStepId !== undefined) {
    if (step.nextStepId === null) return []
    return Array.isArray(step.nextStepId) ? [...step.nextStepId] : [step.nextStepId]
  }
  // Sequential fall-through.
  const idx = orderedIds.indexOf(step.id)
  if (idx === -1 || idx === orderedIds.length - 1) return []
  return [orderedIds[idx + 1]]
}

/**
 * Adjacency map over every step in the definition (unreachable steps
 * included — a cycle among them is still an authoring error). References to
 * unknown step ids are dropped; the schema's reference checks own that
 * failure mode.
 */
export function buildSuccessorMap(def: WorkflowDefinition): Map<string, string[]> {
  const orderedIds = def.steps.map((s) => s.id)
  const known = new Set(orderedIds)
  const map = new Map<string, string[]>()
  for (const step of def.steps) {
    map.set(
      step.id,
      stepSuccessors(step, orderedIds).filter((id) => known.has(id)),
    )
  }
  return map
}

/**
 * Detect a cycle anywhere in the definition graph. Returns one witness cycle
 * as a step-id path (`[a, b, c, a]`) or null when the graph is a DAG.
 * Iterative three-color DFS — no recursion, safe at the 50-step cap.
 */
export function findCycle(def: WorkflowDefinition): string[] | null {
  const adj = buildSuccessorMap(def)
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  const parent = new Map<string, string>()
  for (const id of adj.keys()) color.set(id, WHITE)

  for (const root of adj.keys()) {
    if (color.get(root) !== WHITE) continue
    const stack: Array<{ id: string; nextIdx: number }> = [{ id: root, nextIdx: 0 }]
    color.set(root, GRAY)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const succs = adj.get(frame.id) ?? []
      if (frame.nextIdx < succs.length) {
        const next = succs[frame.nextIdx++]
        const c = color.get(next)
        if (c === GRAY) {
          // Found a back edge — reconstruct the cycle frame.id → ... → next.
          const cycle = [next]
          let cur = frame.id
          while (cur !== next) {
            cycle.push(cur)
            cur = parent.get(cur)!
          }
          cycle.push(next)
          return cycle.reverse()
        }
        if (c === WHITE) {
          color.set(next, GRAY)
          parent.set(next, frame.id)
          stack.push({ id: next, nextIdx: 0 })
        }
      } else {
        color.set(frame.id, BLACK)
        stack.pop()
      }
    }
  }
  return null
}

/**
 * Full static reachability: for every step id, the set of step ids reachable
 * from it INCLUDING itself. O(V·E) BFS per node — trivial at the 50-step cap.
 * The executor's implicit-join rule queries this per settlement.
 */
export function buildReachability(def: WorkflowDefinition): Map<string, Set<string>> {
  const adj = buildSuccessorMap(def)
  const out = new Map<string, Set<string>>()
  for (const id of adj.keys()) {
    const seen = new Set<string>([id])
    const queue = [id]
    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    out.set(id, seen)
  }
  return out
}

/**
 * The step ids that can run CONCURRENTLY with a sibling path — i.e. steps in
 * a parallel region that some fan-out sibling never converges back onto.
 *
 * A step S is a member iff some fan-out step F has two distinct out-edges
 * i ≠ j with S reachable from edge i but NOT from edge j: while S runs, a
 * cursor may still be live on the j side, so S can never legally pause the
 * run (`wait`, ask-policy approval). A step reachable from EVERY edge of the
 * fan-out sits at-or-after the implicit join and is safe again.
 *
 * Static approximation (a branch inside an arm can route around the
 * convergence at run time); the executor's pause-while-parallel guard stays
 * authoritative. Two fan-out sources exist: steps with `nextStepId` arrays
 * of length ≥ 2, and a trigger fan-out (`startStepId` array of length ≥ 2 —
 * the trigger is one more fan-out node). Branch steps route down ONE arm
 * and never parallelize.
 */
export function parallelRegionSteps(def: WorkflowDefinition): Set<string> {
  const reach = buildReachability(def)
  const unsafe = new Set<string>()
  const markDiverging = (edges: string[]) => {
    const edgeReach = edges.map((id) => reach.get(id) ?? new Set<string>([id]))
    for (let i = 0; i < edgeReach.length; i++) {
      for (const candidate of edgeReach[i]) {
        for (let j = 0; j < edgeReach.length; j++) {
          if (j !== i && !edgeReach[j].has(candidate)) {
            unsafe.add(candidate)
            break
          }
        }
      }
    }
  }
  const starts = startStepIds(def)
  if (starts.length >= 2) markDiverging(starts)
  for (const step of def.steps) {
    if (step.type === 'branch') continue
    if (!Array.isArray(step.nextStepId) || step.nextStepId.length < 2) continue
    markDiverging(step.nextStepId)
  }
  return unsafe
}
