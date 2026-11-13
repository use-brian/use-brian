import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { readNativeSessionQueryEvidence } from '../native-session-query-evidence.js'

const workspaceId = '00000000-0000-4000-8000-000000000101'
const selection = { sessionId: '00000000-0000-4000-8000-000000000102', throughSequence: 3, topicThroughSequence: 2 }
const source = { workspaceId, userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [],
  resourceKind: 'application_field', resourceId: '00000000-0000-4000-8000-000000000103', version: 'fictional-version' }
const packet = { history: [{ row: null, sources: [source] }], annotations: [{ row: null, sources: [source] }],
  proof: { admitted: true, immutable: [source], current: [source] } }
const retainedSql = 'SELECT read_native_retained_session_query($1,$2,$3,$4) AS value'
const canonicalSql = 'SELECT read_native_turn_session_query($1,$2,$3,$4) AS value'
const legacySql = 'SELECT read_native_session_query_evidence($1,$2,$3,$4) AS value'
const args = [workspaceId, selection.sessionId, 3, 2]
function connection({ retainedInstalled = false, canonicalInstalled = true,
  retainedValue = packet as unknown, canonicalValue = packet as unknown, legacyValue = packet as unknown } = {}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === 'SELECT to_regprocedure($1) IS NOT NULL AS available') {
      expect(values).toEqual(['public.read_native_retained_session_query(uuid,uuid,integer,integer)'])
      return { rows: [{ available: retainedInstalled }] }
    }
    if (sql === "SELECT to_regprocedure('public.read_native_turn_session_query(uuid,uuid,integer,integer)') IS NOT NULL AS available") {
      return { rows: [{ available: canonicalInstalled }] }
    }
    const value = sql === retainedSql ? retainedValue : sql === canonicalSql ? canonicalValue : sql === legacySql ? legacyValue : undefined
    if (![retainedSql, canonicalSql, legacySql].includes(sql)) throw new Error(`Unexpected query acquisition SQL: ${sql}`)
    expect(values).toEqual(args)
    if (value instanceof Error) throw value
    return { rows: [{ value }] }
  })
  return { query, client: { query } as unknown as Pick<PoolClient, 'query'>, reads: () => query.mock.calls.filter(([sql]) => [retainedSql, canonicalSql, legacySql].includes(sql)) }
}

describe('[COMP:api/native-turn-frame] optional canonical query acquisition adapter', () => {
  it('uses the canonical admitted packet when the retained migration is absent', async () => {
    const f = connection()
    const result = await readNativeSessionQueryEvidence(f.client, workspaceId, selection)
    expect(result?.captures).toEqual({ history: packet.history, annotations: packet.annotations })
    expect(f.reads()).toEqual([[canonicalSql, args]])
  })
  it('uses the retained admitted packet without invoking either fallback reader', async () => {
    const f = connection({ retainedInstalled: true })
    const result = await readNativeSessionQueryEvidence(f.client, workspaceId, selection)
    expect(result?.captures).toEqual({ history: packet.history, annotations: packet.annotations })
    expect(f.reads()).toEqual([[retainedSql, args]])
  })
  it('retains the existing reader before either optional migration is installed', async () => {
    const f = connection({ canonicalInstalled: false })
    expect(await readNativeSessionQueryEvidence(f.client, workspaceId, selection)).not.toBeNull()
    expect(f.reads()).toEqual([[legacySql, args]])
  })
  it('uses the unchanged legacy reader after a canonical pre-write unavailable result', async () => {
    const f = connection({ canonicalValue: null })
    expect(await readNativeSessionQueryEvidence(f.client, workspaceId, selection)).not.toBeNull()
    expect(f.reads()).toEqual([[canonicalSql, args], [legacySql, args]])
  })
  it('permits only retained SQL NULL to fall back to the canonical reader', async () => {
    const f = connection({ retainedInstalled: true, retainedValue: null })
    expect(await readNativeSessionQueryEvidence(f.client, workspaceId, selection)).not.toBeNull()
    expect(f.reads()).toEqual([[retainedSql, args], [canonicalSql, args]])
  })
  it.each(['retained', 'canonical'] as const)('propagates %s post-write errors without invoking a fallback reader', async port => {
    const refusal = Object.assign(new Error('scope_source_changed'), { code: '42501' })
    const f = connection(port === 'retained' ? { retainedInstalled: true, retainedValue: refusal } : { canonicalValue: refusal })
    await expect(readNativeSessionQueryEvidence(f.client, workspaceId, selection)).rejects.toBe(refusal)
    expect(f.reads()).toEqual([[port === 'retained' ? retainedSql : canonicalSql, args]])
  })
  it.each(['retained', 'canonical'] as const)('rejects a malformed %s packet without retrying acquisition', async port => {
    const malformed = { ...packet, history: [] }
    const f = connection(port === 'retained' ? { retainedInstalled: true, retainedValue: malformed } : { canonicalValue: malformed })
    await expect(readNativeSessionQueryEvidence(f.client, workspaceId, selection)).rejects.toBeDefined()
    expect(f.reads()).toEqual([[port === 'retained' ? retainedSql : canonicalSql, args]])
  })
})
