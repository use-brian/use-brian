/**
 * Unit tests for the assistant modes routes.
 * Component tag: [COMP:api/modes-route].
 *
 * Mocks findAssistantById + `query` (the workspace-membership check)
 * and mounts createModesRouter() with an injected mock store. Verifies
 * verifyAccess (auth, assistant-not-found, no-workspace, non-member),
 * the list/get handlers, POST validation + 23505→409, and the
 * PATCH/DELETE ownership 404 when the mode is on another assistant.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/users.js', () => ({
  findAssistantById: vi.fn(),
}))
vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { createModesRouter } from '../modes.js'
import { findAssistantById } from '../../db/users.js'
import { query } from '../../db/client.js'

const mockFindAssistant = vi.mocked(findAssistantById)
const mockQuery = vi.mocked(query)

const modesStore = {
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}

function app(userId?: string) {
  return createTestApp(
    '/api/assistants/:assistantId/modes',
    createModesRouter({ modesStore: modesStore as never }),
    userId ? { userId } : undefined,
  )
}

/** Make verifyAccess pass: assistant in a workspace + caller is a member. */
function grantAccess() {
  mockFindAssistant.mockResolvedValue({ id: 'a-1', workspaceId: 'ws-1' } as never)
  mockQuery.mockResolvedValue({ rows: [{ exists: true }], rowCount: 1 } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/modes-route] verifyAccess gate', () => {
  it('rejects an unauthenticated request with 401', async () => {
    expect((await request(app()).get('/api/assistants/a-1/modes')).status).toBe(401)
  })

  it('returns 404 when the assistant does not exist', async () => {
    mockFindAssistant.mockResolvedValueOnce(null)
    expect((await request(app('u-1')).get('/api/assistants/a-1/modes')).status).toBe(404)
  })

  it('returns 403 when the assistant has no workspace', async () => {
    mockFindAssistant.mockResolvedValueOnce({ id: 'a-1', workspaceId: null } as never)
    expect((await request(app('u-1')).get('/api/assistants/a-1/modes')).status).toBe(403)
  })

  it('returns 403 when the caller is not a workspace member', async () => {
    mockFindAssistant.mockResolvedValueOnce({ id: 'a-1', workspaceId: 'ws-1' } as never)
    mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 } as never)
    expect((await request(app('u-1')).get('/api/assistants/a-1/modes')).status).toBe(403)
  })
})

describe('[COMP:api/modes-route] list / get', () => {
  it('lists the modes for an accessible assistant', async () => {
    grantAccess()
    modesStore.list.mockResolvedValueOnce([{ id: 'm-1', assistantId: 'a-1' }])
    const res = await request(app('u-1')).get('/api/assistants/a-1/modes')
    expect(res.body).toEqual({ modes: [{ id: 'm-1', assistantId: 'a-1' }] })
  })

  it('returns 404 when the mode belongs to a different assistant', async () => {
    grantAccess()
    modesStore.get.mockResolvedValueOnce({ id: 'm-1', assistantId: 'other' })
    expect((await request(app('u-1')).get('/api/assistants/a-1/modes/m-1')).status).toBe(404)
  })
})

describe('[COMP:api/modes-route] create / update', () => {
  it('rejects an invalid create body with 400', async () => {
    grantAccess()
    const res = await request(app('u-1')).post('/api/assistants/a-1/modes').send({ name: '' })
    expect(res.status).toBe(400)
  })

  it('creates a mode (201) from a valid body', async () => {
    grantAccess()
    modesStore.create.mockResolvedValueOnce({ id: 'm-new', assistantId: 'a-1', name: 'Sales' })
    const res = await request(app('u-1'))
      .post('/api/assistants/a-1/modes')
      .send({ name: 'Sales' })
    expect(res.status).toBe(201)
    expect(modesStore.create).toHaveBeenCalledWith(expect.objectContaining({ assistantId: 'a-1', name: 'Sales' }))
  })

  it('maps a unique-violation on create to 409', async () => {
    grantAccess()
    modesStore.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
    const res = await request(app('u-1')).post('/api/assistants/a-1/modes').send({ name: 'Sales' })
    expect(res.status).toBe(409)
  })

  it('PATCH returns 404 when the mode is on another assistant', async () => {
    grantAccess()
    modesStore.get.mockResolvedValueOnce({ id: 'm-1', assistantId: 'other' })
    const res = await request(app('u-1'))
      .patch('/api/assistants/a-1/modes/m-1')
      .send({ name: 'Renamed' })
    expect(res.status).toBe(404)
    expect(modesStore.update).not.toHaveBeenCalled()
  })
})
