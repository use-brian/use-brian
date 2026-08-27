/**
 * Immutable, typed human-decision journal.
 *
 * This is the only application module allowed to insert `decision_events`.
 * Writers pass their open `PoolClient` so domain state and evidence commit or
 * roll back together. The registry parse happens before the first SQL call.
 *
 * [COMP:api/decision-event-store]
 */

import {
  parseDecisionEventWrite,
  type DecisionEvent,
  type DecisionEventWrite,
} from '@use-brian/core'
import type pg from 'pg'

import { getPool } from './client.js'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

export type DecisionEventRecord = DecisionEvent & {
  id: string
  createdAt: Date
}

export type AppendDecisionEventResult = {
  event: DecisionEventRecord
  inserted: boolean
}

const DECISION_EVENT_COLUMNS = `
  id,
  idempotency_key          AS "idempotencyKey",
  workspace_id             AS "workspaceId",
  actor_user_id            AS "actorUserId",
  assistant_id             AS "assistantId",
  session_id               AS "sessionId",
  event_kind               AS "eventKind",
  schema_version           AS "schemaVersion",
  source_kind              AS "sourceKind",
  source_id                AS "sourceId",
  declared_scope           AS "declaredScope",
  visibility,
  sensitivity,
  reason,
  payload,
  caused_by_event_id       AS "causedByEventId",
  caused_by_application_id AS "causedByApplicationId",
  reverses_event_id        AS "reversesEventId",
  created_at               AS "createdAt"
` as const

function toRecord(row: Record<string, unknown>): DecisionEventRecord {
  const { id, createdAt, ...eventFields } = row
  const parsed = parseDecisionEventWrite(eventFields)
  return {
    ...parsed,
    id: id as string,
    createdAt: createdAt as Date,
  }
}

export async function appendDecisionEvent(
  input: DecisionEventWrite,
  client?: pg.PoolClient,
): Promise<AppendDecisionEventResult> {
  const event = parseDecisionEventWrite(input)
  const exec: Queryable = client ?? getPool()
  const inserted = await exec.query(
    `INSERT INTO decision_events (
       idempotency_key, workspace_id, actor_user_id, assistant_id, session_id,
       event_kind, schema_version, source_kind, source_id, declared_scope,
       visibility, sensitivity, reason, payload, caused_by_event_id,
       caused_by_application_id, reverses_event_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       $14::jsonb, $15, $16, $17
     )
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${DECISION_EVENT_COLUMNS}`,
    [
      event.idempotencyKey,
      event.workspaceId,
      event.actorUserId,
      event.assistantId,
      event.sessionId,
      event.eventKind,
      event.schemaVersion,
      event.sourceKind,
      event.sourceId,
      event.declaredScope,
      event.visibility,
      event.sensitivity,
      event.reason,
      JSON.stringify(event.payload),
      event.causedByEventId,
      event.causedByApplicationId,
      event.reversesEventId,
    ],
  )
  if (inserted.rows[0]) {
    return {
      event: toRecord(inserted.rows[0] as Record<string, unknown>),
      inserted: true,
    }
  }

  const existing = await exec.query(
    `SELECT ${DECISION_EVENT_COLUMNS}
       FROM decision_events
      WHERE idempotency_key = $1`,
    [event.idempotencyKey],
  )
  if (!existing.rows[0]) {
    throw new Error(`Decision event ${event.idempotencyKey} conflicted but could not be read`)
  }
  return {
    event: toRecord(existing.rows[0] as Record<string, unknown>),
    inserted: false,
  }
}

export async function findDecisionEventByIdempotencyKey(
  idempotencyKey: string,
  client?: pg.PoolClient,
): Promise<DecisionEventRecord | null> {
  const trimmed = idempotencyKey.trim()
  if (!trimmed || trimmed.length > 512) throw new Error('Invalid decision event idempotency key')
  const exec: Queryable = client ?? getPool()
  const result = await exec.query(
    `SELECT ${DECISION_EVENT_COLUMNS}
       FROM decision_events
      WHERE idempotency_key = $1`,
    [trimmed],
  )
  return result.rows[0] ? toRecord(result.rows[0] as Record<string, unknown>) : null
}

export async function listDecisionEventsForActor(params: {
  assistantId: string
  actorUserId: string
  since: Date
  limit: number
}): Promise<DecisionEventRecord[]> {
  const limit = Math.min(Math.max(params.limit, 1), 100)
  const result = await getPool().query(
    `SELECT ${DECISION_EVENT_COLUMNS}
       FROM decision_events
      WHERE assistant_id = $1
        AND actor_user_id = $2
        AND created_at >= $3
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [params.assistantId, params.actorUserId, params.since, limit],
  )
  return result.rows.map((row) => toRecord(row as Record<string, unknown>))
}
