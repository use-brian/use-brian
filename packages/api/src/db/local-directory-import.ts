/** Bulk reconciliation for read-only Local Directory file descriptors. */

import { query, queryWithRLS } from './client.js'
import type { LocalDirectoryFileDescriptor } from '../files/local-directory-import.js'

const CHUNK_SIZE = 500

type ExistingImportRow = {
  id: string
  relativePath: string
  fingerprint: string
  storageUri: string
  name: string
  mime: string
  sizeBytes: number | string
}

export type LocalDirectoryReconcileResult = {
  created: number
  updated: number
  unchanged: number
  retracted: number
  skipped: number
}

function chunks<T>(values: T[]): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += CHUNK_SIZE) {
    result.push(values.slice(offset, offset + CHUNK_SIZE))
  }
  return result
}

function metadata(connectorInstanceId: string, file: LocalDirectoryFileDescriptor): Record<string, unknown> {
  return {
    localDirectory: {
      connectorInstanceId,
      relativePath: file.relativePath,
      fingerprint: file.fingerprint,
      readOnly: true,
    },
  }
}

export async function reconcileLocalDirectoryFiles(input: {
  userId: string
  workspaceId: string
  connectorInstanceId: string
  files: LocalDirectoryFileDescriptor[]
}): Promise<LocalDirectoryReconcileResult> {
  const existingResult = await queryWithRLS<ExistingImportRow>(
    input.userId,
    `SELECT id,
            metadata->'localDirectory'->>'relativePath' AS "relativePath",
            metadata->'localDirectory'->>'fingerprint' AS fingerprint,
            storage_uri AS "storageUri", name, mime, size_bytes AS "sizeBytes"
       FROM workspace_files
      WHERE workspace_id = $1 AND valid_to IS NULL
        AND metadata->'localDirectory'->>'connectorInstanceId' = $2
        AND metadata->'localDirectory'->>'readOnly' = 'true'`,
    [input.workspaceId, input.connectorInstanceId],
  )
  const existingByRelative = new Map(existingResult.rows.map((row) => [row.relativePath, row]))
  const scannedPaths = new Set(input.files.map((file) => file.relativePath))
  const createCandidates: LocalDirectoryFileDescriptor[] = []
  const updateCandidates: Array<LocalDirectoryFileDescriptor & { id: string }> = []
  let unchanged = 0

  for (const file of input.files) {
    const current = existingByRelative.get(file.relativePath)
    if (!current) {
      createCandidates.push(file)
      continue
    }
    if (
      current.fingerprint !== file.fingerprint ||
      current.storageUri !== file.storageUri ||
      current.name !== file.name ||
      current.mime !== file.mime ||
      Number(current.sizeBytes) !== file.sizeBytes
    ) {
      updateCandidates.push({ ...file, id: current.id })
    } else {
      unchanged++
    }
  }

  let created = 0
  for (const batch of chunks(createCandidates)) {
    const rows = batch.map((file) => ({ ...file, metadata: metadata(input.connectorInstanceId, file) }))
    const result = await queryWithRLS(
      input.userId,
      `INSERT INTO workspace_files (
         workspace_id, path, parent_path, name, title, summary, mime, size_bytes,
         tags, related_ids, storage_uri, sensitivity, metadata, source,
         created_by_user_id, created_by_assistant_id
       )
       SELECT $1, x.brain_path, x.parent_path, x.name, x.title,
              'Read-only file from Local Directory: ' || x.relative_path,
              x.mime, x.size_bytes, ARRAY['local-directory', 'read-only']::text[],
              '{}'::uuid[], x.storage_uri, 'internal', x.metadata, 'user', $2, NULL
         FROM jsonb_to_recordset($3::jsonb) AS x(
           relative_path text, brain_path text, parent_path text, name text,
           title text, mime text, size_bytes bigint, storage_uri text, metadata jsonb
         )
       ON CONFLICT (workspace_id, path) WHERE valid_to IS NULL DO NOTHING`,
      [input.workspaceId, input.userId, JSON.stringify(rows.map((row) => ({
        relative_path: row.relativePath,
        brain_path: row.brainPath,
        parent_path: row.parentPath,
        name: row.name,
        title: row.title,
        mime: row.mime,
        size_bytes: row.sizeBytes,
        storage_uri: row.storageUri,
        metadata: row.metadata,
      })))],
    )
    created += result.rowCount ?? 0
  }

  let updated = 0
  for (const batch of chunks(updateCandidates)) {
    const rows = batch.map((file) => ({
      id: file.id,
      name: file.name,
      title: file.title,
      mime: file.mime,
      size_bytes: file.sizeBytes,
      storage_uri: file.storageUri,
      metadata: metadata(input.connectorInstanceId, file),
    }))
    const result = await queryWithRLS(
      input.userId,
      `UPDATE workspace_files AS wf
          SET name = x.name, title = x.title, mime = x.mime,
              size_bytes = x.size_bytes, storage_uri = x.storage_uri,
              metadata = x.metadata
         FROM jsonb_to_recordset($3::jsonb) AS x(
           id uuid, name text, title text, mime text, size_bytes bigint,
           storage_uri text, metadata jsonb
         )
        WHERE wf.id = x.id AND wf.workspace_id = $1 AND wf.valid_to IS NULL
          AND wf.metadata->'localDirectory'->>'connectorInstanceId' = $2`,
      [input.workspaceId, input.connectorInstanceId, JSON.stringify(rows)],
    )
    updated += result.rowCount ?? 0
  }

  const removedIds = existingResult.rows
    .filter((row) => !scannedPaths.has(row.relativePath))
    .map((row) => row.id)
  let retracted = 0
  const retractedIds: string[] = []
  for (const batch of chunks(removedIds)) {
    const result = await queryWithRLS<{ id: string }>(
      input.userId,
      `UPDATE workspace_files
          SET valid_to = now(), retracted_at = now(),
              retracted_reason = 'local_directory_source_missing', retracted_by = $2
        WHERE workspace_id = $1 AND id = ANY($3::uuid[]) AND valid_to IS NULL
          AND metadata->'localDirectory'->>'connectorInstanceId' = $4
        RETURNING id`,
      [input.workspaceId, input.userId, batch, input.connectorInstanceId],
    )
    retracted += result.rowCount ?? 0
    retractedIds.push(...result.rows.map((row) => row.id))
  }
  for (const batch of chunks(retractedIds)) {
    await query(
      `UPDATE file_segments SET valid_to = now()
        WHERE file_id = ANY($1::uuid[]) AND valid_to IS NULL`,
      [batch],
    )
  }

  return {
    created,
    updated,
    unchanged,
    retracted,
    skipped: createCandidates.length - created,
  }
}
