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

import { extractionSpecSchema } from '@sidanclaw/core'
import { buildCitationIndex } from '@sidanclaw/shared'
import {
  synthesizeFromSource,
  type SynthesisSource,
  type SynthesisBlueprint,
  type SynthesisTarget,
  type SynthesizeDeps,
} from '../synthesize.js'
import type { BlueprintRecord } from '../../db/blueprint-records-store.js'

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

  it('without fullText, instructs the search-tool sweep', async () => {
    const { deps } = build()
    await synthesizeFromSource(SOURCE, BLUEPRINT, TARGET, deps)
    const { systemPrompt } = queryLoopMock.mock.calls[0][0]
    expect(systemPrompt).not.toContain('FULL TRANSCRIPT')
    expect(systemPrompt).toContain('read the recording END TO END') // the sweep fallback
  })

  it('injects the full transcript and drops the sweep when source.fullText is set', async () => {
    // A model told to sweep with a tool satisfices and briefs only the opening
    // (2026-07-15). Injecting the whole transcript removes the discretion.
    const { deps } = build()
    const transcript = '[0:00:01] Speaker 1: opening line.\n[1:35:12] Speaker 2: the very last line.'
    await synthesizeFromSource({ ...SOURCE, fullText: transcript }, BLUEPRINT, TARGET, deps)
    const { systemPrompt } = queryLoopMock.mock.calls[0][0]
    expect(systemPrompt).toContain('FULL TRANSCRIPT')
    expect(systemPrompt).toContain('the very last line.') // the whole thing is in the prompt
    expect(systemPrompt).toContain('Draft from ALL of it')
    expect(systemPrompt).not.toContain('read the recording END TO END') // sweep instruction dropped
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

  // ── Record-first fill (document blueprints with a typed contract) ──────

  const DOC_SPEC = extractionSpecSchema.parse({
    fields: [
      { key: 'summary', heading: 'Summary', instruction: 'sum it', type: 'markdown', required: true },
      { key: 'budget', heading: 'Budget', instruction: 'annual', type: 'number' },
    ],
    capture: [],
  })
  const DOC_BLUEPRINT: SynthesisBlueprint = {
    kind: 'document',
    slug: 'tmpl-1',
    body: 'DOC_BODY_MARKER',
    title: 'Account brief',
    spec: DOC_SPEC,
  }

  function recordDeps() {
    const ensure = vi.fn().mockResolvedValue({ id: 'rec-row-1' } as BlueprintRecord)
    const mergeFields = vi.fn().mockResolvedValue(true)
    const finalize = vi.fn().mockResolvedValue(null)
    const projectRecordPage = vi.fn().mockResolvedValue(true)
    return { ensure, mergeFields, finalize, projectRecordPage }
  }

  it('record path: ensures the record BEFORE the loop, sinks via writeField, no doc tools', async () => {
    const rec = recordDeps()
    const { deps, createDraft } = build({
      blueprintRecordStore: { ensure: rec.ensure, mergeFields: rec.mergeFields, finalize: rec.finalize },
      projectRecordPage: rec.projectRecordPage,
    })
    queryLoopMock.mockImplementation((opts: { tools: Map<string, Tool> }) =>
      (async function* () {
        const wf = opts.tools.get('writeField')
        if (!wf) throw new Error('writeField missing from tool map')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ok = await wf.execute({ key: 'summary', value: 'All good.' } as any, {} as any)
        expect(ok.isError).not.toBe(true)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bad = await wf.execute({ key: 'budget', value: 'lots' } as any, {} as any)
        expect(bad.isError).toBe(true)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unknown = await wf.execute({ key: 'nope', value: 1 } as any, {} as any)
        expect(unknown.isError).toBe(true)
        yield* gen(HAPPY)
      })(),
    )
    const res = await synthesizeFromSource(
      SOURCE,
      DOC_BLUEPRINT,
      { anchorKey: 'recording-synthesis:rec-1', renderPage: false, recordSubject: 'Acme' },
      deps,
    )

    // Record ensured before the model loop, on the shared anchor, fields reset.
    expect(rec.ensure).toHaveBeenCalledTimes(1)
    expect(rec.ensure.mock.invocationCallOrder[0]).toBeLessThan(queryLoopMock.mock.invocationCallOrder[0])
    expect(rec.ensure.mock.calls[0][1]).toMatchObject({
      blueprintId: 'tmpl-1',
      anchorKey: 'recording-synthesis:rec-1',
      subject: 'Acme',
      sourceKind: 'recording',
      sensitivity: 'confidential',
      resetFields: true,
    })

    // Record-only: no page minted, no doc tools in the map.
    expect(createDraft).not.toHaveBeenCalled()
    expect(res.pageId).toBeNull()
    const { tools, systemPrompt } = queryLoopMock.mock.calls[0][0]
    expect(tools.has('patchPage')).toBe(false)
    expect(tools.has('writeField')).toBe(true)
    expect(systemPrompt).toContain('DOC_BODY_MARKER')
    expect(systemPrompt).toContain('writeField')

    // Only the VALID write merged; completeness from required coverage.
    expect(rec.mergeFields).toHaveBeenCalledTimes(1)
    // No citation index wired ⇒ no citations argument; the value merge is unchanged.
    expect(rec.mergeFields).toHaveBeenCalledWith('u-1', 'rec-row-1', { summary: 'All good.' }, undefined)
    expect(rec.finalize).toHaveBeenCalledWith('u-1', 'rec-row-1', {
      status: 'complete',
      missing: [],
      pageId: null,
    })
    expect(res.recordId).toBe('rec-row-1')
    expect(res.recordStatus).toBe('complete')
    expect(rec.projectRecordPage).not.toHaveBeenCalled()
  })

  it('record path: renders the page projection from the record when the surface renders', async () => {
    const rec = recordDeps()
    const { deps, createDraft } = build({
      blueprintRecordStore: { ensure: rec.ensure, mergeFields: rec.mergeFields, finalize: rec.finalize },
      projectRecordPage: rec.projectRecordPage,
    })
    queryLoopMock.mockImplementation((opts: { tools: Map<string, Tool> }) =>
      (async function* () {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await opts.tools.get('writeField')!.execute({ key: 'summary', value: 'Done.' } as any, {} as any)
        yield* gen(HAPPY)
      })(),
    )
    const res = await synthesizeFromSource(
      SOURCE,
      DOC_BLUEPRINT,
      { anchorKey: 'recording-synthesis:rec-1', renderPage: true },
      deps,
    )
    expect(createDraft).toHaveBeenCalledTimes(1)
    expect(res.pageId).toBe('page-new')
    expect(rec.projectRecordPage).toHaveBeenCalledTimes(1)
    const projected = rec.projectRecordPage.mock.calls[0][0]
    expect(projected.pageId).toBe('page-new')
    expect(projected.blocks.some((b: { kind: string }) => b.kind === 'heading')).toBe(true)
    expect(rec.finalize).toHaveBeenCalledWith('u-1', 'rec-row-1', {
      status: 'complete',
      missing: [],
      pageId: 'page-new',
    })
  })

  // ── Typed citations (migration 337) ───────────────────────────────────
  //
  // The model cites `[H:MM:SS]` in the field's prose; the write path resolves
  // each moment against the transcript and persists it as a typed pointer
  // BESIDE the value — never inside it.

  const CITE_INDEX = buildCitationIndex(
    [
      { segmentIndex: 0, startMs: 0, endMs: 30_000, speaker: 'Ken' },
      { segmentIndex: 38, startMs: 2_800_000, endMs: 2_900_000, speaker: 'Priya' },
    ],
    2_900_000,
  )

  it('citations: resolves the moments a field cites and merges them beside the value', async () => {
    const rec = recordDeps()
    const { deps } = build({
      blueprintRecordStore: { ensure: rec.ensure, mergeFields: rec.mergeFields, finalize: rec.finalize },
      citationIndex: CITE_INDEX,
    })
    queryLoopMock.mockImplementation((opts: { tools: Map<string, Tool> }) =>
      (async function* () {
        const res = await opts.tools.get('writeField')!.execute(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { key: 'summary', value: 'Ship Cantonese in Q3 [0:47:21].' } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {} as any,
        )
        // The count is fed back so a model can notice an ungrounded field.
        expect((res.data as { cited: number }).cited).toBe(1)
        yield* gen(HAPPY)
      })(),
    )
    await synthesizeFromSource(SOURCE, DOC_BLUEPRINT, { anchorKey: 'k', renderPage: false }, deps)

    const [, , patch, citations] = rec.mergeFields.mock.calls[0]
    // The VALUE is untouched prose — every downstream reader (page projection,
    // getBlueprintRecord, send_page's recordField, {{lastRun.output.*}}) does
    // String() on it, so a nested { value, citations } would ship
    // "[object Object]" to all four.
    expect(patch).toEqual({ summary: 'Ship Cantonese in Q3 [0:47:21].' })
    expect(citations).toEqual({
      summary: [{ startMs: 2_841_000, segmentIndex: 38, speaker: 'Priya', confidence: 'parsed' }],
    })
  })

  it('citations: drops a moment past the end of the transcript', async () => {
    const rec = recordDeps()
    const { deps } = build({
      blueprintRecordStore: { ensure: rec.ensure, mergeFields: rec.mergeFields, finalize: rec.finalize },
      citationIndex: CITE_INDEX,
    })
    queryLoopMock.mockImplementation((opts: { tools: Map<string, Tool> }) =>
      (async function* () {
        // The transcript ends at 2,900,000ms — [2:00:00] never happened.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await opts.tools.get('writeField')!.execute({ key: 'summary', value: 'We agreed [2:00:00].' } as any, {} as any)
        yield* gen(HAPPY)
      })(),
    )
    await synthesizeFromSource(SOURCE, DOC_BLUEPRINT, { anchorKey: 'k', renderPage: false }, deps)

    const [, , patch, citations] = rec.mergeFields.mock.calls[0]
    // The prose is kept as the model wrote it; only the POINTER is refused.
    expect(patch).toEqual({ summary: 'We agreed [2:00:00].' })
    expect(citations).toEqual({ summary: [] })
  })

  it('citations: re-writing a key replaces its citations rather than accumulating them', async () => {
    const rec = recordDeps()
    const { deps } = build({
      blueprintRecordStore: { ensure: rec.ensure, mergeFields: rec.mergeFields, finalize: rec.finalize },
      citationIndex: CITE_INDEX,
    })
    queryLoopMock.mockImplementation((opts: { tools: Map<string, Tool> }) =>
      (async function* () {
        const wf = opts.tools.get('writeField')!
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await wf.execute({ key: 'summary', value: 'First draft [0:47:21].' } as any, {} as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await wf.execute({ key: 'summary', value: 'Rewritten, no citation.' } as any, {} as any)
        yield* gen(HAPPY)
      })(),
    )
    await synthesizeFromSource(SOURCE, DOC_BLUEPRINT, { anchorKey: 'k', renderPage: false }, deps)

    // The key is present-but-empty, not absent: `field_citations || {...}` only
    // overwrites keys it carries, so an omitted key would strand the first
    // draft's moment on replacement text that no longer cites it.
    const [, , , citations] = rec.mergeFields.mock.calls[1]
    expect(citations).toEqual({ summary: [] })
  })

  it('citations: a non-recording fill writes values with no citations argument', async () => {
    const rec = recordDeps()
    const { deps } = build({
      blueprintRecordStore: { ensure: rec.ensure, mergeFields: rec.mergeFields, finalize: rec.finalize },
    })
    queryLoopMock.mockImplementation((opts: { tools: Map<string, Tool> }) =>
      (async function* () {
        const res = await opts.tools.get('writeField')!.execute(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { key: 'summary', value: 'A brain draft [0:47:21].' } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {} as any,
        )
        // No transcript to validate against ⇒ no claim about coverage at all.
        expect(res.data).not.toHaveProperty('cited')
        yield* gen(HAPPY)
      })(),
    )
    await synthesizeFromSource(SOURCE, DOC_BLUEPRINT, { anchorKey: 'k', renderPage: false }, deps)
    expect(rec.mergeFields.mock.calls[0][3]).toBeUndefined()
  })

  it('record path: a fill missing required fields finalizes incomplete with the missing keys', async () => {
    const rec = recordDeps()
    const { deps } = build({
      blueprintRecordStore: { ensure: rec.ensure, mergeFields: rec.mergeFields, finalize: rec.finalize },
    })
    queryLoopMock.mockImplementation(() => gen(HAPPY)) // model writes nothing
    const res = await synthesizeFromSource(
      SOURCE,
      DOC_BLUEPRINT,
      { anchorKey: 'k', renderPage: false },
      deps,
    )
    expect(res.recordStatus).toBe('incomplete')
    expect(res.missing).toEqual(['summary'])
    expect(rec.finalize).toHaveBeenCalledWith('u-1', 'rec-row-1', {
      status: 'incomplete',
      missing: ['summary'],
      pageId: null,
    })
  })

  it('legacy (spec-less) path is untouched: no record calls, page authored via doc tools', async () => {
    const rec = recordDeps()
    const { deps } = build({
      blueprintRecordStore: { ensure: rec.ensure, mergeFields: rec.mergeFields, finalize: rec.finalize },
    })
    const res = await synthesizeFromSource(SOURCE, BLUEPRINT, TARGET, deps)
    expect(rec.ensure).not.toHaveBeenCalled()
    expect(res.recordId).toBeNull()
    expect(res.recordStatus).toBeNull()
    expect(queryLoopMock.mock.calls[0][0].tools.has('patchPage')).toBe(true)
  })
})
