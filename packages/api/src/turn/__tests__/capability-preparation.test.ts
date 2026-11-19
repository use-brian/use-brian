/** [COMP:api/turn-kernel] The owner capability port: every profile prepares
 * through the M3 capability surface (`mcp/surface.ts`) with its entrypoint's
 * exact parameter block, profile/lane binding (including a callee that
 * composes before binding), once-per-owner, opportunistic pre-binding through
 * the original tool scope, an explicit unavailable notice instead of a silent
 * no-op on web/public failure, durable resume activating exactly its
 * suspended tool, and activate-then-bind under the captured invocation. Only
 * lease SQL and the surface are fake. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { createExecutionContext, executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { buildTool, type CurrentAuthorityBoundary, type Tool } from '@use-brian/agent-runtime/tools/types.js'
const mocks = vi.hoisted(() => ({ surface: vi.fn(), resume: vi.fn(), bind: vi.fn() }))
vi.mock('../lease.js', async importOriginal => ({ ...await importOriginal<typeof import('../lease.js')>(),
  takeTurnLease: vi.fn(async () => ({ taken: true, token: 'roster-token', turnId: 'd'.repeat(64) })),
  startLeaseHeartbeat: () => () => {}, releaseTurn: vi.fn(async () => true),
}))
vi.mock('../../mcp/surface.js', () => ({ composeSurfaceCapabilities: mocks.surface, composeResumeCapabilities: mocks.resume }))
vi.mock('../../context-scope/agent-access-tools.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../context-scope/agent-access-tools.js')>()
  return { ...real, bindToolsToAgentAccess: (...args: Parameters<typeof real.bindToolsToAgentAccess>) => {
    mocks.bind([...args[0].keys()]); return real.bindToolsToAgentAccess(...args) } }
})
import { openAssistantTurn, type AssistantTurn } from '../kernel.js'
import { CONNECTOR_PREPARATION_UNAVAILABLE } from '../../mcp/discovery-diagnostics.js'
import { AuthorityChangedError } from '../../context-scope/authority-lease.js'

const identity = { workspace: '00000000-0000-4000-8000-000000000060', assistant: 'roster-assistant', user: 'roster-user', session: 'roster-session' }
const provider = { name: 'unused', models: [], stream() { throw new Error('unused') } } as unknown as LLMProvider
const services = { provider, configuredProviders: undefined, resolveWorkspaceCustomLlm: null, resolveLegacyByoKey: null, buildLegacyByoProvider: null }
const owners: AssistantTurn[] = []
afterEach(async () => { for (const owner of owners.splice(0)) await owner.finish('failed') })
beforeEach(() => { vi.clearAllMocks()
  mocks.surface.mockImplementation(async (surface: string, { tools }: { tools: Map<string, Tool> }) => {
    if (surface === 'web' || surface === 'public') return { unavailable: ['fictional'], searchableSources: [], enrichConfirmation: async (_n: string, i: unknown) => i }
    tools.set('connectorRead', readTool('connectorRead')); return { unavailable: [], searchableSources: ['fictional'] } })
  mocks.resume.mockImplementation(async ({ tools, suspendedToolName }: { tools: Map<string, Tool>; suspendedToolName: string }) => {
    tools.set(suspendedToolName, readTool(suspendedToolName)); return { unavailable: [], searchableSources: [] } }) })
const routeStores = { connectorStore: {} as never, mcpSettingsStore: {} as never }

const calls: string[] = []
function readTool(name = 'baseRead') {
  return buildTool({ name, description: `Fictional ${name}`, inputSchema: z.object({}).passthrough(), isReadOnly: true,
    async execute() { calls.push(name); return { data: name } } })
}
async function fixture() {
  const abort = new AbortController()
  const authority: CurrentAuthorityBoundary = { assertCurrent: vi.fn(async () => {}), execute: vi.fn(async operation => operation()) }
  const execution = createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: identity.user, authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: identity.workspace },
    access: { workspaceId: identity.workspace, userId: identity.user, assistantId: identity.assistant, assistantKind: 'standard', clearance: 'internal',
      compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [identity.assistant] },
    writeDefaults: { compartments: [], projectIds: [] }, authority,
    lifecycle: { sessionId: identity.session, channelType: 'web', channelId: 'fixture', abortSignal: abort.signal } })
  const owner = await openAssistantTurn({ sessionId: identity.session, assistantId: identity.assistant, policy: { admission: 'personal' }, abortController: abort })
  owners.push(owner)
  const bind = (toolProfile: 'web' | 'public' | 'callee' | 'channel' | 'resume') => owner.bindModelPreparation({ kind: 'execution', toolProfile, execution, assertCurrent: async () => {} }, services)
  return { owner, bind, authority, context: executionToolContext(execution, { appId: 'fixture' }) }
}

describe('[COMP:api/turn-kernel] owner prepareCapabilities', () => {
  it('prepares the web surface from the route parameter block and pre-binds the composed roster once', async () => {
    const f = await fixture(); f.bind('web')
    const tools = new Map([['baseRead', readTool()]])
    const params = { scope: 'chat', connectorUserId: identity.user, assistant: { id: identity.assistant }, tools, stores: routeStores,
      userTimezone: 'Asia/Hong_Kong', allowKnowledgeWrites: true, exposeLocalReadTools: true, routineCalendarRead: true }
    const result = await f.owner.prepareCapabilities({ profile: 'web', composition: { kind: 'route-params', params } })
    expect(mocks.surface).toHaveBeenCalledOnce()
    const [surface, options] = mocks.surface.mock.calls[0]!
    expect(surface).toBe('web')
    expect(options).toMatchObject({ userId: identity.user, assistantId: identity.assistant, tools, userTimezone: 'Asia/Hong_Kong',
      allowKnowledgeWrites: true, exposeLocalReadTools: true, knowledgeWriteAuthorization: 'capture', routineCalendarRead: true })
    // A personal assistant's missing workspace is a stable null, never undefined.
    expect(options.assistantTeamId).toBeNull()
    expect(result.unavailable).toEqual(['fictional'])
    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith(['baseRead'])
    // prepareRun/prepareTools reuse the pre-bound wrapper: nothing is rebound.
    const first = f.owner.prepareTools(tools).get('baseRead')
    expect(mocks.bind).toHaveBeenLastCalledWith([])
    expect(f.owner.activateAndBind(tools).get('baseRead')).toBe(first)
    expect(() => f.owner.prepareCapabilities({ profile: 'web', composition: { kind: 'route-params', params } })).toThrow('already started')
  })

  it('activates the routine Calendar read only when the web route passes routine eligibility (T1)', async () => {
    for (const routineCalendarRead of [undefined, false, true]) {
      const f = await fixture(); f.bind('web')
      await f.owner.prepareCapabilities({ profile: 'web', composition: { kind: 'route-params', params: {
        scope: 'chat', connectorUserId: identity.user, assistant: { id: identity.assistant }, tools: new Map(), stores: routeStores,
        ...(routineCalendarRead === undefined ? {} : { routineCalendarRead }) } } })
      expect(mocks.surface.mock.calls.at(-1)![1]).toMatchObject({ routineCalendarRead: routineCalendarRead === true })
    }
    // The public surface never takes the routine read, even when asked.
    const p = await fixture(); p.bind('public')
    await p.owner.prepareCapabilities({ profile: 'public', composition: { kind: 'route-params', params: {
      scope: 'public-api', connectorUserId: identity.user, assistant: { id: identity.assistant }, tools: new Map(), stores: routeStores, routineCalendarRead: true } } })
    expect(mocks.surface.mock.calls.at(-1)![1]).toMatchObject({ routineCalendarRead: false })
  })

  it('prepares nothing without connector stores, and reports a public failure instead of a silent no-op', async () => {
    const f = await fixture(); f.bind('public')
    const empty = await f.owner.prepareCapabilities({ profile: 'public', composition: { kind: 'route-params', params: {
      scope: 'public-api', connectorUserId: identity.user, assistant: { id: identity.assistant, workspaceId: identity.workspace }, tools: new Map(), stores: {} } } })
    expect(mocks.surface).not.toHaveBeenCalled()
    expect(empty).toMatchObject({ unavailable: [], searchableSources: [] })
    expect(await empty.enrichConfirmation('fictionalTool', { foo: 'bar' })).toEqual({ foo: 'bar' })

    const g = await fixture(); g.bind('public')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.surface.mockRejectedValueOnce(new Error('Fictional discovery timeout'))
    const failed = await g.owner.prepareCapabilities({ profile: 'public', composition: { kind: 'route-params', params: {
      scope: 'public-api', connectorUserId: identity.user, assistant: { id: identity.assistant, workspaceId: identity.workspace }, tools: new Map(), stores: routeStores } } })
    expect(mocks.surface.mock.calls.at(-1)![0]).toBe('public')
    expect(mocks.surface.mock.calls.at(-1)![1]).toMatchObject({ routineCalendarRead: false, assistantTeamId: identity.workspace })
    expect(failed.unavailable).toEqual([CONNECTOR_PREPARATION_UNAVAILABLE])
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('[public-api]'), expect.any(Error))
    errors.mockRestore()

    // Authority loss is never degraded into a connector-less turn.
    const h = await fixture(); h.bind('web')
    const changed = new AuthorityChangedError()
    mocks.surface.mockRejectedValueOnce(changed)
    await expect(h.owner.prepareCapabilities({ profile: 'web', composition: { kind: 'route-params', params: {
      scope: 'chat', connectorUserId: identity.user, assistant: { id: identity.assistant }, tools: new Map(), stores: routeStores } } })).rejects.toBe(changed)
  })

  it('lets a callee compose before binding, then checks its lane and pre-binds the mutated map', async () => {
    const f = await fixture()
    const tools = new Map([['baseRead', readTool()]])
    await f.owner.prepareCapabilities({ profile: 'callee', composition: { kind: 'surface-options', params: { tools } as never } })
    expect(mocks.surface).toHaveBeenCalledExactlyOnceWith('callee', { tools })
    expect([...tools.keys()]).toEqual(['baseRead', 'connectorRead'])
    expect(mocks.bind).not.toHaveBeenCalled()
    f.bind('callee')
    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith(['baseRead', 'connectorRead'])
    const g = await fixture()
    await g.owner.prepareCapabilities({ profile: 'callee', composition: { kind: 'surface-options', params: { tools: new Map() } as never } })
    expect(() => g.bind('web')).toThrow(expect.objectContaining({ reason: 'authority_changed' }))
  })

  it('refuses a profile that does not match the bound lane', async () => {
    const f = await fixture(); f.bind('web')
    expect(() => f.owner.prepareCapabilities({ profile: 'channel', composition: { kind: 'surface-options', params: { tools: new Map() } as never } }))
      .toThrow(expect.objectContaining({ reason: 'authority_changed' }))
    expect(mocks.surface).not.toHaveBeenCalled()
  })

  it('propagates the composition failure unchanged', async () => {
    const f = await fixture(); f.bind('channel')
    const failure = new Error('Fictional injection failure')
    mocks.surface.mockRejectedValueOnce(failure)
    await expect(f.owner.prepareCapabilities({ profile: 'channel', composition: { kind: 'surface-options', params: { tools: new Map() } as never } })).rejects.toBe(failure)
  })

  it('gives durable resume the catalog: exactly the suspended tool, bound under the resume lane', async () => {
    const f = await fixture(); f.bind('resume')
    const tools = new Map([['baseRead', readTool()]])
    const params = { tools, suspendedToolName: 'githubCreateIssue' } as never
    await f.owner.prepareCapabilities({ profile: 'resume', composition: { kind: 'resume', params } })
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith(params)
    expect(mocks.surface).not.toHaveBeenCalled()
    expect(mocks.bind).toHaveBeenCalledExactlyOnceWith(['baseRead', 'githubCreateIssue'])
  })

  it('binds a later-activated tool under the original invocation and refuses after the owner closes', async () => {
    const f = await fixture(); f.bind('web')
    const late = readTool('lateActivated')
    const bound = f.owner.activateAndBind(new Map([['lateActivated', late]])).get('lateActivated')!
    expect(bound).not.toBe(late)
    calls.length = 0
    await bound.execute({}, { ...f.context, abortSignal: new AbortController().signal })
    expect(calls).toEqual(['lateActivated'])
    expect(f.authority.execute).toHaveBeenCalled()
    await f.owner.finish('completed')
    expect(() => f.owner.activateAndBind(new Map([['lateActivated', late]]))).toThrow('open original turn')
  })
})
