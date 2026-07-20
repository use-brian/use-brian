import { describe, it, expect, vi } from 'vitest'
import type { WorkflowRecord, WorkflowTrigger } from '@use-brian/core'
import {
  createWorkflowLifecycleWorker,
  type LifecycleSweepRecord,
  type WorkflowLifecycleAuditEvent,
  type WorkflowLifecycleSkillPort,
  type WorkflowLifecycleSweepStore,
} from '../workflow-lifecycle-worker.js'
import type { WorkflowDigestInput, WorkflowDigestLLM } from '../workflow-digest-llm.js'

const NOW = new Date('2026-07-07T12:00:00Z')

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
}

const MANUAL: WorkflowTrigger = { kind: 'manual' }

function row(overrides: Partial<LifecycleSweepRecord> = {}): LifecycleSweepRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: 'ws-1',
    createdBy: 'user-1',
    name: 'Scheduled reminder',
    description: 'Migrated from a legacy scheduled job (migration 159).',
    trigger: MANUAL,
    enabled: true,
    pinned: false,
    lifecycleState: 'active',
    lifecycleTransitionedAt: null,
    digestedAt: null,
    createdAt: daysAgo(120),
    updatedAt: daysAgo(120),
    lastRunAt: null,
    runCount: 0,
    hasLiveFire: false,
    ...overrides,
  }
}

function record(r: LifecycleSweepRecord): WorkflowRecord {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    createdBy: r.createdBy,
    name: r.name,
    description: r.description,
    definition: {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'Remind me to take the 2pm medication',
        },
      ],
    },
    enabled: r.enabled,
    pausedReason: null,
    trigger: r.trigger,
    webhookSlug: null,
    webhookSecret: null,
    modelAlias: 'pro',
    maxTurns: null,
    researchMode: false,
    nameManuallySet: false,
    lifecycleState: r.lifecycleState,
    lifecycleTransitionedAt: r.lifecycleTransitionedAt,
    lifecycleReason: null,
    pinned: r.pinned,
    digestedAt: r.digestedAt,
    digestVerdict: null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

function makeStore(rows: LifecycleSweepRecord[]) {
  const transitions: Array<{ id: string; state: string; reason: string | null }> = []
  const digested: Array<{ ids: string[]; verdicts: Map<string, string> }> = []
  const deleted: string[] = []
  const store: WorkflowLifecycleSweepStore & {
    transitions: typeof transitions
    digested: typeof digested
    deleted: typeof deleted
  } = {
    transitions,
    digested,
    deleted,
    async listSweepRows() {
      return rows
    },
    async applyTransition(id, state, reason) {
      transitions.push({ id, state, reason })
    },
    async markDigested(ids, verdicts) {
      digested.push({ ids: [...ids].sort(), verdicts })
    },
    async deleteWorkflow(id) {
      deleted.push(id)
      return true
    },
    async getWorkflow(id) {
      const match = rows.find((r) => r.id === id)
      return match ? record(match) : null
    },
  }
  return store
}

function makeSkillPort(overrides: Partial<WorkflowLifecycleSkillPort> = {}) {
  const staged: Array<{ slug: string; approverUserId: string; sourceWorkflowIds: string[] }> = []
  const port: WorkflowLifecycleSkillPort & { staged: typeof staged } = {
    staged,
    async listSkillSummaries() {
      return []
    },
    async hasPendingOrExistingSlug() {
      return false
    },
    async stageCandidate({ umbrella, approverUserId, sourceWorkflowIds }) {
      staged.push({ slug: umbrella.slug, approverUserId, sourceWorkflowIds })
    },
    ...overrides,
  }
  return port
}

const emptyLLM: WorkflowDigestLLM = { plan: async () => ({ candidates: [] }) }

function collectAudits() {
  const audits: WorkflowLifecycleAuditEvent[] = []
  return { audits, emit: (e: WorkflowLifecycleAuditEvent) => void audits.push(e) }
}

describe('[COMP:workers/workflow-lifecycle-worker] Workflow lifecycle sweep', () => {
  it('marks an idle manual workflow stale and audits it', async () => {
    const store = makeStore([row({ updatedAt: daysAgo(40) })])
    const { audits, emit } = collectAudits()
    const worker = createWorkflowLifecycleWorker({ store, emitAudit: emit, now: () => NOW })

    await worker.tick()

    expect(store.transitions).toEqual([
      { id: row().id, state: 'stale', reason: 'no activity for 40 days' },
    ])
    expect(audits.map((a) => a.eventType)).toEqual(['workflow.lifecycle_staled'])
  })

  it('archives a long-stale workflow and hard-deletes an archived one-off past grace', async () => {
    const staleRow = row({
      id: '00000000-0000-4000-8000-00000000000a',
      lifecycleState: 'stale',
      updatedAt: daysAgo(100),
      lifecycleTransitionedAt: daysAgo(70),
    })
    const archivedOneOff = row({
      id: '00000000-0000-4000-8000-00000000000b',
      lifecycleState: 'archived',
      digestedAt: daysAgo(60),
      lifecycleTransitionedAt: daysAgo(31),
      runCount: 1,
    })
    const store = makeStore([staleRow, archivedOneOff])
    const { audits, emit } = collectAudits()
    const worker = createWorkflowLifecycleWorker({ store, emitAudit: emit, now: () => NOW })

    await worker.tick()

    expect(store.transitions).toEqual([
      { id: staleRow.id, state: 'archived', reason: expect.stringContaining('no activity') },
    ])
    expect(store.deleted).toEqual([archivedOneOff.id])
    const deletedAudit = audits.find((a) => a.eventType === 'workflow.lifecycle_deleted')
    expect(deletedAudit?.details).toMatchObject({
      workflowId: archivedOneOff.id,
      name: 'Scheduled reminder',
      triggerKind: 'manual',
      stepCount: 1,
      runCount: 1,
    })
  })

  it('never deletes an archived recurring/multi-run workflow', async () => {
    const archivedRecurring = row({
      lifecycleState: 'archived',
      trigger: { kind: 'schedule', schedule: { type: 'daily', time: '09:00' } },
      enabled: false,
      digestedAt: daysAgo(90),
      lifecycleTransitionedAt: daysAgo(200),
      runCount: 40,
    })
    const store = makeStore([archivedRecurring])
    const worker = createWorkflowLifecycleWorker({ store, now: () => NOW })

    await worker.tick()

    expect(store.deleted).toEqual([])
    expect(store.transitions).toEqual([])
  })

  it('holds deletion of an undigested one-off until the digest pass has seen it', async () => {
    const undigested = row({
      lifecycleState: 'archived',
      digestedAt: null,
      lifecycleTransitionedAt: daysAgo(45),
      runCount: 0,
    })
    const store = makeStore([undigested])
    const skillPort = makeSkillPort()
    const worker = createWorkflowLifecycleWorker({
      store,
      digestLLM: emptyLLM,
      skillPort,
      now: () => NOW,
    })

    await worker.tick()

    // Not deleted this tick — but reviewed by the digest pass (empty plan →
    // not_repeatable), so the NEXT tick may delete it.
    expect(store.deleted).toEqual([])
    expect(store.digested).toHaveLength(1)
    expect(store.digested[0].verdicts.get(undigested.id)).toBeUndefined()
    expect(store.digested[0].ids).toEqual([undigested.id])
  })

  it('digests a stale batch: stages cited candidates with provenance, stamps verdicts', async () => {
    const a = row({
      id: '00000000-0000-4000-8000-0000000000aa',
      lifecycleState: 'stale',
      lifecycleTransitionedAt: daysAgo(10),
      updatedAt: daysAgo(50),
      createdBy: 'user-1',
    })
    const b = row({
      id: '00000000-0000-4000-8000-0000000000bb',
      lifecycleState: 'stale',
      lifecycleTransitionedAt: daysAgo(10),
      updatedAt: daysAgo(60),
      createdBy: 'user-2',
    })
    const c = row({
      id: '00000000-0000-4000-8000-0000000000cc',
      lifecycleState: 'stale',
      lifecycleTransitionedAt: daysAgo(10),
      updatedAt: daysAgo(70),
      createdBy: 'user-1',
    })
    const store = makeStore([a, b, c])
    const skillPort = makeSkillPort()
    const { audits, emit } = collectAudits()
    const planInputs: WorkflowDigestInput[] = []
    const plan = vi.fn(async (input: WorkflowDigestInput) => {
      planInputs.push(input)
      return {
        candidates: [
          {
            slug: 'weekly-reminder-ritual',
            name: 'Weekly reminder ritual',
            description: 'How this team schedules recurring reminders',
            content: '# Weekly reminder ritual\n\n## When to use\n…',
            // c is real, the last id is hallucinated and must be dropped.
            sourceWorkflowIds: [a.id, c.id, '00000000-0000-4000-8000-0000000000ff'],
          },
        ],
      }
    })
    const worker = createWorkflowLifecycleWorker({
      store,
      digestLLM: { plan },
      skillPort,
      emitAudit: emit,
      now: () => NOW,
    })

    await worker.tick()

    expect(skillPort.staged).toEqual([
      {
        slug: 'weekly-reminder-ritual',
        approverUserId: 'user-1', // most common creator among cited (a + c)
        sourceWorkflowIds: [a.id, c.id],
      },
    ])
    expect(store.digested).toHaveLength(1)
    const { ids, verdicts } = store.digested[0]
    expect(ids).toEqual([a.id, b.id, c.id].sort())
    expect(verdicts.get(a.id)).toBe('skill_candidate')
    expect(verdicts.get(c.id)).toBe('skill_candidate')
    expect(verdicts.get(b.id)).toBeUndefined() // uncited → not_repeatable default
    expect(audits.some((e) => e.eventType === 'workflow.digested')).toBe(true)
    // The prompt saw all three workflows with step summaries.
    expect(planInputs[0]?.workflows).toHaveLength(3)
    expect(planInputs[0]?.workflows[0]?.steps[0]?.type).toBe('assistant_call')
  })

  it('skips a candidate whose slug already exists and still stamps the batch', async () => {
    const a = row({
      lifecycleState: 'stale',
      lifecycleTransitionedAt: daysAgo(10),
      updatedAt: daysAgo(50),
    })
    const store = makeStore([a])
    const skillPort = makeSkillPort({
      hasPendingOrExistingSlug: async () => true,
    })
    const worker = createWorkflowLifecycleWorker({
      store,
      digestLLM: {
        plan: async () => ({
          candidates: [
            {
              slug: 'already-exists',
              name: 'Already exists',
              description: 'dup',
              content: '# body',
              sourceWorkflowIds: [a.id],
            },
          ],
        }),
      },
      skillPort,
      now: () => NOW,
    })

    await worker.tick()

    expect(skillPort.staged).toEqual([])
    expect(store.digested).toHaveLength(1)
    expect(store.digested[0].verdicts.get(a.id)).toBeUndefined()
  })

  it('a thrown digest call leaves the batch undigested for the next tick', async () => {
    const a = row({
      lifecycleState: 'stale',
      lifecycleTransitionedAt: daysAgo(10),
      updatedAt: daysAgo(50),
    })
    const store = makeStore([a])
    const events: string[] = []
    const worker = createWorkflowLifecycleWorker({
      store,
      digestLLM: {
        plan: async () => {
          throw new Error('provider down')
        },
      },
      skillPort: makeSkillPort(),
      now: () => NOW,
      onEvent: (e) => events.push(e.type),
    })

    await worker.tick()

    expect(store.digested).toEqual([])
    expect(events).toContain('digest_failed')
  })

  it('never digests active workflows and never touches pinned/armed rows', async () => {
    const active = row({ id: '00000000-0000-4000-8000-0000000000d1', updatedAt: daysAgo(2) })
    const pinned = row({
      id: '00000000-0000-4000-8000-0000000000d2',
      pinned: true,
      updatedAt: daysAgo(400),
    })
    const armed = row({
      id: '00000000-0000-4000-8000-0000000000d3',
      trigger: { kind: 'event', event: { sources: [{ source: { type: 'task' } }] } },
      updatedAt: daysAgo(400),
    })
    const store = makeStore([active, pinned, armed])
    const plan = vi.fn(async () => ({ candidates: [] }))
    const worker = createWorkflowLifecycleWorker({
      store,
      digestLLM: { plan },
      skillPort: makeSkillPort(),
      now: () => NOW,
    })

    await worker.tick()

    expect(store.transitions).toEqual([])
    expect(plan).not.toHaveBeenCalled()
  })

  it('one row failing its transition never aborts the sweep', async () => {
    const bad = row({ id: '00000000-0000-4000-8000-0000000000e1', updatedAt: daysAgo(40) })
    const good = row({ id: '00000000-0000-4000-8000-0000000000e2', updatedAt: daysAgo(40) })
    const store = makeStore([bad, good])
    const original = store.applyTransition.bind(store)
    store.applyTransition = async (id, state, reason) => {
      if (id === bad.id) throw new Error('db hiccup')
      return original(id, state, reason)
    }
    const worker = createWorkflowLifecycleWorker({ store, now: () => NOW })

    await worker.tick()

    expect(store.transitions).toEqual([
      { id: good.id, state: 'stale', reason: expect.any(String) },
    ])
  })

  it('start() is a no-op when disabled (ships dark)', () => {
    const worker = createWorkflowLifecycleWorker({ store: makeStore([]), enabled: false })
    worker.start()
    expect(worker.isRunning).toBe(false)
  })

  it('start() arms the timer when enabled', () => {
    vi.useFakeTimers()
    try {
      const worker = createWorkflowLifecycleWorker({
        store: makeStore([]),
        enabled: true,
        runImmediately: false,
      })
      worker.start()
      expect(worker.isRunning).toBe(true)
      worker.stop()
      expect(worker.isRunning).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
