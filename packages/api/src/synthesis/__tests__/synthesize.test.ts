import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import type { Tool } from '@sidanclaw/core'

// Partial-mock the core barrel: only `queryLoop` is scripted, so the runner's
// orchestration (page-first, idempotency, system prompt, tool map, COGS,
// timeout) is asserted without a real model. resolveResearchBudget stays real.
const queryLoopMock = vi.hoisted(() => vi.fn())
vi.mock('@sidanclaw/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sidanclaw/core')>()
  return { ...actual, queryLoop: queryLoopMock }
})

import {
  synthesizeFromSource,
  type SynthesisSource,
  type SynthesisBlueprint,
  type SynthesisTarget,
  type SynthesizeDeps,
} from '../synthesize.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function* gen(events: any[]) {
  for (const e of events) yield e
}

const HAPPY = [
  { type: 'tool_start', name: 'searchRecording' },
  { type: 'text_delta', text: 'Logged Acme: 1 company, 2 contacts, 1 deal.' },
  {
    type: 'turn_complete',
    totalUsage: { inputTokens: 1200, outputTokens: 300 },
    response: { model: 'gemini-flash', content: [] },
  },
]

function toolStub(name: string, requiresConfirmation = true): Tool {
  return {
    name,
    description: name,
    inputSchema: z.object({}),
    execute: async () => ({ data: null }),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation,
  }
}

const SOURCE: SynthesisSource = {
  kind: 'recording',
  sourceId: 'rec-1',
  workspaceId: 'ws-1',
  userId: 'u-1',
  assistantId: 'a-1',
  assistantKind: 'standard',
  sensitivity: 'confidential',
}
const BLUEPRINT: SynthesisBlueprint = {
  kind: 'skill',
  slug: 'my-blueprint',
  body: 'BLUEPRINT_BODY_MARKER — query searchRecording per concern, then saveCompany.',
  title: 'Account brief',
}
const TARGET: SynthesisTarget = { anchorKey: 'recording-synthesis:rec-1' }

function build(overrides: Partial<SynthesizeDeps> = {}) {
  const createDraft = vi.fn().mockResolvedValue({ id: 'page-new' })
  const findIdByAnchorKey = vi.fn().mockResolvedValue(null)
  const recordUsage = vi.fn().mockResolvedValue(undefined)
  const deps: SynthesizeDeps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: {} as any,
    model: 'gemini-flash',
    sourceTool: toolStub('searchRecording', false),
    buildDocTools: () =>
      new Map([
        ['patchPage', toolStub('patchPage')],
        ['getCurrentPage', toolStub('getCurrentPage')],
      ]),
    brainWriteTools: new Map([['saveCompany', toolStub('saveCompany')]]),
    savedViewStore: { createDraft, findIdByAnchorKey },
    usageStore: { recordUsage },
    computeCostUsd: () => 0.01,
    ...overrides,
  }
  return { deps, createDraft, findIdByAnchorKey, recordUsage }
}

describe('[COMP:api/synthesize] structural-synthesis runner', () => {
  beforeEach(() => {
    queryLoopMock.mockReset().mockImplementation(() => gen(HAPPY))
  })

  it('is page-first: creates the brief page BEFORE the model loop and pins docViewId to it', async () => {
    const { deps, createDraft } = build()
    const res = await synthesizeFromSource(SOURCE, BLUEPRINT, TARGET, deps)

    expect(createDraft).toHaveBeenCalledTimes(1)
    expect(createDraft.mock.invocationCallOrder[0]).toBeLessThan(queryLoopMock.mock.invocationCallOrder[0])
    const opts = queryLoopMock.mock.calls[0][0]
    expect(opts.context.docViewId).toBe('page-new')
    expect(res.pageId).toBe('page-new')
    expect(res.summary).toContain('Logged Acme')
    expect(res.toolCallCount).toBe(1)
    expect(res.truncated).toBe(false)

    // anchorKey is carried onto the draft for idempotent re-runs
    expect(createDraft.mock.calls[0][0]).toMatchObject({ anchorKey: 'recording-synthesis:rec-1' })
  })

  it('is idempotent: an existing anchor page is reused, not duplicated', async () => {
    const { deps, createDraft, findIdByAnchorKey } = build()
    findIdByAnchorKey.mockResolvedValue('page-existing')
    const res = await synthesizeFromSource(SOURCE, BLUEPRINT, TARGET, deps)

    expect(createDraft).not.toHaveBeenCalled()
    expect(res.pageId).toBe('page-existing')
    expect(queryLoopMock.mock.calls[0][0].context.docViewId).toBe('page-existing')
  })

  it('makes the blueprint body the system prompt and inherits source sensitivity', async () => {
    const { deps } = build()
    await synthesizeFromSource(SOURCE, BLUEPRINT, TARGET, deps)
    const { systemPrompt } = queryLoopMock.mock.calls[0][0]
    expect(systemPrompt).toContain('BLUEPRINT_BODY_MARKER')
    expect(systemPrompt).toContain('confidential') // sensitivity threaded into the envelope
    expect(systemPrompt).toContain('searchRecording')
  })

  it('assembles the tool map (source + doc + brain) and strips confirmation for the unattended run', async () => {
    const { deps } = build()
    await synthesizeFromSource(SOURCE, BLUEPRINT, TARGET, deps)
    const { tools, context } = queryLoopMock.mock.calls[0][0]
    expect([...tools.keys()].sort()).toEqual(['getCurrentPage', 'patchPage', 'saveCompany', 'searchRecording'])
    expect(tools.get('patchPage').requiresConfirmation).toBe(false)
    expect(tools.get('saveCompany').requiresConfirmation).toBe(false)
    expect(context.activeCapabilities.has('crm')).toBe(true)
    expect(context.activeCapabilities.has('tasks')).toBe(true)
  })

  it('records synthesis COGS as overhead (out of the credit derivation) with a null session', async () => {
    const { deps, recordUsage } = build()
    await synthesizeFromSource(SOURCE, BLUEPRINT, TARGET, deps)
    expect(recordUsage).toHaveBeenCalledTimes(1)
    expect(recordUsage.mock.calls[0][0]).toMatchObject({
      source: 'overhead:synthesis',
      triggerKey: 'structural_synthesis',
      sessionId: null,
      model: 'gemini-flash',
      actualCostUsd: 0.01,
    })
  })

  it('propagates a non-abort loop error', async () => {
    const { deps } = build()
    queryLoopMock.mockImplementation(() => gen([{ type: 'error', error: new Error('provider boom') }]))
    await expect(synthesizeFromSource(SOURCE, BLUEPRINT, TARGET, deps)).rejects.toThrow('provider boom')
  })

  it('returns truncated:true with the page when the wall-clock budget aborts', async () => {
    const { deps } = build({ budget: { timeoutMs: 1 } }) // clamps to the 1s floor
    queryLoopMock.mockImplementation((opts: { context: { abortSignal: AbortSignal } }) =>
      (async function* () {
        await new Promise((_resolve, reject) => {
          opts.context.abortSignal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        })
        yield { type: 'turn_complete' } // never reached
      })(),
    )
    const res = await synthesizeFromSource(SOURCE, BLUEPRINT, TARGET, deps)
    expect(res.truncated).toBe(true)
    expect(res.pageId).toBe('page-new')
  })
})
