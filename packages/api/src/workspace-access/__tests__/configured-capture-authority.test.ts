/** [COMP:api/configured-capture-authority] A shared capability keeps its exact claimant transaction. */
import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { programmaticIntakeClient, programmaticIntakeClaims } from '../../db/programmatic-intake-context.js'
import { admitProgrammaticCandidate, withProgrammaticCandidate } from '../configured-capture-authority.js'
import * as oldOwner from '../../ingest/programmatic-candidate-authority.js'
const source: ScopeSource = { resourceKind: 'episode', resourceId: 'source', version: 'verified-1', workspaceId: 'workspace', userId: null,
  assistantId: 'assistant', sensitivity: 'internal', compartments: ['dept:fictional'], projectIds: [] } satisfies ScopeSource
const input = { userId: null, assistantId: 'assistant', sensitivity: 'internal' as const, compartments: ['dept:fictional'], projectIds: [] }
function fixture() {
  const current = { source };
  const query = vi.fn(async (sql: string, _params?: unknown[]) => ({ rows: sql.includes('programmatic_candidate_source()') ? [{ source: current.source }] : [] }))
  const client = { query } as unknown as PoolClient
  const claimed = <T>(run: () => Promise<T>) => programmaticIntakeClient.run(client, () => programmaticIntakeClaims.run(new Set(['batch']), run))
  return { client, current, query, claimed }
}
describe('canonical configured capture authority', () => {
  it('shares the old and new callable owner and admits only the exact claimed source', async () => {
    expect(oldOwner.withProgrammaticCandidate).toBe(withProgrammaticCandidate)
    expect(oldOwner.admitProgrammaticCandidate).toBe(admitProgrammaticCandidate)
    const f = fixture()
    const result = await f.claimed(() => oldOwner.withProgrammaticCandidate(f.client, 'batch', source, 'memory', 'actor',
      () => admitProgrammaticCandidate(f.client, 'workspace', 'actor', 'memory', input)))
    expect(result).toEqual({ visibility: 'workspace', sensitivity: 'internal', compartments: ['dept:fictional'], projectIds: [] })
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("set_config('app.programmatic_candidate_source','',true)")
    expect(await admitProgrammaticCandidate(f.client, 'workspace', 'actor', 'memory', input)).toBeNull()
  })
  it('binds task creation to its exact pre-existing frozen candidate descriptor',async()=>{
    const f=fixture(), candidate={runId:'run',candidateId:'candidate',payloadHash:'a'.repeat(64)}
    await expect(f.claimed(()=>withProgrammaticCandidate(f.client,'batch',source,'task','actor',async()=>null))).rejects.toThrow('capture_candidate_writer_required')
    await f.claimed(()=>withProgrammaticCandidate(f.client,'batch',source,'task','actor',async()=>{
      expect(JSON.parse(f.query.mock.calls[0]![1]![0] as string)).toMatchObject(candidate)
      expect(await admitProgrammaticCandidate(f.client,'workspace','actor','task',input)).toMatchObject({visibility:'workspace'})
    },candidate))
  })
  it('refuses a forged claim, cross-transaction client, actor, writer kind or changed source', async () => {
    const f = fixture(), other = fixture()
    await expect(withProgrammaticCandidate(f.client, 'batch', source, 'memory', 'actor', async () => null)).rejects.toThrow('capture_claim_required')
    await f.claimed(() => withProgrammaticCandidate(f.client, 'batch', source, 'memory', 'actor', async () => {
      for (const [client, actor, kind, requested] of [[other.client, 'actor', 'memory', input], [f.client, 'other', 'memory', input],
        [f.client, 'actor', 'entity', input], [f.client, 'actor', 'memory', { ...input, compartments: [] }]] as const) {
        await expect(admitProgrammaticCandidate(client, 'workspace', actor, kind, { ...requested, compartments: [...requested.compartments] })).rejects.toThrow('capture_candidate_scope_mismatch')
      }
      f.current.source = { ...source, version: 'changed' }
      await expect(admitProgrammaticCandidate(f.client, 'workspace', 'actor', 'memory', input)).rejects.toThrow('capture_source_changed')
    }))
    expect(f.query.mock.calls.at(-1)?.[0]).toContain("set_config('app.programmatic_candidate_source','',true)")
  })
})
