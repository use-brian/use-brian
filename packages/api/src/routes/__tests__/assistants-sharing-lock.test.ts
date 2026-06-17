import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { assistantRoutes } from '../assistants.js'
import { queryWithRLS } from '../../db/client.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)

const capabilityStore = {
  listActive: vi.fn(),
  hasActive: vi.fn(),
  listAllActive: vi.fn(),
  listHistoryForAssistant: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}

beforeEach(() => {
  mockQueryWithRLS.mockReset()
  capabilityStore.hasActive.mockReset()
})

function makeApp(opts: { userId: string }) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { userId: string }).userId = opts.userId
    next()
  })
  app.use('/api/assistants', assistantRoutes({ capabilityStore: capabilityStore as never }))
  return app
}

describe('[COMP:routes/assistants-sharing-lock] PATCH /:assistantId sharing_mode hard-lock', () => {
  it('rejects enabling sharing when the assistant has active capability grants (409)', async () => {
    // 1. membership check: owner
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 } as never)
    // hasActive: has grants
    capabilityStore.hasActive.mockResolvedValueOnce(true)

    const res = await request(makeApp({ userId: 'u-owner' }))
      .patch('/api/assistants/a-1')
      .send({ sharingMode: 'public' })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SHARING_LOCKED_BY_GRANTS')
    // Critically, the UPDATE query must NOT have been issued.
    expect(mockQueryWithRLS).toHaveBeenCalledTimes(1) // only the membership check
  })

  it('allows setting sharing_mode=off even when the assistant has active grants', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 } as never) // membership
      .mockResolvedValueOnce({ // UPDATE
        rows: [{ id: 'a-1', name: 'Bot', system_prompt: null, slack_model_alias: 'standard', telegram_model_alias: 'standard', whatsapp_model_alias: 'standard' }],
        rowCount: 1,
      } as never)
    capabilityStore.hasActive.mockResolvedValueOnce(true) // has grants — but we're setting off, so no check

    const res = await request(makeApp({ userId: 'u-owner' }))
      .patch('/api/assistants/a-1')
      .send({ sharingMode: 'off' })

    expect(res.status).toBe(200)
    // hasActive should not even be called for sharingMode='off'
    expect(capabilityStore.hasActive).not.toHaveBeenCalled()
  })

  it('allows enabling sharing when the assistant has no active grants', async () => {
    mockQueryWithRLS
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 } as never) // membership
      .mockResolvedValueOnce({ // UPDATE
        rows: [{ id: 'a-1', name: 'Bot', system_prompt: null, slack_model_alias: 'standard', telegram_model_alias: 'standard', whatsapp_model_alias: 'standard' }],
        rowCount: 1,
      } as never)
    capabilityStore.hasActive.mockResolvedValueOnce(false)

    const res = await request(makeApp({ userId: 'u-owner' }))
      .patch('/api/assistants/a-1')
      .send({ sharingMode: 'public' })

    expect(res.status).toBe(200)
    expect(capabilityStore.hasActive).toHaveBeenCalledWith('a-1')
  })

  it('403 for non-owner members (hard-lock never runs)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)

    const res = await request(makeApp({ userId: 'u-member' }))
      .patch('/api/assistants/a-1')
      .send({ sharingMode: 'public' })

    expect(res.status).toBe(403)
    expect(capabilityStore.hasActive).not.toHaveBeenCalled()
  })
})
