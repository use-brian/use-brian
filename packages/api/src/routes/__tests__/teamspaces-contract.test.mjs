import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { duplexPair } from 'node:stream'
import { text } from 'node:stream/consumers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTeamspace, listTeamspaces, updateTeamspace } from '../../../../../apps/app-web/src/lib/api/teamspaces'
import { teamspacesRoutes } from '../teamspaces.js'
import { createTestApp } from './helpers.js'

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock('@/lib/auth-fetch', () => ({ authFetch }))
vi.mock('@/lib/runtime-public-config', () => ({
  publicRuntimeConfig: () => ({ apiUrl: 'http://api.example.test' }),
}))

// Load the shared runtime code directly so this test also runs before a build.
vi.mock('@use-brian/shared/teamspaces', () => import('../../../../shared/src/teamspaces.js'))
vi.mock('@use-brian/agent-runtime/security/sensitivity.js', () => import('../../../../agent-runtime/src/security/sensitivity.js'))
vi.mock('../../db/teamspace-store.js', () => ({ joinDefaultTeamspacesSystem: vi.fn() }))
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceMembershipWithClearanceSystem: async () => ({ role: 'member', clearance: 'internal' }),
  effectiveReadClearance: () => 'internal',
}))

const teamId = '2e9f1b34-0000-4000-8000-000000000099'
const metadata = {
  id: 'ts-1',
  workspaceId: 'w-1',
  name: 'Field notes',
  icon: '📓',
  description: null,
  sensitivity: 'public',
  workspaceGroupId: null,
  isDefault: false,
  position: 0,
  createdAt: '2026-07-09T00:00:00.000Z',
  updatedAt: '2026-07-09T00:00:00.000Z',
}

beforeEach(() => {
  authFetch.mockReset()
})

describe('[COMP:api/teamspaces-route] [COMP:app-web/teamspaces-sdk] [COMP:app-web/teamspace-context] Teamspace response contract', () => {
  it('reads the saved metadata through the SDK and gets current authority from the list', async () => {
    let row = {
      ...metadata,
      createdBy: 'u-1',
      createdAt: new Date(metadata.createdAt),
      updatedAt: new Date(metadata.updatedAt),
    }
    const update = vi.fn(async (_id, fields) => {
      row = { ...row, ...fields, updatedAt: new Date('2026-07-09T01:00:00Z') }
      return row
    })
    const store = {
      create: vi.fn(async () => row),
      listForUser: vi.fn(async () => row.workspaceGroupId ? [] : [row]),
      memberCountsSystem: vi.fn(async () => new Map([[row.id, 1]])),
      getSystem: vi.fn(async () => row),
      isMemberSystem: vi.fn(async () => !row.workspaceGroupId),
      update,
    }
    const workspaceGroupStore = {
      listGroups: vi.fn(async () => [{ id: teamId, kind: 'team', status: 'active' }]),
    }
    const server = createServer(createTestApp('/api', teamspacesRoutes({
      teamspaceStore: store,
      workspaceGroupStore,
    }), { userId: 'u-1' }))
    let patchResponse
    authFetch.mockImplementation(async (input, init) => {
      const sdkRequest = new Request(input, init)
      const body = sdkRequest.body ? await sdkRequest.text() : undefined
      // Connect native HTTP parsing and serialization over streams, without a port.
      const [client, peer] = duplexPair()
      server.emit('connection', peer)
      try {
        const outgoing = request(sdkRequest.url, {
          method: sdkRequest.method,
          headers: Object.fromEntries(sdkRequest.headers),
          createConnection: () => client,
        })
        const received = once(outgoing, 'response')
        outgoing.end(body)
        const [incoming] = await received
        const payload = await text(incoming)
        if (sdkRequest.method === 'PATCH') patchResponse = JSON.parse(payload)
        return new Response(payload, {
          status: incoming.statusCode,
          headers: { 'content-type': incoming.headers['content-type'] ?? '' },
        })
      } finally {
        client.destroy()
        peer.destroy()
      }
    })

    const fullRow = { ...metadata, memberCount: 1, canManage: true }
    await expect(createTeamspace('w-1', {
      name: metadata.name,
      icon: metadata.icon,
      sensitivity: metadata.sensitivity,
    })).resolves.toEqual(fullRow)
    expect(store.create).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'w-1',
      name: metadata.name,
      icon: metadata.icon,
      description: null,
      sensitivity: metadata.sensitivity,
      createdBy: 'u-1',
    })
    await expect(listTeamspaces('w-1')).resolves.toEqual([fullRow])

    const patch = { name: '  Shared notes  ', icon: null, workspaceGroupId: teamId }
    const savedMetadata = {
      ...metadata,
      ...patch,
      name: 'Shared notes',
      updatedAt: '2026-07-09T01:00:00.000Z',
    }
    await expect(updateTeamspace('ts-1', patch)).resolves.toEqual(savedMetadata)
    expect(patchResponse).toEqual(savedMetadata)
    expect(update).toHaveBeenCalledExactlyOnceWith('ts-1', { ...patch, name: 'Shared notes' })
    await expect(listTeamspaces('w-1')).resolves.toEqual([])
    await expect(updateTeamspace('ts-1', { name: 'Unavailable' })).rejects.toMatchObject({
      name: 'TeamspaceApiError',
      status: 404,
      code: 'Teamspace not found',
    })
  })

  it('accepts a PATCH acknowledgement from before Team linking', async () => {
    const legacy = { ...metadata, workspaceGroupId: undefined, name: 'Older server' }
    authFetch.mockResolvedValueOnce(Response.json(legacy))
    await expect(updateTeamspace('ts-1', { name: legacy.name })).resolves.toEqual({
      ...legacy,
      workspaceGroupId: null,
    })
    expect(authFetch).toHaveBeenCalledExactlyOnceWith(
      'http://api.example.test/api/teamspaces/ts-1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: legacy.name }) }),
    )
  })

  it('rejects a PATCH acknowledgement without the saved name', async () => {
    authFetch.mockResolvedValueOnce(Response.json({ ...metadata, name: undefined }))
    await expect(updateTeamspace('ts-1', { name: 'Renamed' })).rejects.toMatchObject({
      name: 'ZodError',
      issues: [expect.objectContaining({ path: ['name'] })],
    })
  })
})
