/** [COMP:api/native-chat-read-cost] Direct packed entry point; no legacy success can satisfy these assertions. */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { boundScopeSources, ContextScopeAccumulator, type ExecutionContext, type ScopeSource } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { readRetainedContextFrame, writeSessionContextRevision } from '../../db/session-context-revisions.js'
import { addSessionMessage, createWorkspaceChatSession } from '../../db/sessions.js'
import { nativeSessionQueryCaptureSources, readOriginalNativeSessionQueryCaptures } from '../native-session-query-evidence.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
type Json = Record<string, any>
const helper = `retained_query_fixture_${randomUUID().replaceAll('-', '')}`
const cacheHelper = `${helper}_cache`
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let execution: ExecutionContext
let messageIds: string[]
const authority = () => ({ execution, accumulator: new ContextScopeAccumulator() })
async function frame<T>(run: (client: PoolClient) => Promise<T>) { return readRetainedContextFrame(authority(), [], run) }
async function acquire(client: PoolClient, body = 3, topics = body): Promise<Json | null> {
  return (await client.query('SELECT read_native_retained_session_query($1,$2,$3,$4) value', [f.workspaceId, f.session.id, body, topics])).rows[0].value
}
async function original(client: PoolClient, body = 3, topics = body) {
  return readOriginalNativeSessionQueryCaptures(client, f.workspaceId, { sessionId: f.session.id, throughSequence: body, topicThroughSequence: topics })
}
async function counts() {
  return (await f.pool.query(`SELECT (SELECT count(*)::integer FROM application_field_observations WHERE workspace_id=$1) fields,
    (SELECT count(*)::integer FROM application_query_domains WHERE workspace_id=$1) domains`, [f.workspaceId])).rows[0]
}
async function sourceProof(client: PoolClient, sources: ScopeSource[]) {
  return (await client.query('SELECT read_native_retained_scope_evidence($1,$2) value', [f.workspaceId,
    JSON.stringify(sources.map(source => ({ kind: source.resourceKind, id: source.resourceId, version: source.version }))),
  ])).rows[0].value as Json | null
}
async function annotate(messageId: string, label: string, expectedRevision?: string) {
  const current = authority()
  const body = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: 3, topicThroughSequence: 0, authority: current })
  return writeSessionContextRevision({ sessionId: f.session.id, parentId: messageId, kind: 'message_annotation',
    content: { topicLabel: label, topicConfidence: 0.9, replyToText: null }, authority: current, expectedRevision,
    derivation: { producer: 'fixture:native-query', sources: boundScopeSources(body) } })
}

describe.sequential('[COMP:api/native-chat-read-cost] packed retained acquisition and fresh contraction checks', () => {
  beforeAll(async () => {
    f = await persistentContextFixture()
    messageIds = (await f.history()).map(message => message.id)
    execution = await f.execution(f.firstId)
    expect(await annotate(messageIds[2], 'Fictional final topic')).not.toBeNull()
    await f.pool.query(`CREATE FUNCTION ${helper}(action text,arg jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $fixture$
      BEGIN
        IF action='hidden' THEN UPDATE session_messages SET sensitivity='confidential' WHERE id='${messageIds[0]}'::uuid;
        ELSIF action='drift' THEN ALTER FUNCTION native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb) COST 101;
        ELSIF action='requirements' THEN RETURN read_native_turn_requirements('${f.workspaceId}'::uuid,arg);
        ELSIF action='prepare' THEN RETURN native_turn_prepare_publication('${f.workspaceId}'::uuid,'${f.session.id}'::uuid,
          'fixture:authenticated-retained-port',arg,'${JSON.stringify(f.envelope).replaceAll("'", "''")}'::jsonb);
        ELSIF action='hold' THEN UPDATE session_messages SET scope_held=true WHERE id='${messageIds[1]}'::uuid;
        ELSIF action='forge-port' THEN
          EXECUTE $definition$CREATE OR REPLACE FUNCTION public.read_native_retained_requirements(w uuid,roots jsonb,selectors jsonb)
            RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $forged$
            DECLARE sources jsonb;
            BEGIN
              PERFORM set_config('app.fixture_forged_port_executed','true',true);
              SELECT coalesce(jsonb_agg(o.source_scope||jsonb_build_object('resourceKind','application_field',
                'resourceId',o.resource_id,'version',o.version)),'[]') INTO sources
              FROM jsonb_array_elements(roots) r JOIN application_field_observations o
                ON o.workspace_id=w AND o.resource_id=(r->>'id')::uuid AND o.version=r->>'version'
              WHERE r->>'kind'='application_field';
              RETURN jsonb_build_object('available',true,'admitted',true,'validUntil','infinity',
                'immutable',sources,'current',sources,'forged',true);
            END $forged$ $definition$;
        ELSE RAISE EXCEPTION 'Unknown fixture action';END IF;
        RETURN '{}'::jsonb;
      END $fixture$;
      REVOKE ALL ON FUNCTION ${helper}(text,jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION ${helper}(text,jsonb) TO app_user`)
    await f.pool.query(`CREATE FUNCTION ${cacheHelper}(arg jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE w uuid:='${f.workspaceId}';s uuid:='${f.session.id}';roots jsonb;captured jsonb;meta jsonb;frame jsonb;scopes jsonb;
        fields text[];t text:=arg->>'type';message_id uuid;point jsonb;point_key text;points jsonb:='{}';slots jsonb:='{}';values_array jsonb[]:='{}';
        raw_fields text[];raw_key text;raw_unresolved boolean:=false;
        union_child jsonb;loop_sources jsonb:='[]';batch_sources jsonb;
        parent jsonb;bounds jsonb;visibility jsonb;original jsonb;cached jsonb;memo jsonb:='{"nativeWorklist":true}';
      BEGIN
        IF arg ? 'unionChildren' THEN
          FOR union_child IN SELECT value FROM jsonb_array_elements(arg->'unionChildren') LOOP
            loop_sources:=loop_sources||jsonb_build_array(union_child->'source')||coalesce(union_child->'sources','[]');
          END LOOP;
          SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO loop_sources
            FROM (SELECT DISTINCT value FROM jsonb_array_elements(loop_sources)) unique_sources;
          SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO batch_sources FROM (
            SELECT DISTINCT expanded.value FROM jsonb_array_elements(arg->'unionChildren') AS child_row(value)
            CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(child_row.value->'source')||coalesce(child_row.value->'sources','[]')) expanded(value)
          ) unique_sources;
          RETURN jsonb_build_object('loop',loop_sources,'batch',batch_sources);
        END IF;
        SELECT jsonb_agg(jsonb_build_object('kind','session_message','id',id,'version',scope_version::text)) INTO roots
          FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num<=3;
        captured:=native_retained_capture_requirements(w,roots,jsonb_build_array(
          jsonb_build_object('type','session_message','sessionId',s,'through',3),
          jsonb_build_object('type','session_message_annotation','sessionId',s,'through',3)));
        IF captured->>'admitted' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Fixture canonical admission failed';END IF;
        meta:=captured->'metadata';frame:=native_turn_capture_sources(w,meta);
        SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),true) INTO scopes
          FROM jsonb_array_elements(meta#>'{witness,graph,nodes}') n
          WHERE n->>'tag'='source' AND n->>'kind' IN('session_message','session_context_revision','workspace_file','episode','recording');
        frame:=frame||jsonb_build_object('validUntil',captured->'validUntil',
          'sourceKeys',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id')||':'||(n->>'version'),true)
            FROM jsonb_array_elements(meta#>'{witness,graph,nodes}') n WHERE n->>'tag'='source'),
          'edges',(SELECT jsonb_object_agg(key,'[]'::jsonb) FROM jsonb_object_keys(scopes) key),
          'privacyCovered',(SELECT jsonb_object_agg((n->>'kind')||':'||(n->>'id'),true)
            FROM jsonb_array_elements(meta#>'{witness,privacyGraph,nodes}') n));
        SELECT array_agg(value ORDER BY value) INTO fields FROM jsonb_array_elements_text(arg->'fields');
        IF arg->>'rawFirst'='true' THEN
          SELECT array_agg(value ORDER BY ordinality) INTO raw_fields FROM jsonb_array_elements_text(arg->'fields') WITH ORDINALITY;
          SELECT id INTO message_id FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num=1;
          point:=native_turn_compact_point(w,t,message_id,raw_fields,memo,frame,scopes);
          raw_key:=jsonb_build_array(t,message_id,raw_fields)::text;
          points:=points||jsonb_build_object(raw_key,coalesce(point->'value','null'::jsonb));
          -- The raw point cannot impersonate its still-uncompleted sorted peer.
          BEGIN
            PERFORM native_turn_compact_envelope(w,t,message_id,'query',raw_fields,memo,frame,points);
          EXCEPTION WHEN SQLSTATE 'PNT01' THEN raw_unresolved:=true;END;
        END IF;
        FOR message_id IN SELECT id FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num<=3 ORDER BY sequence_num,id LOOP
          point:=native_turn_compact_point(w,t,message_id,fields,memo,frame,scopes);
          point_key:=jsonb_build_array(t,message_id,fields)::text;
          points:=points||jsonb_build_object(point_key,coalesce(point->'value','null'::jsonb));
          point:=native_turn_compact_envelope(w,t,message_id,'query',fields,memo,frame,points)->'value';
          values_array:=array_append(values_array,point);
          slots:=slots||jsonb_build_object(point_key,cardinality(values_array));
          IF arg->>'dropFirst'='true' AND cardinality(values_array)=1 THEN slots:=slots-point_key;END IF;
        END LOOP;
        parent:=native_turn_parent(w,s,frame);bounds:=native_turn_session_bounds(w,parent);
        IF arg->>'narrow'='true' THEN bounds:=application_query_scope_cap(sensitivity_rank('public'),'[]','[]');END IF;
        visibility:=jsonb_build_object('userId',NULL,'assistants',NULL);
        -- Keep the caller's ordered mask in each scan's output, independently of lookup normalization.
        SELECT array_agg(value ORDER BY ordinality) INTO fields FROM jsonb_array_elements_text(arg->'fields') WITH ORDINALITY;
        original:=native_turn_compact_scan(w,s,t,(arg->>'through')::integer,fields,bounds,visibility,memo,frame,points);
        cached:=native_retained_cached_scan(w,s,t,(arg->>'through')::integer,fields,bounds,visibility,memo,frame,points,slots,values_array);
        RETURN jsonb_build_object('original',original,'cached',cached,
          'negativeSlots',(SELECT count(*) FROM unnest(values_array) value WHERE value IS NULL),
          'rawUnresolvedBeforePeer',raw_unresolved,'rawAliasSlot',coalesce(slots ? raw_key,false));
      END $fixture$;
      REVOKE ALL ON FUNCTION ${cacheHelper}(jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION ${cacheHelper}(jsonb) TO app_user`)
  }, 120_000)
  afterAll(async () => {
    try { await getPool().query(`DROP FUNCTION IF EXISTS ${helper}(text,jsonb);DROP FUNCTION IF EXISTS ${cacheHelper}(jsonb)`); await f?.cleanup() }
    finally { await getAppPool().end(); await getPool().end() }
  })

  it.each([[3, 3], [2, 3], [3, 2], [3, 0]])('matches canonical captures at independent body/topic bounds %i/%i', async (body, topics) => frame(async client => {
    const actual = await acquire(client, body, topics)
    expect(actual).not.toBeNull()
    expect({ history: actual!.history, annotations: actual!.annotations }).toEqual(await original(client, body, topics))
    expect(actual!.history.slice(1).map((row: Json) => row.row.id)).toEqual(messageIds.slice(0, body))
    expect(actual!.annotations.slice(1).map((row: Json) => row.row.id)).toEqual(topics >= 3 ? [messageIds[2]] : [])
    for (const source of nativeSessionQueryCaptureSources(actual as any, f.workspaceId)) {
      expect(actual!.proof.immutable).toContainEqual(source)
      expect(actual!.proof.current).toContainEqual(source)
    }
  }), 60_000)

  it.each([
    { type:'session_message',fields:['content','id'],through:3,narrow:false },
    { type:'session_message',fields:['id','content'],through:2,narrow:true },
    { type:'session_message_annotation',fields:['topicLabel','id'],through:3,narrow:false },
    { type:'session_message_annotation',fields:['id','topicLabel'],through:2,narrow:false },
    { type:'session_message_annotation',fields:['id'],through:0,narrow:false },
  ])('matches complete canonical scan packets for $type through $through with narrow=$narrow',async selector=>frame(async client=>{
    const packet=(await client.query(`SELECT ${cacheHelper}($1::jsonb) value`,[JSON.stringify(selector)])).rows[0].value
    expect(packet.cached).toEqual(packet.original)
    if(selector.type==='session_message_annotation')expect(Number(packet.negativeSlots)).toBe(2)
    if(selector.narrow||selector.through===0)expect(packet.cached.value.candidates).toEqual([])
  }),60_000)

  it('keeps an unsorted point distinct until its actual canonical-mask peer completes',async()=>frame(async client=>{
    const packet=(await client.query(`SELECT ${cacheHelper}($1::jsonb) value`,[JSON.stringify({
      type:'session_message',fields:['id','content'],through:3,rawFirst:true,
    })])).rows[0].value
    expect(packet.rawUnresolvedBeforePeer).toBe(true)
    expect(packet.rawAliasSlot).toBe(false)
    expect(packet.cached).toEqual(packet.original)
    expect(packet.cached.value.candidates).toHaveLength(3)
  }))

  it('refuses an absent query-envelope slot rather than treating it as a completed negative',async()=>{
    await expect(frame(client=>client.query(`SELECT ${cacheHelper}($1::jsonb) value`,[JSON.stringify({
      type:'session_message_annotation',fields:['id'],through:3,dropFirst:true,
    })]))).rejects.toMatchObject({code:'PNT01',message:'native_turn_requirement_unresolved'})
  })

  it.each([
    { children:[],expected:[] },
    { children:[{source:{id:'a'},sources:[{id:'a'},{id:'b'}]},{source:{id:'b'},sources:[{id:'a'}]}],expected:[{id:'a'},{id:'b'}] },
    { children:[{source:null,sources:null},{},null],expected:[null] },
    { children:[{source:'direct',sources:{id:'declared'}},{source:'direct',sources:'scalar'},{source:'direct',sources:7}],expected:['direct',{id:'declared'},'scalar',7] },
    { children:[{source:['a'],sources:[['b'],['a']]}],expected:[['a'],['b']] },
  ])('preserves exact canonical source-union concatenation and distinct ordering for $children',async({children,expected})=>frame(async client=>{
    const packet=(await client.query(`SELECT ${cacheHelper}($1::jsonb) value`,[JSON.stringify({unionChildren:children})])).rows[0].value
    expect(packet.batch).toEqual(packet.loop)
    expect(packet.batch).toHaveLength(expected.length)
    for(const source of expected)expect(packet.batch).toContainEqual(source)
  }))

  it('freshly refuses a captured body after its payload changes without a scope bump', async () => {
    const captured = await frame(client => acquire(client))
    expect(captured).not.toBeNull()
    const sources = nativeSessionQueryCaptureSources(captured as any, f.workspaceId)
    const before = (await f.pool.query('SELECT content,scope_version FROM session_messages WHERE id=$1', [messageIds[1]])).rows[0]
    // Explicit legacy-corruption injection on this disposable fixture. Restore
    // the one named version trigger before the actual reader runs, so only the
    // payload digest (not a version bump or descendant hold) can reject the read.
    async function legacyBody(content: unknown) {
      const client = await f.pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('ALTER TABLE session_messages DISABLE TRIGGER canonical_scope_version')
        await client.query('UPDATE session_messages SET content=$2::jsonb WHERE id=$1', [messageIds[1], JSON.stringify(content)])
        await client.query('ALTER TABLE session_messages ENABLE TRIGGER canonical_scope_version')
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    try {
      await legacyBody([{type:'text',text:'Fictional unversioned body replacement'}])
      expect((await f.pool.query('SELECT scope_version FROM session_messages WHERE id=$1', [messageIds[1]])).rows[0].scope_version).toBe(before.scope_version)
      await frame(async client => { expect((await sourceProof(client, sources))?.admitted).not.toBe(true) })
    } finally { await legacyBody(before.content) }
  })

  it('keeps empty and scope-hidden candidate profiles on pre-write fallback', async () => {
    const before = await counts()
    await frame(async client => { expect(await acquire(client, 0, 0)).toBeNull() })
    await frame(async client => {
      await client.query('SAVEPOINT hidden_candidate')
      try {
        await client.query(`SELECT ${helper}('hidden')`)
        expect(await acquire(client)).toBeNull()
        const expected = await original(client)
        expect(expected.history.slice(1).map(row => row.row?.id)).not.toContain(messageIds[0])
      } finally { await client.query('ROLLBACK TO SAVEPOINT hidden_candidate;RELEASE SAVEPOINT hidden_candidate') }
    })
    expect(await counts()).toEqual(before)
  }, 60_000)

  it('preserves missing-head negative evidence when an annotation later appears inside its bound', async () => {
    const before = await frame(client => acquire(client, 3, 2))
    expect(before).not.toBeNull()
    expect(before!.annotations).toHaveLength(1)
    expect(await annotate(messageIds[0], 'Fictional newly available topic')).not.toBeNull()
    const sources = nativeSessionQueryCaptureSources(before as any, f.workspaceId)
    await frame(async client => { expect((await sourceProof(client, sources))?.admitted).not.toBe(true) })
    const after = await frame(client => acquire(client, 3, 2))
    expect(after!.annotations.slice(1).map((row: Json) => row.row.id)).toEqual([messageIds[0]])
  }, 60_000)

  it('does not let an outside-bound append change the original query observation', async () => {
    const before = await frame(client => acquire(client, 2, 1))
    await addSessionMessage({ sessionId: f.session.id, role: 'user', content: 'Fictional later request', scope: f.envelope })
    const after = await frame(client => acquire(client, 2, 1))
    expect(after).toEqual(before)
  }, 60_000)

  it.each(['body', 'hold', 'membership'] as const)('rolls back all observations after post-materialization %s changes', async change => {
    const trigger = `native_query_change_${randomUUID().replaceAll('-', '')}`
    const before = await counts()
    const mutation = change === 'body' ? `UPDATE session_messages SET content='"Fictional body changed without a scope bump"'::jsonb WHERE id='${messageIds[1]}'::uuid;`
      : change === 'hold' ? `UPDATE session_messages SET scope_held=true WHERE id='${messageIds[1]}'::uuid;`
        : `UPDATE workspace_members SET clearance='public' WHERE workspace_id='${f.workspaceId}'::uuid AND user_id='${f.firstId}'::uuid;`
    await f.pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      BEGIN IF NEW.workspace_id='${f.workspaceId}'::uuid THEN ${mutation} END IF;RETURN NULL;END $fixture$;
      CREATE TRIGGER ${trigger} AFTER INSERT ON application_field_observations FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    try {
      // The newly appended fourth message has not yet been captured by this suite.
      await expect(frame(client => acquire(client, 4, 4))).rejects.toMatchObject({ code: 'scope_source_changed', cause: { code: '42501', message: 'scope_source_changed' } })
      expect(await counts()).toEqual(before)
    } finally { await f.pool.query(`DROP TRIGGER ${trigger} ON application_field_observations;DROP FUNCTION ${trigger}()`) }
  }, 60_000)

  it('authenticates the complete retained closure before original proof and publication dispatchers invoke it', async () => {
    const captured=await frame(client=>acquire(client))
    expect(captured).not.toBeNull()
    const sources=nativeSessionQueryCaptureSources(captured as any,f.workspaceId)
    const roots=sources.map(source=>({kind:source.resourceKind,id:source.resourceId,version:source.version}))
    await frame(async client=>{
      expect((await client.query(`SELECT ${helper}('prepare',$1::jsonb) value`,[JSON.stringify(sources)])).rows[0].value).not.toBeNull()
      await client.query('SAVEPOINT forged_retained_port')
      try{
        await client.query("SELECT set_config('app.fixture_forged_port_executed','false',true)")
        await client.query(`SELECT ${helper}('forge-port')`)
        await client.query(`SELECT ${helper}('hold')`)
        const original=(await client.query(`SELECT ${helper}('requirements',$1::jsonb) value`,[JSON.stringify(roots)])).rows[0].value
        expect(original?.available).not.toBe(true)
        expect((await client.query(`SELECT ${helper}('prepare',$1::jsonb) value`,[JSON.stringify(sources)])).rows[0].value).toBeNull()
        expect(await sourceProof(client,sources)).toBeNull()
        expect((await client.query("SELECT current_setting('app.fixture_forged_port_executed',true) value")).rows[0].value).toBe('false')
      }finally{await client.query('ROLLBACK TO SAVEPOINT forged_retained_port;RELEASE SAVEPOINT forged_retained_port')}
    })
    expect(await frame(client=>acquire(client))).not.toBeNull()
  },60_000)

  it('checks a historical annotation ancestor under the same stable query-field identity before payload', async () => {
    const foreign = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.ownerId,
      workspaceId: f.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
    await addSessionMessage({ sessionId: foreign.id, role: 'user', content: 'Fictional historical annotation source', scope: f.envelope })
    const foreignAuthority = { execution: await f.execution(f.firstId, foreign), accumulator: new ContextScopeAccumulator() }
    const foreignQuery = await readAdmittedSessionQuery({ sessionId: foreign.id, throughSequence: 1, topicThroughSequence: 0, authority: foreignAuthority })
    const old = await writeSessionContextRevision({ sessionId: f.session.id, parentId: messageIds[1], kind: 'message_annotation',
      content: { topicLabel: 'Fictional historical topic', topicConfidence: 0.9, replyToText: null }, authority: authority(),
      derivation: { producer: 'fixture:historical-query', sources: boundScopeSources(foreignQuery) } })
    expect(old).not.toBeNull()
    // Persist the original point observation before advancing this message's head.
    await frame(client => original(client, 3, 3))
    expect(await annotate(messageIds[1], 'Fictional replacement topic', old!.id)).not.toBeNull()
    const before = await counts()
    await f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1', [foreign.id])
    await frame(async client => { expect(await acquire(client, 3, 3)).toBeNull() })
    expect(await counts()).toEqual(before)
    // Keep the privacy hold intact; disposable workspace cleanup owns teardown.
  }, 60_000)

  it('falls back before materialization when a private capture helper changes', async () => {
    const before = await counts()
    await frame(async client => {
      await client.query('SAVEPOINT helper_drift')
      try {
        await client.query(`SELECT ${helper}('drift')`)
        expect(await acquire(client)).toBeNull()
      } finally { await client.query('ROLLBACK TO SAVEPOINT helper_drift;RELEASE SAVEPOINT helper_drift') }
    })
    expect(await counts()).toEqual(before)
  })

  it('does not expose selector compiler, completed frames or materializer to app_user', async () => frame(async client => {
    const rows = (await client.query(`SELECT p.oid::regprocedure::text signature FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[])
      AND has_function_privilege(current_user,p.oid,'EXECUTE')`, [[
      'native_retained_metadata(uuid,jsonb,jsonb,boolean)', 'native_retained_capture_requirements(uuid,jsonb,jsonb)',
      'native_retained_capture_plan(uuid,jsonb,jsonb)', 'native_retained_graph_append(jsonb,jsonb,boolean)',
      'native_retained_helpers_current()', 'read_native_retained_requirements(uuid,jsonb,jsonb)',
      'native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)',
      'application_materialize_field_envelope(uuid,jsonb,integer)',
    ]])).rows
    expect(rows).toEqual([])
  }))
})
