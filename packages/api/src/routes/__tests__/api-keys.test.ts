import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { apiKeyRoutes } from '../api-keys.js'
import { createTestApp } from './helpers.js'

const store = { create: vi.fn(), listForUser: vi.fn(), revokeForUser: vi.fn() }
const app = (userId?: string) => createTestApp(
  '/api/assistants/:assistantId/integrations/api-keys',
  apiKeyRoutes(store as never),
  userId ? { userId } : undefined,
)

beforeEach(() => vi.resetAllMocks())

describe('[COMP:api/integrations-api-keys] API key management', () => {
  it('validates authentication and create input', async () => {
    expect((await request(app()).post('/api/assistants/a-1/integrations/api-keys').send({ name: 'k' })).status).toBe(401)
    expect((await request(app('u-1')).post('/api/assistants/a-1/integrations/api-keys').send({})).status).toBe(400)
    expect((await request(app('u-1')).post('/api/assistants/a-1/integrations/api-keys').send({ name: 'k', extra: true })).status).toBe(400)
  })

  it('returns plaintext once and defaults scope to chat', async () => {
    store.create.mockResolvedValueOnce({
      id: 'key-1', name: 'CI', plaintext: 'sk_live_secret', prefix: 'sk_live_ab',
      scope: 'chat', status: 'active', createdAt: '2026-05-16T00:00:00Z', lastUsedAt: null,
    })
    const res = await request(app('u-1')).post('/api/assistants/a-1/integrations/api-keys').send({ name: 'CI' })
    expect(res.body.key).toBe('sk_live_secret')
    expect(store.create).toHaveBeenCalledWith({ assistantId: 'a-1', name: 'CI', actingUserId: 'u-1', scope: 'chat' })
  })

  it('lists and revokes keys', async () => {
    store.listForUser.mockResolvedValueOnce([{ id: 'key-1', prefix: 'sk_live_ab' }])
    expect((await request(app('u-1')).get('/api/assistants/a-1/integrations/api-keys')).body.keys).toHaveLength(1)
    store.revokeForUser.mockResolvedValueOnce(true)
    expect((await request(app('u-1')).delete('/api/assistants/a-1/integrations/api-keys/key-1')).status).toBe(204)
    store.revokeForUser.mockResolvedValueOnce(false)
    expect((await request(app('u-1')).delete('/api/assistants/a-1/integrations/api-keys/missing')).status).toBe(404)
  })

  it('maps authorization failures to 403', async () => {
    store.create.mockRejectedValueOnce(new Error('Not authorized to modify this assistant'))
    expect((await request(app('u-1')).post('/api/assistants/a-1/integrations/api-keys').send({ name: 'Nope' })).status).toBe(403)
  })
})
