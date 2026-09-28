/**
 * Immutable classifier promotion evidence with an audited revocation seam.
 * This is deployment-global quality evidence, not workspace/customer state.
 *
 * [COMP:decisions/promotion-registry]
 */
import { createHash } from 'node:crypto'
import type {
  DecisionEvaluationProfile,
  DecisionOperationRef,
} from '@use-brian/core'
import type { DecisionEvaluationReport } from '../decision-evaluation.js'
import {
  parseDecisionPromotionBundle,
  parseStoredDecisionProfile,
} from '../decision-promotion.js'
import { query } from './client.js'

type ProfileRow = {
  profile_id: string
  profile_version: string
  operation_id: string
  operation_version: string
  state_version: string
  question_version: string
  model_catalog_id: string
  model_wire_id: string
  evaluation_segment: string
  profile: unknown
  report_sha256: string
  approved_at: string
}

export type ApprovedDecisionProfileSummary = {
  id: string
  version: string
  operationId: string
  operationVersion: string
  stateVersion: string
  questionVersion: string
  modelCatalogId: string
  modelWireId: string
  evaluationSegment: string
  reportSha256: string
  approvedAt: string
}

function digestReport(report: DecisionEvaluationReport): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex')
}

function assertRowIdentity(row: ProfileRow, profile: DecisionEvaluationProfile): void {
  const matches = row.profile_id === profile.id
    && row.profile_version === profile.version
    && row.operation_id === profile.operationId
    && row.operation_version === profile.operationVersion
    && row.state_version === profile.stateVersion
    && row.question_version === profile.questionVersion
    && row.model_catalog_id === profile.modelCatalogId
    && row.model_wire_id === profile.modelWireId
    && row.evaluation_segment === profile.evaluationSegment
  if (!matches) throw new Error('decision-profile-registry: stored profile identity is inconsistent')
}

function toSummary(row: ProfileRow): ApprovedDecisionProfileSummary {
  return {
    id: row.profile_id,
    version: row.profile_version,
    operationId: row.operation_id,
    operationVersion: row.operation_version,
    stateVersion: row.state_version,
    questionVersion: row.question_version,
    modelCatalogId: row.model_catalog_id,
    modelWireId: row.model_wire_id,
    evaluationSegment: row.evaluation_segment,
    reportSha256: row.report_sha256,
    approvedAt: row.approved_at,
  }
}

export function createDecisionEvaluationProfileStore() {
  return {
    async getApprovedExact(params: {
      operation: DecisionOperationRef
      modelCatalogId: string
      modelWireId: string
      evaluationSegment: string
    }): Promise<DecisionEvaluationProfile | null> {
      const result = await query<ProfileRow>(
        `SELECT profile_id, profile_version, operation_id, operation_version,
                state_version, question_version, model_catalog_id, model_wire_id,
                evaluation_segment,
                profile, report_sha256, approved_at
           FROM decision_evaluation_profiles
          WHERE status = 'approved'
            AND operation_id = $1
            AND operation_version = $2
            AND state_version = $3
            AND question_version = $4
            AND model_catalog_id = $5
            AND model_wire_id = $6
            AND evaluation_segment = $7`,
        [
          params.operation.id,
          params.operation.version,
          params.operation.stateVersion,
          params.operation.questionVersion,
          params.modelCatalogId,
          params.modelWireId,
          params.evaluationSegment,
        ],
      )
      const row = result.rows[0]
      if (!row) return null
      const profile = parseStoredDecisionProfile(row.profile)
      assertRowIdentity(row, profile)
      return profile
    },

    async listApproved(): Promise<ApprovedDecisionProfileSummary[]> {
      const result = await query<ProfileRow>(
        `SELECT profile_id, profile_version, operation_id, operation_version,
                state_version, question_version, model_catalog_id, model_wire_id,
                evaluation_segment,
                profile, report_sha256, approved_at
           FROM decision_evaluation_profiles
          WHERE status = 'approved'
          ORDER BY model_catalog_id, operation_id, approved_at`,
      )
      return result.rows.map((row) => {
        const profile = parseStoredDecisionProfile(row.profile)
        assertRowIdentity(row, profile)
        return toSummary(row)
      })
    },

    async promote(params: {
      profile: unknown
      report: unknown
      approvedBy: string
    }): Promise<ApprovedDecisionProfileSummary> {
      const approvedBy = params.approvedBy.trim()
      if (!approvedBy) throw new Error('decision-profile-registry: approvedBy is required')
      const { profile, report } = parseDecisionPromotionBundle(params.profile, params.report)
      const reportSha256 = digestReport(report)
      const result = await query<ProfileRow>(
        `INSERT INTO decision_evaluation_profiles (
           profile_id, profile_version, operation_id, operation_version,
           state_version, question_version, model_catalog_id, model_wire_id,
           evaluation_segment, profile, report, report_sha256, approved_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13
         )
         RETURNING profile_id, profile_version, operation_id, operation_version,
                   state_version, question_version, model_catalog_id, model_wire_id,
                   evaluation_segment, profile, report_sha256, approved_at`,
        [
          profile.id,
          profile.version,
          profile.operationId,
          profile.operationVersion,
          profile.stateVersion,
          profile.questionVersion,
          profile.modelCatalogId,
          profile.modelWireId,
          profile.evaluationSegment,
          JSON.stringify(profile),
          JSON.stringify(report),
          reportSha256,
          approvedBy,
        ],
      )
      const row = result.rows[0]
      if (!row) throw new Error('decision-profile-registry: promotion was not written')
      return toSummary(row)
    },

    async revoke(params: {
      profileId: string
      profileVersion: string
      revokedBy: string
      reason: string
    }): Promise<boolean> {
      const revokedBy = params.revokedBy.trim()
      const reason = params.reason.trim()
      if (!revokedBy) throw new Error('decision-profile-registry: revokedBy is required')
      if (!reason) throw new Error('decision-profile-registry: revocation reason is required')
      const result = await query<{ profile_id: string }>(
        `UPDATE decision_evaluation_profiles
            SET status = 'revoked',
                revoked_by = $3,
                revoked_at = now(),
                revocation_reason = $4
          WHERE profile_id = $1
            AND profile_version = $2
            AND status = 'approved'
        RETURNING profile_id`,
        [params.profileId, params.profileVersion, revokedBy, reason],
      )
      return result.rows.length === 1
    },
  }
}

export type DecisionEvaluationProfileStore = ReturnType<typeof createDecisionEvaluationProfileStore>
