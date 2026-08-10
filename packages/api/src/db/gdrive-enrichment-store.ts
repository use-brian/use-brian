/**
 * Version-idempotent queue/ledger for progressive Google Drive enrichment.
 *
 * System queue operations use the owner pool. Offline imports additionally
 * prove workspace-admin authority and exact Drive-instance ownership at the
 * boundary before inserting. The worker clears the pre-filled JSON after it
 * has materialized the durable workspace-file artifact.
 *
 * [COMP:integrations/gdrive-enrichment]
 */

import { query } from './client.js'
import type { GDriveOfflineEnrichmentEntry } from '../google/enrichment-bundle.js'

export type GDriveEnrichmentMode = 'lazy_fetch' | 'offline_bundle'
export type GDriveEnrichmentStatus = 'pending' | 'processing' | 'done' | 'failed' | 'superseded'

export type GDriveEnrichmentJob = {
  id: string
  workspaceId: string
  connectorInstanceId: string
  actingUserId: string
  assistantId: string | null
  externalFileId: string
  sourceVersion: string
  fileName: string
  mimeType: string
  modifiedTime: Date | null
  webViewLink: string | null
  mode: GDriveEnrichmentMode
  status: GDriveEnrichmentStatus
  prefilledPayload: GDriveOfflineEnrichmentEntry | null
  artifactFileId: string | null
  sourceEpisodeId: string | null
  attempts: number
  lastError: string | null
}

export type GDriveEnrichmentStatusSummary = {
  pending: number
  processing: number
  done: number
  failed: number
  superseded: number
  total: number
  lastUpdatedAt: string | null
}

export const GDRIVE_ENRICHMENT_MAX_ATTEMPTS = 3

const RETURNING = `
  id,
  workspace_id          AS "workspaceId",
  connector_instance_id AS "connectorInstanceId",
  acting_user_id        AS "actingUserId",
  assistant_id          AS "assistantId",
  external_file_id      AS "externalFileId",
  source_version        AS "sourceVersion",
  file_name             AS "fileName",
  mime_type             AS "mimeType",
  modified_time         AS "modifiedTime",
  web_view_link         AS "webViewLink",
  mode,
  status,
  prefilled_payload     AS "prefilledPayload",
  artifact_file_id      AS "artifactFileId",
  source_episode_id     AS "sourceEpisodeId",
  attempts,
  last_error            AS "lastError"
`

export async function enqueueGDriveLazyEnrichment(input: {
  workspaceId: string
  connectorInstanceId: string
  actingUserId: string
  assistantId?: string | null
  externalFileId: string
  sourceVersion: string
  fileName: string
  mimeType: string
  modifiedTime?: string | null
  webViewLink?: string | null
}): Promise<{ enqueued: boolean; jobId: string | null }> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO gdrive_file_enrichments
       (workspace_id, connector_instance_id, acting_user_id, assistant_id,
        external_file_id, source_version, file_name, mime_type, modified_time,
        web_view_link, mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'lazy_fetch')
     ON CONFLICT (workspace_id, connector_instance_id, external_file_id, source_version)
       DO UPDATE SET
         acting_user_id = EXCLUDED.acting_user_id,
         assistant_id = EXCLUDED.assistant_id,
         file_name = EXCLUDED.file_name,
         mime_type = EXCLUDED.mime_type,
         modified_time = EXCLUDED.modified_time,
         web_view_link = EXCLUDED.web_view_link,
         mode = 'lazy_fetch',
         status = 'pending',
         prefilled_payload = NULL,
         attempts = 0,
         last_error = NULL,
         locked_at = NULL,
         updated_at = now()
       WHERE gdrive_file_enrichments.status = 'failed'
     RETURNING id`,
    [
      input.workspaceId,
      input.connectorInstanceId,
      input.actingUserId,
      input.assistantId ?? null,
      input.externalFileId,
      input.sourceVersion,
      input.fileName,
      input.mimeType,
      input.modifiedTime ?? null,
      input.webViewLink ?? null,
    ],
  )
  return rows[0] ? { enqueued: true, jobId: rows[0].id } : { enqueued: false, jobId: null }
}

/** Shared owner/admin + exact connected Drive-instance boundary. */
export async function assertGDriveWorkspaceAdminAuthority(input: {
  actingUserId: string
  workspaceId: string
  connectorInstanceId: string
}): Promise<void> {
  const { rows } = await query<{ role: string }>(
    `SELECT wm.role
       FROM workspace_members wm
       JOIN connector_instance ci
         ON ci.id = $3
        AND ci.provider = 'gdrive'
        AND ci.connected = true
        AND (
          (ci.scope = 'workspace' AND ci.workspace_id = wm.workspace_id)
          OR (
            ci.scope = 'user'
            AND EXISTS (
              SELECT 1 FROM connector_grant cg
               WHERE cg.connector_instance_id = ci.id
                 AND cg.target_type = 'workspace'
                 AND cg.target_id = wm.workspace_id
            )
          )
        )
      WHERE wm.workspace_id = $2
        AND wm.user_id = $1
        AND wm.role IN ('owner', 'admin')`,
    [input.actingUserId, input.workspaceId, input.connectorInstanceId],
  )
  if (!rows[0]) throw new GDriveEnrichmentImportAuthError()
}

export class GDriveEnrichmentImportAuthError extends Error {
  constructor() {
    super('Workspace owner/admin access to this connected Drive instance is required')
    this.name = 'GDriveEnrichmentImportAuthError'
  }
}

export async function enqueueGDriveOfflineEnrichment(input: {
  actingUserId: string
  workspaceId: string
  connectorInstanceId: string
  assistantId?: string | null
  files: GDriveOfflineEnrichmentEntry[]
}): Promise<{ accepted: number; skipped: number }> {
  await assertGDriveWorkspaceAdminAuthority(input)
  if (input.files.length === 0) return { accepted: 0, skipped: 0 }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO gdrive_file_enrichments
       (workspace_id, connector_instance_id, acting_user_id, assistant_id,
        external_file_id, source_version, file_name, mime_type, modified_time,
        web_view_link, mode, prefilled_payload)
     SELECT $1, $2, $3, $4,
            item->>'fileId', item->>'version', item->>'name', item->>'mimeType',
            NULLIF(item->>'modifiedTime', '')::timestamptz,
            NULLIF(item->>'webViewLink', ''),
            'offline_bundle', item
       FROM jsonb_array_elements($5::jsonb) AS item
      WHERE NOT EXISTS (
              SELECT 1 FROM gdrive_catalog_syncs s
               WHERE s.workspace_id = $1 AND s.connector_instance_id = $2
            )
         OR EXISTS (
              SELECT 1 FROM gdrive_catalog_syncs s
               WHERE s.workspace_id = $1 AND s.connector_instance_id = $2
                 AND (
                   s.sync_scope = 'entire_drive'
                   OR EXISTS (
                     SELECT 1 FROM gdrive_file_catalog c
                      WHERE c.workspace_id = s.workspace_id
                        AND c.connector_instance_id = s.connector_instance_id
                        AND c.external_file_id = item->>'fileId'
                        AND c.active = true
                   )
                 )
            )
     ON CONFLICT (workspace_id, connector_instance_id, external_file_id, source_version)
       DO UPDATE SET
         acting_user_id = EXCLUDED.acting_user_id,
         assistant_id = EXCLUDED.assistant_id,
         file_name = EXCLUDED.file_name,
         mime_type = EXCLUDED.mime_type,
         modified_time = EXCLUDED.modified_time,
         web_view_link = EXCLUDED.web_view_link,
         mode = 'offline_bundle',
         status = 'pending',
         prefilled_payload = EXCLUDED.prefilled_payload,
         attempts = 0,
         last_error = NULL,
         locked_at = NULL,
         updated_at = now()
       WHERE gdrive_file_enrichments.status = 'failed'
     RETURNING id`,
    [
      input.workspaceId,
      input.connectorInstanceId,
      input.actingUserId,
      input.assistantId ?? null,
      JSON.stringify(input.files),
    ],
  )
  return { accepted: rows.length, skipped: input.files.length - rows.length }
}

export async function claimNextGDriveEnrichment(): Promise<GDriveEnrichmentJob | null> {
  const { rows } = await query<GDriveEnrichmentJob>(
    `UPDATE gdrive_file_enrichments
        SET status = 'processing', attempts = attempts + 1,
            locked_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM gdrive_file_enrichments
         WHERE status = 'pending'
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING ${RETURNING}`,
  )
  return rows[0] ?? null
}

export async function markGDriveEnrichmentDone(input: {
  id: string
  artifactFileId: string
  sourceEpisodeId?: string | null
}): Promise<void> {
  await query(
    `UPDATE gdrive_file_enrichments
        SET status = 'done', artifact_file_id = $2, source_episode_id = $3,
            prefilled_payload = NULL, locked_at = NULL, last_error = NULL,
            updated_at = now()
      WHERE id = $1`,
    [input.id, input.artifactFileId, input.sourceEpisodeId ?? null],
  )
}

export async function markGDriveEnrichmentSuperseded(id: string): Promise<void> {
  await query(
    `UPDATE gdrive_file_enrichments
        SET status = 'superseded', prefilled_payload = NULL, locked_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [id],
  )
}

export async function markGDriveEnrichmentFailed(
  id: string,
  error: string,
): Promise<{ retrying: boolean }> {
  const { rows } = await query<{ attempts: number }>(
    `UPDATE gdrive_file_enrichments
        SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
            last_error = $3, locked_at = NULL, updated_at = now()
      WHERE id = $1
      RETURNING attempts`,
    [id, GDRIVE_ENRICHMENT_MAX_ATTEMPTS, error.slice(0, 2000)],
  )
  const attempts = rows[0]?.attempts ?? GDRIVE_ENRICHMENT_MAX_ATTEMPTS
  return { retrying: attempts < GDRIVE_ENRICHMENT_MAX_ATTEMPTS }
}

export async function getGDriveEnrichmentStatus(input: {
  actingUserId: string
  workspaceId: string
  connectorInstanceId: string
}): Promise<GDriveEnrichmentStatusSummary> {
  await assertGDriveWorkspaceAdminAuthority(input)
  const { rows } = await query<{
    status: GDriveEnrichmentStatus
    count: string
    last_updated_at: Date | null
  }>(
    `SELECT status, count(*)::text AS count, max(updated_at) AS last_updated_at
       FROM gdrive_file_enrichments
      WHERE workspace_id = $1 AND connector_instance_id = $2
      GROUP BY status`,
    [input.workspaceId, input.connectorInstanceId],
  )
  const summary: GDriveEnrichmentStatusSummary = {
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    superseded: 0,
    total: 0,
    lastUpdatedAt: null,
  }
  let last: Date | null = null
  for (const row of rows) {
    const count = Number(row.count)
    summary[row.status] = count
    summary.total += count
    if (row.last_updated_at && (!last || row.last_updated_at > last)) last = row.last_updated_at
  }
  summary.lastUpdatedAt = last?.toISOString() ?? null
  return summary
}
