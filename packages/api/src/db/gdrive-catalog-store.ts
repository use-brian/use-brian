/**
 * Workspace-specific Google Drive metadata catalog and recurring sync ledger.
 *
 * The catalog is deliberately metadata-only. Its rows are also the
 * application-enforced membership boundary for selected-folder BYO Drive
 * reads. All worker operations use the owner pool; configuration/status first
 * pass the shared Drive workspace-owner/admin boundary.
 *
 * [COMP:integrations/gdrive-enrichment]
 */

import { query } from './client.js'
import {
  assertGDriveWorkspaceAdminAuthority,
  GDriveEnrichmentImportAuthError,
} from './gdrive-enrichment-store.js'

export type GDriveCatalogScope = 'entire_drive' | 'selected_folders'

export type GDriveCatalogFolder = {
  id: string
  name: string
}

export type GDriveCatalogSyncStatus = 'pending' | 'processing' | 'done' | 'failed'

export type GDriveCatalogSyncJob = {
  id: string
  workspaceId: string
  connectorInstanceId: string
  actingUserId: string
  syncScope: GDriveCatalogScope
  selectedFolders: GDriveCatalogFolder[]
  generation: string
  status: GDriveCatalogSyncStatus
  estimatedFiles: number | null
  filesSeen: number
  filesIndexed: number
  attempts: number
  lastError: string | null
}

export type GDriveCatalogEntry = {
  externalFileId: string
  name: string
  mimeType: string
  sourceVersion: string
  modifiedTime: string | null
  sizeBytes: number | null
  webViewLink: string | null
  parentIds: string[]
  folderPath: string[]
  isFolder: boolean
}

export type GDriveCatalogStoredEntry = GDriveCatalogEntry & {
  artifactFileId: string | null
  lastSeenGeneration: string
}

export type GDriveCatalogStatus = {
  configured: boolean
  syncScope: GDriveCatalogScope | null
  selectedFolders: GDriveCatalogFolder[]
  status: GDriveCatalogSyncStatus | null
  estimatedFiles: number | null
  filesSeen: number
  filesIndexed: number
  catalogFiles: number
  lastError: string | null
  nextSyncAt: string | null
  lastCompletedAt: string | null
}

export const GDRIVE_CATALOG_MAX_ATTEMPTS = 3
export const GDRIVE_CATALOG_SYNC_INTERVAL_HOURS = 6

const SYNC_RETURNING = `
  id,
  workspace_id          AS "workspaceId",
  connector_instance_id AS "connectorInstanceId",
  acting_user_id        AS "actingUserId",
  sync_scope            AS "syncScope",
  selected_folders      AS "selectedFolders",
  generation,
  status,
  estimated_files       AS "estimatedFiles",
  files_seen            AS "filesSeen",
  files_indexed         AS "filesIndexed",
  attempts,
  last_error            AS "lastError"
`

export async function configureGDriveCatalog(input: {
  actingUserId: string
  workspaceId: string
  connectorInstanceId: string
  syncScope: GDriveCatalogScope
  selectedFolders: GDriveCatalogFolder[]
  estimatedFiles: number
}): Promise<string> {
  await assertGDriveWorkspaceAdminAuthority(input)
  const { rows } = await query<{ generation: string }>(
    `WITH configured AS (
       INSERT INTO gdrive_catalog_syncs
       (workspace_id, connector_instance_id, acting_user_id, sync_scope,
        selected_folders, estimated_files)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT (workspace_id, connector_instance_id)
         DO UPDATE SET
           acting_user_id = EXCLUDED.acting_user_id,
           sync_scope = EXCLUDED.sync_scope,
           selected_folders = EXCLUDED.selected_folders,
           generation = gen_random_uuid(),
           status = 'pending',
           estimated_files = EXCLUDED.estimated_files,
           files_seen = 0,
           files_indexed = 0,
           attempts = 0,
           last_error = NULL,
           locked_at = NULL,
           next_sync_at = NULL,
           updated_at = now()
       RETURNING generation
     ), deactivated AS (
       UPDATE gdrive_file_catalog
          SET active = false, updated_at = now()
        WHERE workspace_id = $1 AND connector_instance_id = $2
       RETURNING id
     )
     SELECT generation FROM configured`,
    [
      input.workspaceId,
      input.connectorInstanceId,
      input.actingUserId,
      input.syncScope,
      JSON.stringify(input.selectedFolders),
      input.estimatedFiles,
    ],
  )
  if (!rows[0]) throw new Error('Drive catalog configuration was not persisted')
  return rows[0].generation
}

export async function listGDriveCatalogArtifactsOutsideGeneration(input: {
  workspaceId: string
  connectorInstanceId: string
  generation: string
}): Promise<string[]> {
  const { rows } = await query<{ artifact_file_id: string }>(
    `SELECT artifact_file_id
       FROM gdrive_file_catalog
      WHERE workspace_id = $1 AND connector_instance_id = $2
        AND last_seen_generation <> $3 AND artifact_file_id IS NOT NULL`,
    [input.workspaceId, input.connectorInstanceId, input.generation],
  )
  return rows.map((row) => row.artifact_file_id)
}

export async function getGDriveCatalogStatus(input: {
  actingUserId: string
  workspaceId: string
  connectorInstanceId: string
}): Promise<GDriveCatalogStatus> {
  await assertGDriveWorkspaceAdminAuthority(input)
  const { rows } = await query<{
    sync_scope: GDriveCatalogScope
    selected_folders: GDriveCatalogFolder[]
    status: GDriveCatalogSyncStatus
    estimated_files: number | null
    files_seen: number
    files_indexed: number
    last_error: string | null
    next_sync_at: Date | null
    last_completed_at: Date | null
    catalog_files: string
  }>(
    `SELECT s.sync_scope, s.selected_folders, s.status, s.estimated_files,
            s.files_seen, s.files_indexed, s.last_error, s.next_sync_at,
            s.last_completed_at,
            (SELECT count(*)::text FROM gdrive_file_catalog c
              WHERE c.workspace_id = s.workspace_id
                AND c.connector_instance_id = s.connector_instance_id
                AND c.active = true
                AND c.is_folder = false) AS catalog_files
       FROM gdrive_catalog_syncs s
      WHERE s.workspace_id = $1 AND s.connector_instance_id = $2`,
    [input.workspaceId, input.connectorInstanceId],
  )
  const row = rows[0]
  if (!row) {
    return {
      configured: false,
      syncScope: null,
      selectedFolders: [],
      status: null,
      estimatedFiles: null,
      filesSeen: 0,
      filesIndexed: 0,
      catalogFiles: 0,
      lastError: null,
      nextSyncAt: null,
      lastCompletedAt: null,
    }
  }
  return {
    configured: true,
    syncScope: row.sync_scope,
    selectedFolders: row.selected_folders,
    status: row.status,
    estimatedFiles: row.estimated_files,
    filesSeen: row.files_seen,
    filesIndexed: row.files_indexed,
    catalogFiles: Number(row.catalog_files),
    lastError: row.last_error,
    nextSyncAt: row.next_sync_at?.toISOString() ?? null,
    lastCompletedAt: row.last_completed_at?.toISOString() ?? null,
  }
}

export async function claimNextGDriveCatalogSync(): Promise<GDriveCatalogSyncJob | null> {
  const { rows } = await query<GDriveCatalogSyncJob>(
    `UPDATE gdrive_catalog_syncs
        SET generation = CASE WHEN status = 'done' THEN gen_random_uuid() ELSE generation END,
            status = 'processing', attempts = CASE WHEN status = 'done' THEN 1 ELSE attempts + 1 END,
            files_seen = 0, files_indexed = 0, last_error = NULL,
            locked_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM gdrive_catalog_syncs
         WHERE status = 'pending'
            OR (status = 'done' AND next_sync_at IS NOT NULL AND next_sync_at <= now())
         ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, updated_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING ${SYNC_RETURNING}`,
  )
  return rows[0] ?? null
}

export async function isGDriveCatalogRunCurrent(id: string, generation: string): Promise<boolean> {
  const { rows } = await query<{ current: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM gdrive_catalog_syncs
        WHERE id = $1 AND generation = $2 AND status = 'processing'
     ) AS current`,
    [id, generation],
  )
  return rows[0]?.current ?? false
}

export async function upsertGDriveCatalogEntry(input: {
  job: Pick<GDriveCatalogSyncJob, 'workspaceId' | 'connectorInstanceId' | 'generation'>
  entry: GDriveCatalogEntry
}): Promise<GDriveCatalogStoredEntry | null> {
  const previous = await query<GDriveCatalogStoredEntry>(
    `SELECT external_file_id AS "externalFileId", name,
            mime_type AS "mimeType", source_version AS "sourceVersion",
            modified_time::text AS "modifiedTime", size_bytes::float8 AS "sizeBytes",
            web_view_link AS "webViewLink", parent_ids AS "parentIds",
            folder_path AS "folderPath", is_folder AS "isFolder",
            artifact_file_id AS "artifactFileId",
            last_seen_generation AS "lastSeenGeneration"
       FROM gdrive_file_catalog
      WHERE workspace_id = $1 AND connector_instance_id = $2 AND external_file_id = $3`,
    [input.job.workspaceId, input.job.connectorInstanceId, input.entry.externalFileId],
  )
  await query(
    `INSERT INTO gdrive_file_catalog
       (workspace_id, connector_instance_id, external_file_id, name, mime_type,
        source_version, modified_time, size_bytes, web_view_link, parent_ids,
        folder_path, is_folder, last_seen_generation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (workspace_id, connector_instance_id, external_file_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         mime_type = EXCLUDED.mime_type,
         source_version = EXCLUDED.source_version,
         modified_time = EXCLUDED.modified_time,
         size_bytes = EXCLUDED.size_bytes,
         web_view_link = EXCLUDED.web_view_link,
         parent_ids = EXCLUDED.parent_ids,
         folder_path = EXCLUDED.folder_path,
         is_folder = EXCLUDED.is_folder,
         artifact_file_id = CASE WHEN EXCLUDED.is_folder THEN NULL ELSE gdrive_file_catalog.artifact_file_id END,
         last_seen_generation = EXCLUDED.last_seen_generation,
         updated_at = now()`,
    [
      input.job.workspaceId,
      input.job.connectorInstanceId,
      input.entry.externalFileId,
      input.entry.name,
      input.entry.mimeType,
      input.entry.sourceVersion,
      input.entry.modifiedTime,
      input.entry.sizeBytes,
      input.entry.webViewLink,
      input.entry.parentIds,
      input.entry.folderPath,
      input.entry.isFolder,
      input.job.generation,
    ],
  )
  return previous.rows[0] ?? null
}

export async function setGDriveCatalogArtifact(input: {
  workspaceId: string
  connectorInstanceId: string
  externalFileId: string
  generation: string
  artifactFileId: string | null
}): Promise<void> {
  await query(
    `UPDATE gdrive_file_catalog
        SET artifact_file_id = $5, updated_at = now()
      WHERE workspace_id = $1 AND connector_instance_id = $2
        AND external_file_id = $3 AND last_seen_generation = $4`,
    [input.workspaceId, input.connectorInstanceId, input.externalFileId, input.generation, input.artifactFileId],
  )
}

export async function updateGDriveCatalogProgress(input: {
  id: string
  generation: string
  filesSeen: number
  filesIndexed: number
}): Promise<void> {
  await query(
    `UPDATE gdrive_catalog_syncs
        SET files_seen = $3, files_indexed = $4, updated_at = now()
      WHERE id = $1 AND generation = $2 AND status = 'processing'`,
    [input.id, input.generation, input.filesSeen, input.filesIndexed],
  )
}

export async function listStaleGDriveCatalogArtifacts(input: {
  workspaceId: string
  connectorInstanceId: string
  generation: string
}): Promise<string[]> {
  const { rows } = await query<{ artifact_file_id: string }>(
    `SELECT artifact_file_id
       FROM gdrive_file_catalog
      WHERE workspace_id = $1 AND connector_instance_id = $2
        AND last_seen_generation <> $3 AND artifact_file_id IS NOT NULL`,
    [input.workspaceId, input.connectorInstanceId, input.generation],
  )
  return rows.map((row) => row.artifact_file_id)
}

export async function completeGDriveCatalogSync(input: {
  id: string
  workspaceId: string
  connectorInstanceId: string
  generation: string
  filesSeen: number
  filesIndexed: number
}): Promise<void> {
  await query(
    `WITH current_run AS (
       SELECT id, generation
         FROM gdrive_catalog_syncs
        WHERE id = $1 AND generation = $2 AND status = 'processing'
     ), activated AS (
       UPDATE gdrive_file_catalog c
          SET active = true, updated_at = now()
         FROM current_run r
        WHERE c.workspace_id = $3 AND c.connector_instance_id = $4
          AND c.last_seen_generation = r.generation
       RETURNING c.id
     ), removed AS (
       DELETE FROM gdrive_file_catalog c
        USING current_run r
        WHERE c.workspace_id = $3 AND c.connector_instance_id = $4
          AND c.last_seen_generation <> r.generation
       RETURNING c.id
     )
     UPDATE gdrive_catalog_syncs s
        SET status = 'done', files_seen = $5, files_indexed = $6,
            attempts = 0, last_error = NULL, locked_at = NULL,
            last_completed_at = now(),
            next_sync_at = now() + interval '${GDRIVE_CATALOG_SYNC_INTERVAL_HOURS} hours',
            updated_at = now()
       FROM current_run r
      WHERE s.id = r.id`,
    [
      input.id,
      input.generation,
      input.workspaceId,
      input.connectorInstanceId,
      input.filesSeen,
      input.filesIndexed,
    ],
  )
}

export async function markGDriveCatalogSyncFailed(
  id: string,
  generation: string,
  error: string,
): Promise<{ retrying: boolean }> {
  const { rows } = await query<{ attempts: number }>(
    `UPDATE gdrive_catalog_syncs
        SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
            last_error = $4, locked_at = NULL, updated_at = now()
      WHERE id = $1 AND generation = $2
      RETURNING attempts`,
    [id, generation, GDRIVE_CATALOG_MAX_ATTEMPTS, error.slice(0, 2000)],
  )
  const attempts = rows[0]?.attempts ?? GDRIVE_CATALOG_MAX_ATTEMPTS
  return { retrying: attempts < GDRIVE_CATALOG_MAX_ATTEMPTS }
}

export type GDriveCatalogReadPolicy = {
  configured: boolean
  syncScope: GDriveCatalogScope | null
  status: GDriveCatalogSyncStatus | null
  selectedFolders: GDriveCatalogFolder[]
  allowed: boolean
}

export type GDriveCatalogRuntimeScope = {
  configured: boolean
  syncScope: GDriveCatalogScope | null
  status: GDriveCatalogSyncStatus | null
  selectedFolders: GDriveCatalogFolder[]
}

export async function getGDriveCatalogRuntimeScope(input: {
  workspaceId: string
  connectorInstanceId: string
}): Promise<GDriveCatalogRuntimeScope> {
  const { rows } = await query<{
    sync_scope: GDriveCatalogScope
    status: GDriveCatalogSyncStatus
    selected_folders: GDriveCatalogFolder[]
  }>(
    `SELECT sync_scope, status, selected_folders
       FROM gdrive_catalog_syncs
      WHERE workspace_id = $1 AND connector_instance_id = $2`,
    [input.workspaceId, input.connectorInstanceId],
  )
  const row = rows[0]
  if (!row) return { configured: false, syncScope: null, status: null, selectedFolders: [] }
  return {
    configured: true,
    syncScope: row.sync_scope,
    status: row.status,
    selectedFolders: row.selected_folders,
  }
}

export async function getGDriveCatalogReadPolicy(input: {
  workspaceId: string
  connectorInstanceId: string
  externalFileId: string
}): Promise<GDriveCatalogReadPolicy> {
  const { rows } = await query<{
    sync_scope: GDriveCatalogScope
    status: GDriveCatalogSyncStatus
    selected_folders: GDriveCatalogFolder[]
    in_catalog: boolean
  }>(
    `SELECT s.sync_scope, s.status, s.selected_folders,
            EXISTS(
              SELECT 1 FROM gdrive_file_catalog c
               WHERE c.workspace_id = s.workspace_id
                 AND c.connector_instance_id = s.connector_instance_id
                 AND c.external_file_id = $3
                 AND c.active = true
            ) AS in_catalog
       FROM gdrive_catalog_syncs s
      WHERE s.workspace_id = $1 AND s.connector_instance_id = $2`,
    [input.workspaceId, input.connectorInstanceId, input.externalFileId],
  )
  const row = rows[0]
  if (!row) {
    return { configured: false, syncScope: null, status: null, selectedFolders: [], allowed: true }
  }
  const rootAllowed = row.selected_folders.some((folder) => folder.id === input.externalFileId)
  return {
    configured: true,
    syncScope: row.sync_scope,
    status: row.status,
    selectedFolders: row.selected_folders,
    allowed: row.sync_scope === 'entire_drive' || rootAllowed || row.in_catalog,
  }
}

export async function listGDriveCatalogFiles(input: {
  workspaceId: string
  connectorInstanceId: string
  query?: string
  folderId?: string
  limit?: number
}): Promise<Array<GDriveCatalogEntry>> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  const search = input.query?.trim() ?? ''
  const { rows } = await query<{
    external_file_id: string
    name: string
    mime_type: string
    source_version: string
    modified_time: Date | null
    size_bytes: number | null
    web_view_link: string | null
    parent_ids: string[]
    folder_path: string[]
    is_folder: boolean
  }>(
    `SELECT c.external_file_id, c.name, c.mime_type, c.source_version, c.modified_time,
            c.size_bytes::float8 AS size_bytes, c.web_view_link, c.parent_ids,
            c.folder_path, c.is_folder
       FROM gdrive_file_catalog c
       JOIN gdrive_catalog_syncs s
         ON s.workspace_id = c.workspace_id
        AND s.connector_instance_id = c.connector_instance_id
        AND c.active = true
      WHERE c.workspace_id = $1 AND c.connector_instance_id = $2
        AND ($3 = '' OR c.name ILIKE '%' || $3 || '%'
             OR array_to_string(c.folder_path, ' / ') ILIKE '%' || $3 || '%')
        AND ($4::text IS NULL OR $4 = ANY(c.parent_ids))
      ORDER BY c.is_folder DESC, c.modified_time DESC NULLS LAST, lower(c.name)
      LIMIT $5`,
    [input.workspaceId, input.connectorInstanceId, search, input.folderId ?? null, limit],
  )
  return rows.map((row) => ({
    externalFileId: row.external_file_id,
    name: row.name,
    mimeType: row.mime_type,
    sourceVersion: row.source_version,
    modifiedTime: row.modified_time?.toISOString() ?? null,
    sizeBytes: row.size_bytes,
    webViewLink: row.web_view_link,
    parentIds: row.parent_ids,
    folderPath: row.folder_path,
    isFolder: row.is_folder,
  }))
}

export { GDriveEnrichmentImportAuthError as GDriveCatalogAuthError }
