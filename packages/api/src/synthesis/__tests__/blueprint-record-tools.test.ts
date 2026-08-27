import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractionSpecSchema, type Tool, type ToolContext } from '@use-brian/core'
import {
  blueprintSubjectAnchorKey,
  buildBlueprintSurfacePrompt,
  createBlueprintRecordTools,
} from '../blueprint-record-tools.js'
import type { BlueprintRecord } from '../../db/blueprint-records-store.js'

const SPEC = extractionSpecSchema.parse({
  fields: [
    { key: 'summary', heading: 'Summary', instruction: 's', type: 'markdown', required: true },
    { key: 'budget', heading: 'Budget', instruction: 'b', type: 'number' },
    { key: 'stage', heading: 'Stage', instruction: 'pick', type: 'enum', options: ['Prospect', 'Won'] },
  ],
  capture: ['company'],
})

const TEMPLATE = {
  id: 'bp-1',
  workspaceId: 'ws-1',
  createdBy: 'u-1',
  name: 'Discovery Brief',
  description: 'Post-call brief',
  icon: null,
  category: 'knowledge' as const,
  extraction: SPEC,
  createdAt: '2026-07-07T00:00:00.000Z',
  updatedAt: '2026-07-07T00:00:00.000Z',
}
const SKELETON = { ...TEMPLATE, id: 'tpl-2', name: 'Plain skeleton', extraction: null }

const CTX = { userId: 'u-1', workspaceId: 'ws-1', sessionId: 'sess-1', channelType: 'web' } as ToolContext

function record(over: Partial<BlueprintRecord> = {}): BlueprintRecord {
  return {
    id: 'r-1',
    workspaceId: 'ws-1',
    blueprintId: 'bp-1',
    specSnapshot: SPEC.fields,
    subject: 'Acme',
    anchorKey: blueprintSubjectAnchorKey('ws-1', 'bp-1', 'Acme'),
    fields: {},
    // A chat-origin record has no transcript to cite — citations stay empty.
    fieldCitations: {},
    status: 'incomplete',
    missing: ['summary'],
    sourceKind: 'chat',
    sourceId: 'sess-1',
    sensitivity: 'internal',
    compartments: [],
    projectIds: [],
    pageId: null,
    createdBy: 'u-1',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...over,
  }
}

function build() {
  const pageTemplateStore = {
    list: vi.fn().mockResolvedValue([TEMPLATE, SKELETON]),
    getById: vi.fn(),
    create: vi.fn().mockResolvedValue({ ...TEMPLATE, id: 'bp-new', name: 'Weekly Report' }),
    update: vi.fn(),
    remove: vi.fn(),
  }
  const blueprintRecordStore = {
    ensure: vi.fn().mockResolvedValue(record()),
    mergeFields: vi.fn().mockResolvedValue(true),
    finalize: vi.fn().mockImplementation(async (_u: string, _id: string, o: { status: string; missing: string[] }) =>
      record({ fields: { summary: 'Done.' }, status: o.status as never, missing: o.missing }),
    ),
    getById: vi.fn().mockResolvedValue(record()),
    getByAnchor: vi.fn(),
    getByPageId: vi.fn(),
    getLatestForSource: vi.fn(),
    getLatestBySubject: vi.fn().mockResolvedValue(record({ status: 'complete', missing: [], fields: { summary: 'x' } })),
    listForBlueprint: vi.fn().mockResolvedValue([record()]),
  }
  const tools = createBlueprintRecordTools({ pageTemplateStore, blueprintRecordStore })
  const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]))
  return { pageTemplateStore, blueprintRecordStore, byName }
}

describe('[COMP:api/blueprint-record-tools] direct record surface', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exposes exactly the four contract tools; only createBlueprint needs confirmation', () => {
    const { byName } = build()
    expect([...byName.keys()].sort()).toEqual([
      'createBlueprint',
      'getBlueprintRecord',
      'listBlueprints',
      'saveBlueprintRecord',
    ])
    expect(byName.get('createBlueprint')!.requiresConfirmation).toBe(true)
    expect(byName.get('saveBlueprintRecord')!.requiresConfirmation).toBe(false)
    expect(byName.get('listBlueprints')!.isReadOnly).toBe(true)
    expect(byName.get('getBlueprintRecord')!.isReadOnly).toBe(true)
  })

  it('listBlueprints returns only spec-carrying templates with their field contracts', async () => {
    const { byName } = build()
    const res = await byName.get('listBlueprints')!.execute({}, CTX)
    const data = res.data as { blueprints: Array<{ id: string; fields: Array<{ key: string }> }> }
    expect(data.blueprints).toHaveLength(1)
    expect(data.blueprints[0].id).toBe('bp-1')
    expect(data.blueprints[0].fields.map((f) => f.key)).toEqual(['summary', 'budget', 'stage'])
  })

  it('saveBlueprintRecord validates keys + values, merges (no reset), and finalizes completeness', async () => {
    const { byName, blueprintRecordStore } = build()
    const res = await byName.get('saveBlueprintRecord')!.execute(
      { blueprint: 'discovery', subject: 'Acme', fields: { summary: 'Done.', budget: '120' } },
      CTX,
    )
    expect(res.isError).toBeFalsy()
    // Direct saves merge over the existing record — never a fresh-fill reset —
    // and share the generate-fill anchor so one subject = one record.
    expect(blueprintRecordStore.ensure.mock.calls[0][1]).toMatchObject({
      blueprintId: 'bp-1',
      subject: 'Acme',
      anchorKey: blueprintSubjectAnchorKey('ws-1', 'bp-1', 'Acme'),
      sourceKind: 'chat',
      resetFields: false,
    })
    expect(blueprintRecordStore.mergeFields).toHaveBeenCalledWith('u-1', 'r-1', {
      summary: 'Done.',
      budget: 120,
    })
    expect(blueprintRecordStore.finalize.mock.calls[0][2]).toMatchObject({ status: 'complete', missing: [] })
  })

  it('saveBlueprintRecord rejects unknown keys and invalid values without writing', async () => {
    const { byName, blueprintRecordStore } = build()
    const bad = await byName.get('saveBlueprintRecord')!.execute(
      { blueprint: 'Discovery Brief', subject: 'Acme', fields: { nope: 1, budget: 'lots' } },
      CTX,
    )
    expect(bad.isError).toBe(true)
    // Message-first TEXT, not `{ error }` JSON: the subject that failed, the
    // fact that nothing was written, every rejected value, the valid keys, and
    // the retry verdict. docs/architecture/engine/tool-executor.md → "Failure copy".
    const text = bad.data as string
    expect(typeof text).toBe('string')
    expect(text).toContain('saveBlueprintRecord did not save the "Discovery Brief" record for "Acme"')
    expect(text).toContain('Nothing was saved.')
    expect(text).toContain('unknown field "nope"')
    expect(text).toContain('Field keys on this blueprint:')
    expect(text).toMatch(/rejected the same way/i)
    expect(blueprintRecordStore.ensure).not.toHaveBeenCalled()
    expect(blueprintRecordStore.mergeFields).not.toHaveBeenCalled()
  })

  it('getBlueprintRecord reads latest-by-subject and surfaces status for handoff checks', async () => {
    const { byName, blueprintRecordStore } = build()
    const res = await byName.get('getBlueprintRecord')!.execute(
      { blueprint: 'Discovery Brief', subject: 'Acme' },
      CTX,
    )
    expect(res.isError).toBeFalsy()
    expect(blueprintRecordStore.getLatestBySubject).toHaveBeenCalledWith('u-1', 'ws-1', 'bp-1', 'Acme')
    expect((res.data as { status: string }).status).toBe('complete')
  })

  it('createBlueprint auto-keys headings, validates the contract, and mints via the template store', async () => {
    const { byName, pageTemplateStore } = build()
    const res = await byName.get('createBlueprint')!.execute(
      {
        name: 'Weekly Report',
        fields: [
          { heading: 'Highlights', instruction: 'top 3', required: true },
          { heading: 'Risk level', instruction: 'pick', type: 'enum', options: ['low', 'high'] },
        ],
        capture: ['task'],
      },
      CTX,
    )
    expect(res.isError).toBeFalsy()
    const created = pageTemplateStore.create.mock.calls[0][1]
    expect(created.extraction.fields.map((f: { key: string }) => f.key)).toEqual(['highlights', 'risk-level'])
    expect(created.blocks.length).toBeGreaterThan(0)
    expect(created.category).toBe('knowledge')
    expect((res.data as { blueprintId: string }).blueprintId).toBe('bp-new')
  })

  it('createBlueprint rejects an invalid contract (enum without options)', async () => {
    const { byName, pageTemplateStore } = build()
    const res = await byName.get('createBlueprint')!.execute(
      { name: 'X', fields: [{ heading: 'Stage', instruction: 'pick', type: 'enum' }] },
      CTX,
    )
    expect(res.isError).toBe(true)
    expect(pageTemplateStore.create).not.toHaveBeenCalled()
  })

  it('buildBlueprintSurfacePrompt is closed-world: empty without blueprints, lists what exists', () => {
    expect(buildBlueprintSurfacePrompt([SKELETON])).toBe('')
    const prompt = buildBlueprintSurfacePrompt([TEMPLATE, SKELETON])
    expect(prompt).toContain('Discovery Brief')
    expect(prompt).toContain('summary*') // required marker
    expect(prompt).toContain('saveBlueprintRecord')
    expect(prompt).toContain('never save unbound work silently')
    expect(prompt).not.toContain('Plain skeleton')
  })

  // ── projectBlueprintRecordPage (page-actions §4.6) ──────────────────────

  function buildWithProjection() {
    const base = build()
    const createDraft = vi.fn().mockResolvedValue({ id: 'page-9' })
    const findIdByAnchorKey = vi.fn().mockResolvedValue(null)
    const applyPatch = vi.fn().mockResolvedValue({ newVersion: 2 })
    const getVersionedPage = vi.fn().mockResolvedValue({
      page: { blocks: [{ id: 'old-1', kind: 'text', text: 'stale' }] },
      version: 1,
    })
    const tools = createBlueprintRecordTools({
      pageTemplateStore: base.pageTemplateStore as never,
      blueprintRecordStore: base.blueprintRecordStore as never,
      savedViewStore: { createDraft, findIdByAnchorKey } as never,
      docPageStore: { getVersionedPage, applyPatch } as never,
    })
    const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]))
    return { ...base, byName, createDraft, findIdByAnchorKey, applyPatch, getVersionedPage }
  }

  it('is built only when the projection deps are wired', () => {
    const { byName } = build()
    expect(byName.has('projectBlueprintRecordPage')).toBe(false)
    const withDeps = buildWithProjection()
    expect(withDeps.byName.has('projectBlueprintRecordPage')).toBe(true)
  })

  it('projects a record to a new page with a verbatim draftMarkdown body and links pageId', async () => {
    const h = buildWithProjection()
    const res = await h.byName.get('projectBlueprintRecordPage')!.execute(
      {
        blueprint: 'Discovery Brief',
        subject: 'Acme',
        parentPageId: '00000000-0000-0000-0000-00000000abcd',
        draftMarkdown: 'Hi Bernard,\n\nQuick intro about Siu Gam.',
      },
      CTX,
    )
    expect(res.isError).toBeUndefined()
    expect(res.data).toMatchObject({ projected: true, pageId: 'page-9', recordId: 'r-1', body: 'draft' })
    // find-or-create on the record's own anchor key, nested + system-written.
    expect(h.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorKey: blueprintSubjectAnchorKey('ws-1', 'bp-1', 'Acme'),
        nestParentId: '00000000-0000-0000-0000-00000000abcd',
        writtenBy: 'system',
      }),
    )
    // Body = the draft markdown ONLY — no record-field scaffolding leaks into
    // what send_page will email.
    const patch = h.applyPatch.mock.calls[0][0] as { nextPage: { blocks: Array<{ text?: string }> } }
    const bodyText = JSON.stringify(patch.nextPage.blocks)
    expect(bodyText).toContain('Quick intro about Siu Gam')
    expect(bodyText).not.toContain('Summary')
    // The projection is linked back onto the record.
    expect(h.blueprintRecordStore.finalize).toHaveBeenCalledWith(
      'u-1',
      'r-1',
      expect.objectContaining({ pageId: 'page-9' }),
    )
  })

  it('errors honestly when the record does not exist yet', async () => {
    const h = buildWithProjection()
    h.blueprintRecordStore.getLatestBySubject.mockResolvedValueOnce(null)
    const res = await h.byName.get('projectBlueprintRecordPage')!.execute(
      { blueprint: 'Discovery Brief', subject: 'Nobody' },
      CTX,
    )
    expect(res.isError).toBe(true)
    const text = res.data as string
    expect(typeof text).toBe('string')
    // Names the target it could not resolve, says no page was touched, points
    // at the tool that mints the record, and forbids the identical retry.
    expect(text).toContain('blueprint "Discovery Brief" + subject "Nobody"')
    expect(text).toContain('No page was created or changed.')
    expect(text).toContain('saveBlueprintRecord')
    expect(text).toContain('Do NOT retry this exact target.')
  })

  it('names the blueprints that exist when the requested one does not', async () => {
    const h = buildWithProjection()
    const res = await h.byName.get('getBlueprintRecord')!.execute({ blueprint: 'Ghost Brief' }, CTX)
    expect(res.isError).toBe(true)
    const text = res.data as string
    expect(text).toContain('no blueprint in this workspace matches "Ghost Brief"')
    expect(text).toContain('Blueprints in this workspace right now: Discovery Brief')
    expect(text).toContain('Do NOT retry this exact name.')
  })

  it('gives a record-id miss the discovery pointer instead of "No record <id>."', async () => {
    const h = buildWithProjection()
    h.blueprintRecordStore.getById.mockResolvedValueOnce(null)
    const res = await h.byName.get('getBlueprintRecord')!.execute({ recordId: 'r-404' }, CTX)
    expect(res.isError).toBe(true)
    const text = res.data as string
    expect(text).toContain('Blueprint record `r-404` not found in this workspace.')
    expect(text).toContain('listBlueprints')
    expect(text).toContain('Do NOT retry this exact id.')
  })
})
