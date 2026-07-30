/**
 * GitHub sync for custom Home apps.
 *
 * The KB sync-worker pattern (`packages/core/src/knowledge/sync-worker.ts`)
 * applied to bundles: a 15-minute `setInterval` with a re-entrancy flag and an
 * injected advisory lock, a `getBranchHead` early return, and per-app errors
 * that land in `sync_error` and never stop the tick.
 *
 * Three things this deliberately does NOT do:
 *
 *   - **No tarball fetch.** There is no tarball helper anywhere in this
 *     codebase, and v1 does not add one: the bundle caps (100 files, 5 MB) keep
 *     per-blob fetch acceptable, and a tarball path would be a new dependency
 *     surface for a problem we do not have yet.
 *   - **No webhooks.** PAT-only connectors cannot register them — the same
 *     documented constraint the KB and github-ingest pollers live with. 15-min
 *     polling is the house cadence.
 *   - **No credential storage.** The PAT is resolved through the app's
 *     `connector_instance_id`, so revoking the connector revokes the sync.
 *
 * And one it does, which is the whole point of syncing at all being safe:
 * every sync runs the bundle through the same validator the import ran, and
 * `applyHomeAppManifest` drops the app to `needs_consent` if the new manifest
 * asks for more than the standing grant. A repo push cannot widen an app's
 * access without a human seeing it.
 *
 * Spec: docs/architecture/features/home-apps.md → "Custom apps".
 * [COMP:api/home-app-sync]
 */

import {
  MANIFEST_FILENAME,
  contentTypeFor,
  validateBundle,
  type AppManifest,
} from '@use-brian/brian-app'
import {
  applyHomeAppManifest,
  recordHomeAppSyncError,
  type HomeAppRow,
} from '../db/home-apps-store.js'

/** The GitHub reads a sync needs. Injected so tests need no network. */
export type SyncGitHubApi = {
  getBranchHead(pat: string, owner: string, repo: string, branch: string): Promise<string>
  getRepoTree(
    pat: string,
    owner: string,
    repo: string,
    sha: string,
  ): Promise<Array<{ path: string; type: string; size?: number }>>
  getFileText(
    pat: string,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string>
}

export type SyncDeps = {
  api: SyncGitHubApi
  /** Resolve the PAT through the connector instance — never a stored token. */
  getPat(workspaceId: string, connectorInstanceId: string | null): Promise<string>
  /** Replace an app's stored bundle with these files. */
  writeBundle(
    workspaceId: string,
    appId: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<void>
}

export type SyncOutcome =
  | { status: 'unchanged'; sha: string }
  | { status: 'synced'; sha: string; droppedToNeedsConsent: boolean; manifest: AppManifest }
  | { status: 'failed'; error: string }

/**
 * Is this repo file part of the bundle at all?
 *
 * The manifest plus anything the bundle route would serve. Everything else in
 * the repo — README, LICENSE, CI config, lockfiles, source that gets built
 * elsewhere — is repo furniture, and skipping it is what lets an app live in
 * an ordinary repo rather than a bare directory of servable assets.
 */
export function isBundleAsset(path: string): boolean {
  return path === MANIFEST_FILENAME || contentTypeFor(path) !== null
}

/** Strip the app's `root_path` prefix so bundle paths are root-relative. */
export function relativeBundlePath(rootPath: string, entryPath: string): string | null {
  const prefix = rootPath.replace(/^\/+|\/+$/g, '')
  if (!prefix) return entryPath
  if (!entryPath.startsWith(`${prefix}/`)) return null
  return entryPath.slice(prefix.length + 1)
}

/** Turn any throw into a message safe to persist and show. */
export function describeSyncError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.slice(0, 500)
}

/**
 * Sync one app from its repo. Returns an outcome rather than throwing, so the
 * worker's loop can record a per-app failure and keep going — one broken repo
 * must never stop every other workspace's sync.
 */
export async function syncHomeAppFromGitHub(
  deps: SyncDeps,
  app: HomeAppRow,
): Promise<SyncOutcome> {
  try {
    if (!app.repo) return { status: 'failed', error: 'This app has no repository.' }
    const [owner, name] = app.repo.split('/')
    if (!owner || !name) {
      return { status: 'failed', error: `Invalid repository: ${app.repo}` }
    }

    const pat = await deps.getPat(app.workspaceId, app.connectorInstanceId)
    const head = await deps.api.getBranchHead(pat, owner, name, app.branch)

    // Early return on an unchanged HEAD — the same first check the KB poller
    // makes. Most ticks find nothing, and a tree walk per app per 15 minutes
    // across every workspace is the cost this avoids.
    if (head === app.lastSyncedSha) return { status: 'unchanged', sha: head }

    const tree = await deps.api.getRepoTree(pat, owner, name, head)
    const wanted: Array<{ repoPath: string; path: string; bytes: number }> = []
    for (const entry of tree) {
      if (entry.type !== 'blob') continue
      const rel = relativeBundlePath(app.rootPath, entry.path)
      if (rel === null) continue
      // A repo CONTAINS a bundle; it is not one. `README.md`, `LICENSE`, the
      // CI workflow, a lockfile — every real app repo carries files that are
      // not bundle assets, and failing the import because one exists would be
      // absurd. So the GitHub path FILTERS to what we can serve; the assistant
      // path does not, because there an unservable file means the model sent
      // something it thought would be served.
      if (!isBundleAsset(rel)) continue
      wanted.push({ repoPath: entry.path, path: rel, bytes: entry.size ?? 0 })
    }

    const manifestEntry = wanted.find((f) => f.path === MANIFEST_FILENAME)
    if (!manifestEntry) {
      return {
        status: 'failed',
        error: `No ${MANIFEST_FILENAME} at ${app.repo}${app.rootPath ? `/${app.rootPath}` : ''}.`,
      }
    }

    const manifestText = await deps.api.getFileText(
      pat,
      owner,
      name,
      manifestEntry.repoPath,
      head,
    )
    let manifestJson: unknown
    try {
      manifestJson = JSON.parse(manifestText)
    } catch (err) {
      return { status: 'failed', error: `${MANIFEST_FILENAME} is not valid JSON: ${describeSyncError(err)}` }
    }

    // Validate BEFORE fetching every blob: the caps are what make per-blob
    // fetch acceptable, so a bundle that blows them must not cost us the
    // fetches first.
    const validated = validateBundle({
      files: wanted.map((f) => ({ path: f.path, bytes: f.bytes })),
      manifestJson,
    })
    if (!validated.ok) {
      return {
        status: 'failed',
        error: validated.issues
          .map((i) => `${i.path || '(bundle)'}: ${i.message}`)
          .join('; ')
          .slice(0, 500),
      }
    }

    const files: Array<{ path: string; content: string }> = []
    for (const file of wanted) {
      files.push({
        path: file.path,
        content:
          file.path === MANIFEST_FILENAME
            ? manifestText
            : await deps.api.getFileText(pat, owner, name, file.repoPath, head),
      })
    }

    await deps.writeBundle(app.workspaceId, app.id, files)

    // The grant check. A repo push cannot widen an app's access without a
    // human seeing it: a manifest asking for more than the standing grant
    // drops the app to `needs_consent`, and it leaves the Home strip.
    const applied = await applyHomeAppManifest({
      appId: app.id,
      manifest: validated.manifest,
      lastSyncedSha: head,
    })
    if (!applied) return { status: 'failed', error: 'The app was removed mid-sync.' }

    return {
      status: 'synced',
      sha: head,
      droppedToNeedsConsent: applied.droppedToNeedsConsent,
      manifest: validated.manifest,
    }
  } catch (err) {
    return { status: 'failed', error: describeSyncError(err) }
  }
}

export type HomeAppSyncWorkerOptions = {
  deps: SyncDeps
  /** GitHub-kind apps due for a sync. */
  getAppsDue(): Promise<HomeAppRow[]>
  intervalMs?: number
  tryAcquireLock?: () => Promise<boolean>
  releaseLock?: () => Promise<void>
  onEvent?: (event: { appId: string; repo: string | null; outcome: SyncOutcome }) => void
}

/**
 * The 15-minute poller. Re-entrancy flag + injected advisory lock, so several
 * API instances do not all sync the same repo, and a slow tick cannot overlap
 * itself.
 */
export function createHomeAppSyncWorker(opts: HomeAppSyncWorkerOptions): {
  start(): void
  stop(): void
  tick(): Promise<void>
} {
  const intervalMs = opts.intervalMs ?? 15 * 60 * 1000
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      if (opts.tryAcquireLock && !(await opts.tryAcquireLock())) return
      for (const app of await opts.getAppsDue()) {
        // Per-app try/catch: one broken repo must never stop every other
        // workspace's sync.
        try {
          const outcome = await syncHomeAppFromGitHub(opts.deps, app)
          if (outcome.status === 'failed') {
            await recordHomeAppSyncError(app.id, outcome.error)
          }
          opts.onEvent?.({ appId: app.id, repo: app.repo, outcome })
        } catch (err) {
          const error = describeSyncError(err)
          console.error(`[home-app-sync] ${app.repo ?? app.id} failed:`, error)
          await recordHomeAppSyncError(app.id, error).catch(() => {})
        }
      }
    } finally {
      if (opts.releaseLock) await opts.releaseLock().catch(() => {})
      running = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), intervalMs)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
}
