import express from 'express'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FilesApi } from '@sidanclaw/core'
import type { DeckStore } from '../../db/deck-store.js'

// Membership is the visibility boundary — mock the workspace-store lookups
// the router uses so no DB is needed. user-member belongs to ws-1 only.
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceMembershipWithClearanceSystem: vi.fn(async (userId: string, workspaceId: string) =>
    userId === 'user-member' && workspaceId === 'ws-1' ? { role: 'member', clearance: 'internal' } : null,
  ),
  effectiveReadClearance: vi.fn(() => 'internal'),
}))

const { decksRoutes } = await import('../decks.js')

const DECK = {
  id: 'deck-1',
  workspaceId: 'ws-1',
  title: 'Board: Q3 Update',
  spec: { title: 'Board: Q3 Update', slides: [{ title: 'S', bullets: ['b'] }] },
  style: null,
  styleSource: null,
  filePath: 'decks/deck-1.pptx',
  version: 2,
  updatedAt: '2026-07-14T00:00:00.000Z',
}

const deckStore = {
  listSystem: vi.fn(async (workspaceId: string) => (workspaceId === 'ws-1' ? [{ id: 'deck-1' }] : [])),
  getSystem: vi.fn(async (id: string) => (id === 'deck-1' ? DECK : null)),
} as unknown as DeckStore

const filesApi = {
  readBytes: vi.fn(async (_ctx: unknown, path: string) =>
    path === 'decks/deck-1.pptx'
      ? { ok: true, value: { file: { path }, bytes: Buffer.from('PKfake') } }
      : { ok: false, error: { kind: 'not_found', reference: path } },
  ),
} as unknown as FilesApi

let server: Server
let baseUrl: string

beforeAll(async () => {
  const app = express()
  // requireAuth stand-in: the X-Test-User header becomes req.userId.
  app.use((req, _res, next) => {
    const user = req.headers['x-test-user']
    if (typeof user === 'string' && user) (req as { userId?: string }).userId = user
    next()
  })
  app.use('/api', decksRoutes({ deckStore, filesApi }))
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('no address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(() => {
  server?.close()
})

function get(path: string, user?: string) {
  return fetch(`${baseUrl}${path}`, { headers: user ? { 'x-test-user': user } : {} })
}

describe('[COMP:api/decks-route] Deck routes', () => {
  it('rejects unauthenticated requests', async () => {
    expect((await get('/api/decks?workspaceId=ws-1')).status).toBe(401)
    expect((await get('/api/decks/deck-1')).status).toBe(401)
    expect((await get('/api/decks/deck-1/export')).status).toBe(401)
  })

  it('lists decks for a member, 403s a non-member', async () => {
    const ok = await get('/api/decks?workspaceId=ws-1', 'user-member')
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { decks: unknown[] }).decks).toHaveLength(1)
    expect((await get('/api/decks?workspaceId=ws-1', 'user-outsider')).status).toBe(403)
  })

  it('serves deck detail to members; non-members get the same 404 as a missing id', async () => {
    const ok = await get('/api/decks/deck-1', 'user-member')
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { deck: { version: number } }).deck.version).toBe(2)
    expect((await get('/api/decks/deck-1', 'user-outsider')).status).toBe(404)
    expect((await get('/api/decks/nope', 'user-member')).status).toBe(404)
  })

  it('exports the built .pptx with attachment headers', async () => {
    const res = await get('/api/decks/deck-1/export', 'user-member')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('presentationml.presentation')
    expect(res.headers.get('content-disposition')).toContain('Board- Q3 Update.pptx')
    expect(await res.text()).toBe('PKfake')
  })

  it('404s the export when the deck file is missing (regenerate hint)', async () => {
    deckStore.getSystem = vi.fn(async () => ({ ...DECK, filePath: 'decks/gone.pptx' })) as DeckStore['getSystem']
    const res = await get('/api/decks/deck-1/export', 'user-member')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toMatch(/regenerate/i)
  })
})
