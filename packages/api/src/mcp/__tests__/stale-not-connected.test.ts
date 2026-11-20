/**
 * [COMP:api/mcp-catalog] "Not connected" notices are computed once, by the
 * catalog, from the admitted bindings (deletion ledger D11-4).
 *
 * Regression guard for the 2026-07-29 live finding: a workspace-scoped
 * assistant never loads the owner's personal connectors, and the retired
 * injector's personal lane pushed a not-connected notice that a later
 * exposure or workspace-owned lane then falsified; the system prompt claimed
 * the connector was unavailable while the model held its tools. The catalog
 * has no stale notice to retract: it announces a built-in only when no lane
 * admits it, and an `auth_failed` binding only as "reconnect required".
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../connector-config.js', () => ({ getConnectorConfig: () => ({ clientId: 'fixture', clientSecret: 'fixture' }) }))

import { OFFICIAL_CONNECTORS } from '@use-brian/shared'
import { prepareCapabilityCatalog, surfaceProfile } from '../catalog.js'
import { NOT_CONNECTED_CAPABILITIES } from '../providers/notices.js'
import { PROVIDER_MODULES } from '../providers/index.js'
import { NOT_CONNECTED_DISPLAY_NAME } from '../tool-names.js'

const WORKSPACE = 'workspace-example'
const at = (day: number) => new Date(Date.UTC(2030, 0, day))
const instance = (row: { id: string; provider: string } & Record<string, unknown>) => ({
  scope: 'workspace', userId: null, workspaceId: WORKSPACE, connectedEmail: null, url: null, custom: false, config: {},
  sensitivity: 'internal', connected: true, healthStatus: 'ok', compartments: [], projectIds: [], createdAt: at(1), updatedAt: at(2),
  label: String(row.provider), ...row,
})

async function catalogFor(instances: ReturnType<typeof instance>[], grants: unknown[] = []) {
  return prepareCapabilityCatalog({
    profile: surfaceProfile('web'), assistant: { id: 'assistant-example', workspaceId: WORKSPACE }, connectorUserId: 'owner-example',
    stores: {
      connectorStore: { list: vi.fn(async () => []) },
      connectorInstanceStore: { listByWorkspaceSystem: vi.fn(async () => instances) } as never,
      connectorGrantStore: { listForTargetSystem: vi.fn(async () => grants) } as never,
    },
    policyReader: async () => [], actionGrantReader: null, providers: Object.values(PROVIDER_MODULES),
  })
}

const shopifyNotice = (lines: readonly string[]) => lines.filter((line) => line.startsWith('Shopify: not connected'))

describe('[COMP:api/mcp-catalog] not-connected notices from the admitted bindings', () => {
  it('announces nothing for a provider a member exposure provides', async () => {
    const grant = { id: 'grant-shop', connectorInstanceId: 'ci-shop', targetType: 'workspace', targetId: WORKSPACE,
      grantedByUserId: 'member-example', grantedAt: at(3), compartments: [], projectIds: [],
      instance: instance({ id: 'ci-shop', provider: 'shopify', scope: 'user', userId: 'member-example', workspaceId: null }) }
    const catalog = await catalogFor([], [grant])
    expect(catalog.descriptors.some((descriptor) => descriptor.name === 'shopifyGetShop')).toBe(true)
    expect(shopifyNotice(catalog.unavailable)).toEqual([])
  })

  it('announces nothing for a workspace-owned provider, including its second account', async () => {
    const catalog = await catalogFor([instance({ id: 'ci-shop-1', provider: 'shopify', label: 'Main Store' }),
      instance({ id: 'ci-shop-2', provider: 'shopify', label: 'Second Store', createdAt: at(4) })])
    expect(catalog.descriptors.some((descriptor) => descriptor.name.startsWith('shopifyGetShop__secondstore_'))).toBe(true)
    expect(shopifyNotice(catalog.unavailable)).toEqual([])
  })

  it('announces a provider no lane admits, once, with its curated capability text', async () => {
    const catalog = await catalogFor([instance({ id: 'ci-gh', provider: 'github' })])
    expect(shopifyNotice(catalog.unavailable)).toEqual([
      'Shopify: not connected for this assistant (store products, orders, customers, and inventory)'])
    expect(catalog.unavailable.some((line) => line.startsWith('GitHub'))).toBe(false)
  })

  it('reports a dead binding as reconnect required, never also as not connected', async () => {
    const catalog = await catalogFor([instance({ id: 'ci-fathom', provider: 'fathom', label: 'Meetings', healthStatus: 'auth_failed' })])
    expect(catalog.unavailable.filter((line) => line.startsWith('Fathom'))).toEqual([
      'Fathom "Meetings": reconnect required (credentials expired or revoked; Studio → Connectors)'])
  })

  it('has a display name and curated capability text for every announced built-in', () => {
    const described = new Set(Object.values(PROVIDER_MODULES).flatMap((provider) => provider.describe()).map((d) => d.connectorId))
    for (const connectorId of Object.keys(NOT_CONNECTED_CAPABILITIES)) {
      expect(NOT_CONNECTED_DISPLAY_NAME[connectorId], connectorId).toBeDefined()
      expect(described.has(connectorId), `${connectorId} has no described tools`).toBe(true)
      expect(OFFICIAL_CONNECTORS.some((connector) => connector.id === connectorId), connectorId).toBe(true)
    }
  })
})
