import { describe, it, expect } from 'vitest'
import { createPlanTools, seedPlanFromTasks } from '../plan-tools.js'
import type { PlanStepRecord, PlanStore } from '../plan-types.js'
import type { ToolContext } from '../../tools/types.js'

function makeStore(): PlanStore {
  const rows: PlanStepRecord[] = []
  let seq = 0
  return {
    async upsertStep(p) {
      let row = rows.find((r) => r.attemptId === p.attemptId && r.key === p.key)
      if (row) {
        row.description = p.description
        row.position = p.position
        row.attemptState = 'active'
        row.updatedAt = new Date()
      } else {
        row = {
          id: `r${++seq}`,
          sessionId: p.sessionId,
          userId: p.userId,
          assistantId: p.assistantId,
          attemptId: p.attemptId,
          attemptState: 'active',
          key: p.key,
          status: 'pending',
          description: p.description,
          note: null,
          position: p.position,
          source: p.source,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        rows.push(row)
      }
      return { ...row }
    },
    async updateStepStatus(p) {
      const row = rows.find((r) => r.attemptId === p.attemptId && r.key === p.key)
      if (!row) return null
      row.status = p.status
      if (p.note != null) row.note = p.note
      row.updatedAt = new Date()
      return { ...row }
    },
    async listByAttempt(attemptId) {
      return rows
        .filter((r) => r.attemptId === attemptId)
        .sort((a, b) => a.position - b.position)
        .map((r) => ({ ...r }))
    },
    async listActiveBySession(sessionId) {
      return rows
        .filter((r) => r.sessionId === sessionId && r.attemptState === 'active')
        .sort((a, b) => a.position - b.position)
        .map((r) => ({ ...r }))
    },
    async activeAttemptId(sessionId) {
      const a = rows.filter(
        (r) => r.sessionId === sessionId && r.attemptState === 'active',
      )
      return a.length ? a[a.length - 1].attemptId : null
    },
    async setAttemptState(p) {
      let n = 0
      for (const r of rows) {
        if (r.sessionId === p.sessionId && r.attemptId === p.attemptId) {
          r.attemptState = p.state
          n++
        }
      }
      return n
    },
    async recentDormantAttemptId(sessionId) {
      const d = rows.filter(
        (r) => r.sessionId === sessionId && r.attemptState === 'dormant',
      )
      return d.length ? d[d.length - 1].attemptId : null
    },
  }
}

function ctx(): ToolContext {
  return {
    userId: 'u1',
    assistantId: 'a1',
    sessionId: 's1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'web:u1',
    abortSignal: new AbortController().signal,
  }
}

describe('[COMP:plan/tools] Execution-plan tools', () => {
  it('setPlan creates all steps as pending under one active attempt', async () => {
    const store = makeStore()
    const { setPlan } = createPlanTools(store, { newAttemptId: () => 'att-1' })
    await setPlan.execute(
      { steps: [{ key: 'step:a', description: 'A' }, { key: 'step:b', description: 'B' }] },
      ctx(),
    )
    const active = await store.listActiveBySession('s1')
    expect(active).toHaveLength(2)
    expect(active.every((s) => s.status === 'pending')).toBe(true)
    expect(await store.activeAttemptId('s1')).toBe('att-1')
  })

  it('updatePlanStep moves status and records the note', async () => {
    const store = makeStore()
    const { setPlan, updatePlanStep } = createPlanTools(store, { newAttemptId: () => 'att-1' })
    await setPlan.execute({ steps: [{ key: 'step:a', description: 'A' }] }, ctx())
    await updatePlanStep.execute({ key: 'step:a', status: 'done', note: 'found it' }, ctx())
    const [row] = await store.listByAttempt('att-1')
    expect(row.status).toBe('done')
    expect(row.note).toBe('found it')
  })

  it('rejects blocked without a note (escape-hatch discipline)', async () => {
    const store = makeStore()
    const { setPlan, updatePlanStep } = createPlanTools(store, { newAttemptId: () => 'att-1' })
    await setPlan.execute({ steps: [{ key: 'step:a', description: 'A' }] }, ctx())
    const res = await updatePlanStep.execute({ key: 'step:a', status: 'blocked' }, ctx())
    expect(JSON.stringify(res)).toContain('note')
    const [row] = await store.listByAttempt('att-1')
    expect(row.status).toBe('pending') // unchanged
  })

  it('accepts blocked WITH a note', async () => {
    const store = makeStore()
    const { setPlan, updatePlanStep } = createPlanTools(store, { newAttemptId: () => 'att-1' })
    await setPlan.execute({ steps: [{ key: 'step:a', description: 'A' }] }, ctx())
    await updatePlanStep.execute(
      { key: 'step:a', status: 'blocked', note: 'API down' },
      ctx(),
    )
    const [row] = await store.listByAttempt('att-1')
    expect(row.status).toBe('blocked')
    expect(row.note).toBe('API down')
  })

  it('revising a plan keeps statuses, adds new keys pending, marks dropped keys skipped', async () => {
    const store = makeStore()
    const { setPlan, updatePlanStep } = createPlanTools(store, { newAttemptId: () => 'att-1' })
    await setPlan.execute(
      { steps: [{ key: 'step:a', description: 'A' }, { key: 'step:b', description: 'B' }] },
      ctx(),
    )
    await updatePlanStep.execute({ key: 'step:a', status: 'done', note: 'ok' }, ctx())
    // Revise: drop b, keep a, add c.
    await setPlan.execute(
      { steps: [{ key: 'step:a', description: 'A' }, { key: 'step:c', description: 'C' }] },
      ctx(),
    )
    const byKey = Object.fromEntries(
      (await store.listByAttempt('att-1')).map((r) => [r.key, r.status]),
    )
    expect(byKey['step:a']).toBe('done') // preserved
    expect(byKey['step:b']).toBe('skipped') // dropped → skipped, not deleted
    expect(byKey['step:c']).toBe('pending') // new
  })

  it('abandonPlan archives the active attempt', async () => {
    const store = makeStore()
    const { setPlan, abandonPlan } = createPlanTools(store, { newAttemptId: () => 'att-1' })
    await setPlan.execute({ steps: [{ key: 'step:a', description: 'A' }] }, ctx())
    await abandonPlan.execute({}, ctx())
    expect(await store.activeAttemptId('s1')).toBeNull()
    expect(await store.listActiveBySession('s1')).toHaveLength(0)
  })
})

describe('[COMP:plan/auto-seed] seedPlanFromTasks', () => {
  const c = { sessionId: 's1', userId: 'u1', assistantId: 'a1' }

  it('seeds one pending auto-seed step per task', async () => {
    const store = makeStore()
    const seeded = await seedPlanFromTasks(
      store, c, ['research competitor pricing', 'draft the summary'], () => 'att-seed',
    )
    expect(seeded).toBe(true)
    const active = await store.listActiveBySession('s1')
    expect(active).toHaveLength(2)
    expect(active.every((s) => s.status === 'pending')).toBe(true)
    expect(active.every((s) => s.source === 'auto-seed')).toBe(true)
    expect(active[0].description).toBe('research competitor pricing')
  })

  it('no-ops (returns false) when a plan is already active — never clobbers', async () => {
    const store = makeStore()
    const { setPlan } = createPlanTools(store, { newAttemptId: () => 'att-1' })
    await setPlan.execute({ steps: [{ key: 'step:a', description: 'A' }] }, ctx())
    const seeded = await seedPlanFromTasks(store, c, ['something else'], () => 'att-seed')
    expect(seeded).toBe(false)
    const active = await store.listActiveBySession('s1')
    expect(active).toHaveLength(1)
    expect(active[0].key).toBe('step:a') // untouched
  })

  it('no-ops on empty tasks', async () => {
    const store = makeStore()
    expect(await seedPlanFromTasks(store, c, [], () => 'att-seed')).toBe(false)
    expect(await store.listActiveBySession('s1')).toHaveLength(0)
  })
})
