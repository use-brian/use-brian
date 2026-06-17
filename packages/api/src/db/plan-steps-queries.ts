import type {
  AttemptState,
  PlanSource,
  PlanStepStatus,
} from '@sidanclaw/core'
import { query } from './client.js'

export type PlanStepRow = {
  id: string
  sessionId: string
  userId: string
  assistantId: string
  attemptId: string
  attemptState: AttemptState
  key: string
  status: PlanStepStatus
  description: string
  note: string | null
  position: number
  source: PlanSource
  createdAt: Date
  updatedAt: Date
}

const SELECT = `
  id,
  session_id    as "sessionId",
  user_id       as "userId",
  assistant_id  as "assistantId",
  attempt_id    as "attemptId",
  attempt_state as "attemptState",
  key,
  status,
  description,
  note,
  position,
  source,
  created_at    as "createdAt",
  updated_at    as "updatedAt"
`

export async function upsertPlanStep(params: {
  sessionId: string
  userId: string
  assistantId: string
  attemptId: string
  key: string
  description: string
  position: number
  source: PlanSource
}): Promise<PlanStepRow> {
  // ON CONFLICT (attempt_id, key): a plan revision updates description/position
  // and re-activates the attempt, but PRESERVES the existing status + note —
  // setPlan must never reset work already in progress (execution-plan.md
  // "Reconciliation on re-setPlan"). New rows insert as status='pending'.
  const result = await query<PlanStepRow>(
    `INSERT INTO plan_steps
       (session_id, user_id, assistant_id, attempt_id, key, description, position, source, attempt_state, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 'pending')
     ON CONFLICT (attempt_id, key) DO UPDATE SET
       description   = EXCLUDED.description,
       position      = EXCLUDED.position,
       attempt_state = 'active',
       updated_at    = now()
     RETURNING ${SELECT}`,
    [
      params.sessionId,
      params.userId,
      params.assistantId,
      params.attemptId,
      params.key,
      params.description,
      params.position,
      params.source,
    ],
  )
  return result.rows[0]
}

export async function updatePlanStepStatus(params: {
  attemptId: string
  key: string
  status: PlanStepStatus
  note: string | null
}): Promise<PlanStepRow | null> {
  const result = await query<PlanStepRow>(
    `UPDATE plan_steps
        SET status     = $3,
            note       = COALESCE($4, note),
            updated_at = now()
      WHERE attempt_id = $1
        AND key = $2
     RETURNING ${SELECT}`,
    [params.attemptId, params.key, params.status, params.note],
  )
  return result.rows[0] ?? null
}

export async function listPlanStepsByAttempt(
  attemptId: string,
): Promise<PlanStepRow[]> {
  const result = await query<PlanStepRow>(
    `SELECT ${SELECT}
       FROM plan_steps
      WHERE attempt_id = $1
      ORDER BY position, created_at`,
    [attemptId],
  )
  return result.rows
}

export async function listActivePlanSteps(
  sessionId: string,
): Promise<PlanStepRow[]> {
  const result = await query<PlanStepRow>(
    `SELECT ${SELECT}
       FROM plan_steps
      WHERE session_id = $1
        AND attempt_state = 'active'
      ORDER BY position, created_at`,
    [sessionId],
  )
  return result.rows
}

export async function activePlanAttemptId(
  sessionId: string,
): Promise<string | null> {
  const result = await query<{ attemptId: string }>(
    `SELECT attempt_id as "attemptId"
       FROM plan_steps
      WHERE session_id = $1
        AND attempt_state = 'active'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [sessionId],
  )
  return result.rows[0]?.attemptId ?? null
}

export async function recentDormantPlanAttemptId(
  sessionId: string,
): Promise<string | null> {
  const result = await query<{ attemptId: string }>(
    `SELECT attempt_id as "attemptId"
       FROM plan_steps
      WHERE session_id = $1
        AND attempt_state = 'dormant'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [sessionId],
  )
  return result.rows[0]?.attemptId ?? null
}

export async function setPlanAttemptState(params: {
  sessionId: string
  attemptId: string
  state: AttemptState
}): Promise<number> {
  const result = await query<{ id: string }>(
    `UPDATE plan_steps
        SET attempt_state = $3,
            updated_at    = now()
      WHERE session_id = $1
        AND attempt_id = $2
     RETURNING id`,
    [params.sessionId, params.attemptId, params.state],
  )
  return result.rowCount ?? result.rows.length
}
