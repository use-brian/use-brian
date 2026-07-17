import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/memories.js', () => ({
  listMemories: vi.fn(),
  getMemoryById: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  searchMemories: vi.fn(),
  getMemoryStats: vi.fn(),
  getSoul: vi.fn(),
  listWorkspaceMemories: vi.fn(),
  searchWorkspaceMemories: vi.fn(),
  createMemory: vi.fn(),
  listUnverifiedByWorkspace: vi.fn(),
  countUnverifiedByWorkspace: vi.fn(),
  markVerifiedDirect: vi.fn(),
}))

vi.mock('../../db/memory-verifications-store.js', () => ({
  recordVerification: vi.fn(),
}))

vi.mock('../../db/memory-recall-events-store.js', () => ({
  listMemoriesByRecentOutcome: vi.fn(),
}))

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceRoleSystem: vi.fn(),
  // Fused read-ceiling resolver — echo the assistant clearance + compartments
  // so these CRUD tests (which don't assert on clearance/compartments) keep
  // their prior behavior.
  resolveReadCeilingsSystem: vi.fn(
    async (
      _u: string,
      _w: unknown,
      assistantClearance: string,
      assistantCompartments: string[] | null,
    ) => ({ clearance: assistantClearance, compartments: assistantCompartments }),
  ),
}))

// Realtime NOTIFY — the route fires this fire-and-forget on every successful
// write so cross-tab /brain pages repaint. Mock it so we can assert the call
// shape without touching the LISTEN/NOTIFY Postgres machinery.
vi.mock('../../brain-stream/notify.js', () => ({
  notifyBrainInboxChange: vi.fn(),
}))

import {
  listMemories,
  getMemoryById,
  updateMemory,
  deleteMemory,
  searchMemories,
  getMemoryStats,
  getSoul,
  listWorkspaceMemories,
  markVerifiedDirect,
} from '../../db/memories.js'
import { query, queryWithRLS } from '../../db/client.js'
import { getWorkspaceRoleSystem } from '../../db/workspace-store.js'
import { recordVerification } from '../../db/memory-verifications-store.js'
import { notifyBrainInboxChange } from '../../brain-stream/notify.js'
import { memoryRoutes } from '../memories.js'

const mockListMemories = vi.mocked(listMemories)
const mockGetMemoryById = vi.mocked(getMemoryById)
const mockUpdateMemory = vi.mocked(updateMemory)
const mockDeleteMemory = vi.mocked(deleteMemory)
const mockSearchMemories = vi.mocked(searchMemories)
const mockGetMemoryStats = vi.mocked(getMemoryStats)
const mockGetSoul = vi.mocked(getSoul)
const mockListTeamMemories = vi.mocked(listWorkspaceMemories)
const mockMarkVerifiedDirect = vi.mocked(markVerifiedDirect)
const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockGetTeamRoleSystem = vi.mocked(getWorkspaceRoleSystem)
const mockRecordVerification = vi.mocked(recordVerification)
const mockNotifyBrainInboxChange = vi.mocked(notifyBrainInboxChange)

/** Mock membership check — queryWithRLS for assistant_members. */
function setupAuth() {
  mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ user_id: 'u_1' }], rowCount: 1 } as never)
}

function setupNoAuth() {
  mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
}

/**
 * After WU-4.2b, routes that issue a memory store read call
 * `resolveViewerCtx` first — a one-row `query` for the assistant's
 * workspace + clearance. Tests that exercise such routes queue this
 * mock immediately after `setupAuth()` (it's a single shared shape
 * across personal + team routes).
 */
function mockResolveViewerCtx(workspaceId: string | null = 'w_1') {
  mockQuery.mockResolvedValueOnce({
    rows: [{ workspaceId, clearance: 'confidential' }],
    rowCount: 1,
  } as never)
}

describe('[COMP:api/memories-route] Memory routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /', () => {
    it('returns 403 if not a member', async () => {
      setupNoAuth()
      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories')
      expect(res.status).toBe(403)
    })

    it('returns 200 with memories', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockListMemories.mockResolvedValueOnce({
        memories: [{ id: 'mem_1', summary: 'Likes coffee' }],
        total: 1,
      } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories')
      expect(res.status).toBe(200)
      expect(res.body.memories).toHaveLength(1)
      expect(res.body.total).toBe(1)
    })
  })

  describe('GET /stats', () => {
    it('returns 200 with stats', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockGetMemoryStats.mockResolvedValueOnce({ total: 42, totalRecalls: 5 } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories/stats')
      expect(res.status).toBe(200)
    })
  })

  describe('GET /soul', () => {
    it('returns 200 with soul content', async () => {
      setupAuth()
      mockGetSoul.mockResolvedValueOnce('User is an engineer who loves hiking' as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories/soul')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('soul')
    })
  })

  describe('GET /search', () => {
    it('returns 400 without q parameter', async () => {
      setupAuth()
      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories/search')
      expect(res.status).toBe(400)
    })

    it('returns 200 with results', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockSearchMemories.mockResolvedValueOnce([{ id: 'mem_1', summary: 'Likes coffee' }] as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories/search?q=coffee')
      expect(res.status).toBe(200)
      expect(res.body.memories).toHaveLength(1)
    })
  })

  describe('GET /:memoryId', () => {
    it('returns 404 if not found', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockGetMemoryById.mockResolvedValueOnce(null as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories/mem_missing')
      expect(res.status).toBe(404)
    })

    it('returns 200 with memory', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockGetMemoryById.mockResolvedValueOnce({ id: 'mem_1', summary: 'Likes coffee' } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories/mem_1')
      expect(res.status).toBe(200)
      expect(res.body.memory.id).toBe('mem_1')
    })
  })

  describe('PATCH /:memoryId', () => {
    it('returns 400 without fields', async () => {
      setupAuth()
      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).patch('/api/assistants/a_1/memories/mem_1').send({})
      expect(res.status).toBe(400)
    })

    it('returns 200 on success', async () => {
      setupAuth()
      // WS3: the edit route now builds resolveViewerCtx and passes it to
      // updateMemory so the write is access-scoped (the read/write-asymmetry
      // fix) — queue its one-row assistant→workspace query.
      mockResolveViewerCtx('w_1')
      mockUpdateMemory.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'w_1', summary: 'Updated' } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .patch('/api/assistants/a_1/memories/mem_1')
        .send({ summary: 'Updated' })
      expect(res.status).toBe(200)
      expect(res.body.memory.summary).toBe('Updated')
      // Realtime: a PATCH emits an 'update' NOTIFY for the (superseded) row id,
      // scoped to the row's workspace.
      expect(mockNotifyBrainInboxChange).toHaveBeenCalledWith('w_1', 'memory', 'mem_1', 'update')
      // The update is scoped: updateMemory received a viewer ctx as its 3rd arg.
      const call = mockUpdateMemory.mock.calls[0]
      expect(call).toHaveLength(3)
      expect(call[2]).toBeTruthy()
    })

    it('returns 404 when the caller cannot access the assistant (no viewer ctx)', async () => {
      setupAuth()
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // resolveViewerCtx → null

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .patch('/api/assistants/a_1/memories/mem_1')
        .send({ summary: 'Updated' })
      expect(res.status).toBe(404)
      expect(mockUpdateMemory).not.toHaveBeenCalled()
    })
  })

  describe('POST /:memoryId/scope', () => {
    const OWN_MEMORY = { id: 'mem_1', assistantId: 'a_1', userId: 'u_1', scope: 'shared', workspaceId: null }

    it('rejects an unknown target scope', async () => {
      setupAuth()
      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/scope')
        .send({ scope: 'public' })
      expect(res.status).toBe(400)
    })

    it('returns 404 when the memory does not belong to this assistant', async () => {
      setupAuth()
      // Scope route does a single assistant query that doubles as
      // workspace lookup + ctx builder (WU-4.2b).
      mockQuery.mockResolvedValueOnce({
        rows: [{ workspaceId: 'team_x', clearance: 'confidential' }],
        rowCount: 1,
      } as never)
      mockGetMemoryById.mockResolvedValueOnce({ ...OWN_MEMORY, assistantId: 'a_other' } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/scope')
        .send({ scope: 'workspace' })
      expect(res.status).toBe(404)
    })

    it('returns 403 when the memory was authored by another user', async () => {
      setupAuth()
      mockQuery.mockResolvedValueOnce({
        rows: [{ workspaceId: 'team_x', clearance: 'confidential' }],
        rowCount: 1,
      } as never)
      mockGetMemoryById.mockResolvedValueOnce({ ...OWN_MEMORY, userId: 'u_other' } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/scope')
        .send({ scope: 'workspace' })
      expect(res.status).toBe(403)
    })

    it('returns 400 when the assistant is not on a team', async () => {
      setupAuth()
      mockQuery.mockResolvedValueOnce({
        rows: [{ workspaceId: null, clearance: 'confidential' }],
        rowCount: 1,
      } as never)
      mockGetMemoryById.mockResolvedValueOnce(OWN_MEMORY as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/scope')
        .send({ scope: 'workspace' })
      expect(res.status).toBe(400)
    })

    it('returns 403 when the user is not a member of the assistant team', async () => {
      setupAuth()
      mockQuery.mockResolvedValueOnce({
        rows: [{ workspaceId: 'team_x', clearance: 'confidential' }],
        rowCount: 1,
      } as never)
      mockGetMemoryById.mockResolvedValueOnce(OWN_MEMORY as never)
      mockGetTeamRoleSystem.mockResolvedValueOnce(null)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/scope')
        .send({ scope: 'workspace' })
      expect(res.status).toBe(403)
    })

    it('promotes a personal memory to team scope', async () => {
      setupAuth()
      mockQuery.mockResolvedValueOnce({
        rows: [{ workspaceId: 'team_x', clearance: 'confidential' }],
        rowCount: 1,
      } as never)
      mockGetMemoryById.mockResolvedValueOnce(OWN_MEMORY as never)
      mockGetTeamRoleSystem.mockResolvedValueOnce('member')
      mockUpdateMemory.mockResolvedValueOnce({ ...OWN_MEMORY, scope: 'workspace', workspaceId: 'team_x' } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/scope')
        .send({ scope: 'workspace' })
      expect(res.status).toBe(200)
      expect(res.body.memory.scope).toBe('workspace')
      expect(mockUpdateMemory).toHaveBeenCalledWith('mem_1', { scope: 'workspace', workspaceId: 'team_x' })
    })

    it('is idempotent when promoting an already-team memory', async () => {
      setupAuth()
      mockQuery.mockResolvedValueOnce({
        rows: [{ workspaceId: 'team_x', clearance: 'confidential' }],
        rowCount: 1,
      } as never)
      mockGetMemoryById.mockResolvedValueOnce({ ...OWN_MEMORY, scope: 'workspace', workspaceId: 'team_x' } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/scope')
        .send({ scope: 'workspace' })
      expect(res.status).toBe(200)
      expect(mockUpdateMemory).not.toHaveBeenCalled()
    })

    it('demotes a team memory back to personal', async () => {
      setupAuth()
      mockQuery.mockResolvedValueOnce({
        rows: [{ workspaceId: 'team_x', clearance: 'confidential' }],
        rowCount: 1,
      } as never)
      mockGetMemoryById.mockResolvedValueOnce({ ...OWN_MEMORY, scope: 'workspace', workspaceId: 'team_x' } as never)
      mockGetTeamRoleSystem.mockResolvedValueOnce('member')
      mockUpdateMemory.mockResolvedValueOnce({ ...OWN_MEMORY, scope: 'shared', workspaceId: null } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/scope')
        .send({ scope: 'user' })
      expect(res.status).toBe(200)
      expect(mockUpdateMemory).toHaveBeenCalledWith('mem_1', { scope: 'shared', workspaceId: null })
    })
  })

  describe('POST /:memoryId/verify (staged-memory feedback loop)', () => {
    const STAGED_MEMORY = {
      id: 'mem_1',
      assistantId: 'a_1',
      userId: 'u_1',
      workspaceId: 'w_1',
      summary: 'Likes coffee',
      detail: null,
      scope: 'shared',
      sensitivity: 'internal',
      verifiedByUserId: null,
      verifiedAt: null,
    }

    it('returns 403 if not a member', async () => {
      setupNoAuth()
      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).post('/api/assistants/a_1/memories/mem_1/verify').send({})
      expect(res.status).toBe(403)
    })

    it('returns 404 when the memory does not exist', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockGetMemoryById.mockResolvedValueOnce(null as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).post('/api/assistants/a_1/memories/mem_1/verify').send({})
      expect(res.status).toBe(404)
    })

    it('is idempotent for an already-verified memory (no audit row, no stamp)', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockGetMemoryById.mockResolvedValueOnce({
        ...STAGED_MEMORY,
        verifiedByUserId: 'u_other',
      } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).post('/api/assistants/a_1/memories/mem_1/verify').send({})

      expect(res.status).toBe(200)
      expect(mockMarkVerifiedDirect).not.toHaveBeenCalled()
      expect(mockRecordVerification).not.toHaveBeenCalled()
    })

    it('stamps verified + writes a confirm row on success', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockGetMemoryById.mockResolvedValueOnce(STAGED_MEMORY as never)
      mockMarkVerifiedDirect.mockResolvedValueOnce({
        ...STAGED_MEMORY,
        verifiedByUserId: 'u_1',
      } as never)
      mockRecordVerification.mockResolvedValueOnce({ id: 'ver_1' } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).post('/api/assistants/a_1/memories/mem_1/verify').send({})

      expect(res.status).toBe(200)
      expect(mockMarkVerifiedDirect).toHaveBeenCalledWith('mem_1', 'u_1')
      expect(mockRecordVerification).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryId: 'mem_1',
          workspaceId: 'w_1',
          verifiedBy: 'u_1',
          action: 'confirm',
        }),
      )
      // Realtime: a verify emits an 'update' NOTIFY for the memory row.
      expect(mockNotifyBrainInboxChange).toHaveBeenCalledWith('w_1', 'memory', 'mem_1', 'update')
    })
  })

  describe('POST /:memoryId/adjust (staged-memory feedback loop)', () => {
    const STAGED_MEMORY = {
      id: 'mem_1',
      assistantId: 'a_1',
      userId: 'u_1',
      workspaceId: 'w_1',
      summary: 'Likes coffee',
      detail: null,
      scope: 'shared',
      sensitivity: 'internal',
      verifiedByUserId: null,
      verifiedAt: null,
    }

    it('returns 400 with no recognised field changes', async () => {
      setupAuth()
      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).post('/api/assistants/a_1/memories/mem_1/adjust').send({})
      expect(res.status).toBe(400)
    })

    it('returns 400 for an unknown scope value', async () => {
      setupAuth()
      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/adjust')
        .send({ scope: 'public' })
      expect(res.status).toBe(400)
    })

    it('returns 400 for an unknown sensitivity', async () => {
      setupAuth()
      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/adjust')
        // 'bogus' is not a valid sensitivity — the route rejects it at
        // input validation (400) before resolveViewerCtx / any DB call.
        // ('public' is a *valid* value, so it would fall through.)
        .send({ sensitivity: 'bogus' })
      expect(res.status).toBe(400)
    })

    it('returns 404 when the memory is on a different assistant', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockGetMemoryById.mockResolvedValueOnce({
        ...STAGED_MEMORY,
        assistantId: 'a_other',
      } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/adjust')
        .send({ sensitivity: 'confidential' })
      expect(res.status).toBe(404)
    })

    it('writes one verification per changed field and stamps the new row', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockGetMemoryById.mockResolvedValueOnce(STAGED_MEMORY as never)
      mockUpdateMemory.mockResolvedValueOnce({
        ...STAGED_MEMORY,
        id: 'mem_2',
        scope: 'workspace',
        sensitivity: 'confidential',
        summary: 'Loves espresso',
      } as never)
      mockRecordVerification.mockResolvedValue({ id: 'ver' } as never)
      mockMarkVerifiedDirect.mockResolvedValueOnce({
        id: 'mem_2',
        verifiedByUserId: 'u_1',
      } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/adjust')
        .send({
          scope: 'workspace',
          sensitivity: 'confidential',
          summary: 'Loves espresso',
          reason: 'too narrow',
        })

      expect(res.status).toBe(200)
      // updateMemory supersedes the row.
      expect(mockUpdateMemory).toHaveBeenCalledWith(
        'mem_1',
        expect.objectContaining({
          scope: 'workspace',
          sensitivity: 'confidential',
          summary: 'Loves espresso',
        }),
      )
      // One audit row per changed field — scope, sensitivity, edit_summary.
      const actions = mockRecordVerification.mock.calls.map((c) => c[0].action)
      expect(actions).toContain('adjust_scope')
      expect(actions).toContain('adjust_sensitivity')
      expect(actions).toContain('edit_summary')
      // Reason flows through every row.
      mockRecordVerification.mock.calls.forEach((c) => {
        expect(c[0].reason).toBe('too narrow')
      })
      // The new active row gets the verification stamp.
      expect(mockMarkVerifiedDirect).toHaveBeenCalledWith('mem_2', 'u_1')
      // Realtime: an adjust supersedes the row, so the NOTIFY carries the new id.
      expect(mockNotifyBrainInboxChange).toHaveBeenCalledWith('w_1', 'memory', 'mem_2', 'update')
    })

    it('skips audit rows for unchanged fields', async () => {
      setupAuth()
      mockResolveViewerCtx()
      mockGetMemoryById.mockResolvedValueOnce({
        ...STAGED_MEMORY,
        sensitivity: 'confidential',
      } as never)
      mockUpdateMemory.mockResolvedValueOnce({
        ...STAGED_MEMORY,
        id: 'mem_2',
        sensitivity: 'confidential',
        summary: 'Loves espresso',
      } as never)
      mockRecordVerification.mockResolvedValue({ id: 'ver' } as never)
      mockMarkVerifiedDirect.mockResolvedValueOnce({
        id: 'mem_2',
      } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app)
        .post('/api/assistants/a_1/memories/mem_1/adjust')
        .send({
          // sensitivity is already 'confidential' — should not produce an
          // adjust_sensitivity row.
          sensitivity: 'confidential',
          summary: 'Loves espresso',
        })

      expect(res.status).toBe(200)
      const actions = mockRecordVerification.mock.calls.map((c) => c[0].action)
      expect(actions).not.toContain('adjust_sensitivity')
      expect(actions).toContain('edit_summary')
    })
  })

  describe('DELETE /:memoryId', () => {
    it('returns 404 if not found', async () => {
      setupAuth()
      // Pre-delete workspace lookup (returns the row's workspace_id for the NOTIFY).
      mockQuery.mockResolvedValueOnce({ rows: [{ workspaceId: 'w_1' }], rowCount: 1 } as never)
      mockDeleteMemory.mockResolvedValueOnce(false as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).delete('/api/assistants/a_1/memories/mem_1')
      expect(res.status).toBe(404)
      // A 404 (nothing deleted) must not emit a realtime NOTIFY.
      expect(mockNotifyBrainInboxChange).not.toHaveBeenCalled()
    })

    it('returns 204 on success', async () => {
      setupAuth()
      // Pre-delete lookup captures the workspace before the row is gone.
      mockQuery.mockResolvedValueOnce({ rows: [{ workspaceId: 'w_1' }], rowCount: 1 } as never)
      mockDeleteMemory.mockResolvedValueOnce(true as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).delete('/api/assistants/a_1/memories/mem_1')
      expect(res.status).toBe(204)
      // Realtime: a successful delete emits a 'delete' NOTIFY scoped to the
      // captured workspace.
      expect(mockNotifyBrainInboxChange).toHaveBeenCalledWith('w_1', 'memory', 'mem_1', 'delete')
    })
  })

  describe('GET /team', () => {
    it('returns empty for assistant with no team', async () => {
      // The route queries assistants table for workspace_id first
      mockQuery.mockResolvedValueOnce({ rows: [{ workspaceId: null }], rowCount: 1 } as never)
      // Then falls back to assistant_members membership check
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ user_id: 'u_1' }], rowCount: 1 } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories/team')

      // When workspaceId is null, the route returns early with empty result
      // Note: if this resolves as /:memoryId instead, the route ordering places
      // /team, /stats, /soul, /search before /:memoryId so it should work
      expect(res.status).toBe(200)
      expect(res.body.memories).toEqual([])
    })

    it('grants access via workspace_members when user is not a direct assistant member', async () => {
      // Team-owned `kind=app` assistants don't carry per-member rows in
      // assistant_members; access flows through workspace_members. This was the
      // bug behind feed.usebrian.ai's "Failed to fetch" — the Voice page hit
      // the team route, which 403'd because the team admin had no
      // assistant_members row for the team's distribution assistant.
      // After WU-4.2b the route also calls `resolveViewerCtx` to fetch
      // workspace + clearance for the universal predicate, so we prime
      // a second `query` reply.
      mockQuery.mockResolvedValueOnce({ rows: [{ workspaceId: 't_1' }], rowCount: 1 } as never)
      mockGetTeamRoleSystem.mockResolvedValueOnce('admin')
      mockResolveViewerCtx('t_1')
      mockListTeamMemories.mockResolvedValueOnce({
        memories: [{ id: 'mem_1', summary: 'sign off with — the team' }],
        total: 1,
      } as never)

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories/team?limit=100')

      expect(res.status).toBe(200)
      expect(res.body.memories).toHaveLength(1)
      // queryWithRLS for assistant_members should NOT be consulted when team
      // role is positive — no fallback mock was set, and the request still
      // succeeded.
      expect(mockQueryWithRLS).not.toHaveBeenCalled()
    })

    it('returns 403 when user is neither team member nor assistant member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ workspaceId: 't_1' }], rowCount: 1 } as never)
      mockGetTeamRoleSystem.mockResolvedValueOnce(null)
      setupNoAuth()

      const app = createTestApp('/api/assistants/:assistantId/memories', memoryRoutes(), { userId: 'u_1' })
      const res = await request(app).get('/api/assistants/a_1/memories/team')

      expect(res.status).toBe(403)
    })
  })
})
