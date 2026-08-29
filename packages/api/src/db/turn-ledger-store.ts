/**
 * turn_events / turn_payloads / ledger_epoch — DB access for the turn
 * ledger (migration 486).
 *
 * Writes are system-level (`query`, no RLS GUC): recording happens under
 * the engine before any user-scoped connection state is relevant, and a
 * ledger write must never fail a turn — the memory_recall_events
 * precedent. Reads are gated at the route layer by workspace membership
 * (plan §7: hosted operator surfaces may read event metadata and payload
 * index rows; the payload GET path requires workspace-member auth and the
 * admin API simply has no payload-fetch route).
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 * [COMP:api/turn-ledger-store]
 */

import { query } from './client.js'

export type TurnEventKind =
  | 'provider_call'
  | 'tool_call'
  | 'retrieval'
  | 'confirmation'
  | 'approval'
  | 'mutation'

export type TurnEventInsert = {
  workspaceId?: string | null
  assistantId?: string | null
  sessionId?: string | null
  assistantMessageId: string
  stepOrdinal: number
  actor: string
  kind: TurnEventKind
  metadata: Record<string, unknown>
  payloadRefs: string[]
  sensitivity?: string
}

export type TurnEventRow = {
  id: string
  workspaceId: string | null
  assistantId: string | null
  sessionId: string | null
  assistantMessageId: string
  stepOrdinal: number
  actor: string
  kind: TurnEventKind
  metadata: Record<string, unknown>
  payloadRefs: string[]
  sensitivity: string
  createdAt: Date
}

export type TurnPayloadRow = {
  scope: string
  hash: string
  workspaceId: string | null
  byteSize: number
  mediaType: string
  storageRef: string
  sensitivity: string
  erasedAt: Date | null
}

export function payloadScope(workspaceId: string | null | undefined): string {
  return workspaceId ?? 'global'
}

export async function insertTurnEvent(e: TurnEventInsert): Promise<void> {
  await query(
    `INSERT INTO turn_events
       (workspace_id, assistant_id, session_id, assistant_message_id, step_ordinal, actor, kind, metadata, payload_refs, sensitivity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (assistant_message_id, step_ordinal) DO NOTHING`,
    [
      e.workspaceId ?? null,
      e.assistantId ?? null,
      e.sessionId ?? null,
      e.assistantMessageId,
      e.stepOrdinal,
      e.actor,
      e.kind,
      JSON.stringify(e.metadata),
      e.payloadRefs,
      e.sensitivity ?? 'internal',
    ],
  )
}

/** True when the payload row already exists (object write can be skipped). */
export async function payloadExists(workspaceId: string | null | undefined, hash: string): Promise<boolean> {
  const res = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM turn_payloads WHERE scope = $1 AND hash = $2`,
    [payloadScope(workspaceId), hash],
  )
  return (res.rowCount ?? 0) > 0
}

export async function insertPayloadIndex(p: {
  workspaceId?: string | null
  hash: string
  byteSize: number
  mediaType: string
  storageRef: string
  sensitivity?: string
}): Promise<void> {
  await query(
    `INSERT INTO turn_payloads (scope, hash, workspace_id, byte_size, media_type, storage_ref, sensitivity)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (scope, hash) DO NOTHING`,
    [
      payloadScope(p.workspaceId),
      p.hash,
      p.workspaceId ?? null,
      p.byteSize,
      p.mediaType,
      p.storageRef,
      p.sensitivity ?? 'internal',
    ],
  )
}

export async function getLedgerEpoch(): Promise<Date | null> {
  const res = await query<{ epoch_at: Date }>(`SELECT epoch_at FROM ledger_epoch WHERE id = 1`)
  return res.rows[0]?.epoch_at ?? null
}

function mapEventRow(r: Record<string, unknown>): TurnEventRow {
  return {
    id: r.id as string,
    workspaceId: (r.workspace_id as string | null) ?? null,
    assistantId: (r.assistant_id as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    assistantMessageId: r.assistant_message_id as string,
    stepOrdinal: r.step_ordinal as number,
    actor: r.actor as string,
    kind: r.kind as TurnEventKind,
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    payloadRefs: (r.payload_refs as string[]) ?? [],
    sensitivity: r.sensitivity as string,
    createdAt: r.created_at as Date,
  }
}

/** Full trace for one assistant_message_id, ordinal-ordered. */
export async function listTraceEvents(assistantMessageId: string): Promise<TurnEventRow[]> {
  const res = await query(
    `SELECT * FROM turn_events WHERE assistant_message_id = $1 ORDER BY step_ordinal ASC`,
    [assistantMessageId],
  )
  return res.rows.map(mapEventRow)
}

/** All trace roots for a session (distinct assistant_message_id, oldest first). */
export async function listSessionTraces(sessionId: string): Promise<Array<{ assistantMessageId: string; startedAt: Date }>> {
  const res = await query<{ assistant_message_id: string; started_at: Date }>(
    `SELECT assistant_message_id, min(created_at) AS started_at
       FROM turn_events WHERE session_id = $1
      GROUP BY assistant_message_id ORDER BY started_at ASC`,
    [sessionId],
  )
  return res.rows.map((r) => ({ assistantMessageId: r.assistant_message_id, startedAt: r.started_at }))
}

export async function getPayloadIndexRow(
  workspaceId: string | null | undefined,
  hash: string,
): Promise<TurnPayloadRow | null> {
  const res = await query(
    `SELECT * FROM turn_payloads WHERE scope = $1 AND hash = $2`,
    [payloadScope(workspaceId), hash],
  )
  const r = res.rows[0]
  if (!r) return null
  return {
    scope: r.scope as string,
    hash: r.hash as string,
    workspaceId: (r.workspace_id as string | null) ?? null,
    byteSize: Number(r.byte_size),
    mediaType: r.media_type as string,
    storageRef: r.storage_ref as string,
    sensitivity: r.sensitivity as string,
    erasedAt: (r.erased_at as Date | null) ?? null,
  }
}

/**
 * Erasure tombstone (plan §7): stamp `erased_at` and return the storage
 * refs so the caller can delete the objects. The index rows remain — an
 * as-of read over an erased range resolves to an explicit erased marker,
 * never silent absence.
 */
export async function markPayloadsErased(
  workspaceId: string | null | undefined,
  hashes: string[],
): Promise<string[]> {
  if (hashes.length === 0) return []
  const res = await query<{ storage_ref: string }>(
    `UPDATE turn_payloads SET erased_at = now()
      WHERE scope = $1 AND hash = ANY($2) AND erased_at IS NULL
      RETURNING storage_ref`,
    [payloadScope(workspaceId), hashes],
  )
  return res.rows.map((r) => r.storage_ref)
}

/**
 * Re-key a trace from its recorder-minted UUID to the persisted assistant
 * message id, once the lane knows it (the chat flush site). Makes
 * `getTurnTrace(assistantMessageId)` a direct lookup for interactive lanes.
 */
export async function rebindTraceId(mintedId: string, realId: string): Promise<void> {
  if (mintedId === realId) return
  await query(`UPDATE turn_events SET assistant_message_id = $2 WHERE assistant_message_id = $1`, [
    mintedId,
    realId,
  ])
}
