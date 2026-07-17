import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the engine + the core tool factories so the helper's wiring (blueprint
// resolution, anchor key, renderPage exclusion) is asserted without a model/DB.
const synthesizeMock = vi.hoisted(() => vi.fn())
const loadBuiltinSkillsMock = vi.hoisted(() => vi.fn())
const createDocToolsMock = vi.hoisted(() => vi.fn())
const createCrmToolsMock = vi.hoisted(() => vi.fn())
const createTaskToolsMock = vi.hoisted(() => vi.fn())
const createMemoryToolsMock = vi.hoisted(() => vi.fn())

vi.mock('../synthesize.js', async (orig) => ({
  ...(await orig<typeof import('../synthesize.js')>()),
  synthesizeFromSource: synthesizeMock,
}))
vi.mock('@sidanclaw/core', async (orig) => ({
  ...(await orig<typeof import('@sidanclaw/core')>()),
  loadBuiltinSkills: loadBuiltinSkillsMock,
  createDocTools: createDocToolsMock,
  createCrmTools: createCrmToolsMock,
  createTaskTools: createTaskToolsMock,
  createMemoryTools: createMemoryToolsMock,
}))
vi.mock('../../recordings/recording-search-tool.js', () => ({
  createSearchRecordingTool: vi.fn(() => ({ name: 'searchRecording' })),
}))

import { createRecordingSynthesizer, type RecordingSynthesizerDeps } from '../recording-synthesizer.js'

const ARGS = {
  recordingId: 'rec-1',
  workspaceId: 'ws-1',
  userId: 'u-1',
  assistantId: 'a-1',
  sensitivity: 'confidential',
  blueprintSlug: 'my-blueprint',
}

function deps(over: Partial<RecordingSynthesizerDeps> = {}): RecordingSynthesizerDeps {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: {} as any,
    model: 'gemini-flash',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    savedViewStore: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    docPageStore: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    crmStore: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workflowRunStore: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workspaceDirectory: {} as any,
    ...over,
  }
}

describe('[COMP:api/recording-synthesizer] createRecordingSynthesizer', () => {
  beforeEach(() => {
    synthesizeMock.mockReset().mockResolvedValue({ pageId: 'page-1' })
    // There are no built-in blueprints anymore — the loader resolves nothing for
    // a blueprint slug, so resolution falls through to workspace / document.
    loadBuiltinSkillsMock.mockReset().mockReturnValue([])
    createDocToolsMock.mockReset().mockReturnValue({ renderPage: {}, patchPage: {}, getCurrentPage: {} })
    createCrmToolsMock.mockReset().mockReturnValue({ saveCompany: {}, saveContact: {}, saveDeal: {} })
    createTaskToolsMock.mockReset().mockReturnValue({ saveTask: {} })
    createMemoryToolsMock
      .mockReset()
      .mockReturnValue({ saveMemory: {}, getMemory: {}, deleteMemory: {} })
  })

  it('resolves a workspace-authored blueprint and runs synthesis on the recording anchor', async () => {
    const resolveWorkspaceBlueprint = vi.fn().mockResolvedValue({ body: 'WS BODY', title: 'My lens' })
    const res = await createRecordingSynthesizer(deps({ resolveWorkspaceBlueprint }))(ARGS)
    expect(res).toEqual({ pageId: 'page-1' })
    expect(synthesizeMock).toHaveBeenCalledTimes(1)
    expect(resolveWorkspaceBlueprint).toHaveBeenCalledWith('ws-1', 'my-blueprint')
    const [source, blueprint, target] = synthesizeMock.mock.calls[0]
    expect(source).toMatchObject({ kind: 'recording', sourceId: 'rec-1', sensitivity: 'confidential' })
    expect(blueprint).toMatchObject({ kind: 'skill', slug: 'my-blueprint', body: 'WS BODY' })
    // Recording fills render their brief page (per-surface default), with the
    // record riding underneath on the same anchor.
    expect(target).toMatchObject({ anchorKey: 'recording-synthesis:rec-1', renderPage: true })
  })

  it('excludes renderPage from the doc tools (the page-first brief must not be orphaned)', async () => {
    const resolveWorkspaceBlueprint = vi.fn().mockResolvedValue({ body: 'WS BODY', title: 'My lens' })
    await createRecordingSynthesizer(deps({ resolveWorkspaceBlueprint }))(ARGS)
    const engineDeps = synthesizeMock.mock.calls[0][3]
    const docTools = engineDeps.buildDocTools('page-1')
    expect(docTools.has('renderPage')).toBe(false)
    expect(docTools.has('patchPage')).toBe(true)
    expect(docTools.has('getCurrentPage')).toBe(true)
  })

  it('returns null without running synthesis when the blueprint is unresolved', async () => {
    loadBuiltinSkillsMock.mockReturnValue([])
    const res = await createRecordingSynthesizer(deps())({ ...ARGS, blueprintSlug: 'nope' })
    expect(res).toBeNull()
    expect(synthesizeMock).not.toHaveBeenCalled()
  })

  it('binds saveMemory (extracted, episode-anchored) only when a memory store is wired', async () => {
    const resolveWorkspaceBlueprint = vi.fn().mockResolvedValue({ body: 'WS BODY', title: 'T' })

    // Without a memory store: the CRM + task set only — the prompt must not
    // name a tool that is not bound (tool-awareness).
    await createRecordingSynthesizer(deps({ resolveWorkspaceBlueprint }))(ARGS)
    let engineDeps = synthesizeMock.mock.calls[0][3]
    expect(Array.from(engineDeps.brainWriteTools.keys())).toEqual([
      'saveCompany',
      'saveContact',
      'saveDeal',
      'saveTask',
    ])
    expect(createMemoryToolsMock).not.toHaveBeenCalled()

    // With one: saveMemory joins, built with extracted provenance anchored to
    // the recording Episode (the same anchors the CRM/task writes carry).
    synthesizeMock.mockClear()
    await createRecordingSynthesizer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps({ resolveWorkspaceBlueprint, memoryStore: { create: vi.fn() } as any }),
    )(ARGS)
    engineDeps = synthesizeMock.mock.calls[0][3]
    expect(engineDeps.brainWriteTools.has('saveMemory')).toBe(true)
    expect(createMemoryToolsMock).toHaveBeenCalledWith(expect.anything(), {
      writeSource: 'extracted',
      writeSourceEpisodeId: 'rec-1',
    })
  })

  it('resolves a document blueprint from a page template with an extraction spec', async () => {
    loadBuiltinSkillsMock.mockReturnValue([]) // no builtin / no workspace skill
    const pageTemplateStore = {
      getById: vi.fn().mockResolvedValue({
        id: 'tmpl-1',
        name: 'QBR',
        // The real store normalizes stored JSONB to the typed v2 contract on
        // read — the mock hands back what `getById` actually returns.
        extraction: {
          fields: [
            {
              key: 'account-health',
              heading: 'Account health',
              instruction: 'How are they doing',
              type: 'markdown',
              required: false,
              outputType: 'prose',
            },
          ],
          capture: ['company'],
        },
      }),
    }
    await createRecordingSynthesizer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps({ pageTemplateStore: pageTemplateStore as any }),
    )({ ...ARGS, blueprintSlug: 'tmpl-1' })
    expect(pageTemplateStore.getById).toHaveBeenCalledWith('u-1', 'tmpl-1')
    const bp = synthesizeMock.mock.calls[0][1]
    expect(bp).toMatchObject({ kind: 'document', slug: 'tmpl-1', title: 'QBR' })
    expect(bp.body).toContain('### 1. Account health')
    // The typed contract rides on the blueprint so the engine runs record-first.
    expect(bp.spec.fields[0].key).toBe('account-health')
  })
})
