/** [COMP:api/native-chat-read-cost] Media scope obligations stay separate from factual roots. */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { AccessCeiling, ScopeSource } from '@use-brian/core'
import { describe, expect, it, vi } from 'vitest'
import { readNativePublicationCohorts, readNativeSessionEvidence } from '../native-session-evidence.js'
import { readNativeSessionQueryEvidence } from '../native-session-query-evidence.js'
import { tryValidateNativeCombinedOutputEvidence } from '../../context-scope/caller-evidence.js'

const workspaceId = randomUUID(), ownerId = randomUUID()
function source(resourceKind: ScopeSource['resourceKind'], over: Partial<ScopeSource> = {}): ScopeSource {
  return { workspaceId, userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [],
    resourceKind, resourceId: randomUUID(), version: '1', ...over }
}
function client(value: unknown) {
  return { query: vi.fn(async (sql: string, args?: unknown[]) => {
    if (sql === 'SELECT to_regprocedure($1) IS NOT NULL AS available') {
      expect(args).toEqual(['public.read_native_retained_scope_evidence(uuid,jsonb)'])
      return { rows: [{ available: false }] }
    }
    if (sql === 'SELECT read_native_turn_scope_evidence($1,$2) AS value') return { rows: [{ value }] }
    throw new Error(`Unexpected media scope query: ${sql}`)
  }) } as unknown as Pick<PoolClient, 'query'>
}
const ceiling: AccessCeiling = { workspaceId, userId: ownerId, clearance: 'confidential', compartments: null,
  mutationCompartments: null, projectIds: null, visibilityAssistantIds: null }

describe('[COMP:api/native-chat-read-cost] internal media evidence', () => {
  it('retains media ancestors for current checks without adding them to immutable factual inputs', async () => {
    const field = source('application_field'), episode = source('episode'), recording = source('recording')
    const read = client({ admitted: true, immutable: [field], current: [field, episode, recording] })
    const result = await readNativeSessionEvidence(read, workspaceId, [field])
    expect(result).toMatchObject({ kind: 'complete', current: [field, episode, recording] })
    if (result?.kind !== 'complete') throw new Error('Expected complete fixture proof')
    expect(result.evidence.sources).toEqual([field])
    expect(vi.mocked(read.query).mock.calls.map(([sql])=>sql).filter(sql=>typeof sql==='string'&&!sql.includes('to_regprocedure')))
      .toEqual(['SELECT read_native_turn_scope_evidence($1,$2) AS value'])
  })

  it.each(['episode', 'recording'] as const)('keeps %s outside accepted roots and immutable declarations', async kind => {
    const field = source('application_field'), media = source(kind)
    const read = client({ admitted: true, immutable: [field, media], current: [field, media] })
    expect(await readNativeSessionEvidence(read, workspaceId, [field, media])).toBeNull()
    expect(read.query).not.toHaveBeenCalled()
    await expect(readNativeSessionEvidence(read, workspaceId, [field])).rejects.toThrow()
  })

  it('keeps each publication cohort media floor independent', async () => {
    const first = source('application_field'), second = source('application_field')
    const episode = source('episode'), recording = source('recording', { sensitivity: 'confidential' })
    const query = vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql === 'SELECT to_regprocedure($1) IS NOT NULL AS available') {
        expect(args).toEqual(['public.read_native_retained_publication_cohorts(uuid,jsonb)'])
        return { rows: [{ available: false }] }
      }
      if (sql === "SELECT to_regprocedure('public.read_native_turn_publication_cohorts(uuid,jsonb)') IS NOT NULL AS available") return { rows: [{ available: true }] }
      if (sql === 'SELECT read_native_turn_publication_cohorts($1,$2) AS value') return { rows: [{ value: { admitted: true, cohorts: [
        { immutable: [first], current: [first, episode] }, { immutable: [second], current: [second, recording] },
      ] } }] }
      throw new Error(`Unexpected media cohort query: ${sql}`)
    })
    const result = await readNativePublicationCohorts({ query } as unknown as Pick<PoolClient, 'query'>, workspaceId, [[first], [second]])
    expect(result?.map(proof => proof.current)).toEqual([[first, episode], [second, recording]])
    expect(result?.map(proof => proof.evidence.sources)).toEqual([[first], [second]])
  })

  it.each(['episode', 'recording'] as const)('still refuses a private %s ancestor for a shared recipient', async kind => {
    const field = source('application_field'), media = source(kind, { userId: ownerId })
    const read = client({ admitted: true, immutable: [field], current: [field, media] })
    await expect(tryValidateNativeCombinedOutputEvidence({ sources: [field] }, ceiling, { ...ceiling, userId: '' }, read))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', diagnostic: 'user_visibility' })
  })

  it('still refuses a media ancestor above the recipient clearance', async () => {
    const field = source('application_field'), media = source('recording', { sensitivity: 'confidential' })
    const read = client({ admitted: true, immutable: [field], current: [field, media] })
    await expect(tryValidateNativeCombinedOutputEvidence({ sources: [field] }, ceiling, { ...ceiling, clearance: 'internal' }, read))
      .rejects.toMatchObject({ reason: 'delivery_audience_unverified', diagnostic: 'clearance' })
  })

  it('rejects cross-workspace or payload-bearing media scopes', async () => {
    const field = source('application_field'), media = source('recording')
    await expect(readNativeSessionEvidence(client({ admitted: true, immutable: [field], current: [field, { ...media, workspaceId: randomUUID() }] }), workspaceId, [field]))
      .rejects.toThrow('Native session evidence unavailable')
    await expect(readNativeSessionEvidence(client({ admitted: true, immutable: [field], current: [field, { ...media, transcript: 'Fictional forbidden payload' }] }), workspaceId, [field]))
      .rejects.toThrow()
  })

  it.each(['episode', 'recording'] as const)('retains %s privacy obligations on the next history query without widening captures', async kind => {
    const field = source('application_field'), media = source(kind)
    const selection = { sessionId: randomUUID(), throughSequence: 3, topicThroughSequence: 2 }
    const captures = { history: [{ row: null, sources: [field] }], annotations: [{ row: null, sources: [field] }] }
    const proof = { admitted: true, immutable: [field], current: [field, media] }
    const read = (value: unknown) => ({ query: vi.fn(async (sql: string, args?: unknown[]) => {
      if (sql === 'SELECT to_regprocedure($1) IS NOT NULL AS available') {
        expect(args).toEqual(['public.read_native_retained_session_query(uuid,uuid,integer,integer)'])
        return { rows: [{ available: false }] }
      }
      if (sql === "SELECT to_regprocedure('public.read_native_turn_session_query(uuid,uuid,integer,integer)') IS NOT NULL AS available") return { rows: [{ available: true }] }
      if (sql === 'SELECT read_native_turn_session_query($1,$2,$3,$4) AS value') return { rows: [{ value }] }
      throw new Error(`Unexpected media acquisition query: ${sql}`)
    }) }) as unknown as Pick<PoolClient, 'query'>
    const result = await readNativeSessionQueryEvidence(read({ ...captures, proof }), workspaceId, selection)
    expect(result?.native.current).toEqual([field, media])
    expect(result?.sources).toEqual([field])
    expect(result?.native.evidence.sources).toEqual([field])
    for (const invalid of [
      { ...captures, proof: { ...proof, immutable: [field, media] } },
      { ...captures, history: [{ row: null, sources: [field, media] }], proof },
      { ...captures, proof: { ...proof, current: [field, { ...media, workspaceId: randomUUID() }] } },
      { ...captures, proof: { ...proof, current: [field, { ...media, transcript: 'Fictional forbidden payload' }] } },
    ]) {
      const acquisition = read(invalid)
      await expect(readNativeSessionQueryEvidence(acquisition, workspaceId, selection)).rejects.toThrow()
      expect(acquisition.query).toHaveBeenCalledWith('SELECT read_native_turn_session_query($1,$2,$3,$4) AS value', expect.any(Array))
      expect(acquisition.query).not.toHaveBeenCalledWith(expect.stringContaining('SELECT read_native_session_query_evidence('), expect.any(Array))
    }
  })
})
