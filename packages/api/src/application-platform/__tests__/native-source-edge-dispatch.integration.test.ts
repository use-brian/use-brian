import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { boundScopeSources, ContextScopeAccumulator, type ScopeSource } from '@use-brian/core'
import { getAppPool, getPool, rollbackAndRelease } from '../../db/client.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { addSessionMessage } from '../../db/sessions.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const dispatcher = 'application_native_source_edges_dispatch(uuid,text,uuid,text)'
const originalSql = await readFile(new URL('../../../migrations/8069_native_metadata_extension_contract.sql', import.meta.url), 'utf8')
const originalDefinition = originalSql.match(/CREATE OR REPLACE FUNCTION application_scope_source_edges\([\s\S]*?^\$\$;/m)?.[0]
if (!originalDefinition) throw new Error('Original SQL edge definition missing')
const reference = originalDefinition.replace('application_scope_source_edges(', 'pg_temp.original_source_edges(')
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let fileIds: string[], segmentId: string, runId: string, replyId: string
let fieldRoots: ScopeSource[]
async function transaction<T>(read: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect()
  try { await client.query('BEGIN'); await client.query(reference); return await read(client) }
  finally { await rollbackAndRelease(client) }
}
async function outcome(client: PoolClient, sql: string, args: unknown[]) {
  await client.query('SAVEPOINT edge_outcome')
  try { return { rows: (await client.query(sql, args)).rows } }
  catch (error) { const e = error as { code: string; message: string }; return { code: e.code, message: e.message } }
  finally { await client.query('ROLLBACK TO SAVEPOINT edge_outcome') }
}
async function equalEdges(client: PoolClient, args: unknown[]) {
  const actual = await outcome(client, 'SELECT * FROM application_scope_source_edges_before_knowledge_versions($1,$2,$3,$4) ORDER BY kind,id,version', args)
  expect(actual).toEqual(await outcome(client, 'SELECT * FROM pg_temp.original_source_edges($1,$2,$3,$4) ORDER BY kind,id,version', args))
  return actual
}
async function guards(client: PoolClient) {
  return (await client.query(`SELECT application_memory_statement_helpers_current() memory,
    application_native_worklist_helpers_current() worklist,
    application_native_covered_evidence_helpers_current() covered`)).rows[0]
}

describe.sequential('[COMP:api/application-persistence] native source-edge dispatch', () => {
  beforeAll(async () => {
    f = await persistentContextFixture()
    fileIds = [randomUUID(), randomUUID()]
    for (const [index, id] of fileIds.entries()) await f.pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
      VALUES($1,$2,$3,'Fictional edge file','fixture://edge',$4,'user','internal')`, [id, f.workspaceId, `/fictional/edge-${index}`, f.ownerId])
    segmentId = randomUUID()
    await f.pool.query(`INSERT INTO file_segments(id,workspace_id,file_id,segment_index,char_start,char_end,content,created_by_user_id)
      VALUES($1,$2,$3,0,0,12,'Fictional text',$4)`, [segmentId, f.workspaceId, fileIds[0], f.ownerId])
    const history = await f.history(), authority = await f.modelContext()
    const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: history.at(-1)!.sequenceNum, authority })
    fieldRoots = boundScopeSources(query)
    const reply = await addSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional edge response', authority,
      derivationTarget: f.envelope, derivation: { producer: 'fixture:edge-dispatch', sources: fieldRoots } })
    replyId = reply.id
    const workflowId = randomUUID(); runId = randomUUID()
    await f.pool.query("INSERT INTO workflows(id,workspace_id,created_by,name,definition) VALUES($1,$2,$3,'Fictional edge workflow','{}')", [workflowId, f.workspaceId, f.ownerId])
    const source = (await f.pool.query("SELECT read_scope_source($1,'workspace_file',$2) source", [f.workspaceId, fileIds[0]])).rows[0].source
    expect(source).not.toBeNull()
    const evidence = new ContextScopeAccumulator({ sources: [source, source] }).evidence
    await f.pool.query(`INSERT INTO workflow_runs(id,workflow_id,workspace_id,triggered_by,trigger_kind,vars)
      VALUES($1,$2,$3,$4,'manual',$5)`, [runId, workflowId, f.workspaceId, f.ownerId, { __contextScopeEvidence: evidence }])
  }, 90_000)
  afterAll(async () => {
    try { if (f) await f.pool.query('DELETE FROM file_segments WHERE workspace_id=$1', [f.workspaceId]); await f?.cleanup() } finally { await getAppPool().end(); await getPool().end() }
  })

  it('executes every real field and native derivation arm with the original complete edge sets', async () => transaction(async client => {
    const nodes = (await client.query('SELECT * FROM application_scope_lineage($1,ARRAY[\'session_message\'],ARRAY[$2::uuid],ARRAY[\'1\'])', [f.workspaceId, replyId])).rows
    expect(nodes.some(n => n.kind === 'application_field')).toBe(true)
    expect(nodes.some(n => n.kind === 'application_query_domain')).toBe(true)
    for (const node of nodes) await equalEdges(client, [f.workspaceId, node.kind, node.id, node.version])
    const baseline = (await client.query(`WITH RECURSIVE lineage(kind,id,version) AS (
      SELECT 'session_message'::text,$2::uuid,'1'::text UNION
      SELECT e.* FROM lineage n CROSS JOIN LATERAL pg_temp.original_source_edges($1,n.kind,n.id,n.version) e
    ) SELECT * FROM lineage ORDER BY kind,id,version`, [f.workspaceId, replyId])).rows
    expect([...nodes].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toEqual([...baseline].sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
    expect(await guards(client)).toEqual({ memory: true, worklist: true, covered: true })
  }))

  it('retains file-segment parents and valid workflow evidence with UNION duplicate elimination', async () => transaction(async client => {
    const version = (await client.query('SELECT scope_version::text version FROM workspace_files WHERE id=$1', [fileIds[0]])).rows[0].version
    for (const [kind, id] of [['file_segment', segmentId], ['workflow_run', runId]]) {
      const value = await equalEdges(client, [f.workspaceId, kind, id, '1'])
      expect(value).toEqual({ rows: [{ kind: 'workspace_file', id: fileIds[0], version }] })
    }
    // Repeat an observed source in the canonical workflow input, which is a
    // legal evidence shape. SQL UNION must still emit one edge.
    await client.query(`UPDATE workflow_runs SET vars=jsonb_set(vars,'{__contextScopeEvidence,sources}',
      (vars#>'{__contextScopeEvidence,sources}')||(vars#>'{__contextScopeEvidence,sources}')) WHERE id=$1`, [runId])
    expect(await equalEdges(client, [f.workspaceId, 'workflow_run', runId, '1'])).toEqual({ rows: [{ kind: 'workspace_file', id: fileIds[0], version }] })
  }))

  it('preserves predecessor cycles, versions and wrong-workspace filters', async () => transaction(async client => {
    await client.query('UPDATE workspace_files SET superseded_by=$1 WHERE id=$2', [fileIds[0], fileIds[1]])
    await client.query('UPDATE workspace_files SET superseded_by=$1 WHERE id=$2', [fileIds[1], fileIds[0]])
    expect(await equalEdges(client, [f.workspaceId, 'workspace_file', fileIds[0], 'fictional-version'])).toEqual({ rows: [{ kind: 'workspace_file', id: fileIds[1], version: 'fictional-version' }] })
    expect(await equalEdges(client, [randomUUID(), 'workspace_file', fileIds[0], '1'])).toEqual({ rows: [] })
  }))

  it('preserves NULL, unknown, missing and malformed workflow outcomes', async () => transaction(async client => {
    for (const kind of [null, 'fictional_unknown_kind', 'application_field', 'workspace_file', 'file_segment', 'workflow_run', 'memory', 'session_message']) {
      for (const workspace of [null, f.workspaceId, randomUUID()]) await equalEdges(client, [workspace, kind, randomUUID(), null])
    }
    await client.query(`UPDATE workflow_runs SET vars=vars-'__contextScopeEvidence' WHERE id=$1`, [runId])
    const result = await equalEdges(client, [f.workspaceId, 'workflow_run', runId, '1'])
    expect(result).toHaveProperty('message', 'scope_evidence_missing')
  }))

  it('preserves the SQL extension delegate and the outer Memory-history dispatch language', async () => transaction(async client => {
    for (const name of ['application_scope_source_edges', 'application_scope_source_edges_before_knowledge_versions']) {
      const fn = (await client.query(`SELECT l.lanname FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=$1::regprocedure`, [`${name}(uuid,text,uuid,text)`])).rows[0]
      expect(fn.lanname).toBe(name === 'application_scope_source_edges' ? 'plpgsql' : 'sql')
    }
  }))

  for (const drift of ['body', 'ACL', 'configuration', 'COST', 'default'] as const) it(`invalidates every closed shortcut after dispatcher ${drift} drift`, async () => transaction(async client => {
    expect(await guards(client)).toEqual({ memory: true, worklist: true, covered: true })
    if (drift === 'ACL') await client.query(`GRANT EXECUTE ON FUNCTION ${dispatcher} TO app_user`)
    else if (drift === 'configuration') await client.query(`ALTER FUNCTION ${dispatcher} SET work_mem='8MB'`)
    else if (drift === 'COST') await client.query(`ALTER FUNCTION ${dispatcher} COST 117`)
    else {
      const fn = (await client.query('SELECT pg_get_functiondef(oid) definition,prosrc body FROM pg_proc WHERE oid=$1::regprocedure', [dispatcher])).rows[0]
      await client.query(drift === 'body' ? fn.definition.replace(fn.body, () => fn.body + '\n-- Fictional dispatcher drift')
        : fn.definition.replace(/v text\)/, 'v text DEFAULT NULL::text)'))
    }
    expect(await guards(client)).toEqual({ memory: false, worklist: false, covered: false })
  }))

  it('keeps the dispatcher owner-only for the restricted application role', async () => {
    const app = await getAppPool().connect()
    try { await expect(app.query('SELECT * FROM application_native_source_edges_dispatch($1,$2,$3,$4)', [f.workspaceId, 'workspace_file', fileIds[0], '1'])).rejects.toMatchObject({ code: '42501' }) }
    finally { app.release() }
  })
})
