import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionEvaluationProfile } from '@use-brian/core'

vi.mock('../client.js', () => ({ query: vi.fn() }))

import { query } from '../client.js'
import { createDecisionEvaluationProfileStore } from '../decision-evaluation-profiles.js'
import {
  SYNTHETIC_EVALUATION_PROFILES,
  runDecisionEvaluation,
  type DecisionEvaluationReport,
} from '../../decision-evaluation.js'

const mockQuery = vi.mocked(query)
const store = createDecisionEvaluationProfileStore()

async function eligibleBundle(): Promise<{
  profile: DecisionEvaluationProfile
  report: DecisionEvaluationReport
}> {
  const offline = await runDecisionEvaluation({
    mode: 'offline',
    now: () => new Date('2026-09-28T00:00:00.000Z'),
  })
  return {
    profile: {
      ...SYNTHETIC_EVALUATION_PROFILES[0]!,
      id: 'approved-research-intent',
      mode: 'hybrid',
      status: 'approved',
      evidence: 'recorded',
    },
    report: {
      ...offline,
      mode: 'live',
      evidence: 'recorded',
      mockedData: false,
      productionPromotionEvidence: true,
    },
  }
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:decisions/promotion-registry] decision evaluation profile store', () => {
  it('validates and inserts immutable aggregate evidence', async () => {
    const { profile, report } = await eligibleBundle()
    mockQuery.mockResolvedValueOnce({ rows: [{
      profile_id: profile.id,
      profile_version: profile.version,
      operation_id: profile.operationId,
      operation_version: profile.operationVersion,
      state_version: profile.stateVersion,
      question_version: profile.questionVersion,
      model_catalog_id: profile.modelCatalogId,
      model_wire_id: profile.modelWireId,
      evaluation_segment: profile.evaluationSegment,
      profile,
      report_sha256: 'a'.repeat(64),
      approved_at: '2026-09-29T00:00:00.000Z',
    }] } as never)

    await expect(store.promote({ profile, report, approvedBy: 'operator-fixture' }))
      .resolves.toMatchObject({ id: profile.id, operationId: profile.operationId })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO decision_evaluation_profiles'),
      expect.arrayContaining([
        profile.id,
        profile.version,
        profile.operationId,
        profile.operationVersion,
        profile.stateVersion,
        profile.questionVersion,
        profile.modelCatalogId,
        profile.modelWireId,
      ]),
    )
    const values = mockQuery.mock.calls[0]![1]!
    expect(values[11]).toMatch(/^[0-9a-f]{64}$/)
    expect(values[12]).toBe('operator-fixture')
  })

  it('rejects synthetic and observation-only promotions before a database write', async () => {
    const { profile, report } = await eligibleBundle()
    await expect(store.promote({
      profile: { ...profile, evidence: 'synthetic' },
      report,
      approvedBy: 'operator-fixture',
    })).rejects.toThrow()
    await expect(store.promote({
      profile: { ...profile, operationId: 'ingest.sensitivity' },
      report: {
        ...report,
        profiles: report.profiles.map((entry, index) => index === 0
          ? { ...entry, operationId: 'ingest.sensitivity' }
          : entry),
        operations: report.operations.map((entry, index) => index === 0
          ? { ...entry, operation: { ...entry.operation, id: 'ingest.sensitivity' } }
          : entry),
      },
      approvedBy: 'operator-fixture',
    })).rejects.toThrow(/observation-only/)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('reads only an exact active profile and verifies duplicated identity columns', async () => {
    const { profile } = await eligibleBundle()
    mockQuery.mockResolvedValueOnce({ rows: [{
      profile_id: profile.id,
      profile_version: profile.version,
      operation_id: profile.operationId,
      operation_version: profile.operationVersion,
      state_version: profile.stateVersion,
      question_version: profile.questionVersion,
      model_catalog_id: profile.modelCatalogId,
      model_wire_id: profile.modelWireId,
      evaluation_segment: profile.evaluationSegment,
      profile,
      report_sha256: 'b'.repeat(64),
      approved_at: '2026-09-29T00:00:00.000Z',
    }] } as never)

    await expect(store.getApprovedExact({
      operation: {
        id: profile.operationId,
        version: profile.operationVersion,
        stateVersion: profile.stateVersion,
        questionVersion: profile.questionVersion,
      },
      modelCatalogId: profile.modelCatalogId,
      modelWireId: profile.modelWireId,
      evaluationSegment: profile.evaluationSegment,
    })).resolves.toEqual(profile)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'approved'"),
      [
        profile.operationId,
        profile.operationVersion,
        profile.stateVersion,
        profile.questionVersion,
        profile.modelCatalogId,
        profile.modelWireId,
        profile.evaluationSegment,
      ],
    )
  })

  it('revokes authority with operator and reason metadata', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ profile_id: 'approved-research-intent' }] } as never)
    await expect(store.revoke({
      profileId: 'approved-research-intent',
      profileVersion: '1',
      revokedBy: 'operator-fixture',
      reason: 'superseded evidence',
    })).resolves.toBe(true)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'revoked'"),
      ['approved-research-intent', '1', 'operator-fixture', 'superseded evidence'],
    )
  })
})
