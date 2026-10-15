import { describe, expect, it, vi } from 'vitest'
import type { QueryEvent } from '@use-brian/core'
import type { ResearchActivity, SettleResearchActivityInput } from '../../db/research-store.js'
import { createResearchTurnObserver, recordResearchDelivery, researchTitleFor, type ResearchDeliveryDeps } from '../delivery.js'

const ACTOR = '00000000-0000-4000-8000-0000000000a1'
const PLANNED = '00000000-0000-4000-8000-0000000000b1'
const EXISTING = '00000000-0000-4000-8000-0000000000c1'
const FILE = '00000000-0000-4000-8000-0000000000d1'

function activity(over: Partial<ResearchActivity> = {}): ResearchActivity {
  return {
    id: '00000000-0000-4000-8000-0000000000e1', workspaceId: '00000000-0000-4000-8000-0000000000f1',
    sessionId: 's', requestMessageId: 'm0', outputMessageId: null, actorUserId: ACTOR, assistantId: 'a',
    projectId: null, taskId: null, predecessorActivityId: null, entry: 'explicit', status: 'running',
    plannedPageId: PLANNED, runtime: {}, sources: [], gaps: [], findingsCount: 0, summary: null, saveError: null,
    sensitivity: 'internal', compartments: [], revision: 1, createdAt: new Date(), completedAt: null, ...over,
  }
}

function deps(over: Partial<ResearchDeliveryDeps> = {}) {
  const settled: SettleResearchActivityInput[] = []
  const d: ResearchDeliveryDeps = {
    settle: vi.fn(async (input: SettleResearchActivityInput) => {
      settled.push(input)
      return activity({ status: input.status, saveError: input.saveError })
    }),
    inspect: vi.fn(async () => ({ readable: true, version: 3 })),
    writeDefaultPage: vi.fn(async (input) => ({ pageId: input.pageId, version: 1 })),
    ...over,
  }
  return { d, settled }
}

const toolInput = (id: string, name: string, input: Record<string, unknown>): QueryEvent => ({ type: 'tool_input', id, name, input })
const toolResult = (id: string, name: string, content: string, isError = false): QueryEvent =>
  ({ type: 'tool_result', id, results: [{ type: 'tool_result', toolUseId: id, name, content, isError }] })

describe('[COMP:api/research-delivery] Research delivery', () => {
  it('R01: authors one default Page through the canonical writer and links it only after inspection', async () => {
    const { d, settled } = deps()
    const obs = createResearchTurnObserver()
    obs.observeWorker(toolInput('w1', 'urlReader', { url: 'https://example.com/report' }))
    obs.observeWorker(toolResult('w1', 'urlReader', 'Full article text'))
    const out = await recordResearchDelivery(d, {
      activity: activity(), observation: obs.snapshot(), finalText: '## Findings\nMarket grew.', outputMessageId: 'm1', requestText: 'Research the widget market',
    })
    expect(d.writeDefaultPage).toHaveBeenCalledTimes(1)
    expect(d.writeDefaultPage).toHaveBeenCalledWith(expect.objectContaining({ pageId: PLANNED, title: 'Research the widget market', sensitivity: 'internal' }))
    expect(d.inspect).toHaveBeenCalledWith(ACTOR, 'page', PLANNED)
    expect(out.status).toBe('saved')
    expect(settled[0]).toMatchObject({ status: 'saved', outputMessageId: 'm1', saveError: null,
      links: [{ kind: 'page', artifactId: PLANNED, version: 1, relation: 'output', toolName: 'research.default_page' }] })
    expect(settled[0]!.sources).toEqual([expect.objectContaining({ kind: 'web', ref: 'https://example.com/report', inspected: true })])
  })

  it('R02: an explicit native write is used instead of a new report; editing an existing page is a revision', async () => {
    const { d, settled } = deps()
    const obs = createResearchTurnObserver()
    obs.observe(toolInput('t1', 'patchPage', { pageId: EXISTING, ops: [] }))
    obs.observe(toolResult('t1', 'patchPage', JSON.stringify({ kind: 'doc_patch', pageId: EXISTING, version: 7 })))
    obs.observe(toolInput('t2', 'fileWrite', { path: '/research/notes.md' }))
    obs.observe(toolResult('t2', 'fileWrite', `Saved /research/notes.md (40 bytes, text/markdown). id=${FILE}`))
    await recordResearchDelivery(d, { activity: activity(), observation: obs.snapshot(), finalText: 'Done.', outputMessageId: 'm1', requestText: 'x' })
    expect(d.writeDefaultPage).not.toHaveBeenCalled()
    expect(settled[0]!.links).toEqual([
      expect.objectContaining({ kind: 'page', artifactId: EXISTING, version: 7, relation: 'revision' }),
      expect.objectContaining({ kind: 'file', artifactId: FILE, version: 3, relation: 'output' }),
    ])
  })

  it('R03: a failed save keeps partial findings and gaps with a recovery reason, never saved', async () => {
    const { d, settled } = deps({ writeDefaultPage: vi.fn(async () => { throw Object.assign(new Error('nope'), { code: 'page_source_admission_required' }) }) })
    const obs = createResearchTurnObserver()
    obs.observeWorker(toolInput('g1', 'urlReader', { url: 'https://example.com/paywalled' }))
    obs.observeWorker(toolResult('g1', 'urlReader', 'HTTP 402', true))
    // Planning prose is narration, never a gap a user sees.
    obs.observe({ type: 'assistant_turn', toolResults: [],
      response: { content: [{ type: 'text', text: '<gap-assessment>Pricing: PARTIAL</gap-assessment>' }], stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 }, model: 'm' } } as QueryEvent)
    const out = await recordResearchDelivery(d, { activity: activity(), observation: obs.snapshot(), finalText: 'Partial answer', outputMessageId: 'm1', requestText: 'x' })
    expect(out.status).toBe('partial')
    expect(settled[0]).toMatchObject({ status: 'partial', saveError: 'page_source_admission_required', links: [], summary: 'Partial answer' })
    expect(settled[0]!.gaps).toEqual(['Not read: https://example.com/paywalled'])
    expect(settled[0]!.sources).toEqual([])
  })

  it('R03: false ids, narration and error results never create saved delivery', async () => {
    const { d, settled } = deps({ inspect: vi.fn(async () => ({ readable: false, version: null })) })
    const obs = createResearchTurnObserver()
    obs.observe(toolInput('t1', 'renderPage', {}))
    obs.observe(toolResult('t1', 'renderPage', `Failed to render page: ${EXISTING}`, true))
    // The model claims a page in prose; the observer never sees a receipt.
    const out = await recordResearchDelivery(d, {
      activity: activity({ plannedPageId: null }), observation: obs.snapshot(),
      finalText: `Saved your report as page ${EXISTING}.`, outputMessageId: 'm1', requestText: 'x',
    })
    expect(out.status).toBe('partial')
    expect(settled[0]).toMatchObject({ links: [], saveError: 'not_saved' })

    // A receipt the actor can no longer read is not linked either.
    const obs2 = createResearchTurnObserver()
    obs2.observe(toolInput('t2', 'renderPage', {}))
    obs2.observe(toolResult('t2', 'renderPage', JSON.stringify({ kind: 'doc_render', pageId: EXISTING, version: 1 })))
    await recordResearchDelivery(d, { activity: activity(), observation: obs2.snapshot(), finalText: 'ok', outputMessageId: 'm1', requestText: 'x' })
    expect(settled[1]).toMatchObject({ status: 'partial', links: [], saveError: 'artifact_not_readable' })
  })

  it('R03: an interrupted turn with nothing gathered fails honestly and writes no page', async () => {
    const { d, settled } = deps()
    const out = await recordResearchDelivery(d, { activity: activity(), observation: createResearchTurnObserver().snapshot(), finalText: '', outputMessageId: null, requestText: 'x', interrupted: true })
    expect(d.writeDefaultPage).not.toHaveBeenCalled()
    expect(out.status).toBe('failed')
    expect(settled[0]).toMatchObject({ status: 'failed', saveError: 'interrupted' })
  })

  it('R04: internal, external and browser reads inform one result; found links stay uninspected; workers cannot write', () => {
    const obs = createResearchTurnObserver()
    obs.observe(toolInput('r1', 'readPage', { pageId: EXISTING }))
    obs.observe(toolResult('r1', 'readPage', 'page body'))
    obs.observeWorker(toolInput('r2', 'webSearch', { query: 'widgets' }))
    obs.observeWorker(toolResult('r2', 'webSearch', 'Results: https://example.org/a https://example.org/b'))
    obs.observeWorker(toolInput('r3', 'browserRead', { url: 'https://example.net/login' }))
    obs.observeWorker(toolResult('r3', 'browserRead', 'Sign in required', true))
    obs.observeWorker(toolInput('r4', 'browserRead', { url: 'https://example.net/pricing' }))
    obs.observeWorker(toolResult('r4', 'browserRead', 'Pricing table'))
    // A worker reporting a write result is ignored: workers are read-only.
    obs.observeWorker(toolInput('r5', 'renderPage', {}))
    obs.observeWorker(toolResult('r5', 'renderPage', JSON.stringify({ kind: 'doc_render', pageId: FILE, version: 1 })))
    const snap = obs.snapshot()
    expect(snap.receipts).toEqual([])
    expect(snap.sources.map((s) => [s.kind, s.ref, s.inspected])).toEqual([
      ['page', EXISTING, true],
      ['web', 'https://example.org/a', false],
      ['web', 'https://example.org/b', false],
      ['browser', 'https://example.net/pricing', true],
    ])
  })

  it('R16: a confidential floor is passed to the writer, which may refuse', async () => {
    const { d } = deps()
    await recordResearchDelivery(d, { activity: activity({ sensitivity: 'confidential' }), observation: createResearchTurnObserver().snapshot(), finalText: 'x', outputMessageId: null, requestText: null })
    expect(d.writeDefaultPage).toHaveBeenCalledWith(expect.objectContaining({ sensitivity: 'confidential', title: 'Research' }))
  })

  it('titles a report from its request', () => {
    expect(researchTitleFor('  Compare   widget vendors  ')).toBe('Compare widget vendors')
    expect(researchTitleFor('x'.repeat(100))).toHaveLength(80)
  })
})
