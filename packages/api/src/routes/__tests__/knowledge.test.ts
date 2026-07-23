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
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
// The access gate is the single predicate now, not a route-local join. Mock it
// explicitly so these tests drive authorization on purpose rather than through
// whatever the generic `query` stub happens to return.
// See [COMP:api/assistant-access].
vi.mock('../../db/users.js', () => ({
  resolveAssistantAccess: vi.fn(),
}))

vi.mock('../../db/workspace-store.js', async (io) => ({
  ...(await io<typeof import('../../db/workspace-store.js')>()),
  getWorkspaceMembershipWithClearanceSystem: (...a: unknown[]) => mockMembership(...a),
}))

import { knowledgeRoutes, workspaceKnowledgeRoutes } from '../knowledge.js'
import { query, queryWithRLS } from '../../db/client.js'
import { resolveAssistantAccess } from '../../db/users.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)
const mockAccess = vi.mocked(resolveAssistantAccess)

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
  createSource: vi.fn(),
  updateSourceWriteAccess: vi.fn(),
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
  getCredentials: vi.fn(),
}
const connectorGrantStore = {
  listForTargetSystem: vi.fn(),
}

function appWs(userId?: string, allowLocalSources = true) {
  return createTestApp(
    '/api/workspaces/:workspaceId/knowledge',
    workspaceKnowledgeRoutes({
      knowledgeStore: knowledgeStore as never,
      allowLocalSources,
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
  mockAccess.mockResolvedValue({
    assistant: { id: 'a-1', name: 'A', workspaceId: 'ws-1', clearance: 'internal' },
    role: 'member',
  } as never)
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

  it('returns 403, not 404, when the assistant does not exist', async () => {
    // The predicate returns null for both "missing" and "exists but no access",
    // and callers must not distinguish them — a 404 here would disclose
    // assistant existence across workspace boundaries. This route used to 404.
    mockAccess.mockResolvedValue(null as never)
    expect(
      (await request(app('u-1')).get('/api/assistants/ghost/knowledge/entries')).status,
    ).toBe(403)
  })

  it('returns 403 when the caller is not a member of the assistant or its team', async () => {
    mockAccess.mockResolvedValue(null as never)
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

describe('[COMP:api/kb-write-capability] POST /sources — create-time write probe', () => {
  function ghInst(over: Record<string, unknown>) {
    return {
      scope: 'user', userId: 'u-1', workspaceId: null, provider: 'github', label: 'GH',
      connectedEmail: null, url: null, custom: false, config: {}, sensitivity: 'internal',
      connected: true, ingestionEnabled: false, credentialsType: 'oauth',
      healthStatus: 'ok', lastError: null, lastCheckedAt: null, createdBy: 'u-1',
      createdAt: new Date(0), updatedAt: new Date(0), ...over,
    }
  }

  /** URL-routed GitHub stub for the pre-connect validation + the probe. */
  function stubGithub(opts: { probeStatus?: number; push?: boolean }) {
    const b64 = Buffer.from('---\ntitle: X\ndescription: d\n---\nBody').toString('base64')
    return vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (/\/git\/ref\/heads\//.test(url)) {
        return new Response(JSON.stringify({ object: { sha: 'headsha' } }), { status: 200 })
      }
      if (url.includes('/git/trees/')) {
        return new Response(JSON.stringify({ tree: [
          { path: 'docs/index.md', type: 'blob' },
          { path: 'docs/products/vault.md', type: 'blob' },
          { path: 'docs/products/fees.md', type: 'blob' },
        ] }), { status: 200 })
      }
      if (url.includes('/contents/')) {
        return new Response(JSON.stringify({ content: b64, encoding: 'base64' }), { status: 200 })
      }
      if (/api\.github\.com\/repos\/acme\/kb$/.test(url)) {
        // The write-capability probe (getRepoPermissions).
        if (opts.probeStatus && opts.probeStatus !== 200) {
          return new Response('boom', { status: opts.probeStatus })
        }
        return new Response(JSON.stringify({ permissions: { push: opts.push === true, pull: true, admin: false } }), { status: 200 })
      }
      return new Response('unexpected: ' + url, { status: 500 })
    })
  }

  function wireHappyPath() {
    mockRls.mockResolvedValue({ rows: [{ role: 'member', clearance: 'internal', compartments: null }], rowCount: 1 } as never)
    mockMembership.mockResolvedValue({ role: 'member', clearance: 'internal' })
    connectorInstanceStore.listByUser.mockResolvedValue([ghInst({ id: 'own-gh' })])
    connectorInstanceStore.listByWorkspace.mockResolvedValue([])
    connectorGrantStore.listForTargetSystem.mockResolvedValue([
      { grantedByUserId: 'u-1', instance: ghInst({ id: 'own-gh' }) },
    ])
    connectorInstanceStore.getCredentials.mockResolvedValue({ client_id: 'github_pat', client_secret: 'ghp_x' })
    knowledgeStore.createSource.mockResolvedValue({ id: 'src-new', workspaceId: 'ws-1', repo: 'acme/kb' })
    knowledgeStore.updateSourceWriteAccess.mockResolvedValue(undefined)
  }

  it('probes push permission after creating the source and persists the result', async () => {
    wireHappyPath()
    vi.stubGlobal('fetch', stubGithub({ push: true }))
    try {
      const res = await request(appWs('u-1'))
        .post('/api/workspaces/ws-1/knowledge/sources')
        .send({ repo: 'acme/kb', branch: 'main', rootPath: 'docs', connectorInstanceId: 'own-gh' })
      expect(res.status).toBe(201)
      expect(knowledgeStore.createSource).toHaveBeenCalled()
      // The just-created source is writable immediately, not after the first tick.
      expect(knowledgeStore.updateSourceWriteAccess).toHaveBeenCalledWith('src-new', true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('still creates the source when the probe fails (best-effort; the tick re-probes)', async () => {
    wireHappyPath()
    vi.stubGlobal('fetch', stubGithub({ probeStatus: 500 }))
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const res = await request(appWs('u-1'))
        .post('/api/workspaces/ws-1/knowledge/sources')
        .send({ repo: 'acme/kb', branch: 'main', rootPath: 'docs', connectorInstanceId: 'own-gh' })
      expect(res.status).toBe(201)
      expect(knowledgeStore.updateSourceWriteAccess).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('[COMP:api/knowledge-route] local filesystem sources', () => {
  it('is unavailable unless the standalone composition explicitly enables it', async () => {
    mockRls.mockResolvedValueOnce({
      rows: [{ role: 'admin', clearance: 'confidential', compartments: null }],
      rowCount: 1,
    } as never)
    const res = await request(appWs('u1', false))
      .post('/api/workspaces/ws-1/knowledge/sources')
      .send({ sourceType: 'local', localPath: '/tmp' })
    expect(res.status).toBe(404)
    expect(knowledgeStore.createSource).not.toHaveBeenCalled()
  })

  it('allows a workspace admin to connect a readable markdown directory', async () => {
    // realpath so the expected `repo` matches what the route stores: on macOS
    // `tmpdir()` (/tmp) is a symlink to /private/tmp, which the route canonicalizes.
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'brian-local-kb-route-')))
    try {
      await writeFile(join(dir, 'index.md'), '# Local knowledge')
      mockRls.mockResolvedValueOnce({
        rows: [{ role: 'admin', clearance: 'confidential', compartments: null }],
        rowCount: 1,
      } as never)
      knowledgeStore.createSource.mockResolvedValueOnce({
        id: 'local-source', workspaceId: 'ws-1', sourceType: 'local', repo: dir,
        branch: 'local', rootPath: '', lastSyncedSha: null, lastSyncedAt: null,
        syncError: null, connectorInstanceId: null, writeAccess: null,
        writeAccessCheckedAt: null, createdAt: new Date(),
      })

      const res = await request(appWs('u1'))
        .post('/api/workspaces/ws-1/knowledge/sources')
        .send({ sourceType: 'local', localPath: dir })

      expect(res.status).toBe(201)
      expect(knowledgeStore.createSource).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws-1', sourceType: 'local', repo: dir, branch: 'local', rootPath: '',
      }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects local filesystem sources from ordinary workspace members', async () => {
    mockRls.mockResolvedValueOnce({
      rows: [{ role: 'member', clearance: 'internal', compartments: null }],
      rowCount: 1,
    } as never)

    const res = await request(appWs('u1'))
      .post('/api/workspaces/ws-1/knowledge/sources')
      .send({ sourceType: 'local', localPath: '/tmp' })

    expect(res.status).toBe(403)
    expect(knowledgeStore.createSource).not.toHaveBeenCalled()
  })
})
