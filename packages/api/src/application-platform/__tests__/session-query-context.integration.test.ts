import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { getAppPool, getPool } from '../../db/client.js'
import { nativeSessionQueryContextSources } from '../session-query-context.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

const familyReaders = ['session', 'knowledge', 'memory'].map(family => `read_native_${family}_query_cohort_sources`)
type Plan = { 'Function Name'?: string; 'Actual Loops': number; Plans?: Plan[] }
const planNodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(planNodes)]

describe('[COMP:api/application-persistence] native query cohort routing', () => {
  it('selects reachable families from exact ancestry and retains existing outputs and unavailable proofs', async () => {
    const fixture = await persistentContextFixture()
    const { pool, workspaceId, envelope, ownerId } = fixture
    const execution = await fixture.execution()
    const fingerprint = () => createHash('sha256').update(randomUUID()).digest('hex')
    async function field(type: string, carrier: string, fields: string[]): Promise<ScopeSource> {
      const identity = fingerprint()
      const version = fingerprint()
      const { rows } = await pool.query<{ id: string }>(`INSERT INTO application_field_resources(
          id,workspace_id,origin,type_key,resource_id,selection,fields,field_identity,identity
        ) VALUES (application_field_resource_uuid($1),$2,'{"kind":"native","moduleKey":"native"}',$3,$4,'read',$5,$1,$1)
        RETURNING id`, [identity, workspaceId, type, carrier, fields])
      const id = rows[0]!.id
      await pool.query(`INSERT INTO application_field_observations(workspace_id,resource_id,version,record_version,policy_version,
        source_kind,source_id,source_version,source_scope) VALUES ($1,$2,$3,'1',$3,$4,$5,'1',$6)`,
      [workspaceId, id, version, type, carrier, JSON.stringify(envelope)])
      return { ...envelope, resourceKind: 'application_field', resourceId: id, version }
    }
    const [message] = await fixture.history()
    const session = await field('session_message', message!.id, ['role'])
    const memoryRow = await fixture.memory('Fictional retained note')
    const memory = await field('memory', memoryRow.id, ['summary'])
    const knowledgeRows = (await pool.query<{ id: string }>(`INSERT INTO knowledge_entries(workspace_id,path,title,content,created_by)
      VALUES ($1,'/entry-a','Entry A','Fictional content',$2),($1,'/entry-b','Entry B','Fictional content',$2) RETURNING id`, [workspaceId, ownerId])).rows
    const [parent, related] = knowledgeRows
    await pool.query('UPDATE knowledge_entries SET related_ids=ARRAY[$2::uuid] WHERE id=$1', [parent!.id, related!.id])
    const knowledge = await field('knowledge_entry', parent!.id, ['relatedIds'])

    async function compare(roots: ScopeSource[], expectedLoops: number[], expectRelated: boolean) {
      const calls = vi.spyOn(pool, 'query')
      let statement: string | undefined
      let args: unknown[] | undefined
      try {
        expect(await nativeSessionQueryContextSources(execution, roots)).toEqual({ sources: roots, independent: false })
        const [sql, params] = calls.mock.calls.find(([sql]) => typeof sql === 'string' && sql.startsWith('WITH families'))!
        statement = sql as string
        args = params as unknown[]
      } finally { calls.mockRestore() }
      const scalar = familyReaders.map(name => `SELECT source FROM ${name}($1,$2,$3,$4)`).join(' UNION ALL ')
      const [before, after, plan] = await Promise.all([
        pool.query(scalar, args),
        pool.query(statement!, args),
        pool.query<{ 'QUERY PLAN': [{ Plan: Plan }] }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, args),
      ])
      expect(after.rows).toEqual(before.rows)
      expect(after.rows.map(row => row.source.resourceId)).toEqual(expectRelated ? [related!.id] : [])
      const nodes = planNodes(plan.rows[0]!['QUERY PLAN'][0].Plan)
      expect(familyReaders.map(name => nodes.find(node => node['Function Name'] === name)?.['Actual Loops'] ?? 0)).toEqual(expectedLoops)
    }

    try {
      await compare([session], [1, 0, 0], false)
      await pool.query(`INSERT INTO application_field_observation_sources(workspace_id,resource_id,version,source_kind,source_id,source_version)
        VALUES($1,$2,$3,'application_field',$4,$5)`, [workspaceId, session.resourceId, session.version, knowledge.resourceId, knowledge.version])
      await compare([session], [1, 1, 0], true)
      await compare([session, memory], [1, 1, 1], true)
      await expect(nativeSessionQueryContextSources(execution, [{ ...session, version: fingerprint() }]))
        .rejects.toMatchObject({ code: 'source_unavailable' })
    } finally { await fixture.cleanup() }
  })
})
