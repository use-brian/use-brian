import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextScopeAccumulator, createExecutionContext, executionToolContext,
  type CreateExecutionContextInput, type ToolContext,
} from '@use-brian/core'
import type { Session } from '../../db/sessions.js'
import { getApplicationExecutionBinding } from '../../application-platform/execution-context.js'
import { createAttendedDeliveryAudienceAuthorizer, validateAttendedAudienceEvidence } from '../attended-audience.js'
import { createActionPermissionSnapshots } from '../action-permission-snapshots.js'
import type { PermissionInvalidation, subscribePermissionInvalidation } from '../permission-events.js'
import type { ResolvedExecutionContext } from '../execution-context.js'
import { createRequestPermissionContext, ownsRequestPermissionContext } from '../request-permission-context.js'

vi.mock('../attended-audience.js', () => ({
  createAttendedDeliveryAudienceAuthorizer: vi.fn(), validateAttendedAudienceEvidence: vi.fn(),
}))
vi.mock('../../application-platform/execution-context.js', () => ({ getApplicationExecutionBinding: vi.fn() }))
vi.mock('../permission-events.js', () => ({
  subscribePermissionInvalidation: () => { throw new Error('Tests must inject subscribe') },
}))

const cleanup: (() => void)[] = []
const admit = vi.mocked(validateAttendedAudienceEvidence)
const destinationQuery = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  admit.mockImplementation(async (_execution, evidence) => evidence)
  vi.mocked(getApplicationExecutionBinding).mockReturnValue(undefined)
  destinationQuery.mockRejectedValue(new Error('Unexpected destination query'))
  vi.mocked(createAttendedDeliveryAudienceAuthorizer).mockReturnValue(destinationQuery)
})
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose() })

function fixture(options: { shared?: boolean; external?: boolean } = {}) {
  const controller = new AbortController()
  const input: CreateExecutionContextInput = {
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor', authenticationKind: 'native_session' } },
    ownership: { kind: 'workspace', workspaceId: 'workspace' },
    access: { workspaceId: 'workspace', userId: 'actor', assistantId: 'assistant', assistantKind: 'standard',
      clearance: options.shared ? 'internal' : 'confidential', compartments: options.shared ? [] : null,
      mutationCompartments: options.shared ? [] : null, projectIds: options.shared ? [] : null,
      visibilityAssistantIds: ['assistant'], ...(options.shared ? { sharedAudience: true } : {}) },
    writeDefaults: { compartments: [], projectIds: [] },
    authority: { assertCurrent: vi.fn(async () => {}), execute: async operation => operation() },
    lifecycle: { abortSignal: controller.signal, sessionId: 'session', channelType: 'web', channelId: 'channel' },
  }
  function selection(facts = input): ResolvedExecutionContext {
    const executionContext = createExecutionContext(facts)
    return { executionContext, turnScope: {
      access: executionContext.security.access, activeGroupId: null, activeProjectId: null,
      effectiveCompartments: [], effectiveProjectIds: [], writeCompartments: [], writeProjectIds: [],
      activeTeam: null, activeProject: null,
    } }
  }
  const initial = selection()
  const accumulator = new ContextScopeAccumulator({ sources: [{ resourceKind: options.external ? 'external_source' : 'memory', resourceId: 'source',
    version: '1', workspaceId: 'workspace', userId: options.shared ? null : 'actor', assistantId: null,
    sensitivity: 'internal', compartments: [], projectIds: [] }] })
  const session = { id: 'session', userId: 'actor', channelType: 'web', channelId: 'channel',
    visibility: options.shared ? 'workspace' : 'personal', anchorKind: 'none', appOrigin: 'chat',
    mode: 'conversation', effectiveClearance: 'internal', contextCompartments: [], contextProjectId: null } as Partial<Session> as Session
  let listener!: (event: PermissionInvalidation) => void
  const unsubscribe = vi.fn()
  const subscribe: typeof subscribePermissionInvalidation = vi.fn((_workspace, callback) => {
    listener = callback
    return { eligible: true, available: true, unsubscribe }
  })
  const load = vi.fn(async () => ({ value: initial }))
  const createActionSnapshots = vi.fn(() => createActionPermissionSnapshots('workspace', load, { subscribe }))
  const permissions = createRequestPermissionContext(initial, accumulator, session, { createActionSnapshots })!
  expect(permissions).toBeDefined()
  cleanup.push(permissions.dispose)
  const context = (value = initial): ToolContext => ({
    ...executionToolContext(value.executionContext, { appId: 'chat' }), scopeAccumulator: accumulator,
  })
  const emit = () => listener({ dirty: true, eligible: true, available: true, reason: 'workspace' })
  return { input, initial, accumulator, session, controller, selection, context, permissions,
    load, createActionSnapshots, subscribe, unsubscribe, emit }
}

const unavailable = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({
  reason: 'permission_snapshot_unavailable', operationMayHaveExecuted: false,
})

describe('[COMP:api/private-transcript] request permission context', () => {
  it('revalidates private dialogue for every output without repeating native field admission', async () => {
    const f = fixture()
    const transcript = { ...f.accumulator.evidence.sources![0], resourceKind: 'private_transcript' as const, resourceId: 'dialogue' }
    f.accumulator.note({ sources: [transcript] })
    for (let i = 0; i < 3; i++) await f.permissions.authorizeDelivery(f.context())
    expect(destinationQuery).not.toHaveBeenCalled()
    expect(admit.mock.calls.map(call => call[1].sources?.map(source => source.resourceKind))).toEqual([
      ['memory'], ['private_transcript'], ['private_transcript'], ['private_transcript'],
    ])
    admit.mockRejectedValueOnce(new Error('Dialogue held'))
    await expect(f.permissions.authorizeDelivery(f.context())).rejects.toThrow('Dialogue held')
    await expect(f.permissions.authorizeDelivery(f.context())).rejects.toThrow()
    expect(admit).toHaveBeenCalledTimes(5)
  })

  it('refuses evidence changed while the final transcript proof is pending', async () => {
    const f = fixture()
    f.accumulator.note({ sources: [{ ...f.accumulator.evidence.sources![0], resourceKind: 'private_transcript', resourceId: 'dialogue' }] })
    await f.permissions.authorizeDelivery(f.context())
    let finish!: () => void
    admit.mockImplementationOnce(async (_execution, evidence) => {
      await new Promise<void>(resolve => { finish = resolve })
      return evidence
    })
    const pending = expect(f.permissions.authorizeDelivery(f.context())).rejects.toThrow()
    f.accumulator.note({ sensitivity: 'confidential' })
    finish()
    await pending
    await expect(f.permissions.authorizeDelivery(f.context())).rejects.toThrow()
    expect(destinationQuery).not.toHaveBeenCalled()
  })

  it('shares lazy action permissions, coalesces event bursts, and never refreshes at delivery', async () => {
    const f = fixture()
    expect(f.createActionSnapshots).toHaveBeenCalledOnce()
    expect(f.subscribe).toHaveBeenCalledOnce()
    expect(f.load).not.toHaveBeenCalled()
    await f.permissions.authorizeDelivery(f.context())
    expect(f.load).not.toHaveBeenCalled()
    const first = await f.permissions.beforeAction()
    expect(await f.permissions.beforeAction()).toBe(first)
    expect(f.load).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 10; i++) f.emit()
    for (let i = 0; i < 20; i++) await f.permissions.authorizeDelivery(f.context())
    expect(f.load).toHaveBeenCalledTimes(1)
    expect(admit).toHaveBeenCalledTimes(1)
    expect(destinationQuery).not.toHaveBeenCalled()
    const next = f.selection({ ...f.input, access: { ...f.input.access, compartments: ['team'] } })
    f.load.mockResolvedValue({ value: next })
    const selected = await f.permissions.beforeAction()
    expect(selected).toBe(next) // action and delivery share the exact selected snapshot
    expect(selected.executionContext).toBe(next.executionContext)
    expect(await f.permissions.beforeAction()).toBe(selected)
    expect(f.load).toHaveBeenCalledTimes(2)
    expect(Object.isFrozen(selected.turnScope.access)).toBe(true)
  })

  it('drops old delivery receipts on a different selection while allowing held actions fresh admission', async () => {
    const f = fixture()
    const held = await f.permissions.beforeAction()
    await f.permissions.authorizeDelivery(f.context(held))
    const next = f.selection({ ...f.input, access: { ...f.input.access, clearance: 'internal' } })
    f.load.mockResolvedValue({ value: next }); f.emit()
    const selected = await f.permissions.beforeAction()
    expect(ownsRequestPermissionContext(f.permissions, f.context(held))).toBe(true)
    await f.permissions.authorizeDelivery(f.context(selected))
    await f.permissions.authorizeDelivery(f.context(held))
    await f.permissions.authorizeDelivery(f.context(held))
    expect(admit).toHaveBeenCalledTimes(3)
    expect(admit.mock.calls.map(call => call[0])).toEqual([held.executionContext, next.executionContext, held.executionContext])
    expect(f.load).toHaveBeenCalledTimes(2)
  })

  it.each(['actor', 'workspace', 'destination'] as const)('refuses a refreshed %s mismatch before selection', async mismatch => {
    const f = fixture()
    await f.permissions.beforeAction()
    const changed = { ...f.input, access: { ...f.input.access }, lifecycle: { ...f.input.lifecycle } }
    if (mismatch === 'actor') {
      changed.identity = { kind: 'attended', principal: { kind: 'workspace_member', userId: 'other', authenticationKind: 'native_session' } }
      changed.access.userId = 'other'
    } else if (mismatch === 'workspace') {
      changed.ownership = { kind: 'workspace', workspaceId: 'other' }
      changed.access.workspaceId = 'other'
    } else changed.lifecycle.channelId = 'other'
    const next = f.selection(changed)
    f.load.mockResolvedValue({ value: next }); f.emit()
    await unavailable(f.permissions.beforeAction())
    expect(ownsRequestPermissionContext(f.permissions, f.context(next))).toBe(false)
    expect(admit).not.toHaveBeenCalled()
  })

  it('rejects foreign executions, accumulators, authorities and copied context ownership', async () => {
    const f = fixture(), foreign = fixture()
    expect(ownsRequestPermissionContext(f.permissions, f.context())).toBe(true)
    expect(ownsRequestPermissionContext({ ...f.permissions }, f.context())).toBe(false)
    for (const wrong of [foreign.context(), { ...f.context(), scopeAccumulator: foreign.accumulator },
      { ...f.context(), authority: foreign.context().authority }, f.context(f.selection())]) {
      expect(ownsRequestPermissionContext(f.permissions, wrong)).toBe(false)
    }
    await expect(f.permissions.authorizeDelivery(foreign.context())).rejects.toThrow()
    expect(admit).not.toHaveBeenCalled()
  })

  it('declines mismatched stored destinations and application-bound executions without starting a provider', () => {
    const f = fixture()
    for (const session of [{ ...f.session, userId: 'other' }, { ...f.session, channelId: 'other' }]) {
      expect(createRequestPermissionContext(f.initial, f.accumulator, session, {
        createActionSnapshots: f.createActionSnapshots,
      })).toBeUndefined()
    }
    vi.mocked(getApplicationExecutionBinding).mockReturnValue({} as NonNullable<ReturnType<typeof getApplicationExecutionBinding>>)
    expect(createRequestPermissionContext(f.initial, f.accumulator, f.session, {
      createActionSnapshots: f.createActionSnapshots,
    })).toBeUndefined()
    expect(f.createActionSnapshots).toHaveBeenCalledOnce() // only the original qualifying request
    expect(f.load).not.toHaveBeenCalled()
  })

  it.each(['dispose', 'abort'] as const)('refuses a pending action selection after %s and cleans up once', async transition => {
    const f = fixture()
    let finish!: (value: { value: ResolvedExecutionContext }) => void
    f.load.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const pending = unavailable(f.permissions.beforeAction())
    await Promise.resolve()
    if (transition === 'abort') f.controller.abort()
    else f.permissions.dispose()
    finish({ value: f.selection() })
    await pending
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(f.load).toHaveBeenCalledOnce()
    expect(admit).not.toHaveBeenCalled()
  })

  it.each(['dispose', 'execution abort', 'delivery abort'] as const)(
    'never returns an allow when %s races a pending delivery and keeps refusal sticky', async transition => {
      const f = fixture(), deliveryController = new AbortController()
      const context = transition === 'delivery abort' ? { ...f.context(), abortSignal: deliveryController.signal } : f.context()
      let finish!: () => void
      admit.mockImplementationOnce(async (_execution, evidence) => {
        await new Promise<void>(resolve => { finish = resolve })
        return evidence
      })
      const allowed = vi.fn()
      const pending = expect(f.permissions.authorizeDelivery(context).then(allowed)).rejects.toThrow()
      expect(admit).toHaveBeenCalledOnce()
      if (transition === 'dispose') f.permissions.dispose()
      else if (transition === 'execution abort') f.controller.abort()
      else deliveryController.abort()
      finish()
      await pending
      expect(allowed).not.toHaveBeenCalled()
      // A fresh, non-aborted tool context must not clear the request failure.
      await expect(f.permissions.authorizeDelivery(f.context())).rejects.toThrow()
      f.emit()
      await unavailable(f.permissions.beforeAction())
      expect(admit).toHaveBeenCalledOnce()
      expect(f.load).not.toHaveBeenCalled()
    },
  )

  it('does not restore an old cached allow when selection changes during pending delivery', async () => {
    const f = fixture()
    const held = await f.permissions.beforeAction()
    let finish!: () => void
    admit.mockImplementationOnce(async (_execution, evidence) => {
      await new Promise<void>(resolve => { finish = resolve })
      return evidence
    })
    const pending = f.permissions.authorizeDelivery(f.context(held))
    expect(admit).toHaveBeenCalledOnce()
    const next = f.selection({ ...f.input, access: { ...f.input.access, clearance: 'internal' } })
    f.load.mockResolvedValue({ value: next }); f.emit()
    const selected = await f.permissions.beforeAction()
    finish()
    await pending // The admitted old action can finish, but cannot repopulate its cleared receipt.
    await f.permissions.authorizeDelivery(f.context(held))
    expect(admit).toHaveBeenCalledTimes(2)
    expect(admit.mock.calls[1][0]).toBe(held.executionContext)
    expect(admit.mock.calls[1][1]).toEqual(f.accumulator.evidence) // full source admission, not an empty delta
    await f.permissions.authorizeDelivery(f.context(held))
    expect(admit).toHaveBeenCalledTimes(2)
    await f.permissions.authorizeDelivery(f.context(selected))
    expect(admit).toHaveBeenCalledTimes(3)
    expect(admit.mock.calls[2][0]).toBe(next.executionContext)
  })

  it('composes shared-room scope, exact ownership, and anonymous recipient admission without changing the actor', async () => {
    const f = fixture({ shared: true }), foreign = fixture({ shared: true })
    const held = await f.permissions.beforeAction()
    expect(held.turnScope.access).toMatchObject({ userId: 'actor', sharedAudience: true, compartments: [], projectIds: [] })
    expect(ownsRequestPermissionContext(f.permissions, f.context(held))).toBe(true)
    expect(ownsRequestPermissionContext(f.permissions, foreign.context())).toBe(false)
    expect(ownsRequestPermissionContext(f.permissions, { ...f.context(held), scopeAccumulator: foreign.accumulator })).toBe(false)
    await f.permissions.authorizeDelivery(f.context(held))
    expect(admit).toHaveBeenCalledWith(held.executionContext, f.accumulator.evidence,
      expect.objectContaining({ userId: '', workspaceId: 'workspace', clearance: 'internal',
        compartments: [], projectIds: [], visibilityAssistantIds: null }), { directHumanSource: false })
    const next = f.selection()
    f.load.mockResolvedValue({ value: next }); f.emit()
    const selected = await f.permissions.beforeAction()
    await f.permissions.authorizeDelivery(f.context(selected))
    expect(selected.executionContext.security.access.userId).toBe('actor')
    expect(ownsRequestPermissionContext(f.permissions, f.context(held))).toBe(true)
    // Identical actor and destination do not permit changing a room into a private read scope.
    const privateSelection = f.selection({ ...f.input, access: { ...f.input.access, sharedAudience: false } })
    f.load.mockResolvedValue({ value: privateSelection }); f.emit()
    await unavailable(f.permissions.beforeAction())
    expect(ownsRequestPermissionContext(f.permissions, f.context(privateSelection))).toBe(false)
    expect(destinationQuery).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps independent-source delivery live across unchanged events and refreshed selections (shared=%s)', async shared => {
    const f = fixture({ shared, external: true })
    destinationQuery.mockImplementation(async input => ({ allowed: true, evidence: input.scopeEvidence }))
    const held = await f.permissions.beforeAction()
    for (let i = 0; i < 3; i++) await f.permissions.authorizeDelivery(f.context(held))
    expect(destinationQuery).toHaveBeenCalledTimes(3)
    const next = f.selection()
    f.load.mockResolvedValue({ value: next }); f.emit()
    const selected = await f.permissions.beforeAction()
    for (let i = 0; i < 3; i++) await f.permissions.authorizeDelivery(f.context(selected))
    await f.permissions.authorizeDelivery(f.context(held))
    expect(destinationQuery).toHaveBeenCalledTimes(7)
    expect(destinationQuery).toHaveBeenLastCalledWith({ workspaceId: 'workspace', assistantId: 'assistant',
      userId: 'actor', channelType: 'web', channelId: 'channel', sessionId: 'session',
      recipientType: shared ? 'group' : 'individual', scopeEvidence: f.accumulator.evidence })
    expect(admit).not.toHaveBeenCalled()
    expect(f.load).toHaveBeenCalledTimes(2)
    destinationQuery.mockResolvedValueOnce({ allowed: false, reason: 'delivery_audience_unverified', diagnostic: 'source_unverifiable' })
    await expect(f.permissions.authorizeDelivery(f.context(selected))).rejects.toThrow()
    await expect(f.permissions.authorizeDelivery(f.context(held))).rejects.toThrow()
    expect(destinationQuery).toHaveBeenCalledTimes(8)
    await unavailable(f.permissions.beforeAction())
  })

  it('makes delivery failure sticky across action invalidation and refresh attempts', async () => {
    const f = fixture()
    await f.permissions.beforeAction()
    admit.mockRejectedValueOnce(new Error('source revoked'))
    await expect(f.permissions.authorizeDelivery(f.context())).rejects.toThrow('source revoked')
    f.load.mockResolvedValue({ value: f.selection() }); f.emit()
    await unavailable(f.permissions.beforeAction())
    await expect(f.permissions.authorizeDelivery(f.context())).rejects.toThrow()
    expect(f.load).toHaveBeenCalledTimes(1)
    expect(admit).toHaveBeenCalledTimes(1)
  })

  it('never falls back to stale permissions after refresh failure and retries later', async () => {
    const f = fixture()
    const held = await f.permissions.beforeAction()
    f.emit()
    const failure = new Error('permission read failed')
    f.load.mockRejectedValueOnce(failure)
    await expect(f.permissions.beforeAction()).rejects.toBe(failure)
    const next = f.selection()
    f.load.mockResolvedValue({ value: next })
    const recovered = await f.permissions.beforeAction()
    expect(recovered.executionContext).toBe(next.executionContext)
    expect(recovered.executionContext).not.toBe(held.executionContext)
    expect(f.load).toHaveBeenCalledTimes(3)
  })

  it.each(['dispose', 'abort', 'already aborted'] as const)('cleans up its provider on %s and refuses further use', async transition => {
    const f = fixture()
    if (transition === 'already aborted') {
      f.permissions.dispose()
      f.controller.abort()
      const provider = { eligible: true, beforeAction: vi.fn(async () => f.initial), dispose: vi.fn() }
      const permissions = createRequestPermissionContext(f.initial, f.accumulator, f.session, { createActionSnapshots: () => provider })!
      expect(provider.dispose).toHaveBeenCalledOnce()
      await unavailable(permissions.beforeAction())
      return
    }
    await f.permissions.beforeAction()
    if (transition === 'abort') f.controller.abort()
    else f.permissions.dispose()
    f.permissions.dispose(); f.controller.abort()
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(ownsRequestPermissionContext(f.permissions, f.context())).toBe(false)
    await unavailable(f.permissions.beforeAction())
    await expect(f.permissions.authorizeDelivery(f.context())).rejects.toThrow()
    expect(f.load).toHaveBeenCalledTimes(1)
  })
})
