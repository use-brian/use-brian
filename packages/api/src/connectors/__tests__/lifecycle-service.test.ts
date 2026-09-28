import { describe, expect, it, vi } from 'vitest'
import type { McpSettingsStore } from '@use-brian/core'
import type { ConnectorEntry } from '@use-brian/shared'

import type { ConnectorStore } from '../../db/connector-store.js'
import type { ConnectorInstance, ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import {
  ConnectorLifecycleError,
  createConnectorLifecycleService,
} from '../lifecycle-service.js'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

function instance(over: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    scope: 'user', userId: USER, workspaceId: null, provider: 'github',
    label: 'Work GitHub', connectedEmail: 'person@example.com', url: null,
    custom: false, config: { connectedEmail: 'person@example.com' },
    sensitivity: 'internal', connected: true, ingestionEnabled: false,
    ingestWorkspaceId: null, credentialsType: 'oauth', healthStatus: 'degraded',
    lastError: 'sync delayed', lastCheckedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: USER, createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'), compartments: [], projectIds: [],
    ...over,
  }
}

function harness(
  rows = [instance()],
  directoryInstall: 'reuse_primary' | 'create_new' = 'reuse_primary',
) {
  let current = rows.map((row) => structuredClone(row))
  const update = vi.fn(async (actor: string, id: string, patch: Record<string, unknown>) => {
    const row = current.find((item) => item.id === id && (item.userId === actor || item.scope === 'workspace'))
    if (!row) return null
    const { credentials: _credentials, configPatch: _configPatch, ...publicPatch } = patch
    Object.assign(row, publicPatch)
    if (patch.configPatch) row.config = { ...row.config, ...(patch.configPatch as object) }
    return structuredClone(row)
  })
  const remove = vi.fn(async (actor: string, id: string) => {
    const before = current.length
    current = current.filter((item) => !(item.id === id && item.userId === actor))
    return current.length !== before
  })
  const transferToWorkspace = vi.fn(async (actor: string, id: string, workspaceId: string) => {
    const row = current.find((item) => item.id === id && item.userId === actor && item.scope === 'user')
    if (!row) return null
    Object.assign(row, { scope: 'workspace', userId: null, workspaceId })
    return structuredClone(row)
  })
  const store = {
    listByUser: vi.fn(async (_actor: string, owner: string) => current.filter((row) => row.userId === owner).map((row) => structuredClone(row))),
    get: vi.fn(async (_actor: string, id: string) => current.find((row) => row.id === id) ?? null),
    update,
    delete: remove,
    transferToWorkspace,
    createUserInstance: vi.fn(async (input: Record<string, unknown>) => {
      const created = instance({
        id: `44444444-4444-4444-8444-${String(current.length + 1).padStart(12, '0')}`,
        provider: input.provider as string,
        label: input.label as string,
        connected: input.connected as boolean,
        connectedEmail: (input.connectedEmail as string | null | undefined) ?? null,
        config: (input.config as Record<string, unknown> | undefined) ?? {},
      })
      current.push(created)
      return structuredClone(created)
    }),
  } as unknown as ConnectorInstanceStore
  const settings = {
    getPolicy: vi.fn(async () => null), setPolicy: vi.fn(async () => {}),
    recordUsage: vi.fn(), recordUsageAndGetCount: vi.fn(),
  } as unknown as McpSettingsStore
  const registry: ConnectorEntry[] = [{
    id: 'github', name: 'GitHub', description: 'GitHub', category: 'official',
    auth_type: 'api_key', oauth_required: false, enabled: true, tags: [],
  }]
  const service = createConnectorLifecycleService({
    instanceStore: store,
    legacyStore: {} as ConnectorStore,
    settingsStore: settings,
    registry,
    policy: { directoryInstall },
    canMutateWorkspaceInstance: async () => true,
  })
  return { service, store, settings, update, remove, transferToWorkspace, rows: () => current }
}

describe('[COMP:connectors/lifecycle] shared connector lifecycle', () => {
  it.each(['open', 'hosted'])('runs the same normalized operation fixture for the %s adapter', async () => {
    const h = harness()
    const directory = await h.service.directory(USER)
    const primary = await h.service.disconnect(USER, { kind: 'primary', provider: 'github' })
    const explicit = await h.service.connect(USER, {
      kind: 'instance', instanceId: primary.id, provider: 'github',
    })
    const renamed = await h.service.rename(USER, {
      kind: 'instance', instanceId: primary.id, provider: 'github',
    }, { label: 'Renamed' })

    expect(directory).toEqual([expect.objectContaining({ id: 'github', added: true, connected: true })])
    expect(primary.id).toBe(explicit.id)
    expect(renamed.label).toBe('Renamed')
    expect(h.rows()).toHaveLength(1)
  })

  it('makes the directory install difference an explicit edition policy', async () => {
    const open = harness([instance()], 'reuse_primary')
    const hosted = harness([instance()], 'create_new')
    await open.service.install(USER, 'github')
    await hosted.service.install(USER, 'github')
    expect(open.rows()).toHaveLength(1)
    expect(hosted.rows()).toHaveLength(2)
  })

  it('normalizes primary and explicit targets to the same oldest instance', async () => {
    const newer = instance({ id: '55555555-5555-4555-8555-555555555555', createdAt: new Date('2026-02-01') })
    const h = harness([newer, instance()])
    const primary = await h.service.connect(USER, { kind: 'primary', provider: 'github' })
    const explicit = await h.service.connect(USER, {
      kind: 'instance', instanceId: primary.id, provider: 'github',
    })
    expect(primary.id).toBe('33333333-3333-4333-8333-333333333333')
    expect(explicit.id).toBe(primary.id)
  })

  it('never turns a grantee-visible personal row into mutation authority', async () => {
    const h = harness([instance({ userId: OTHER })])
    await expect(h.service.rename(USER, {
      kind: 'instance', instanceId: h.rows()[0].id, provider: 'github',
    }, { label: 'Stolen' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(h.service.remove(USER, {
      kind: 'instance', instanceId: h.rows()[0].id, provider: 'github',
    })).rejects.toMatchObject({ code: 'forbidden' })
    expect(h.update).not.toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('rejects an explicit instance that does not match the named provider', async () => {
    const h = harness()
    await expect(h.service.connect(USER, {
      kind: 'instance', instanceId: h.rows()[0].id, provider: 'notion',
    })).rejects.toBeInstanceOf(ConnectorLifecycleError)
    expect(h.update).not.toHaveBeenCalled()
  })

  it('disconnect clears intent and display identity in one local mutation', async () => {
    const h = harness()
    await h.service.disconnect(USER, { kind: 'primary', provider: 'github' })
    expect(h.update).toHaveBeenCalledTimes(1)
    expect(h.update).toHaveBeenCalledWith(USER, h.rows()[0].id, {
      connected: false,
      connectedEmail: null,
      configPatch: { connectedEmail: null },
    })
  })

  it('delegates ownership transfer to the store atomic boundary once', async () => {
    const h = harness()
    const transferred = await h.service.transferToWorkspace({
      userId: USER,
      target: { kind: 'instance', instanceId: h.rows()[0].id },
      workspaceId: OTHER,
      sensitivity: 'confidential',
    })
    expect(transferred).toMatchObject({ scope: 'workspace', workspaceId: OTHER })
    expect(h.transferToWorkspace).toHaveBeenCalledOnce()
  })

  it('attaches credentials to the exact provider target without returning the secret', async () => {
    const h = harness()
    const result = await h.service.attachCredentials({
      userId: USER, provider: 'github', fallbackLabel: 'GitHub',
      credentials: { type: 'oauth', client_id: '', client_secret: 'never-return-this' },
      connectedEmail: 'person@example.com',
      configPatch: { account: 'work' },
      instanceId: h.rows()[0].id,
    })
    expect(JSON.stringify(result)).not.toContain('never-return-this')
    expect(h.update).toHaveBeenCalledWith(USER, result.id, expect.objectContaining({
      connected: true,
      configPatch: { account: 'work' },
    }))
  })

  it('keeps static tools visible for a degraded connected instance', async () => {
    const h = harness()
    const inventory = await h.service.tools(USER, { kind: 'primary', provider: 'github' })
    expect(h.rows()[0].healthStatus).toBe('degraded')
    expect(inventory.tools.length).toBeGreaterThan(0)
  })
})
