/**
 * Unit tests for the knowledge-base routes.
 * Component tag: [COMP:api/knowledge-route].
 *
 * Mocks `query` / `queryWithRLS` (the assistant + membership +
 * clearance lookups) and mounts knowledgeRoutes() with an injected
 * mock store. Verifies the membership gate, GET /entries (browse +
 * search), GET /entries/:id workspace-scoping, POST /entries
 * (source-synced lock, required-field validation, 23505→409), and the
 * DELETE /entries/:id ownership check.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

// The GitHub picker resolves the caller's clearance via this lookup; stub it
// (effectiveReadClearance stays real). Deferred arrow dodges the hoist trap.
const mockMembership = vi.fn()
vi.mock('../../db/workspace-store.js', async (io) => ({
  ...(await io<typeof import('../../db/workspace-store.js')>()),
  getWorkspaceMembershipWithClearanceSystem: (...a: unknown[]) => mockMembership(...a),
}))

import { knowledgeRoutes, workspaceKnowledgeRoutes } from '../knowledge.js'
import { query, queryWithRLS } from '../../db/client.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)

const knowledgeStore = {
  search: vi.fn(),
  listByPath: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  listSources: vi.fn(),
  listSourcesForAssistant: vi.fn(),
  listDisabledSourceIds: vi.fn(),
  setSourceDisabled: vi.fn(),
  getSource: vi.fn(),
}

function app(userId?: string) {
  return createTestApp(
    '/api/assistants/:assistantId/knowledge',
    knowledgeRoutes({ knowledgeStore: knowledgeStore as never }),
    userId ? { userId } : undefined,
  )
}

// Connector stores for the workspace-scoped GitHub picker.
const connectorInstanceStore = {
  listByUser: vi.fn(),
  listByWorkspace: vi.fn(),
}
const connectorGrantStore = {
  listForTargetSystem: vi.fn(),
}

function appWs(userId?: string) {
  return createTestApp(
    '/api/workspaces/:workspaceId/knowledge',
    workspaceKnowledgeRoutes({
      knowledgeStore: knowledgeStore as never,
      connectorInstanceStore: connectorInstanceStore as never,
      connectorGrantStore: connectorGrantStore as never,
    }),
    userId ? { userId } : undefined,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: assistant exists in ws-1; caller is a direct member; clearance internal.
  mockQuery.mockResolvedValue({
    rows: [{ workspace_id: 'ws-1', clearance: 'internal' }],
    rowCount: 1,
  } as never)
  mockRls.mockResolvedValue({ rows: [{ role: 'member' }], rowCount: 1 } as never)
  knowledgeStore.listSources.mockResolvedValue([])
  knowledgeStore.listSourcesForAssistant.mockResolvedValue([])
  knowledgeStore.listDisabledSourceIds.mockResolvedValue([])
  knowledgeStore.setSourceDisabled.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:api/knowledge-route] GET /github/instances (usable picker)', () => {
  function ghInst(over: Record<string, unknown>) {
    return {
      scope: 'user', userId: 'u-1', workspaceId: null, provider: 'github', label: 'GH',
      connectedEmail: null, url: null, custom: false, config: {}, sensitivity: 'internal',
      connected: true, ingestionEnabled: false, credentialsType: 'oauth',
      healthStatus: 'ok', lastError: null, lastCheckedAt: null, createdBy: 'u-1',
      createdAt: new Date(0), updatedAt: new Date(0), ...over,
    }
  }

  it('lists own-exposed + teammate-granted GitHub within clearance; hides unexposed-own, above-clearance and non-GitHub', async () => {
    // workspace_members row for verifyWorkspaceMember.
    mockRls.mockResolvedValue({ rows: [{ role: 'member', clearance: 'internal', compartments: null }], rowCount: 1 } as never)
    mockMembership.mockResolvedValue({ role: 'member', clearance: 'internal' })
    connectorInstanceStore.listByUser.mockResolvedValue([
      ghInst({ id: 'own-gh', label: 'My GitHub' }),
      // Connected in ANOTHER workspace, never exposed here — must not surface
      // (the fls.com.hk Knowledge picker leak).
      ghInst({ id: 'own-elsewhere', label: 'My other GitHub' }),
    ])
    connectorInstanceStore.listByWorkspace.mockResolvedValue([])
    connectorGrantStore.listForTargetSystem.mockResolvedValue([
      { grantedByUserId: 'u-1', instance: ghInst({ id: 'own-gh', label: 'My GitHub' }) },
      { grantedByUserId: 'alice', instance: ghInst({ id: 'alice-gh', userId: 'alice', label: 'Alice GH', sensitivity: 'internal' }) },
      { grantedByUserId: 'bob', instance: ghInst({ id: 'bob-gh', userId: 'bob', sensitivity: 'confidential' }) },
      { grantedByUserId: 'carol', instance: ghInst({ id: 'carol-notion', userId: 'carol', provider: 'notion', sensitivity: 'public' }) },
    ])

    const res = await request(appWs('u-1')).get('/api/workspaces/ws-1/knowledge/github/instances')
    expect(res.status).toBe(200)
    const ids = (res.body.instances as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toContain('own-gh')
    expect(ids).toContain('alice-gh')
    expect(ids).not.toContain('own-elsewhere') // owned, but not exposed to this workspace
    expect(ids).not.toContain('bob-gh') // above the member's internal clearance
    expect(ids).not.toContain('carol-notion') // not a GitHub connector
  })
})

describe('[COMP:api/knowledge-route] GET /entries', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await request(app()).get('/api/assistants/a-1/knowledge/entries')).status).toBe(401)
  })

  it('returns 404 when the assistant does not exist', async () => {
    mockQuery.mockReset()
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(
      (await request(app('u-1')).get('/api/assistants/ghost/knowledge/entries')).status,
    ).toBe(404)
  })

  it('returns 403 when the caller is not a member of the assistant or its team', async () => {
    mockRls.mockReset()
    mockRls.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    expect(
      (await request(app('u-1')).get('/api/assistants/a-1/knowledge/entries')).status,
    ).toBe(403)
  })

  it('browses entries by path', async () => {
    knowledgeStore.listByPath.mockResolvedValueOnce([
      { id: 'e-1', path: 'docs/x', title: 'X', summary: 's', tags: [], sensitivity: 'internal' },
    ])
    const res = await request(app('u-1')).get('/api/assistants/a-1/knowledge/entries')
    expect(res.status).toBe(200)
    expect(res.body.entries[0].id).toBe('e-1')
  })

  it('searches entries when a q param is supplied', async () => {
    knowledgeStore.search.mockResolvedValueOnce([
      { id: 'e-9', path: 'p', title: 'hit', summary: 's', tags: [], sensitivity: 'internal' },
    ])
    const res = await request(app('u-1')).get('/api/assistants/a-1/knowledge/entries?q=hit')
    expect(res.status).toBe(200)
    expect(knowledgeStore.search).toHaveBeenCalled()
    expect(res.body.entries[0].title).toBe('hit')
  })
})

describe('[COMP:api/knowledge-route] GET /entries/:id', () => {
  it('returns 404 when the entry belongs to another workspace', async () => {
    knowledgeStore.getById.mockResolvedValueOnce({ id: 'e-1', workspaceId: 'other-ws' })
    expect(
      (await request(app('u-1')).get('/api/assistants/a-1/knowledge/entries/e-1')).status,
    ).toBe(404)
  })

  it('returns the entry when it belongs to the assistant workspace', async () => {
    knowledgeStore.getById.mockResolvedValueOnce({ id: 'e-1', workspaceId: 'ws-1', title: 'Doc' })
    const res = await request(app('u-1')).get('/api/assistants/a-1/knowledge/entries/e-1')
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('Doc')
  })
})

describe('[COMP:api/knowledge-route] POST /entries', () => {
  it('rejects writes when the KB is synced from a GitHub source', async () => {
    knowledgeStore.listSources.mockResolvedValueOnce([{ id: 'src-1' }])
    const res = await request(app('u-1'))
      .post('/api/assistants/a-1/knowledge/entries')
      .send({ path: 'p', title: 't', content: 'c' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('GitHub')
  })

  it('rejects a body missing path / title / content', async () => {
    const res = await request(app('u-1'))
      .post('/api/assistants/a-1/knowledge/entries')
      .send({ path: 'p' })
    expect(res.status).toBe(400)
  })

  it('creates an entry (201) from a valid body', async () => {
    knowledgeStore.create.mockResolvedValueOnce({ id: 'e-new', path: 'docs/new' })
    const res = await request(app('u-1'))
      .post('/api/assistants/a-1/knowledge/entries')
      .send({ path: 'docs/new', title: 'New', content: 'body', sensitivity: 'public' })
    expect(res.status).toBe(201)
    expect(knowledgeStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', path: 'docs/new', sensitivity: 'public' }),
    )
  })

  it('maps a unique-violation at the same path to 409', async () => {
    knowledgeStore.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
    const res = await request(app('u-1'))
      .post('/api/assistants/a-1/knowledge/entries')
      .send({ path: 'docs/dup', title: 'T', content: 'c' })
    expect(res.status).toBe(409)
  })
})

describe('[COMP:api/knowledge-route] GET /sources (per-assistant enablement)', () => {
  it('annotates each source with enabled=true by default', async () => {
    knowledgeStore.listSourcesForAssistant.mockResolvedValueOnce([
      { id: 'src-1', repo: 'org/a' },
      { id: 'src-2', repo: 'org/b' },
    ])
    knowledgeStore.listDisabledSourceIds.mockResolvedValueOnce([])
    const res = await request(app('u-1')).get('/api/assistants/a-1/knowledge/sources')
    expect(res.status).toBe(200)
    expect(res.body.sources).toEqual([
      { id: 'src-1', repo: 'org/a', enabled: true },
      { id: 'src-2', repo: 'org/b', enabled: true },
    ])
  })

  it('marks a denylisted source as enabled=false', async () => {
    knowledgeStore.listSourcesForAssistant.mockResolvedValueOnce([
      { id: 'src-1', repo: 'org/a' },
      { id: 'src-2', repo: 'org/b' },
    ])
    knowledgeStore.listDisabledSourceIds.mockResolvedValueOnce(['src-2'])
    const res = await request(app('u-1')).get('/api/assistants/a-1/knowledge/sources')
    expect(res.body.sources.find((s: any) => s.id === 'src-2').enabled).toBe(false)
    expect(res.body.sources.find((s: any) => s.id === 'src-1').enabled).toBe(true)
  })
})

describe('[COMP:api/knowledge-route] PATCH /sources/:id/enablement', () => {
  it('rejects a non-boolean enabled with 400', async () => {
    const res = await request(app('u-1'))
      .patch('/api/assistants/a-1/knowledge/sources/src-1/enablement')
      .send({ enabled: 'yes' })
    expect(res.status).toBe(400)
    expect(knowledgeStore.setSourceDisabled).not.toHaveBeenCalled()
  })

  it('returns 404 when the source belongs to another workspace', async () => {
    knowledgeStore.getSource.mockResolvedValueOnce({ id: 'src-1', workspaceId: 'other-ws' })
    const res = await request(app('u-1'))
      .patch('/api/assistants/a-1/knowledge/sources/src-1/enablement')
      .send({ enabled: false })
    expect(res.status).toBe(404)
    expect(knowledgeStore.setSourceDisabled).not.toHaveBeenCalled()
  })

  it('disables a source for this assistant (disabled=true)', async () => {
    knowledgeStore.getSource.mockResolvedValueOnce({ id: 'src-1', workspaceId: 'ws-1' })
    const res = await request(app('u-1'))
      .patch('/api/assistants/a-1/knowledge/sources/src-1/enablement')
      .send({ enabled: false })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, enabled: false })
    expect(knowledgeStore.setSourceDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: 'a-1', sourceId: 'src-1', disabled: true, userId: 'u-1' }),
    )
  })

  it('re-enables a source (disabled=false)', async () => {
    knowledgeStore.getSource.mockResolvedValueOnce({ id: 'src-1', workspaceId: 'ws-1' })
    const res = await request(app('u-1'))
      .patch('/api/assistants/a-1/knowledge/sources/src-1/enablement')
      .send({ enabled: true })
    expect(res.status).toBe(200)
    expect(knowledgeStore.setSourceDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ disabled: false }),
    )
  })
})

describe('[COMP:api/knowledge-route] DELETE /entries/:id', () => {
  it('deletes an entry owned by the workspace (204)', async () => {
    knowledgeStore.getById.mockResolvedValueOnce({ id: 'e-1', workspaceId: 'ws-1' })
    knowledgeStore.delete.mockResolvedValueOnce(true)
    expect(
      (await request(app('u-1')).delete('/api/assistants/a-1/knowledge/entries/e-1')).status,
    ).toBe(204)
  })

  it('returns 404 when the entry belongs to another workspace', async () => {
    knowledgeStore.getById.mockResolvedValueOnce({ id: 'e-1', workspaceId: 'other' })
    expect(
      (await request(app('u-1')).delete('/api/assistants/a-1/knowledge/entries/e-1')).status,
    ).toBe(404)
    expect(knowledgeStore.delete).not.toHaveBeenCalled()
  })
})
