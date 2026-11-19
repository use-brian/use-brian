/** [COMP:api/native-chat-read-cost] Media scope obligations stay separate from factual roots. */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { AccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { describe, expect, it, vi } from 'vitest'
import { readConversationPublicationCohorts, readConversationEvidence } from '../conversation-evidence.js'
import { tryValidateNativeScopeEvidence } from '../../context-scope/caller-evidence.js'

const workspaceId = randomUUID(), ownerId = randomUUID()
function source(resourceKind: ScopeSource['resourceKind'], over: Partial<ScopeSource> = {}): ScopeSource {
  return { workspaceId, userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [],
    resourceKind, resourceId: randomUUID(), version: '1', ...over }
}
function client(value: unknown) {
  return { query: vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql === 'SELECT capture_conversation_evidence($1,$2) AS value') return { rows: [{ value }] }
    throw new Error(`Unexpected media scope query: ${sql}`)
  }) } as unknown as Pick<PoolClient, 'query'>
}
const ceiling: AccessCeiling = { workspaceId, userId: ownerId, clearance: 'confidential', compartments: null,
  mutationCompartments: null, projectIds: null, visibilityAssistantIds: null }

describe('[COMP:api/native-chat-read-cost] internal media evidence', () => {
  it('retains media ancestors for current checks without adding them to immutable factual inputs', async () => {
    const field = source('application_field'), episode = source('episode'), recording = source('recording')
    const read = client({ admitted: true, immutable: [field], current: [field, episode, recording] })
    const result = await readConversationEvidence(read, workspaceId, [field])
    expect(result).toMatchObject({ kind: 'complete', current: [field, episode, recording] })
    if (result?.kind !== 'complete') throw new Error('Expected complete fixture proof')
    expect(result.evidence.sources).toEqual([field])
    expect(vi.mocked(read.query).mock.calls.map(([sql])=>sql))
      .toEqual(['SELECT capture_conversation_evidence($1,$2) AS value'])
  })

  it.each(['episode', 'recording'] as const)('keeps %s outside accepted roots and immutable declarations', async kind => {
    const field = source('application_field'), media = source(kind)
    const read = client({ admitted: true, immutable: [field, media], current: [field, media] })
    expect(await readConversationEvidence(read, workspaceId, [field, media])).toBeNull()
    expect(read.query).not.toHaveBeenCalled()
    await expect(readConversationEvidence(read, workspaceId, [field])).rejects.toThrow()
  })

  it('keeps each publication cohort media floor independent', async () => {
    const first = source('application_field'), second = source('application_field')
    const episode = source('episode'), recording = source('recording', { sensitivity: 'confidential' })
    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql === 'SELECT capture_conversation_evidence($1,NULL,NULL,$2) AS value') {
        expect(args).toEqual([workspaceId,JSON.stringify([[first],[second]].map(roots=>roots.map(s=>({kind:s.resourceKind,id:s.resourceId,version:s.version}))))])
        return { rows: [{ value: { admitted: true, cohorts: [
          { immutable: [first], current: [first, episode] },
          { immutable: [second], current: [second, recording] },
        ] } }] }
      }
      throw new Error(`Unexpected media cohort query: ${sql}`)
    })
    const result = await readConversationPublicationCohorts({ query } as unknown as Pick<PoolClient, 'query'>, workspaceId, [[first], [second]])
    expect(query).toHaveBeenCalledTimes(1)
    expect(result?.map(proof => proof.current)).toEqual([[first, episode], [second, recording]])
    expect(result?.map(proof => proof.evidence.sources)).toEqual([[first], [second]])
  })

  it.each(['episode', 'recording'] as const)('still refuses a private %s ancestor for a shared recipient', async kind => {
    const field = source('application_field'), media = source(kind, { userId: ownerId })
    const read = client({ admitted: true, immutable: [field], current: [field, media] })
    await expect(tryValidateNativeScopeEvidence({ sources: [field] }, { ...ceiling, userId: '' }, read, 'audience'))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', diagnostic: 'user_visibility' })
  })

  it('still refuses a media ancestor above the recipient clearance', async () => {
    const field = source('application_field'), media = source('recording', { sensitivity: 'confidential' })
    const read = client({ admitted: true, immutable: [field], current: [field, media] })
    await expect(tryValidateNativeScopeEvidence({ sources: [field] }, { ...ceiling, clearance: 'internal' }, read, 'audience'))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', diagnostic: 'clearance' })
  })

  it('rejects cross-workspace or payload-bearing media scopes', async () => {
    const field = source('application_field'), media = source('recording')
    await expect(readConversationEvidence(client({ admitted: true, immutable: [field], current: [field, { ...media, workspaceId: randomUUID() }] }), workspaceId, [field]))
      .rejects.toThrow('Native session evidence unavailable')
    await expect(readConversationEvidence(client({ admitted: true, immutable: [field], current: [field, { ...media, transcript: 'Fictional forbidden payload' }] }), workspaceId, [field]))
      .rejects.toThrow()
  })

})
