/**
 * Unit tests for the snapshot management routes.
 * Component tag: [COMP:api/snapshots-route].
 *
 * Mocks `requireAssistantMember` (membership passes by default) and
 * mounts snapshotRoutes() with an injected mock store. Verifies the
 * auth gate, the category allow-list (400), the 501 when no generator
 * is configured, the generate-draft 201 + missing-content 400, the
 * draft listing, and the publish / get-published 404-on-null paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../route-helpers.js', () => ({
  requireAssistantMember: vi.fn().mockResolvedValue(true),
}))

import { snapshotRoutes, type SnapshotGenerator } from '../snapshots.js'
import { requireAssistantMember } from '../route-helpers.js'

const mockMember = vi.mocked(requireAssistantMember)

const snapshotStore = {
  generateDraft: vi.fn(),
  listDrafts: vi.fn(),
  publish: vi.fn(),
  getPublishedForOwner: vi.fn(),
}

function app(generateSnapshot?: SnapshotGenerator) {
  return createTestApp(
    '/api/snapshots',
    snapshotRoutes({ snapshotStore: snapshotStore as never, generateSnapshot }),
    { userId: 'u-1' },
  )
}

function noAuthApp() {
  return createTestApp('/api/snapshots', snapshotRoutes({ snapshotStore: snapshotStore as never }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockMember.mockResolvedValue(true)
})

describe('[COMP:api/snapshots-route] POST /auto-generate/:assistantId/:category', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(noAuthApp()).post('/api/snapshots/auto-generate/a-1/tasks')
    expect(res.status).toBe(401)
  })

  it('rejects an unknown category with 400', async () => {
    const res = await request(app()).post('/api/snapshots/auto-generate/a-1/bogus')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Invalid category')
  })

  it('returns 501 when no snapshot generator is configured', async () => {
    const res = await request(app()).post('/api/snapshots/auto-generate/a-1/tasks')
    expect(res.status).toBe(501)
  })

  it('returns the generated summary when a generator is configured', async () => {
    const generate = vi.fn().mockResolvedValue('3 tasks due this week')
    const res = await request(app(generate)).post('/api/snapshots/auto-generate/a-1/tasks')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, summary: '3 tasks due this week' })
    expect(generate).toHaveBeenCalledWith('a-1', 'u-1', 'tasks')
  })
})

describe('[COMP:api/snapshots-route] POST /generate/:assistantId/:category', () => {
  it('rejects a request with no content object', async () => {
    const res = await request(app()).post('/api/snapshots/generate/a-1/knowledge').send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('content')
  })

  it('creates a draft (201) from the supplied content', async () => {
    snapshotStore.generateDraft.mockResolvedValueOnce({ id: 'snap-1', status: 'draft' })
    const res = await request(app())
      .post('/api/snapshots/generate/a-1/knowledge')
      .send({ content: { items: [] } })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: 'snap-1', status: 'draft' })
    expect(snapshotStore.generateDraft).toHaveBeenCalledWith('a-1', 'knowledge', { items: [] })
  })
})

describe('[COMP:api/snapshots-route] drafts / publish / get', () => {
  it('GET /drafts returns the draft list', async () => {
    snapshotStore.listDrafts.mockResolvedValueOnce([{ id: 'snap-1' }])
    const res = await request(app()).get('/api/snapshots/drafts/a-1')
    expect(res.body).toEqual({ drafts: [{ id: 'snap-1' }] })
  })

  it('POST /:snapshotId/publish returns 404 when the snapshot does not exist', async () => {
    snapshotStore.publish.mockResolvedValueOnce(null)
    const res = await request(app()).post('/api/snapshots/snap-x/publish').send({})
    expect(res.status).toBe(404)
  })

  it('POST /:snapshotId/publish returns the published snapshot on success', async () => {
    snapshotStore.publish.mockResolvedValueOnce({ id: 'snap-1', status: 'published' })
    const res = await request(app()).post('/api/snapshots/snap-1/publish').send({ edits: { a: 1 } })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('published')
    expect(snapshotStore.publish).toHaveBeenCalledWith('u-1', 'snap-1', { a: 1 })
  })

  it('GET /:assistantId/:category returns 404 when nothing is published', async () => {
    snapshotStore.getPublishedForOwner.mockResolvedValueOnce(null)
    const res = await request(app()).get('/api/snapshots/a-1/memories')
    expect(res.status).toBe(404)
  })
})
