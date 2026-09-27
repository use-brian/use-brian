import { describe, expect, it, vi } from 'vitest'
import type { AccessCeiling } from '@use-brian/core'
import { createAuthorityLease, runWithAuthorityLease, assertCurrentAuthority, executeWithCurrentAuthority } from '../authority-lease.js'

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
})
