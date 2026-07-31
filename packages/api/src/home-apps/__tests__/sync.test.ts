/**
 * [COMP:api/home-app-sync] — GitHub sync for custom Home apps.
 *
 * The claim this suite exists to defend: **a repo push cannot widen an app's
 * access without a human seeing it.** Everything else here (the HEAD early
 * return, per-app error isolation, root-path handling) is the KB poller's
 * shape; the drift branch is the one that turns a sync into a security
 * boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const applyCalls: Array<Record<string, unknown>> = []
let driftNext = false
const syncErrors: Array<{ appId: string; message: string }> = []

vi.mock('../../db/home-apps-store.js', () => ({
  applyHomeAppManifest: vi.fn(async (params: Record<string, unknown>) => {
    applyCalls.push(params)
    return {
      app: { id: params.appId, status: driftNext ? 'needs_consent' : 'active' },
      droppedToNeedsConsent: driftNext,
    }
  }),
  recordHomeAppSyncError: vi.fn(async (appId: string, message: string) => {
    syncErrors.push({ appId, message })
  }),
}))

import {
  createHomeAppSyncWorker,
  isBundleAsset,
  relativeBundlePath,
  syncHomeAppFromGitHub,
  type SyncDeps,
} from '../sync.js'

const MANIFEST = JSON.stringify({
  manifestVersion: 1,
  name: 'Board',
  entry: 'index.html',
  scopes: { data: 'read' },
})

function app(over: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    workspaceId: 'ws-1',
    kind: 'github',
    repo: 'acme/board',
    branch: 'main',
    rootPath: '',
    connectorInstanceId: 'ci-1',
    lastSyncedSha: null,
    ...over,
  } as never
}

function deps(over: Partial<SyncDeps> = {}) {
  const written: Array<Array<{ path: string }>> = []
  const fetched: string[] = []
  const value: SyncDeps = {
    api: {
      getBranchHead: vi.fn(async () => 'sha-new'),
      getRepoTree: vi.fn(async () => [
        { path: 'brian-app.json', type: 'blob', size: MANIFEST.length },
        { path: 'index.html', type: 'blob', size: 12 },
        { path: 'README.md', type: 'blob', size: 5 },
      ]),
      getFileText: vi.fn(async (_p, _o, _r, path: string) => {
        fetched.push(path)
        return path === 'brian-app.json' ? MANIFEST : 'x'
      }),
      ...(over.api ?? {}),
    },
    getPat: vi.fn(async () => 'pat'),
    writeBundle: vi.fn(async (_ws, _id, files) => {
      written.push(files)
    }),
    ...over,
  }
  return { value, written, fetched }
}

beforeEach(() => {
  applyCalls.length = 0
  syncErrors.length = 0
  driftNext = false
})

describe('[COMP:api/home-app-sync] isBundleAsset', () => {
  it('keeps the manifest and anything servable, drops repo furniture', () => {
    // A repo CONTAINS a bundle; failing an import because the repo has a
    // README would be absurd.
    expect(isBundleAsset('brian-app.json')).toBe(true)
    expect(isBundleAsset('index.html')).toBe(true)
    expect(isBundleAsset('assets/app.js')).toBe(true)
    expect(isBundleAsset('README.md')).toBe(false)
    expect(isBundleAsset('LICENSE')).toBe(false)
    expect(isBundleAsset('.github/workflows/ci.yml')).toBe(false)
    expect(isBundleAsset('pnpm-lock.yaml')).toBe(false)
  })
})

describe('[COMP:api/home-app-sync] relativeBundlePath', () => {
  it('is identity with no root path', () => {
    expect(relativeBundlePath('', 'a/b.js')).toBe('a/b.js')
  })

  it('strips the root prefix and drops anything outside it', () => {
    expect(relativeBundlePath('app', 'app/index.html')).toBe('index.html')
    expect(relativeBundlePath('/app/', 'app/assets/x.js')).toBe('assets/x.js')
    expect(relativeBundlePath('app', 'docs/readme.md')).toBeNull()
  })
})

describe('[COMP:api/home-app-sync] syncHomeAppFromGitHub', () => {
  it('early-returns on an unchanged HEAD without walking the tree', async () => {
    const d = deps()
    const result = await syncHomeAppFromGitHub(d.value, app({ lastSyncedSha: 'sha-new' }))
    expect(result).toEqual({ status: 'unchanged', sha: 'sha-new' })
    expect(d.value.api.getRepoTree).not.toHaveBeenCalled()
    expect(applyCalls).toEqual([])
  })

  it('fetches, validates, stores, and records the new sha', async () => {
    const d = deps()
    const result = await syncHomeAppFromGitHub(d.value, app())
    expect(result).toMatchObject({ status: 'synced', sha: 'sha-new' })
    // README.md is repo furniture, not a bundle asset — filtered, not fatal.
    expect(d.written[0].map((f) => f.path).sort()).toEqual([
      'brian-app.json',
      'index.html',
    ])
    expect(applyCalls[0]).toMatchObject({ appId: 'app-1', lastSyncedSha: 'sha-new' })
  })

  it('reports drift so the caller can tell the user the app went dark', async () => {
    // The whole point: a repo push that widens scopes drops the app to
    // needs_consent, and it leaves the Home strip until a human re-grants.
    driftNext = true
    const result = await syncHomeAppFromGitHub(deps().value, app())
    expect(result).toMatchObject({ status: 'synced', droppedToNeedsConsent: true })
  })

  it('validates BEFORE fetching every blob', async () => {
    // The caps are what make per-blob fetch acceptable, so an over-cap bundle
    // must not cost us the fetches first.
    const d = deps({
      api: {
        getBranchHead: vi.fn(async () => 'sha-new'),
        getRepoTree: vi.fn(async () => [
          { path: 'brian-app.json', type: 'blob', size: MANIFEST.length },
          { path: 'index.html', type: 'blob', size: 12 },
          { path: 'huge.js', type: 'blob', size: 9 * 1024 * 1024 },
        ]),
        getFileText: vi.fn(async (_p, _o, _r, path: string) =>
          path === 'brian-app.json' ? MANIFEST : 'x',
        ),
      } as never,
    })
    const result = await syncHomeAppFromGitHub(d.value, app())
    expect(result.status).toBe('failed')
    // Only the manifest was read.
    expect(d.value.api.getFileText).toHaveBeenCalledTimes(1)
    expect(applyCalls).toEqual([])
  })

  it('fails cleanly on a missing manifest, bad JSON, and a bad repo', async () => {
    const noManifest = deps({
      api: {
        getBranchHead: vi.fn(async () => 'sha-new'),
        getRepoTree: vi.fn(async () => [{ path: 'index.html', type: 'blob', size: 5 }]),
        getFileText: vi.fn(async () => 'x'),
      } as never,
    })
    expect((await syncHomeAppFromGitHub(noManifest.value, app())).status).toBe('failed')

    const badJson = deps({
      api: {
        getBranchHead: vi.fn(async () => 'sha-new'),
        getRepoTree: vi.fn(async () => [
          { path: 'brian-app.json', type: 'blob', size: 3 },
        ]),
        getFileText: vi.fn(async () => '{ nope'),
      } as never,
    })
    expect((await syncHomeAppFromGitHub(badJson.value, app())).status).toBe('failed')

    expect((await syncHomeAppFromGitHub(deps().value, app({ repo: 'nope' }))).status).toBe(
      'failed',
    )
    expect((await syncHomeAppFromGitHub(deps().value, app({ repo: null }))).status).toBe(
      'failed',
    )
  })

  it('turns a thrown network error into a recorded failure, not a crash', async () => {
    const d = deps({
      api: {
        getBranchHead: vi.fn(async () => {
          throw new Error('GitHub 502')
        }),
        getRepoTree: vi.fn(),
        getFileText: vi.fn(),
      } as never,
    })
    expect(await syncHomeAppFromGitHub(d.value, app())).toEqual({
      status: 'failed',
      error: 'GitHub 502',
    })
  })
})

describe('[COMP:api/home-app-sync] the poller', () => {
  it('records each failure and keeps going — one bad repo cannot stop the tick', async () => {
    const good = app({ id: 'ok' })
    const bad = app({ id: 'bad', repo: 'invalid' })
    const worker = createHomeAppSyncWorker({
      deps: deps().value,
      getAppsDue: async () => [bad, good],
    })
    await worker.tick()
    expect(syncErrors.map((e) => e.appId)).toEqual(['bad'])
    // The good app still synced, after the bad one failed.
    expect(applyCalls.map((c) => c.appId)).toEqual(['ok'])
  })

  it('is re-entrancy-guarded and honours the advisory lock', async () => {
    const getAppsDue = vi.fn(async () => [] as never[])
    const locked = createHomeAppSyncWorker({
      deps: deps().value,
      getAppsDue,
      tryAcquireLock: async () => false,
    })
    await locked.tick()
    // Lock refused → another instance owns this tick; do nothing.
    expect(getAppsDue).not.toHaveBeenCalled()

    const release = vi.fn(async () => {})
    const unlocked = createHomeAppSyncWorker({
      deps: deps().value,
      getAppsDue,
      tryAcquireLock: async () => true,
      releaseLock: release,
    })
    await unlocked.tick()
    expect(getAppsDue).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
