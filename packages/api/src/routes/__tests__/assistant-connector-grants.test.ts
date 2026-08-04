import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/users.js', () => ({
  resolveAssistantAccess: vi.fn(),
}))

import { resolveAssistantAccess } from '../../db/users.js'
import { assistantConnectorGrantsRoutes } from '../assistant-connector-grants.js'

const mockAccess = vi.mocked(resolveAssistantAccess)
const store = {
  getForAssistantSystem: vi.fn(),
  listForAssistant: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
}

function makeApp(userId: string | null = 'u-1') {
  const app = express()
  app.use(express.json())
  if (userId) {
    app.use((req, _res, next) => {
      ;(req as unknown as { userId: string }).userId = userId
      next()
    })
  }
  app.use('/api/assistant-connector-grants', assistantConnectorGrantsRoutes({ store: store as never }))
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAccess.mockResolvedValue({ assistant: { id: 'a-1' }, role: 'owner' } as never)
  store.listForAssistant.mockResolvedValue([])
  store.upsert.mockImplementation(async (_userId, input) => ({ id: 'g-1', ...input }))
  store.delete.mockResolvedValue(true)
})

describe('[COMP:api/assistant-connector-grants-route] shared OSS + hosted grant route', () => {
  it('rejects unauthenticated and non-member requests', async () => {
    const unauthenticated = await request(makeApp(null)).get('/api/assistant-connector-grants/a-1')
    expect(unauthenticated.status).toBe(401)

    mockAccess.mockResolvedValueOnce(null)
    const forbidden = await request(makeApp()).get('/api/assistant-connector-grants/a-1')
    expect(forbidden.status).toBe(403)
  })

  it('lists grants for an accessible assistant', async () => {
    store.listForAssistant.mockResolvedValueOnce([{ connectorId: 'imap', allowedActions: ['imapSendMessage'] }])
    const response = await request(makeApp()).get('/api/assistant-connector-grants/a-1')

    expect(response.status).toBe(200)
    expect(store.listForAssistant).toHaveBeenCalledWith('u-1', 'a-1')
    expect(response.body.grants).toEqual([{ connectorId: 'imap', allowedActions: ['imapSendMessage'] }])
  })

  it('persists the write-tool grant that the app-web toggle sends', async () => {
    const response = await request(makeApp())
      .patch('/api/assistant-connector-grants/a-1/imap')
      .send({ readAllowed: true, allowedActions: ['imapSendMessage'] })

    expect(response.status).toBe(200)
    expect(store.upsert).toHaveBeenCalledWith('u-1', {
      assistantId: 'a-1',
      connectorId: 'imap',
      readAllowed: true,
      allowedActions: ['imapSendMessage'],
    })
  })

  it('validates the allowedActions payload and supports deletion', async () => {
    const invalid = await request(makeApp())
      .patch('/api/assistant-connector-grants/a-1/imap')
      .send({ allowedActions: 'imapSendMessage' })
    expect(invalid.status).toBe(400)
    expect(store.upsert).not.toHaveBeenCalled()

    const removed = await request(makeApp()).delete('/api/assistant-connector-grants/a-1/imap')
    expect(removed.status).toBe(200)
    expect(store.delete).toHaveBeenCalledWith('u-1', 'a-1', 'imap')
  })

  it('is mounted by the shared boot composition used by OSS and hosted', () => {
    const bootSource = readFileSync(new URL('../../boot.ts', import.meta.url), 'utf8')
    expect(bootSource).toContain("'/api/assistant-connector-grants',")
    expect(bootSource).toContain('assistantConnectorGrantsRoutes({ store: assistantConnectorGrantsStore })')
  })
})
