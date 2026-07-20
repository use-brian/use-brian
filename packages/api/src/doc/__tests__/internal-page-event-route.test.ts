/**
 * Internal content-edit page-event endpoint tests — `POST /internal/page-event`.
 *
 * The content-edit half of the `page` workflow-event source: doc-sync signals a
 * block-content settle here, and the route resolves the page context and hands a
 * `PageLifecycleEvent` to the `publishPageLifecycle` seam. Verifies the shared
 * secret gate, the `updated` default + action validation, the system-side
 * context resolution, the `isSystem` pass-through (self-loop guard), and the
 * dead-page ack.
 *
 * [COMP:api/internal-page-event-route]
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import type { PageLifecycleEvent, SavedViewStore } from '@use-brian/core'
import { createTestApp } from '../../routes/__tests__/helpers.js'
import { internalPageEventRoutes } from '../internal-page-event-route.js'

const SECRET = 'shhh'
const PAGE = 'a3b1c2d4-0000-4000-8000-000000000001'
const WS = 'e1799b0e-9f64-46d5-8ed8-132a2194943d'
const PARENT = 'b7c8d9e0-0000-4000-8000-000000000002'

function makeApp(overrides?: {
  ctx?: Awaited<ReturnType<SavedViewStore['getPageEventContextSystem']>>
  publish?: (e: PageLifecycleEvent) => void
}) {
  const getPageEventContextSystem = vi.fn().mockResolvedValue(
    overrides?.ctx === undefined
      ? { workspaceId: WS, parentId: PARENT, title: 'Roadmap' }
      : overrides.ctx,
  )
  const savedViewStore = { getPageEventContextSystem } as unknown as SavedViewStore
  const publish = overrides?.publish ?? vi.fn()
  const app = createTestApp(
    '/',
    internalPageEventRoutes({ savedViewStore, publish, sharedSecret: SECRET }),
  )
  return { app, publish, getPageEventContextSystem }
}

describe('[COMP:api/internal-page-event-route] POST /internal/page-event', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dispatches an `updated` PageLifecycleEvent resolved from the store', async () => {
    const publish = vi.fn()
    const { app } = makeApp({ publish })
    const res = await request(app)
      .post('/internal/page-event')
      .set('x-doc-sync-secret', SECRET)
      .send({ pageId: PAGE })

    expect(res.status).toBe(202)
    expect(res.body).toEqual({ dispatched: true })
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({
      workspaceId: WS,
      pageId: PAGE,
      parentId: PARENT,
      title: 'Roadmap',
      actorId: null,
      action: 'updated',
      isSystem: false,
    })
  })

  it('passes isSystem through for the self-loop guard', async () => {
    const publish = vi.fn()
    const { app } = makeApp({ publish })
    await request(app)
      .post('/internal/page-event')
      .set('x-doc-sync-secret', SECRET)
      .send({ pageId: PAGE, isSystem: true })

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ isSystem: true }),
    )
  })

  it('rejects a wrong / missing secret with 403 and never publishes', async () => {
    const publish = vi.fn()
    const { app } = makeApp({ publish })
    const bad = await request(app)
      .post('/internal/page-event')
      .set('x-doc-sync-secret', 'nope')
      .send({ pageId: PAGE })
    const none = await request(app).post('/internal/page-event').send({ pageId: PAGE })

    expect(bad.status).toBe(403)
    expect(none.status).toBe(403)
    expect(publish).not.toHaveBeenCalled()
  })

  it('400s when pageId is missing', async () => {
    const publish = vi.fn()
    const { app } = makeApp({ publish })
    const res = await request(app)
      .post('/internal/page-event')
      .set('x-doc-sync-secret', SECRET)
      .send({})
    expect(res.status).toBe(400)
    expect(publish).not.toHaveBeenCalled()
  })

  it('400s on an unknown action rather than coercing it', async () => {
    const publish = vi.fn()
    const { app } = makeApp({ publish })
    const res = await request(app)
      .post('/internal/page-event')
      .set('x-doc-sync-secret', SECRET)
      .send({ pageId: PAGE, action: 'deleted' })
    expect(res.status).toBe(400)
    expect(publish).not.toHaveBeenCalled()
  })

  it('acks a dead page (context gone) without publishing', async () => {
    const publish = vi.fn()
    const { app } = makeApp({ ctx: null, publish })
    const res = await request(app)
      .post('/internal/page-event')
      .set('x-doc-sync-secret', SECRET)
      .send({ pageId: PAGE })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ skipped: 'not_found' })
    expect(publish).not.toHaveBeenCalled()
  })
})
