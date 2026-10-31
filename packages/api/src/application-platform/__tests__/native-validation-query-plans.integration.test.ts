import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { boundScopeSources, ContextScopeAccumulator } from '@use-brian/core'
import { getAppPool, getPool, rollbackAndRelease } from '../../db/client.js'
import { addSessionMessage, createWorkspaceChatSession } from '../../db/sessions.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { sessionContextGeneration, writeSessionContextRevision } from '../../db/session-context-revisions.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const ancestrySignature = 'scope_source_ancestors_before_browser_profile(uuid,text,uuid)'
const fieldSignature = 'application_session_eval_field(uuid,uuid,text,jsonb)'
const fileIds = Array.from({ length: 5 }, () => randomUUID())
let fixture: Awaited<ReturnType<typeof persistentContextFixture>>
let otherWorkspace: string
let parents: Array<{ kind: string; id: string }>
let fields: Array<{ id: string; version: string }>
let secondSession: string
let secondField: { id: string; version: string }

// Execute the actual pre-optimization definitions, not a test reimplementation.
async function originalDefinition(file: string, name: string) {
  const sql = await readFile(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8')
  const definition = sql.match(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION ${name}\\([\\s\\S]*?^\\$\\$;`, 'm'))?.[0]
  if (!definition) throw new Error(`Missing original fixture definition: ${name}`)
  return definition.replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION')
}
const originalAncestry = await originalDefinition('8067_native_attended_metadata_walk.sql', 'scope_source_ancestors_before_browser_profile')
const originalRecording = await originalDefinition('8135_channel_recording_privacy_hold.sql', 'recording_source_read_allowed')

async function transaction<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect()
  try { await client.query('BEGIN'); return await run(client) }
  finally { await rollbackAndRelease(client) }
}
async function original<T>(client: PoolClient, definition: string, read: () => Promise<T>) {
  await client.query('SAVEPOINT original_plan')
  try { await client.query(definition); return await read() }
  finally { await client.query('ROLLBACK TO SAVEPOINT original_plan') }
}
async function guard(client: PoolClient) {
  return (await client.query<{ allowed: boolean }>('SELECT application_memory_statement_helpers_current() AS allowed')).rows[0].allowed
}
async function appendBodyComment(client: PoolClient, signature: string) {
  const { rows: [fn] } = await client.query<{ definition: string; body: string }>(
    'SELECT pg_get_functiondef(oid) AS definition,prosrc AS body FROM pg_proc WHERE oid=$1::regprocedure', [signature])
  await client.query(fn.definition.replace(fn.body, `${fn.body}\n-- synthetic helper drift`))
}

describe.sequential('[COMP:api/application-persistence] native validation query plans', () => {
  beforeAll(async () => {
    fixture = await persistentContextFixture()
    const f = fixture, history = await f.history()
    otherWorkspace = randomUUID()
    await f.pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional alternate workspace',$2)", [otherWorkspace, f.ownerId])
    for (const [index, id] of fileIds.entries()) await f.pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
      VALUES($1,$2,$3,'Fictional predecessor','fixture://ancestry',$4,'user','internal')`,
    [id, index === 4 ? otherWorkspace : f.workspaceId, `/fictional/ancestor-${index}`, f.ownerId])
    const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: history.at(-1)!.sequenceNum, authority: await f.modelContext() })
    const derivation = { producer: 'fixture:recording-parents', sources: boundScopeSources(query) }
    const revision = await writeSessionContextRevision({ sessionId: f.session.id, kind: 'compact_summary',
      content: { summary: 'Fictional compact summary', boundarySequence: history.at(-1)!.sequenceNum }, authority: await f.modelContext(), derivation })
    const now = Date.now()
    const state = await writeSessionContextRevision({ sessionId: f.session.id, kind: 'session_state',
      content: { key: 'fictional-state', status: 'open', summary: 'Fictional state', detail: null, source: 'tool', createdAt: now, updatedAt: now, resolvedAt: null },
      authority: await f.modelContext(), derivation, expectedGeneration: await sessionContextGeneration(f.session.id) })
    const episode = await writeSessionContextRevision({ sessionId: f.session.id, kind: 'episodic_memory',
      content: { topicLabel: 'Fictional episode', summary: 'Fictional summary', messageSpan: { fromSequence: 1, toSequence: 3, turnCount: 3 }, entityRefs: null },
      authority: await f.modelContext(), derivation })
    expect(revision).not.toBeNull()
    expect(state).not.toBeNull()
    expect(episode).not.toBeNull()
    // Legacy feedback also remains protected by its current recording parent.
    const feedback = randomUUID()
    await f.pool.query(`INSERT INTO analytics_events(id,session_id,user_id,assistant_id,event_name,metadata)
      VALUES($1,$2,$3,$4,'fictional-feedback','{}')`, [feedback, f.session.id, f.ownerId, f.assistantId])
    parents = [{ kind: 'session', id: f.session.id }, { kind: 'session_message', id: history[0].id },
      { kind: 'session_context_revision', id: revision!.id }, { kind: 'session_state', id: state!.parentId },
      { kind: 'episodic_memory', id: episode!.parentId }, { kind: 'feedback_event', id: feedback }]
    fields = boundScopeSources(query).filter(source => source.resourceKind === 'application_field')
      .map(source => ({ id: source.resourceId, version: source.version }))
    expect(fields.length).toBeGreaterThanOrEqual(2)
    const second = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.ownerId, workspaceId: f.workspaceId,
      effectiveClearance: 'internal', authenticatedHuman: true })
    secondSession = second.id
    const message = await addSessionMessage({ sessionId: second.id, role: 'user', content: [{ type: 'text', text: 'Fictional second conversation' }], scope: f.envelope })
    const secondQuery = await readAdmittedSessionQuery({ sessionId: second.id, throughSequence: message.sequenceNum,
      authority: { execution: await f.execution(f.ownerId, second), accumulator: new ContextScopeAccumulator() } })
    secondField = (await f.pool.query<{ id: string; version: string }>(`SELECT r.id,o.version FROM application_field_resources r
      JOIN application_field_observations o ON o.resource_id=r.id AND o.workspace_id=r.workspace_id
      WHERE r.workspace_id=$1 AND r.resource_id=$2 AND r.selection='query' AND r.id=ANY($3::uuid[])`,
    [f.workspaceId, message.id, boundScopeSources(secondQuery).map(source => source.resourceId)])).rows[0]
    expect(secondField).toBeDefined()
  })
  afterAll(async () => {
    try {
      if (otherWorkspace) await getPool().query('DELETE FROM workspaces WHERE id=$1', [otherWorkspace])
      await fixture?.cleanup()
    } finally { await getAppPool().end(); await getPool().end() }
  })

  for (const scenario of ['leaf', 'predecessor chain', 'cycle', 'other workspace', 'missing root', 'renamed column', 'versioned mapping', 'unversioned mapping'] as const) {
    it(`preserves original file ancestry for ${scenario}`, async () => transaction(async client => {
      const f = fixture
      let expected = [fileIds[2]]
      if (scenario === 'predecessor chain' || scenario === 'cycle') {
        await client.query('UPDATE workspace_files SET superseded_by=$1 WHERE id=$2', [fileIds[2], fileIds[1]])
        await client.query('UPDATE workspace_files SET superseded_by=$1 WHERE id=$2', [fileIds[1], scenario === 'cycle' ? fileIds[2] : fileIds[0]])
        expected = scenario === 'cycle' ? [fileIds[1], fileIds[2]] : fileIds.slice(0, 3)
      } else if (scenario === 'other workspace') await client.query('UPDATE workspace_files SET superseded_by=$1 WHERE id=$2', [fileIds[2], fileIds[4]])
      else if (scenario === 'missing root') { await client.query('DELETE FROM workspace_files WHERE id=$1', [fileIds[2]]); expected = [] }
      else if (scenario === 'renamed column') await client.query('ALTER TABLE workspace_files RENAME COLUMN superseded_by TO synthetic_previous_column')
      else if (scenario.endsWith('mapping')) {
        const versioned = scenario === 'versioned mapping'
        await client.query(`CREATE TABLE synthetic_file_ancestors(id uuid,workspace_id uuid${versioned ? ',superseded_by uuid' : ''})`)
        await client.query('INSERT INTO synthetic_file_ancestors(id,workspace_id) VALUES($1,$2)', [fileIds[2], f.workspaceId])
        if (versioned) {
          await client.query('INSERT INTO synthetic_file_ancestors VALUES($1,$2,$3)', [fileIds[3], f.workspaceId, fileIds[2]])
          expected.push(fileIds[3])
        }
        const { rows: [fn] } = await client.query('SELECT pg_get_functiondef(oid) AS definition,prosrc FROM pg_proc WHERE oid=\'scope_source_table(text)\'::regprocedure')
        await client.query(fn.definition.replace(fn.prosrc, " SELECT 'synthetic_file_ancestors'::text "))
      }
      const read = async () => (await client.query<{ resource_id: string }>(`SELECT resource_id FROM ${ancestrySignature.split('(')[0]}($1,'workspace_file',$2) ORDER BY resource_id`, [f.workspaceId, fileIds[2]])).rows.map(row => row.resource_id)
      expect(await read()).toEqual([...expected].sort())
      expect(await read()).toEqual(await original(client, originalAncestry, read))
    }))
  }

  for (const held of [false, true]) it(`preserves all six recording parent families with held=${held}`, async () => transaction(async client => {
    await client.query('UPDATE sessions SET recording_privacy_held=$1 WHERE id=$2', [held, fixture.session.id])
    for (const parent of parents) {
      const read = async () => (await client.query<{ allowed: boolean }>('SELECT recording_source_read_allowed($1,$2,$3) AS allowed', [fixture.workspaceId, parent.kind, parent.id])).rows[0].allowed
      expect(await read()).toBe(!held)
      expect(await read()).toBe(await original(client, originalRecording, read))
    }
  }))

  it('preserves mixed recording parents and terminates a cyclic field dependency graph', async () => transaction(async client => {
    const [first, second] = fields
    await client.query(`INSERT INTO application_field_observation_sources(workspace_id,resource_id,version,source_kind,source_id,source_version)
      VALUES($1,$2,$3,'application_field',$4,$5),($1,$4,$5,'application_field',$2,$3),($1,$4,$5,'application_field',$6,$7)
      ON CONFLICT DO NOTHING`,
    [fixture.workspaceId, first.id, first.version, second.id, second.version, secondField.id, secondField.version])
    expect((await client.query(`SELECT count(*)::int AS count FROM application_field_observation_sources s
      JOIN (VALUES($2::uuid,$3::text,$4::uuid,$5::text),($4,$5,$2,$3),($4,$5,$6::uuid,$7::text)) expected(id,version,source,source_version)
      ON (s.resource_id,s.version,s.source_id,s.source_version)=(expected.id,expected.version,expected.source,expected.source_version)
      WHERE s.workspace_id=$1 AND s.source_kind='application_field'`,
    [fixture.workspaceId, first.id, first.version, second.id, second.version, secondField.id, secondField.version])).rows[0].count).toBe(3)
    const read = async () => (await client.query<{ allowed: boolean }>("SELECT recording_source_read_allowed($1,'application_field',$2) AS allowed", [fixture.workspaceId, first.id])).rows[0].allowed
    expect(await read()).toBe(true)
    expect(await read()).toBe(await original(client, originalRecording, read))
    await client.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1', [secondSession])
    expect(await read()).toBe(false)
    expect(await read()).toBe(await original(client, originalRecording, read))
  }))

  it('retains missing-root and nullable-parent recording semantics', async () => transaction(async client => {
    for (const parent of parents) {
      const missingId = randomUUID()
      const read = async () => (await client.query<{ allowed: boolean }>('SELECT recording_source_read_allowed($1,$2,$3) AS allowed', [fixture.workspaceId, parent.kind, missingId])).rows[0].allowed
      expect(await read()).toBe(true)
      expect(await read()).toBe(await original(client, originalRecording, read))
    }
    const feedback = parents.find(parent => parent.kind === 'feedback_event')!
    await client.query('UPDATE analytics_events SET session_id=NULL WHERE id=$1', [feedback.id])
    const read = async () => (await client.query<{ allowed: boolean }>("SELECT recording_source_read_allowed($1,'feedback_event',$2) AS allowed", [fixture.workspaceId, feedback.id])).rows[0].allowed
    expect(await read()).toBe(true)
    expect(await read()).toBe(await original(client, originalRecording, read))
  }))

  for (const mutation of ['body', 'ACL', 'owner', 'search path', 'custom configuration', 'cost', 'default argument', 'normalized projection name', 'normalized source body'] as const) {
    it(`invalidates the fresh complete helper manifest after ${mutation} drift`, async () => transaction(async client => {
      expect(await guard(client)).toBe(true)
      await client.query('SAVEPOINT helper_drift')
      if (mutation === 'body') await appendBodyComment(client, fieldSignature)
      else if (mutation === 'ACL') await client.query(`GRANT EXECUTE ON FUNCTION ${fieldSignature} TO app_user`)
      else if (mutation === 'owner') await client.query(`ALTER FUNCTION ${fieldSignature} OWNER TO app_user`)
      else if (mutation === 'search path') await client.query(`ALTER FUNCTION ${fieldSignature} SET search_path=public,pg_catalog`)
      else if (mutation === 'custom configuration') await client.query(`ALTER FUNCTION ${fieldSignature} SET app.synthetic_guard_setting='fixture'`)
      else if (mutation === 'cost') await client.query(`ALTER FUNCTION ${fieldSignature} COST 987`)
      else if (mutation === 'default argument') {
        const { rows: [fn] } = await client.query('SELECT pg_get_functiondef(oid) AS definition,pg_get_function_arguments(oid) AS arguments FROM pg_proc WHERE oid=$1::regprocedure', [fieldSignature])
        expect(fn.arguments).not.toContain('DEFAULT')
        await client.query(fn.definition.replace(fn.arguments, `${fn.arguments} DEFAULT NULL`))
      } else if (mutation === 'normalized projection name') {
        const { rows: [fn] } = await client.query("SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE proname='application_field_projection_state_before_feedback_outcome'")
        await client.query(`ALTER FUNCTION ${fn.signature} RENAME TO synthetic_projection_name`)
      } else await appendBodyComment(client, 'read_entity_derivation_source(uuid,text,uuid)')
      expect(await guard(client)).toBe(false)
      expect(await guard(client)).toBe(false)
      await client.query('ROLLBACK TO SAVEPOINT helper_drift')
      expect(await guard(client)).toBe(true)
      expect((await client.query('SELECT application_empty_query_helpers_current() AS allowed')).rows[0].allowed).toBe(true)
      expect((await client.query('SELECT application_empty_query_facades_current() AS allowed')).rows[0].allowed).toBe(true)
    }))
  }

  it('keeps private helpers private and the recording reader callable by the application role', async () => transaction(async client => {
    for (const signature of [ancestrySignature, 'application_memory_statement_helpers_current()']) {
      expect((await client.query("SELECT has_function_privilege('app_user',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed).toBe(false)
    }
    expect((await client.query("SELECT has_function_privilege('app_user','recording_source_read_allowed(uuid,text,uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(true)
    expect(await guard(client)).toBe(true)
  }))
})
