import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessCeiling, ScopeSource } from '@use-brian/core'
import { bindScopeSource, createdRowEvidence, scopeEvidenceFromRows } from '@use-brian/core'
import type { CurrentSourceState } from '../../db/derived-scope-store.js'

const state = vi.hoisted(() => ({
  read: [] as ScopeSource[][],
  next: null as null | ((sources: ScopeSource[]) => CurrentSourceState[]),
}))
vi.mock('../../db/client.js', () => {
  // These fixtures have no retained/field/external ancestors, and one empty
  // Page-dependency result for each ordinary root.
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.includes(' AS dependencies')) return { rows: (values[1] as string[]).map(() => ({ dependencies: [] })) }
    if (/application_scope_lineage|read_application_field_dependencies|read_external_source_dependencies/.test(sql)) return { rows: [] }
    throw new Error('Unexpected caller-evidence fixture query')
  }
  return { getPool: () => ({ query }), query }
})
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
  it('admits a newly saved note without treating the note as private context read by the group', async () => {
    const memory = bindScopeSource({ id: 'just-created', summary: 'Remember the course registration deadline' }, source('just-created'))
    const group = { ...ceiling, userId: '' }
    // Deployed saveMemory returned this full read-source evidence. The
    // executor adds it before the tool-result event can be recorded.
    await expect(validateAudienceScopeEvidence(scopeEvidenceFromRows([memory]), group))
      .rejects.toMatchObject({ diagnostic: 'user_visibility' })
    await expect(validateAudienceScopeEvidence(createdRowEvidence([memory]), group))
      .resolves.toMatchObject({ sensitivity: 'internal' })
    // A real read of the same personal memory must remain forbidden.
    await expect(validateAudienceScopeEvidence(scopeEvidenceFromRows([memory]), group))
      .rejects.toMatchObject({ diagnostic: 'user_visibility' })
  })
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

describe('[COMP:api/caller-scope-evidence] pure department envelopes',()=>{
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
})
