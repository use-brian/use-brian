import type { WorkspaceFilesStore } from '@use-brian/core'
import {
  createWorkspaceFile,
  getWorkspaceFileById,
  getWorkspaceFileByPath,
  getWorkspaceFileHistory,
  updateWorkspaceFileMeta,
  updateWorkspaceFileSize,
  deleteWorkspaceFile,
  listWorkspaceFilesByPath,
  searchWorkspaceFiles,
  listWorkspaceFilesIndexRanked,
  sumWorkspaceFilesSizeBytes,
  supersedeWorkspaceFile,
  retractWorkspaceFilesByStorageBucket,
} from './workspace-files.js'

/**
 * Create a WorkspaceFilesStore backed by PostgreSQL.
 * Adapts the SQL helpers in `workspace-files.ts` to the core
 * `WorkspaceFilesStore` interface.
 *
 * All operations route through `queryWithRLS(userId, ...)` so the
 * `wf_workspace_member` RLS policy enforces workspace isolation. The
 * SQL also filters by `workspace_id` explicitly — RLS is the second
 * layer of defense. `supersede` runs both writes on a single connection
 * with RLS engaged for the duration of the transaction.
 */
export function createDbWorkspaceFilesStore(): WorkspaceFilesStore {
  return {
    create(userId, input) {
      return createWorkspaceFile(userId, input)
    },
    getById(ctx, id) {
      return getWorkspaceFileById(ctx, id)
    },
    getByPath(ctx, path) {
      return getWorkspaceFileByPath(ctx, path)
    },
    updateMeta(userId, workspaceId, id, patch) {
      return updateWorkspaceFileMeta(userId, workspaceId, id, patch)
    },
    updateSize(userId, workspaceId, id, sizeBytes) {
      return updateWorkspaceFileSize(userId, workspaceId, id, sizeBytes)
    },
    delete(userId, workspaceId, id) {
      return deleteWorkspaceFile(userId, workspaceId, id)
    },
    listByPath(ctx, opts) {
      return listWorkspaceFilesByPath(ctx, opts)
    },
    searchByText(ctx, opts) {
      return searchWorkspaceFiles(ctx, opts)
    },
    listIndexRanked(ctx, limit) {
      return listWorkspaceFilesIndexRanked(ctx, limit)
    },
    sumSizeBytes(ctx) {
      return sumWorkspaceFilesSizeBytes(ctx)
    },
    supersede(userId, workspaceId, id, patch) {
      return supersedeWorkspaceFile(userId, workspaceId, id, patch)
    },
    getHistory(ctx, id) {
      return getWorkspaceFileHistory(ctx, id)
    },
    retractByStorageBucketSystem(workspaceId, bucket, scheme, reason) {
      return retractWorkspaceFilesByStorageBucket(workspaceId, bucket, scheme, reason)
    },
  }
}
