import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// The route resolves the caller's effective clearance through the workspace
// store module. Keep the pure `effectiveReadClearance` real (it IS the gate
// semantics under test) and mock only the membership lookup.
vi.mock('../../db/workspace-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/workspace-store.js')>()
  return {
    ...actual,
    getWorkspaceMembershipWithClearanceSystem: vi.fn(),
  }
})

// The lazy General-teamspace heal touches the DB — stub it out.
vi.mock('../../db/teamspace-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/teamspace-store.js')>()
  return {
    ...actual,
    ensureDefaultTeamspaceSystem: vi.fn(async () => 'ts-general'),
  }
})

import { getWorkspaceMembershipWithClearanceSystem } from '../../db/workspace-store.js'
import { teamspacesRoutes } from '../teamspaces.js'
import type { Teamspace, TeamspaceStore } from '../../db/teamspace-store.js'

const NOW = new Date('2026-07-09T00:00:00Z')

function ts(partial: Partial<Teamspace> = {}): Teamspace {
  return {
    id: 'ts-1',
    workspaceId: 'w-1',
    name: 'Engineering',
    icon: null,
    description: null,
    sensitivity: 'internal',
    isDefault: false,
    position: 0,
    createdBy: 'u-1',
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  }
}

function makeStore(overrides: Partial<Record<keyof TeamspaceStore, unknown>> = {}): TeamspaceStore {
  return {
    listForUser: vi.fn(async () => [ts()]),
    getSystem: vi.fn(async () => ts()),
    memberCountsSystem: vi.fn(async () => new Map([['ts-1', 3]])),
    create: vi.fn(async (params: { name: string }) => ts({ id: 'ts-new', name: params.name })),
    update: vi.fn(async () => ts({ name: 'Renamed' })),
    remove: vi.fn(async () => true),
    isMemberSystem: vi.fn(async () => true),
    listMembersSystem: vi.fn(async () => []),
    addMemberSystem: vi.fn(async () => undefined),
    removeMemberSystem: vi.fn(async () => true),
    hasMemberBelowSystem: vi.fn(async () => false),
    ...overrides,
  } as unknown as TeamspaceStore
}

function member(role: 'owner' | 'admin' | 'member', clearance: 'public' | 'internal' | 'confidential') {
  vi.mocked(getWorkspaceMembershipWithClearanceSystem).mockImplementation(
    async (userId: string) => (userId.startsWith('u-') ? { role, clearance } : null),
  )
}

function app(store: TeamspaceStore, userId = 'u-1') {
  return createTestApp('/api', teamspacesRoutes({ teamspaceStore: store }), { userId })
}

beforeEach(() => {
  vi.mocked(getWorkspaceMembershipWithClearanceSystem).mockReset()
})

describe('[COMP:api/teamspaces-route] teamspace list + create', () => {
  it('403s a non-workspace-member on list', async () => {
    vi.mocked(getWorkspaceMembershipWithClearanceSystem).mockResolvedValue(null)
    const res = await request(app(makeStore())).get('/api/workspaces/w-1/teamspaces')
    expect(res.status).toBe(403)
  })

  it('lists the caller\'s teamspaces with memberCount and clearance-derived canManage', async () => {
    member('member', 'internal')
    const store = makeStore({
      listForUser: vi.fn(async () => [
        ts({ id: 'ts-1', sensitivity: 'internal' }),
        ts({ id: 'ts-2', name: 'Fundraising', sensitivity: 'confidential' }),
      ]),
      memberCountsSystem: vi.fn(async () => new Map([['ts-1', 3], ['ts-2', 2]])),
    })
    const res = await request(app(store)).get('/api/workspaces/w-1/teamspaces')
    expect(res.status).toBe(200)
    expect(res.body.teamspaces).toHaveLength(2)
    // An internal-cleared member manages an internal teamspace (no admin
    // floor) but not a confidential one — the connector-transfer posture.
    expect(res.body.teamspaces[0]).toMatchObject({ id: 'ts-1', memberCount: 3, canManage: true })
    expect(res.body.teamspaces[1]).toMatchObject({ id: 'ts-2', memberCount: 2, canManage: false })
  })

  it('caps a new teamspace\'s sensitivity at the creator\'s clearance', async () => {
    member('member', 'internal')
    const res = await request(app(makeStore()))
      .post('/api/workspaces/w-1/teamspaces')
      .send({ name: 'Secret plans', sensitivity: 'confidential' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('sensitivity_exceeds_clearance')
  })

  it('creates a teamspace (any member) and reports the creator as sole member', async () => {
    member('member', 'internal')
    const store = makeStore()
    const res = await request(app(store))
      .post('/api/workspaces/w-1/teamspaces')
      .send({ name: 'Design', sensitivity: 'internal' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ name: 'Design', memberCount: 1, canManage: true })
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w-1', name: 'Design', createdBy: 'u-1', sensitivity: 'internal' }),
    )
  })
})

describe('[COMP:api/teamspaces-route] manage gate', () => {
  it('404s a non-member of the teamspace (existence is not confirmed to outsiders)', async () => {
    member('member', 'confidential')
    const store = makeStore({ isMemberSystem: vi.fn(async () => false) })
    const res = await request(app(store)).patch('/api/teamspaces/ts-1').send({ name: 'X' })
    expect(res.status).toBe(404)
  })

  it('403s a member below the teamspace sensitivity on manage', async () => {
    member('member', 'internal')
    const store = makeStore({ getSystem: vi.fn(async () => ts({ sensitivity: 'confidential' })) })
    const res = await request(app(store)).patch('/api/teamspaces/ts-1').send({ name: 'X' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('insufficient_clearance')
  })

  it('an owner manages regardless of stored column (role bump to confidential)', async () => {
    member('owner', 'internal')
    const store = makeStore({ getSystem: vi.fn(async () => ts({ sensitivity: 'confidential' })) })
    const res = await request(app(store)).patch('/api/teamspaces/ts-1').send({ name: 'Renamed' })
    expect(res.status).toBe(200)
  })

  it('blocks raising sensitivity while any member sits below the new tier', async () => {
    member('owner', 'confidential')
    const store = makeStore({ hasMemberBelowSystem: vi.fn(async () => true) })
    const res = await request(app(store))
      .patch('/api/teamspaces/ts-1')
      .send({ sensitivity: 'confidential' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('member_below_sensitivity')
  })

  it('refuses to delete the default (General) teamspace', async () => {
    member('owner', 'confidential')
    const store = makeStore({ getSystem: vi.fn(async () => ts({ isDefault: true })) })
    const res = await request(app(store)).delete('/api/teamspaces/ts-1')
    expect(res.status).toBe(400)
    expect(store.remove).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/teamspaces-route] membership', () => {
  it('refuses adding a workspace member whose clearance is below the teamspace sensitivity', async () => {
    // Actor u-1 is confidential; target u-2 resolves internal.
    vi.mocked(getWorkspaceMembershipWithClearanceSystem).mockImplementation(async (userId: string) =>
      userId === 'u-1'
        ? { role: 'owner', clearance: 'confidential' as const }
        : { role: 'member', clearance: 'internal' as const },
    )
    const store = makeStore({ getSystem: vi.fn(async () => ts({ sensitivity: 'confidential' })) })
    const res = await request(app(store))
      .post('/api/teamspaces/ts-1/members')
      .send({ userId: '2e9f1b34-0000-4000-8000-000000000002' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('target_clearance_below_sensitivity')
    expect(store.addMemberSystem).not.toHaveBeenCalled()
  })

  it('adds a qualifying workspace member', async () => {
    vi.mocked(getWorkspaceMembershipWithClearanceSystem).mockResolvedValue({
      role: 'member',
      clearance: 'internal',
    })
    const store = makeStore()
    const res = await request(app(store))
      .post('/api/teamspaces/ts-1/members')
      .send({ userId: '2e9f1b34-0000-4000-8000-000000000002' })
    expect(res.status).toBe(201)
    expect(store.addMemberSystem).toHaveBeenCalledWith('ts-1', '2e9f1b34-0000-4000-8000-000000000002')
  })

  it('nobody can be removed from (or leave) the default teamspace', async () => {
    member('owner', 'confidential')
    const store = makeStore({ getSystem: vi.fn(async () => ts({ isDefault: true })) })
    const res = await request(app(store)).delete('/api/teamspaces/ts-1/members/u-1')
    expect(res.status).toBe(400)
    expect(store.removeMemberSystem).not.toHaveBeenCalled()
  })

  it('self-removal (leave) needs no manage clearance on a non-default teamspace', async () => {
    // An internal member of a confidential teamspace (demotion edge) can
    // still walk away — leaving is not a management action.
    member('member', 'internal')
    const store = makeStore({ getSystem: vi.fn(async () => ts({ sensitivity: 'confidential' })) })
    const res = await request(app(store)).delete('/api/teamspaces/ts-1/members/u-1')
    expect(res.status).toBe(200)
    expect(store.removeMemberSystem).toHaveBeenCalledWith('ts-1', 'u-1')
  })

  it('removing someone else is clearance-gated', async () => {
    member('member', 'internal')
    const store = makeStore({ getSystem: vi.fn(async () => ts({ sensitivity: 'confidential' })) })
    const res = await request(app(store)).delete('/api/teamspaces/ts-1/members/u-other')
    expect(res.status).toBe(403)
    expect(store.removeMemberSystem).not.toHaveBeenCalled()
  })
})
