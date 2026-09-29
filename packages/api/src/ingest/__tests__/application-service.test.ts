import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  emptyApplicationCounts,
  freezeExtractionPlan,
  type AccessContext,
  type ExtractionApplicationClaim,
  type ExtractionApplicationItem,
  type ExtractionApplicationMutation,
  type ExtractionApplicationRun,
  type FrozenCandidate,
} from '@use-brian/core'

import type { DbExtractionApplicationStore } from '../../db/extraction-application-store.js'
import { createIngestApplicationService, IngestApplicationServiceError } from '../application-service.js'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const episodeId = '33333333-3333-4333-8333-333333333333'

function access(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    workspaceId,
    userId,
    assistantId: '44444444-4444-4444-8444-444444444444',
    assistantKind: 'primary',
    clearance: 'confidential',
    mutationCompartments: [],
    projectIds: [],
    ...overrides,
  }
}

function frozenPlan() {
  return freezeExtractionPlan({
    episodeId,
    sourceContentHash: 'a'.repeat(64),
    sourceScopeVersion: '7',
    extractorContractVersion: 'pipeline-b-v1',
    candidates: [
      { key: 'memory', primitiveKind: 'memory', payload: { summary: 'A durable fact' } },
    ],
  })
}

class RecoveryStore implements DbExtractionApplicationStore {
  readonly plan = frozenPlan()
  run: ExtractionApplicationRun
  lease: string | null = null

  constructor() {
    const counts = emptyApplicationCounts()
    counts.failed = 1
    this.run = {
      id: randomUUID(),
      workspaceId,
      episodeId,
      attemptKey: 'initial:source:pipeline-b-v1',
      planHash: this.plan.planHash,
      extractionState: 'succeeded',
      applicationState: 'partial',
      errorCode: null,
      counts,
      items: this.plan.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        primitiveKind: candidate.primitiveKind,
        payloadHash: candidate.payloadHash,
        dependencyIds: candidate.dependencyIds,
        disposition: 'failed',
        targetRecordId: null,
        receiptId: null,
        attemptCount: 1,
        failureCode: 'temporary_store_failure',
        retryable: true,
      })),
    }
  }

  async ensureRun(input: Parameters<DbExtractionApplicationStore['ensureRun']>[0]) {
    if (input.attemptKey !== this.run.attemptKey) throw new Error('retry created a second logical attempt')
    return structuredClone(this.run)
  }

  async claim(
    runId: string,
    expectedPlanHash: string,
    authority?: ExtractionApplicationClaim['authority'],
  ) {
    this.lease = randomUUID()
    return { runId, planHash: expectedPlanHash, leaseToken: this.lease, authority }
  }

  async applyItem(
    _claim: ExtractionApplicationClaim,
    candidate: FrozenCandidate,
    mutate: (context: unknown) => Promise<ExtractionApplicationMutation>,
  ): Promise<ExtractionApplicationItem> {
    const result = await mutate({ kind: 'test-transaction' })
    const item = this.run.items.find((entry) => entry.candidateId === candidate.candidateId)!
    Object.assign(item, {
      disposition: result.disposition ?? 'committed',
      targetRecordId: result.targetRecordId ?? null,
      receiptId: randomUUID(),
      attemptCount: item.attemptCount + 1,
      failureCode: result.safeCode ?? null,
      retryable: false,
    })
    return structuredClone(item)
  }

  async recordFailure(
    _claim: ExtractionApplicationClaim,
    _candidateId: string,
    _failure: { code: string; retryable: boolean },
  ): Promise<ExtractionApplicationItem> {
    throw new Error('unexpected failure')
  }

  async finish() {
    const counts = emptyApplicationCounts()
    for (const item of this.run.items) counts[item.disposition] += 1
    this.run.counts = counts
    this.run.applicationState = 'complete'
    return structuredClone(this.run)
  }

  async getRun(runId: string) { return runId === this.run.id ? structuredClone(this.run) : null }

  async getAuthorized(ctx: AccessContext, requestedEpisodeId: string, runId?: string) {
    if (ctx.workspaceId !== workspaceId || requestedEpisodeId !== episodeId) return null
    if (runId && runId !== this.run.id) return null
    return structuredClone(this.run)
  }

  async listAuthorized(ctx: AccessContext) {
    return { runs: ctx.workspaceId === workspaceId ? [structuredClone(this.run)] : [], nextCursor: null }
  }

  async getFrozenPlan(runId: string) {
    return runId === this.run.id ? structuredClone(this.plan) : null
  }
}

function service(store = new RecoveryStore(), role: 'owner' | 'admin' | 'member' | null = 'owner') {
  const mutateCandidate = vi.fn(async () => ({ targetRecordId: randomUUID() }))
  const extract = vi.fn()
  return {
    store,
    mutateCandidate,
    extract,
    value: createIngestApplicationService({
      store,
      episodes: {
        getEpisodeById: vi.fn(async (ctx: AccessContext, id: string) =>
          ctx.workspaceId === workspaceId && id === episodeId ? { id } : null),
      } as never,
      mutateCandidate,
      getWorkspaceRole: vi.fn(async () => role),
    }),
  }
}

describe('[COMP:api/ingest-application] application recovery service', () => {
  it('I1/I5 resumes the named frozen run without extraction or a second logical attempt', async () => {
    const fixture = service()
    const result = await fixture.value.retry({
      ctx: access(),
      episodeId,
      runId: fixture.store.run.id,
      expectedPlanHash: fixture.store.run.planHash,
    })

    expect(result).toMatchObject({ applicationState: 'complete', counts: { committed: 1, failed: 0 } })
    expect(fixture.mutateCandidate).toHaveBeenCalledTimes(1)
    expect(fixture.extract).not.toHaveBeenCalled()
  })

  it('I5 rejects stale plan hashes as conflicts before applying', async () => {
    const fixture = service()
    await expect(fixture.value.retry({
      ctx: access(), episodeId, runId: fixture.store.run.id, expectedPlanHash: 'stale',
    })).rejects.toMatchObject({ code: 'conflict' } satisfies Partial<IngestApplicationServiceError>)
    expect(fixture.mutateCandidate).not.toHaveBeenCalled()
  })

  it('I4/I5 requires both administrator role and verified mutation authority', async () => {
    const member = service(new RecoveryStore(), 'member')
    await expect(member.value.retry({
      ctx: access(), episodeId, runId: member.store.run.id, expectedPlanHash: member.store.run.planHash,
    })).rejects.toMatchObject({ code: 'forbidden' })

    const owner = service()
    await expect(owner.value.retry({
      ctx: access({ mutationCompartments: undefined }),
      episodeId,
      runId: owner.store.run.id,
      expectedPlanHash: owner.store.run.planHash,
    })).rejects.toMatchObject({ code: 'forbidden' })
    expect(owner.mutateCandidate).not.toHaveBeenCalled()
  })
})
