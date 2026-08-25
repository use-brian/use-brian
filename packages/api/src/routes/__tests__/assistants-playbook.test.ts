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

vi.mock('../../db/playbook-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/playbook-store.js')>()
  return {
    ...actual,
    listPlaybookRules: vi.fn(),
    decidePlaybookRule: vi.fn(),
  }
})

import { assistantRoutes } from '../assistants.js'
import { resolveAssistantAccess } from '../../db/users.js'
import { decidePlaybookRule, listPlaybookRules } from '../../db/playbook-store.js'

const mockAccess = vi.mocked(resolveAssistantAccess)
const mockListRules = vi.mocked(listPlaybookRules)
const mockDecide = vi.mocked(decidePlaybookRule)

const capabilityStore = {
  listActive: vi.fn(),
  hasActive: vi.fn(),
  listAllActive: vi.fn(),
  listHistoryForAssistant: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}

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

const RULE = {
  id: 'r-1',
  assistantId: 'a-1',
  rule: 'Confirm the resolution before closing a thread',
  rationale: 'Two threads were reopened',
  provenance: { sessionIds: ['s-1'] },
  status: 'suggested' as const,
  createdBy: 'reflection' as const,
  appliesToUserId: null,
  applicabilityKind: 'general' as const,
  applicabilityKey: null,
  evidenceCount: 0,
  semanticKey: null,
  decisionSensitivity: 'internal' as const,
  decidedByUserId: null,
  decidedAt: null,
  createdAt: '2026-08-07T00:00:00Z',
}

beforeEach(() => {
  mockAccess.mockReset()
  mockListRules.mockReset()
  mockDecide.mockReset()
})

describe('[COMP:routes/assistant-playbook] Playbook list + owner decision gate', () => {
  it('lets any member view the playbook', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', workspaceId: 'w-1' }, role: 'member' } as never)
    mockListRules.mockResolvedValueOnce([RULE])

    const res = await request(makeApp({ userId: 'u-member' })).get('/api/assistants/a-1/playbook')

    expect(res.status).toBe(200)
    expect(res.body.rules).toHaveLength(1)
    expect(res.body.rules[0].rule).toBe(RULE.rule)
    expect(res.body.maxActive).toBeGreaterThan(0)
  })

  it('blocks a non-owner from deciding (403, decision not applied)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', workspaceId: 'w-1' }, role: 'admin' } as never)

    const res = await request(makeApp({ userId: 'u-admin' }))
      .post('/api/assistants/a-1/playbook/r-1/decision')
      .send({ decision: 'approve' })

    expect(res.status).toBe(403)
    expect(mockDecide).not.toHaveBeenCalled()
  })

  it('lets the owner approve a suggestion', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', workspaceId: 'w-1' }, role: 'owner' } as never)
    mockDecide.mockResolvedValueOnce({ ...RULE, status: 'active', decidedByUserId: 'u-owner' })

    const res = await request(makeApp({ userId: 'u-owner' }))
      .post('/api/assistants/a-1/playbook/r-1/decision')
      .send({ decision: 'approve' })

    expect(res.status).toBe(200)
    expect(res.body.rule.status).toBe('active')
    expect(mockDecide).toHaveBeenCalledWith({
      assistantId: 'a-1', ruleId: 'r-1', decision: 'approve', userId: 'u-owner',
    })
  })

  it('surfaces the active-rule cap as a 409 with a real reason', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', workspaceId: 'w-1' }, role: 'owner' } as never)
    mockDecide.mockResolvedValueOnce('cap')

    const res = await request(makeApp({ userId: 'u-owner' }))
      .post('/api/assistants/a-1/playbook/r-1/decision')
      .send({ decision: 'approve' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('active_rule_cap')
  })

  it('404s a rule that is missing or not in a decidable state', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', workspaceId: 'w-1' }, role: 'owner' } as never)
    mockDecide.mockResolvedValueOnce(null)

    const res = await request(makeApp({ userId: 'u-owner' }))
      .post('/api/assistants/a-1/playbook/r-1/decision')
      .send({ decision: 'retire' })

    expect(res.status).toBe(404)
  })

  it('rejects an unknown decision verb (400, no store call)', async () => {
    mockAccess.mockResolvedValueOnce({ assistant: { id: 'a-1', workspaceId: 'w-1' }, role: 'owner' } as never)

    const res = await request(makeApp({ userId: 'u-owner' }))
      .post('/api/assistants/a-1/playbook/r-1/decision')
      .send({ decision: 'promote' })

    expect(res.status).toBe(400)
    expect(mockDecide).not.toHaveBeenCalled()
  })
})
