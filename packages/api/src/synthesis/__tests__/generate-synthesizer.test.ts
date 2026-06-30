import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the engine + the core tool factories + the brain source tool so the
// helper's wiring (blueprint resolution, anchor key, brain-as-source,
// renderPage exclusion) is asserted without a model / DB.
const synthesizeMock = vi.hoisted(() => vi.fn())
const loadBuiltinSkillsMock = vi.hoisted(() => vi.fn())
const createDocToolsMock = vi.hoisted(() => vi.fn())
const createCrmToolsMock = vi.hoisted(() => vi.fn())
const createTaskToolsMock = vi.hoisted(() => vi.fn())

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
}))
vi.mock('../brain-source-tool.js', () => ({
  createBrainSourceTool: vi.fn(() => ({ name: 'searchSource' })),
}))

import { createGenerateSynthesizer, type GenerateSynthesizerDeps } from '../generate-synthesizer.js'
import { createBrainSourceTool } from '../brain-source-tool.js'

const ARGS = {
  blueprintSlug: 'my-blueprint',
  subject: 'Acme Corp',
  workspaceId: 'ws-1',
  userId: 'u-1',
  assistantId: 'a-1',
  sensitivity: 'internal',
}

function deps(over: Partial<GenerateSynthesizerDeps> = {}): GenerateSynthesizerDeps {
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
    // Built-ins are gone; the default blueprint resolves as a workspace-authored
    // one. Tests that assert "unresolved" override this with `() => null`.
    resolveWorkspaceBlueprint: vi.fn().mockResolvedValue({ body: 'WS BODY', title: 'My lens' }),
    ...over,
  }
}

describe('[COMP:api/generate-synthesizer] createGenerateSynthesizer', () => {
  beforeEach(() => {
    synthesizeMock.mockReset().mockResolvedValue({ pageId: 'page-1' })
    // No built-in blueprints — resolution falls through to workspace / document.
    loadBuiltinSkillsMock.mockReset().mockReturnValue([])
    createDocToolsMock.mockReset().mockReturnValue({ renderPage: {}, patchPage: {}, getCurrentPage: {} })
    createCrmToolsMock.mockReset().mockReturnValue({ saveCompany: {}, saveContact: {}, saveDeal: {} })
    createTaskToolsMock.mockReset().mockReturnValue({ saveTask: {} })
    vi.mocked(createBrainSourceTool).mockClear()
  })

  it('resolves a workspace blueprint and drafts from the brain on a subject anchor', async () => {
    const res = await createGenerateSynthesizer(deps())(ARGS)
    expect(res).toEqual({ pageId: 'page-1' })
    expect(synthesizeMock).toHaveBeenCalledTimes(1)
    const [source, blueprint, target] = synthesizeMock.mock.calls[0]
    // The SOURCE is the brain (generate mode), not a recording.
    expect(source).toMatchObject({ kind: 'brain', sourceId: 'Acme Corp', sensitivity: 'internal' })
    expect(blueprint).toMatchObject({ kind: 'skill', slug: 'my-blueprint', body: 'WS BODY' })
    // Idempotent per (workspace, blueprint, subject).
    expect(target).toMatchObject({
      anchorKey: 'generate-synthesis:ws-1:my-blueprint:acme-corp',
    })
  })

  it('passes the brain source tool (searchSource) as the engine source tool', async () => {
    await createGenerateSynthesizer(deps())(ARGS)
    expect(createBrainSourceTool).toHaveBeenCalledTimes(1)
    // The actor read-ceiling is pinned from the source sensitivity.
    expect(vi.mocked(createBrainSourceTool).mock.calls[0][0].actor).toMatchObject({
      workspaceId: 'ws-1',
      userId: 'u-1',
      clearance: 'internal',
    })
    const engineDeps = synthesizeMock.mock.calls[0][3]
    expect(engineDeps.sourceTool).toEqual({ name: 'searchSource' })
  })

  it('excludes renderPage from the doc tools (the page-first brief must not be orphaned)', async () => {
    await createGenerateSynthesizer(deps())(ARGS)
    const engineDeps = synthesizeMock.mock.calls[0][3]
    const docTools = engineDeps.buildDocTools('page-1')
    expect(docTools.has('renderPage')).toBe(false)
    expect(docTools.has('patchPage')).toBe(true)
    expect(docTools.has('getCurrentPage')).toBe(true)
  })

  it('defaults sensitivity to internal when omitted', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { sensitivity: _omit, ...noSens } = ARGS
    await createGenerateSynthesizer(deps())(noSens)
    expect(synthesizeMock.mock.calls[0][0]).toMatchObject({ kind: 'brain', sensitivity: 'internal' })
    expect(vi.mocked(createBrainSourceTool).mock.calls[0][0].actor.clearance).toBe('internal')
  })

  it('forwards an explicit target pageId when given (workflow-anchored generate)', async () => {
    await createGenerateSynthesizer(deps())({ ...ARGS, pageId: 'page-explicit' })
    expect(synthesizeMock.mock.calls[0][2]).toMatchObject({ pageId: 'page-explicit' })
  })

  it('falls back to a workspace-authored blueprint when no built-in matches', async () => {
    loadBuiltinSkillsMock.mockReturnValue([])
    const resolveWorkspaceBlueprint = vi.fn().mockResolvedValue({ body: 'WS BODY', title: 'My lens' })
    await createGenerateSynthesizer(deps({ resolveWorkspaceBlueprint }))({ ...ARGS, blueprintSlug: 'my-custom' })
    expect(resolveWorkspaceBlueprint).toHaveBeenCalledWith('ws-1', 'my-custom')
    expect(synthesizeMock.mock.calls[0][1]).toMatchObject({ slug: 'my-custom', body: 'WS BODY' })
  })

  it('resolves a document blueprint from a page template with an extraction spec', async () => {
    loadBuiltinSkillsMock.mockReturnValue([])
    const pageTemplateStore = {
      getById: vi.fn().mockResolvedValue({
        id: 'tmpl-1',
        name: 'SOW',
        extraction: {
          sections: [{ heading: 'Scope', instruction: 'What we will do', outputType: 'prose' }],
          capture: ['company'],
        },
      }),
    }
    await createGenerateSynthesizer(
      // No workspace skill matches → resolution reaches the document branch.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deps({ resolveWorkspaceBlueprint: vi.fn().mockResolvedValue(null), pageTemplateStore: pageTemplateStore as any }),
    )({ ...ARGS, blueprintSlug: 'tmpl-1' })
    expect(pageTemplateStore.getById).toHaveBeenCalledWith('u-1', 'tmpl-1')
    const bp = synthesizeMock.mock.calls[0][1]
    expect(bp).toMatchObject({ kind: 'document', slug: 'tmpl-1' })
    expect(bp.body).toContain('### 1. Scope')
  })

  it('returns null without running synthesis when the blueprint is unresolved', async () => {
    loadBuiltinSkillsMock.mockReturnValue([])
    const res = await createGenerateSynthesizer(
      deps({ resolveWorkspaceBlueprint: vi.fn().mockResolvedValue(null) }),
    )({ ...ARGS, blueprintSlug: 'nope' })
    expect(res).toBeNull()
    expect(synthesizeMock).not.toHaveBeenCalled()
  })
})
