import { describe, expect, it } from 'vitest'
import type { AccessCeiling, ScopeSource } from '@use-brian/core'
import { validateAudienceScopeEvidence, validateCallerScopeEvidence } from '../caller-evidence.js'

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

describe('[COMP:api/caller-scope-evidence] pure envelope limits', () => {
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
