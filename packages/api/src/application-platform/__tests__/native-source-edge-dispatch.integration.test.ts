import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { withTableTriggersSuspended } from '../../__tests__/fixtures/bootstrap-role.js'
import { getAppPool, getPool, rollbackAndRelease } from '../../db/client.js'
import { readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { addSessionMessage } from '../../db/sessions.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { executableProjection } = await import(new URL('../../../scripts/conversation-store/executable-record.mjs', import.meta.url).href)
const dispatcher = 'application_native_source_edges_dispatch(uuid,text,uuid,text)'
const originalSql = await readFile(new URL('../../../migrations/8069_native_metadata_extension_contract.sql', import.meta.url), 'utf8')
const originalDefinition = originalSql.match(/CREATE OR REPLACE FUNCTION application_scope_source_edges\([\s\S]*?^\$\$;/m)?.[0]
if (!originalDefinition) throw new Error('Original SQL edge definition missing')
const reference = originalDefinition.replace('application_scope_source_edges(', 'pg_temp.original_source_edges(')
const lineageSql = await readFile(new URL('../../../migrations/8011_application_derivation_and_fields.sql', import.meta.url), 'utf8')
const lineageDefinition = lineageSql.match(/CREATE FUNCTION application_scope_lineage\([\s\S]*?^END \$\$;/m)?.[0]
if (!lineageDefinition) throw new Error('Original SQL lineage definition missing')
const lineageReference = lineageDefinition.replace('application_scope_lineage(', 'pg_temp.original_scope_lineage(')
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
async function equalLineage(client: PoolClient, args: unknown[]) {
  const ordered = '($1,$2,$3,$4) ORDER BY kind,id,version'
  const actual = await outcome(client, 'SELECT * FROM application_scope_lineage' + ordered, args)
  expect(actual).toEqual(await outcome(client, 'SELECT * FROM pg_temp.original_scope_lineage' + ordered, args))
  return actual
}
async function guards(client: PoolClient) {
  return (await client.query(`SELECT native_turn_helpers_current() memory,
    application_native_worklist_helpers_current() worklist,
    native_turn_helpers_current() covered`)).rows[0]
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

  it('matches the original complete walk across Memory versions, branches, cycles and later source handlers', async () => {
    const root = await f.memory('Fictional Memory lineage root')
    const prior = await f.memory('Fictional Memory lineage predecessor')
    const sibling = await f.memory('Fictional Memory lineage sibling')
    const extra = await f.memory('Fictional Memory lineage derivation')
    const missing = randomUUID(), external = randomUUID(), office = randomUUID()
    await transaction(async client => {
      await client.query(lineageReference)
      await client.query(`UPDATE memories SET valid_to=now(),superseded_by=CASE WHEN id=$1 THEN $2 ELSE $1 END
        WHERE id=ANY($3::uuid[])`, [root.id, prior.id, [root.id, prior.id, sibling.id]])
      // Model stored derivations whose input snapshots predate the live Memory
      // versions, including polymorphic records no longer found at their IDs.
      await withTableTriggersSuspended(client, ['scope_derivations', 'scope_derivation_sources'], async () => {
        await client.query(`WITH recorded AS (
          INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,
            assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
          SELECT m.workspace_id,'memory',s.id,s.version,'fixture:memory-lineage',m.user_id,m.assistant_id,
            m.sensitivity,m.compartments,m.project_ids,1
          FROM memories m JOIN unnest($2::uuid[],$3::text[]) s(id,version)
            ON m.id=CASE WHEN s.id=$8::uuid THEN $9::uuid ELSE s.id END
          WHERE m.workspace_id=$1 RETURNING id,resource_id,resource_version
        ) INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
          SELECT $1,d.id,s.kind,s.id,s.version FROM recorded d
          JOIN unnest($4::text[],$5::text[],$6::uuid[],$7::text[]) s(recorded_version,kind,id,version)
            ON s.recorded_version=d.resource_version`, [f.workspaceId, [prior.id, prior.id, sibling.id, missing],
          ['old-1', 'old-2', 'old-3', 'old-4'], ['old-1', 'old-1', 'old-2', 'old-2', 'old-3', 'old-4'],
          ['memory', 'file_segment', 'external_source', 'office_observation', 'session_message', 'memory'],
          [extra.id, segmentId, external, office, replyId, extra.id], ['historic', '1', 'retained', '1', '1', 'retained'],
          missing, root.id])
      })
      const args = [f.workspaceId, ['memory', 'memory', 'memory', 'memory'], [root.id, missing, root.id, root.id], ['current', 'missing', 'historic', 'current']]
      expect(await equalLineage(client, args)).toMatchObject({ rows: expect.arrayContaining([
        { kind: 'memory', id: root.id, version: 'historic' },
        { kind: 'memory', id: prior.id, version: 'current' },
        { kind: 'memory', id: sibling.id, version: 'historic' },
        { kind: 'memory', id: extra.id, version: 'historic' },
        { kind: 'memory', id: extra.id, version: 'retained' },
        { kind: 'memory', id: missing, version: 'missing' },
        { kind: 'external_source', id: external, version: 'retained' },
        { kind: 'office_observation', id: office, version: '1' },
        { kind: 'session_message', id: replyId, version: '1' },
        { kind: 'workspace_file', id: fileIds[0], version: '1' },
      ]) })
      expect(await equalLineage(client, [randomUUID(), ['memory'], [root.id], ['1']]))
        .toEqual({ rows: [{ kind: 'memory', id: root.id, version: '1' }] })
      expect(await equalLineage(client, [f.workspaceId, ['application_field'], [missing], ['1']]))
        .toEqual({ code: '22023', message: 'scope_ancestry_unavailable' })
      expect(await equalLineage(client, [f.workspaceId, ['memory'], [], ['1']]))
        .toEqual({ code: '22023', message: 'scope_evidence_missing' })
    })
  })

  it('keeps the inclusive 4,096-node limit on the complete closure', async () => {
    const root = await f.memory('Fictional Memory lineage boundary')
    await transaction(async client => {
      await client.query(lineageReference)
      const args = [f.workspaceId, ['memory'], [root.id], ['1']]
      await withTableTriggersSuspended(client, ['scope_derivations', 'scope_derivation_sources'], async () => {
        const header = (await client.query(`INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,
          producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
          SELECT workspace_id,'memory',id,scope_version::text,'fixture:lineage-bound',user_id,assistant_id,
            sensitivity,compartments,project_ids,1 FROM memories WHERE workspace_id=$1 AND id=$2 RETURNING id`, [f.workspaceId, root.id])).rows[0].id
        const insert = `INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
          SELECT $1,$2,'memory',gen_random_uuid(),'fixture' FROM generate_series(1,$3::integer)`
        await client.query(insert, [f.workspaceId, header, 4095])
        expect((await equalLineage(client, args)).rows).toHaveLength(4096)
        await client.query(insert, [f.workspaceId, header, 1])
        expect(await equalLineage(client, args)).toEqual({ code: '22023', message: 'scope_ancestry_unavailable' })
      })
    })
  })

  it('locks the exact Memory scope row only for its own workspace', async () => {
    const memory = await f.memory('Fictional Memory row lock')
    const writer = await f.pool.connect()
    const reader = await f.pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('SELECT id FROM public.memories WHERE id=$1 FOR UPDATE', [memory.id])
      await reader.query('BEGIN')
      await reader.query("SET LOCAL lock_timeout='100ms'")
      const scope = 'SELECT public.read_scope_source($1,\'memory\',$2) AS source'
      expect((await reader.query(scope, [randomUUID(), memory.id])).rows).toEqual([{ source: null }])
      expect((await reader.query(scope, [null, memory.id])).rows).toEqual([{ source: null }])
      await expect(reader.query(scope, [f.workspaceId, memory.id])).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await rollbackAndRelease(reader)
      await rollbackAndRelease(writer)
    }
  })

  it('follows canonical Memory edge extensions even after the installed registry is repinned', async () => {
    const root = await f.memory('Fictional Memory lineage extension root')
    const edge = randomUUID()
    await transaction(async client => {
      await client.query(lineageReference)
      const signature = 'application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)'
      const routine = (await client.query('SELECT prosrc,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0]
      const extended = routine.prosrc + `\nUNION SELECT 'office_observation'::text,'${edge}'::uuid,'1'::text
        WHERE k='memory' AND i='${root.id}'::uuid`
      await client.query(routine.definition.replace(routine.prosrc, () => extended))
      await client.query(`UPDATE public.native_turn_contract_helpers h SET contract=${executableProjection('p')}
        FROM pg_proc p WHERE h.signature=$1 AND p.oid=to_regprocedure('public.'||h.signature)`, [signature])
      expect(await equalLineage(client, [f.workspaceId, ['memory'], [root.id], ['historic']])).toMatchObject({
        rows: expect.arrayContaining([{ kind: 'office_observation', id: edge, version: '1' }]),
      })
    })
  })

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

  it('keeps the dispatcher and complete lineage owner-only for the restricted application role', async () => {
    const app = await getAppPool().connect()
    try {
      await expect(app.query('SELECT * FROM application_native_source_edges_dispatch($1,$2,$3,$4)', [f.workspaceId, 'workspace_file', fileIds[0], '1'])).rejects.toMatchObject({ code: '42501' })
      await expect(app.query('SELECT * FROM application_scope_lineage($1,$2,$3,$4)', [f.workspaceId, ['workspace_file'], [fileIds[0]], ['1']])).rejects.toMatchObject({ code: '42501' })
    }
    finally { app.release() }
  })
})
