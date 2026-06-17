import { describe, expect, it, vi } from 'vitest'

import { createCircuitBreaker, createInMemoryCounterStore } from '../../circuit-breaker.js'
import { createClassifierSelfHealWorker } from '../worker.js'
import type {
  EntityCentralityScannerPort,
  EntityKindReclassifierPort,
} from '../worker.js'
import type { Classifier, ClassifierDecision } from '../../types.js'
import type { EntityKind, EntityRecord } from '../../../entities/types.js'
import type { PendingClassificationStore } from '../../pending-queue.js'

const NOW = new Date('2026-05-28T10:00:00Z')

function makeEntity(p: Partial<EntityRecord> & Pick<EntityRecord, 'id'>): EntityRecord {
  return {
    id: p.id,
    kind: p.kind ?? 'project',
    displayName: p.displayName ?? 'whatever',
    canonicalId: p.canonicalId ?? null,
    aliases: p.aliases ?? [],
    attributes: p.attributes ?? {},
    sensitivity: 'internal',
    workspaceId: p.workspaceId ?? 'ws-1',
    userId: null,
    assistantId: null,
    createdByUserId: 'user-1',
    createdByAssistantId: null,
    sourceEpisodeId: null,
    source: 'extracted',
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: NOW,
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    centrality: 0,
    centralityComputedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function stubScanner(entitiesByWorkspace: Record<string, EntityRecord[]>): EntityCentralityScannerPort {
  return {
    scanByCentrality: vi.fn(async (ws) => entitiesByWorkspace[ws] ?? []),
  }
}

function stubReclassifier(): EntityKindReclassifierPort & {
  reclassifyCalls: Array<{ id: string; kind: EntityKind }>
  promoteCalls: Array<{ id: string; kind: 'person' | 'company' | 'deal' }>
} {
  const reclassifyCalls: Array<{ id: string; kind: EntityKind }> = []
  const promoteCalls: Array<{ id: string; kind: 'person' | 'company' | 'deal' }> = []
  return {
    reclassifyCalls,
    promoteCalls,
    reclassifyEntityKind: vi.fn(async (_u, id, kind) => {
      reclassifyCalls.push({ id, kind })
      return null
    }),
    promoteEntityToCrm: vi.fn(async (_u, id, kind) => {
      promoteCalls.push({ id, kind })
      return null
    }),
  }
}

function stubPendingQueue(): PendingClassificationStore & { enqueued: unknown[] } {
  const enqueued: unknown[] = []
  return {
    enqueued,
    enqueue: vi.fn(async (params) => {
      enqueued.push(params)
      return {
        id: `pc-${enqueued.length}`,
        workspaceId: params.workspaceId,
        primitiveKind: params.primitiveKind,
        targetId: params.targetId,
        currentValue: params.currentValue,
        suggestedValue: params.suggestedValue,
        ruleId: params.ruleId,
        confidence: params.confidence,
        detectedAt: NOW,
        detectedByBoundary: params.detectedByBoundary,
        resolvedAt: null,
        resolvedByUserId: null,
        resolution: null,
      }
    }),
    listUnresolvedForWorkspace: vi.fn(async () => []),
    resolve: vi.fn(async () => null),
    autoDismissStale: vi.fn(async () => 0),
    getById: vi.fn(async () => null),
  } as unknown as PendingClassificationStore & { enqueued: unknown[] }
}

function stubClassifier(decisionForKind: Record<string, ClassifierDecision<EntityKind>>): Classifier<EntityKind> {
  return {
    classify: () => [],
    decide: (c) => decisionForKind[(c.proposed ?? '') as string] ?? { kind: 'no_signal' },
  }
}

function overrideDecision(value: EntityKind, ruleId = 'r-x'): ClassifierDecision<EntityKind> {
  return {
    kind: 'override',
    match: {
      rule_id: ruleId,
      value,
      confidence: 1.0,
      tier: 'deterministic',
    },
  }
}

function hintDecision(value: EntityKind, confidence: number, ruleId = 'r-prob'): ClassifierDecision<EntityKind> {
  return {
    kind: 'hint',
    matches: [{ rule_id: ruleId, value, confidence, tier: 'probabilistic' }],
  }
}

describe('[COMP:classification/self-heal-worker] createClassifierSelfHealWorker', () => {
  it('reclassifies deterministic non-CRM mismatch via reclassifyEntityKind', async () => {
    const entity = makeEntity({ id: 'e-1', kind: 'project' })
    const worker = createClassifierSelfHealWorker({
      classifier: stubClassifier({ project: overrideDecision('repository') }),
      entities: {} as never,
      scanner: stubScanner({ 'ws-1': [entity] }),
      reclassifier: stubReclassifier(),
      pendingQueue: stubPendingQueue(),
      workspaces: async () => [{ workspaceId: 'ws-1', actorUserId: 'sys' }],
      systemActorUserId: 'sys',
    })
    const result = await worker.tick()
    expect(result.overrides).toBe(1)
    expect(result.enqueued).toBe(0)
  })

  it('promotes non-CRM → CRM via promoteEntityToCrm', async () => {
    const entity = makeEntity({ id: 'e-1', kind: 'project' })
    const reclassifier = stubReclassifier()
    const worker = createClassifierSelfHealWorker({
      classifier: stubClassifier({ project: overrideDecision('company') }),
      entities: {} as never,
      scanner: stubScanner({ 'ws-1': [entity] }),
      reclassifier,
      pendingQueue: stubPendingQueue(),
      workspaces: async () => [{ workspaceId: 'ws-1', actorUserId: 'sys' }],
      systemActorUserId: 'sys',
    })
    await worker.tick()
    expect(reclassifier.promoteCalls).toEqual([{ id: 'e-1', kind: 'company' }])
    expect(reclassifier.reclassifyCalls).toEqual([])
  })

  it('blocks CRM → non-CRM demote, enqueues for manual resolution', async () => {
    const entity = makeEntity({ id: 'e-1', kind: 'company' })
    const queue = stubPendingQueue()
    const reclassifier = stubReclassifier()
    const worker = createClassifierSelfHealWorker({
      classifier: stubClassifier({ company: overrideDecision('project') }),
      entities: {} as never,
      scanner: stubScanner({ 'ws-1': [entity] }),
      reclassifier,
      pendingQueue: queue,
      workspaces: async () => [{ workspaceId: 'ws-1', actorUserId: 'sys' }],
      systemActorUserId: 'sys',
    })
    const result = await worker.tick()
    expect(result.overrides).toBe(0)
    expect(result.enqueued).toBe(1)
    expect(reclassifier.reclassifyCalls).toEqual([])
    expect(reclassifier.promoteCalls).toEqual([])
    expect(queue.enqueued).toHaveLength(1)
  })

  it('probabilistic mismatch above hintThreshold enqueues; below skips', async () => {
    const entity = makeEntity({ id: 'e-1', kind: 'project' })
    const queue = stubPendingQueue()
    // High-confidence hint
    const workerHigh = createClassifierSelfHealWorker({
      classifier: stubClassifier({ project: hintDecision('repository', 0.8) }),
      entities: {} as never,
      scanner: stubScanner({ 'ws-1': [entity] }),
      reclassifier: stubReclassifier(),
      pendingQueue: queue,
      workspaces: async () => [{ workspaceId: 'ws-1', actorUserId: 'sys' }],
      systemActorUserId: 'sys',
    })
    await workerHigh.tick()
    expect(queue.enqueued).toHaveLength(1)

    // Low-confidence hint (under default 0.7)
    const queueLow = stubPendingQueue()
    const workerLow = createClassifierSelfHealWorker({
      classifier: stubClassifier({ project: hintDecision('repository', 0.5) }),
      entities: {} as never,
      scanner: stubScanner({ 'ws-1': [entity] }),
      reclassifier: stubReclassifier(),
      pendingQueue: queueLow,
      workspaces: async () => [{ workspaceId: 'ws-1', actorUserId: 'sys' }],
      systemActorUserId: 'sys',
    })
    await workerLow.tick()
    expect(queueLow.enqueued).toHaveLength(0)
  })

  it('no-op when classifier returns kind === entity.kind (already correct)', async () => {
    const entity = makeEntity({ id: 'e-1', kind: 'project' })
    const reclassifier = stubReclassifier()
    const worker = createClassifierSelfHealWorker({
      classifier: stubClassifier({ project: overrideDecision('project') }),
      entities: {} as never,
      scanner: stubScanner({ 'ws-1': [entity] }),
      reclassifier,
      pendingQueue: stubPendingQueue(),
      workspaces: async () => [{ workspaceId: 'ws-1', actorUserId: 'sys' }],
      systemActorUserId: 'sys',
    })
    const result = await worker.tick()
    expect(result.overrides).toBe(0)
    expect(reclassifier.reclassifyCalls).toEqual([])
  })

  it('circuit breaker suspends override but counts as skippedSuspended', async () => {
    const entity = makeEntity({ id: 'e-1', kind: 'project' })
    const breaker = createCircuitBreaker(createInMemoryCounterStore(), { hourlyCap: 1 })
    // Pre-trip the breaker for this rule
    await breaker.record('ws-1', 'r-x', 'self_heal')

    const reclassifier = stubReclassifier()
    const worker = createClassifierSelfHealWorker({
      classifier: stubClassifier({ project: overrideDecision('repository', 'r-x') }),
      entities: {} as never,
      scanner: stubScanner({ 'ws-1': [entity] }),
      reclassifier,
      pendingQueue: stubPendingQueue(),
      workspaces: async () => [{ workspaceId: 'ws-1', actorUserId: 'sys' }],
      circuitBreaker: breaker,
      systemActorUserId: 'sys',
    })
    const result = await worker.tick()
    expect(result.skippedSuspended).toBe(1)
    expect(result.overrides).toBe(0)
    expect(reclassifier.reclassifyCalls).toEqual([])
  })

  it('iterates across multiple workspaces', async () => {
    const e1 = makeEntity({ id: 'e-1', kind: 'project', workspaceId: 'ws-1' })
    const e2 = makeEntity({ id: 'e-2', kind: 'project', workspaceId: 'ws-2' })
    const worker = createClassifierSelfHealWorker({
      classifier: stubClassifier({ project: overrideDecision('repository') }),
      entities: {} as never,
      scanner: stubScanner({ 'ws-1': [e1], 'ws-2': [e2] }),
      reclassifier: stubReclassifier(),
      pendingQueue: stubPendingQueue(),
      workspaces: async () => [{ workspaceId: 'ws-1', actorUserId: 'sys' }, { workspaceId: 'ws-2', actorUserId: 'sys' }],
      systemActorUserId: 'sys',
    })
    const result = await worker.tick()
    expect(result.workspacesScanned).toBe(2)
    expect(result.entitiesScanned).toBe(2)
    expect(result.overrides).toBe(2)
  })

  it('error in one entity does not abort the rest of the batch', async () => {
    const e1 = makeEntity({ id: 'e-1', kind: 'project' })
    const e2 = makeEntity({ id: 'e-2', kind: 'project' })
    const reclassifier = stubReclassifier()
    // First call throws, second succeeds
    let callIdx = 0
    reclassifier.reclassifyEntityKind = vi.fn(async (_u, id, kind) => {
      callIdx++
      if (callIdx === 1) throw new Error('synthetic')
      reclassifier.reclassifyCalls.push({ id, kind })
      return null
    })
    const errors: unknown[] = []
    const worker = createClassifierSelfHealWorker({
      classifier: stubClassifier({ project: overrideDecision('repository') }),
      entities: {} as never,
      scanner: stubScanner({ 'ws-1': [e1, e2] }),
      reclassifier,
      pendingQueue: stubPendingQueue(),
      workspaces: async () => [{ workspaceId: 'ws-1', actorUserId: 'sys' }],
      systemActorUserId: 'sys',
      onError: (err) => errors.push(err),
    })
    const result = await worker.tick()
    expect(result.entitiesScanned).toBe(2)
    expect(result.overrides).toBe(1)
    expect(result.errors).toBe(1)
    expect(errors).toHaveLength(1)
  })
})
