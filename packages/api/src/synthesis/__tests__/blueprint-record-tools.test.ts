import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractionSpecSchema, type Tool, type ToolContext } from '@sidanclaw/core'
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
    status: 'incomplete',
    missing: ['summary'],
    sourceKind: 'chat',
    sourceId: 'sess-1',
    sensitivity: 'internal',
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
    expect(String((bad.data as { error: string }).error)).toContain('unknown field "nope"')
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
})
