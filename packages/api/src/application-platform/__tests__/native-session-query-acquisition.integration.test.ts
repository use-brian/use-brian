import { randomUUID } from 'node:crypto'
import pg, { type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { listWorkspaceFilesIndexRanked } from '../../db/workspace-files.js'
import { readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { readRetainedContextFrame, writeSessionContextRevision } from '../../db/session-context-revisions.js'
import { publishNativeSessionMessage } from '../../db/conversation-store.js'
import { addSessionMessage } from '../../db/sessions.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { validateCallerScopeEvidence } from '../../context-scope/caller-evidence.js'
import { captureConversationQuery, conversationCaptureSources } from '../../db/conversation-store.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
type Json = Record<string, any>
const wrapper = `joint_query_fixture_${randomUUID().replaceAll('-', '')}`
const guard = 'native_turn_helpers_current()'
const stage = 'capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)'
const rpc = 'capture_conversation_query(uuid,uuid,integer,integer)'
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let execution: ExecutionContext
let files: ScopeSource[]
let through = 3
const replies: string[] = []
const authority = () => ({ execution, accumulator: new ContextScopeAccumulator() })
const selection = (body = through, topics = body) => ({ sessionId: f.session.id, throughSequence: body, topicThroughSequence: topics })
const normalize = (values: readonly ScopeSource[]) => [...values].sort((a, b) =>
  `${a.resourceKind}:${a.resourceId}:${a.version}`.localeCompare(`${b.resourceKind}:${b.resourceId}:${b.version}`))
async function operation<T = Json>(client: Pick<PoolClient, 'query'>, action: string, payload: unknown = {}): Promise<T> {
  return (await client.query(`SELECT public.${wrapper}($1,$2,$3) AS value`, [f.workspaceId, action, JSON.stringify(payload)])).rows[0].value
}
async function frame<T>(run: (client: PoolClient) => Promise<T>) { return readRetainedContextFrame(authority(), [], run) }
async function isolated<T>(client: PoolClient, run: () => Promise<T>) {
  const name = `joint_${randomUUID().replaceAll('-', '')}`
  await client.query(`SAVEPOINT ${name}`)
  try { return await run() } finally { await client.query(`ROLLBACK TO SAVEPOINT ${name}`);await client.query(`RELEASE SAVEPOINT ${name}`) }
}
async function outcome(client: PoolClient, run: () => Promise<unknown>) {
  return isolated(client, async () => {
    try { return { value: await run() } } catch (error) { return { error: (error as { code?: string }).code } }
  })
}
async function joint(client: PoolClient, body = through, topics = body) {
  return (await client.query('SELECT capture_conversation_query($1,$2,$3,$4) AS value', [f.workspaceId, f.session.id, body, topics])).rows[0].value as Json | null
}
async function original(client: PoolClient, body = through, topics = body) {
  return captureConversationQuery(client, f.workspaceId, selection(body, topics))
}
async function traced<T>(run: () => Promise<T>) {
  const sql: string[] = [], query = pg.Client.prototype.query
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function(this: pg.Client, ...args: Parameters<typeof query>) {
    sql.push(typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? ''))
    return query.apply(this, args)
  } as typeof query)
  try { return { value: await run(), sql } } finally { spy.mockRestore() }
}

describe.sequential('[COMP:api/application-persistence] joint native body and topic acquisition', () => {
  beforeAll(async () => {
    f = await persistentContextFixture()
    await f.history()
    await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
      SELECT $1,'/fictional/joint-'||n||'.txt','Fictional joint file '||n,'fixture://joint-'||n,$2,'user','internal'
      FROM generate_series(1,50) n`, [f.workspaceId, f.ownerId])
    const unbounded = await f.execution(f.firstId), maximumAccess = { ...unbounded.security.ceiling,
      clearance: f.envelope.sensitivity, compartments: f.envelope.compartments, mutationCompartments: [], projectIds: f.envelope.projectIds }
    execution = (await resolveExecutionContextSystem({ userId: f.firstId, workspaceId: f.workspaceId,
      assistant: (await findAssistantById(f.assistantId))!, memberMode: 'member', sharedAudience: true,
      session: f.session, sessionAuthority: f.session, identity: unbounded.identity, ownership: unbounded.ownership,
      lifecycle: unbounded.lifecycle, maximumAccess, maximumAccessCurrent: async () => maximumAccess })).executionContext
    files = (await listWorkspaceFilesIndexRanked(execution.security.access, 50)).flatMap(boundScopeSources)
    expect(files).toHaveLength(50)
    for (let turn = 0; turn < 2; turn++) {
      const current = authority(), query = await readAdmittedSessionQuery({ ...selection(), authority: current })
      const memory = await createDbMemoryStore().getIndex(execution.security.access, false, current)
      const sources = new ContextScopeAccumulator({ sources: [...boundScopeSources(query), ...boundScopeSources(memory), ...files] }).evidence.sources!
      const row = await publishNativeSessionMessage({ sessionId: f.session.id, role: 'assistant', content: `Fictional joint reply ${turn}`,
        senderAssistantId: f.assistantId, authority: current, derivationTarget: f.envelope, derivation: { producer: 'fixture:joint-query', sources } })
      through = row.sequenceNum;replies.push(row.id)
    }
    const current = authority(), body = await readAdmittedSessionQuery({ ...selection(through, 0), authority: current })
    expect(await writeSessionContextRevision({ sessionId: f.session.id, parentId: replies.at(-1), kind: 'message_annotation',
      content: { topicLabel: 'Fictional joint topic', topicConfidence: 0.9, replyToText: null }, authority: current,
      derivation: { producer: 'fixture:joint-topic', sources: [...boundScopeSources(body), ...files] } })).not.toBeNull()
    await f.pool.query(`CREATE FUNCTION ${wrapper}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE definition text;body text;signature text;
      BEGIN
        IF action='guard' THEN RETURN to_jsonb(native_turn_helpers_current());
        ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);
        ELSIF action='stats' THEN RETURN coalesce((SELECT jsonb_object_agg(p.proname,s.calls) FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid),'{}');
        ELSIF action='observations' THEN RETURN jsonb_build_object(
          'fields',(SELECT count(*) FROM application_field_observations WHERE workspace_id=w),
          'domains',(SELECT count(*) FROM application_query_domains WHERE workspace_id=w));
        ELSIF action='hold' THEN INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
          VALUES(w,'workspace_file',(payload->>'id')::uuid,payload->>'version','held',1,'Fictional joint hold');
        ELSIF action='labels' THEN UPDATE workspace_files SET sensitivity='confidential' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
        ELSIF action='acl' THEN GRANT EXECUTE ON FUNCTION ${stage} TO app_user;
        ELSIF action='drift' THEN
          signature:=payload->>'signature';EXECUTE 'ALTER FUNCTION '||signature::regprocedure::text||' COST 101';
        ELSE RAISE EXCEPTION 'Unknown fixture operation';END IF;
        RETURN '{}'::jsonb;
      END $fixture$;
      REVOKE ALL ON FUNCTION ${wrapper}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${wrapper}(uuid,text,jsonb) TO app_user`)
  }, 120_000)
  afterAll(async () => {
    try { await getPool().query(`DROP FUNCTION IF EXISTS ${wrapper}(uuid,text,jsonb)`);await f?.cleanup() }
    finally { await getAppPool().end();await getPool().end() }
  })

  it('captures file-backed history, Memory and annotations with every bound source',async()=>frame(async client=>{
    expect(await operation(client,'guard')).toBe(true)
    const actual=await joint(client)
    const roots=conversationCaptureSources(actual as any,f.workspaceId)
    const admitted=await validateCallerScopeEvidence({sources:roots},execution.security.ceiling,client)
    for(const root of roots)expect(admitted.sources).toContainEqual(root)
    expect(actual!.history.some((row:Json)=>row.row?.id===replies.at(-1))).toBe(true)
    expect(actual!.annotations.some((row:Json)=>row.row?.topicLabel==='Fictional joint topic')).toBe(true)
  }),120_000)

  it('uses exactly one capture port in the real host and preserves bound evidence',async()=>{
    const actual=await traced(()=>readAdmittedSessionQuery({...selection(),authority:authority()}))
    expect(actual.value.history.some(row=>row.id===replies.at(-1))).toBe(true)
    expect(boundScopeSources(actual.value).length).toBeGreaterThan(0)
    expect(actual.sql.filter(sql=>sql.includes('SELECT capture_conversation_query('))).toHaveLength(1)
    expect(actual.sql.some(sql=>/SELECT read_native_(?:retained_session_query|turn_session_query|session_query_evidence)\(/.test(sql))).toBe(false)
  },120_000)

  it('rolls back actual acquisition observations before a malformed payload can leave the reader frame', async () => {
    const high = (await addSessionMessage({ sessionId: f.session.id, role: 'user', content: 'Fictional malformed packet boundary', scope: f.envelope })).sequenceNum
    const before = await operation(f.pool, 'observations'), query = pg.Client.prototype.query
    let packets = 0
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function(this: pg.Client, ...args: Parameters<typeof query>) {
      const sql = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
      const result = query.apply(this, args)
      if (!sql.includes('SELECT capture_conversation_query(')) return result
      // Execute the real materializing SQL, then corrupt only a payload DTO at
      // the driver boundary. The proof and every authority check stay real.
      return (result as unknown as Promise<Json>).then(result => {
        if (result.rows[0].value === null) return result
        packets++
        expect(result.rows[0].value.history.length).toBeGreaterThan(1)
        result.rows[0].value.history[1].row.createdAt = 'not-a-date'
        return result
      }) as unknown as ReturnType<typeof query>
    } as typeof query)
    try { await expect(readAdmittedSessionQuery({ ...selection(high), authority: authority() })).rejects.toBeDefined() }
    finally { spy.mockRestore() }
    expect(packets).toBe(1)
    expect(await operation(f.pool, 'observations')).toEqual(before)
  }, 120_000)

  it('withholds acquired data outside the original caller ceiling', async () => {
    const narrowed = { ...execution, security: { ...execution.security,
      ceiling: { ...execution.security.ceiling, clearance: 'public' as const } } }
    const result = await traced(async () => {
      await expect(readAdmittedSessionQuery({ ...selection(), authority: { execution: narrowed, accumulator: new ContextScopeAccumulator() } })).rejects.toBeDefined()
    })
    expect(result.sql.some(sql=>sql.includes('SELECT read_native_session_query_evidence('))).toBe(false)
  })

  for (const noFile of [true, false]) it(`preserves ${noFile ? 'the original no-file query' : 'a body query with an empty topic ceiling'}`, async () => frame(async client => {
    const high = noFile ? 3 : through, topics = noFile ? 3 : 0
    const actual = await joint(client, high, topics)
    expect(actual).not.toBeNull()
    expect({ history: actual!.history, annotations: actual!.annotations }).toEqual(await original(client, high, topics))
  }))

  for (const signature of [guard, stage, 'application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)']) it(`refuses changed ${signature} before acquisition`, async () => frame(async client => isolated(client, async () => {
    await operation(client, 'drift', { signature })
    await expect(joint(client)).rejects.toMatchObject({code:'42501'})
  })))
  it('refuses changed private ACLs and keeps both internal helpers inaccessible', async () => frame(async client => isolated(client, async () => {
    for (const signature of [guard, stage]) expect((await client.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') allowed', [signature])).rows[0].allowed).toBe(false)
    await operation(client, 'acl');expect(await operation(client, 'guard')).toBe(false)
    await expect(joint(client)).rejects.toMatchObject({code:'42501'})
  })))

  for (const change of ['hold', 'labels']) it(`preserves canonical withholding after current file ${change}`, async () => frame(async client => isolated(client, async () => {
    await operation(client, change, { id: files[0].resourceId, version: files[0].version })
    const read = async () => {
      const captured = await original(client)
      await validateCallerScopeEvidence({ sources: conversationCaptureSources(captured, f.workspaceId) }, execution.security.ceiling, client)
      return captured
    }
    const fallback = await outcome(client, read)
    if ('value' in fallback) expect((fallback.value as { history: { row: Json | null }[] }).history.some(row => replies.includes(row.row?.id))).toBe(false)
    else expect(fallback.error).toBeDefined()
  })), 90_000)

  it('refuses an extra role after widening the public capture ACL',async()=>{
    const client=await f.pool.connect(),role=`fictional_joint_reader_${randomUUID().replaceAll('-','')}`
    try{
      await client.query('BEGIN');await client.query(`CREATE ROLE ${role} NOLOGIN`)
      await client.query(`GRANT EXECUTE ON FUNCTION ${rpc},${wrapper}(uuid,text,jsonb) TO ${role}`)
      await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.firstId])
      await client.query(`SET SESSION AUTHORIZATION ${role}`)
      expect(await operation(client,'guard')).toBe(false)
      expect(await outcome(client,()=>joint(client))).toMatchObject({error:'42501'})
    }finally{await client.query('RESET SESSION AUTHORIZATION');await client.query('ROLLBACK');client.release()}
  })

  for (const change of ['hold', 'body', 'actor', 'ceiling', 'predecessor', 'guard']) it(`discards buffered content after ${change} changes during real materialization`, async () => {
    const high = (await addSessionMessage({ sessionId: f.session.id, role: 'user', content: `Fictional joint barrier ${change}`, scope: f.envelope })).sequenceNum
    const trigger = `${wrapper}_barrier`
    await f.pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $barrier$
      DECLARE definition text;body text;
      BEGIN
        IF NEW.workspace_id=TG_ARGV[0]::uuid AND current_setting('app.fixture_joint_barrier',true)='on'
          AND EXISTS(SELECT 1 FROM application_field_resources r WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.resource_id AND r.selection='query_domain' AND r.type_key='session_message') THEN
          IF NOT EXISTS(SELECT 1 FROM pg_stat_xact_user_functions WHERE funcid='capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)'::regprocedure AND calls>current_setting('app.fixture_joint_initial_calls')::bigint)
            THEN RAISE EXCEPTION 'Fixture did not reach a seeded joint capture';END IF;
          PERFORM set_config('app.fixture_joint_barrier','off',true);
          IF TG_ARGV[1]='hold' THEN INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
            VALUES(NEW.workspace_id,'workspace_file',TG_ARGV[2]::uuid,TG_ARGV[3],'held',1,'Fictional joint materialization hold');
          ELSIF TG_ARGV[1]='body' THEN UPDATE session_messages SET content='"Fictional changed joint body"'::jsonb WHERE workspace_id=NEW.workspace_id AND id=TG_ARGV[4]::uuid;
          ELSIF TG_ARGV[1]='actor' THEN PERFORM set_config('app.current_user_id',TG_ARGV[5],true);PERFORM set_config('app.agent_actor_id',TG_ARGV[5],true);
          ELSIF TG_ARGV[1]='ceiling' THEN PERFORM set_config('app.agent_clearance','public',true);
          ELSIF TG_ARGV[1]='predecessor' THEN INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity,superseded_by)
            VALUES(NEW.workspace_id,'/fictional/joint-predecessor','Fictional predecessor','fixture://joint-predecessor',TG_ARGV[5]::uuid,'user','confidential',TG_ARGV[2]::uuid);
          ELSE ALTER FUNCTION capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb) COST 101;END IF;
        END IF;RETURN NEW;
      END $barrier$;
      REVOKE ALL ON FUNCTION ${trigger}() FROM PUBLIC;
      CREATE TRIGGER ${trigger} AFTER INSERT ON application_field_observations FOR EACH ROW EXECUTE FUNCTION ${trigger}(
        '${f.workspaceId}','${change}','${files[0].resourceId}','${files[0].version}','${replies[0]}','${f.secondId}')`)
    try {
      await frame(async client => {
        await operation(client, 'trace');const before = await operation(client, 'stats'), observations = await operation(client, 'observations')
        await client.query("SELECT set_config('app.fixture_joint_barrier','on',true),set_config('app.fixture_joint_initial_calls',$1,true)", [String(before.capture_conversation_selection ?? 0)])
        expect(await outcome(client,()=>joint(client,high))).toMatchObject({error:'42501'})
        const after = await operation(client, 'stats')
        expect(after[trigger]).toBeGreaterThan(before[trigger] ?? 0)
        expect(after.capture_conversation_selection).toBeGreaterThan(before.capture_conversation_selection ?? 0)
        expect(await operation(client, 'observations')).toEqual(observations)
        await client.query("SELECT set_config('app.fixture_joint_barrier','off',true)")
        expect(await joint(client, high)).not.toBeNull()
      })
    } finally { await f.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON application_field_observations;DROP FUNCTION IF EXISTS ${trigger}()`) }
  }, 120_000)

  it('declines invalid selector bounds without leaving observations', async () => frame(async client => {
    const before = await operation(client, 'observations')
    expect(await outcome(client,()=>joint(client,-1))).toMatchObject({error:'42501'})
    expect(await operation(client, 'observations')).toEqual(before)
  }))

  it('captures more than one hundred messages without a reader fallback', async () => {
    let high = through
    for (let index = 0; index < 101; index++) high = (await addSessionMessage({ sessionId: f.session.id, role: 'user',
      content: `Fictional bounded joint request ${index}`, scope: f.envelope })).sequenceNum
    await frame(async client => {
      await client.query("SET LOCAL statement_timeout='60s'")
      const fallback = await original(client, high)
      expect(fallback.history.filter(row => row.row !== null)).toHaveLength(high)
      expect(fallback.history.at(-1)!.row!.sequenceNum).toBe(high)
    })
  }, 120_000)
})
