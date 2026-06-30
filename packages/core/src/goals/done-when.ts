/**
 * `done_when` — the goal-seeker's acceptance language.
 *
 * ONE engine-verifiable predicate language, not a list of forms (see
 * `docs/plans/task-goal-seeker.md` §4.10): two leaf kinds — `query`
 * (a predicate over brain/DB state) and `tool` (a read-only external
 * check) — plus the `subtasks` sugar leaf (all of the subject's
 * sub-tasks / sub-goals are closed), combined with `all` / `any` / `not`.
 * The `verify` leaf (§12) reads a verified-done marker the completion tool
 * stamps only after an adversarial verifier passed — the agentic-termination
 * path for a goal with no objective predicate.
 *
 * INVARIANT — the evaluator is never self-graded. It calls ONLY the injected
 * resolver ports (`subtasksClosed` / `query` / `tool` / `verifiedDone`), each a
 * deterministic read; there is no `assistant_call` on this path. For a `verify`
 * leaf the model judgment is made earlier and elsewhere — in the completion
 * tool, gated by the adversarial verifier (§12) — and the evaluator only reads
 * the resulting marker. A goal's "done" is never the model's bare opinion
 * in-loop.
 *
 * INVARIANT — a `tool` leaf is a read-only, idempotent check; a thrown or
 * failed read resolves to `false` ("not confirmed -> continue"), never
 * `true` and never a loop-killing error. A flaky connector can neither
 * falsely close a goal nor wedge it.
 *
 * [COMP:goals/acceptance-schema]
 * [COMP:goals/acceptance-evaluator]
 */
import { z } from 'zod'

/** A predicate over brain/DB state. The shape is opaque to the evaluator;
 *  the host-provided `query` resolver interprets `predicate`. */
export type DoneWhenQuery = { description?: string; predicate: Record<string, unknown> }

/** A read-only, idempotent external check (a connector/tool read). */
export type DoneWhenToolCheck = { tool: string; args?: Record<string, unknown>; description?: string }

export type DoneWhenLeaf =
  | { kind: 'subtasks' }
  | { kind: 'query'; query: DoneWhenQuery }
  | { kind: 'tool'; tool: DoneWhenToolCheck }
  /** Agentic termination (§12): met iff this goal's verified-done marker is
   *  stamped (the completion tool stamps it only after the adversarial verifier
   *  passed). No payload — the goal's outcome is the criterion. */
  | { kind: 'verify' }

export type DoneWhenNode =
  | DoneWhenLeaf
  | { all: DoneWhenNode[] }
  | { any: DoneWhenNode[] }
  | { not: DoneWhenNode }

// --- schema (boundary validation: stored JSON + tool input) -----------------

const leafSchema = z.union([
  z.object({ kind: z.literal('subtasks') }).strict(),
  z
    .object({
      kind: z.literal('query'),
      query: z
        .object({ description: z.string().optional(), predicate: z.record(z.unknown()) })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool'),
      tool: z
        .object({
          tool: z.string().min(1),
          args: z.record(z.unknown()).optional(),
          description: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('verify') }).strict(),
])

/** Recursive schema for a `done_when` predicate tree. `all` / `any` require
 *  at least one child so an empty combinator can't masquerade as "met". */
export const doneWhenSchema: z.ZodType<DoneWhenNode> = z.lazy(() =>
  z.union([
    leafSchema,
    z.object({ all: z.array(doneWhenSchema).min(1) }).strict(),
    z.object({ any: z.array(doneWhenSchema).min(1) }).strict(),
    z.object({ not: doneWhenSchema }).strict(),
  ]),
)

// --- evaluation -------------------------------------------------------------

export type DoneWhenResolvers = {
  /** True iff the subject (host Noun or self-hosted goal) has no open
   *  sub-tasks / sub-goals. Backs the `subtasks` sugar leaf. */
  subtasksClosed: () => Promise<boolean>
  /** Resolve a `query` leaf to a boolean. The host defines query semantics. */
  query: (q: DoneWhenQuery) => Promise<boolean>
  /** Resolve a `tool` leaf to a boolean. MUST be read-only + idempotent. A
   *  thrown read is caught by the evaluator and treated as `false`. */
  tool: (t: DoneWhenToolCheck) => Promise<boolean>
  /** True iff this goal's verified-done marker is stamped — set by the
   *  completion tool ONLY after the adversarial verifier passed (§12). A
   *  deterministic READ; the evaluator never runs the verifier, so the verdict
   *  path stays model-free. Optional: absent on the non-acting rollup path (a
   *  `verify` goal completes only on the acting driver, which provides it), and
   *  a missing resolver evaluates to `false` — never falsely met. Backs the
   *  `verify` leaf. */
  verifiedDone?: () => Promise<boolean>
}

export type DoneWhenTraceEntry = {
  leaf: 'subtasks' | 'query' | 'tool' | 'verify'
  met: boolean
  detail?: string
  /** Set when a `tool` read threw/failed and was treated as not-confirmed. */
  unconfirmed?: boolean
}

/** The structured verdict: the boolean plus per-leaf evidence. The trace is
 *  what the loop records on the run and surfaces in the goal's decision log —
 *  a goal never terminates without written evidence (§7 "no silent
 *  termination"). */
export type DoneWhenVerdict = { met: boolean; trace: DoneWhenTraceEntry[] }

export async function evaluateDoneWhen(
  node: DoneWhenNode,
  resolvers: DoneWhenResolvers,
): Promise<DoneWhenVerdict> {
  const trace: DoneWhenTraceEntry[] = []
  const met = await evalNode(node, resolvers, trace)
  return { met, trace }
}

async function evalNode(
  node: DoneWhenNode,
  resolvers: DoneWhenResolvers,
  trace: DoneWhenTraceEntry[],
): Promise<boolean> {
  if ('kind' in node) {
    switch (node.kind) {
      case 'subtasks': {
        const met = await resolvers.subtasksClosed()
        trace.push({ leaf: 'subtasks', met })
        return met
      }
      case 'query': {
        const met = await resolvers.query(node.query)
        trace.push({ leaf: 'query', met, detail: node.query.description })
        return met
      }
      case 'tool': {
        try {
          const met = await resolvers.tool(node.tool)
          trace.push({ leaf: 'tool', met, detail: node.tool.description ?? node.tool.tool })
          return met
        } catch {
          // Read-only/idempotent check failed -> NOT confirmed (false), never
          // a loop-killing error. (§4.10 invariant.)
          trace.push({
            leaf: 'tool',
            met: false,
            unconfirmed: true,
            detail: node.tool.description ?? node.tool.tool,
          })
          return false
        }
      }
      case 'verify': {
        // The model judgment lives in the completion tool, gated by the
        // adversarial verifier; the evaluator only READS the resulting marker,
        // so a `verify` goal is never self-graded here. Absent resolver (the
        // non-acting rollup path) -> false, never falsely met (fail-safe).
        const met = resolvers.verifiedDone ? await resolvers.verifiedDone() : false
        trace.push({ leaf: 'verify', met })
        return met
      }
    }
  }
  if ('all' in node) {
    for (const child of node.all) {
      if (!(await evalNode(child, resolvers, trace))) return false // short-circuit
    }
    return true
  }
  if ('any' in node) {
    for (const child of node.any) {
      if (await evalNode(child, resolvers, trace)) return true // short-circuit
    }
    return false
  }
  return !(await evalNode(node.not, resolvers, trace))
}
