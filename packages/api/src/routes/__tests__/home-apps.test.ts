/**
 * Bundle-serving route tests.
 * Component tag: [COMP:api/home-app-bundle-route].
 *
 * The first test is the important one. `homeAppRoutes()` registers its routes
 * eagerly, so a pattern Express cannot parse throws while the router is being
 * built — inside `bootOpenApi`, before the API ever listens. That is a
 * whole-service boot crash wearing the costume of a single broken route, and
 * nothing else in the suite constructs this router, which is how a bare `*`
 * wildcard (illegal under Express 5's path-to-regexp v8) reached a deploy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/home-apps-store.js', () => ({
  consumeHomeAppBudget: vi.fn(),
  createHomeApp: vi.fn(),
  deleteHomeApp: vi.fn(),
  getHomeApp: vi.fn(),
  recordHomeAppSyncError: vi.fn(),
  grantHomeApp: vi.fn(),
  setHomeAppStatus: vi.fn(),
  getHomeAppState: vi.fn(),
  isRenderableHomeApp: vi.fn(() => true),
  listHomeApps: vi.fn(),
  putHomeAppState: vi.fn(),
}))
vi.mock('../../db/workspace-store.js', () => ({
  getWorkspaceMembershipWithClearanceSystem: vi.fn(),
  getWorkspaceRoleSystem: vi.fn(),
}))
vi.mock('../../brain-stream/notify.js', () => ({ notifyWorkspaceChange: vi.fn() }))
vi.mock('../../home-apps/tools.js', () => ({ writeHomeAppBundle: vi.fn() }))

import { homeAppRoutes, deleteBundle } from '../home-apps.js'
import { listWorkspaceFilesUnderReservedPrefix } from '../../db/workspace-files.js'

vi.mock('../../db/workspace-files.js', () => ({
  listWorkspaceFilesUnderReservedPrefix: vi.fn(async () => []),
}))
import { getHomeApp } from '../../db/home-apps-store.js'
import { mintBundleToken } from '../../home-apps/tokens.js'

const mockGetHomeApp = vi.mocked(getHomeApp)

const SECRET = 'test-signing-secret'
const APP_ID = '11111111-1111-4111-8111-111111111111'

const APP_ROW = {
  id: APP_ID,
  workspaceId: '22222222-2222-4222-8222-222222222222',
  createdBy: '33333333-3333-4333-8333-333333333333',
  status: 'active',
  grantedScopes: { net: [] },
  manifest: { scopes: { net: [] } },
} as never

/** Records every path the route asks storage for, so traversal is observable. */
const readPaths: string[] = []

function makeApp() {
  const filesApi = {
    readBytes: vi.fn(async (_ctx: unknown, path: string) => {
      readPaths.push(path)
      return { ok: true as const, value: { bytes: Buffer.from('<!doctype html>') } }
    }),
    search: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
  }
  const app = express()
  app.use(
    '/api/home-apps',
    homeAppRoutes({
      requireAuth: ((_req, _res, next) => next()) as express.RequestHandler,
      filesApi: filesApi as never,
      signingSecret: SECRET,
      apiOrigin: 'https://api.example.com',
    }),
  )
  return { app, filesApi }
}

function bundleUrl(path: string): string {
  const token = mintBundleToken({ appId: APP_ID, secret: SECRET })
  return `/api/home-apps/${APP_ID}/bundle/${path}?t=${encodeURIComponent(token)}`
}

describe('[COMP:api/home-app-bundle-route] Home app bundle route', () => {
  beforeEach(() => {
    readPaths.length = 0
    mockGetHomeApp.mockResolvedValue(APP_ROW)
  })

  it('builds the router without throwing (boot-crash regression)', () => {
    expect(() => makeApp()).not.toThrow()
  })

  it('serves a bundle file for a valid token', async () => {
    const { app } = makeApp()
    const res = await request(app).get(bundleUrl('index.html'))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(readPaths).toEqual([`/apps/${APP_ID}/index.html`])
  })

  it('rejoins a nested sub-resource path across segments', async () => {
    const { app } = makeApp()
    const res = await request(app).get(bundleUrl('assets/js/app.js'))
    expect(res.status).toBe(200)
    expect(readPaths).toEqual([`/apps/${APP_ID}/assets/js/app.js`])
  })

  it('404s a percent-encoded traversal instead of reading another app', async () => {
    const { app } = makeApp()
    // Express decodes before the handler sees it, so this arrives as a single
    // segment containing `../../` — a plain join would escape the app prefix.
    const res = await request(app).get(bundleUrl('%2e%2e%2f%2e%2e%2fother/index.html'))
    expect(res.status).toBe(404)
    expect(readPaths).toEqual([])
  })

  it('401s without a token', async () => {
    const { app } = makeApp()
    const res = await request(app).get(`/api/home-apps/${APP_ID}/bundle/index.html`)
    expect(res.status).toBe(401)
    expect(readPaths).toEqual([])
  })
})

describe('[COMP:api/home-app-bundle-route] deleteBundle clears the previous version', () => {
  it('does NOT go through fileSearch, which cannot see /apps/ at all', async () => {
    // `searchWorkspaceFiles` hard-excludes `path NOT LIKE '/apps/%'` so bundle
    // source never reaches brain retrieval. Building the replace on top of it
    // meant the delete always found nothing and the next write hit `conflict`
    // — re-import and re-sync had never worked, only a first install.
    const filesApi = {
      search: vi.fn(async () => []),
      delete: vi.fn(async () => ({ ok: true as const })),
    }
    vi.mocked(listWorkspaceFilesUnderReservedPrefix).mockResolvedValue([
      { path: '/apps/app-1/index.html' },
      { path: '/apps/app-1/brian-app.json' },
    ])

    await deleteBundle(filesApi as never, 'ws-1', 'app-1', 'user-1')

    expect(filesApi.search).not.toHaveBeenCalled()
    expect(listWorkspaceFilesUnderReservedPrefix).toHaveBeenCalledWith('ws-1', '/apps/app-1/')
    expect(filesApi.delete.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      '/apps/app-1/index.html',
      '/apps/app-1/brian-app.json',
    ])
  })
})

describe('[COMP:api/home-app-bundle-route] DELETE cleans the bundle up with it', () => {
  it('passes the acting user through, so the files layer can actually run', async () => {
    // The cleanup is fire-and-forget behind `.catch`, and the route has already
    // answered `{ ok: true }` by then - so when it fails, nothing anywhere says
    // so. It failed for every delete: `deleteBundle` was called without
    // `actingUserId`, which becomes `userId: ''`, and the files layer binds
    // that into an RLS session variable where an empty string is not a uuid.
    // Every removed app left its whole bundle behind, invisibly.
    const { deleteHomeApp } = await import('../../db/home-apps-store.js')
    vi.mocked(deleteHomeApp).mockResolvedValue({
      ok: true,
      app: { id: 'app-1', workspaceId: 'ws-1' },
    } as never)
    vi.mocked(listWorkspaceFilesUnderReservedPrefix).mockResolvedValue([
      { path: '/apps/app-1/index.html' },
    ] as never)

    const deleted: unknown[][] = []
    const filesApi = {
      search: vi.fn(async () => []),
      delete: vi.fn(async (...args: unknown[]) => {
        deleted.push(args)
        return { ok: true as const }
      }),
    }

    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { (req as { userId?: string }).userId = 'user-9'; next() })
    app.use('/api/home-apps', homeAppRoutes({
      requireAuth: (_q: unknown, _s: unknown, n: () => void) => n(),
      filesApi,
      secret: 's',
    } as never))

    const res = await request(app).delete('/api/home-apps/app-1').send({ workspaceId: 'ws-1' })
    expect(res.status).toBe(200)

    // The cleanup is not awaited by the handler, so let its microtasks run
    // before asserting - otherwise this passes for the wrong reason.
    await new Promise((r) => setTimeout(r, 0))

    // The RLS context must carry a real user id, never ''.
    const ctx = deleted[0]?.[0] as { userId?: string } | undefined
    expect(ctx?.userId).toBe('user-9')
    expect(deleted[0]?.[1]).toBe('/apps/app-1/index.html')
  })
})
