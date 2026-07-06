/**
 * Usable-connector resolver — the clearance + dedup boundary behind the
 * display/config surfaces (Studio → Connectors, the Knowledge picker).
 * Component tag: [COMP:connectors/usable-resolver].
 *
 * `effectiveReadClearance` is kept REAL (importOriginal) so the tests exercise
 * the actual owner/admin → confidential and member → column-clearance rule;
 * only the membership lookup is stubbed. `client.js` is mocked so importing
 * the store module never opens a pool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/client.js', () => ({ query: vi.fn(), queryWithRLS: vi.fn() }))

// `vi.hoisted` so the mock fn exists before `vi.mock` (which is hoisted) runs.
const { membershipMock } = vi.hoisted(() => ({ membershipMock: vi.fn() }))
vi.mock('../../db/workspace-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/workspace-store.js')>()
  return { ...actual, getWorkspaceMembershipWithClearanceSystem: membershipMock }
})

import { listUsableWorkspaceConnectors } from '../usable-connectors.js'
import type { ConnectorInstance } from '../../db/connector-instance-store.js'

const U = 'user-1'
const W = 'ws-1'

function inst(over: Partial<ConnectorInstance> & { id: string }): ConnectorInstance {
  return {
    scope: 'user',
    userId: U,
    workspaceId: null,
    provider: 'github',
    label: 'GH',
    connectedEmail: null,
    url: null,
    custom: false,
    config: {},
    sensitivity: 'internal',
    connected: true,
    ingestionEnabled: false,
    credentialsType: 'oauth',
    healthStatus: 'ok',
    lastError: null,
    lastCheckedAt: null,
    createdBy: U,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as ConnectorInstance
}

function makeStores(opts: {
  own?: ConnectorInstance[]
  teamNative?: ConnectorInstance[]
  granted?: Array<{ grantedByUserId: string; instance: ConnectorInstance }>
}) {
  const connectorInstanceStore = {
    listByUser: vi.fn(async () => opts.own ?? []),
    listByWorkspace: vi.fn(async () => opts.teamNative ?? []),
  } as never
  const connectorGrantStore = {
    listForTargetSystem: vi.fn(async () => opts.granted ?? []),
  } as never
  return { connectorInstanceStore, connectorGrantStore }
}

function run(stores: ReturnType<typeof makeStores>) {
  return listUsableWorkspaceConnectors({ ...stores, userId: U, workspaceId: W })
}

describe('[COMP:connectors/usable-resolver] listUsableWorkspaceConnectors', () => {
  beforeEach(() => membershipMock.mockReset())

  it('hides the member’s own personal connector when it is not exposed to this workspace', async () => {
    membershipMock.mockResolvedValue({ role: 'member', clearance: 'confidential' })
    const res = await run(makeStores({ own: [inst({ id: 'own' })] }))
    expect(res).toHaveLength(0)
  })

  it('includes the member’s own EXPOSED personal connector, any tier, clearance-free', async () => {
    membershipMock.mockResolvedValue({ role: 'member', clearance: 'public' })
    const mine = inst({ id: 'own', sensitivity: 'confidential' })
    const res = await run(
      makeStores({ own: [mine], granted: [{ grantedByUserId: U, instance: mine }] }),
    )
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ source: 'personal', instance: expect.objectContaining({ id: 'own' }) })
  })

  it('includes a teammate-granted connector within clearance, hides one above it', async () => {
    membershipMock.mockResolvedValue({ role: 'member', clearance: 'internal' })
    const res = await run(
      makeStores({
        granted: [
          { grantedByUserId: 'alice', instance: inst({ id: 'g1', userId: 'alice', sensitivity: 'internal' }) },
          { grantedByUserId: 'bob', instance: inst({ id: 'g2', userId: 'bob', sensitivity: 'confidential' }) },
        ],
      }),
    )
    expect(res.map((u) => u.instance.id)).toEqual(['g1'])
    expect(res[0]).toMatchObject({ source: 'granted', grantedByUserId: 'alice' })
  })

  it('hides above-clearance team-native connectors from a member', async () => {
    membershipMock.mockResolvedValue({ role: 'member', clearance: 'internal' })
    const res = await run(
      makeStores({
        teamNative: [
          inst({ id: 'tn-pub', scope: 'workspace', userId: null, workspaceId: W, sensitivity: 'public' }),
          inst({ id: 'tn-conf', scope: 'workspace', userId: null, workspaceId: W, sensitivity: 'confidential' }),
        ],
      }),
    )
    expect(res.map((u) => u.instance.id)).toEqual(['tn-pub'])
    expect(res[0].source).toBe('team_native')
  })

  it('owner/admin clearance is confidential — sees a confidential shared connector regardless of column', async () => {
    membershipMock.mockResolvedValue({ role: 'admin', clearance: 'public' })
    const res = await run(
      makeStores({
        teamNative: [inst({ id: 'tn', scope: 'workspace', userId: null, workspaceId: W, sensitivity: 'confidential' })],
      }),
    )
    expect(res.map((u) => u.instance.id)).toEqual(['tn'])
  })

  it('dedups the member’s OWN exposed connector to personal (not "granted")', async () => {
    membershipMock.mockResolvedValue({ role: 'member', clearance: 'confidential' })
    const res = await run(
      makeStores({
        own: [inst({ id: 'mine' })],
        granted: [{ grantedByUserId: U, instance: inst({ id: 'mine' }) }],
      }),
    )
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ source: 'personal', instance: expect.objectContaining({ id: 'mine' }) })
  })

  it('fails closed for a non-member — no workspace-shared visibility, no ungranted personal', async () => {
    membershipMock.mockResolvedValue(null)
    const res = await run(
      makeStores({
        own: [inst({ id: 'own' })],
        teamNative: [inst({ id: 'tn', scope: 'workspace', userId: null, workspaceId: W, sensitivity: 'public' })],
        granted: [{ grantedByUserId: 'x', instance: inst({ id: 'g', userId: 'x', sensitivity: 'public' }) }],
      }),
    )
    expect(res).toHaveLength(0)
  })
})
