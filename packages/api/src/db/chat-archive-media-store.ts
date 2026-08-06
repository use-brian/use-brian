/** Durable asset + leased extraction-job store for chat archive media. */

import type pg from 'pg'
import { getPool } from './client.js'

export type ChatArchiveMediaKind = 'image' | 'video' | 'voice' | 'file'
export type ChatArchiveUploadStatus = 'uploading' | 'uploaded' | 'stored' | 'failed'
export type ChatArchiveExtractionStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'unsupported'

export type ChatArchiveMediaAsset = {
  id: string
  workspaceId: string
  instanceId: string
  ownerUserId: string
  messageId: string | null
  source: string
  providerMessageId: string
  kind: ChatArchiveMediaKind
  filename: string
  mime: string
  sizeBytes: number
  expectedSha256: string | null
  sha256: string | null
  storageKey: string
  storageUri: string
  uploadStatus: ChatArchiveUploadStatus
  extractionStatus: ChatArchiveExtractionStatus
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

export type ChatArchiveMediaJob = {
  id: string
  asset: ChatArchiveMediaAsset
  attemptCount: number
}

export type DerivedMediaSegment = {
  text: string
  metadata: Record<string, unknown>
}

export type ChatArchiveMediaDeletion = {
  id: string
  workspaceId: string
  storageKey: string
  storageUri: string
  attemptCount: number
}

const ASSET_COLS = `
  id,
  workspace_id        AS "workspaceId",
  instance_id         AS "instanceId",
  owner_user_id       AS "ownerUserId",
  message_id          AS "messageId",
  source,
  provider_message_id AS "providerMessageId",
  kind,
  filename,
  mime,
  size_bytes          AS "sizeBytes",
  expected_sha256     AS "expectedSha256",
  sha256,
  storage_key         AS "storageKey",
  storage_uri         AS "storageUri",
  upload_status       AS "uploadStatus",
  extraction_status   AS "extractionStatus",
  last_error          AS "lastError",
  created_at          AS "createdAt",
  updated_at          AS "updatedAt"`

function assetFromRow(row: Record<string, unknown>): ChatArchiveMediaAsset {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    instanceId: String(row.instanceId),
    ownerUserId: String(row.ownerUserId),
    messageId: row.messageId ? String(row.messageId) : null,
    source: String(row.source),
    providerMessageId: String(row.providerMessageId),
    kind: row.kind as ChatArchiveMediaKind,
    filename: String(row.filename ?? ''),
    mime: String(row.mime ?? 'application/octet-stream'),
    sizeBytes: Number(row.sizeBytes ?? 0),
    expectedSha256: row.expectedSha256 ? String(row.expectedSha256) : null,
    sha256: row.sha256 ? String(row.sha256) : null,
    storageKey: String(row.storageKey),
    storageUri: String(row.storageUri),
    uploadStatus: row.uploadStatus as ChatArchiveUploadStatus,
    extractionStatus: row.extractionStatus as ChatArchiveExtractionStatus,
    lastError: row.lastError ? String(row.lastError) : null,
    createdAt: new Date(row.createdAt as string | Date),
    updatedAt: new Date(row.updatedAt as string | Date),
  }
}

export type ChatArchiveMediaStore = ReturnType<typeof createChatArchiveMediaStore>

export function createChatArchiveMediaStore(pool: pg.Pool = getPool()) {
  return {
    async ensureBinding(input: {
      workspaceId: string
      ownerUserId: string
      source: string
      instanceId?: string | null
    }): Promise<string | null> {
      if (input.instanceId) {
        const supplied = await pool.query<{ found: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM connector_instance
              WHERE id = $1::uuid AND provider = $2
                AND ((scope = 'workspace' AND workspace_id = $3::uuid)
                  OR ingest_workspace_id = $3::uuid
                  OR (scope = 'user' AND user_id = $4::uuid))
           ) AS found`,
          [input.instanceId, input.source, input.workspaceId, input.ownerUserId],
        )
        if (supplied.rows[0]?.found) return input.instanceId
      }
      const existing = await pool.query<{ id: string }>(
        `SELECT id::text FROM connector_instance
          WHERE provider = $1
            AND ((scope = 'workspace' AND workspace_id = $2)
              OR ingest_workspace_id = $2
              OR (scope = 'user' AND user_id = $3))
          ORDER BY (config->>'managedBy' = 'local_chat_archive') ASC,
                   connected DESC, created_at ASC LIMIT 1`,
        [input.source, input.workspaceId, input.ownerUserId],
      )
      if (existing.rows[0]) return existing.rows[0].id
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO connector_instance
           (scope, user_id, workspace_id, provider, label, custom,
            credentials_type, config, sensitivity, connected,
            ingestion_enabled, created_by)
         VALUES ('workspace', NULL, $1, $2, $3, false, 'none',
                 '{"managedBy":"local_chat_archive"}'::jsonb,
                 'internal', true, false, $4)
         ON CONFLICT DO NOTHING
         RETURNING id::text`,
        [input.workspaceId, input.source, `${input.source} chat archive`, input.ownerUserId],
      )
      if (inserted.rows[0]) return inserted.rows[0].id
      const raced = await pool.query<{ id: string }>(
        `SELECT id::text FROM connector_instance
          WHERE scope = 'workspace' AND workspace_id = $1 AND provider = $2
            AND config->>'managedBy' = 'local_chat_archive'
          LIMIT 1`,
        [input.workspaceId, input.source],
      )
      return raced.rows[0]?.id ?? null
    },

    async bindingExists(input: {
      instanceId: string
      source: string
      workspaceId: string
      ownerUserId: string
    }): Promise<boolean> {
      const result = await pool.query<{ found: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM connector_instance
            WHERE id = $1::uuid AND provider = $2
              AND (
                (scope = 'workspace' AND workspace_id = $3::uuid)
                OR ingest_workspace_id = $3::uuid
                OR (scope = 'user' AND user_id = $4::uuid)
              )
         ) AS found`,
        [input.instanceId, input.source, input.workspaceId, input.ownerUserId],
      )
      return result.rows[0]?.found === true
    },

    async get(id: string): Promise<ChatArchiveMediaAsset | null> {
      const result = await pool.query(`SELECT ${ASSET_COLS} FROM chat_archive_media_assets WHERE id = $1`, [id])
      return result.rows[0] ? assetFromRow(result.rows[0] as Record<string, unknown>) : null
    },

    async getByProvider(input: { instanceId: string; providerMessageId: string }): Promise<ChatArchiveMediaAsset | null> {
      const result = await pool.query(
        `SELECT ${ASSET_COLS} FROM chat_archive_media_assets
          WHERE instance_id = $1 AND provider_message_id = $2`,
        [input.instanceId, input.providerMessageId],
      )
      return result.rows[0] ? assetFromRow(result.rows[0] as Record<string, unknown>) : null
    },

    async upsertUploading(input: {
      id: string
      workspaceId: string
      instanceId: string
      ownerUserId: string
      source: string
      providerMessageId: string
      kind: ChatArchiveMediaKind
      filename: string
      mime: string
      sizeBytes: number
      expectedSha256?: string | null
      storageKey: string
      storageUri: string
    }): Promise<ChatArchiveMediaAsset> {
      const result = await pool.query(
        `INSERT INTO chat_archive_media_assets (
           id, workspace_id, instance_id, owner_user_id, source,
           provider_message_id, kind, filename, mime, size_bytes,
           expected_sha256, storage_key, storage_uri,
           upload_status, extraction_status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'uploading','pending')
         ON CONFLICT (instance_id, provider_message_id) DO UPDATE SET
           filename = EXCLUDED.filename,
           mime = EXCLUDED.mime,
           size_bytes = EXCLUDED.size_bytes,
           expected_sha256 = EXCLUDED.expected_sha256,
           upload_status = CASE
             WHEN chat_archive_media_assets.upload_status = 'stored'
              AND (EXCLUDED.expected_sha256 IS NULL OR chat_archive_media_assets.sha256 = EXCLUDED.expected_sha256)
             THEN 'stored' ELSE 'uploading' END,
           extraction_status = CASE
             WHEN chat_archive_media_assets.upload_status = 'stored'
              AND (EXCLUDED.expected_sha256 IS NULL OR chat_archive_media_assets.sha256 = EXCLUDED.expected_sha256)
             THEN chat_archive_media_assets.extraction_status ELSE 'pending' END,
           last_error = NULL,
           updated_at = now()
         RETURNING ${ASSET_COLS}`,
        [
          input.id, input.workspaceId, input.instanceId, input.ownerUserId, input.source,
          input.providerMessageId, input.kind, input.filename, input.mime, input.sizeBytes,
          input.expectedSha256 ?? null, input.storageKey, input.storageUri,
        ],
      )
      return assetFromRow(result.rows[0] as Record<string, unknown>)
    },

    async markUploaded(id: string, sha256: string, sizeBytes: number): Promise<ChatArchiveMediaAsset> {
      const result = await pool.query(
        `UPDATE chat_archive_media_assets
            SET sha256 = $2, size_bytes = $3, upload_status = 'uploaded',
                extraction_status = 'pending', last_error = NULL, updated_at = now()
          WHERE id = $1
          RETURNING ${ASSET_COLS}`,
        [id, sha256, sizeBytes],
      )
      if (!result.rows[0]) throw new Error('chat archive media asset not found')
      return assetFromRow(result.rows[0] as Record<string, unknown>)
    },

    async markUploadFailed(id: string, error: string): Promise<void> {
      await pool.query(
        `UPDATE chat_archive_media_assets
            SET upload_status = 'failed', extraction_status = 'failed',
                last_error = $2, updated_at = now()
          WHERE id = $1`,
        [id, error.slice(0, 2000)],
      )
    },

    async completeUpload(id: string): Promise<ChatArchiveMediaAsset> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const current = await client.query(
          `SELECT ${ASSET_COLS} FROM chat_archive_media_assets WHERE id = $1 FOR UPDATE`,
          [id],
        )
        if (!current.rows[0]) throw new Error('chat archive media asset not found')
        const asset = assetFromRow(current.rows[0] as Record<string, unknown>)
        if (asset.uploadStatus !== 'uploaded' && asset.uploadStatus !== 'stored') {
          throw new Error(`chat archive media upload is ${asset.uploadStatus}`)
        }
        if (!asset.sha256) throw new Error('chat archive media upload has no fingerprint')
        if (asset.expectedSha256 && asset.expectedSha256 !== asset.sha256) {
          await client.query(
            `UPDATE chat_archive_media_assets
                SET upload_status = 'failed', extraction_status = 'failed',
                    last_error = 'uploaded SHA-256 did not match expected fingerprint', updated_at = now()
              WHERE id = $1`,
            [id],
          )
          await client.query('COMMIT')
          throw new Error('uploaded SHA-256 did not match expected fingerprint')
        }
        if (asset.uploadStatus === 'stored' && asset.extractionStatus !== 'pending') {
          await client.query('COMMIT')
          return asset
        }
        await client.query(
          `UPDATE chat_archive_media_assets
              SET upload_status = 'stored', last_error = NULL, updated_at = now()
            WHERE id = $1`,
          [id],
        )
        await client.query(
          `INSERT INTO chat_archive_media_jobs (asset_id, status)
           VALUES ($1, 'pending')
           ON CONFLICT (asset_id) DO UPDATE SET
             status = 'pending',
             next_attempt_at = now(), locked_until = NULL, last_error = NULL, updated_at = now()`,
          [id],
        )
        const updated = await client.query(`SELECT ${ASSET_COLS} FROM chat_archive_media_assets WHERE id = $1`, [id])
        await client.query('COMMIT')
        return assetFromRow(updated.rows[0] as Record<string, unknown>)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async claimNext(): Promise<ChatArchiveMediaJob | null> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE chat_archive_media_jobs
              SET status = 'failed', next_attempt_at = now(), locked_until = NULL,
                  last_error = 'lease expired', updated_at = now()
            WHERE status = 'processing' AND locked_until < now()`,
        )
        const claimed = await client.query<{ id: string; assetId: string; attemptCount: number }>(
          `SELECT j.id, j.asset_id AS "assetId", j.attempt_count AS "attemptCount"
             FROM chat_archive_media_jobs j
             JOIN chat_archive_media_assets a ON a.id = j.asset_id
            WHERE j.status IN ('pending','failed') AND j.next_attempt_at <= now()
              AND a.message_id IS NOT NULL AND a.upload_status = 'stored'
            ORDER BY j.next_attempt_at, j.created_at
            FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
        )
        const row = claimed.rows[0]
        if (!row) {
          await client.query('COMMIT')
          return null
        }
        const updated = await client.query<{ attemptCount: number }>(
          `UPDATE chat_archive_media_jobs
              SET status = 'processing', attempt_count = attempt_count + 1,
                  locked_until = now() + interval '15 minutes', updated_at = now()
            WHERE id = $1 RETURNING attempt_count AS "attemptCount"`,
          [row.id],
        )
        await client.query(
          `UPDATE chat_archive_media_assets
              SET extraction_status = 'processing', last_error = NULL, updated_at = now()
            WHERE id = $1`,
          [row.assetId],
        )
        const assetRow = await client.query(`SELECT ${ASSET_COLS} FROM chat_archive_media_assets WHERE id = $1`, [row.assetId])
        await client.query('COMMIT')
        if (!assetRow.rows[0]) return null
        return { id: row.id, asset: assetFromRow(assetRow.rows[0] as Record<string, unknown>), attemptCount: updated.rows[0]!.attemptCount }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async replaceDerivedSegments(asset: ChatArchiveMediaAsset, segments: DerivedMediaSegment[]): Promise<void> {
      if (!asset.messageId) throw new Error('chat archive media asset is not linked to a message')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `DELETE FROM chat_archive_segments WHERE message_id = $1 AND segment_index > 0`,
          [asset.messageId],
        )
        let index = 1
        for (const segment of segments) {
          const text = segment.text.trim()
          if (!text) continue
          await client.query(
            `INSERT INTO chat_archive_segments (
               workspace_id, message_id, instance_id, conversation_id,
               segment_index, segment_text, user_id, assistant_id,
               source, sensitivity, metadata, valid_from, created_by_user_id
             )
             SELECT m.workspace_id, m.id, m.instance_id, m.conversation_id,
                    $2, $3, m.owner_user_id, NULL,
                    'chat_archive_media', 'internal', $4::jsonb, m.sent_at, m.owner_user_id
               FROM chat_archive_messages m WHERE m.id = $1
             ON CONFLICT (message_id, segment_index) DO UPDATE SET
               segment_text = EXCLUDED.segment_text,
               metadata = EXCLUDED.metadata,
               embedding = NULL, embedding_model_id = NULL, content_hash = NULL,
               embedding_failed_at = NULL, embedding_failure_reason = NULL,
               embedding_updated_at = NULL`,
            [asset.messageId, index, text, JSON.stringify({ asset_id: asset.id, ...segment.metadata })],
          )
          index += 1
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async completeJob(jobId: string, assetId: string): Promise<void> {
      await pool.query(
        `WITH job AS (
           UPDATE chat_archive_media_jobs
              SET status = 'completed', locked_until = NULL, last_error = NULL,
                  completed_at = now(), updated_at = now()
            WHERE id = $1 RETURNING asset_id
         )
         UPDATE chat_archive_media_assets
            SET extraction_status = 'ready', last_error = NULL, updated_at = now()
          WHERE id = $2 AND EXISTS (SELECT 1 FROM job WHERE asset_id = $2)`,
        [jobId, assetId],
      )
    },

    async unsupportedJob(jobId: string, assetId: string, reason: string): Promise<void> {
      await pool.query(
        `WITH job AS (
           UPDATE chat_archive_media_jobs
              SET status = 'unsupported', locked_until = NULL, last_error = $3,
                  completed_at = now(), updated_at = now()
            WHERE id = $1 RETURNING asset_id
         )
         UPDATE chat_archive_media_assets
            SET extraction_status = 'unsupported', last_error = $3, updated_at = now()
          WHERE id = $2 AND EXISTS (SELECT 1 FROM job WHERE asset_id = $2)`,
        [jobId, assetId, reason.slice(0, 2000)],
      )
    },

    async failJob(jobId: string, assetId: string, attemptCount: number, error: string): Promise<void> {
      const dead = attemptCount >= 5
      const delay = Math.min(2 ** Math.max(1, attemptCount) * 15, 3600)
      await pool.query(
        `WITH job AS (
           UPDATE chat_archive_media_jobs
              SET status = $4, locked_until = NULL, last_error = $3,
                  next_attempt_at = now() + ($5 * interval '1 second'), updated_at = now()
            WHERE id = $1 RETURNING asset_id
         )
         UPDATE chat_archive_media_assets
            SET extraction_status = CASE WHEN $4 = 'dead' THEN 'failed' ELSE 'pending' END,
                last_error = $3, updated_at = now()
          WHERE id = $2 AND EXISTS (SELECT 1 FROM job WHERE asset_id = $2)`,
        [jobId, assetId, error.slice(0, 2000), dead ? 'dead' : 'failed', delay],
      )
    },

    async listUnlinkedBefore(before: Date, limit = 100): Promise<ChatArchiveMediaAsset[]> {
      const result = await pool.query(
        `SELECT ${ASSET_COLS} FROM chat_archive_media_assets
          WHERE message_id IS NULL AND created_at < $1
          ORDER BY created_at LIMIT $2`,
        [before, limit],
      )
      return result.rows.map((row) => assetFromRow(row as Record<string, unknown>))
    },

    async remove(id: string): Promise<void> {
      await pool.query(`DELETE FROM chat_archive_media_assets WHERE id = $1`, [id])
    },

    async listDeletions(limit = 100): Promise<ChatArchiveMediaDeletion[]> {
      const result = await pool.query(
        `SELECT id::text, workspace_id::text AS "workspaceId",
                storage_key AS "storageKey", storage_uri AS "storageUri",
                attempt_count AS "attemptCount"
           FROM chat_archive_media_deletions
          WHERE next_attempt_at <= now()
          ORDER BY next_attempt_at, created_at LIMIT $1`,
        [limit],
      )
      return result.rows as ChatArchiveMediaDeletion[]
    },

    async completeDeletion(id: string): Promise<void> {
      await pool.query(`DELETE FROM chat_archive_media_deletions WHERE id = $1`, [id])
    },

    async failDeletion(id: string, attemptCount: number, error: string): Promise<void> {
      const delay = Math.min(2 ** Math.max(1, attemptCount + 1) * 15, 3600)
      await pool.query(
        `UPDATE chat_archive_media_deletions
            SET attempt_count = attempt_count + 1, last_error = $2,
                next_attempt_at = now() + ($3 * interval '1 second')
          WHERE id = $1`,
        [id, error.slice(0, 2000), delay],
      )
    },
  }
}
