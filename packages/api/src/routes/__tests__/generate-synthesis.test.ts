import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

const getWorkspacePlan = vi.fn(async () => 'pro')
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspacePlan: () => getWorkspacePlan(),
}))

import { generateSynthesisRoutes } from '../generate-synthesis.js'

const getRole = vi.fn(async () => 'owner' as string | null)
const generateSynthesize = vi.fn(async (): Promise<{ pageId: string | null } | null> => ({ pageId: 'page-1' }))
const resolvePrimaryAssistantForWorkspace = vi.fn(async () => 'assistant-1' as string | null)
const getById = vi.fn()
const checkCreditBudget = vi.fn(async (): Promise<{
  status: 'ok' | 'downgraded' | 'blocked'
  creditsUsed: number
  creditCap: number | null
  resetsAt: string | null
}> => ({
  status: 'ok',
  creditsUsed: 0,
  creditCap: 1000,
  resetsAt: null,
}))
const quoteCredits = vi.fn((sectionCount: number) => Math.max(1, Math.ceil(sectionCount / 3)))
const charge = vi.fn(async () => ({ charged: true }))

const BLUEPRINT_4 = {
  id: 'bp-1',
  workspaceId: 'ws-1',
  name: 'Discovery Brief',
  extraction: { fields: [{}, {}, {}, {}] },
}

beforeEach(() => {
  vi.resetAllMocks()
  getWorkspacePlan.mockResolvedValue('pro')
  getRole.mockResolvedValue('owner')
  generateSynthesize.mockResolvedValue({ pageId: 'page-1' })
  resolvePrimaryAssistantForWorkspace.mockResolvedValue('assistant-1')
  getById.mockResolvedValue(BLUEPRINT_4)
  checkCreditBudget.mockResolvedValue({ status: 'ok', creditsUsed: 0, creditCap: 1000, resetsAt: null })
  quoteCredits.mockImplementation((sectionCount) => Math.max(1, Math.ceil(sectionCount / 3)))
  charge.mockResolvedValue({ charged: true })
})

function makeApp(options: {
  userId?: string | null
  withGenerate?: boolean
  withBilling?: boolean
} = {}) {
  const app = express()
  app.use(express.json())
  const userId = options.userId === undefined ? 'user-1' : options.userId
  app.use((req, _res, next) => {
    if (userId) req.userId = userId
    next()
  })
  app.use('/api/workspaces/:workspaceId/blueprints', generateSynthesisRoutes({
    getRole,
    generateSynthesize: options.withGenerate === false ? undefined : generateSynthesize as never,
    resolvePrimaryAssistantForWorkspace,
    pageTemplateStore: { getById: (...args: unknown[]) => getById(...args) } as never,
    checkCreditBudget: options.withBilling === false ? undefined : checkCreditBudget,
    billing: options.withBilling === false ? undefined : { quoteCredits, charge },
  }))
  return app
}

describe('[COMP:api/generate-route] generate-from-brain route', () => {
  it('quotes hosted credits from the blueprint field count', async () => {
    const response = await request(makeApp()).post('/api/workspaces/ws-1/blueprints/bp-1/estimate')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      blueprintId: 'bp-1',
      name: 'Discovery Brief',
      sectionCount: 4,
      surchargeCredits: 2,
    })
    expect(quoteCredits).toHaveBeenCalledWith(4)
  })

  it('quotes zero credits and runs unmetered in OSS', async () => {
    const app = makeApp({ withBilling: false })
    const estimate = await request(app).post('/api/workspaces/ws-1/blueprints/bp-1/estimate')
    const generated = await request(app)
      .post('/api/workspaces/ws-1/blueprints/bp-1/generate')
      .send({ subject: 'HKTV Mall', requestId: 'req-1' })

    expect(estimate.body.surchargeCredits).toBe(0)
    expect(generated.status).toBe(200)
    expect(generated.body).toEqual({ pageId: 'page-1', chargedCredits: 0 })
    expect(getWorkspacePlan).not.toHaveBeenCalled()
    expect(checkCreditBudget).not.toHaveBeenCalled()
    expect(charge).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated, non-member, wrong-workspace, and non-blueprint estimates', async () => {
    expect((await request(makeApp({ userId: null })).post('/api/workspaces/ws-1/blueprints/bp-1/estimate')).status).toBe(401)

    getRole.mockResolvedValue(null)
    expect((await request(makeApp()).post('/api/workspaces/ws-1/blueprints/bp-1/estimate')).status).toBe(403)
    getRole.mockResolvedValue('owner')

    getById.mockResolvedValue({ ...BLUEPRINT_4, workspaceId: 'other-ws' })
    expect((await request(makeApp()).post('/api/workspaces/ws-1/blueprints/bp-1/estimate')).status).toBe(404)

    getById.mockResolvedValue({ ...BLUEPRINT_4, extraction: null })
    const response = await request(makeApp()).post('/api/workspaces/ws-1/blueprints/bp-1/estimate')
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('not_a_blueprint')
  })

  it('runs the fill and invokes the hosted success charge', async () => {
    const response = await request(makeApp())
      .post('/api/workspaces/ws-1/blueprints/bp-1/generate')
      .send({ subject: ' HKTV Mall ', requestId: ' req-1 ', sensitivity: 'private' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ pageId: 'page-1', chargedCredits: 2 })
    expect(generateSynthesize).toHaveBeenCalledWith({
      blueprintSlug: 'bp-1',
      subject: 'HKTV Mall',
      workspaceId: 'ws-1',
      userId: 'user-1',
      assistantId: 'assistant-1',
      sensitivity: 'private',
    })
    expect(charge).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      requestId: 'req-1',
      credits: 2,
      blueprintId: 'bp-1',
      pageId: 'page-1',
      chargedByUserId: 'user-1',
    }))
  })

  it('validates the generate input', async () => {
    expect((await request(makeApp()).post('/api/workspaces/ws-1/blueprints/bp-1/generate').send({ requestId: 'r' })).status).toBe(400)
    expect((await request(makeApp()).post('/api/workspaces/ws-1/blueprints/bp-1/generate').send({ subject: 'x' })).status).toBe(400)
  })

  it('blocks hosted generation before synthesis when credits are exhausted', async () => {
    checkCreditBudget.mockResolvedValue({ status: 'blocked', creditsUsed: 200, creditCap: 125, resetsAt: null })
    const response = await request(makeApp())
      .post('/api/workspaces/ws-1/blueprints/bp-1/generate')
      .send({ subject: 'x', requestId: 'r' })

    expect(response.status).toBe(402)
    expect(response.body.error).toBe('credit_limit')
    expect(generateSynthesize).not.toHaveBeenCalled()
    expect(charge).not.toHaveBeenCalled()
  })

  it('returns 409 when the workspace has no primary assistant', async () => {
    resolvePrimaryAssistantForWorkspace.mockResolvedValue(null)
    const response = await request(makeApp())
      .post('/api/workspaces/ws-1/blueprints/bp-1/generate')
      .send({ subject: 'x', requestId: 'r' })

    expect(response.status).toBe(409)
    expect(generateSynthesize).not.toHaveBeenCalled()
  })

  it('returns 422 without a synthesis result and does not charge', async () => {
    generateSynthesize.mockResolvedValue(null)
    const response = await request(makeApp())
      .post('/api/workspaces/ws-1/blueprints/bp-1/generate')
      .send({ subject: 'x', requestId: 'r' })

    expect(response.status).toBe(422)
    expect(charge).not.toHaveBeenCalled()
  })

  it('returns 503 when no model key is configured', async () => {
    const response = await request(makeApp({ withGenerate: false }))
      .post('/api/workspaces/ws-1/blueprints/bp-1/generate')
      .send({ subject: 'x', requestId: 'r' })

    expect(response.status).toBe(503)
  })

  it('keeps a generated page when the hosted charge fails', async () => {
    charge.mockRejectedValue(new Error('ledger unavailable'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await request(makeApp())
      .post('/api/workspaces/ws-1/blueprints/bp-1/generate')
      .send({ subject: 'x', requestId: 'r' })

    expect(response.status).toBe(200)
    expect(response.body.pageId).toBe('page-1')
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
