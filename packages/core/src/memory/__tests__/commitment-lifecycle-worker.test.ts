import { describe, it, expect } from 'vitest'
import {
  createCommitmentLifecycleWorker,
  COMMITMENT_OPEN_TAG,
  COMMITMENT_RESOLVED_TAG,
  type CommitmentResolution,
  type CommitmentLifecycleEvent,
} from '../commitment-lifecycle-worker.js'
import type { MemoryRecord, MemoryStore } from '../types.js'

function memory(overrides: Partial<MemoryRecord> & { id: string; tags: string[] }): MemoryRecord {
  return {
    scope: 'shared',
    summary: 'placeholder',
    detail: null,
    confidence: 0.8,
    sensitivity: 'internal',
    ...overrides,
  }
}

type FakeStore = MemoryStore & {
  updates: Array<{ id: string; updates: Parameters<MemoryStore['update']>[1] }>
  openCalls: Array<Parameters<MemoryStore['listOpenCommitments']>[0]>
}

function makeFakeStore(opts: {
  open: MemoryRecord[]
  withWorkerLockResult?: boolean
}): FakeStore {
  const updates: FakeStore['updates'] = []
  const openCalls: FakeStore['openCalls'] = []
  const notImpl = () => { throw new Error('not used by commitment worker test') }
  const store = {
    updates,
    openCalls,
    async listOpenCommitments(params) {
      openCalls.push(params)
      return opts.open
    },
    async update(id, updates_) {
      updates.push({ id, updates: updates_ })
      // Return a synthetic new row with a fresh id (mirrors D.7 supersession).
      const old = opts.open.find((m) => m.id === id)
      if (!old) return null
      return {
        ...old,
        id: `${id}-v2`,
        tags: updates_.tags ?? old.tags,
        summary: updates_.summary ?? old.summary,
        detail: updates_.detail !== undefined ? updates_.detail : old.detail,
      }
    },
    async create() { return notImpl() },
    async getById() { return null },
    async getByIdSystem() { return null },
    async search() { return [] },
    async getIdentity() { return [] },
    async getIndex() { return [] },
    async getIndexSystem() { return [] },
    async getWorkspaceIndexSystem() { return [] },
    async getIndexRanked() { return { rows: [], totalCount: 0 } },
    async trackRecall() {},
    async trackRecallOutcome() {},
    async getSoul() { return null },
    async count() { return 0 },
    async listWithMetrics() { return [] },
    async writeConsolidationScore() {},
    async deleteMemory() {},
    async listCronContextCandidatesForPrune() { return [] },
    async listForSoulSynthesis() { return { selfEntityAttributes: null, preferences: [] } },
    async upsertSoul() {},
    async upsertDomainSummary() {},
    async pruneStaleDomainSummaries() { return 0 },
    async logConsolidation() {},
    async listMemoryUsers() { return [] },
    async getLastPhaseAt() { return null },
    async hasRecentActivity() { return false },
    async getWorkspaceIdentity() { return [] },
    async getWorkspaceIndex() { return [] },
    async getWorkspaceMemoriesByCategory() { return [] },
    async searchTeam() { return [] },
    async listWorkspaceMemoryGroups() { return [] },
    async listTeamWithMetrics() { return [] },
    async getLastWorkspacePhaseAt() { return null },
    async logWorkspaceConsolidation() {},
    async listForReflection() { return [] },
    async withWorkerLock(_id: number, fn: () => Promise<void>) {
      if (opts.withWorkerLockResult === false) return false
      await fn()
      return true
    },
  } as FakeStore
  return store
}

describe('[COMP:brain/commitment-memory-lifecycle-worker] Commitment lifecycle worker', () => {
  it('supersedes open commitment when resolver says resolved', async () => {
    const open = [memory({
      id: 'm1',
      tags: [COMMITMENT_OPEN_TAG, 'commitment:follow_up_due', 'sprint:2026Q3'],
      detail: 'Follow up with Acme by Tue',
    })]
    const store = makeFakeStore({ open })

    const resolver = async (): Promise<CommitmentResolution> => ({
      resolved: true,
      reason: 'deadline passed',
    })

    const events: CommitmentLifecycleEvent[] = []
    const worker = createCommitmentLifecycleWorker({
      store,
      resolver,
      onEvent: (e) => events.push(e),
    })
    await worker.tick()

    expect(store.updates).toHaveLength(1)
    const u = store.updates[0]
    expect(u.id).toBe('m1')
    expect(u.updates.tags).toContain(COMMITMENT_RESOLVED_TAG)
    expect(u.updates.tags).not.toContain(COMMITMENT_OPEN_TAG)
    // Domain tags preserved
    expect(u.updates.tags).toContain('commitment:follow_up_due')
    expect(u.updates.tags).toContain('sprint:2026Q3')
    // Resolution rationale appended to detail
    expect(u.updates.detail).toContain('[resolved] deadline passed')
    expect(u.updates.detail).toContain('Follow up with Acme by Tue')

    // Events
    expect(events.some((e) => e.type === 'scan_started' && e.count === 1)).toBe(true)
    expect(events.some((e) => e.type === 'resolved' && e.memoryId === 'm1')).toBe(true)
    expect(events.some((e) => e.type === 'scan_completed' && e.resolved === 1 && e.openRemaining === 0)).toBe(true)
  })

  it('leaves open commitments untouched when resolver says not resolved', async () => {
    const open = [
      memory({ id: 'm1', tags: [COMMITMENT_OPEN_TAG, 'commitment:sprint_variance'] }),
      memory({ id: 'm2', tags: [COMMITMENT_OPEN_TAG, 'commitment:investor_signal'] }),
    ]
    const store = makeFakeStore({ open })

    const resolver = async (): Promise<CommitmentResolution> => ({ resolved: false })

    const events: CommitmentLifecycleEvent[] = []
    const worker = createCommitmentLifecycleWorker({
      store,
      resolver,
      onEvent: (e) => events.push(e),
    })
    await worker.tick()

    expect(store.updates).toHaveLength(0)
    expect(events.filter((e) => e.type === 'still_open')).toHaveLength(2)
    expect(events.find((e) => e.type === 'scan_completed')).toEqual({
      type: 'scan_completed',
      resolved: 0,
      openRemaining: 2,
    })
  })

  it('isolates per-row resolver failures so the tick drains the rest', async () => {
    const open = [
      memory({ id: 'm-good-1', tags: [COMMITMENT_OPEN_TAG] }),
      memory({ id: 'm-bad', tags: [COMMITMENT_OPEN_TAG] }),
      memory({ id: 'm-good-2', tags: [COMMITMENT_OPEN_TAG] }),
    ]
    const store = makeFakeStore({ open })

    const resolver = async (m: MemoryRecord): Promise<CommitmentResolution> => {
      if (m.id === 'm-bad') throw new Error('boom')
      return { resolved: true, reason: 'ok' }
    }

    const errors: Array<{ id: string; err: unknown }> = []
    const worker = createCommitmentLifecycleWorker({
      store,
      resolver,
      onError: (err, id) => errors.push({ id, err }),
    })
    await worker.tick()

    expect(errors).toHaveLength(1)
    expect(errors[0].id).toBe('m-bad')
    // Good rows still updated
    expect(store.updates.map((u) => u.id).sort()).toEqual(['m-good-1', 'm-good-2'])
  })

  it('re-entry guard: a slow tick blocks the next invocation', async () => {
    const open = [memory({ id: 'm1', tags: [COMMITMENT_OPEN_TAG] })]
    const store = makeFakeStore({ open })

    let resolveSlow: (value: CommitmentResolution) => void = () => {}
    const slowPromise = new Promise<CommitmentResolution>((resolve) => {
      resolveSlow = resolve
    })
    const resolver = (): Promise<CommitmentResolution> => slowPromise

    const worker = createCommitmentLifecycleWorker({ store, resolver })
    const first = worker.tick()
    // Second call while first is mid-flight — should be a no-op.
    const second = worker.tick()
    await second
    expect(store.openCalls).toHaveLength(1)
    resolveSlow({ resolved: false })
    await first
    expect(store.openCalls).toHaveLength(1)
  })

  it('skips work when advisory lock is held by another instance', async () => {
    const open = [memory({ id: 'm1', tags: [COMMITMENT_OPEN_TAG] })]
    const store = makeFakeStore({ open, withWorkerLockResult: false })

    const resolver = async (): Promise<CommitmentResolution> => ({ resolved: true, reason: 'x' })

    const worker = createCommitmentLifecycleWorker({
      store,
      resolver,
      lockId: 900_002,
    })
    await worker.tick()

    expect(store.openCalls).toHaveLength(0)
    expect(store.updates).toHaveLength(0)
  })

  it('supersedeWith content flows through to update', async () => {
    const open = [memory({
      id: 'm1',
      tags: [COMMITMENT_OPEN_TAG, 'commitment:investor_signal'],
      detail: 'Signal: Acme increasing budget',
      summary: 'Acme investor signal',
    })]
    const store = makeFakeStore({ open })

    const resolver = async (): Promise<CommitmentResolution> => ({
      resolved: true,
      reason: 'founder acknowledged',
      supersedeWith: {
        summary: 'Acme investor signal — acknowledged',
        detail: 'Founder acknowledged 2026-05-15; no further action.',
      },
    })

    const worker = createCommitmentLifecycleWorker({ store, resolver })
    await worker.tick()

    expect(store.updates).toHaveLength(1)
    const u = store.updates[0].updates
    expect(u.summary).toBe('Acme investor signal — acknowledged')
    expect(u.detail).toBe('Founder acknowledged 2026-05-15; no further action.')
  })

  it('scope narrows listOpenCommitments query', async () => {
    const store = makeFakeStore({ open: [] })
    const resolver = async (): Promise<CommitmentResolution> => ({ resolved: false })
    const worker = createCommitmentLifecycleWorker({
      store,
      resolver,
      scope: { workspaceId: 'ws-123', assistantId: 'a-456' },
      batchLimit: 50,
    })
    await worker.tick()
    expect(store.openCalls).toEqual([{ workspaceId: 'ws-123', assistantId: 'a-456', limit: 50 }])
  })
})
