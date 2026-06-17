/**
 * Execution-plan tier.
 *
 * Per-session, drive-oriented tracker of "which parts of the current task are
 * done". Distinct from the session-state tier (`# Open commitments`), which is
 * suppression-oriented (cross-turn user obligations, "don't re-issue"). This
 * tier is "don't conclude while steps remain" — see
 * `docs/architecture/context-engine/execution-plan.md`.
 *
 * Steps are grouped into a task **attempt** (`attemptId`). An attempt moves
 * through `active` → `dormant` (topic shifted away, resumable) → `archived`
 * (done / superseded / abandoned). The `# Active plan` block is injected ONLY
 * while the attempt is `active` — a liveness gate that stops the drive tier
 * leaking into unrelated turns (the inverse of the 2026-04-22 session-state
 * leak).
 *
 * Written by two paths:
 *   - `tool`       — explicit `setPlan` / `updatePlanStep` / `abandonPlan`
 *   - `auto-seed`  — pre-turn seed derived from existing classifier/splitter
 *                    signals (no new per-turn LLM call)
 */

export type PlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'blocked'
  | 'skipped'

export type AttemptState = 'active' | 'dormant' | 'archived'

export type PlanSource = 'tool' | 'auto-seed'

/** Statuses the completeness gate treats as still-open. */
export const OPEN_PLAN_STATUSES: readonly PlanStepStatus[] = [
  'pending',
  'in_progress',
]

export function isOpenStatus(status: PlanStepStatus): boolean {
  return status === 'pending' || status === 'in_progress'
}

export type PlanStepRecord = {
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

export type PlanStore = {
  /**
   * Insert a step or update its `description`/`position` for
   * `(attemptId, key)`. On insert, `status` defaults to `'pending'`; on
   * conflict the existing `status` and `note` are **preserved** (a plan
   * revision must not reset work already in progress). Always (re)sets the
   * attempt to `active`.
   */
  upsertStep(params: {
    sessionId: string
    userId: string
    assistantId: string
    attemptId: string
    key: string
    description: string
    position: number
    source: PlanSource
  }): Promise<PlanStepRecord>

  /**
   * Move one step's `status` (and optional `note`) for `(attemptId, key)`.
   * Returns the updated row, or `null` if no such step exists.
   */
  updateStepStatus(params: {
    attemptId: string
    key: string
    status: PlanStepStatus
    note?: string | null
  }): Promise<PlanStepRecord | null>

  /** All steps of an attempt, by `position`. Used for reconciliation. */
  listByAttempt(attemptId: string): Promise<PlanStepRecord[]>

  /**
   * Steps of the session's `active` attempt, by `position`. Empty when no
   * attempt is active (dormant/archived attempts return nothing — this is
   * the liveness gate that omits the `# Active plan` block). Used by the
   * block builder and the completeness gate.
   */
  listActiveBySession(sessionId: string): Promise<PlanStepRecord[]>

  /** The session's active `attempt_id`, or `null`. */
  activeAttemptId(sessionId: string): Promise<string | null>

  /**
   * Set every step of an attempt to `state`. Returns rows affected. Used by
   * lifecycle transitions (active↔dormant, →archived) and `abandonPlan`.
   */
  setAttemptState(params: {
    sessionId: string
    attemptId: string
    state: AttemptState
  }): Promise<number>

  /** The session's most-recent `dormant` attempt id, or `null`. Reactivation. */
  recentDormantAttemptId(sessionId: string): Promise<string | null>
}
