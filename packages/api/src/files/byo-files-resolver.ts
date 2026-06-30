/**
 * Bring-your-own-storage resolver — points a workspace's file bytes at its
 * OWN GCS bucket under its OWN service-account key, falling back to the app
 * default for workspaces with no binding.
 *
 * This module is the *mechanism* (build + cache per-workspace clients,
 * route by bucket); it is policy-free. The caller injects a `lookup` that
 * knows how to find a workspace's binding (e.g. an active `gcs`
 * connector_instance) and a `fallback` (the app-default singleton resolver).
 * See docs/plans/byo-google-storage.md §2-3.
 */

import {
  createGcsFilesClient,
  parseStorageBucket,
  type GcsFilesClient,
  type GcsServiceAccountCredentials,
} from './gcs-client.js'
import type { FilesClientResolver, ResolvedFilesClient } from './files-api.js'

export type WorkspaceStorageBinding = {
  credentials: GcsServiceAccountCredentials
  bucket: string
  projectId?: string
}

export type CachedByoResolverDeps = {
  /** Find a workspace's active BYO binding, or null when it has none. */
  lookup: (workspaceId: string) => Promise<WorkspaceStorageBinding | null>
  /** App-default resolver, used when a workspace has no binding. */
  fallback: FilesClientResolver
  /** Client factory — overridable in tests. */
  createClient?: (opts: { bucket: string; projectId?: string; credentials: GcsServiceAccountCredentials }) => GcsFilesClient
  /** Bound on the per-bucket client cache. Default 256. */
  maxCacheEntries?: number
}

export function createCachedByoFilesResolver(deps: CachedByoResolverDeps): FilesClientResolver {
  const make = deps.createClient ?? createGcsFilesClient
  const max = deps.maxCacheEntries ?? 256
  // Keyed by bucket name; the build is identical for the lifetime of a binding,
  // so a bucket key is enough (a creds rotation that keeps the same bucket is
  // rare and self-heals once the entry is evicted). Insertion-ordered Map gives
  // a cheap FIFO eviction when the cap is hit.
  const cache = new Map<string, GcsFilesClient>()

  function getClient(binding: WorkspaceStorageBinding): GcsFilesClient {
    const hit = cache.get(binding.bucket)
    if (hit) return hit
    const client = make({ bucket: binding.bucket, projectId: binding.projectId, credentials: binding.credentials })
    cache.set(binding.bucket, client)
    if (cache.size > max) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return client
  }

  return {
    async forWorkspace(workspaceId: string): Promise<ResolvedFilesClient> {
      const binding = await deps.lookup(workspaceId)
      if (!binding) return deps.fallback.forWorkspace(workspaceId)
      return { gcs: getClient(binding), bucket: binding.bucket, byo: true }
    },

    async forUri(workspaceId: string, storageUri: string): Promise<GcsFilesClient> {
      const bucket = parseStorageBucket(storageUri)
      const binding = await deps.lookup(workspaceId)
      // The file lives in the workspace's BYO bucket and we still hold the key.
      // (After disconnect the key is gone → lookup returns null → fallback, so
      // dormant BYO files read as not_found until a reconnect.)
      if (binding && binding.bucket === bucket) return getClient(binding)
      // Otherwise it's an app-default-bucket file (the common pre-BYO case) →
      // app client. (A file stranded in a *previous* BYO bucket the workspace
      // has since left is a documented limitation, not handled here.)
      return deps.fallback.forUri(workspaceId, storageUri)
    },
  }
}
