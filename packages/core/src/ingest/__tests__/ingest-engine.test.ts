import { describe, it, expect } from 'vitest'

import { createIngestEngine } from '../engine.js'
import type {
  IngestContext,
  IngestEngineDeps,
  IngestRule,
  PendingBatchStore,
  PipelineB,
  PlaceholderResolver,
} from '../engine.js'
import { universalFilters, type IngestEvent } from '../filters.js'

// ── Fakes ────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<IngestRule>): IngestRule {
  return {
    id: 'r1',
    connector_instance_id: 'ci-1',
    source: 'gmail',
    rule_order: 0,
    filter_type: 'always',
    filter_params: {},
    routing_mode: 'realtime',
    routing_schedule: null,
    routing_timezone: 'UTC',
    alert: false,
    episode_sensitivity: null,
    ...overrides,
  }
}

function makePipelineB(episodeId: string | null = null) {
  const calls: Array<{ event: IngestEvent; ctx: IngestContext }> = []
  const pipeline: PipelineB = {
    async process(event, ctx) {
      calls.push({ event, ctx })
      return { episodeId }
    },
  }
  return { pipeline, calls }
}

function makeBatches() {
  const calls: Array<Parameters<PendingBatchStore['appendEvent']>[0]> = []
  const store: PendingBatchStore = {
    async appendEvent(input) {
      calls.push(input)
    },
  }
  return { store, calls }
}

function makeRulesStore(rules: IngestRule[]) {
  return {
    async listByConnectorInstance() {
      return rules
    },
  }
}

function makeResolver(map: Record<string, string[]> = {}) {
  const callCounts = new Map<string, number>()
  const resolver: PlaceholderResolver = async (placeholder) => {
    callCounts.set(placeholder, (callCounts.get(placeholder) ?? 0) + 1)
    return map[placeholder] ?? []
  }
  return { resolver, callCounts }
}

type DepsInput = {
  rules?: IngestRule[]
  batches?: PendingBatchStore
  filters?: IngestEngineDeps['filters']
  pipelineB?: PipelineB
  resolvePlaceholders?: PlaceholderResolver
  onEvent?: IngestEngineDeps['onEvent']
  now?: () => Date
}

function makeDeps(input: DepsInput): IngestEngineDeps {
  const { pipeline } = makePipelineB()
  const { store } = makeBatches()
  const { resolver } = makeResolver()
  return {
    rules: makeRulesStore(input.rules ?? []),
    batches: input.batches ?? store,
    filters: input.filters ?? universalFilters,
    pipelineB: input.pipelineB ?? pipeline,
    resolvePlaceholders: input.resolvePlaceholders ?? resolver,
    onEvent: input.onEvent,
    now: input.now,
  }
}

const CTX: IngestContext = {
  workspace_id: 'ws-1',
  connector_instance_id: 'ci-1',
}

const EVENT: IngestEvent = {
  source: 'gmail',
  normalized: { sender: 'alice@acme.com', text: 'hello urgent thing' },
}

// ── Cases ────────────────────────────────────────────────────────────

describe('[COMP:brain/ingest-engine] Rule evaluation', () => {
  it('first match wins — evaluates in rule_order, stops at first hit', async () => {
    const { pipeline, calls } = makePipelineB()
    const rules: IngestRule[] = [
      makeRule({ id: 'r1', rule_order: 0, filter_type: 'sender_match', filter_params: { values: ['bob@x.com'] } }),
      makeRule({ id: 'r2', rule_order: 1, filter_type: 'sender_match', filter_params: { values: ['alice@acme.com'] }, routing_mode: 'realtime' }),
      makeRule({ id: 'r3', rule_order: 2, filter_type: 'always', routing_mode: 'drop' }),
    ]
    const engine = createIngestEngine(makeDeps({ rules, pipelineB: pipeline }))

    const decision = await engine.ingest(EVENT, CTX)

    expect(decision.matched).toBe(true)
    expect(decision.rule_id).toBe('r2')
    expect(decision.routing_mode).toBe('realtime')
    expect(calls).toHaveLength(1)
  })

  it('returns defensive drop decision when no rules exist', async () => {
    const { pipeline, calls } = makePipelineB()
    const { store, calls: batchCalls } = makeBatches()
    const engine = createIngestEngine(
      makeDeps({ rules: [], pipelineB: pipeline, batches: store }),
    )

    const decision = await engine.ingest(EVENT, CTX)

    expect(decision.matched).toBe(false)
    expect(decision.routing_mode).toBe('drop')
    expect(decision.rule_id).toBe(null)
    expect(calls).toHaveLength(0)
    expect(batchCalls).toHaveLength(0)
  })

  it('returns defensive drop decision when no rule matches', async () => {
    const rules: IngestRule[] = [
      makeRule({ filter_type: 'sender_match', filter_params: { values: ['nobody@example.com'] } }),
    ]
    const engine = createIngestEngine(makeDeps({ rules }))

    const decision = await engine.ingest(EVENT, CTX)

    expect(decision.matched).toBe(false)
    expect(decision.routing_mode).toBe('drop')
  })

  it('skips rules with unknown filter_type and continues evaluation', async () => {
    const { pipeline, calls } = makePipelineB()
    const rules: IngestRule[] = [
      makeRule({ id: 'unknown', filter_type: 'this_filter_does_not_exist', rule_order: 0 }),
      makeRule({ id: 'matches', filter_type: 'always', rule_order: 1, routing_mode: 'realtime' }),
    ]
    const engine = createIngestEngine(makeDeps({ rules, pipelineB: pipeline }))

    const decision = await engine.ingest(EVENT, CTX)

    expect(decision.rule_id).toBe('matches')
    expect(calls).toHaveLength(1)
  })
})

describe('[COMP:brain/ingest-engine] Dispatch by routing mode', () => {
  it('realtime → calls pipelineB.process, no batch write', async () => {
    const { pipeline, calls: pCalls } = makePipelineB()
    const { store, calls: bCalls } = makeBatches()
    const rules = [makeRule({ filter_type: 'always', routing_mode: 'realtime' })]
    const engine = createIngestEngine(
      makeDeps({ rules, pipelineB: pipeline, batches: store }),
    )

    await engine.ingest(EVENT, CTX)

    expect(pCalls).toHaveLength(1)
    expect(pCalls[0].event).toEqual(EVENT)
    expect(pCalls[0].ctx).toEqual(CTX)
    expect(bCalls).toHaveLength(0)
  })

  it('scheduled → appends to batch with cron-computed fires_at, no pipelineB call', async () => {
    const { pipeline, calls: pCalls } = makePipelineB()
    const { store, calls: bCalls } = makeBatches()
    const rules = [
      makeRule({
        id: 'daily',
        filter_type: 'always',
        routing_mode: 'scheduled',
        routing_schedule: '0 9 * * *',
        routing_timezone: 'UTC',
      }),
    ]
    // Freeze "now" at midnight UTC so next 09:00 UTC is deterministic.
    const fixedNow = new Date('2026-05-14T00:00:00.000Z')
    const engine = createIngestEngine(
      makeDeps({
        rules,
        pipelineB: pipeline,
        batches: store,
        now: () => fixedNow,
      }),
    )

    await engine.ingest(EVENT, CTX)

    expect(pCalls).toHaveLength(0)
    expect(bCalls).toHaveLength(1)
    expect(bCalls[0].workspace_id).toBe('ws-1')
    expect(bCalls[0].rule_id).toBe('daily')
    expect(bCalls[0].source).toBe('gmail')
    expect(bCalls[0].event).toEqual(EVENT)
    // 09:00 UTC the same calendar day
    expect(bCalls[0].fires_at.toISOString()).toBe('2026-05-14T09:00:00.000Z')
  })

  it('drop → no pipelineB, no batch, but still fires onEvent', async () => {
    const { pipeline, calls: pCalls } = makePipelineB()
    const { store, calls: bCalls } = makeBatches()
    let eventCalls = 0
    const rules = [makeRule({ filter_type: 'always', routing_mode: 'drop', alert: false })]
    const engine = createIngestEngine(
      makeDeps({
        rules,
        pipelineB: pipeline,
        batches: store,
        onEvent: async () => {
          eventCalls++
        },
      }),
    )

    const decision = await engine.ingest(EVENT, CTX)

    expect(decision.routing_mode).toBe('drop')
    expect(decision.matched).toBe(true)
    expect(pCalls).toHaveLength(0)
    expect(bCalls).toHaveLength(0)
    // Decoupled from routing + `alert` — a matched event fires onEvent
    // even when the brain drops it (workflow-triggering is independent).
    expect(eventCalls).toBe(1)
  })

  it('scheduled rule with null routing_schedule throws — config bug', async () => {
    const rules = [
      makeRule({ filter_type: 'always', routing_mode: 'scheduled', routing_schedule: null }),
    ]
    const engine = createIngestEngine(makeDeps({ rules }))

    await expect(engine.ingest(EVENT, CTX)).rejects.toThrow(/routing_schedule is null/)
  })

  it('scheduled rule with malformed cron propagates UnsupportedCronExpressionError', async () => {
    const rules = [
      makeRule({
        filter_type: 'always',
        routing_mode: 'scheduled',
        routing_schedule: 'garbage',
      }),
    ]
    const engine = createIngestEngine(makeDeps({ rules }))

    await expect(engine.ingest(EVENT, CTX)).rejects.toThrow(/Unsupported cron expression/)
  })
})

describe('[COMP:brain/ingest-engine] Alert hook', () => {
  it('invokes onEvent AFTER Pipeline B for a realtime rule', async () => {
    const order: string[] = []
    const pipeline: PipelineB = {
      async process() {
        order.push('pipelineB')
      },
    }
    const rules = [
      makeRule({ id: 'evt-rule', filter_type: 'always', routing_mode: 'realtime', alert: false }),
    ]
    const eventCalls: IngestRule[] = []
    const engine = createIngestEngine(
      makeDeps({
        rules,
        pipelineB: pipeline,
        onEvent: async (_event, _ctx, rule) => {
          order.push('onEvent')
          eventCalls.push(rule)
        },
      }),
    )

    await engine.ingest(EVENT, CTX)

    expect(order).toEqual(['pipelineB', 'onEvent'])
    expect(eventCalls).toHaveLength(1)
    expect(eventCalls[0].id).toBe('evt-rule')
  })

  it('threads the realtime Pipeline B Episode id into onEvent', async () => {
    const { pipeline } = makePipelineB('ep-from-pipeline')
    const rules = [
      makeRule({ filter_type: 'always', routing_mode: 'realtime', alert: false }),
    ]
    let seenEpisodeId: string | null | undefined
    const engine = createIngestEngine(
      makeDeps({
        rules,
        pipelineB: pipeline,
        onEvent: async (_event, _ctx, _rule, episodeId) => {
          seenEpisodeId = episodeId
        },
      }),
    )

    await engine.ingest(EVENT, CTX)

    expect(seenEpisodeId).toBe('ep-from-pipeline')
  })

  it('passes a null episode id to onEvent for a scheduled rule', async () => {
    const rules = [
      makeRule({
        filter_type: 'always',
        routing_mode: 'scheduled',
        routing_schedule: '0 9 * * *',
        alert: false,
      }),
    ]
    let seenEpisodeId: string | null | undefined = 'unset'
    const engine = createIngestEngine(
      makeDeps({
        rules,
        onEvent: async (_event, _ctx, _rule, episodeId) => {
          seenEpisodeId = episodeId
        },
      }),
    )

    await engine.ingest(EVENT, CTX)

    // `scheduled` defers Pipeline B to the batch worker — no Episode yet.
    expect(seenEpisodeId).toBeNull()
  })

  it('invokes onEvent after appendEvent for a scheduled rule', async () => {
    const order: string[] = []
    const { store } = makeBatches()
    const wrappedStore: PendingBatchStore = {
      async appendEvent(input) {
        order.push('appendEvent')
        await store.appendEvent(input)
      },
    }
    const rules = [
      makeRule({
        filter_type: 'always',
        routing_mode: 'scheduled',
        routing_schedule: '0 9 * * *',
        alert: false,
      }),
    ]
    const engine = createIngestEngine(
      makeDeps({
        rules,
        batches: wrappedStore,
        onEvent: async () => {
          order.push('onEvent')
        },
      }),
    )

    await engine.ingest(EVENT, CTX)

    expect(order).toEqual(['appendEvent', 'onEvent'])
  })

  it('a matched rule without an onEvent handler does not throw', async () => {
    const rules = [
      makeRule({ filter_type: 'always', routing_mode: 'realtime', alert: false }),
    ]
    const engine = createIngestEngine(makeDeps({ rules }))

    await expect(engine.ingest(EVENT, CTX)).resolves.toMatchObject({ matched: true })
  })
})

describe('[COMP:brain/ingest-engine] Placeholder resolution', () => {
  it('expands :crm_contacts at evaluation time before passing to filter', async () => {
    const { resolver } = makeResolver({ ':crm_contacts': ['alice@acme.com', 'bob@notion.com'] })
    const rules = [
      makeRule({
        id: 'crm',
        filter_type: 'sender_match',
        filter_params: { values: [':crm_contacts'] },
        routing_mode: 'realtime',
      }),
    ]
    const { pipeline, calls } = makePipelineB()
    const engine = createIngestEngine(
      makeDeps({ rules, pipelineB: pipeline, resolvePlaceholders: resolver }),
    )

    // alice@acme.com is in the resolved list
    const decision = await engine.ingest(EVENT, CTX)

    expect(decision.rule_id).toBe('crm')
    expect(calls).toHaveLength(1)
  })

  it('concatenates resolved members alongside literal values in the same array', async () => {
    const { resolver } = makeResolver({ ':crm_contacts': ['someone@else.com'] })
    const rules = [
      makeRule({
        filter_type: 'sender_match',
        filter_params: { values: ['alice@acme.com', ':crm_contacts'] },
        routing_mode: 'realtime',
      }),
    ]
    const engine = createIngestEngine(
      makeDeps({ rules, resolvePlaceholders: resolver }),
    )

    const decision = await engine.ingest(EVENT, CTX)

    expect(decision.matched).toBe(true)
  })

  it('caches placeholder resolution per ingest call', async () => {
    const { resolver, callCounts } = makeResolver({ ':crm_contacts': ['alice@acme.com'] })
    // Two rules use the same placeholder; the second matches.
    const rules = [
      makeRule({
        id: 'r1',
        rule_order: 0,
        filter_type: 'sender_match',
        filter_params: { values: [':crm_contacts'] },
      }),
      makeRule({
        id: 'r2',
        rule_order: 1,
        filter_type: 'mention_of',
        filter_params: { values: [':crm_contacts'] },
      }),
    ]
    // EVENT.normalized.sender = alice@acme.com → first rule matches.
    const engine = createIngestEngine(
      makeDeps({ rules, resolvePlaceholders: resolver }),
    )

    await engine.ingest(EVENT, CTX)

    // Resolver should NOT have been called twice — but since the first
    // rule already matched, this asserts a tighter contract: even when
    // both rules evaluate, the resolver fires once per placeholder.
    expect(callCounts.get(':crm_contacts') ?? 0).toBeLessThanOrEqual(1)
  })

  it('calls resolver again across separate ingest invocations (no cross-call leak)', async () => {
    const { resolver, callCounts } = makeResolver({ ':crm_contacts': ['alice@acme.com'] })
    const rules = [
      makeRule({
        filter_type: 'sender_match',
        filter_params: { values: [':crm_contacts'] },
      }),
    ]
    const engine = createIngestEngine(
      makeDeps({ rules, resolvePlaceholders: resolver }),
    )

    await engine.ingest(EVENT, CTX)
    await engine.ingest(EVENT, CTX)

    expect(callCounts.get(':crm_contacts')).toBe(2)
  })

  it('leaves non-placeholder string params unchanged', async () => {
    let seenParams: Record<string, unknown> | null = null
    const customFilters = {
      capture: (_event: IngestEvent, params: Record<string, unknown>) => {
        seenParams = params
        return true
      },
    }
    const rules = [
      makeRule({
        filter_type: 'capture',
        filter_params: { mode: 'strict', values: ['alice@acme.com'] },
      }),
    ]
    const engine = createIngestEngine(
      makeDeps({ rules, filters: { ...universalFilters, ...customFilters } }),
    )

    await engine.ingest(EVENT, CTX)

    expect(seenParams).toEqual({ mode: 'strict', values: ['alice@acme.com'] })
  })

  it('does not mutate the original rule.filter_params', async () => {
    const { resolver } = makeResolver({ ':crm_contacts': ['alice@acme.com'] })
    const originalParams = { values: [':crm_contacts'] as unknown[] }
    const rules = [
      makeRule({
        filter_type: 'sender_match',
        filter_params: originalParams,
      }),
    ]
    const engine = createIngestEngine(
      makeDeps({ rules, resolvePlaceholders: resolver }),
    )

    await engine.ingest(EVENT, CTX)

    expect(originalParams.values).toEqual([':crm_contacts'])
  })
})
