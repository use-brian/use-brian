import { describe, it, expect } from 'vitest'
import { buildActivePlanBlock } from '../plan-context.js'
import type { PlanStepRecord, PlanStepStatus, PlanStore } from '../plan-types.js'

function rec(
  key: string,
  status: PlanStepStatus,
  position: number,
  note: string | null = null,
): PlanStepRecord {
  return {
    id: key,
    sessionId: 's1',
    userId: 'u1',
    assistantId: 'a1',
    attemptId: 'att-1',
    attemptState: 'active',
    key,
    status,
    description: `do ${key}`,
    note,
    position,
    source: 'tool',
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

/** Minimal store: only `listActiveBySession` is exercised by the builder. */
function storeOf(rows: PlanStepRecord[]): PlanStore {
  const unused = () => {
    throw new Error('not used in this test')
  }
  return {
    listActiveBySession: async () =>
      [...rows].sort((a, b) => a.position - b.position),
    upsertStep: unused as never,
    updateStepStatus: unused as never,
    listByAttempt: unused as never,
    activeAttemptId: unused as never,
    setAttemptState: unused as never,
    recentDormantAttemptId: unused as never,
  }
}

describe('[COMP:plan/context] # Active plan block', () => {
  it('returns null when there is no active attempt', async () => {
    const block = await buildActivePlanBlock({ store: storeOf([]), sessionId: 's1' })
    expect(block).toBeNull()
  })

  it('renders the header, the drive instruction, and each step with its status', async () => {
    const block = await buildActivePlanBlock({
      store: storeOf([
        rec('step:a', 'done', 0, 'found 3 prices'),
        rec('step:b', 'in_progress', 1),
        rec('step:c', 'pending', 2),
      ]),
      sessionId: 's1',
    })
    expect(block).toContain('# Active plan')
    expect(block).toContain('do not end your turn')
    expect(block).toContain('[done] step:a')
    expect(block).toContain('found 3 prices')
    expect(block).toContain('[in_progress] step:b')
    expect(block).toContain('[pending] step:c')
  })

  it('never trims open rows even under a tiny budget', async () => {
    const block = await buildActivePlanBlock({
      store: storeOf([
        rec('step:done1', 'done', 0, 'x'.repeat(500)),
        rec('step:open1', 'pending', 1),
        rec('step:open2', 'in_progress', 2),
      ]),
      sessionId: 's1',
      tokenBudget: 1, // force trimming
    })
    // Open rows are load-bearing and survive; the closed one is trimmed.
    expect(block).toContain('step:open1')
    expect(block).toContain('step:open2')
    expect(block).not.toContain('step:done1')
  })
})
