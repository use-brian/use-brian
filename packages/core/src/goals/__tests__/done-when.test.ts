import { describe, it, expect, vi } from 'vitest'
import {
  doneWhenSchema,
  evaluateDoneWhen,
  type DoneWhenNode,
  type DoneWhenResolvers,
} from '../done-when.js'

/** Resolvers that record every call, so a test can assert the evaluator
 *  touches ONLY these three ports (the "never self-graded" invariant). */
function spyResolvers(over: Partial<DoneWhenResolvers> = {}) {
  const calls: string[] = []
  // Recording wraps the (optional) override so `calls` reflects every port
  // touched regardless of what behaviour a test injects.
  const resolvers: DoneWhenResolvers = {
    subtasksClosed: async () => {
      calls.push('subtasksClosed')
      return over.subtasksClosed ? over.subtasksClosed() : false
    },
    query: async (q) => {
      calls.push('query')
      return over.query ? over.query(q) : false
    },
    tool: async (t) => {
      calls.push('tool')
      return over.tool ? over.tool(t) : false
    },
  }
  // `verifiedDone` is optional (absent on the non-acting path); only wire it
  // when a test provides one, so the absent-resolver fail-safe is testable.
  if (over.verifiedDone) {
    const vd = over.verifiedDone
    resolvers.verifiedDone = async () => {
      calls.push('verifiedDone')
      return vd()
    }
  }
  return { resolvers, calls }
}

describe('[COMP:goals/acceptance-schema] done_when schema', () => {
  it('accepts the three leaf kinds', () => {
    expect(doneWhenSchema.safeParse({ kind: 'subtasks' }).success).toBe(true)
    expect(
      doneWhenSchema.safeParse({ kind: 'query', query: { predicate: { stage: 'closed-won' } } })
        .success,
    ).toBe(true)
    expect(
      doneWhenSchema.safeParse({ kind: 'tool', tool: { tool: 'gh.prMerged', args: { pr: 42 } } })
        .success,
    ).toBe(true)
  })

  it('accepts the verify leaf (§12 agentic termination); rejects extra keys', () => {
    expect(doneWhenSchema.safeParse({ kind: 'verify' }).success).toBe(true)
    // No criterion field — the goal's outcome is the criterion.
    expect(doneWhenSchema.safeParse({ kind: 'verify', criterion: 'x' }).success).toBe(false)
  })

  it('accepts nested combinators', () => {
    const node = {
      all: [
        { kind: 'subtasks' },
        { any: [{ kind: 'query', query: { predicate: {} } }, { not: { kind: 'subtasks' } }] },
      ],
    }
    expect(doneWhenSchema.safeParse(node).success).toBe(true)
  })

  it('rejects an empty combinator (cannot masquerade as met)', () => {
    expect(doneWhenSchema.safeParse({ all: [] }).success).toBe(false)
    expect(doneWhenSchema.safeParse({ any: [] }).success).toBe(false)
  })

  it('rejects unknown leaf kinds and extra keys', () => {
    expect(doneWhenSchema.safeParse({ kind: 'vibes' }).success).toBe(false)
    expect(doneWhenSchema.safeParse({ kind: 'subtasks', extra: 1 }).success).toBe(false)
    // no `assistant` / model leaf exists in the language at all
    expect(doneWhenSchema.safeParse({ kind: 'assistant', prompt: 'is it good?' }).success).toBe(
      false,
    )
  })
})

describe('[COMP:goals/acceptance-evaluator] done_when evaluator', () => {
  it('subtasks leaf returns the resolver verdict with a trace', async () => {
    const { resolvers } = spyResolvers({ subtasksClosed: async () => true })
    const v = await evaluateDoneWhen({ kind: 'subtasks' }, resolvers)
    expect(v.met).toBe(true)
    expect(v.trace).toEqual([{ leaf: 'subtasks', met: true }])
  })

  it('query leaf passes the query through and reports the verdict', async () => {
    const query = vi.fn(async () => true)
    const { resolvers } = spyResolvers({ query })
    const node: DoneWhenNode = {
      kind: 'query',
      query: { description: 'deal closed-won', predicate: { stage: 'closed-won' } },
    }
    const v = await evaluateDoneWhen(node, resolvers)
    expect(v.met).toBe(true)
    expect(query).toHaveBeenCalledWith({
      description: 'deal closed-won',
      predicate: { stage: 'closed-won' },
    })
    expect(v.trace[0]).toMatchObject({ leaf: 'query', met: true, detail: 'deal closed-won' })
  })

  it('INVARIANT: a thrown tool read is treated as not-confirmed, never an error', async () => {
    const tool = vi.fn(async () => {
      throw new Error('connector 503')
    })
    const { resolvers } = spyResolvers({ tool })
    const v = await evaluateDoneWhen(
      { kind: 'tool', tool: { tool: 'gh.prMerged', description: 'PR merged' } },
      resolvers,
    )
    expect(v.met).toBe(false)
    expect(v.trace[0]).toMatchObject({ leaf: 'tool', met: false, unconfirmed: true })
  })

  it('all short-circuits on the first false', async () => {
    const subtasksClosed = vi.fn(async () => false)
    const query = vi.fn(async () => true)
    const { resolvers } = spyResolvers({ subtasksClosed, query })
    const v = await evaluateDoneWhen(
      { all: [{ kind: 'subtasks' }, { kind: 'query', query: { predicate: {} } }] },
      resolvers,
    )
    expect(v.met).toBe(false)
    expect(subtasksClosed).toHaveBeenCalledTimes(1)
    expect(query).not.toHaveBeenCalled() // short-circuited
  })

  it('any short-circuits on the first true; not inverts', async () => {
    const { resolvers } = spyResolvers({ subtasksClosed: async () => true })
    const anyV = await evaluateDoneWhen(
      { any: [{ kind: 'subtasks' }, { kind: 'query', query: { predicate: {} } }] },
      resolvers,
    )
    expect(anyV.met).toBe(true)
    const notV = await evaluateDoneWhen({ not: { kind: 'subtasks' } }, resolvers)
    expect(notV.met).toBe(false)
  })

  it('verify leaf returns the verified-done marker; an absent resolver is fail-safe false', async () => {
    // Marker stamped (the acting driver provides verifiedDone) -> met.
    const present = spyResolvers({ verifiedDone: async () => true })
    const v1 = await evaluateDoneWhen({ kind: 'verify' }, present.resolvers)
    expect(v1.met).toBe(true)
    expect(v1.trace).toEqual([{ leaf: 'verify', met: true }])

    // No verifiedDone resolver (the non-acting rollup path) -> false, never met.
    const absent = spyResolvers()
    const v2 = await evaluateDoneWhen({ kind: 'verify' }, absent.resolvers)
    expect(v2.met).toBe(false)
    expect(v2.trace).toEqual([{ leaf: 'verify', met: false }])
  })

  it('INVARIANT: never self-graded — touches only the three injected ports', async () => {
    const { resolvers, calls } = spyResolvers({
      subtasksClosed: async () => true,
      query: async () => false,
      tool: async () => false,
    })
    const node: DoneWhenNode = {
      all: [
        { kind: 'subtasks' },
        { any: [{ kind: 'query', query: { predicate: {} } }, { kind: 'tool', tool: { tool: 't' } }] },
      ],
    }
    await evaluateDoneWhen(node, resolvers)
    // Only the deterministic resolver ports were called — no model anywhere.
    expect(new Set(calls)).toEqual(new Set(['subtasksClosed', 'query', 'tool']))
  })
})
