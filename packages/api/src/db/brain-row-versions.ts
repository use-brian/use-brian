/**
 * brain_row_versions — the brain-history version sidecar (migration 488).
 *
 * Every DESTRUCTIVE memory mutation captures its before-image here first
 * (`captureMemoryVersions`), plus one `turn_events` mutation row so the
 * ledger records who destroyed what and why. The adjust/supersede path is
 * deliberately NOT captured — `updateMemory` already preserves history
 * in-table (insert-new + tombstone via `valid_to`/`superseded_by`) — and
 * neither are pure signal counters or the operator erasure path
 * (`applyHardPurge`: erasure must not mint another content copy; its
 * `correction_audit` row is the tombstone the as-of resolver surfaces as
 * an explicit erased marker).
 *
 * As-of resolution (`resolveMemoryAsOf`) answers "what did row X look
 * like at time T" for the audit surface and replay evals. The
 * clearance-gated variant applies the D7 rule: time-travel applies to
 * DATA, never permissions — a row's historical versions are gated by its
 * CURRENT sensitivity (live row first, else the latest captured state),
 * or an as-of read becomes a clearance bypass after an upward
 * reclassification.
 *
 * Graded by `pnpm check` (`invariants/brain-mutation-versioning`).
 * Spec: docs/architecture/brain/brain-history.md
 * [COMP:api/brain-row-versions]
 */

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { getPool, query } from './client.js'
import { insertTurnEvent } from './turn-ledger-store.js'
import type { TurnLedgerActor } from '@use-brian/core'

export type CaptureOpts = {
  actor: TurnLedgerActor
  reason: string
  workspaceId?: string | null
  /** Pre-existing ledger event to link instead of emitting a new one. */
  mutationEventId?: string | null
}

export type MemoryAsOf =
  | { kind: 'version'; row: Record<string, unknown>; capturedAt: Date }
  | { kind: 'current'; row: Record<string, unknown> }
  | { kind: 'erased'; erasedAt: Date | null }
  | { kind: 'above_clearance' }
  | null

const CAPTURE_SQL = `
  INSERT INTO brain_row_versions
    (primitive, row_id, version_no, before_image, valid_from, valid_to,
     mutation_actor, mutation_reason, mutation_event_id, sensitivity, workspace_id)
  SELECT
    'memory',
    m.id,
    COALESCE((SELECT MAX(v.version_no) FROM brain_row_versions v
               WHERE v.primitive = 'memory' AND v.row_id = m.id), 0) + 1,
    to_jsonb(m) - 'embedding',
    COALESCE((SELECT MAX(v.valid_to) FROM brain_row_versions v
               WHERE v.primitive = 'memory' AND v.row_id = m.id), m.created_at),
    now(),
    $2,
    $3,
    $4,
    m.sensitivity,
    m.workspace_id
  FROM memories m
  WHERE m.id = ANY($1::uuid[])`

/**
 * Capture the current state of `ids` into the sidecar, emitting one
 * `turn_events` mutation row for the batch. Call BEFORE the destructive
 * statement, inside the same transaction when the caller holds one.
 * Returns the number of versions written (rows that no longer exist
 * capture nothing).
 */
export async function captureMemoryVersions(
  ids: string[],
  opts: CaptureOpts,
  transactionClient?: pg.PoolClient,
): Promise<number> {
  if (ids.length === 0) return 0
  let eventId = opts.mutationEventId ?? null
  if (!eventId) {
    // The ledger mutation row rides OUTSIDE the caller's transaction by
    // design (fire-and-forget lane; a rolled-back mutation leaving a
    // mutation event is noise, a committed mutation missing its event
    // because the ledger insert aborted the transaction would be worse).
    eventId = await insertTurnEvent({
      workspaceId: opts.workspaceId ?? null,
      assistantMessageId: `mutation-${randomUUID()}`,
      stepOrdinal: 0,
      actor: opts.actor,
      kind: 'mutation',
      metadata: { primitive: 'memory', reason: opts.reason, rowIds: ids },
      payloadRefs: [],
    }).catch((err) => {
      console.warn(
        `[brain-history] mutation event write failed (versions still captured): ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    })
  }
  const runner = transactionClient ?? getPool()
  const res = await runner.query(CAPTURE_SQL, [ids, opts.actor, opts.reason, eventId])
  return res.rowCount ?? 0
}

/** All captured versions for a row, newest first. */
export async function listMemoryVersions(rowId: string): Promise<
  Array<{ versionNo: number; validFrom: Date; validTo: Date; actor: string; reason: string; erased: boolean }>
> {
  const res = await query(
    `SELECT version_no, valid_from, valid_to, mutation_actor, mutation_reason, erased_at, before_image
       FROM brain_row_versions
      WHERE primitive = 'memory' AND row_id = $1
      ORDER BY version_no DESC`,
    [rowId],
  )
  return res.rows.map((r) => ({
    versionNo: r.version_no as number,
    validFrom: r.valid_from as Date,
    validTo: r.valid_to as Date,
    actor: r.mutation_actor as string,
    reason: r.mutation_reason as string,
    erased: r.erased_at != null || r.before_image == null,
  }))
}

/**
 * "What did memory `rowId` look like at time `at`?" — sidecar version
 * covering `at` first; else the live row (content changes always mint a
 * new row via supersession, so the live row's content is stable over its
 * lifetime — counters excepted, documented fidelity); else the erasure
 * tombstone (correction_audit purge row); else null (never existed /
 * before creation).
 */
export async function resolveMemoryAsOf(rowId: string, at: Date): Promise<MemoryAsOf> {
  const version = await query(
    `SELECT before_image, erased_at, valid_to FROM brain_row_versions
      WHERE primitive = 'memory' AND row_id = $1
        AND valid_from <= $2 AND valid_to > $2
      ORDER BY version_no ASC LIMIT 1`,
    [rowId, at],
  )
  const v = version.rows[0]
  if (v) {
    if (v.erased_at != null || v.before_image == null) {
      return { kind: 'erased', erasedAt: (v.erased_at as Date | null) ?? null }
    }
    return { kind: 'version', row: v.before_image as Record<string, unknown>, capturedAt: v.valid_to as Date }
  }
  const current = await query(
    `SELECT to_jsonb(m) - 'embedding' AS row, m.created_at FROM memories m WHERE m.id = $1`,
    [rowId],
  )
  const c = current.rows[0]
  if (c) {
    if ((c.created_at as Date) > at) return null
    return { kind: 'current', row: c.row as Record<string, unknown> }
  }
  const purge = await query(
    `SELECT created_at FROM correction_audit
      WHERE action = 'purge' AND primitive = 'memory' AND row_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [rowId],
  )
  if (purge.rows[0]) return { kind: 'erased', erasedAt: purge.rows[0].created_at as Date }
  return null
}

/** Mirrors the `sensitivity_rank` SQL helper (migration 065). */
const SENSITIVITY_RANK: Record<string, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
  restricted: 4,
}

/**
 * D7-gated as-of read. The gating classification is the row's CURRENT
 * one: the live row's sensitivity when it still exists, else the most
 * recently captured state's. A version whose stored sensitivity was
 * lower does NOT become readable again — time-travel applies to data,
 * never permissions.
 */
export async function resolveMemoryAsOfForClearance(
  rowId: string,
  at: Date,
  viewerClearance: string,
): Promise<MemoryAsOf> {
  const current = await query<{ sensitivity: string }>(
    `SELECT sensitivity FROM memories WHERE id = $1`,
    [rowId],
  )
  let effective = current.rows[0]?.sensitivity
  if (!effective) {
    const latest = await query<{ sensitivity: string }>(
      `SELECT sensitivity FROM brain_row_versions
        WHERE primitive = 'memory' AND row_id = $1
        ORDER BY version_no DESC LIMIT 1`,
      [rowId],
    )
    effective = latest.rows[0]?.sensitivity
  }
  if (effective) {
    const need = SENSITIVITY_RANK[effective] ?? SENSITIVITY_RANK.restricted
    const have = SENSITIVITY_RANK[viewerClearance] ?? 0
    if (have < need) return { kind: 'above_clearance' }
  }
  return resolveMemoryAsOf(rowId, at)
}

/**
 * Erasure cascade (plan §7): wipe the content copies a purged row left in
 * the sidecar. Keeps the rows as tombstones (explicit erased marker).
 */
export async function eraseMemoryVersions(rowId: string): Promise<number> {
  const res = await query(
    `UPDATE brain_row_versions
        SET before_image = NULL, erased_at = now()
      WHERE primitive = 'memory' AND row_id = $1 AND erased_at IS NULL`,
    [rowId],
  )
  return res.rowCount ?? 0
}
