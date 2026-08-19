/**
 * [COMP:doc/public-share-route] — guest comment routes, mounted per public
 * address family through ONE factory (`mountGuestCommentRoutes`).
 *
 * What matters here is the gate: every handler re-resolves the target on
 * each request and 404s unless the resolved role allows commenting. A page
 * published at `view` (the default) must never accept a guest thread; a page
 * whose owner flipped "Allow comments" (`comment`) must; and the same
 * handlers must behave identically under the `/public/pages/:token`,
 * `/public/published/:pageId` and `/public/sites/:host` bases — that is the
 * whole reason they are shared. Fixture data is invented.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Router } from 'express'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
  getAppPool: vi.fn(),
  rollbackAndRelease: vi.fn(),
}))

const createGuestThread = vi.fn()
const addGuestComment = vi.fn()
const listGuestComments = vi.fn()
vi.mock('../../db/guest-comment-store.js', () => ({
  createGuestThread: (...a: unknown[]) => createGuestThread(...a),
  addGuestComment: (...a: unknown[]) => addGuestComment(...a),
  listGuestComments: (...a: unknown[]) => listGuestComments(...a),
}))

import { mountGuestCommentRoutes, roleAllowsComment, type GuestCommentTarget } from '../_public-guest-comments.js'

const PAGE = '00000000-0000-0000-0000-0000000000a1'
const WORKSPACE = '00000000-0000-0000-0000-0000000000b1'

function target(role: string): GuestCommentTarget {
  return { pageId: PAGE, workspaceId: WORKSPACE, role }
}

function appFor(base: string, resolve: () => Promise<GuestCommentTarget | null>) {
  const router = Router()
  mountGuestCommentRoutes(router, base, resolve)
  return createTestApp('/api', router)
}

beforeEach(() => {
  createGuestThread.mockReset().mockResolvedValue({ threadId: 'thread-1' })
  addGuestComment.mockReset().mockResolvedValue(true)
  listGuestComments.mockReset().mockResolvedValue([])
})

describe('[COMP:doc/public-share-route] Guest comment routes (shared mount)', () => {
  it('roleAllowsComment: view is read-only; comment/edit/full may comment', () => {
    expect(roleAllowsComment('view')).toBe(false)
    expect(roleAllowsComment('comment')).toBe(true)
    expect(roleAllowsComment('edit')).toBe(true)
    expect(roleAllowsComment('full')).toBe(true)
  })

  it('a page published at view (the default) refuses guest threads with 404', async () => {
    const app = appFor('/public/published/:pageId', async () => target('view'))
    const res = await request(app)
      .post(`/api/public/published/${PAGE}/comment-threads`)
      .send({ guestName: 'Ada', body: 'Nice page' })
    expect(res.status).toBe(404)
    expect(createGuestThread).not.toHaveBeenCalled()
  })

  it('an unresolvable target (unpublished / revoked / switch off) is 404 on every handler', async () => {
    const app = appFor('/public/published/:pageId', async () => null)
    expect((await request(app).post(`/api/public/published/${PAGE}/comment-threads`).send({ body: 'x' })).status).toBe(404)
    expect(
      (await request(app).post(`/api/public/published/${PAGE}/comment-threads/t1/messages`).send({ body: 'x', guestSessionToken: 'g' })).status,
    ).toBe(404)
    expect((await request(app).get(`/api/public/published/${PAGE}/comments?guestSessionToken=g`)).status).toBe(404)
  })

  it('"Allow comments" (role=comment) on the published URL opens a guest thread and mints a token', async () => {
    const app = appFor('/public/published/:pageId', async () => target('comment'))
    const res = await request(app)
      .post(`/api/public/published/${PAGE}/comment-threads`)
      .send({ guestName: '  Ada  ', body: '  Nice page  ' })
    expect(res.status).toBe(201)
    expect(res.body.threadId).toBe('thread-1')
    expect(typeof res.body.guestSessionToken).toBe('string')
    expect(res.body.guestSessionToken.length).toBeGreaterThan(10)
    expect(createGuestThread).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: PAGE,
        workspaceId: WORKSPACE,
        guestName: 'Ada',
        body: 'Nice page',
        guestSessionToken: res.body.guestSessionToken,
      }),
    )
  })

  it('a range comment persists anchorBlockId + quote (trimmed, bounded); a quote with no block is dropped', async () => {
    const app = appFor('/public/published/:pageId', async () => target('comment'))
    const res = await request(app)
      .post(`/api/public/published/${PAGE}/comment-threads`)
      .send({ guestName: 'Ada', body: 'why?', anchorBlockId: ' blk-7 ', quote: '  the second claim ' })
    expect(res.status).toBe(201)
    expect(createGuestThread).toHaveBeenCalledWith(
      expect.objectContaining({ anchorBlockId: 'blk-7', quote: 'the second claim' }),
    )
    // Page-level comment: no anchor, and an orphan quote does not sneak through.
    createGuestThread.mockClear()
    await request(app).post(`/api/public/published/${PAGE}/comment-threads`).send({ body: 'hi', quote: 'loose' })
    expect(createGuestThread).toHaveBeenCalledWith(expect.objectContaining({ anchorBlockId: null, quote: null }))
  })

  it('reuses a presented guest token instead of minting a new one', async () => {
    const app = appFor('/public/published/:pageId', async () => target('comment'))
    const res = await request(app)
      .post(`/api/public/published/${PAGE}/comment-threads`)
      .send({ guestName: 'Ada', body: 'Second thread', guestSessionToken: 'guest-token-1' })
    expect(res.status).toBe(201)
    expect(res.body.guestSessionToken).toBe('guest-token-1')
  })

  it('an empty body is 400, and a missing name falls back to "Guest"', async () => {
    const app = appFor('/public/published/:pageId', async () => target('comment'))
    expect((await request(app).post(`/api/public/published/${PAGE}/comment-threads`).send({ body: '   ' })).status).toBe(400)
    const ok = await request(app).post(`/api/public/published/${PAGE}/comment-threads`).send({ body: 'hi' })
    expect(ok.status).toBe(201)
    expect(createGuestThread).toHaveBeenCalledWith(expect.objectContaining({ guestName: 'Guest' }))
  })

  it('replies need the guest token and are refused (403) when the store says the thread is not theirs', async () => {
    const app = appFor('/public/published/:pageId', async () => target('comment'))
    expect(
      (await request(app).post(`/api/public/published/${PAGE}/comment-threads/t1/messages`).send({ body: 'x' })).status,
    ).toBe(400)
    addGuestComment.mockResolvedValueOnce(false)
    const denied = await request(app)
      .post(`/api/public/published/${PAGE}/comment-threads/t1/messages`)
      .send({ body: 'x', guestSessionToken: 'someone-else' })
    expect(denied.status).toBe(403)
    const ok = await request(app)
      .post(`/api/public/published/${PAGE}/comment-threads/t1/messages`)
      .send({ body: 'follow-up', guestSessionToken: 'guest-token-1' })
    expect(ok.status).toBe(201)
    expect(addGuestComment).toHaveBeenLastCalledWith({
      threadId: 't1',
      pageId: PAGE,
      guestSessionToken: 'guest-token-1',
      body: 'follow-up',
    })
  })

  it('listing without a guest token is an empty list; with one it is token-scoped', async () => {
    const app = appFor('/public/published/:pageId', async () => target('comment'))
    const none = await request(app).get(`/api/public/published/${PAGE}/comments`)
    expect(none.status).toBe(200)
    expect(none.body).toEqual({ threads: [] })
    expect(listGuestComments).not.toHaveBeenCalled()
    listGuestComments.mockResolvedValueOnce([{ threadId: 't1', comments: [] }])
    const mine = await request(app).get(`/api/public/published/${PAGE}/comments?guestSessionToken=guest-token-1`)
    expect(mine.body.threads).toHaveLength(1)
    expect(listGuestComments).toHaveBeenCalledWith(PAGE, 'guest-token-1')
  })

  it('the same handlers serve the link and site families (resolver receives the request)', async () => {
    const seen: string[] = []
    const linkApp = appFor('/public/pages/:token', async () => {
      seen.push('link')
      return target('comment')
    })
    const siteApp = appFor('/public/sites/:host', async () => {
      seen.push('site')
      return target('comment')
    })
    expect(
      (await request(linkApp).post('/api/public/pages/tok-1/comment-threads?page=child').send({ body: 'a' })).status,
    ).toBe(201)
    expect(
      (await request(siteApp).post('/api/public/sites/docs.example/comment-threads').send({ body: 'b' })).status,
    ).toBe(201)
    expect(seen).toEqual(['link', 'site'])
  })
})
