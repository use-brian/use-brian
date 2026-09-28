import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createConsolidationWorker } from '../worker.js'
import type { MemoryStore, MemoryWithMetrics } from '../../memory/types.js'

// ── Fake store that exercises cadence gating ──

type RunLog = Array<{ phase: string; userId: string }>

function makeFakeStore(opts: {
  users: Array<{ assistantId: string; userId: string }>
  lastPhases: Record<string, { light?: Date; rem?: Date; deep?: Date; reflection?: Date }>
  memories?: MemoryWithMetrics[]
  now?: () => Date
  /** Per-user activity override. Missing keys default to `true` so existing
   *  tests keep the old (ungated) behaviour. */
  recentActivity?: Record<string, boolean>
}): MemoryStore & { runs: RunLog } {
  const runs: RunLog = []
  const memoryIndex = opts.memories ?? []
  const notImpl = () => { throw new Error('not used by worker test') }
  return {
    runs,
    async listMemoryUsers() { return opts.users },
    async getLastPhaseAt(_a, userId, phase) {
      return opts.lastPhases[userId]?.[phase] ?? null
    },
    async hasRecentActivity(_a, userId) {
      return opts.recentActivity?.[userId] ?? true
    },
    async getIndex() {
      // User-facing — unused in worker path; getIndexSystem is what the
      // consolidation phases call.
      return memoryIndex.map((m) => ({ id: m.id, summary: m.summary, tags: m.tags, sensitivity: m.sensitivity }))
    },
    async getIndexSystem() {
      // Seed with enough entries that REM doesn't early-return.
      return memoryIndex.map((m) => ({ id: m.id, summary: m.summary, tags: m.tags, sensitivity: m.sensitivity }))
    },
    async getWorkspaceIndexSystem() { return [] },
    async getIndexRanked() {
      // Worker runs consolidation; it doesn't use the per-turn ranked slice.
      // Returning an empty capped result is safe — nothing in the worker path
      // consumes it.
      return { rows: [], totalCount: 0 }
    },
    async getById() { return null },
    async getByIdSystem() { return null },
    async update() { return null },
    async listWithMetrics() { return memoryIndex },
    async writeConsolidationScore() {},
    async deleteMemory() {},
    async listCronContextCandidatesForPrune() { return [] },
    async listForSoulSynthesis() { return { selfEntityAttributes: null, preferences: [] } },
    async upsertSoul() {},
    async upsertDomainSummary() {},
    async pruneStaleDomainSummaries() { return 0 },
    async logConsolidation(params) {
      runs.push({ phase: params.phase, userId: params.userId })
      if (opts.now) {
        const phases = opts.lastPhases[params.userId] ??= {}
        phases[params.phase] = opts.now()
      }
    },

    // Unused surface methods
    create: notImpl as never,
    getIdentity: notImpl as never,
    search: notImpl as never,
    trackRecall: notImpl as never,
    trackRecallOutcome: notImpl as never,
    getWorkspaceIdentity: notImpl as never,
    getWorkspaceIndex: notImpl as never,
    getWorkspaceMemoriesByCategory: notImpl as never,
    searchTeam: notImpl as never,
    listWorkspaceMemoryGroups: async () => [],
    listTeamWithMetrics: notImpl as never,
    getLastWorkspacePhaseAt: async () => null,
    logWorkspaceConsolidation: async () => {},
    count: notImpl as never,
    getSoul: async () => null,
    listOpenCommitments: async () => [],
    listForReflection: async () => [],
  }
}

const HOUR = 60 * 60 * 1000

describe('[COMP:consolidation/worker] createConsolidationWorker — cadence gating', () => {
  let calls: number
  let callModel: (prompt: string, ctx: { assistantId: string; userId: string | null; workspaceId: string | null; phase: string }) => Promise<string>

  beforeEach(() => {
    calls = 0
    callModel = async () => { calls++; return 'NO_SOUL' }
  })

  it('resolves real reflection authorship once per workspace and respects the primary cadence', async () => {
    const store=makeFakeStore({users:[],lastPhases:{}})
    store.listWorkspaceMemoryGroups=async()=>[
      {assistantId:'department-a',workspaceId:'workspace-fixture'},
      {assistantId:'department-b',workspaceId:'workspace-fixture'},
    ]
    const phases:string[]=[]
    store.getLastWorkspacePhaseAt=async(assistant,_workspace,phase)=>{
      if(phase==='reflection') {phases.push(assistant);return null}
      return new Date()
    }
    store.listForReflection=async()=>Array.from({length:3},(_,i)=>({
      id:`verification-${i}`,action:'edit_summary',primitive:'memory',rowId:'source',rowSummary:null,
      reason:'Department preference',modelValue:'Before',userValue:'After',at:new Date(),
      scopeSources:[{workspaceId:'workspace-fixture',userId:'member',assistantId:null,
        sensitivity:'internal',compartments:['product'],projectIds:[],resourceKind:'memory_verification',resourceId:`verification-${i}`,version:'1'}],
    }))
    const saved:Parameters<MemoryStore['create']>[0][]=[]
    store.create=async params=>{saved.push(params);return{id:'pattern',...params,scope:params.scope??'shared',detail:null,tags:[],confidence:1}}
    const resolve=vi.fn(async()=>({assistantId:'primary-fixture',userId:'owner-fixture'}))
    const model=vi.fn(async()=>JSON.stringify([{summary:'Scoped preference'}]))
    const worker=createConsolidationWorker({store,callModel:model,resolveReflectionPrincipal:resolve,listReflectionWorkspaces:async()=>['workspace-fixture','workspace-fixture']})
    await worker.tick()
    expect(resolve).toHaveBeenCalledExactlyOnceWith('workspace-fixture')
    expect(phases).toEqual(['primary-fixture'])
    expect(model).toHaveBeenCalledOnce()
    expect(saved[0]).toMatchObject({assistantId:'primary-fixture',userId:'owner-fixture',createdByUserId:'owner-fixture'})
    store.listWorkspaceMemoryGroups=async()=>[]
    store.getLastWorkspacePhaseAt=async()=>null
    await worker.tick()
    expect(model).toHaveBeenCalledTimes(2)
    store.getLastWorkspacePhaseAt=async()=>new Date()
    await worker.tick()
    expect(model).toHaveBeenCalledTimes(2)
  })

  it('does not send correction content to a model without a resolved reflection principal',async()=>{
    const store=makeFakeStore({users:[],lastPhases:{}})
    store.listWorkspaceMemoryGroups=async()=>[{assistantId:'department',workspaceId:'workspace-fixture'}]
    store.getLastWorkspacePhaseAt=async(_a,_w,phase)=>phase==='reflection'?null:new Date()
    const read=vi.fn(async()=>[])
    store.listForReflection=read
    const worker=createConsolidationWorker({store,callModel,resolveReflectionPrincipal:async()=>null})
    await worker.tick()
    expect(read).not.toHaveBeenCalled()
    expect(calls).toBe(0)
  })

  it('runs Light + Deep on a fresh user (no prior runs)', async () => {
    const store = makeFakeStore({
      users: [{ assistantId: 'a1', userId: 'u1' }],
      lastPhases: {},
    })
    const worker = createConsolidationWorker({ store, callModel, now: () => new Date('2026-04-10T00:00:00Z') })
    await worker.tick()

    const phases = store.runs.map((r) => r.phase)
    expect(phases).toContain('light')
    expect(phases).toContain('deep')
  })

  it('skips Light when last run was < 6h ago', async () => {
    const now = new Date('2026-04-10T12:00:00Z')
    const store = makeFakeStore({
      users: [{ assistantId: 'a1', userId: 'u1' }],
      lastPhases: { u1: { light: new Date(now.getTime() - 2 * HOUR) } },
    })
    const worker = createConsolidationWorker({ store, callModel, now: () => now })
    await worker.tick()

    expect(store.runs.find((r) => r.phase === 'light')).toBeUndefined()
  })

  it('runs Light when last run was > 6h ago', async () => {
    const now = new Date('2026-04-10T12:00:00Z')
    const store = makeFakeStore({
      users: [{ assistantId: 'a1', userId: 'u1' }],
      lastPhases: { u1: { light: new Date(now.getTime() - 7 * HOUR) } },
    })
    const worker = createConsolidationWorker({ store, callModel, now: () => now })
    await worker.tick()

    expect(store.runs.find((r) => r.phase === 'light')).toBeDefined()
  })

  it('skips Deep when last run was < 24h ago', async () => {
    const now = new Date('2026-04-10T12:00:00Z')
    const store = makeFakeStore({
      users: [{ assistantId: 'a1', userId: 'u1' }],
      lastPhases: { u1: { deep: new Date(now.getTime() - 20 * HOUR) } },
    })
    const worker = createConsolidationWorker({ store, callModel, now: () => now })
    await worker.tick()

    expect(store.runs.find((r) => r.phase === 'deep')).toBeUndefined()
  })

  it('skips REM + Deep for ghost users (no recent activity) but still runs Light', async () => {
    const now = new Date('2026-04-10T12:00:00Z')
    const store = makeFakeStore({
      users: [
        { assistantId: 'a1', userId: 'ghost' },
        { assistantId: 'a1', userId: 'active' },
      ],
      lastPhases: {
        // Make REM due for both so the gate is the only thing that differs.
        ghost:  { rem: new Date(now.getTime() - 8 * 24 * HOUR) },
        active: { rem: new Date(now.getTime() - 8 * 24 * HOUR) },
      },
      recentActivity: { ghost: false, active: true },
      memories: [
        // REM needs >= 15 entries and 3 tag clusters to reach its model call.
        { id: 'm1', type: 'fact', summary: 's1', tags: [], sensitivity: 'public' } as never,
        { id: 'm2', type: 'fact', summary: 's2', tags: [], sensitivity: 'public' } as never,
        { id: 'm3', type: 'fact', summary: 's3', tags: [], sensitivity: 'public' } as never,
        { id: 'm4', type: 'fact', summary: 's4', tags: [], sensitivity: 'public' } as never,
        { id: 'm5', type: 'fact', summary: 's5', tags: [], sensitivity: 'public' } as never,
      ],
    })
    const worker = createConsolidationWorker({ store, callModel, now: () => now })
    await worker.tick()

    // Ghost: Light ran (free), Deep + REM did not.
    expect(store.runs.find((r) => r.phase === 'light' && r.userId === 'ghost')).toBeDefined()
    expect(store.runs.find((r) => r.phase === 'deep' && r.userId === 'ghost')).toBeUndefined()
    expect(store.runs.find((r) => r.phase === 'rem' && r.userId === 'ghost')).toBeUndefined()

    // Active: all three phases still execute.
    expect(store.runs.find((r) => r.phase === 'light' && r.userId === 'active')).toBeDefined()
    expect(store.runs.find((r) => r.phase === 'deep' && r.userId === 'active')).toBeDefined()
  })

  it('records an ineligible REM attempt so it does not repeat every tick', async () => {
    let now = new Date('2026-04-10T12:00:00Z')
    const store = makeFakeStore({
      users: [{ assistantId: 'a1', userId: 'u1' }],
      lastPhases: {
        u1: {
          light: new Date(now.getTime() - HOUR),
          deep: new Date(now.getTime() - HOUR),
        },
      },
      now: () => now,
    })
    const worker = createConsolidationWorker({ store, callModel, now: () => now })
    await worker.tick()

    expect(store.runs.filter((r) => r.phase === 'rem')).toHaveLength(1)
    expect(calls).toBe(0)

    now = new Date(now.getTime() + 15 * 60 * 1000)
    await worker.tick()

    expect(store.runs.filter((r) => r.phase === 'rem')).toHaveLength(1)
    expect(calls).toBe(0)
  })

  it('isolates per-user failures so one bad user does not abort the tick', async () => {
    const now = new Date('2026-04-10T12:00:00Z')
    const store = makeFakeStore({
      users: [
        { assistantId: 'a1', userId: 'bad' },
        { assistantId: 'a1', userId: 'good' },
      ],
      lastPhases: {},
    })
    // Make the first user's scoring loop blow up.
    store.listWithMetrics = async (_a, userId) => {
      if (userId === 'bad') throw new Error('boom')
      return []
    }
    const errors: Array<{ phase: string; userId: string }> = []
    const worker = createConsolidationWorker({
      store,
      callModel,
      now: () => now,
      onError: (_err, ctx) => errors.push({ phase: ctx.phase, userId: ctx.userId }),
    })
    await worker.tick()

    // Bad user raised, but the good user still ran Light + Deep.
    expect(errors.find((e) => e.phase === 'deep' && e.userId === 'bad')).toBeDefined()
    expect(store.runs.find((r) => r.phase === 'deep' && r.userId === 'good')).toBeDefined()
  })

  it('skips tick when advisory lock is held by another instance', async () => {
    const now = new Date('2026-04-10T12:00:00Z')
    const store = makeFakeStore({
      users: [{ assistantId: 'a1', userId: 'u1' }],
      lastPhases: {},
    })
    // Simulate another instance holding the lock — fn is never called
    store.withWorkerLock = async (_lockId, _fn) => false

    const worker = createConsolidationWorker({ store, callModel, now: () => now })
    await worker.tick()

    // No phases should have run
    expect(store.runs).toHaveLength(0)
  })

  it('runs normally when advisory lock is acquired', async () => {
    const now = new Date('2026-04-10T12:00:00Z')
    const store = makeFakeStore({
      users: [{ assistantId: 'a1', userId: 'u1' }],
      lastPhases: {},
    })
    let lockCallbackRan = false
    store.withWorkerLock = async (_lockId, fn) => {
      await fn()
      lockCallbackRan = true
      return true
    }

    const worker = createConsolidationWorker({ store, callModel, now: () => now })
    await worker.tick()

    expect(store.runs.length).toBeGreaterThan(0)
    expect(lockCallbackRan).toBe(true)
  })

  it('scopes onEvent hooks with assistantId + userId context', async () => {
    const now = new Date('2026-04-10T12:00:00Z')
    const store = makeFakeStore({
      users: [{ assistantId: 'a99', userId: 'u42' }],
      lastPhases: {},
    })
    const events: Array<{ type: string; assistantId: string; userId: string }> = []
    const worker = createConsolidationWorker({
      store,
      callModel,
      now: () => now,
      onEvent: (e) => events.push({ type: e.type, assistantId: e.assistantId, userId: e.userId }),
    })
    await worker.tick()

    // At least the Deep phase's consolidation_completed event should fire
    // and arrive scoped.
    const deepEvent = events.find((e) => e.type === 'consolidation_completed')
    expect(deepEvent).toBeDefined()
    expect(deepEvent!.assistantId).toBe('a99')
    expect(deepEvent!.userId).toBe('u42')
  })
})
