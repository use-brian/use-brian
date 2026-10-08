/**
 * DELETE /:assistantId runs the assistant teardown and reports a refusal as
 * 409 with a readable message (the Settings tab shows `message`), never the
 * generic 500. Component tag: [COMP:api/assistants-delete-teardown].
 *
 * The teardown's SQL is proven against a real schema in
 * db/__tests__/assistant-teardown.integration.test.ts; this covers the route
 * mapping only.
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
import { queryWithRLS, getPool } from '../../db/client.js'
import { resolveAssistantAccess } from '../../db/users.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockAccess = vi.mocked(resolveAssistantAccess)
const mockGetPool = vi.mocked(getPool)

beforeEach(() => {
  mockQueryWithRLS.mockReset()
  mockGetPool.mockReset()
  // Route guards: role=owner, kind=standard, no other members.
  mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', name: 'A', workspaceId: 'w-1' }, role: 'owner' } as never)
  mockQueryWithRLS
    .mockResolvedValueOnce({ rows: [{ kind: 'standard' }], rowCount: 1 } as never)
    .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
})

function pgClient(answer: (sql: string) => Array<Record<string, unknown>>) {
  const issued: string[] = []
  const client = {
    query: vi.fn((sql: string) => {
      issued.push(sql)
      const rows = answer(sql)
      return Promise.resolve({ rows, rowCount: rows.length })
    }),
    release: vi.fn(),
  }
  mockGetPool.mockReturnValue({ connect: () => Promise.resolve(client) } as never)
  return { client, issued }
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { userId: string }).userId = 'u-owner'
    next()
  })
  app.use('/api/assistants', assistantRoutes({ capabilityStore: {} as never }))
  return app
}

describe('[COMP:api/assistants-delete-teardown] DELETE /:assistantId', () => {
  it('names the skills that still depend on the assistant, as 409, and rolls back', async () => {
    const { client, issued } = pgClient((sql) => {
      if (/FROM assistants WHERE id = \$1 FOR UPDATE/.test(sql)) return [{ workspace_id: 'w-1', kind: 'standard' }]
      if (/JOIN workspace_skill_scope_revisions/.test(sql)) return [{ name: 'Weekly report' }]
      return []
    })

    const res = await request(makeApp()).delete('/api/assistants/a-1')

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('assistant_delete_blocked')
    expect(res.body.message).toContain('Weekly report')
    expect(issued).toContain('ROLLBACK')
    expect(issued).not.toContain('COMMIT')
    expect(issued.some((sql) => /DELETE FROM assistants/.test(sql))).toBe(false)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('deletes through the teardown and commits', async () => {
    const { issued } = pgClient((sql) => {
      if (/FROM assistants WHERE id = \$1 FOR UPDATE/.test(sql)) return [{ workspace_id: 'w-1', kind: 'standard' }]
      if (/kind = 'primary'/.test(sql)) return [{ id: 'a-primary' }]
      return []
    })

    const res = await request(makeApp()).delete('/api/assistants/a-1')

    expect(res.status).toBe(204)
    expect(issued).toContain('DELETE FROM assistants WHERE id = $1')
    expect(issued.indexOf('DELETE FROM assistants WHERE id = $1')).toBeLessThan(issued.indexOf('COMMIT'))
  })
})
