/** [COMP:api/native-chat-read-cost] Direct packed entry point; no legacy success can satisfy these assertions. */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { getAppPool, getPool } from '../../db/client.js'
import { readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { readRetainedContextFrame, writeSessionContextRevision } from '../../db/session-context-revisions.js'
import { addSessionMessage, createWorkspaceChatSession } from '../../db/sessions.js'
import { conversationCaptureSources, captureConversationQuery } from '../../db/conversation-store.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
type Json = Record<string, any>
const helper = `retained_query_fixture_${randomUUID().replaceAll('-', '')}`
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let execution: ExecutionContext
let messageIds: string[]
const authority = () => ({ execution, accumulator: new ContextScopeAccumulator() })
async function frame<T>(run: (client: PoolClient) => Promise<T>) { return readRetainedContextFrame(authority(), [], run) }
async function acquire(client: PoolClient, body = 3, topics = body): Promise<Json | null> {
  return (await client.query('SELECT capture_conversation_query($1,$2,$3,$4) value', [f.workspaceId, f.session.id, body, topics])).rows[0].value
}
async function original(client: PoolClient, body = 3, topics = body) {
  return captureConversationQuery(client, f.workspaceId, { sessionId: f.session.id, throughSequence: body, topicThroughSequence: topics })
}
async function counts() {
  return (await f.pool.query(`SELECT (SELECT count(*)::integer FROM application_field_observations WHERE workspace_id=$1) fields,
    (SELECT count(*)::integer FROM application_query_domains WHERE workspace_id=$1) domains`, [f.workspaceId])).rows[0]
}
async function sourceProof(client: PoolClient, sources: ScopeSource[]) {
  return (await client.query('SELECT capture_conversation_evidence($1,$2) value', [f.workspaceId,
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
      DECLARE w constant uuid:='${f.workspaceId}'; s constant uuid:='${f.session.id}';
        fields text[]; bounds jsonb; visibility jsonb; memo jsonb; ordered jsonb; empty jsonb; invalid jsonb;
      BEGIN
        IF action='hidden' THEN UPDATE session_messages SET sensitivity='confidential' WHERE id='${messageIds[0]}'::uuid;
        ELSIF action='drift' THEN ALTER FUNCTION native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb) COST 101;
        ELSIF action='requirements' THEN RETURN capture_conversation_evidence('${f.workspaceId}'::uuid,arg);
        ELSIF action='prepare' THEN RETURN conversation_prepare_publications('${f.workspaceId}'::uuid,'${f.session.id}'::uuid,
          jsonb_build_array(jsonb_build_object('producer','fixture:authenticated-retained-port','sources',arg,'target','${JSON.stringify(f.envelope).replaceAll("'", "''")}'::jsonb)))->0;
        ELSIF action='hold' THEN UPDATE session_messages SET scope_held=true WHERE id='${messageIds[1]}'::uuid;
        ELSIF action='hold-message' THEN UPDATE session_messages SET scope_held=true WHERE session_id='${f.session.id}'::uuid AND id=(arg#>>'{}')::uuid;
        ELSIF action='selection' THEN
          fields:=ARRAY(SELECT f FROM unnest(application_session_field_keys('session_message')) f ORDER BY f);
          bounds:=application_session_query_bounds(w,application_session_query_parent(w,s));
          visibility:=jsonb_build_object('userId',NULL,'assistants',NULL);
          memo:=conversation_dag(w,'[]',jsonb_build_array(jsonb_build_object('type','session_message','sessionId',s,'through',3)))
            ||jsonb_build_object('opaque',repeat('Fictional opaque retained graph ',32768));
          ordered:=capture_conversation_selection(w,s,'session_message',3,fields,bounds,visibility,memo);
          empty:=capture_conversation_selection(w,s,'session_message',0,fields,bounds,visibility,memo);
          invalid:=capture_conversation_selection(w,s,'session_message',-1,fields,bounds,visibility,memo);
          RETURN jsonb_build_object('ordered',ordered-'memo','empty',empty-'memo','invalid',invalid-'memo',
            'copiedMemo',jsonb_build_array(ordered?'memo',empty?'memo',invalid?'memo'));
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

  }, 120_000)
  afterAll(async () => {
    try { await getPool().query(`DROP FUNCTION IF EXISTS ${helper}(text,jsonb)`); await f?.cleanup() }
    finally { await getAppPool().end(); await getPool().end() }
  })

  it('freshly refuses a captured body after its payload changes without a scope bump', async () => {
    const captured = await frame(client => acquire(client))
    expect(captured).not.toBeNull()
    const sources = conversationCaptureSources(captured as any, f.workspaceId)
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

  it('refuses held inputs without invoking a recreated retired reader', async () => {
    const captured=await frame(client=>acquire(client))
    expect(captured).not.toBeNull()
    const sources=conversationCaptureSources(captured as any,f.workspaceId)
    const roots=sources.map(source=>({kind:source.resourceKind,id:source.resourceId,version:source.version}))
    await frame(async client=>{
      expect((await client.query(`SELECT ${helper}('prepare',$1::jsonb) value`,[JSON.stringify(sources)])).rows[0].value).not.toBeNull()
      await client.query('SAVEPOINT forged_retained_port')
      try{
        await client.query("SELECT set_config('app.fixture_forged_port_executed','false',true)")
        await client.query(`SELECT ${helper}('forge-port')`)
        await client.query(`SELECT ${helper}('hold')`)
        const original=(await client.query(`SELECT ${helper}('requirements',$1::jsonb) value`,[JSON.stringify(roots)])).rows[0].value
        expect(original?.admitted).not.toBe(true)
        await client.query('SAVEPOINT refused_publication')
        await expect(client.query(`SELECT ${helper}('prepare',$1::jsonb) value`,[JSON.stringify(sources)]))
          .rejects.toMatchObject({code:'42501',message:'scope_source_changed'})
        await client.query('ROLLBACK TO SAVEPOINT refused_publication;RELEASE SAVEPOINT refused_publication')
        expect((await sourceProof(client,sources))?.admitted).not.toBe(true)
        expect((await client.query("SELECT current_setting('app.fixture_forged_port_executed',true) value")).rows[0].value).toBe('false')
      }finally{await client.query('ROLLBACK TO SAVEPOINT forged_retained_port;RELEASE SAVEPOINT forged_retained_port')}
    })
    expect(await frame(client=>acquire(client))).not.toBeNull()
  },60_000)

  it('does not expose selector compiler, completed frames or materializer to app_user', async () => frame(async client => {
    const rows = (await client.query(`SELECT p.oid::regprocedure::text signature FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[])
      AND has_function_privilege(current_user,p.oid,'EXECUTE')`, [[
      'conversation_dag(uuid,jsonb,jsonb)', 'conversation_capture_privacy(uuid,jsonb)',
      'conversation_dag_edges(uuid,jsonb)',
      'conversation_dag_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb[])',
      'native_retained_helpers_current()',
      'capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)',
      'native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)',
      'application_materialize_field_envelope(uuid,jsonb,integer)',
    ]])).rows
    expect(rows).toEqual([])
  }))

  it('returns only selection results without copying the graph memo', async () => frame(async client => {
    const { ordered, empty, invalid, copiedMemo } = (await client.query<{ value: Json }>(`SELECT ${helper}('selection') value`)).rows[0].value
    for (const key of ['candidates', 'points', 'policies']) {
      expect(ordered.value[key].map((row: { id: string }) => row.id)).toEqual(messageIds)
      expect(empty.value[key]).toEqual([])
    }
    expect(ordered.children).toHaveLength(messageIds.length)
    expect(empty.children).toEqual([])
    expect(invalid).toEqual({})
    expect(copiedMemo).toEqual([false, false, false])
  }))

  it('preserves the admitted domain proof for repeated child roots in any order', async () => {
    const { history } = await frame(client => original(client))
    const [{ sources: [root, ...sources] }, ...points] = history
    expect(points).toHaveLength(3)
    expect(sources).toHaveLength(3)
    expect(sources).toEqual(expect.arrayContaining(points.map(point => point.sources[0])))
    const [inherited, second, third] = sources
    const children = [
      { source: third, sources: [inherited, second, inherited] },
      { source: second, sources: [third] },
    ]
    async function rebuildDomain(children: unknown[]) {
      // Reuse the real immutable domain state with a controlled child order and overlap.
      return (await f.pool.query<{ envelope: { value?: { source: ScopeSource; sources: ScopeSource[] } } }>(`
        SELECT conversation_dag_envelope(r.workspace_id,r.type_key,r.resource_id,r.selection,r.fields,
          '{"hasExternal":false}',jsonb_build_object('domains:'||r.resource_id,1),
          ARRAY[jsonb_build_object('value',jsonb_build_object('source',o.source_scope,
            'sourceKind',o.source_kind,'sourceId',o.source_id,'sourceVersion',o.source_version,
            'recordVersion',o.record_version,'policyVersion',o.policy_version,'fieldIdentity',r.field_identity),
            'children',$4::jsonb)]) envelope
        FROM application_field_resources r JOIN application_field_observations o
          ON o.workspace_id=r.workspace_id AND o.resource_id=r.id
        WHERE r.workspace_id=$1 AND r.id=$2 AND o.version=$3`,
      [f.workspaceId, root.resourceId, root.version, JSON.stringify(children)])).rows[0].envelope
    }
    expect((await rebuildDomain(children)).value).toMatchObject({ source: root, sources })
    expect((await rebuildDomain([...children].reverse())).value).toMatchObject({ source: root, sources })
    expect(await rebuildDomain(Array.from({ length: 4097 }, () => ({ source: null })))).toEqual({})
    expect(await rebuildDomain([{ source: root, sources: Array.from({ length: 4096 }, (_, index) => index) }])).toEqual({})

    await frame(async client => {
      expect(await sourceProof(client, [root])).toMatchObject({
        admitted: true,
        immutable: expect.arrayContaining([root, ...sources]),
        current: expect.arrayContaining([root, ...sources]),
      })
      await client.query('SAVEPOINT held_domain_child')
      try {
        await client.query(`SELECT ${helper}('hold')`)
        expect((await sourceProof(client, [root]))?.admitted).not.toBe(true)
      } finally { await client.query('ROLLBACK TO SAVEPOINT held_domain_child; RELEASE SAVEPOINT held_domain_child') }
      expect((await sourceProof(client, [root]))?.admitted).toBe(true)
    })
  })

  it('preserves ordered body and topic selections around a held annotated message', async () => {
    const messages: Awaited<ReturnType<typeof addSessionMessage>>[] = []
    const topics = ['Fictional early topic', 'Fictional held topic', 'Fictional later topic']
    const current = authority()
    const prior = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: 3, topicThroughSequence: 0, authority: current })
    for (const [index, topic] of topics.entries()) {
      const message = await addSessionMessage({ sessionId: f.session.id, role: 'user',
        content: [{ type: 'text', text: `Fictional ordered body ${index}` }], scope: f.envelope })
      messages.push(message)
      expect(await writeSessionContextRevision({ sessionId: f.session.id, parentId: message.id, kind: 'message_annotation',
        content: { topicLabel: topic, topicConfidence: 0.8, replyToText: null }, authority: authority(),
        derivation: { producer: 'fixture:ordered-topic', sources: boundScopeSources(prior) } })).not.toBeNull()
    }
    const [first, held, last] = messages
    await frame(async client => {
      const before = await original(client, last.sequenceNum)
      expect(before.history.slice(-3).map(point => point.row?.id)).toEqual(messages.map(message => message.id))
      expect(before.annotations.slice(-3).map(point => point.row?.topicLabel)).toEqual(topics)
    })
    await frame(async client => {
      await client.query('SAVEPOINT held_annotation_fixture')
      try {
        await client.query(`SELECT ${helper}('hold-message',$1::jsonb)`, [JSON.stringify(held.id)])
        const captured = await original(client, last.sequenceNum)
        expect(captured.history.slice(-2).map(point => point.row)).toMatchObject([first, last].map(message => ({
          id: message.id, sequenceNum: message.sequenceNum, content: message.content,
        })))
        expect(captured.annotations.slice(-2).map(point => point.row)).toEqual([
          { id: first.id, sequenceNum: first.sequenceNum, topicLabel: topics[0], topicConfidence: 0.8, replyToText: null },
          { id: last.id, sequenceNum: last.sequenceNum, topicLabel: topics[2], topicConfidence: 0.8, replyToText: null },
        ])
        expect(captured.history.some(point => point.row?.id === held.id)).toBe(false)
        expect(captured.annotations.some(point => point.row?.id === held.id)).toBe(false)
        const earlierTopics = await original(client, last.sequenceNum, held.sequenceNum)
        expect(earlierTopics.history).toEqual(captured.history)
        expect(earlierTopics.annotations.at(-1)?.row?.id).toBe(first.id)
        expect(earlierTopics.annotations.some(point => point.row?.id === last.id)).toBe(false)
        const roots = conversationCaptureSources(captured, f.workspaceId)
        expect(await sourceProof(client, roots)).toMatchObject({ admitted: true })
      } finally { await client.query('ROLLBACK TO SAVEPOINT held_annotation_fixture; RELEASE SAVEPOINT held_annotation_fixture') }
    })
  }, 120_000)

  it('captures more than one hundred messages with growing payloads in the runtime SQL budget', async () => {
    const messages: Awaited<ReturnType<typeof addSessionMessage>>[] = []
    for (let index = 0; index < 101; index++) {
      messages.push(await addSessionMessage({ sessionId: f.session.id, role: 'user',
        content: [{ type: 'text', text: `Fictional retained request ${index} ${'payload '.repeat(index * 8)}` }], scope: f.envelope }))
    }
    const high = messages.at(-1)!.sequenceNum
    await frame(async client => {
      expect((await client.query("SELECT current_setting('statement_timeout') value")).rows[0].value).toBe('15s')
      const captured = await original(client, high)
      expect(captured.history.filter(row => row.row !== null)).toHaveLength(high)
      expect(captured.history.slice(-messages.length).map(point => point.row)).toMatchObject(messages.map(message => ({
        id: message.id, sequenceNum: message.sequenceNum, content: message.content,
      })))
      expect(captured.annotations.map(point => point.row?.topicLabel)).toContain('Fictional final topic')
    })
  }, 120_000)
})
