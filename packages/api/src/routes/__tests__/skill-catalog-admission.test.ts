import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator, type ScopeEvidence } from '@use-brian/agent-runtime/security/context-scope.js'
import { bindScopeSource } from '@use-brian/agent-runtime/security/source-evidence.js'
import { createExecutionContext, executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { SkillContent } from '@use-brian/core/skills/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { SkillStore } from '../../db/skill-store.js'
import type { WorkspaceSkillFilesStore } from '../../db/workspace-skill-files-store.js'
import { AuthorityChangedError } from '../../context-scope/authority-lease.js'
import { injectSkills } from '../route-helpers.js'

const mocks = vi.hoisted(() => ({
  validateCaller: vi.fn(async (evidence: ScopeEvidence) => evidence),
  validateAudience: vi.fn(async (evidence: ScopeEvidence) => evidence),
  client: { query: vi.fn() },
}))
vi.mock('../../db/client.js', async original => ({
  ...await original<typeof import('../../db/client.js')>(), getAppPool: () => ({}),
}))
vi.mock('../../application-platform/execution-context.js', async original => ({
  ...await original<typeof import('../../application-platform/execution-context.js')>(),
  runApplicationTransaction: async (_pool: unknown, _execution: unknown, read: (client: typeof mocks.client) => Promise<unknown>) => read(mocks.client),
}))
vi.mock('../../context-scope/caller-evidence.js', async original => ({
  ...await original<typeof import('../../context-scope/caller-evidence.js')>(),
  validateCallerScopeEvidence: mocks.validateCaller, validateAudienceScopeEvidence: mocks.validateAudience,
}))

function fixture(sharedAudience = false) {
  const assertCurrent = vi.fn(async () => {})
  const executionContext = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'member', authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: 'workspace' },
    access: { workspaceId: 'workspace', userId: 'member', assistantId: 'assistant', assistantKind: 'standard',
      clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: null, sharedAudience },
    writeDefaults: { compartments: [], projectIds: [] },
    authority: { assertCurrent, execute: operation => operation() },
    lifecycle: { abortSignal: new AbortController().signal, sessionId: 'session', channelId: 'chat', channelType: 'web' },
  })
  const workspaceSkills = ['first', 'second', 'third', 'fourth', 'fifth'].map((id): SkillContent => bindScopeSource({
    id, name: id, description: id + ' description', content: id + ' instructions',
    source: 'user', category: 'research', requiresConnectors: [],
  }, { resourceKind: 'workspace_skill_revision', resourceId: id, version: '1', workspaceId: 'workspace', userId: null,
    assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [] }))
  const scopeAccumulator = new ContextScopeAccumulator()
  const tools = new Map<string, Tool>()
  const options = {
    executionContext, scopeAccumulator, tools, connectorUserId: 'member', assistantId: 'assistant',
    workspaceId: 'workspace', channel: 'web', unavailableCapabilities: [] as string[],
    restrictToSlugs: ['doc-architect', ...workspaceSkills.map(skill => skill.id)],
    skillStore: { listForWorkspaceContent: async () => workspaceSkills,
      listForAssistant: async () => workspaceSkills.map(skill => ({ skillId: skill.id, enabled: true })) } as unknown as SkillStore,
  }
  const context = { ...executionToolContext(executionContext, { appId: 'skills' }), scopeAccumulator }
  const retained = () => scopeAccumulator.evidence.sources?.map(s => s.resourceId) ?? []
  return { workspaceSkills, options, context, tools, assertCurrent, retained }
}
function deny(ids: string[], diagnostic: string) {
  return async (evidence: ScopeEvidence) => {
    if (evidence.sources?.some(source => ids.includes(source.resourceId))) throw Object.assign(new Error('Unavailable'), { diagnostic })
    return evidence
  }
}

describe('[COMP:api/skill-injection-gate] optional catalog admission', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.validateCaller.mockImplementation(async evidence => evidence)
    mocks.validateAudience.mockImplementation(async evidence => evidence)
  })

  it('admits healthy source-backed entries in a single app-role batch', async () => {
    const { options, retained } = fixture()
    const result = await injectSkills(options)
    expect(result.promptFragment).toContain('first description')
    expect(mocks.validateCaller).toHaveBeenCalledTimes(1)
    expect(mocks.validateCaller.mock.calls[0]).toContain(mocks.client)
    expect(retained()).toEqual(['first', 'second', 'third', 'fourth', 'fifth'])
  })

  it.each([false, true])('preserves healthy peers and built-ins while withholding rejected skill facts, shared=%s', async shared => {
    const { options, workspaceSkills, retained, tools, context } = fixture(shared)
    workspaceSkills[1]!.requiresConnectors = ['gmail']
    const refusal = deny(['second', 'third'], shared ? 'user_visibility' : 'source_held')
    if (!shared) mocks.validateCaller.mockImplementation(refusal)
    const result = await injectSkills({ ...options, authorizeSkillAudience: shared ? refusal : undefined })
    expect(result.promptFragment).toContain('doc-architect')
    expect(result.promptFragment).toContain('first description')
    expect(result.promptFragment).not.toMatch(/second|third/)
    expect(options.unavailableCapabilities).toEqual([])
    expect(retained()).toEqual(['first', 'fourth', 'fifth'])
    const refused = await tools.get('useSkill')!.execute({ skill: 'third' }, context)
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused)).not.toContain('third instructions')
  })

  it('does not turn verifier unavailability into a per-skill retry storm or a false required-skill success', async () => {
    const { options, retained } = fixture()
    mocks.validateCaller.mockRejectedValue(Object.assign(new Error('unavailable'), { diagnostic: 'verification_error' }))
    const result = await injectSkills(options)
    expect(result.promptFragment).toContain('doc-architect')
    expect(retained()).toEqual([])
    expect(mocks.validateCaller).toHaveBeenCalledTimes(1)
    await expect(injectSkills({ ...options, enforceSlugs: ['first'] })).rejects.toThrow('unavailable')
    const mcp = fixture()
    await injectSkills({ ...mcp.options, exposeListingTool: true })
    await expect(mcp.tools.get('listAvailableSkills')!.execute({ offset: 0, limit: 20 }, mcp.context)).rejects.toThrow('unavailable')
  })

  it('omits workspace rows without a reader receipt and retains the source of a visible connector notice', async () => {
    const { workspaceSkills, options, retained } = fixture()
    workspaceSkills[0] = { ...workspaceSkills[0]! } // Copying a row cannot copy the trusted reader binding.
    workspaceSkills[1]!.requiresConnectors = ['gmail']
    const result = await injectSkills(options)
    expect(result.promptFragment).not.toMatch(/first description|second description/)
    expect(options.unavailableCapabilities).toEqual(['second skill (requires: gmail)'])
    expect(retained()).toEqual(['second', 'third', 'fourth', 'fifth'])
  })

  it('fails an explicit use when the previously listed source is held before activation', async () => {
    const { options, tools, context, retained } = fixture()
    await injectSkills(options)
    mocks.validateCaller.mockImplementation(deny(['first'], 'source_held'))
    await expect(tools.get('useSkill')!.execute({ skill: 'first' }, context)).rejects.toMatchObject({ diagnostic: 'source_held' })
    expect(retained()).toContain('first')
  })

  it('propagates revoked invocation authority even for optional discovery', async () => {
    const { options } = fixture()
    mocks.validateCaller.mockRejectedValue(new AuthorityChangedError())
    await expect(injectSkills(options)).rejects.toBeInstanceOf(AuthorityChangedError)
  })

  it.each([1, 2] as const)('uses only the pinned resource bytes for a v%i bundle', async version => {
    const { options, workspaceSkills, tools, context } = fixture()
    const skill = workspaceSkills[0]!
    skill.bundleVersion = version
    skill.content = version === 1 ? 'Use {{reference:guide.md}}' : 'Use references/guide.md.'
    skill.resources = [{ kind: 'reference', path: 'references/guide.md', name: 'guide.md', content: 'Pinned guide', contentHash: 'digest' }]
    const currentFileLookup = vi.fn(() => { throw new Error('Current content is from a different snapshot') })
    const store = { getByPointer: currentFileLookup, listForSkills: currentFileLookup } as unknown as WorkspaceSkillFilesStore
    await injectSkills({ ...options, workspaceSkillFilesStore: store })
    const activated = await tools.get('useSkill')!.execute({ skill: 'first' }, context)
    const result = version === 1 ? activated : await tools.get('readSkillResource')!.execute({ skill: 'first', path: 'references/guide.md' }, context)
    expect(JSON.stringify(result.data)).toContain('Pinned guide')
    expect(currentFileLookup).not.toHaveBeenCalled()
  })

  it('withholds a protected skill when its runtime reader omitted the resource snapshot', async () => {
    const { options, workspaceSkills, retained } = fixture()
    workspaceSkills[0]!.bundleVersion = 2
    const workspaceSkillFilesStore = {} as WorkspaceSkillFilesStore
    const result = await injectSkills({ ...options, workspaceSkillFilesStore })
    expect(result.promptFragment).not.toContain('first description')
    expect(result.promptFragment).toContain('second description')
    expect(retained()).not.toContain('first')
    await expect(injectSkills({ ...options, workspaceSkillFilesStore, enforceSlugs: ['first'] })).rejects.toThrow('skill_source_unavailable')
  })

  it('paginates admitted entries, retaining the returned page and its one visible continuation fact', async () => {
    const { options, retained, tools, context } = fixture()
    const result = await injectSkills({ ...options, restrictToSlugs: options.restrictToSlugs.slice(1), exposeListingTool: true })
    expect(result.promptFragment).toBe('')
    expect(retained()).toEqual([])
    mocks.validateCaller.mockImplementation(deny(['second'], 'source_held'))
    const page = await tools.get('listAvailableSkills')!.execute({ offset: 1, limit: 1 }, context)
    expect(page.data).toEqual({ skills: [{ id: 'third', name: 'third', description: 'third description' }], nextOffset: 2 })
    expect(retained()).toEqual(['third', 'fourth'])
  })
})
