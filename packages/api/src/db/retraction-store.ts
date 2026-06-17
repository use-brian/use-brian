/**
 * `retraction-store.ts` — company-brain corrections D.3 / D.5.
 *
 * DB adapters fulfilling the `MemoryRetractionRepository` +
 * `EpisodeReExtractionRepository` ports declared by the pure
 * orchestration in `packages/core/src/corrections/retraction.ts`.
 * `retractMemory` / `purgeMemory` / `findRetractedMatch` /
 * `reExtractEpisode` inject these ports; this file is the only place
 * SQL touches `memories` (for retraction) and the episode-derived rows
 * (for re-extraction supersession).
 *
 * Access model: system-level operator state. The caller is the admin
 * corrections route (`X-Admin-Key`-gated). Every primitive table
 * carries a `system_bypass` RLS policy (memories: migration 015;
 * episodes: 129; entity_links: 126; entities: 125), so the bare pool /
 * `SET LOCAL app.system_bypass` path is correct — same posture as
 * `entity-merge-store.ts`.
 *
 * `semanticHash` is sourced from `memories.content_hash` (migration
 * 138) — the sha256 content hash doubles as the re-extraction guard's
 * dedup key.
 *
 * [COMP:corrections/retraction-store]
 */

import { randomUUID } from 'node:crypto'
import type {
  EpisodeDerivationSnapshot,
  EpisodeReExtractionRepository,
  MemoryRetractionRepository,
  MemoryRetractionSnapshot,
} from '@sidanclaw/core'
import { getPool, query } from './client.js'

// ── Memory retraction ────────────────────────────────────────────────

type MemoryRetractionRow = {
  id: string
  workspaceId: string
  retractedAt: Date | null
  validTo: Date | null
  sourceEpisodeId: string | null
  semanticHash: string | null
  createdByUserId: string | null
}

const MEMORY_SNAPSHOT_COLS = `
  id,
  workspace_id       AS "workspaceId",
  retracted_at       AS "retractedAt",
  valid_to           AS "validTo",
  source_episode_id  AS "sourceEpisodeId",
  content_hash       AS "semanticHash",
  created_by_user_id AS "createdByUserId"
`

function toMemorySnapshot(row: MemoryRetractionRow): MemoryRetractionSnapshot {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    retractedAt: row.retractedAt,
    validTo: row.validTo,
    sourceEpisodeId: row.sourceEpisodeId,
    semanticHash: row.semanticHash,
    createdByUserId: row.createdByUserId,
  }
}

export function createMemoryRetractionStore(): MemoryRetractionRepository {
  return {
    async readMemoryForRetraction(workspaceId, memoryId) {
      const result = await query<MemoryRetractionRow>(
        `SELECT ${MEMORY_SNAPSHOT_COLS}
           FROM memories
          WHERE id = $1 AND workspace_id = $2`,
        [memoryId, workspaceId],
      )
      const row = result.rows[0]
      return row ? toMemorySnapshot(row) : null
    },

    async applySoftRetract(input) {
      // D.3 — retraction stamps `retracted_at` ("was never correct")
      // alongside `valid_to`. A row already superseded keeps its earlier
      // `valid_to`; an active row gets `valid_to = now()`.
      await query(
        `UPDATE memories
            SET retracted_at     = $3,
                retracted_reason = $4,
                retracted_by     = $5,
                valid_to         = COALESCE(valid_to, $3)
          WHERE id = $1 AND workspace_id = $2`,
        [input.memoryId, input.workspaceId, input.now, input.reason, input.retractedBy],
      )
    },

    async applyHardPurge(input) {
      // The row is about to vanish — record its existence in
      // `correction_audit` (D.7) inside the same transaction as the
      // DELETE so the audit can never be lost to a mid-purge crash.
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO correction_audit
             (workspace_id, action, primitive, row_id, actor_user_id, reason, row_snapshot)
           VALUES ($1, 'purge', 'memory', $2, $3, $4, $5::jsonb)`,
          [
            input.workspaceId,
            input.memoryId,
            input.actorUserId,
            input.reason,
            JSON.stringify(input.snapshot),
          ],
        )
        await client.query(
          `DELETE FROM memories WHERE id = $1 AND workspace_id = $2`,
          [input.memoryId, input.workspaceId],
        )
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async findRetractedMatch(args) {
      // D.3 re-extraction guard — a retracted memory for the same
      // source episode + content hash means the candidate must not be
      // re-derived. A non-null result tells Pipeline B to suppress.
      const result = await query<MemoryRetractionRow>(
        `SELECT ${MEMORY_SNAPSHOT_COLS}
           FROM memories
          WHERE workspace_id = $1
            AND source_episode_id = $2
            AND content_hash = $3
            AND retracted_at IS NOT NULL
          LIMIT 1`,
        [args.workspaceId, args.sourceEpisodeId, args.semanticHash],
      )
      const row = result.rows[0]
      return row ? toMemorySnapshot(row) : null
    },
  }
}

// ── Episode re-extraction (D.5) ──────────────────────────────────────

/**
 * Extraction-derived primitives an Episode can produce. `entity_link`
 * is included — `entity_links` carries the universal column set
 * (migration 126), so edge supersession is expressible.
 */
const DERIVATION_TABLES: Record<EpisodeDerivationSnapshot['primitive'], string> = {
  memory: 'memories',
  task: 'tasks',
  entity_link: 'entity_links',
  entity: 'entities',
}

export function createEpisodeReExtractionStore(): EpisodeReExtractionRepository {
  return {
    async readEpisodeForReExtraction(workspaceId, episodeId) {
      const result = await query<{ id: string; workspaceId: string }>(
        `SELECT id, workspace_id AS "workspaceId"
           FROM episodes
          WHERE id = $1 AND workspace_id = $2`,
        [episodeId, workspaceId],
      )
      return result.rows[0] ?? null
    },

    async snapshotDerivations(workspaceId, episodeId) {
      // Currently-live derivations across the four derived primitives.
      // Already-superseded rows are skipped — re-extraction only
      // re-supersedes what is still active.
      const out: EpisodeDerivationSnapshot[] = []
      for (const primitive of Object.keys(
        DERIVATION_TABLES,
      ) as EpisodeDerivationSnapshot['primitive'][]) {
        const result = await query<{ rowId: string; validTo: Date | null }>(
          `SELECT id AS "rowId", valid_to AS "validTo"
             FROM ${DERIVATION_TABLES[primitive]}
            WHERE workspace_id = $1 AND source_episode_id = $2 AND valid_to IS NULL`,
          [workspaceId, episodeId],
        )
        for (const r of result.rows) {
          out.push({ primitive, rowId: r.rowId, validTo: r.validTo })
        }
      }
      return out
    },

    async supersedeDerivations(input) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')

        let supersededCount = 0
        for (const d of input.derivations) {
          const table = DERIVATION_TABLES[d.primitive]
          if (!table) continue
          const res = await client.query(
            `UPDATE ${table}
                SET valid_to = $3
              WHERE id = $1 AND workspace_id = $2 AND valid_to IS NULL`,
            [d.rowId, input.workspaceId, input.now],
          )
          supersededCount += res.rowCount ?? 0
        }

        await client.query(
          `INSERT INTO correction_audit
             (workspace_id, action, primitive, row_id, actor_user_id, reason,
              ticket_reference, detail)
           VALUES ($1, 're_extract', 'episode', $2, $3, $4, $5, $6::jsonb)`,
          [
            input.workspaceId,
            input.episodeId,
            input.operatorUserId,
            input.reason,
            input.ticketReference,
            JSON.stringify({
              supersededCount,
              derivationsSnapshotted: input.derivations.length,
            }),
          ],
        )

        await client.query('COMMIT')
        return { supersededCount }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async triggerExtraction(input) {
      // Enqueue a re-extraction job for the Pipeline B outbox worker
      // (`extraction_outbox`, migration 142). The `content_hash` is a
      // fresh per-call value — a repeat re-extraction is a new job, not
      // an idempotency-key no-op.
      await query(
        `INSERT INTO extraction_outbox
           (workspace_id, episode_id, derivation_kind, content_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (episode_id, derivation_kind, content_hash) DO NOTHING`,
        [input.workspaceId, input.episodeId, 're_extract', `re_extract:${randomUUID()}`],
      )
    },
  }
}
