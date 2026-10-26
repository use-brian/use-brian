import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { pinPolicyEpoch } from '../policy-epoch.js'
import { createAuthorityLease } from '../authority-lease.js'
import type { AccessCeiling } from '@use-brian/core'

const identity = { workspaceId: randomUUID(), principalId: randomUUID(), assistantId: randomUUID() }
const snapshot = () => ({ ...identity, version: 1, workspaceRevision: '1', contractRevision: '1', timedState: 'a'.repeat(64), modules: [
  { moduleKey: 'operations', contractVersion: '1', configurationRevision: '2', ports: 'b'.repeat(64) },
] })
const ceiling: AccessCeiling = { workspaceId: identity.workspaceId, userId: identity.principalId, clearance: 'internal',
  compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [identity.assistantId] }

describe('[COMP:api/policy-epoch] metadata snapshot and sticky lease mechanics', () => {
  it('pins detached content, compares before first data, and never revives after restoration', async () => {
    const state = snapshot(), read = vi.fn(async () => state)
    const current = await pinPolicyEpoch(identity, read)
    expect(await current()).toBe(true)
    state.workspaceRevision = '2'
    expect(await current()).toBe(false)
    state.workspaceRevision = '1'
    expect(await current()).toBe(false)
    expect(read).toHaveBeenCalledTimes(3)
    expect(await (await pinPolicyEpoch(identity, read))()).toBe(true)
  })

  it.each([
    null, {}, { ...snapshot(), payload: 'not metadata' }, { ...snapshot(), principalId: randomUUID() },
    { ...snapshot(), workspaceRevision: '-1' }, { ...snapshot(), contractRevision: 2 },
    { ...snapshot(), timedState: '' }, { ...snapshot(), modules: [{ ...snapshot().modules[0], configurationRevision: '' }] },
    { ...snapshot(), modules: [snapshot().modules[0], snapshot().modules[0]] },
  ])('holds absent, tampered or noncanonical snapshots (%#)', async state => {
    await expect(pinPolicyEpoch(identity, async () => state)).rejects.toMatchObject({ reason: 'authority_changed', retrySafe: false })
  })

  it('holds a failed revision port and keeps underlying diagnostics private', async () => {
    await expect(pinPolicyEpoch(identity, async () => { throw new Error('private metadata') }))
      .rejects.toThrow('Access changed')
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error('private metadata'))
    const current = await pinPolicyEpoch(identity, read)
    expect(await current()).toBe(false)
    expect(await current()).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not let an awaited successful comparison overwrite a concurrent refusal', async () => {
    let release!: (value: unknown) => void
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockResolvedValueOnce({ ...snapshot(), workspaceRevision: '2' })
    const current = await pinPolicyEpoch(identity, read), first = current()
    expect(await current()).toBe(false)
    release(snapshot())
    expect(await first).toBe(false)
  })

  it('compares on both sides of awaited ceiling resolution', async () => {
    let state = snapshot()
    const current = await pinPolicyEpoch(identity, async () => state)
    const lease = createAuthorityLease(ceiling, async () => { state = { ...state, workspaceRevision: '2' }; return ceiling }, current)
    const data = vi.fn(async () => 'protected')
    await expect(lease.execute(data)).rejects.toMatchObject({ reason: 'authority_changed', operationMayHaveExecuted: false })
    expect(data).not.toHaveBeenCalled()
  })

  it('retains uncertain-effect status after an awaited policy change without retries', async () => {
    let state = snapshot()
    const current = await pinPolicyEpoch(identity, async () => state)
    const lease = createAuthorityLease(ceiling, async () => ceiling, current)
    const effect = vi.fn(async () => { state = { ...state, workspaceRevision: '2' }; return 'protected output' })
    await expect(lease.execute(effect)).rejects.toMatchObject({ operationMayHaveExecuted: true, retrySafe: false })
    expect(effect).toHaveBeenCalledOnce()
    await expect(lease.assertCurrent()).rejects.toMatchObject({ operationMayHaveExecuted: true })
  })
})
