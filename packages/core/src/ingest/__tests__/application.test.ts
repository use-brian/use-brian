import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import {
  applyFrozenExtractionPlan,
  emptyApplicationCounts,
  ExtractionApplicationError,
  freezeExtractionPlan,
  initialExtractionAttemptKey,
  type ExtractionApplicationClaim,
  type ExtractionApplicationItem,
  type ExtractionApplicationMutation,
  type ExtractionApplicationRun,
  type ExtractionApplicationStorePort,
  type FrozenCandidate,
} from '../index.js'

class MemoryApplicationStore implements ExtractionApplicationStorePort {
  run: ExtractionApplicationRun | null = null
  lease: string | null = null

  async ensureRun(input: Parameters<ExtractionApplicationStorePort['ensureRun']>[0]) {
    if (this.run) return structuredClone(this.run)
    const counts = emptyApplicationCounts()
    counts.pending = input.plan.candidates.length
    this.run = {
      id: randomUUID(), workspaceId: input.workspaceId, episodeId: input.episodeId,
      attemptKey: input.attemptKey,
      planHash: input.plan.planHash, extractionState: input.extractionState,
      applicationState: 'not_started', errorCode: null, counts,
      items: input.plan.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        primitiveKind: candidate.primitiveKind,
        payloadHash: candidate.payloadHash,
        dependencyIds: candidate.dependencyIds,
        disposition: 'pending', targetRecordId: null, receiptId: null,
        attemptCount: 0, failureCode: null, retryable: true,
      })),
    }
    return structuredClone(this.run)
  }

  async claim(runId: string, expectedPlanHash: string): Promise<ExtractionApplicationClaim> {
    if (!this.run || this.run.id !== runId || this.run.planHash !== expectedPlanHash) {
      throw new ExtractionApplicationError('application_plan_conflict')
    }
    this.lease = randomUUID()
    return { runId, planHash: expectedPlanHash, leaseToken: this.lease }
  }

  async applyItem(
    claim: ExtractionApplicationClaim,
    candidate: FrozenCandidate,
    mutate: (transactionContext: unknown) => Promise<ExtractionApplicationMutation>,
  ): Promise<ExtractionApplicationItem> {
    if (!this.run || claim.leaseToken !== this.lease) {
      throw new ExtractionApplicationError('application_lease_lost')
    }
    const row = this.run.items.find((item) => item.candidateId === candidate.candidateId)!
    if (row.disposition === 'committed') return { ...row, disposition: 'already_applied' }
    const result = await mutate({ kind: 'memory-transaction' })
    Object.assign(row, {
      disposition: result.disposition ?? 'committed',
      targetRecordId: result.targetRecordId ?? null,
      receiptId: randomUUID(),
      attemptCount: row.attemptCount + 1,
      failureCode: result.safeCode ?? null,
      retryable: false,
    })
    return structuredClone(row)
  }

  async recordFailure(
    claim: ExtractionApplicationClaim,
    candidateId: string,
    failure: { code: string; retryable: boolean },
  ) {
    if (!this.run || claim.leaseToken !== this.lease) {
      throw new ExtractionApplicationError('application_lease_lost')
    }
    const row = this.run.items.find((item) => item.candidateId === candidateId)!
    Object.assign(row, {
      disposition: 'failed',
      attemptCount: row.attemptCount + 1,
      failureCode: failure.code,
      retryable: failure.retryable,
    })
    return structuredClone(row)
  }

  async finish(claim: ExtractionApplicationClaim) {
    if (!this.run || claim.leaseToken !== this.lease) {
      throw new ExtractionApplicationError('application_lease_lost')
    }
    const counts = emptyApplicationCounts()
    for (const item of this.run.items) counts[item.disposition]++
    const terminal = this.run.items.every((item) =>
      ['committed', 'already_applied', 'held', 'rejected'].includes(item.disposition)
      || (item.disposition === 'failed' && !item.retryable))
    const retryable = this.run.items.some((item) =>
      item.disposition === 'pending' || (item.disposition === 'failed' && item.retryable))
    this.run.counts = counts
    this.run.applicationState = terminal ? 'complete' : retryable ? 'partial' : 'blocked'
    this.lease = null
    return structuredClone(this.run)
  }

  async getRun(runId: string) {
    return this.run?.id === runId ? structuredClone(this.run) : null
  }
}

function plan() {
  return freezeExtractionPlan({
    episodeId: '11111111-1111-4111-8111-111111111111',
    sourceContentHash: 'a'.repeat(64),
    sourceScopeVersion: '7',
    extractorContractVersion: 'pipeline-b-v1',
    candidates: [
      { key: 'one', primitiveKind: 'entity', payload: { name: 'Fictional One' } },
      { key: 'two', primitiveKind: 'memory', payload: { summary: 'Second' } },
      { key: 'three', primitiveKind: 'task', payload: { title: 'Third' } },
    ],
  })
}

describe('[COMP:brain/extraction-application] frozen application', () => {
  it('I1 resumes only the failed candidate and a completed replay performs zero writes or model hooks', async () => {
    const frozen = plan()
    const store = new MemoryApplicationStore()
    const writes = vi.fn(async (candidate: FrozenCandidate) => {
      if (candidate.primitiveKind === 'memory' && writes.mock.calls.length === 2) {
        throw new ExtractionApplicationError('temporary_store_failure', undefined, true)
      }
      return { targetRecordId: `target-${candidate.primitiveKind}` }
    })
    const decisionRun = vi.fn()
    const decisionObserve = vi.fn()
    const modelCall = vi.fn()
    const surcharge = vi.fn()
    const args = {
      store,
      workspaceId: '22222222-2222-4222-8222-222222222222',
      attemptKey: initialExtractionAttemptKey(frozen.sourceContentHash, frozen.extractorContractVersion),
      plan: frozen,
      mutate: writes,
    }

    const first = await applyFrozenExtractionPlan(args)
    expect(first.applicationState).toBe('partial')
    expect(first.counts).toMatchObject({ committed: 2, failed: 1 })
    expect(writes).toHaveBeenCalledTimes(3)

    const second = await applyFrozenExtractionPlan(args)
    expect(second.applicationState).toBe('complete')
    expect(second.counts).toMatchObject({ committed: 3, failed: 0 })
    expect(writes).toHaveBeenCalledTimes(4)
    expect(writes.mock.calls.at(-1)?.[0].primitiveKind).toBe('memory')

    const third = await applyFrozenExtractionPlan(args)
    expect(third.applicationState).toBe('complete')
    expect(writes).toHaveBeenCalledTimes(4)
    expect(decisionRun).not.toHaveBeenCalled()
    expect(decisionObserve).not.toHaveBeenCalled()
    expect(modelCall).not.toHaveBeenCalled()
    expect(surcharge).not.toHaveBeenCalled()
  })

  it('I2 preserves held/rejected outcomes and waits for entity dependencies', async () => {
    const frozen = freezeExtractionPlan({
      episodeId: '33333333-3333-4333-8333-333333333333',
      sourceContentHash: 'b'.repeat(64), sourceScopeVersion: '1', extractorContractVersion: 'v1',
      candidates: [
        { key: 'entity', primitiveKind: 'entity', payload: { name: 'Example Org' } },
        { key: 'edge', primitiveKind: 'edge', payload: { relation: 'works_at' }, dependencyKeys: ['entity'] },
        { key: 'held', primitiveKind: 'task', payload: { title: 'Needs detail' }, terminalDisposition: 'held', terminalReason: 'needs_spec' },
        { key: 'ephemeral', primitiveKind: 'ephemeral', payload: { reason: 'ack-only' }, terminalDisposition: 'rejected', terminalReason: 'ephemeral_ack' },
      ],
    })
    const store = new MemoryApplicationStore()
    const order: string[] = []
    const run = await applyFrozenExtractionPlan({
      store, workspaceId: '44444444-4444-4444-8444-444444444444',
      attemptKey: initialExtractionAttemptKey(frozen.sourceContentHash, frozen.extractorContractVersion),
      plan: frozen,
      mutate: async (candidate, receipts) => {
        if (candidate.primitiveKind === 'edge') {
          expect([...receipts.values()].some((item) => item.primitiveKind === 'entity' && item.disposition === 'committed')).toBe(true)
        }
        order.push(candidate.primitiveKind)
        return { targetRecordId: candidate.primitiveKind }
      },
    })
    expect(order).toEqual(['entity', 'edge'])
    expect(run.applicationState).toBe('complete')
    expect(run.counts).toMatchObject({ committed: 2, held: 1, rejected: 1 })
  })
})
