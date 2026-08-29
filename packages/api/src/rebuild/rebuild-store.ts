/**
 * rebuild_runs / memories_shadow — DB access for retroactive rebuild
 * (migration 489).
 *
 * The status machine is the preflight-confirmation contract in table
 * form: `probed` (cheap estimate only) → `confirmed` (an explicit human
 * yes; deriveShadow refuses anything else) → `deriving` → `derived`
 * (diff available) → `promoted`. `failed`/`cancelled` are terminal.
 *
 * Promote is ONE transaction and is itself reversible: the live derived
 * rows are captured into brain_row_versions (actor `human_edit`, reason
 * `rebuild-promote`) before deletion, so rolling a bad promote back is
 * an as-of read away, and a mid-promote crash leaves the live brain
 * untouched. Only rows with `source_episode_id IS NOT NULL` are swapped —
 * direct-taught memories (saveMemory in chat, user edits) are not
 * re-derivable from episodes and never touched by a rebuild.
 *
 * Spec: docs/architecture/brain/retroactive-rebuild.md
 * [COMP:api/rebuild-store]
 */

import { getPool, query } from '../db/client.js'
import { captureMemoryVersions } from '../db/brain-row-versions.js'

export type RebuildRunStatus =
  | 'probed'
  | 'confirmed'
  | 'deriving'
  | 'derived'
  | 'promoted'
  | 'failed'
  | 'cancelled'

export type RebuildRun = {
  id: string
  workspaceId: string
  status: RebuildRunStatus
  targetPipelineVersion: number
  probe: Record<string, unknown>
  progress: Record<string, unknown>
  diff: Record<string, unknown> | null
  error: string | null
  confirmedAt: Date | null
  derivedAt: Date | null
  promotedAt: Date | null
  createdAt: Date
}

function mapRun(r: Record<string, unknown>): RebuildRun {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    status: r.status as RebuildRunStatus,
    targetPipelineVersion: r.target_pipeline_version as number,
    probe: (r.probe as Record<string, unknown>) ?? {},
    progress: (r.progress as Record<string, unknown>) ?? {},
    diff: (r.diff as Record<string, unknown> | null) ?? null,
    error: (r.error as string | null) ?? null,
    confirmedAt: (r.confirmed_at as Date | null) ?? null,
    derivedAt: (r.derived_at as Date | null) ?? null,
    promotedAt: (r.promoted_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

export async function createRebuildRun(params: {
  workspaceId: string
  targetPipelineVersion: number
  probe: Record<string, unknown>
  createdByUserId?: string
}): Promise<RebuildRun> {
  const res = await query(
    `INSERT INTO rebuild_runs (workspace_id, target_pipeline_version, probe, created_by_user_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [params.workspaceId, params.targetPipelineVersion, JSON.stringify(params.probe), params.createdByUserId ?? null],
  )
  return mapRun(res.rows[0])
}

export async function getRebuildRun(id: string): Promise<RebuildRun | null> {
  const res = await query(`SELECT * FROM rebuild_runs WHERE id = $1`, [id])
  return res.rows[0] ? mapRun(res.rows[0]) : null
}

/** probed → confirmed. Any other source state returns null (no silent re-confirm). */
export async function confirmRebuildRun(id: string): Promise<RebuildRun | null> {
  const res = await query(
    `UPDATE rebuild_runs SET status = 'confirmed', confirmed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'probed' RETURNING *`,
    [id],
  )
  return res.rows[0] ? mapRun(res.rows[0]) : null
}

export async function setRebuildStatus(
  id: string,
  from: RebuildRunStatus | RebuildRunStatus[],
  to: RebuildRunStatus,
  patch?: { progress?: Record<string, unknown>; diff?: Record<string, unknown>; error?: string },
): Promise<RebuildRun | null> {
  const fromList = Array.isArray(from) ? from : [from]
  const res = await query(
    `UPDATE rebuild_runs SET
        status = $3,
        progress = COALESCE($4, progress),
        diff = COALESCE($5, diff),
        error = COALESCE($6, error),
        derived_at = CASE WHEN $3 = 'derived' THEN now() ELSE derived_at END,
        updated_at = now()
      WHERE id = $1 AND status = ANY($2)
      RETURNING *`,
    [
      id,
      fromList,
      to,
      patch?.progress ? JSON.stringify(patch.progress) : null,
      patch?.diff ? JSON.stringify(patch.diff) : null,
      patch?.error ?? null,
    ],
  )
  return res.rows[0] ? mapRun(res.rows[0]) : null
}

export async function updateRebuildProgress(id: string, progress: Record<string, unknown>): Promise<void> {
  await query(`UPDATE rebuild_runs SET progress = $2, updated_at = now() WHERE id = $1`, [
    id,
    JSON.stringify(progress),
  ])
}

/**
 * Diff the shadow derivation against the live derived set: counts plus a
 * bounded sample of shadow rows for side-by-side review.
 */
export async function computeRebuildDiff(run: RebuildRun): Promise<Record<string, unknown>> {
  const shadow = await query<{ n: string }>(
    `SELECT count(*) AS n FROM memories_shadow WHERE rebuild_run_id = $1`,
    [run.id],
  )
  const live = await query<{ n: string }>(
    `SELECT count(*) AS n FROM memories WHERE workspace_id = $1 AND source_episode_id IS NOT NULL`,
    [run.workspaceId],
  )
  const sample = await query<{ id: string; summary: string }>(
    `SELECT id, summary FROM memories_shadow WHERE rebuild_run_id = $1 ORDER BY created_at ASC LIMIT 20`,
    [run.id],
  )
  return {
    shadowCount: Number(shadow.rows[0]?.n ?? 0),
    liveDerivedCount: Number(live.rows[0]?.n ?? 0),
    sample: sample.rows.map((r) => ({ id: r.id, summary: r.summary })),
  }
}

/**
 * The columns memories and memories_shadow share (everything except the
 * shadow-only run key). Derived from the catalog at promote time so a
 * later memories migration cannot silently desync the INSERT..SELECT —
 * a column the shadow table lacks simply takes its default on the moved
 * rows.
 */
async function sharedMemoryColumns(client: { query: (t: string, v?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }): Promise<string[]> {
  const res = await client.query(
    `SELECT a.column_name
       FROM information_schema.columns a
       JOIN information_schema.columns b
         ON b.table_name = 'memories_shadow' AND b.column_name = a.column_name
      WHERE a.table_name = 'memories'
      ORDER BY a.ordinal_position`,
  )
  return res.rows.map((r) => r.column_name as string).filter((c) => c !== 'rebuild_run_id')
}

/**
 * The atomic promote (plan §6): capture → delete live derived → move
 * shadow in → stamp promoted. One transaction; any failure rolls the
 * whole thing back and the live brain is untouched.
 */
export async function promoteRebuildRun(id: string): Promise<RebuildRun | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const runRes = await client.query(`SELECT * FROM rebuild_runs WHERE id = $1 FOR UPDATE`, [id])
    const run = runRes.rows[0] ? mapRun(runRes.rows[0]) : null
    if (!run || run.status !== 'derived') {
      await client.query('ROLLBACK')
      return null
    }

    const liveIds = await client.query<{ id: string }>(
      `SELECT id FROM memories WHERE workspace_id = $1 AND source_episode_id IS NOT NULL`,
      [run.workspaceId],
    )
    await captureMemoryVersions(
      liveIds.rows.map((r) => r.id),
      { actor: 'human_edit', reason: 'rebuild-promote', workspaceId: run.workspaceId },
      client,
    )
    await client.query(
      `DELETE FROM memories WHERE workspace_id = $1 AND source_episode_id IS NOT NULL`,
      [run.workspaceId],
    )

    const cols = await sharedMemoryColumns(client)
    const colList = cols.map((c) => `"${c}"`).join(', ')
    await client.query(
      `INSERT INTO memories (${colList})
       SELECT ${colList} FROM memories_shadow WHERE rebuild_run_id = $1`,
      [id],
    )
    await client.query(`DELETE FROM memories_shadow WHERE rebuild_run_id = $1`, [id])

    const done = await client.query(
      `UPDATE rebuild_runs SET status = 'promoted', promoted_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id],
    )
    await client.query('COMMIT')
    return mapRun(done.rows[0])
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** Cancel: drop the shadow rows, mark the run. Never touches live rows. */
export async function cancelRebuildRun(id: string): Promise<RebuildRun | null> {
  await query(`DELETE FROM memories_shadow WHERE rebuild_run_id = $1`, [id])
  return setRebuildStatus(id, ['probed', 'confirmed', 'deriving', 'derived'], 'cancelled')
}
