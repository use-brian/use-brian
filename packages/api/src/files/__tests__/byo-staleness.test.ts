import { describe, it, expect, vi } from 'vitest'
import { sweepStaleByoBindings, BYO_DISCONNECT_GRACE_MS, BYO_STALE_RETRACT_REASON } from '../byo-staleness.js'
import type { ConnectorInstance } from '../../db/connector-instance-store.js'

const NOW = 1_900_000_000_000 // fixed clock
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString()

function inst(over: Partial<ConnectorInstance>): ConnectorInstance {
  return {
    id: 'inst', scope: 'workspace', userId: null, workspaceId: 'ws_1', provider: 'gcs',
    label: 'GCS', connectedEmail: null, url: null, custom: false, config: {},
    sensitivity: 'internal', connected: false, ingestionEnabled: false, ingestWorkspaceId: null,
    credentialsType: 'none', healthStatus: 'ok', lastError: null, lastCheckedAt: null,
    createdBy: 'u', createdAt: new Date(NOW), updatedAt: new Date(NOW),
    ...over,
  }
}

function makeDeps(instances: ConnectorInstance[]) {
  const updateCredentialsSystem = vi.fn(async () => {})
  const setConfigSystem = vi.fn(async () => {})
  const retractByStorageBucketSystem = vi.fn(async () => 3)
  return {
    connectorInstanceStore: {
      listByProviderSystem: vi.fn(async () => instances),
      updateCredentialsSystem,
      setConfigSystem,
    },
    workspaceFilesStore: { retractByStorageBucketSystem },
    nowMs: NOW,
    updateCredentialsSystem,
    setConfigSystem,
    retractByStorageBucketSystem,
  }
}

describe('[COMP:files/byo-staleness] sweepStaleByoBindings', () => {
  it('reclaims a binding disconnected past grace: retracts files (by config bucket) + marks swept', async () => {
    const deps = makeDeps([inst({ id: 'old', config: { bucket: 'cust-bucket', disconnectedAt: daysAgo(31) } })])
    const res = await sweepStaleByoBindings(deps)
    expect(res.swept).toBe(1)
    expect(res.retractedFiles).toBe(3)
    expect(deps.retractByStorageBucketSystem).toHaveBeenCalledWith('ws_1', 'cust-bucket', BYO_STALE_RETRACT_REASON)
    expect(deps.setConfigSystem).toHaveBeenCalledWith('old', { staleSwept: true })
    expect(deps.updateCredentialsSystem).toHaveBeenCalledWith('old', { type: 'none' })
  })

  it('leaves a binding still within grace alone (reconnect can still revive it)', async () => {
    const deps = makeDeps([inst({ id: 'recent', config: { bucket: 'cust-bucket', disconnectedAt: daysAgo(5) } })])
    const res = await sweepStaleByoBindings(deps)
    expect(res.scanned).toBe(1)
    expect(res.swept).toBe(0)
    expect(deps.retractByStorageBucketSystem).not.toHaveBeenCalled()
  })

  it('never touches a connected binding', async () => {
    const deps = makeDeps([inst({ id: 'live', connected: true, config: { bucket: 'b', disconnectedAt: daysAgo(99) } })])
    const res = await sweepStaleByoBindings(deps)
    expect(res.scanned).toBe(0)
    expect(res.swept).toBe(0)
  })

  it('skips an already-swept binding (idempotent)', async () => {
    const deps = makeDeps([inst({ id: 'done', config: { bucket: 'b', disconnectedAt: daysAgo(99), staleSwept: true } })])
    const res = await sweepStaleByoBindings(deps)
    expect(res.scanned).toBe(0)
    expect(res.swept).toBe(0)
  })

  it('skips a disconnected binding with no disconnectedAt marker', async () => {
    const deps = makeDeps([inst({ id: 'legacy', config: { bucket: 'b' } })])
    const res = await sweepStaleByoBindings(deps)
    expect(res.scanned).toBe(0)
    expect(res.swept).toBe(0)
  })

  it('honors a custom grace window', async () => {
    const deps = makeDeps([inst({ id: 'd', config: { bucket: 'b', disconnectedAt: daysAgo(2) } })])
    const res = await sweepStaleByoBindings({ ...deps, graceMs: 24 * 60 * 60 * 1000 }) // 1-day grace
    expect(res.swept).toBe(1)
    expect(BYO_DISCONNECT_GRACE_MS).toBeGreaterThan(0)
  })
})
