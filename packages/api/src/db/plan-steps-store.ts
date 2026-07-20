import type { PlanStepRecord, PlanStore } from '@use-brian/core'
import {
  upsertPlanStep,
  updatePlanStepStatus,
  listPlanStepsByAttempt,
  listActivePlanSteps,
  activePlanAttemptId,
  recentDormantPlanAttemptId,
  setPlanAttemptState,
  type PlanStepRow,
} from './plan-steps-queries.js'

function toRecord(r: PlanStepRow): PlanStepRecord {
  return {
    id: r.id,
    sessionId: r.sessionId,
    userId: r.userId,
    assistantId: r.assistantId,
    attemptId: r.attemptId,
    attemptState: r.attemptState,
    key: r.key,
    status: r.status,
    description: r.description,
    note: r.note,
    position: r.position,
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/**
 * Postgres-backed execution-plan store. Mirrors createDbSessionStateStore.
 */
export function createDbPlanStore(): PlanStore {
  return {
    async upsertStep(params) {
      return toRecord(await upsertPlanStep(params))
    },

    async updateStepStatus(params) {
      const row = await updatePlanStepStatus({
        attemptId: params.attemptId,
        key: params.key,
        status: params.status,
        note: params.note ?? null,
      })
      return row ? toRecord(row) : null
    },

    async listByAttempt(attemptId) {
      return (await listPlanStepsByAttempt(attemptId)).map(toRecord)
    },

    async listActiveBySession(sessionId) {
      return (await listActivePlanSteps(sessionId)).map(toRecord)
    },

    async activeAttemptId(sessionId) {
      return activePlanAttemptId(sessionId)
    },

    async setAttemptState(params) {
      return setPlanAttemptState(params)
    },

    async recentDormantAttemptId(sessionId) {
      return recentDormantPlanAttemptId(sessionId)
    },
  }
}
