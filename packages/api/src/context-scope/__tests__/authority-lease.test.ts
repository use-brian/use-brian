import { describe, expect, it, vi } from 'vitest'
import type { AccessCeiling } from '@use-brian/core'
import { createAuthorityLease, createSessionAuthorityLease, runWithAuthorityLease, assertCurrentAuthority, executeWithCurrentAuthority } from '../authority-lease.js'

const liveSession = vi.hoisted(() => ({ row: null as Record<string, unknown> | null }))
vi.mock('../../db/sessions.js', () => ({ findSessionAuthorityById: async () => liveSession.row }))
vi.mock('../../db/users.js', () => ({ findAssistantById: async (id: string) => ({ id, workspaceId: 'workspace' }) }))
// Each assistant's live ceiling is its own: a standard assistant sees only its rows.
vi.mock('../resolve-turn-scope.js', () => ({
  resolveLiveAccessCeilingSystem: async ({ assistant }: { assistant: { id: string } }) =>
    assistant.id === 'assistant' ? initial : { ...initial, visibilityAssistantIds: [assistant.id] },
}))

const initial: AccessCeiling = { workspaceId: 'workspace', userId: 'actor',
  clearance: 'internal', compartments: ['product'], mutationCompartments:['product'], projectIds: [], visibilityAssistantIds: ['assistant'] }

describe('[COMP:api/authority-lease] current authority at execution boundaries', () => {
  it('rechecks on every boundary and cannot revive a context after revocation', async () => {
    let current: AccessCeiling | null = structuredClone(initial)
    const resolve = vi.fn(async () => current)
    const lease = createAuthorityLease(initial, resolve)
    await lease.assertCurrent()
    await lease.assertCurrent()
    expect(resolve).toHaveBeenCalledTimes(2)
    current = null
    await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    current = initial
    await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(resolve).toHaveBeenCalledTimes(3)
  })

  it('holds a detached starting scope; permission expansion cannot change it', async () => {
    const input = structuredClone(initial)
    let current: AccessCeiling = { ...initial, clearance: 'confidential', compartments: null }
    const lease = createAuthorityLease(input, async () => current)
    input.compartments!.length = 0
    await lease.assertCurrent()
    current = { ...current, compartments: [] }
    await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
  })

  it('checks expiry even without a revision change', async () => {
    let now = 9
    const lease = createAuthorityLease(initial, async () => now < 10 ? initial : { ...initial, compartments: [] })
    await lease.assertCurrent()
    now = 10
    await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
  })

  it('invalidates when only source-mutation permission is revoked',async()=>{
    const lease=createAuthorityLease(initial,async()=>({...initial,mutationCompartments:[]}));
    await expect(lease.assertCurrent()).rejects.toMatchObject({reason:'authority_changed'});
  })

  it('retains parent validators in nested executions', async () => {
    const denied = createAuthorityLease(initial, async () => null)
    const allowed = createAuthorityLease(initial, async () => initial)
    const operation = vi.fn(async () => 'private result')
    await expect(runWithAuthorityLease(denied, () => runWithAuthorityLease(allowed,
      () => executeWithCurrentAuthority(operation)))).rejects.toMatchObject({ operationMayHaveExecuted: false })
    expect(operation).not.toHaveBeenCalled()
    await expect(assertCurrentAuthority()).resolves.toBeUndefined()
  })

  it('withholds a result after revocation during execution without retrying the operation', async () => {
    let revoked = false
    const lease = createAuthorityLease(initial, async () => revoked ? null : initial)
    const operation = vi.fn(async () => { revoked = true; return 'restricted result' })
    await expect(runWithAuthorityLease(lease, () => executeWithCurrentAuthority(operation)))
      .rejects.toMatchObject({ reason: 'authority_changed', operationMayHaveExecuted: true, retrySafe: false })
    expect(operation).toHaveBeenCalledTimes(1)
    await expect(lease.assertCurrent()).rejects.toMatchObject({ operationMayHaveExecuted: true, retrySafe: false })
  })

  it('does not leak an underlying error when validation fails', async () => {
    const lease = createAuthorityLease(initial, async () => { throw new Error('Secret source title') })
    const error = await lease.assertCurrent().catch(e => e)
    expect(error.message).not.toContain('Secret')
    expect(error.reason).toBe('authority_changed')
  })

  it('does not let a concurrent successful check erase invalidation', async () => {
    let release!: (value: AccessCeiling) => void
    let calls = 0
    const lease = createAuthorityLease(initial, async () => ++calls === 1
      ? new Promise<AccessCeiling>(resolve => { release = resolve }) : null)
    const first = lease.assertCurrent()
    await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    release(initial)
    await expect(first).rejects.toMatchObject({ reason: 'authority_changed' })
  })

  describe('session lease', () => {
    const base = { id: 'session', assistantId: 'assistant', userId: 'actor',
      contextGroupId: 'team', contextProjectId: null, contextLockedAt: null as Date | null }

    it('survives the first message locking an unlocked session mid-turn', async () => {
      liveSession.row = { ...base }
      const lease = createSessionAuthorityLease({ starting: initial, session: base })
      await lease.assertCurrent()
      // session_messages_lock_context stamps the lock on the first insert.
      liveSession.row = { ...base, contextLockedAt: new Date('2026-09-29T00:00:00Z') }
      await expect(lease.assertCurrent()).resolves.toBeUndefined()
    })

    it('pins the first observed lock timestamp after an unlocked start', async () => {
      liveSession.row = { ...base }
      const lease = createSessionAuthorityLease({ starting: initial, session: base })
      liveSession.row = { ...base, contextLockedAt: new Date('2026-09-29T00:00:00Z') }
      await expect(lease.assertCurrent()).resolves.toBeUndefined()
      liveSession.row = { ...base, contextLockedAt: new Date('2026-09-29T01:00:00Z') }
      await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    })

    it('still invalidates when the context itself changes', async () => {
      liveSession.row = { ...base }
      const lease = createSessionAuthorityLease({ starting: initial, session: base })
      liveSession.row = { ...base, contextGroupId: 'other-team' }
      await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    })

    it('invalidates tool authority when the live recipient ceiling narrows', async () => {
      liveSession.row = { ...base }
      let maximum: AccessCeiling | null = structuredClone(initial)
      const lease = createSessionAuthorityLease({
        starting: initial,
        session: base,
        maximumAccessCurrent: async () => maximum,
      })
      await expect(lease.assertCurrent()).resolves.toBeUndefined()
      maximum = { ...initial, compartments: [], mutationCompartments: [] }
      await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    })

    it('re-checks the assistant running the turn, not the session binding it was addressed away from', async () => {
      // Doc-dock switch / room @mention: the turn runs as another assistant,
      // and its starting ceiling was resolved for that assistant.
      liveSession.row = { ...base }
      const starting = { ...initial, visibilityAssistantIds: ['doc-assistant'] }
      const lease = createSessionAuthorityLease({ starting, session: base, executingAssistantId: 'doc-assistant' })
      await expect(lease.assertCurrent()).resolves.toBeUndefined()
      // Re-resolving the bound assistant instead can never contain that ceiling.
      const bound = createSessionAuthorityLease({ starting, session: base })
      await expect(bound.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    })

    it('still invalidates a re-addressed turn when the session is rebound', async () => {
      liveSession.row = { ...base }
      const starting = { ...initial, visibilityAssistantIds: ['doc-assistant'] }
      const lease = createSessionAuthorityLease({ starting, session: base, executingAssistantId: 'doc-assistant' })
      liveSession.row = { ...base, assistantId: 'another-assistant' }
      await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    })

    it('invalidates when a pinned lock moves', async () => {
      const locked = { ...base, contextLockedAt: new Date('2026-09-29T00:00:00Z') }
      liveSession.row = { ...locked, contextLockedAt: new Date('2026-09-29T01:00:00Z') }
      const lease = createSessionAuthorityLease({ starting: initial, session: locked })
      await expect(lease.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    })
  })
  it('snapshots a detached locked session only when durable reconstruction is explicitly eligible', async () => {
    const session = { id: 'source-session', assistantId: 'assistant', userId: 'actor', contextGroupId: null,
      visibility: 'owner', mode: null, effectiveClearance: null, contextCompartments: [],
      contextProjectId: null, contextLockedAt: null as Date | null }
    liveSession.row = { ...session }
    const lease = createSessionAuthorityLease({ starting: initial, session, durableSessionSource: true })
    const first = lease.snapshotSource!()
    expect(first.kind).toBe('invocation')
    liveSession.row.contextLockedAt = new Date('2026-10-07T00:00:00Z')
    await lease.assertCurrent()
    const snapshot = lease.snapshotSource!()
    expect(snapshot).toMatchObject({ kind: 'session', id: 'source-session', invocationId: first.invocationId,
      contextLockedAt: '2026-10-07T00:00:00.000Z', executingAssistantId: 'assistant', authorityUserId: 'actor' })
    if (snapshot.kind === 'session') snapshot.id = 'changed-copy'
    expect(lease.snapshotSource!()).toMatchObject({ id: 'source-session' })
    for (const options of [{}, { durableSessionSource: true, credentialCurrent: async () => true },
      { durableSessionSource: true, maximumAccessCurrent: async () => initial }]) {
      const limited = createSessionAuthorityLease({ starting: initial, session: { ...session, contextLockedAt: new Date() }, ...options })
      expect(limited.snapshotSource!().kind).toBe('invocation')
    }
  })

})
