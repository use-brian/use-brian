/**
 * PostgreSQL frozen-plan and atomic application receipts.
 *
 * [COMP:brain/extraction-application-store]
 */
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  emptyApplicationCounts,
  ExtractionApplicationError,
  type AccessContext,
  type ExtractionApplicationClaim,
  type ExtractionApplicationItem,
  type ExtractionApplicationMutation,
  type ExtractionApplicationRun,
  type ExtractionApplicationStorePort,
  type FrozenCandidate,
  type FrozenExtractionPlan,
} from '@use-brian/core'

import { buildAccessPredicate } from './access-predicate.js'
import { getPool, queryWithRLS } from './client.js'

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

const LEASE_MS = 5 * 60 * 1000

type RunRow = {
  id: string
  workspaceId: string
  episodeId: string
  attemptKey: string
  planHash: string
  extractionState: ExtractionApplicationRun['extractionState']
  applicationState: ExtractionApplicationRun['applicationState']
  errorCode: string | null
  createdAt: Date
}

type ItemRow = {
  candidateId: string
  primitiveKind: ExtractionApplicationItem['primitiveKind']
  payloadHash: string
  dependencyIds: string[]
  disposition: ExtractionApplicationItem['disposition']
  targetRecordId: string | null
  receiptId: string | null
  attemptCount: number
  failureCode: string | null
  retryable: boolean
}

const RUN_COLUMNS = `
  r.id,
  r.workspace_id AS "workspaceId",
  r.episode_id AS "episodeId",
  r.attempt_key AS "attemptKey",
  r.plan_hash AS "planHash",
  r.extraction_state AS "extractionState",
  r.application_state AS "applicationState",
  r.error_code AS "errorCode",
  r.created_at AS "createdAt"
`

const ITEM_COLUMNS = `
  candidate_id AS "candidateId",
  primitive_kind AS "primitiveKind",
  payload_hash AS "payloadHash",
  dependency_ids AS "dependencyIds",
  disposition,
  target_record_id AS "targetRecordId",
  receipt_id AS "receiptId",
  attempt_count AS "attemptCount",
  failure_code AS "failureCode",
  retryable
`

function toItem(row: ItemRow): ExtractionApplicationItem {
  return {
    candidateId: row.candidateId,
    primitiveKind: row.primitiveKind,
    payloadHash: row.payloadHash,
    dependencyIds: row.dependencyIds ?? [],
    disposition: row.disposition,
    targetRecordId: row.targetRecordId ?? null,
    receiptId: row.receiptId ?? null,
    attemptCount: row.attemptCount,
    failureCode: row.failureCode ?? null,
    retryable: row.retryable,
  }
}

function summarize(row: RunRow, itemRows: ItemRow[]): ExtractionApplicationRun {
  const items = itemRows.map(toItem)
  const counts = emptyApplicationCounts()
  for (const item of items) counts[item.disposition] += 1
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    episodeId: row.episodeId,
    attemptKey: row.attemptKey,
    planHash: row.planHash,
    extractionState: row.extractionState,
    applicationState: row.applicationState,
    errorCode: row.errorCode ?? null,
    items,
    counts,
  }
}

async function loadRun(exec: Queryable, runId: string): Promise<ExtractionApplicationRun | null> {
  const run = await exec.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM episode_extraction_runs r WHERE r.id=$1`, [runId])
  if (!run.rows[0]) return null
  const items = await exec.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM episode_extraction_items WHERE run_id=$1 ORDER BY candidate_id`,
    [runId],
  )
  return summarize(run.rows[0], items.rows)
}

async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function leaseLost(): never {
  throw new ExtractionApplicationError('application_lease_lost')
}

async function lockClaim(
  client: pg.PoolClient,
  claim: ExtractionApplicationClaim,
): Promise<{ workspaceId: string; episodeId: string }> {
  if (!claim.authority || claim.authority.workspaceId.length === 0
    || claim.authority.actorUserId.length === 0
    || claim.authority.mutationCompartments === undefined
    || claim.authority.projectIds === undefined) {
    throw new ExtractionApplicationError('application_authority_missing')
  }
  const result = await client.query<{
    workspaceId: string
    episodeId: string
    sourceScopeVersion: string
    liveScopeVersion: string
    scopeHeld: boolean
    episodeHeld: boolean
    extractionLocked: boolean
    status: string
    userId: string | null
    createdByUserId: string
    sensitivity: string
    compartments: string[]
    projectIds: string[]
    actorClearance: string
    sourceActorPresent: boolean
  }>(
    `SELECT r.workspace_id AS "workspaceId", r.episode_id AS "episodeId",
            r.source_scope_version::text AS "sourceScopeVersion",
            e.scope_version::text AS "liveScopeVersion",
            r.scope_held AS "scopeHeld", e.scope_held AS "episodeHeld",
            e.extraction_locked AS "extractionLocked", e.status,
            e.user_id AS "userId",e.created_by_user_id AS "createdByUserId",
            e.sensitivity,e.compartments,e.project_ids AS "projectIds",
            actor.clearance AS "actorClearance",
            EXISTS(SELECT 1 FROM workspace_members source_actor
              WHERE source_actor.workspace_id=r.workspace_id
                AND source_actor.user_id=e.created_by_user_id) AS "sourceActorPresent"
       FROM episode_extraction_runs r
       JOIN episodes e ON e.id=r.episode_id AND e.workspace_id=r.workspace_id
       JOIN workspace_members actor ON actor.workspace_id=r.workspace_id AND actor.user_id=$4
      WHERE r.id=$1 AND r.plan_hash=$2 AND r.lease_token=$3::uuid
        AND r.lease_until > now() AND r.workspace_id=$5
      FOR UPDATE OF r,e`,
    [claim.runId, claim.planHash, claim.leaseToken,
      claim.authority.actorUserId, claim.authority.workspaceId],
  )
  const row = result.rows[0]
  if (!row) leaseLost()
  const compartmentGrant = claim.authority.mutationCompartments
  const projectGrant = claim.authority.projectIds
  const allows = (required: string[], grant: string[] | null) =>
    grant === null || required.every((value) => grant.includes(value))
  const sensitivityRank: Record<string, number> = {
    public: 0, internal: 1, confidential: 2, private: 2, secret: 3,
  }
  if (row.scopeHeld || row.episodeHeld || row.extractionLocked
    || row.sourceScopeVersion !== row.liveScopeVersion || row.status !== 'archived') {
    throw new ExtractionApplicationError('application_source_blocked')
  }
  if (!row.sourceActorPresent || (row.userId !== null && row.userId !== claim.authority.actorUserId)
    || (sensitivityRank[row.sensitivity] ?? 99) > (sensitivityRank[row.actorClearance] ?? -1)
    || !allows(row.compartments ?? [], compartmentGrant)
    || !allows(row.projectIds ?? [], projectGrant)) {
    throw new ExtractionApplicationError('application_authority_denied')
  }
  return row
}

export type AuthorizedApplicationPage = {
  runs: ExtractionApplicationRun[]
  nextCursor: string | null
}

export type DbExtractionApplicationStore = ExtractionApplicationStorePort & {
  getAuthorized(
    ctx: AccessContext,
    episodeId: string,
    runId?: string,
    operation?: 'read' | 'mutation',
  ): Promise<ExtractionApplicationRun | null>
  listAuthorized(ctx: AccessContext, opts?: { cursor?: string; limit?: number }): Promise<AuthorizedApplicationPage>
  getFrozenPlan(runId: string): Promise<FrozenExtractionPlan | null>
}

export function createExtractionApplicationStore(): DbExtractionApplicationStore {
  return {
    async ensureRun(input) {
      return transaction(async (client) => {
        const source = await client.query<{
          scopeVersion: string
          status: string
          extractionLocked: boolean
          scopeHeld: boolean
          userId: string | null
          assistantId: string | null
          createdByUserId: string
          createdByAssistantId: string | null
          sensitivity: string
          compartments: string[]
          projectIds: string[]
        }>(
          `SELECT scope_version::text AS "scopeVersion", status,
                  extraction_locked AS "extractionLocked", scope_held AS "scopeHeld",
                  user_id AS "userId", assistant_id AS "assistantId",
                  created_by_user_id AS "createdByUserId",
                  created_by_assistant_id AS "createdByAssistantId",
                  sensitivity, compartments, project_ids AS "projectIds"
             FROM episodes WHERE id=$1 AND workspace_id=$2 FOR SHARE`,
          [input.episodeId, input.workspaceId],
        )
        const episode = source.rows[0]
        if (!episode) throw new ExtractionApplicationError('application_source_missing')
        if (episode.status !== 'archived' || episode.extractionLocked || episode.scopeHeld) {
          throw new ExtractionApplicationError('application_source_blocked')
        }
        if (input.plan.sourceScopeVersion !== episode.scopeVersion) {
          throw new ExtractionApplicationError('application_source_changed')
        }

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO episode_extraction_runs (
             workspace_id,episode_id,attempt_key,source_content_hash,
             extractor_contract_version,plan_hash,frozen_plan,extraction_state,
             outbox_job_id,source_scope_version,user_id,assistant_id,
             created_by_user_id,created_by_assistant_id,sensitivity,compartments,project_ids
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::bigint,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (workspace_id,episode_id,attempt_key) DO NOTHING
           RETURNING id`,
          [input.workspaceId, input.episodeId, input.attemptKey,
            input.plan.sourceContentHash, input.plan.extractorContractVersion,
            input.plan.planHash, JSON.stringify(input.plan), input.extractionState,
            input.outboxJobId ?? null, episode.scopeVersion, episode.userId,
            episode.assistantId, episode.createdByUserId, episode.createdByAssistantId,
            episode.sensitivity, episode.compartments ?? [], episode.projectIds ?? []],
        )
        let runId = inserted.rows[0]?.id
        if (!runId) {
          const existing = await client.query<{ id: string; planHash: string }>(
            `SELECT id,plan_hash AS "planHash" FROM episode_extraction_runs
              WHERE workspace_id=$1 AND episode_id=$2 AND attempt_key=$3 FOR UPDATE`,
            [input.workspaceId, input.episodeId, input.attemptKey],
          )
          if (!existing.rows[0]) throw new ExtractionApplicationError('application_run_missing')
          if (existing.rows[0].planHash !== input.plan.planHash) {
            throw new ExtractionApplicationError('application_plan_conflict')
          }
          runId = existing.rows[0].id
        }

        for (const candidate of input.plan.candidates) {
          const row = await client.query<{ payloadHash: string; primitiveKind: string }>(
            `INSERT INTO episode_extraction_items
               (run_id,candidate_id,primitive_kind,payload_hash,dependency_ids)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (run_id,candidate_id) DO UPDATE SET
               candidate_id=episode_extraction_items.candidate_id
             RETURNING payload_hash AS "payloadHash",primitive_kind AS "primitiveKind"`,
            [runId, candidate.candidateId, candidate.primitiveKind,
              candidate.payloadHash, candidate.dependencyIds],
          )
          if (row.rows[0]?.payloadHash !== candidate.payloadHash
            || row.rows[0]?.primitiveKind !== candidate.primitiveKind) {
            throw new ExtractionApplicationError('application_candidate_conflict')
          }
        }
        return (await loadRun(client, runId))!
      })
    },

    async claim(runId, expectedPlanHash, authority) {
      if (!authority) throw new ExtractionApplicationError('application_authority_missing')
      const leaseToken = randomUUID()
      const leaseOwner = `application-${process.pid}`
      const result = await getPool().query<{ id: string }>(
        `UPDATE episode_extraction_runs
            SET lease_owner=$3,lease_token=$4::uuid,
                lease_until=now()+($5::int*interval '1 millisecond'),
                started_at=coalesce(started_at,now()),error_code=NULL
          WHERE id=$1 AND plan_hash=$2 AND NOT scope_held
            AND application_state<>'complete'
            AND (lease_token IS NULL OR lease_until<=now() OR lease_token=$4::uuid)
          RETURNING id`,
        [runId, expectedPlanHash, leaseOwner, leaseToken, LEASE_MS],
      )
      if (!result.rows[0]) {
        const current = await loadRun(getPool(), runId)
        if (current?.applicationState === 'complete') {
          return { runId, planHash: expectedPlanHash, leaseToken, authority }
        }
        throw new ExtractionApplicationError('application_claim_conflict', undefined, true)
      }
      return { runId, planHash: expectedPlanHash, leaseToken, authority }
    },

    async applyItem(claim, candidate, mutate) {
      return transaction(async (client) => {
        await lockClaim(client, claim)
        const locked = await client.query<ItemRow>(
          `SELECT ${ITEM_COLUMNS} FROM episode_extraction_items
            WHERE run_id=$1 AND candidate_id=$2 FOR UPDATE`,
          [claim.runId, candidate.candidateId],
        )
        const row = locked.rows[0]
        if (!row) throw new ExtractionApplicationError('application_item_missing')
        if (row.payloadHash !== candidate.payloadHash || row.primitiveKind !== candidate.primitiveKind) {
          throw new ExtractionApplicationError('application_candidate_conflict')
        }
        if (['committed', 'already_applied', 'held', 'rejected'].includes(row.disposition)) {
          return { ...toItem(row), disposition: 'already_applied' }
        }
        if (row.disposition === 'failed' && !row.retryable) return toItem(row)

        if (candidate.dependencyIds.length > 0) {
          const dependencies = await client.query<{ candidateId: string; disposition: string }>(
            `SELECT candidate_id AS "candidateId",disposition
               FROM episode_extraction_items
              WHERE run_id=$1 AND candidate_id=ANY($2::text[]) FOR SHARE`,
            [claim.runId, candidate.dependencyIds],
          )
          if (dependencies.rows.length !== candidate.dependencyIds.length
            || dependencies.rows.some((dependency) => !['committed','already_applied'].includes(dependency.disposition))) {
            throw new ExtractionApplicationError('application_dependency_pending', undefined, true)
          }
        }

        const mutation = await mutate(client)
        const disposition = mutation.disposition ?? 'committed'
        if (!['committed', 'held', 'rejected'].includes(disposition)) {
          throw new ExtractionApplicationError('application_disposition_invalid')
        }
        const receiptId = randomUUID()
        const updated = await client.query<ItemRow>(
          `UPDATE episode_extraction_items
              SET disposition=$3,target_record_id=$4,receipt_id=$5::uuid,
                  attempt_count=attempt_count+1,failure_code=$6,retryable=false,
                  applied_at=now()
            WHERE run_id=$1 AND candidate_id=$2
            RETURNING ${ITEM_COLUMNS}`,
          [claim.runId, candidate.candidateId, disposition,
            mutation.targetRecordId ?? null, receiptId, mutation.safeCode ?? null],
        )
        return toItem(updated.rows[0])
      })
    },

    async recordFailure(claim, candidateId, failure) {
      return transaction(async (client) => {
        await lockClaim(client, claim)
        const updated = await client.query<ItemRow>(
          `UPDATE episode_extraction_items
              SET disposition='failed',receipt_id=NULL,target_record_id=NULL,
                  attempt_count=attempt_count+1,failure_code=$3,retryable=$4,
                  applied_at=NULL
            WHERE run_id=$1 AND candidate_id=$2
              AND disposition NOT IN ('committed','already_applied','held','rejected')
            RETURNING ${ITEM_COLUMNS}`,
          [claim.runId, candidateId, failure.code.slice(0, 120), failure.retryable],
        )
        if (!updated.rows[0]) {
          const existing = await client.query<ItemRow>(
            `SELECT ${ITEM_COLUMNS} FROM episode_extraction_items WHERE run_id=$1 AND candidate_id=$2`,
            [claim.runId, candidateId],
          )
          if (!existing.rows[0]) throw new ExtractionApplicationError('application_item_missing')
          return toItem(existing.rows[0])
        }
        return toItem(updated.rows[0])
      })
    },

    async finish(claim) {
      return transaction(async (client) => {
        await lockClaim(client, claim)
        const counts = await client.query<{
          pending: string; committed: string; held: string; rejected: string
          retryableFailed: string; terminalFailed: string
        }>(
          `SELECT
             count(*) FILTER(WHERE disposition='pending')::text AS pending,
             count(*) FILTER(WHERE disposition IN('committed','already_applied'))::text AS committed,
             count(*) FILTER(WHERE disposition='held')::text AS held,
             count(*) FILTER(WHERE disposition='rejected')::text AS rejected,
             count(*) FILTER(WHERE disposition='failed' AND retryable)::text AS "retryableFailed",
             count(*) FILTER(WHERE disposition='failed' AND NOT retryable)::text AS "terminalFailed"
           FROM episode_extraction_items WHERE run_id=$1`,
          [claim.runId],
        )
        const count = counts.rows[0]
        const state: ExtractionApplicationRun['applicationState'] =
          Number(count.pending) === 0 && Number(count.retryableFailed) === 0 && Number(count.terminalFailed) === 0
            ? 'complete'
            : Number(count.pending) > 0 || Number(count.retryableFailed) > 0
              ? 'partial'
              : 'blocked'
        await client.query(
          `UPDATE episode_extraction_runs SET application_state=$2,
             error_code=CASE WHEN $2='blocked' THEN coalesce(error_code,'application_blocked') ELSE NULL END,
             completed_at=CASE WHEN $2='complete' THEN now() ELSE NULL END,
             lease_owner=NULL,lease_token=NULL,lease_until=NULL
           WHERE id=$1`,
          [claim.runId, state],
        )
        return (await loadRun(client, claim.runId))!
      })
    },

    getRun(runId) {
      return loadRun(getPool(), runId)
    },

    async getAuthorized(ctx, episodeId, runId, operation = 'read') {
      const access = buildAccessPredicate(ctx, { alias: 'e', operation })
      const idIndex = access.nextIdx
      const runIndex = idIndex + 1
      const rows = await queryWithRLS<RunRow>(
        ctx.userId,
        `SELECT ${RUN_COLUMNS}
           FROM episode_extraction_runs r JOIN episodes e ON e.id=r.episode_id
          WHERE ${access.sql} AND e.id=$${idIndex}
            AND ($${runIndex}::uuid IS NULL OR r.id=$${runIndex})
          ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
        [...access.params, episodeId, runId ?? null],
      )
      const row = rows.rows[0]
      if (!row) return null
      const items = await queryWithRLS<ItemRow>(
        ctx.userId,
        `SELECT ${ITEM_COLUMNS} FROM episode_extraction_items WHERE run_id=$1 ORDER BY candidate_id`,
        [row.id],
      )
      return summarize(row, items.rows)
    },

    async getFrozenPlan(runId) {
      const result = await getPool().query<{ frozenPlan: FrozenExtractionPlan }>(
        `SELECT frozen_plan AS "frozenPlan" FROM episode_extraction_runs WHERE id=$1`,
        [runId],
      )
      return result.rows[0]?.frozenPlan ?? null
    },

    async listAuthorized(ctx, opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 20, 1), 100)
      const access = buildAccessPredicate(ctx, { alias: 'e' })
      const cursorIndex = access.nextIdx
      const limitIndex = cursorIndex + 1
      const rows = await queryWithRLS<RunRow>(
        ctx.userId,
        `SELECT ${RUN_COLUMNS}
           FROM episode_extraction_runs r JOIN episodes e ON e.id=r.episode_id
          WHERE ${access.sql}
            AND ($${cursorIndex}::uuid IS NULL OR (r.created_at,r.id) < (
              SELECT created_at,id FROM episode_extraction_runs
               WHERE id=$${cursorIndex} AND workspace_id=$1
            ))
          ORDER BY r.created_at DESC,r.id DESC LIMIT $${limitIndex}`,
        [...access.params, opts?.cursor ?? null, limit + 1],
      )
      const pageRows = rows.rows.slice(0, limit)
      const runs: ExtractionApplicationRun[] = []
      for (const row of pageRows) {
        const items = await queryWithRLS<ItemRow>(
          ctx.userId,
          `SELECT ${ITEM_COLUMNS} FROM episode_extraction_items WHERE run_id=$1 ORDER BY candidate_id`,
          [row.id],
        )
        runs.push(summarize(row, items.rows))
      }
      return {
        runs,
        nextCursor: rows.rows.length > limit ? pageRows.at(-1)?.id ?? null : null,
      }
    },
  }
}

export type ExtractionApplicationTransaction = pg.PoolClient
export type { FrozenExtractionPlan }
