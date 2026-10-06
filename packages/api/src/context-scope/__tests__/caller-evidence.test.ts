import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessCeiling, ScopeSource } from '@use-brian/core'
import type { CurrentSourceState } from '../../db/derived-scope-store.js'

const state = vi.hoisted(() => ({
  read: [] as ScopeSource[][],
  next: null as null | ((sources: ScopeSource[]) => CurrentSourceState[]),
}))
vi.mock('../../db/client.js', () => ({ getPool: () => ({}) }))
vi.mock('../../db/derived-scope-store.js', () => ({
  readCurrentScopeSources: async (_client: unknown, _workspaceId: string, sources: ScopeSource[]) => {
    state.read.push(sources)
    return state.next ? state.next(sources) : sources.map(source => ({ state: 'current', source }))
  },
}))

const { validateAudienceScopeEvidence, validateCallerScopeEvidence } = await import('../caller-evidence.js')

const workspaceId = 'ws-fixture'
const userId = 'user-fixture'
const primary = 'assistant-primary'
const other = 'assistant-other'

function source(id: string, over: Partial<ScopeSource> = {}): ScopeSource {
  return {
    workspaceId, userId, assistantId: primary, sensitivity: 'internal',
    compartments: [], projectIds: [], resourceKind: 'memory', resourceId: id, version: '1',
    ...over,
  }
}

const ceiling: AccessCeiling = {
  workspaceId, userId, clearance: 'internal', compartments: null, mutationCompartments: null,
  projectIds: null, visibilityAssistantIds: null,
}

beforeEach(() => { state.read.length = 0; state.next = null })

describe('[COMP:api/caller-scope-evidence] per-source audience validation', () => {
  it('admits read evidence spanning two assistant partitions of the same user', async () => {
    const sources = [source('own'), source('other', { assistantId: other }), source('shared', { assistantId: null, userId: null })]
    const result = await validateAudienceScopeEvidence({ sources }, ceiling)
    expect(result.sensitivity).toBe('internal')
    expect(state.read.at(-1)?.map(s => s.resourceId).sort()).toEqual(['other', 'own', 'shared'])
  })

  it('still refuses a source private to another user, naming the rule internally', async () => {
    await expect(validateAudienceScopeEvidence({ sources: [source('own'), source('foreign', { userId: 'someone-else' })] }, ceiling))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', retrySafe: false, diagnostic: 'user_visibility' })
  })

  it('still refuses an assistant partition outside the receiver grant', async () => {
    await expect(validateCallerScopeEvidence({ sources: [source('own'), source('other', { assistantId: other })] },
      { ...ceiling, visibilityAssistantIds: [primary] }))
      .rejects.toMatchObject({ reason: 'caller_evidence_unavailable', diagnostic: 'assistant_visibility' })
  })

  it('still refuses a source above clearance or from another workspace', async () => {
    await expect(validateAudienceScopeEvidence({ sources: [source('secret', { sensitivity: 'confidential' })] }, ceiling))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', diagnostic: 'clearance' })
    await expect(validateAudienceScopeEvidence({ sources: [source('elsewhere', { workspaceId: 'ws-other' })] }, ceiling))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', diagnostic: 'workspace' })
  })
})

describe('[COMP:api/caller-scope-evidence] current-label revalidation (decision D1)', () => {
  it('delivers when the turn itself edited or removed a source it read', async () => {
    state.next = sources => sources.map((s, i) => i === 0
      ? { state: 'changed', source: s, current: { ...s, sensitivity: 'internal' } }
      : { state: 'gone', source: s })
    const result = await validateAudienceScopeEvidence({ sources: [source('closed-task'), source('deleted-message')] }, ceiling)
    expect(result.sensitivity).toBe('internal')
  })

  it('raises the delivered floor to a source\'s current labels', async () => {
    state.next = sources => sources.map(s => ({ state: 'changed', source: s, current: { ...s, compartments: ['team:sales'] } }))
    const result = await validateCallerScopeEvidence({ sources: [source('task')] }, ceiling)
    expect(result.compartments).toEqual(['team:sales'])
  })

  it('refuses a source reclassified beyond the receiver since it was read', async () => {
    state.next = sources => sources.map(s => ({ state: 'changed', source: s, current: { ...s, sensitivity: 'confidential' } }))
    await expect(validateAudienceScopeEvidence({ sources: [source('reclassified')] }, ceiling))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', diagnostic: 'source_reclassified' })
  })

  it('refuses a held source', async () => {
    state.next = sources => sources.map(s => ({ state: 'held', source: s }))
    await expect(validateAudienceScopeEvidence({ sources: [source('held')] }, ceiling))
      .rejects.toMatchObject({ diagnostic: 'source_held' })
  })

  it('reports a failed lookup as a verification error, not a policy denial', async () => {
    state.next = () => { throw new Error('timeout exceeded when trying to connect') }
    await expect(validateAudienceScopeEvidence({ sources: [source('any')] }, ceiling))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', diagnostic: 'verification_error' })
  })
})

describe('[COMP:api/caller-scope-evidence] model-context history withholds held rows', () => {
  it('every history read in a model-context lane passes excludeHeld', async () => {
    const { readFileSync } = await import('node:fs')
    for (const path of [
      '../../routes/chat.ts',
      '../../routes/public-turn.ts',
      '../../routes/channel-pipeline.ts',
      '../../routes/session-resume-replay.ts',
      '../../routes/_reply-context.ts',
      '../../inter-assistant/executor.ts',
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8')
      // Each call up to its closing paren (these calls never nest parens).
      const calls = [...source.matchAll(/getSessionMessages\([^)]*\)/g)].map((m) => m[0])
      expect(calls.length, path).toBeGreaterThan(0)
      for (const call of calls) expect(call, path).toContain('excludeHeld: true')
    }
  })
})

describe('[COMP:api/caller-scope-evidence] causal inputs stay exact-version', () => {
  it('refuses a CRM event whose content changed since the run read it', async () => {
    state.next = sources => sources.map(s => ({ state: 'stale_input', source: s }))
    await expect(validateCallerScopeEvidence({ sources: [source('event', { resourceKind: 'crm_event' })] }, ceiling))
      .rejects.toMatchObject({ reason: 'caller_evidence_unavailable', diagnostic: 'source_changed' })
  })
})

describe('[COMP:api/caller-scope-evidence] department delivery boundary',()=>{
  const v2:AccessCeiling={...ceiling,departmentRead:{workspaceId,userId,assistantId:primary,
    base:'public',departments:{sales:'confidential'},binding:null,contextDepartment:null,cap:null}}
  it('uses department clearance independently of General and refuses missing departments',async()=>{
    await expect(validateAudienceScopeEvidence({sensitivity:'confidential',compartments:['team:sales']},v2)).resolves.toMatchObject({sensitivity:'confidential'})
    await expect(validateAudienceScopeEvidence({sensitivity:'internal'},v2)).rejects.toMatchObject({diagnostic:'clearance'})
    await expect(validateAudienceScopeEvidence({sensitivity:'public',compartments:['team:finance']},v2)).rejects.toMatchObject({diagnostic:'teams'})
    await expect(validateAudienceScopeEvidence({sensitivity:'public',compartments:['team:sales']},
      {...v2,departmentRead:{...v2.departmentRead!,binding:[]}})).rejects.toMatchObject({diagnostic:'teams'})
  })
  it('checks each source independently so department evidence cannot authorize General secrets',async()=>{
    await expect(validateAudienceScopeEvidence({sources:[
      source('general',{sensitivity:'confidential',compartments:[]}),
      source('sales',{sensitivity:'confidential',compartments:['team:sales']}),
    ]},v2)).rejects.toMatchObject({diagnostic:'clearance'})
  })
  it('blocks a source reclassified into an inaccessible department before delivery',async()=>{
    state.next=sources=>sources.map(s=>({state:'changed',source:s,current:{...s,compartments:['team:finance']}}))
    await expect(validateAudienceScopeEvidence({sources:[source('task',{compartments:['team:sales']})]},v2))
      .rejects.toMatchObject({diagnostic:'source_reclassified'})
  })
})
