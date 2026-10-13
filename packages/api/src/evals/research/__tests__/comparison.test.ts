import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildTool, NOOP_TURN_LEDGER, queryLoop, type LLMProvider, type StreamChunk } from '@use-brian/core'
import { runResearchEvalCli } from '../cli.js'
import { createConfiguredProviderCollectionAdapter } from '../collect.js'
import {
  collectResearchTrace,
  compareResearchTraces,
  dryRunResearchCases,
  publishableCaseProblems,
  researchCaseManifestSchema,
} from '../comparison.js'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'))
const manifest = fixture('cases.json')
const baseline = fixture('baseline.trace.json')
const candidate = fixture('candidate.trace.json')

const fetchSpy = vi.fn(async () => { throw new Error('network is not allowed in offline comparison') })
beforeEach(() => { vi.stubGlobal('fetch', fetchSpy) })
afterEach(() => { vi.unstubAllGlobals(); fetchSpy.mockClear() })

function io() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { log: (s: string) => out.push(s), error: (s: string) => err.push(s) } }
}

describe('[COMP:evals/research-comparison] Research engine comparison', () => {
  it('R15: compares matching identities per split, keeps unknown apart and surfaces new hard failures', () => {
    const r = compareResearchTraces(manifest, baseline, candidate)
    expect(r.identities).toEqual({ caseSetVersion: 'research-cases-v1', datasetVersion: 'fixture-2026-10', judge: 'fixture-judge@1',
      baseline: { engine: 'research-coordinator', version: 'v1', model: 'fixture-model' },
      candidate: { engine: 'research-coordinator', version: 'v2', model: 'fixture-model' } })
    expect(r.splits.target.baseline).toMatchObject({ cases: 2, completed: 1, unknown: 1, claimSupport: 0, coverage: 0.5, savedSuccess: 0 })
    expect(r.splits.target.candidate).toMatchObject({ completed: 2, unknown: 0, claimSupport: 1, coverage: 1, savedSuccess: 1, humanCorrections: 0 })
    // A cost nobody reported is unknown, not zero.
    expect(r.splits.heldout.baseline.costUsd).toBeNull()
    expect(r.splits.regression.baseline).toMatchObject({ cases: 1, completed: 0, unknown: 1, claimSupport: null, usefulness: null })
    // Better averages do not hide a hard failure the candidate introduced.
    expect(r.hardFailures.baseline.map((f) => f.kind)).toEqual(['false_saved_success', 'missing_required_artifact'])
    expect(r.hardFailures.newInCandidate).toEqual([
      { caseId: 'regulation-scan', kind: 'invented_source' },
      { caseId: 'regulation-scan', kind: 'unavailable_read_reported' },
    ])
  })

  it('R15: refuses mismatched dataset, judge, same-engine and unknown-case comparisons', () => {
    expect(() => compareResearchTraces(manifest, { ...baseline, datasetVersion: 'other' }, candidate)).toThrow(/dataset/)
    expect(() => compareResearchTraces(manifest, baseline, { ...candidate, judge: { id: 'other-judge', version: '1' } })).toThrow(/different judges/)
    expect(() => compareResearchTraces(manifest, baseline, { ...candidate, engine: baseline.engine })).toThrow(/same engine/)
    expect(() => compareResearchTraces(manifest, baseline, { ...candidate, results: [{ ...candidate.results[0], caseId: 'not-a-case' }] })).toThrow(/unknown case/)
    expect(() => compareResearchTraces(manifest, baseline, { ...candidate, results: [{ ...candidate.results[0], passed: true }] })).toThrow()
  })

  it('R15: keeps revisions of one report family out of both target and held-out splits', () => {
    const bad = structuredClone(manifest)
    bad.cases[1].split = 'heldout'
    const parsed = researchCaseManifestSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/family vendor-pricing spans splits/)
  })

  it('R15: dry run and offline compare make zero model or network calls; cost stays unknown when undeclared', async () => {
    const plan = dryRunResearchCases(manifest)
    expect(plan).toMatchObject({ requiresLive: 1, costKnown: false, estimatedCostUsd: null })
    expect(dryRunResearchCases(manifest, { split: 'target' })).toMatchObject({ costKnown: true, estimatedCostUsd: 0.06 })
    const configuredAdapter = vi.fn()
    let r = io()
    expect(await runResearchEvalCli(['--dry-run'], r.io, { configuredAdapter })).toBe(0)
    expect(JSON.parse(r.out[0]!)).toMatchObject({ modelCalls: 0, networkCalls: 0, costKnown: false })
    r = io()
    const base = new URL('../fixtures/', import.meta.url).pathname
    expect(await runResearchEvalCli(['--compare', `${base}baseline.trace.json`, `${base}candidate.trace.json`], r.io, { configuredAdapter })).toBe(1)
    expect(JSON.parse(r.out[0]!)).toMatchObject({ verification: 'local_verified', hardFailures: { newInCandidate: [{ caseId: 'regulation-scan' }, { caseId: 'regulation-scan' }] } })
    expect(configuredAdapter).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('R16: collection needs the preflight and an explicit confirmation, and refuses live cases by default', async () => {
    const adapter = { identity: { engine: { id: 'e', version: '1', config: {} }, runtime: { model: 'm', tools: [] } }, runCase: vi.fn() }
    const preflight = dryRunResearchCases(manifest, { split: 'target' })
    await expect(collectResearchTrace({ manifest, adapter, preflight: null, confirmed: true })).rejects.toMatchObject({ reason: 'preflight_required' })
    await expect(collectResearchTrace({ manifest, adapter, preflight, confirmed: false })).rejects.toMatchObject({ reason: 'confirmation_required' })
    await expect(collectResearchTrace({ manifest, adapter, preflight: dryRunResearchCases(manifest), confirmed: true })).rejects.toMatchObject({ reason: 'live_not_allowed' })
    expect(adapter.runCase).not.toHaveBeenCalled()
    const r = io()
    const configuredAdapter = vi.fn()
    expect(await runResearchEvalCli(['--collect', '--out', '/dev/null'], r.io, { configuredAdapter })).toBe(2)
    expect(r.err.join('\n')).toMatch(/--confirm/)
    expect(configuredAdapter).not.toHaveBeenCalled()
  })

  it('R16: the configured-provider adapter runs the real loop with the deep budget, current tools and metering', async () => {
    let turn = 0
    const chunks: StreamChunk[][] = [
      [{ type: 'message_start', model: 'fixture-model' }, { type: 'tool_use_start', id: 't1', name: 'urlReader' },
        { type: 'tool_use_delta', id: 't1', input: '{"url":"https://vendor-a.example/pricing"}' }, { type: 'tool_use_end', id: 't1' },
        { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } }],
      [{ type: 'message_start', model: 'fixture-model' }, { type: 'text_delta', text: 'Vendor A pricing is 10 per seat with email support. Source: https://vendor-a.example/pricing' },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 8 } }],
    ]
    const next = () => { const c = chunks[Math.min(turn++, 1)]!; return (async function* () { for (const x of c) yield x })() }
    const provider: LLMProvider = { name: 'fixture', models: ['fixture-model'], stream: next, createSession: () => ({ send: next }) }
    const urlReader = buildTool({ name: 'urlReader', description: 'read', inputSchema: z.object({ url: z.string() }), isReadOnly: true,
      async execute() { return { data: 'Vendor A charges 10 per seat.' } } })
    const costOf = vi.fn(() => 0.001)
    // The same runner shape the eval script binds to the configured provider.
    const run: Parameters<typeof createConfiguredProviderCollectionAdapter>[0]['run'] = async ({ caseId, systemPrompt, prompt, tools, maxTurns, onEvent }) => {
      let usage = null
      for await (const event of queryLoop({ ledger: NOOP_TURN_LEDGER, provider, model: 'fixture-model', systemPrompt, messages: [{ role: 'user', content: prompt }], tools, maxTurns,
        context: { userId: 'eval-user', assistantId: 'eval-assistant', sessionId: `eval-${caseId}`, appId: 'eval', channelType: 'web', channelId: 'eval', abortSignal: new AbortController().signal } })) {
        onEvent(event)
        if (event.type === 'turn_complete') usage = event.totalUsage ?? null
      }
      return { usage }
    }
    const adapter = createConfiguredProviderCollectionAdapter({ run, model: 'fixture-model', tools: new Map([['urlReader', urlReader], ['webSearch', urlReader]]),
      engine: { id: 'research-query-loop', version: 'test' }, costOf, now: () => 1000 })
    expect(adapter.identity.engine.config).toMatchObject({ maxTurns: 40, maxToolCalls: 35 })
    const preflight = dryRunResearchCases({ ...manifest, cases: [manifest.cases[0]] })
    const trace = await collectResearchTrace({ manifest: { ...manifest, cases: [manifest.cases[0]] }, adapter, preflight, confirmed: true })
    expect(trace.results[0]).toMatchObject({ caseId: 'vendor-pricing-a', status: 'completed', readSources: ['s1'], citedSources: ['s1'],
      coverage: ['pricing', 'support'], savedArtifact: { claimed: false, verified: false }, costUsd: 0.001 })
    expect(costOf).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    // A case whose required tool is unavailable is reported unavailable, not run.
    const missing = await adapter.runCase({ ...manifest.cases[0], requirements: { tools: ['browserRead'], live: false, estimatedCostUsd: null } })
    expect(missing.status).toBe('unavailable')
  })

  it('R14: a publishable case uses fabricated identities and data; real-looking values are refused', () => {
    for (const c of manifest.cases) expect(publishableCaseProblems(c)).toEqual([])
    const leaky = structuredClone(manifest.cases[0])
    leaky.request = 'Compare vendors for jane@acmecorp.io, call +1 212 448 1234'
    leaky.sources[0].ref = 'https://www.realcompany.com/pricing'
    leaky.context.priorArtifacts = ['Report 6f1c2a3b-1111-4222-8333-444455556666']
    const problems = publishableCaseProblems(leaky)
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/email domain acmecorp\.io/),
      expect.stringMatching(/555/),
      expect.stringMatching(/link host www\.realcompany\.com/),
      expect.stringMatching(/production-style id/),
    ]))
  })
})
