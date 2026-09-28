import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessContext } from '@use-brian/core'
import {
  IngestApplicationServiceError,
  type IngestApplicationService,
} from '../../ingest/application-service.js'
import { createIngestApplicationRecoveryRoutes } from '../ingest-application.js'

const USER = '00000000-0000-4000-8000-000000000001'
const WORKSPACE = '00000000-0000-4000-8000-000000000002'
const ASSISTANT = '00000000-0000-4000-8000-000000000003'
const EPISODE = '00000000-0000-4000-8000-000000000004'
const RUN = '00000000-0000-4000-8000-000000000005'
const HASH = 'a'.repeat(64)

function access(): AccessContext {
  return {
    workspaceId: WORKSPACE,
    userId: USER,
    assistantId: ASSISTANT,
    assistantKind: 'primary',
    clearance: 'confidential',
    compartments: null,
    mutationCompartments: null,
    projectIds: null,
  }
}

function setup() {
  const projection = {
    status: 'tracked' as const,
    runId: RUN,
    episodeId: EPISODE,
    planHash: HASH,
    extractionState: 'succeeded' as const,
    applicationState: 'partial' as const,
    errorCode: 'write_failed',
    counts: { pending: 0, committed: 2, alreadyApplied: 0, held: 0, rejected: 0, failed: 1 },
    resumable: true,
    items: [{
      candidateId: '0002:memory:fixture', primitiveKind: 'memory' as const,
      disposition: 'failed' as const, attemptCount: 1, failureCode: 'write_failed', retryable: true,
    }],
  }
  const service = {
    get: vi.fn().mockResolvedValue(projection),
    list: vi.fn().mockResolvedValue({ items: [projection], nextCursor: null }),
    retry: vi.fn().mockResolvedValue({ ...projection, applicationState: 'complete', counts: {
      ...projection.counts, committed: 3, failed: 0,
    } }),
  }
  const resolveAccess = vi.fn().mockResolvedValue(access())
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.userId = USER; next() })
  app.use('/api/ingest', createIngestApplicationRecoveryRoutes({
    application: service as unknown as IngestApplicationService,
    resolveAccess,
  }))
  return { app, service, resolveAccess, projection }
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:api/ingest-application] authenticated application recovery', () => {
  it('round-trips persisted counts and safe errors through list and detail reloads', async () => {
    const { app, service, projection } = setup()
    const list = await request(app).get(`/api/ingest/applications?workspaceId=${WORKSPACE}`)
    const detail = await request(app).get(`/api/ingest/episodes/${EPISODE}/application`)
    expect(list.status).toBe(200)
    expect(list.body.items[0]).toEqual(projection)
    expect(detail.status).toBe(200)
    expect(detail.body).toEqual(projection)
    expect(service.list).toHaveBeenCalledWith(access(), { cursor: undefined })
    expect(service.get).toHaveBeenCalledWith(access(), EPISODE)
  })

  it('uses the shared service for retry and passes the exact frozen hash without extraction input', async () => {
    const { app, service } = setup()
    const response = await request(app)
      .post(`/api/ingest/episodes/${EPISODE}/retry-application`)
      .send({ runId: RUN, expectedPlanHash: HASH })
    expect(response.status).toBe(200)
    expect(service.retry).toHaveBeenCalledWith({
      ctx: access(), episodeId: EPISODE, runId: RUN, expectedPlanHash: HASH,
    })
    expect(service.retry.mock.calls[0]?.[0]).not.toHaveProperty('content')
    expect(service.retry.mock.calls[0]?.[0]).not.toHaveProperty('extract')
  })

  it.each([
    ['conflict', 409],
    ['forbidden', 403],
  ] as const)('maps %s recovery failures to %i', async (code, status) => {
    const { app, service } = setup()
    service.retry.mockRejectedValue(new IngestApplicationServiceError(code, code))
    const response = await request(app)
      .post(`/api/ingest/episodes/${EPISODE}/retry-application`)
      .send({ runId: RUN, expectedPlanHash: HASH })
    expect(response.status).toBe(status)
    expect(response.body.error).toBe(code)
  })
})
