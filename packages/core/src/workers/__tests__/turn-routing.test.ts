/**
 * Turn routing decision core: the research/topic/split decision matrix for
 * the web and channel profiles, model-call budgets, Stop, discarded split
 * usage, per-lane authority and catalog-validated tool names.
 * Spec: docs/architecture/features/research.md → "Turn routing".
 *
 * [COMP:core/turn-routing]
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  planTurnRoute,
  routeTurn,
  type ChannelRoutingFacts,
  type TurnRoutingCapture,
  type TurnRoutingInput,
  type TurnRoutingLane,
  type TurnRoutingUsageRecord,
  type WebRoutingFacts,
} from '../turn-routing.js'
import type { ResearchClassifyResult } from '../research-classifier.js'
import type { SplitResult } from '../splitter.js'
import type { TopicClassification } from '../../memory/topic-classifier.js'

const USAGE = { inputTokens: 10, outputTokens: 2 }
const TRIVIAL = 'thanks'
const SHORT = 'what is the latest policy rate?'
const LONG = 'Compare pricing of three project tools for a ten person team in detail'
const OPERATE = 'browse lu.ma for me and list the events happening this weekend'

function web(overrides: Partial<WebRoutingFacts> = {}): WebRoutingFacts {
  return {
    profile: 'web', workspaceId: 'ws-1', assistantKind: 'primary', researchQuotaAvailable: true,
    pageBound: false, docSurface: false, tier: 'standard',
    model: { custom: false, explicitMetered: false, standardWhenOk: true, standardWhenDowngraded: true },
    ...overrides,
  }
}

function channel(overrides: Partial<ChannelRoutingFacts> = {}): ChannelRoutingFacts {
  return { profile: 'channel', adaptiveResearchEnabled: true, workspaceId: 'ws-1', plan: 'pro', budgetStatus: 'ok', isolatedAudience: false, ...overrides }
}

function capture(message: string, topic: Partial<TurnRoutingCapture['topic']> = {}): TurnRoutingCapture {
  return {
    message,
    recentConversation: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }],
    topic: { recentUserTurns: [{ text: 'earlier question', topicLabel: 'tools' }], knownTopicsThisSession: ['tools'], replyToText: null, allowTrivialShortcut: true, ...topic },
  }
}

const ordinary = (): ResearchClassifyResult => ({ research: false, operateSite: false, reason: null, usage: USAGE, model: 'bg-model' })
const researchVerdict = (): ResearchClassifyResult => ({ research: true, effort: 'focused', operateSite: false, reason: 'multi-source comparison', usage: USAGE, model: 'bg-model' })
const topicResult = (): TopicClassification => ({ topic_label: 'tools', state: 'continue', confidence: 0.9, usage: USAGE, model: 'bg-model' })

type Harness = {
  input: TurnRoutingInput
  ports: { research: ReturnType<typeof vi.fn>; topic: ReturnType<typeof vi.fn>; split: ReturnType<typeof vi.fn>; combined: ReturnType<typeof vi.fn> }
  authority: Record<TurnRoutingLane, ReturnType<typeof vi.fn>>
  records: TurnRoutingUsageRecord[]
}

function harness(params: {
  facts: WebRoutingFacts | ChannelRoutingFacts
  capture: TurnRoutingCapture
  research?: (request: Parameters<TurnRoutingInput['ports']['research']>[0]) => Promise<ResearchClassifyResult>
  topic?: (request: Parameters<TurnRoutingInput['ports']['topic']>[0]) => Promise<TopicClassification>
  split?: (request: Parameters<TurnRoutingInput['ports']['split']>[0]) => Promise<SplitResult>
  extra?: Partial<TurnRoutingInput>
}): Harness {
  const records: TurnRoutingUsageRecord[] = []
  const ports = {
    research: vi.fn(params.research ?? (async () => ordinary())),
    topic: vi.fn(params.topic ?? (async () => topicResult())),
    split: vi.fn(params.split ?? (async (): Promise<SplitResult> => ({ tasks: ['angle one', 'angle two'], usage: USAGE, model: 'bg-model' }))),
    combined: vi.fn(async () => ({ research: ordinary(), topic: topicResult(), split: { tasks: null, usage: null, model: null }, usage: USAGE, model: 'bg-model' })),
  }
  const authority = { research: vi.fn(async () => {}), topic: vi.fn(async () => {}), split: vi.fn(async () => {}) }
  const input: TurnRoutingInput = {
    facts: params.facts, capture: params.capture,
    ports: { research: ports.research, topic: ports.topic, split: ports.split },
    authority,
    recordUsage: async record => { records.push(record) },
    attribution: { modelTier: 'standard', providerKeySource: 'platform' },
    ...params.extra,
  }
  return { input, ports, authority, records }
}

type Row = {
  name: string
  facts: WebRoutingFacts | ChannelRoutingFacts
  message: string
  topic?: Partial<TurnRoutingCapture['topic']>
  verdict?: 'ordinary' | 'research'
  expect: {
    research: { active: boolean; entry: 'explicit' | 'adaptive' | null; effort: string | null; operateSite: boolean }
    trace: { research: string; topic: string; split: string }
    split: 'preflight' | 'coordinator' | null
    modelCalls: number
  }
}

const off = { active: false, entry: null, effort: null, operateSite: false } as const
const adaptive = { active: true, entry: 'adaptive', effort: 'focused', operateSite: false } as const
const explicitDeep = { active: true, entry: 'explicit', effort: 'deep', operateSite: false } as const
const site = { active: false, entry: null, effort: null, operateSite: true } as const

/** The routing matrix. Mirrored as a table in the M3 turn-routing receipt. */
const MATRIX: Row[] = [
  // ── web, Standard ──
  { name: 'W1 web Standard trivial', facts: web(), message: TRIVIAL, expect: { research: off, trace: { research: 'shortcut:trivial', topic: 'shortcut:trivial', split: 'skip:short' }, split: null, modelCalls: 0 } },
  { name: 'W2 web Standard CJK trivial', facts: web(), message: '你好', expect: { research: off, trace: { research: 'shortcut:trivial', topic: 'shortcut:trivial', split: 'skip:short' }, split: null, modelCalls: 0 } },
  { name: 'W3 web Standard short substantive', facts: web(), message: SHORT, expect: { research: off, trace: { research: 'model', topic: 'model', split: 'skip:short' }, split: null, modelCalls: 2 } },
  { name: 'W4 web Standard long ordinary', facts: web(), message: LONG, expect: { research: off, trace: { research: 'model', topic: 'model', split: 'model:concurrent' }, split: 'preflight', modelCalls: 3 } },
  { name: 'W5 web Standard long research verdict', facts: web(), message: LONG, verdict: 'research', expect: { research: adaptive, trace: { research: 'model', topic: 'model', split: 'discarded:research' }, split: null, modelCalls: 3 } },
  { name: 'W6 web Standard operate-site', facts: web(), message: OPERATE, expect: { research: site, trace: { research: 'shortcut:operate_site', topic: 'model', split: 'skip:operate_site' }, split: null, modelCalls: 1 } },
  { name: 'W7 web explicit research', facts: web({ requestedMode: 'research' }), message: LONG, expect: { research: explicitDeep, trace: { research: 'explicit', topic: 'model', split: 'skip:research' }, split: null, modelCalls: 1 } },
  { name: 'W8 web mode default', facts: web({ requestedMode: 'default' }), message: LONG, expect: { research: off, trace: { research: 'skip:ineligible', topic: 'model', split: 'model:late' }, split: 'preflight', modelCalls: 2 } },
  { name: 'W9 web free allowance exhausted', facts: web({ researchQuotaAvailable: false }), message: LONG, expect: { research: off, trace: { research: 'skip:ineligible', topic: 'model', split: 'model:late' }, split: 'preflight', modelCalls: 2 } },
  { name: 'W10 web no workspace', facts: web({ workspaceId: null }), message: LONG, expect: { research: off, trace: { research: 'skip:ineligible', topic: 'model', split: 'model:late' }, split: 'preflight', modelCalls: 2 } },
  { name: 'W11 web page-bound doc turn', facts: web({ pageBound: true, docSurface: true }), message: LONG, expect: { research: off, trace: { research: 'skip:page_bound', topic: 'skip:page_bound', split: 'model:late' }, split: 'preflight', modelCalls: 1 } },
  { name: 'W12 web page-bound trivial', facts: web({ pageBound: true, docSurface: true }), message: TRIVIAL, expect: { research: off, trace: { research: 'skip:page_bound', topic: 'skip:page_bound', split: 'skip:short' }, split: null, modelCalls: 0 } },
  { name: 'W13 web app assistant', facts: web({ assistantKind: 'app' }), message: LONG, expect: { research: off, trace: { research: 'skip:ineligible', topic: 'model', split: 'model:late' }, split: 'preflight', modelCalls: 2 } },
  { name: 'W14 web app assistant explicit research', facts: web({ assistantKind: 'app', requestedMode: 'research' }), message: LONG, expect: { research: off, trace: { research: 'skip:ineligible', topic: 'model', split: 'model:late' }, split: 'preflight', modelCalls: 2 } },
  { name: 'W15 web custom model', facts: web({ model: { custom: true, explicitMetered: false, standardWhenOk: true, standardWhenDowngraded: true } }), message: LONG, expect: { research: off, trace: { research: 'model', topic: 'model', split: 'model:late' }, split: 'preflight', modelCalls: 3 } },
  { name: 'W16 web doc surface explicit research', facts: web({ docSurface: true, requestedMode: 'research' }), message: LONG, expect: { research: explicitDeep, trace: { research: 'explicit', topic: 'model', split: 'skip:doc_research' }, split: null, modelCalls: 1 } },
  { name: 'W17 web reply to trivial', facts: web(), message: TRIVIAL, topic: { replyToText: 'the earlier plan', allowTrivialShortcut: false }, expect: { research: off, trace: { research: 'shortcut:trivial', topic: 'model', split: 'skip:short' }, split: null, modelCalls: 1 } },
  // ── web, Pro/Max ──
  { name: 'W18 web Pro/Max long ordinary', facts: web({ tier: 'pro_max', model: { custom: false, explicitMetered: false, standardWhenOk: false, standardWhenDowngraded: false } }), message: LONG, expect: { research: off, trace: { research: 'model', topic: 'model', split: 'model:late' }, split: 'coordinator', modelCalls: 3 } },
  { name: 'W19 web Pro/Max long research verdict', facts: web({ tier: 'pro_max', model: { custom: false, explicitMetered: false, standardWhenOk: false, standardWhenDowngraded: false } }), message: LONG, verdict: 'research', expect: { research: adaptive, trace: { research: 'model', topic: 'model', split: 'skip:research' }, split: null, modelCalls: 2 } },
  { name: 'W20 web Pro/Max operate-site', facts: web({ tier: 'pro_max', model: { custom: false, explicitMetered: false, standardWhenOk: false, standardWhenDowngraded: false } }), message: OPERATE, expect: { research: site, trace: { research: 'shortcut:operate_site', topic: 'model', split: 'skip:operate_site' }, split: null, modelCalls: 1 } },
  { name: 'W21 web Pro/Max short', facts: web({ tier: 'pro_max', model: { custom: false, explicitMetered: false, standardWhenOk: false, standardWhenDowngraded: false } }), message: SHORT, expect: { research: off, trace: { research: 'model', topic: 'model', split: 'skip:short' }, split: null, modelCalls: 2 } },
  { name: 'W22 web Pro/Max doc surface', facts: web({ tier: 'pro_max', docSurface: true, model: { custom: false, explicitMetered: false, standardWhenOk: false, standardWhenDowngraded: false } }), message: LONG, expect: { research: off, trace: { research: 'model', topic: 'model', split: 'model:late' }, split: 'preflight', modelCalls: 3 } },
  // ── channel ──
  { name: 'C1 channel paid long ordinary', facts: channel(), message: LONG, expect: { research: off, trace: { research: 'model', topic: 'model', split: 'model:concurrent' }, split: 'preflight', modelCalls: 3 } },
  { name: 'C2 channel paid long research verdict', facts: channel(), message: LONG, verdict: 'research', expect: { research: adaptive, trace: { research: 'model', topic: 'model', split: 'model:concurrent' }, split: 'preflight', modelCalls: 3 } },
  { name: 'C3 channel free plan', facts: channel({ plan: 'free' }), message: LONG, expect: { research: off, trace: { research: 'skip:unpaid', topic: 'model', split: 'model:concurrent' }, split: 'preflight', modelCalls: 2 } },
  { name: 'C4 channel research not enabled', facts: channel({ adaptiveResearchEnabled: false }), message: SHORT, expect: { research: off, trace: { research: 'skip:not_enabled', topic: 'model', split: 'skip:short' }, split: null, modelCalls: 1 } },
  { name: 'C5 channel budget downgraded', facts: channel({ budgetStatus: 'downgraded' }), message: LONG, expect: { research: off, trace: { research: 'skip:budget_downgraded', topic: 'model', split: 'model:concurrent' }, split: 'preflight', modelCalls: 2 } },
  { name: 'C6 channel isolated audience', facts: channel({ isolatedAudience: true }), message: LONG, expect: { research: off, trace: { research: 'skip:isolated_audience', topic: 'model', split: 'skip:isolated_audience' }, split: null, modelCalls: 1 } },
  { name: 'C7 channel trivial', facts: channel(), message: TRIVIAL, expect: { research: off, trace: { research: 'shortcut:trivial', topic: 'shortcut:trivial', split: 'skip:short' }, split: null, modelCalls: 0 } },
  { name: 'C8 channel operate-site', facts: channel(), message: OPERATE, expect: { research: site, trace: { research: 'shortcut:operate_site', topic: 'model', split: 'model:concurrent' }, split: 'preflight', modelCalls: 2 } },
  { name: 'C9 channel short substantive', facts: channel(), message: SHORT, expect: { research: off, trace: { research: 'model', topic: 'model', split: 'skip:short' }, split: null, modelCalls: 2 } },
]

describe('[COMP:core/turn-routing] routing matrix', () => {
  it.each(MATRIX)('$name', async row => {
    const h = harness({
      facts: row.facts, capture: capture(row.message, row.topic),
      research: async () => row.verdict === 'research' ? researchVerdict() : ordinary(),
    })
    const route = await routeTurn(h.input)
    expect({ active: route.research.active, entry: route.research.entry, effort: route.research.effort, operateSite: route.research.operateSite }).toEqual(row.expect.research)
    expect(route.trace).toEqual(row.expect.trace)
    expect(route.split?.delegation ?? null).toBe(row.expect.split)
    expect(route.modelCalls).toBe(row.expect.modelCalls)
    const invoked = h.ports.research.mock.calls.length + h.ports.topic.mock.calls.length + h.ports.split.mock.calls.length
    expect(invoked).toBe(row.expect.modelCalls)
    // Every completed model call is recorded exactly once.
    expect(h.records).toHaveLength(row.expect.modelCalls)
    expect(route.usage).toEqual(h.records)
    expect(route.topic.ephemeral).toBe(row.expect.trace.topic === 'shortcut:trivial')
    if (row.expect.trace.topic === 'skip:page_bound') expect(route.topic.classification).toBeNull()
    else expect(route.topic.classification).not.toBeNull()
  })

  it('planTurnRoute decides shortcuts without any port', () => {
    const plan = planTurnRoute(web(), capture(TRIVIAL))
    expect(plan.research).toEqual({ kind: 'shortcut', reason: 'trivial' })
    expect(plan.topic).toEqual({ kind: 'shortcut', reason: 'trivial' })
    expect(plan.split.concurrent).toBe(false)
    expect(planTurnRoute(web(), capture(LONG)).split.concurrent).toBe(true)
    expect(planTurnRoute(web({ model: { custom: false, explicitMetered: true, standardWhenOk: true, standardWhenDowngraded: true } }), capture(LONG)).split.concurrent).toBe(false)
    expect(planTurnRoute(web({ model: { custom: false, explicitMetered: false, standardWhenOk: true, standardWhenDowngraded: false } }), capture(LONG)).split.concurrent).toBe(false)
    expect(planTurnRoute(web({ assistantKind: 'member' }), capture(LONG)).split.concurrent).toBe(false)
  })
})

describe('[COMP:core/turn-routing] captured input, authority and attribution', () => {
  it('shares one frozen capture and gives each lane its own authority check', async () => {
    const h = harness({ facts: web(), capture: capture(LONG) })
    const original = h.input.capture
    const route = await routeTurn(h.input)
    original.message = 'mutated after routing'
    const seen = [h.ports.research, h.ports.topic, h.ports.split].map(port => port.mock.calls[0][0])
    expect(seen[0].input).toBe(seen[1].input)
    expect(seen[1].input).toBe(seen[2].input)
    expect(Object.isFrozen(seen[0].input)).toBe(true)
    expect(seen[0].input.message).toBe(LONG)
    expect(seen[0].assertInputAuthority).toBe(h.authority.research)
    expect(seen[1].assertInputAuthority).toBe(h.authority.topic)
    expect(seen[2].assertInputAuthority).toBe(h.authority.split)
    expect(seen[2].phase).toBe('concurrent')
    // Adoption re-proves every adopted lane.
    expect(h.authority.research).toHaveBeenCalledTimes(1)
    expect(h.authority.topic).toHaveBeenCalledTimes(1)
    expect(h.authority.split).toHaveBeenCalledTimes(1)
    expect(route.usage.map(record => [record.lane, record.source, record.triggerKey, record.discarded])).toEqual([
      ['research', 'overhead:classifier', 'adaptive_research_classifier', false],
      ['topic', 'overhead:classifier', undefined, false],
      ['split', 'overhead:splitter', 'parallel_split_classifier', false],
    ])
    for (const record of route.usage) expect(record.attribution).toEqual({ modelTier: 'standard', providerKeySource: 'platform' })
  })

  it('deterministic shortcuts still prove their lane authority and carry the prior topic', async () => {
    const h = harness({ facts: web(), capture: capture(TRIVIAL) })
    const route = await routeTurn(h.input)
    expect(route.modelCalls).toBe(0)
    expect(h.authority.research).toHaveBeenCalledTimes(1)
    expect(h.authority.topic).toHaveBeenCalledTimes(1)
    expect(h.authority.split).not.toHaveBeenCalled()
    expect(route.topic).toEqual({ classification: { topic_label: 'tools', state: 'continue', confidence: 0, usage: null }, ephemeral: true })
  })

  it('channel usage keeps the channel trigger keys', async () => {
    const h = harness({ facts: channel(), capture: capture(LONG) })
    const route = await routeTurn(h.input)
    expect(route.usage.map(record => record.triggerKey)).toEqual(['adaptive_research', undefined, 'parallel_split_classifier'])
  })

  it('refuses a lane whose authority changes, after recording completed usage once', async () => {
    const refusal = Object.assign(new Error('authority changed'), { reason: 'authority_changed' })
    const h = harness({ facts: web(), capture: capture(LONG) })
    h.authority.topic.mockRejectedValueOnce(refusal)
    await expect(routeTurn(h.input)).rejects.toBe(refusal)
    expect(h.records.map(record => [record.lane, record.discarded])).toEqual([
      ['research', true], ['topic', true], ['split', true],
    ])
  })
})

describe('[COMP:core/turn-routing] Stop and abort', () => {
  it('a Stop before routing invokes no classifier', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    const h = harness({ facts: web(), capture: capture(LONG), extra: { signal: controller.signal } })
    await expect(routeTurn(h.input)).rejects.toThrow('stopped')
    expect(h.ports.research).not.toHaveBeenCalled()
    expect(h.ports.topic).not.toHaveBeenCalled()
    expect(h.records).toEqual([])
  })

  it('a Stop during routing cancels every lane and records only completed calls', async () => {
    const controller = new AbortController()
    const waitForStop = (signal: AbortSignal) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const h = harness({
      facts: web(), capture: capture(LONG), extra: { signal: controller.signal },
      research: request => waitForStop(request.signal),
      split: request => waitForStop(request.signal),
    })
    const routing = routeTurn(h.input)
    await vi.waitFor(() => expect(h.ports.topic).toHaveBeenCalled())
    const stop = new Error('user stop')
    controller.abort(stop)
    await expect(routing).rejects.toBe(stop)
    expect(h.records.map(record => [record.lane, record.discarded])).toEqual([['topic', true]])
  })

  it('a Stop after the concurrent phase prevents the late split call', async () => {
    const controller = new AbortController()
    const stop = new Error('user stop')
    const h = harness({
      facts: web({ tier: 'pro_max', model: { custom: false, explicitMetered: false, standardWhenOk: false, standardWhenDowngraded: false } }),
      capture: capture(LONG), extra: { signal: controller.signal },
      research: async () => { controller.abort(stop); return ordinary() },
    })
    await expect(routeTurn(h.input)).rejects.toBe(stop)
    expect(h.ports.split).not.toHaveBeenCalled()
    expect(h.records.map(record => record.lane).sort()).toEqual(['research', 'topic'])
  })
})

describe('[COMP:core/turn-routing] discarded speculative split', () => {
  it('a split completed before a research verdict is discarded but recorded exactly once', async () => {
    let releaseResearch!: () => void
    const researchGate = new Promise<void>(resolve => { releaseResearch = resolve })
    const h = harness({
      facts: web(), capture: capture(LONG),
      research: async () => { await researchGate; return researchVerdict() },
      split: async () => { queueMicrotask(releaseResearch); return { tasks: ['a', 'b'], usage: { inputTokens: 7, outputTokens: 3 }, model: 'bg-model' } },
    })
    const route = await routeTurn(h.input)
    expect(route.split).toBeNull()
    expect(route.research.active).toBe(true)
    expect(route.trace.split).toBe('discarded:research')
    const splitRecords = h.records.filter(record => record.lane === 'split')
    expect(splitRecords).toHaveLength(1)
    expect(splitRecords[0]).toMatchObject({ discarded: true, usage: { inputTokens: 7, outputTokens: 3 }, source: 'overhead:splitter' })
    expect(h.authority.split).not.toHaveBeenCalled()
  })

  it('a split still in flight is cancelled by the research verdict without an error or usage', async () => {
    let splitSignal: AbortSignal | undefined
    const h = harness({
      facts: web(), capture: capture(LONG),
      research: async () => researchVerdict(),
      split: request => new Promise<never>((_, reject) => {
        splitSignal = request.signal
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      }),
    })
    const route = await routeTurn(h.input)
    expect(splitSignal?.aborted).toBe(true)
    expect(route.split).toBeNull()
    expect(route.modelCalls).toBe(3)
    expect(h.records.map(record => record.lane)).toEqual(['research', 'topic'])
  })

  it('an operate-site verdict from the classifier also discards the speculative split', async () => {
    const h = harness({
      facts: web(), capture: capture(LONG),
      research: async () => ({ research: false, operateSite: true, reason: 'operate_site_classifier', usage: USAGE, model: 'bg-model' }),
    })
    const route = await routeTurn(h.input)
    expect(route.research.operateSite).toBe(true)
    expect(route.split).toBeNull()
    expect(route.trace.split).toBe('discarded:operate_site')
  })
})

describe('[COMP:core/turn-routing] tool names from the capability catalog', () => {
  const catalog = [
    { name: 'webSearch', description: 'Search the web' },
    { name: 'gcalListEvents', description: 'List calendar events' },
  ]

  it('passes descriptors as candidates and keeps names that are in the catalog', async () => {
    const h = harness({
      facts: web(), capture: capture(LONG), extra: { capabilities: catalog },
      research: async () => ({ ...researchVerdict(), toolNames: ['gcalListEvents', 'webSearch', 'webSearch'] }),
    })
    const route = await routeTurn(h.input)
    expect(h.ports.research.mock.calls[0][0].toolCandidates).toEqual(catalog)
    expect(route.research.toolNames).toEqual(['gcalListEvents', 'webSearch'])
  })

  it('refuses the whole selection when any name is outside the catalog', async () => {
    const h = harness({
      facts: web(), capture: capture(LONG), extra: { capabilities: catalog },
      research: async () => ({ ...ordinary(), toolNames: ['webSearch', 'deleteEverything'] }),
    })
    const route = await routeTurn(h.input)
    expect(route.research.toolNames).toEqual([])
    expect(route.trace.research).toBe('model:tool_selection_rejected')
  })

  it('never surfaces names without a catalog to validate against', async () => {
    const h = harness({ facts: web(), capture: capture(LONG), research: async () => ({ ...ordinary(), toolNames: ['webSearch'] }) })
    const route = await routeTurn(h.input)
    expect(h.ports.research.mock.calls[0][0]).not.toHaveProperty('toolCandidates')
    expect(route.research).not.toHaveProperty('toolNames')
  })

  it('a trivial shortcut owns an empty selection; an operate-site shortcut owns none', async () => {
    const trivial = await routeTurn(harness({ facts: web(), capture: capture(TRIVIAL), extra: { capabilities: catalog } }).input)
    expect(trivial.research.toolNames).toEqual([])
    const operate = await routeTurn(harness({ facts: web(), capture: capture(OPERATE), extra: { capabilities: catalog } }).input)
    expect(operate.research).not.toHaveProperty('toolNames')
  })

  it('rejects a malformed catalog before any classifier runs', async () => {
    const h = harness({ facts: web(), capture: capture(LONG), extra: { capabilities: [...catalog, { name: 'webSearch', description: 'dup' }] } })
    await expect(routeTurn(h.input)).rejects.toThrow(TypeError)
    expect(h.ports.research).not.toHaveBeenCalled()
  })
})

describe('[COMP:core/turn-routing] combined decision strategy', () => {
  it('is never used by default even when a combined port is supplied', async () => {
    const h = harness({ facts: web(), capture: capture(LONG) })
    h.input.ports.combined = h.ports.combined
    const route = await routeTurn(h.input)
    expect(h.ports.combined).not.toHaveBeenCalled()
    expect(route.modelCalls).toBe(3)
  })

  it('refuses to run without an evaluation receipt', async () => {
    const h = harness({ facts: web(), capture: capture(LONG), extra: { strategy: { kind: 'combined', evaluationReceipt: '  ' } } })
    h.input.ports.combined = h.ports.combined
    await expect(routeTurn(h.input)).rejects.toThrow(/evaluation receipt/)
    expect(h.ports.combined).not.toHaveBeenCalled()
  })

  it('with a receipt, folds the model lanes into one call and records it once', async () => {
    const h = harness({ facts: web(), capture: capture(LONG), extra: { strategy: { kind: 'combined', evaluationReceipt: 'docs/plans/evidence/example.json' } } })
    h.input.ports.combined = h.ports.combined
    const route = await routeTurn(h.input)
    expect(route.modelCalls).toBe(1)
    expect(h.ports.combined.mock.calls[0][0].lanes).toEqual(['research', 'topic', 'split'])
    expect(h.ports.research).not.toHaveBeenCalled()
    expect(h.ports.split).not.toHaveBeenCalled()
    expect(route.split).toBeNull()
    expect(route.trace.split).toBe('model:combined')
    expect(h.records.map(record => [record.lane, record.triggerKey])).toEqual([['combined', 'turn_routing_combined']])
  })
})

describe('[COMP:core/turn-routing] neutrality', () => {
  it('imports no provider SDK, vendor model or host framework', () => {
    const source = readFileSync(new URL('../turn-routing.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/^(?:import|export)(\s+type)?\b[^;]*?\bfrom '([^']+)'/gms)]
      .map(match => ({ typeOnly: Boolean(match[1]), path: match[2] }))
    expect(imports.length).toBeGreaterThan(0)
    // Relative core modules, plus type-only contracts of the provider-neutral
    // runtime package (M4: the TokenUsage type lives in @use-brian/agent-runtime).
    // A value import from the runtime, or any other package, fails.
    const neutral = (i: { typeOnly: boolean; path: string }) => i.path.startsWith('./') || i.path.startsWith('../')
      || (i.typeOnly && i.path.startsWith('@use-brian/agent-runtime/'))
    expect(imports.filter(i => !neutral(i))).toEqual([])
    expect(source).not.toMatch(/gemini|openai|anthropic|express|hono/i)
  })
})
