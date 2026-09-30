import { describe, expect, it, vi } from 'vitest'
import type { AccessCeiling, ScopeSource } from '@use-brian/core'

const revalidated = vi.hoisted(() => [] as ScopeSource[][])
vi.mock('../../db/client.js', () => ({
  getPool: () => ({
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  }),
}))
vi.mock('../../db/derived-scope-store.js', () => ({
  revalidateScopeSources: async (_client: unknown, _workspaceId: string, sources: ScopeSource[]) => {
    revalidated.push(sources)
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

describe('[COMP:api/caller-scope-evidence] per-source audience validation', () => {
  it('admits read evidence spanning two assistant partitions of the same user', async () => {
    const sources = [source('own'), source('other', { assistantId: other }), source('shared', { assistantId: null, userId: null })]
    const result = await validateAudienceScopeEvidence({ sources }, ceiling)
    expect(result.sensitivity).toBe('internal')
    expect(revalidated.at(-1)?.map(s => s.resourceId).sort()).toEqual(['other', 'own', 'shared'])
  })

  it('still refuses a source private to another user', async () => {
    await expect(validateAudienceScopeEvidence({ sources: [source('own'), source('foreign', { userId: 'someone-else' })] }, ceiling))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', retrySafe: false })
  })

  it('still refuses an assistant partition outside the receiver grant', async () => {
    await expect(validateCallerScopeEvidence({ sources: [source('own'), source('other', { assistantId: other })] },
      { ...ceiling, visibilityAssistantIds: [primary] }))
      .rejects.toMatchObject({ reason: 'caller_evidence_unavailable' })
  })

  it('still refuses a source above clearance or from another workspace', async () => {
    await expect(validateAudienceScopeEvidence({ sources: [source('secret', { sensitivity: 'confidential' })] }, ceiling))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified' })
    await expect(validateAudienceScopeEvidence({ sources: [source('elsewhere', { workspaceId: 'ws-other' })] }, ceiling))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified' })
  })
})
