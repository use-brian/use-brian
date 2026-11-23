import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { createdRowEvidence, scopeEvidenceFromRows } from '@use-brian/agent-runtime/security/context-scope.js'
import { bindScopeSource } from '@use-brian/agent-runtime/security/source-evidence.js'
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
  it('preserves safe native-proof cancellation metadata without changing the refusal', async () => {
    const databaseError = Object.assign(new Error('PRIVATE SQL and source id'), { code: '57014' })
    const client = { query: vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql === 'SELECT to_regprocedure($1) IS NOT NULL AS available') {
        expect(args).toEqual(['public.capture_conversation_evidence(uuid,jsonb)'])
        return { rows: [{ available: false }] }
      }
      if (sql === 'SELECT capture_conversation_evidence($1,$2) AS value') throw databaseError
      throw new Error(`Unexpected native-proof query: ${sql}`)
    }) }
    await expect(validateAudienceScopeEvidence({ sources: [source('field', { resourceKind: 'application_field' })] }, ceiling, client as never))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', retrySafe: false, diagnostic: 'source_unverifiable',
        verificationPhase: 'native_proof', verificationSqlstateClass: '57', cause: databaseError })
    expect(client.query.mock.calls.map(([sql])=>sql).filter(sql=>!sql.includes('to_regprocedure')))
      .toEqual(['SELECT capture_conversation_evidence($1,$2) AS value'])
    expect(state.read).toHaveLength(0)
  })

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
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    // Each call up to its closing paren (these calls never nest parens).
    const directReads = (source: string) => [...source.matchAll(/getSessionMessages\([^)]*\)/g)].map((m) => m[0])
    // Since the D9 transfer the main-turn history read of these lanes belongs
    // to the original turn owner (`prepareHistory`, turn-kernel.md "Turn
    // history acquisition"); its stored reader is the one read site for every
    // non-native lane, durable resume and delegated consults included.
    const lanes: Record<string, string | null> = {
      '../../routes/chat.ts': 'ownedTurn.prepareHistory({',
      '../../routes/public-turn.ts': 'capabilityOwner.prepareHistory({ native: null,',
      '../../routes/channel-pipeline.ts': 'turnOwner.prepareHistory({',
      '../../routes/session-resume-replay.ts': 'owner.prepareHistory({ native: null,',
      '../../routes/_reply-context.ts': null,
      '../../inter-assistant/executor.ts': 'owner.prepareHistory({ native: null,',
      // The routing adapter receives captures from its routes; it never reads.
      '../../routes/attended-turn-routing.ts': null,
    }
    for (const [path, owner] of Object.entries(lanes)) {
      const source = read(path)
      const calls = directReads(source)
      for (const call of calls) expect(call, path).toContain('excludeHeld: true')
      if (owner) expect(source, `${path} must read its turn history through the owner`).toContain(owner)
      if (path !== '../../routes/attended-turn-routing.ts') expect(calls.length + (owner ? 1 : 0), path).toBeGreaterThan(0)
    }
    expect(read('../../turn/kernel.ts')).toContain('const read = captureTurnHistory(preparation.sessionId, request)')
    // The owner's stored reader: exactly one read, held rows withheld after the
    // caller's options so no option can re-admit them.
    const history = read('../../turn/history.ts')
    expect(directReads(history)).toEqual(['getSessionMessages(sessionId, { ...options, excludeHeld: true })'])
  })

  it('the owner\'s stored history reader withholds held rows on every request', async () => {
    const getSessionMessages = vi.fn(async () => [])
    vi.resetModules()
    vi.doMock('../../db/sessions.js', async original => ({ ...await original<typeof import('../../db/sessions.js')>(), getSessionMessages }))
    try {
      const { captureTurnHistory } = await import('../../turn/history.js')
      await captureTurnHistory('session-fixture', { native: null })()
      await captureTurnHistory('session-fixture', { native: null, fromSequence: 7 })()
      await captureTurnHistory('session-fixture', { native: null, fromSequence: null, projectStored: async rows => rows })()
      expect(getSessionMessages.mock.calls).toEqual([
        ['session-fixture', { excludeHeld: true }],
        ['session-fixture', { fromSequence: 7, excludeHeld: true }],
        ['session-fixture', { fromSequence: null, excludeHeld: true }],
      ])
    } finally {
      vi.doUnmock('../../db/sessions.js')
      vi.resetModules()
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
