import { assertCurrentFileAssistant } from '../workspace-access/file-publication-admission.js'
import { readAdmissionPolicy } from '../workspace-access/admission-policy-read.js'
/**
 * Durable ledger for direct-to-storage workspace file uploads.
 *
 * User-facing reads/writes use the app pool and its RLS policy. The expiry
 * reaper uses the system pool only to enumerate work that has already expired;
 * byte deletion is still scoped by each row's recorded workspace/storage URI.
 *
 * [COMP:files/chunked-upload]
 */

import { query, queryWithRLS, getAppPool, applyRLSGucs, rollbackAndRelease } from './client.js'
import type { AccessContext, ResourceScope } from '@use-brian/core'
import { admitFileCreate } from '../workspace-access/file-create-admission.js'
import { assertExecutionResourceScope } from './access-predicate.js'

export type WorkspaceFileUploadStatus = 'pending' | 'assembling' | 'completed' | 'aborted'

export type WorkspaceFileUpload = {
  admissionBinding?: ResourceScope
  id: string
  workspaceId: string
  actingUserId: string
  assistantId: string | null
  fileId: string
  path: string
  name: string
  mime: string
  sizeBytes: number
  chunkSizeBytes: number
  partCount: number
  storageUri: string
  quotaExempt: boolean
  status: WorkspaceFileUploadStatus
  expiresAt: Date
  completedAt: Date | null
  partsDeletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export type CreateWorkspaceFileUpload = Omit<
  WorkspaceFileUpload,
  'status' | 'completedAt' | 'partsDeletedAt' | 'createdAt' | 'updatedAt' | 'admissionBinding'
> & { access?: AccessContext; requestedCompartments?: string[]; requestedProjectIds?: string[]; sensitivity?: ResourceScope['sensitivity'] }

type UploadRow = Omit<WorkspaceFileUpload, 'sizeBytes'> & { sizeBytes: number | string }

const SELECT = `
  id, admission_binding AS "admissionBinding",
  workspace_id AS "workspaceId",
  acting_user_id AS "actingUserId",
  assistant_id AS "assistantId",
  file_id AS "fileId",
  path,
  name,
  mime,
  size_bytes AS "sizeBytes",
  chunk_size_bytes AS "chunkSizeBytes",
  part_count AS "partCount",
  storage_uri AS "storageUri",
  quota_exempt AS "quotaExempt",
  status,
  expires_at AS "expiresAt",
  completed_at AS "completedAt",
  parts_deleted_at AS "partsDeletedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

function record(row: UploadRow): WorkspaceFileUpload {
  return { ...row, sizeBytes: typeof row.sizeBytes === 'string' ? Number(row.sizeBytes) : row.sizeBytes }
}

export type WorkspaceFileUploadsStore = {
  create(userId: string, input: CreateWorkspaceFileUpload): Promise<WorkspaceFileUpload>
  get(userId: string, uploadId: string): Promise<WorkspaceFileUpload | null>
  claim(userId: string, uploadId: string): Promise<WorkspaceFileUpload | null>
  resetPending(userId: string, uploadId: string): Promise<void>
  markCompleted(userId: string, uploadId: string): Promise<void>
  markAborted(userId: string, uploadId: string): Promise<void>
  markAbortedSystem(uploadId: string): Promise<void>
  markPartsDeletedSystem(uploadId: string): Promise<void>
  listExpiredSystem(limit?: number): Promise<WorkspaceFileUpload[]>
  listCompletedWithPartsSystem(limit?: number): Promise<WorkspaceFileUpload[]>
}

export function createWorkspaceFileUploadsStore(): WorkspaceFileUploadsStore {
  return {
    async create(userId, input) {
      const client=await getAppPool().connect()
      try {
        await client.query('BEGIN'); await applyRLSGucs(client,userId)
        if (input.actingUserId!==userId || (input.access && (input.access.userId!==userId || input.access.workspaceId!==input.workspaceId))) throw new Error('scope_operation_denied')
        const admitted=await admitFileCreate(client,userId,{workspaceId:input.workspaceId,path:input.path,parentPath:'/uploads',name:input.name,mime:input.mime,
          sizeBytes:input.sizeBytes,storageUri:input.storageUri,createdByUserId:userId,sensitivity:input.sensitivity,
          compartments:input.requestedCompartments,projectIds:input.requestedProjectIds})
        const binding:ResourceScope={workspaceId:input.workspaceId,userId:null,assistantId:null,sensitivity:admitted.sensitivity??'internal',
          compartments:admitted.compartments??[],projectIds:admitted.projectIds??[]}
        await assertCurrentFileAssistant(client,binding,input.access)
        assertExecutionResourceScope(binding,'mutation',input.access)
        const ready=(await readAdmissionPolicy(client,input.workspaceId))?.setupState==='ready'
        const result = await client.query<UploadRow>(
          `INSERT INTO workspace_file_uploads (
             id, workspace_id, acting_user_id, assistant_id, file_id,
             path, name, mime, size_bytes, chunk_size_bytes, part_count,
             storage_uri, quota_exempt, expires_at, admission_binding
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
           RETURNING ${SELECT}`,
          [
            input.id,
            input.workspaceId,
            input.actingUserId,
            input.assistantId,
            input.fileId,
            input.path,
            input.name,
            input.mime,
            input.sizeBytes,
            input.chunkSizeBytes,
            input.partCount,
            input.storageUri,
            input.quotaExempt,
            input.expiresAt, JSON.stringify({...binding,ready,executingAssistantId:input.assistantId}),
          ],
        )
        await client.query('COMMIT')
        return record(result.rows[0])
      } finally { await rollbackAndRelease(client) }
    },

    async get(userId, uploadId) {
      const result = await queryWithRLS<UploadRow>(
        userId,
        `SELECT ${SELECT} FROM workspace_file_uploads WHERE id = $1`,
        [uploadId],
      )
      return result.rows[0] ? record(result.rows[0]) : null
    },

    async claim(userId, uploadId) {
      const result = await queryWithRLS<UploadRow>(
        userId,
        `UPDATE workspace_file_uploads
         SET status = 'assembling', updated_at = now()
         WHERE id = $1 AND status = 'pending' AND expires_at > now()
         RETURNING ${SELECT}`,
        [uploadId],
      )
      return result.rows[0] ? record(result.rows[0]) : null
    },

    async resetPending(userId, uploadId) {
      await queryWithRLS(
        userId,
        `UPDATE workspace_file_uploads
         SET status = 'pending', updated_at = now()
         WHERE id = $1 AND status = 'assembling' AND expires_at > now()`,
        [uploadId],
      )
    },

    async markCompleted(userId, uploadId) {
      await queryWithRLS(
        userId,
        `UPDATE workspace_file_uploads
         SET status = 'completed', completed_at = COALESCE(completed_at, now()), updated_at = now()
         WHERE id = $1 AND status IN ('pending', 'assembling', 'completed')`,
        [uploadId],
      )
    },

    async markAborted(userId, uploadId) {
      await queryWithRLS(
        userId,
        `UPDATE workspace_file_uploads
         SET status = 'aborted', updated_at = now()
         WHERE id = $1 AND status IN ('pending', 'assembling', 'aborted')`,
        [uploadId],
      )
    },

    async markAbortedSystem(uploadId) {
      await query(
        `UPDATE workspace_file_uploads
         SET status = 'aborted', updated_at = now()
         WHERE id = $1 AND status IN ('pending', 'assembling', 'aborted')`,
        [uploadId],
      )
    },

    async markPartsDeletedSystem(uploadId) {
      await query(
        `UPDATE workspace_file_uploads
         SET parts_deleted_at = COALESCE(parts_deleted_at, now()), updated_at = now()
         WHERE id = $1`,
        [uploadId],
      )
    },

    async listExpiredSystem(limit = 50) {
      const result = await query<UploadRow>(
        `SELECT ${SELECT}
         FROM workspace_file_uploads
         WHERE status IN ('pending', 'assembling') AND expires_at <= now()
         ORDER BY expires_at ASC
         LIMIT $1`,
        [Math.min(Math.max(limit, 1), 200)],
      )
      return result.rows.map(record)
    },

    async listCompletedWithPartsSystem(limit = 50) {
      const result = await query<UploadRow>(
        `SELECT ${SELECT}
         FROM workspace_file_uploads
         WHERE status = 'completed' AND parts_deleted_at IS NULL
         ORDER BY completed_at ASC NULLS FIRST
         LIMIT $1`,
        [Math.min(Math.max(limit, 1), 200)],
      )
      return result.rows.map(record)
    },
  }
}
