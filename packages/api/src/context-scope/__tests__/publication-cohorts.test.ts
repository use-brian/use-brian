import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import type { AccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'
import type { ScopeEvidence } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { readValidatedNativePublicationCohorts } from '../caller-evidence.js'

const workspaceId = 'b1000000-0000-4000-8000-000000000001'
const userId = 'b1000000-0000-4000-8000-000000000002'
const assistantId = 'b1000000-0000-4000-8000-000000000003'
const ceiling: AccessCeiling = { workspaceId, userId, clearance: 'confidential', compartments: null,
  mutationCompartments: null, projectIds: null, visibilityAssistantIds: null }
function source(suffix: string, overrides: Partial<ScopeSource> = {}): ScopeSource {
  return { workspaceId, userId, assistantId, sensitivity: 'internal', compartments: [], projectIds: [],
    resourceKind: 'application_field', resourceId: `b1000000-0000-4000-8000-${suffix.padStart(12, '0')}`, version: 'original', ...overrides }
}
function fixture() {
  const annotation = source('11'), reply = source('12', { sensitivity: 'confidential', compartments: ['reply-only'] })
  const ancestor = source('13', { resourceKind: 'workspace_file', version: '2' })
  const currentAnnotation = { ...annotation, version: 'current', compartments: ['current-annotation'] }
  const evidence: [ScopeEvidence, ScopeEvidence] = [
    { sources: [annotation, reply] },
    { sensitivity: 'internal', compartments: ['annotation-floor'], sources: [annotation] },
  ]
  const packet = { admitted: true, cohorts: [
    { immutable: [annotation, reply], current: [currentAnnotation, reply, ancestor] },
    { immutable: [annotation], current: [currentAnnotation, ancestor] },
  ] }
  let value: unknown = packet, beforeRead: (() => void) | undefined
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    if (!sql.startsWith('SELECT capture_conversation_evidence')) throw new Error(`Unexpected publication-cohort query: ${sql}`)
    beforeRead?.()
    return { rows: [{ value }] }
  })
  return { annotation, reply, ancestor, evidence, packet, query, client: { query } as unknown as Pick<PoolClient, 'query'>,
    reads: () => query.mock.calls,
    result: (next: unknown) => { value = next }, mutate: (run: () => void) => { beforeRead = run } }
}

const acquisitionSql = 'SELECT capture_conversation_evidence($1,NULL,NULL,$2) AS value'
describe('[COMP:api/caller-scope-evidence] canonical publication cohort acquisition', () => {
  const makeFixture = fixture
  it('uses one identity-only acquisition while preserving independent original floors and current labels', async () => {
    const f = makeFixture(), checked = await readValidatedNativePublicationCohorts(f.evidence, ceiling, f.client)
    expect(f.reads()).toHaveLength(1)
    expect(f.reads()[0][0]).toBe(acquisitionSql)
    expect(JSON.parse(f.reads()[0][1]![1] as string)).toEqual(f.evidence.map(evidence => evidence.sources!.map(source => ({
      kind: source.resourceKind, id: source.resourceId, version: source.version,
    }))))
    expect(checked![0].sensitivity).toBe('confidential')
    expect(checked![0].compartments).toEqual(expect.arrayContaining(['reply-only', 'current-annotation']))
    expect(checked![1].sensitivity).toBe('internal')
    expect(checked![1].compartments).toEqual(expect.arrayContaining(['annotation-floor', 'current-annotation']))
    expect(checked![1].compartments).not.toContain('reply-only')
    expect(checked![1].sources!.map(source => source.resourceId)).toEqual([f.annotation.resourceId])
    expect(checked![1].sources![0].version).toBe('original')
  })

  it('checks each projected current scope against the original caller ceiling', async () => {
    const f = makeFixture()
    f.packet.cohorts[1].current.push(source('14', { userId: 'b1000000-0000-4000-8000-000000000099' }))
    await expect(readValidatedNativePublicationCohorts(f.evidence, ceiling, f.client)).rejects.toMatchObject({
      reason: 'caller_evidence_unavailable', diagnostic: 'user_visibility', retrySafe: false,
    })
  })

  it('does not erase a scalar floor just because the SQL projection is narrower', async () => {
    const f = makeFixture()
    f.evidence[1].compartments = ['retained-floor']
    await expect(readValidatedNativePublicationCohorts(f.evidence, { ...ceiling, compartments: ['reply-only', 'current-annotation'] }, f.client))
      .rejects.toMatchObject({ reason: 'caller_evidence_unavailable', diagnostic: 'teams' })
  })

  it('pins both input cohorts and the ceiling before its first await', async () => {
    const f = makeFixture(), original = structuredClone(f.evidence), mutableCeiling = structuredClone(ceiling)
    f.mutate(() => { f.evidence[1].sources = []; mutableCeiling.clearance = 'public' })
    const checked = await readValidatedNativePublicationCohorts(f.evidence, mutableCeiling, f.client)
    expect(checked![1].sources!.map(source => source.resourceId)).toEqual(original[1].sources!.map(source => source.resourceId))
    expect(checked![0].sensitivity).toBe('confidential')
  })

  it('delegates unsupported source families without probing another reader', async () => {
    const f = makeFixture()
    f.result(null)
    expect(await readValidatedNativePublicationCohorts(f.evidence, ceiling, f.client)).toBeNull()
    expect(f.reads().map(([sql]) => sql)).toEqual([acquisitionSql])
  })

  it.each(['denied', 'missing-packet', 'missing-cohort', 'missing-current-root', 'missing-immutable-root', 'wrong-workspace'] as const)
    ('refuses %s rather than turning an incomplete packet into fallback', async change => {
      const f = makeFixture()
      if (change === 'denied') f.result({ admitted: false })
      if (change === 'missing-packet') f.result(undefined)
      if (change === 'missing-cohort') f.packet.cohorts.pop()
      if (change === 'missing-current-root') f.packet.cohorts[1].current.splice(0, 1)
      if (change === 'missing-immutable-root') f.packet.cohorts[1].immutable.length = 0
      if (change === 'wrong-workspace') f.packet.cohorts[1].current[0].workspaceId = 'b1000000-0000-4000-8000-000000000098'
      await expect(readValidatedNativePublicationCohorts(f.evidence, ceiling, f.client)).rejects.toMatchObject({
        reason: 'caller_evidence_unavailable', diagnostic: 'source_unverifiable', retrySafe: false,
      })
    })

  it('never reuses the previous packet for a second operation', async () => {
    const f = makeFixture()
    await readValidatedNativePublicationCohorts(f.evidence, ceiling, f.client)
    f.result({ admitted: false })
    await expect(readValidatedNativePublicationCohorts(f.evidence, ceiling, f.client)).rejects.toMatchObject({ reason: 'caller_evidence_unavailable' })
    expect(f.reads().map(([sql]) => sql)).toEqual([acquisitionSql, acquisitionSql])
  })

  it.each(['external_source','memory'] as const)('keeps %s roots on their original independent protocol', async resourceKind => {
    const f = makeFixture()
    f.evidence[0].sources!.push(source('15', { resourceKind }))
    expect(await readValidatedNativePublicationCohorts(f.evidence, ceiling, f.client)).toBeNull()
    expect(f.query).not.toHaveBeenCalled()
  })
})
