import { readFileSessionBinding, type FileSessionBinding } from '../workspace-access/file-publication-admission.js'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from './client.js'
import type { WorkspaceFilesStore, DerivedWriteEvidence, WorkspaceFileCreateInput, AccessContext, WorkspaceFile } from '@use-brian/core'
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
export type DerivedWorkspaceFilesStore = WorkspaceFilesStore & {
  prepareSessionOwned(userId: string, workspaceId: string, path: string, access?: AccessContext): Promise<FileSessionBinding>
  createSessionOwned(userId: string, input: WorkspaceFileCreateInput, binding: FileSessionBinding, access?: AccessContext): Promise<WorkspaceFile>
  finalizeUpload(userId: string, input: WorkspaceFileCreateInput, uploadId: string, access?: AccessContext): Promise<WorkspaceFile>
  createDerived(userId: string, input: WorkspaceFileCreateInput, evidence: DerivedWriteEvidence, access?: AccessContext): Promise<WorkspaceFile>
}

export function createDbWorkspaceFilesStore(): DerivedWorkspaceFilesStore {
  return {
    async prepareSessionOwned(userId,workspaceId,path,access) {
      const client=await getAppPool().connect()
      try {
        await client.query('BEGIN'); await applyRLSGucs(client,userId)
        const binding=await readFileSessionBinding(client,userId,workspaceId,path,access)
        await client.query('COMMIT'); return binding
      } finally { await rollbackAndRelease(client) }
    },
    createSessionOwned(userId,input,binding,access) { return createWorkspaceFile(userId,input,{access,sessionBinding:binding}) },
    finalizeUpload(userId,input,uploadId,access) { return createWorkspaceFile(userId,input,{access,uploadId}) },
    createDerived(userId, input, evidence, access) {
      return createWorkspaceFile(userId, input, { access, derivation: evidence })
    },
    create(userId, input, access) {
      return createWorkspaceFile(userId, input, { access })
    },
    getById(ctx, id) {
      return getWorkspaceFileById(ctx, id)
    },
    getByPath(ctx, path) {
      return getWorkspaceFileByPath(ctx, path)
    },
    updateMeta(userId, workspaceId, id, patch, access) {
      return updateWorkspaceFileMeta(userId, workspaceId, id, patch, undefined, access)
    },
    updateSize(userId, workspaceId, id, sizeBytes, scope, access) {
      return updateWorkspaceFileSize(userId, workspaceId, id, sizeBytes, scope, access)
    },
    delete(userId, workspaceId, id, access) {
      return deleteWorkspaceFile(userId, workspaceId, id, access)
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
    supersede(userId, workspaceId, id, patch, access) {
      return supersedeWorkspaceFile(userId, workspaceId, id, patch, access)
    },
    getHistory(ctx, id) {
      return getWorkspaceFileHistory(ctx, id)
    },
    retractByStorageBucketSystem(workspaceId, bucket, scheme, reason) {
      return retractWorkspaceFilesByStorageBucket(workspaceId, bucket, scheme, reason)
    },
  }
}
