/** [COMP:api/assistant-run-preparation] Original invocation at the awaited tool effect. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import {
  createExecutionContext,
  executionToolContext
} from '@use-brian/agent-runtime/security/execution-context.js'
import {
  buildTool,
  type CurrentAuthorityBoundary,
  type ToolContext
} from '@use-brian/agent-runtime/tools/types.js'
vi.mock('../lease.js', async original => ({ ...await original<typeof import('../lease.js')>(),
  takeTurnLease: vi.fn(async () => ({ taken: true, token: 'tool-token', turnId: 'b'.repeat(64) })),
  startLeaseHeartbeat: () => () => {}, releaseTurn: vi.fn(async () => true),
}))
import { openAssistantTurn, type AssistantTurn } from '../kernel.js'
import { currentAgentAccess, runWithAgentAccess } from '../../db/agent-access-context.js'
import { releaseTurn } from '../lease.js'

const owners: AssistantTurn[] = [], pending: Array<() => void> = []
afterEach(async () => { pending.splice(0).forEach(fn => fn()); for (const owner of owners.splice(0)) await owner.finish('failed'); vi.clearAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); pending.push(resolve); return { promise, resolve } }
const services = { provider: { name: 'fixture', models: [] } as unknown as LLMProvider,
  configuredProviders: undefined, resolveWorkspaceCustomLlm: null, resolveLegacyByoKey: null, buildLegacyByoProvider: null }
type Lane = 'web' | 'channel' | 'public' | 'callee' | 'resume'
async function fixture(lane: Lane, prepareModel = true) {
  const abort = new AbortController(), admit = vi.fn(async () => {}), assertCurrent = vi.fn(async () => {})
  const parent = { userId: 'actor', workspaceId: 'workspace', clearance: 'confidential', compartments: null, projectIds: null }
  const originalParent = runWithAgentAccess(parent, () => AsyncLocalStorage.snapshot())
  const authority: CurrentAuthorityBoundary = { assertCurrent,
    execute: vi.fn(async operation => { await assertCurrent(); return originalParent(operation) }) }
  // Durable resume binds its canonical system execution (the saved bounded ceiling, keyed by its approval).
  const execution = createExecutionContext({ identity: lane === 'resume' ? { kind: 'system', purpose: 'session_resume', jobId: 'approval' }
    : { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor', authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: 'workspace' },
    access: { workspaceId: 'workspace', userId: 'actor', assistantId: 'child', assistantKind: 'standard', clearance: 'internal',
      compartments: ['read', 'write'], mutationCompartments: ['write'], projectIds: ['project'], visibilityAssistantIds: ['child'], sharedAudience: true },
    writeDefaults: { compartments: ['write'], projectIds: ['project'] }, authority,
    lifecycle: { sessionId: 'session', channelType: 'web', channelId: 'channel', abortSignal: abort.signal } })
  const context: ToolContext = executionToolContext(execution, { appId: 'fixture' })
  const owner = await openAssistantTurn({ sessionId: 'session', assistantId: 'child', policy: { admission: 'personal' }, abortController: abort })
  owners.push(owner)
  owner.bindModelPreparation({ kind: 'execution', toolProfile: lane, execution, assertCurrent: admit }, services)
  if (prepareModel) await owner.prepareMainModel(lane === 'web'
    ? { kind: 'web', requestedModel: 'pro', plan: 'max_5x', budgetStatus: 'ok', researchMode: false, metered: null, hasImage: false }
    : lane === 'callee' ? { kind: 'callee', modelAlias: 'pro', researchFanout: false }
    : lane === 'resume' ? { kind: 'resume', fallbackModel: 'fixture', selectedTier: 'pro' }
    : { kind: lane, plan: 'max_5x', budgetStatus: 'ok' })
  const effect = vi.fn(async (_input: unknown, toolContext: ToolContext) => { await Promise.resolve(); return { data: { scope: currentAgentAccess(), context: toolContext } } })
  const original = buildTool({ name: 'scopeProbe', description: 'Read the actual awaited scope.', inputSchema: z.object({}), execute: effect })
  const tools = owner.prepareTools(new Map([[original.name, original]])), tool = tools.get(original.name)!
  return { owner, abort, admit, authority, assertCurrent, execution, context, effect, original, tool }
}

describe.each<Lane>(['web', 'channel', 'public', 'callee', 'resume'])('%s original tool invocation', lane => {
  it('binds the original scope before main model preparation without moving model work earlier', async () => {
    const f = await fixture(lane, false)
    expect(f.admit).not.toHaveBeenCalled()
    await f.tool.execute({}, f.context)
    expect(f.effect).toHaveBeenCalledOnce(); expect(f.admit).not.toHaveBeenCalled()
  })

  it('refuses substituting a different model surface before any route preparation callback', async () => {
    const f = await fixture(lane, false)
    const wrong = lane === 'web' ? { kind: 'public' as const, plan: 'max_5x', budgetStatus: 'ok' as const }
      : { kind: 'web' as const, plan: 'max_5x', budgetStatus: 'ok' as const, researchMode: false, metered: null, hasImage: false }
    await expect(f.owner.prepareMainModel(wrong)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(f.admit).not.toHaveBeenCalled(); expect(f.effect).not.toHaveBeenCalled()
  })

  it('refuses context replacement during authority post-effect cleanup as uncertain', async () => {
    const f = await fixture(lane), entered = deferred(), gate = deferred()
    vi.mocked(f.authority.execute).mockImplementation(async operation => {
      const result = await operation(); entered.resolve(); await gate.promise; return result
    })
    const running = f.tool.execute({}, f.context)
    const outcome = expect(running).rejects.toMatchObject({ reason: 'authority_changed', operationMayHaveExecuted: true })
    await entered.promise; f.context.assistantKind = 'primary'; gate.resolve(); await outcome
    expect(f.effect).toHaveBeenCalledOnce()
  })

  it('applies child bounds inside retained parent authority and preserves a narrower effect scope', async () => {
    const f = await fixture(lane), admissions = f.admit.mock.calls.length
    f.assertCurrent.mockClear(); vi.mocked(f.authority.execute).mockClear()
    const replacement = vi.fn(async () => ({ data: 'wrong implementation' })); f.original.execute = replacement
    const result = await runWithAgentAccess({ userId: 'actor', workspaceId: 'workspace', clearance: 'internal',
      compartments: ['write'], mutationCompartments: [], projectIds: [] }, () => f.tool.execute({}, f.context))
    expect((result.data as { scope: unknown }).scope).toMatchObject({ userId: 'actor', workspaceId: 'workspace', clearance: 'internal',
      compartments: ['write'], mutationCompartments: [], projectIds: [], visibilityAssistantIds: ['child'], sharedAudience: true })
    expect((result.data as { context: ToolContext }).context).toMatchObject({ compartments: ['write'], mutationCompartments: [], projectIds: [] })
    expect(f.effect).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled()
    expect(f.authority.execute).toHaveBeenCalledOnce(); expect(f.assertCurrent).toHaveBeenCalledOnce()
    expect(f.admit.mock.calls.length).toBe(admissions) // No new route-wide recipient/source proofs.
    expect(currentAgentAccess()).toBeUndefined()
    expect((result.data as { context: ToolContext }).context.executionContext).toBe(f.execution)
  })

  it.each(['actor', 'workspace', 'assistant', 'session', 'kind', 'execution', 'authority'] as const)('refuses %s substitution before the effect', async axis => {
    const f = await fixture(lane), candidate = { ...f.context }
    if (axis === 'actor') candidate.userId = 'foreign'
    if (axis === 'workspace') candidate.workspaceId = 'foreign'
    if (axis === 'assistant') candidate.assistantId = 'foreign'
    if (axis === 'session') candidate.sessionId = 'foreign'
    if (axis === 'kind') candidate.assistantKind = 'primary'
    if (axis === 'execution') candidate.executionContext = { ...f.execution }
    if (axis === 'authority') candidate.authority = { assertCurrent: vi.fn(async () => {}), execute: async operation => operation() }
    await expect(async () => f.tool.execute({}, candidate)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(f.effect).not.toHaveBeenCalled()
  })

  it.each(['execute', 'assertCurrent'] as const)('refuses replacing original authority.%s across its await', async method => {
    const f = await fixture(lane), gate = deferred(), entered = deferred()
    f.assertCurrent.mockImplementation(async () => { entered.resolve(); await gate.promise })
    const running = f.tool.execute({}, f.context), outcome = expect(running).rejects.toMatchObject({ reason: 'authority_changed' })
    await entered.promise
    if (method === 'execute') f.authority.execute = vi.fn(async operation => operation())
    else f.authority.assertCurrent = vi.fn(async () => {})
    gate.resolve(); await outcome; expect(f.effect).not.toHaveBeenCalled()
  })

  it.each(['execute', 'assertCurrent', 'context'] as const)('refuses uncertain success when %s changes during the actual awaited effect', async axis => {
    for (const toolThrows of [false, true]) {
      const f = await fixture(lane), gate = deferred(), entered = deferred()
      f.effect.mockImplementation(async (_input, context) => {
        entered.resolve(); await gate.promise
        if (toolThrows) throw new Error('Fixture effect failure')
        return { data: { scope: currentAgentAccess(), context } }
      })
      const running = f.tool.execute({}, f.context)
      const outcome = expect(running).rejects.toMatchObject({ reason: 'authority_changed', operationMayHaveExecuted: true, retrySafe: false })
      await entered.promise
      if (axis === 'execute') f.authority.execute = vi.fn(async operation => operation())
      if (axis === 'assertCurrent') f.authority.assertCurrent = vi.fn(async () => {})
      if (axis === 'context') f.context.assistantKind = 'primary'
      gate.resolve(); await outcome
      expect(f.effect).toHaveBeenCalledOnce() // An uncertain effect is never replayed.
    }
  })

  it('reuses original binding for repeated preparation without stacking scope or authority wrappers', async () => {
    const f = await fixture(lane)
    expect(f.owner.prepareTools(new Map([[f.original.name, f.original]])).get(f.original.name)).toBe(f.tool)
    expect(f.owner.prepareTools(new Map([[f.original.name, f.tool]])).get(f.original.name)).toBe(f.tool)
    vi.mocked(f.authority.execute).mockClear(); await f.tool.execute({}, f.context)
    expect(f.authority.execute).toHaveBeenCalledOnce(); expect(f.effect).toHaveBeenCalledOnce()
  })

  it.each(['stop', 'loss'] as const)('refuses %s observed during fresh effect admission', async kind => {
    const f = await fixture(lane), gate = deferred(), entered = deferred()
    f.assertCurrent.mockImplementation(async () => { entered.resolve(); await gate.promise; if (kind === 'loss') throw Object.assign(new Error('Fixture lease lost'), { reason: 'authority_changed' }) })
    const running = f.tool.execute({}, f.context), outcome = expect(running).rejects.toThrow(kind === 'loss' ? 'Fixture lease lost' : 'Fixture Stop')
    await entered.promise; if (kind === 'stop') f.abort.abort(new Error('Fixture Stop')); gate.resolve(); await outcome
    expect(f.effect).not.toHaveBeenCalled()
  })
})

it('drains an already-started original tool effect before exact-token release, then refuses reuse', async () => {
  const f = await fixture('resume'), gate = deferred(), entered = deferred()
  f.assertCurrent.mockImplementation(async () => { entered.resolve(); await gate.promise })
  const running = f.tool.execute({}, f.context); await entered.promise
  const finishing = f.owner.finish(); await Promise.resolve(); expect(releaseTurn).not.toHaveBeenCalled()
  gate.resolve(); await running; await finishing
  expect(releaseTurn).toHaveBeenCalledExactlyOnceWith('session', 'tool-token', 'completed', expect.any(Function))
  await expect(f.tool.execute({}, f.context)).rejects.toThrow('original turn is closed')
  expect(f.effect).toHaveBeenCalledOnce()
})
