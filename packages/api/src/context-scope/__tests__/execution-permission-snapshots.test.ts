import { describe, expect, it, vi } from 'vitest'
import { createExecutionPermissionSnapshots } from '../execution-permission-snapshots.js'
import { resolveExecutionContextSystem, type ResolveExecutionContextInput } from '../execution-context.js'
import type { ResolvedTurnScope } from '../resolve-turn-scope.js'
import type { PermissionInvalidation, subscribePermissionInvalidation } from '../permission-events.js'

const db = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../db/client.js', () => ({ query: db.query }))

const workspaceId = '11111111-1111-4111-8111-111111111111'
function input(): ResolveExecutionContextInput {
  return {
    workspaceId, userId: 'actor',
    assistant: { id: 'assistant', workspaceId, kind: 'standard', clearance: 'internal', compartments: [] },
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'actor' } },
    ownership: { kind: 'workspace', workspaceId },
    lifecycle: { abortSignal: new AbortController().signal, sessionId: 'session', channelType: 'web', channelId: 'channel' },
  }
}
function scope(): ResolvedTurnScope {
  return {
    access: { workspaceId, userId: 'actor', assistantId: 'assistant', assistantKind: 'standard',
      clearance: 'internal', compartments: ['team'], mutationCompartments: ['team'], projectIds: ['project'],
      visibilityAssistantIds: ['assistant'] },
    activeGroupId: null, activeProjectId: null,
    effectiveCompartments: ['team'], effectiveProjectIds: ['project'], writeCompartments: ['team'], writeProjectIds: ['project'],
    activeTeam: null, activeProject: null,
  }
}
function fixture(overrides: { input?: ResolveExecutionContextInput; available?: boolean; eligible?: boolean; defaultRead?: boolean } = {}) {
  const source = scope()
  let event!: (event: PermissionInvalidation) => void
  let time = 100
  const unsubscribe = vi.fn()
  const subscribe: typeof subscribePermissionInvalidation = vi.fn((_workspace, callback) => {
    event = callback
    return { eligible: overrides.eligible ?? true, available: overrides.available ?? true, unsubscribe }
  })
  const resolveScope = vi.fn(async () => source)
  const resolve = vi.fn(resolveExecutionContextSystem)
  const readNextTransition = vi.fn(async (): Promise<unknown> => null)
  const currentInput = overrides.input ?? input()
  const cache = createExecutionPermissionSnapshots(currentInput, {
    resolveExecutionContext: resolve,
    ...(overrides.defaultRead ? {} : { readNextTransition }),
    resolveScope,
    resolveAssistant: async () => currentInput.assistant,
    pinPolicyEpoch: async () => async () => true,
    createLease: () => ({ markOperationMayHaveExecuted() {}, async assertCurrent() {}, async execute(operation) { return operation() } }),
  }, { subscribe, now: () => time })
  return { cache, source, resolve, resolveScope, readNextTransition, unsubscribe, subscribe,
    tick: (value: number) => { time = value },
    dirty: (available = true) => event({ dirty: true, eligible: true, available, reason: 'workspace' }),
  }
}

describe('execution permission snapshots (opt-in, no runtime wiring)', () => {
  it('subscribes before lazy resolution using the existing resolver and reuses clean snapshots', async () => {
    const f = fixture()
    expect(f.subscribe).toHaveBeenCalledWith(workspaceId, expect.any(Function))
    expect(f.resolve).not.toHaveBeenCalled()
    expect(f.readNextTransition).not.toHaveBeenCalled()
    const first = await f.cache.beforeAction()
    expect(Object.isFrozen(first.executionContext)).toBe(true)
    expect(first.executionContext).toBe((await f.resolve.mock.results[0].value).executionContext)
    expect(await f.cache.beforeAction()).toBe(first)
    expect(f.resolve).toHaveBeenCalledOnce()
    expect(f.readNextTransition.mock.invocationCallOrder[0]).toBeLessThan(f.resolve.mock.invocationCallOrder[0])
    f.cache.dispose()
  })

  it('pins caller identity, lifecycle facts and trusted callbacks before lazy loading', async () => {
    const original = input()
    const credentialCurrent = vi.fn(async () => true)
    original.credentialCurrent = credentialCurrent
    const f = fixture({ input: original })
    original.userId = 'different-actor'
    if (original.identity.kind === 'attended') original.identity.principal.userId = 'different-actor'
    original.lifecycle.channelId = 'different-channel'
    original.credentialCurrent = async () => false
    const selected = await f.cache.beforeAction()
    expect(selected.executionContext.security.access.userId).toBe('actor')
    expect(selected.executionContext.lifecycle.channelId).toBe('channel')
    expect(f.resolve.mock.calls[0][0].credentialCurrent).toBe(credentialCurrent)
    f.cache.dispose()
  })

  it('coalesces bursts and parallel admissions, detaching nested facts from reused store scopes', async () => {
    const f = fixture()
    const old = await f.cache.beforeAction()
    f.source.effectiveProjectIds = ['new-project']
    f.source.writeCompartments.push('new-team')
    f.source.access.mutationCompartments = ['team', 'new-team']
    f.source.access.compartments = ['team', 'new-team']
    f.source.writeProjectIds = ['new-project']
    f.source.access.projectIds = ['new-project']
    f.dirty(); f.dirty(); f.dirty()
    expect(f.resolve).toHaveBeenCalledOnce()
    const [fresh, same] = await Promise.all([f.cache.beforeAction(), f.cache.beforeAction()])
    expect(fresh).toBe(same)
    expect(f.resolve).toHaveBeenCalledTimes(2)
    expect(fresh.executionContext).not.toBe(old.executionContext)
    expect(fresh.turnScope).not.toBe(old.turnScope)
    expect(old.turnScope.effectiveProjectIds).toEqual(['project'])
    expect(old.turnScope.access.projectIds).toEqual(['project'])
    expect(old.turnScope.writeCompartments).toEqual(['team'])
    expect(fresh.turnScope.access.projectIds).toEqual(['new-project'])
    expect(Object.isFrozen(old.turnScope.access.projectIds)).toBe(true)
    expect(Object.isFrozen(old.turnScope.access)).toBe(true)
    expect(Object.isFrozen(f.source.writeCompartments)).toBe(false)
    f.cache.dispose()
  })

  it('propagates deadlines without TTL and refreshes exactly at the scheduled transition', async () => {
    const f = fixture()
    f.readNextTransition.mockResolvedValueOnce(200)
    const old = await f.cache.beforeAction()
    f.tick(199)
    expect(await f.cache.beforeAction()).toBe(old)
    f.tick(200)
    expect(await f.cache.beforeAction()).not.toBe(old)
    f.tick(999999)
    await f.cache.beforeAction()
    expect(f.resolve).toHaveBeenCalledTimes(2)
    f.cache.dispose()
  })

  it('rejects a deadline crossed during scope resolution', async () => {
    const f = fixture()
    f.readNextTransition.mockResolvedValueOnce(150)
    f.resolveScope.mockImplementationOnce(async () => { f.tick(150); return f.source })
    await expect(f.cache.beforeAction()).rejects.toMatchObject({ reason: 'permission_snapshot_unavailable' })
    await expect(f.cache.beforeAction()).resolves.toBeDefined()
    expect(f.resolve).toHaveBeenCalledTimes(2)
    f.cache.dispose()
  })

  it.each([undefined, '200', NaN, Infinity, {}, new Date()])('fails closed on malformed deadline %s before resolving', async deadline => {
    const f = fixture()
    f.readNextTransition.mockResolvedValueOnce(deadline)
    await expect(f.cache.beforeAction()).rejects.toMatchObject({ reason: 'permission_snapshot_unavailable' })
    expect(f.resolve).not.toHaveBeenCalled()
    f.cache.dispose()
  })

  it('uses only workspace metadata for the default transition read', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ refresh_at: 200 }] })
    const f = fixture({ defaultRead: true })
    await f.cache.beforeAction()
    const [sql, values] = db.query.mock.calls.at(-1)!
    expect(values).toEqual([workspaceId])
    for (const table of ['department_edges', 'project_shared_members', 'application_native_role_assignments', 'workspace_access_grants']) {
      expect(sql).toContain(`public.${table}`)
    }
    expect(sql).toContain("status='active'")
    expect(sql).toContain('revoked_at IS NULL')
    expect(sql).toContain('statement_timestamp()')
    f.tick(200)
    db.query.mockResolvedValueOnce({ rows: [{ refresh_at: null }] })
    await f.cache.beforeAction()
    expect(f.resolve).toHaveBeenCalledTimes(2)
    f.cache.dispose()
  })

  it('fails closed on missing transition metadata and supports explicit failure cleanup', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    const f = fixture({ defaultRead: true })
    await expect(f.cache.beforeAction()).rejects.toMatchObject({ reason: 'permission_snapshot_unavailable' })
    expect(f.resolve).not.toHaveBeenCalled()
    f.cache.dispose()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })

  it('requires a workspace with matching assistant and ownership, permitting resolver workspace fallback', () => {
    const personal = input(); personal.ownership = { kind: 'personal', ownerUserId: 'actor' }
    const absent = input(); absent.workspaceId = null; absent.assistant.workspaceId = null
    const mismatch = input(); mismatch.workspaceId = '22222222-2222-4222-8222-222222222222'
    const malformed = input(); malformed.workspaceId = 'invalid'
    for (const value of [personal, absent, mismatch, malformed]) {
      expect(() => fixture({ input: value })).toThrow('Current permissions cannot be verified')
    }
    const fallback = input(); delete fallback.workspaceId
    fixture({ input: fallback }).cache.dispose()
  })

  it.each([{ available: false }, { eligible: false }])('does not resolve on unavailable transport %j', async config => {
    const f = fixture(config)
    await expect(f.cache.beforeAction()).rejects.toMatchObject({ reason: 'permission_snapshot_unavailable' })
    expect(f.resolve).not.toHaveBeenCalled()
    f.cache.dispose()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })

  it('never falls back after read/resolver failures, and abort/dispose cleans up once', async () => {
    const value = input(), controller = new AbortController()
    value.lifecycle.abortSignal = controller.signal
    const f = fixture({ input: value })
    await f.cache.beforeAction()
    f.dirty()
    f.readNextTransition.mockRejectedValueOnce(new Error('metadata unavailable'))
    await expect(f.cache.beforeAction()).rejects.toThrow('metadata unavailable')
    f.resolve.mockRejectedValueOnce(new Error('resolution failed'))
    await expect(f.cache.beforeAction()).rejects.toThrow('resolution failed')
    await expect(f.cache.beforeAction()).resolves.toBeDefined()
    controller.abort()
    f.cache.dispose()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    await expect(f.cache.beforeAction()).rejects.toMatchObject({ reason: 'permission_snapshot_unavailable' })
  })

  it('rejects transport loss during resolution and permits a fresh read after reconnect', async () => {
    const f = fixture()
    f.resolveScope.mockImplementationOnce(async () => { f.dirty(false); return f.source })
    await expect(f.cache.beforeAction()).rejects.toMatchObject({ reason: 'permission_snapshot_unavailable' })
    f.dirty(true)
    await expect(f.cache.beforeAction()).resolves.toBeDefined()
    expect(f.resolve).toHaveBeenCalledTimes(2)
    f.cache.dispose()
  })
})
