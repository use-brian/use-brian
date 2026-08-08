/**
 * Migration 416 collapsed `assistants.{slack,telegram,whatsapp}_model_alias`
 * into two columns cut along the axis that actually decides which one a turn
 * reads: whether the surface has a `channel_assistants` routing row.
 *
 *   - `default_model_alias` — no routing row exists (hosted official Telegram
 *     and WhatsApp bots), plus the seed for a newly attached channel.
 *   - `api_model_alias`     — owner-paid public traffic (`sk_live_` API and
 *     the `/c/<token>` chat link), settable independently so capping a public
 *     link no longer downgrades the owner's own bot.
 *
 * These tests pin the write path: the two fields are independent, the
 * pre-416 per-platform keys still land (the Telegram Mini App manage page and
 * any third-party script send them), and both stay owner-only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

vi.mock('../../db/users.js', () => ({
  resolveAssistantAccess: vi.fn(),
}))

import { assistantRoutes } from '../assistants.js'
import { query, queryWithRLS } from '../../db/client.js'
import { resolveAssistantAccess } from '../../db/users.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockAccess = vi.mocked(resolveAssistantAccess)
const mockQuery = vi.mocked(query)

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
  mockQuery.mockReset()
})

function makeApp(userId: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { userId: string }).userId = userId
    next()
  })
  app.use('/api/assistants', assistantRoutes({ capabilityStore: capabilityStore as never }))
  return app
}

const updatedRow = {
  id: 'a-1',
  name: 'Bot',
  system_prompt: null,
  default_model_alias: 'max',
  api_model_alias: 'standard',
  clearance: 'internal',
}

function asOwner() {
  mockAccess.mockResolvedValueOnce({
    assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' },
    role: 'owner',
  } as never)
  mockQueryWithRLS.mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as never)
}

/** The SET clause + bound values of the single UPDATE the route issues. */
function update(): { sql: string; values: unknown[] } {
  return {
    sql: mockQueryWithRLS.mock.calls[0][1] as string,
    values: mockQueryWithRLS.mock.calls[0][2] as unknown[],
  }
}

describe('[COMP:routes/assistants-model-tiers] PATCH /:assistantId model tiers', () => {
  it('writes defaultModelAlias to default_model_alias, untouched by the API tier', async () => {
    asOwner()

    const res = await request(makeApp('u-owner'))
      .patch('/api/assistants/a-1')
      .send({ defaultModelAlias: 'max' })

    expect(res.status).toBe(200)
    expect(res.body.defaultModelAlias).toBe('max')
    const { sql, values } = update()
    expect(sql).toContain('default_model_alias = $')
    expect(sql).not.toContain('api_model_alias = $')
    expect(values).toContain('max')
  })

  it('writes apiModelAlias to api_model_alias without touching the default tier', async () => {
    asOwner()

    const res = await request(makeApp('u-owner'))
      .patch('/api/assistants/a-1')
      .send({ apiModelAlias: 'standard' })

    expect(res.status).toBe(200)
    expect(res.body.apiModelAlias).toBe('standard')
    const { sql, values } = update()
    expect(sql).toContain('api_model_alias = $')
    expect(sql).not.toContain('default_model_alias = $')
    expect(values).toContain('standard')
  })

  it('sets both independently in one request', async () => {
    asOwner()

    const res = await request(makeApp('u-owner'))
      .patch('/api/assistants/a-1')
      .send({ defaultModelAlias: 'max', apiModelAlias: 'standard' })

    expect(res.status).toBe(200)
    const { sql, values } = update()
    expect(sql).toContain('default_model_alias = $')
    expect(sql).toContain('api_model_alias = $')
    expect(values).toContain('max')
    expect(values).toContain('standard')
  })

  // Pre-416 clients. The Mini App manage page shipped `telegramModelAlias`
  // and is installed in users' Telegram apps; it must keep working against a
  // deployed API, and must land on the tier the official bot actually reads.
  it.each(['telegramModelAlias', 'slackModelAlias', 'whatsappModelAlias'])(
    'folds the legacy %s key onto default_model_alias',
    async (legacyKey) => {
      asOwner()

      const res = await request(makeApp('u-owner'))
        .patch('/api/assistants/a-1')
        .send({ [legacyKey]: 'max' })

      expect(res.status).toBe(200)
      const { sql, values } = update()
      expect(sql).toContain('default_model_alias = $')
      expect(sql).not.toContain('api_model_alias = $')
      expect(values).toContain('max')
    },
  )

  it('never writes the retired per-platform columns', async () => {
    asOwner()

    await request(makeApp('u-owner'))
      .patch('/api/assistants/a-1')
      .send({ telegramModelAlias: 'max' })

    const { sql } = update()
    expect(sql).not.toContain('telegram_model_alias')
    expect(sql).not.toContain('slack_model_alias')
    expect(sql).not.toContain('whatsapp_model_alias')
  })

  it('rejects an out-of-range tier before issuing any UPDATE', async () => {
    mockAccess.mockResolvedValueOnce({
      assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' },
      role: 'owner',
    } as never)

    const res = await request(makeApp('u-owner'))
      .patch('/api/assistants/a-1')
      .send({ apiModelAlias: 'gemini-flash' })

    expect(res.status).toBe(400)
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('stays owner-only — a member setting either tier is rejected whole', async () => {
    for (const field of ['defaultModelAlias', 'apiModelAlias']) {
      mockQueryWithRLS.mockReset()
      mockAccess.mockResolvedValueOnce({
        assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' },
        role: 'member',
      } as never)

      const res = await request(makeApp('u-member'))
        .patch('/api/assistants/a-1')
        .send({ [field]: 'max', systemPrompt: 'allowed on its own' })

      expect(res.status).toBe(403)
      expect(mockQueryWithRLS).not.toHaveBeenCalled()
    }
  })
})
