/**
 * Bring-your-own-storage resolver — points a workspace's file bytes at its
 * OWN bucket under its OWN credentials, falling back to the app default for
 * workspaces with no binding. Supports two backends: GCS (service-account key)
 * and S3-compatible (access-key/secret-key). Both satisfy the same
 * `GcsFilesClient` blob interface, so the caller (files-api) is backend-blind.
 *
 * This module is the *mechanism* (build + cache per-workspace clients, route
 * by bucket); it is policy-free. The caller injects a `lookup` that knows how
 * to find a workspace's binding (an active `gcs` or `s3` connector_instance)
 * and a `fallback` (the app-default singleton resolver). See
 * docs/plans/byo-google-storage.md §2-3 and docs/plans/byo-s3-storage.md.
 */

import {
  createGcsFilesClient,
  parseStorageBucket,
  type GcsFilesClient,
  type GcsServiceAccountCredentials,
} from './gcs-client.js'
import { createS3FilesClient, type S3Credentials } from './s3-client.js'
import type { FilesClientResolver, ResolvedFilesClient } from './files-api.js'

/** A workspace's GCS bring-your-own binding. */
export type GcsStorageBinding = {
  kind: 'gcs'
  credentials: GcsServiceAccountCredentials
  bucket: string
  projectId?: string
}

/** A workspace's S3-compatible bring-your-own binding. */
export type S3StorageBinding = {
  kind: 's3'
  credentials: S3Credentials
  bucket: string
  region?: string
  endpoint?: string
  forcePathStyle?: boolean
}

export type WorkspaceStorageBinding = GcsStorageBinding | S3StorageBinding

export type CachedByoResolverDeps = {
  /** Find a workspace's active BYO binding, or null when it has none. */
  lookup: (workspaceId: string) => Promise<WorkspaceStorageBinding | null>
  /** App-default resolver, used when a workspace has no binding. */
  fallback: FilesClientResolver
  /** GCS client factory — overridable in tests. */
  createGcsClient?: (opts: { bucket: string; projectId?: string; credentials: GcsServiceAccountCredentials }) => GcsFilesClient
  /** S3 client factory — overridable in tests. */
  createS3Client?: (opts: {
    bucket: string
    region?: string
    endpoint?: string
    forcePathStyle?: boolean
    credentials: S3Credentials
  }) => GcsFilesClient
  /** Bound on the per-bucket client cache. Default 256. */
  maxCacheEntries?: number
}

/** Cache key: backend + endpoint + bucket, so two backends never collide on a shared bucket name. */
function cacheKeyFor(binding: WorkspaceStorageBinding): string {
  return binding.kind === 's3'
    ? `s3:${binding.endpoint ?? ''}:${binding.bucket}`
    : `gcs:${binding.bucket}`
}

export function createCachedByoFilesResolver(deps: CachedByoResolverDeps): FilesClientResolver {
  const makeGcs = deps.createGcsClient ?? createGcsFilesClient
  const makeS3 = deps.createS3Client ?? createS3FilesClient
  const max = deps.maxCacheEntries ?? 256
  // Keyed by backend+bucket; the build is identical for the lifetime of a
  // binding, so the key is enough (a creds rotation that keeps the same bucket
  // is rare and self-heals once the entry is evicted). Insertion-ordered Map
  // gives a cheap FIFO eviction when the cap is hit.
  const cache = new Map<string, GcsFilesClient>()

  function getClient(binding: WorkspaceStorageBinding): GcsFilesClient {
    const cacheKey = cacheKeyFor(binding)
    const hit = cache.get(cacheKey)
    if (hit) return hit
    const client =
      binding.kind === 's3'
        ? makeS3({
            bucket: binding.bucket,
            region: binding.region,
            endpoint: binding.endpoint,
            forcePathStyle: binding.forcePathStyle,
            credentials: binding.credentials,
          })
        : makeGcs({ bucket: binding.bucket, projectId: binding.projectId, credentials: binding.credentials })
    cache.set(cacheKey, client)
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
      return {
        gcs: getClient(binding),
        bucket: binding.bucket,
        uriScheme: binding.kind === 's3' ? 's3' : 'gs',
        byo: true,
      }
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
