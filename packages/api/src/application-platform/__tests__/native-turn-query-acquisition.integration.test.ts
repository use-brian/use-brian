import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { applyApplicationRLSContext, releaseApplicationTransactionBinding } from '../execution-context.js'
import { readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { readRetainedContextFrame, writeSessionContextRevision } from '../../db/session-context-revisions.js'
import { addSessionMessage, createWorkspaceChatSession } from '../../db/sessions.js'
import { conversationCaptureSources, captureConversationQuery } from '../../db/conversation-store.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
type Json = Record<string, any>
const helper = `native_query_fixture_${randomUUID().replaceAll('-', '')}`
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
async function counts(workspaceId = f.workspaceId) {
  return (await f.pool.query(`SELECT (SELECT count(*)::integer FROM application_field_resources WHERE workspace_id=$1) resources,
    (SELECT count(*)::integer FROM application_field_observations WHERE workspace_id=$1) fields,
    (SELECT count(*)::integer FROM application_field_observation_sources WHERE workspace_id=$1) sources,
    (SELECT count(*)::integer FROM application_query_domains WHERE workspace_id=$1) domains`, [workspaceId])).rows[0]
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

describe.sequential('[COMP:api/native-turn-frame] canonical conversation query acquisition', () => {
  beforeAll(async () => {
    f = await persistentContextFixture()
    messageIds = (await f.history()).map(message => message.id)
    execution = await f.execution(f.firstId)
    expect(await annotate(messageIds[2], 'Fictional final topic')).not.toBeNull()
    await f.pool.query(`CREATE FUNCTION ${helper}(action text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $fixture$
      BEGIN
        IF action='trace' THEN PERFORM set_config('track_functions','all',true);
        ELSIF action='stats' THEN RETURN coalesce((SELECT jsonb_object_agg(p.oid::regprocedure::text,s.calls)
          FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid),'{}'::jsonb);
        ELSIF action='hidden' THEN UPDATE session_messages SET sensitivity='confidential' WHERE id='${messageIds[0]}'::uuid;
        ELSIF action='drift' THEN ALTER FUNCTION native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb) COST 101;
        ELSE RAISE EXCEPTION 'Unknown fixture action';END IF;
        RETURN '{}'::jsonb;
      END $fixture$;
      REVOKE ALL ON FUNCTION ${helper}(text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION ${helper}(text) TO app_user`)
  }, 120_000)
  afterAll(async () => {
    try { await getPool().query(`DROP FUNCTION IF EXISTS ${helper}(text)`); await f?.cleanup() }
    finally { await getAppPool().end(); await getPool().end() }
  })

  it.each([[3, 3], [2, 3], [3, 2], [3, 0]])('matches canonical captures at independent body/topic bounds %i/%i', async (body, topics) => frame(async client => {
    const actual = await acquire(client, body, topics)
    expect(actual).not.toBeNull()
    expect(Object.keys(actual!).sort()).toEqual(['annotations','history'])
    expect(actual!.history.slice(1).map((row: Json) => row.row.id)).toEqual(messageIds.slice(0, body))
    expect(actual!.annotations.slice(1).map((row: Json) => row.row.id)).toEqual(topics >= 3 ? [messageIds[2]] : [])
    const proof=await sourceProof(client,conversationCaptureSources(actual as any,f.workspaceId))
    expect(proof?.admitted).toBe(true)
  }), 60_000)

  it('uses one query operation and does not invoke a retired query reader', async () => frame(async client => {
    await client.query(`SELECT ${helper}('trace')`)
    const before = (await client.query(`SELECT ${helper}('stats') value`)).rows[0].value as Json
    expect(await acquire(client)).not.toBeNull()
    const after = (await client.query(`SELECT ${helper}('stats') value`)).rows[0].value as Json
    const difference = (signature: string) => (after[signature] ?? 0) - (before[signature] ?? 0)
    expect(difference('capture_conversation_query(uuid,uuid,integer,integer)')).toBe(1)
    expect(difference('native_turn_capture_compact_requirements(uuid,jsonb,jsonb)')).toBe(0)
    expect(difference('read_native_turn_compact_requirements(uuid,jsonb,jsonb)')).toBe(0)
    expect(difference('read_native_turn_query_requirements(uuid,jsonb,jsonb)')).toBe(0)
    expect(difference('read_native_turn_requirements(uuid,jsonb)')).toBe(0)
    expect(difference('capture_native_session_projection_batch(uuid,uuid,integer,text)')).toBe(0)
    expect(difference('native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)')).toBe(0)
  }), 60_000)

  it('captures empty queries and filters inaccessible candidates without a fallback', async () => {
    await frame(async client => {
      const empty=await acquire(client,0,0)
      expect(empty?.history).toHaveLength(1);expect(empty?.annotations).toHaveLength(1)
    })
    await frame(async client => {
      await client.query('SAVEPOINT hidden_candidate')
      try {
        await client.query(`SELECT ${helper}('hidden')`)
        const captured=await acquire(client)
        expect(captured?.history.slice(1).map((row:Json)=>row.row.id)).toEqual(messageIds.slice(1))
      } finally { await client.query('ROLLBACK TO SAVEPOINT hidden_candidate;RELEASE SAVEPOINT hidden_candidate') }
    })
  },60_000)

  it('preserves missing-head negative evidence when an annotation later appears inside its bound', async () => {
    const before = await frame(client => acquire(client, 3, 2))
    expect(before).not.toBeNull()
    expect(before!.annotations).toHaveLength(1)
    expect(await annotate(messageIds[0], 'Fictional newly available topic')).not.toBeNull()
    const sources = conversationCaptureSources(before as any, f.workspaceId)
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

  it.each(['hold', 'membership'] as const)('rechecks concurrent %s at the observation boundary', async change => {
    const current = await persistentContextFixture()
    const latch = `native_query_latch_${randomUUID().replaceAll('-', '')}`
    let barrier: PoolClient | undefined
    let mutator: PoolClient | undefined
    let pending: Promise<unknown> | undefined
    let pendingChange: Promise<unknown> | undefined
    try {
      const history = await current.history()
      const first = history[0]
      const selection = { sessionId: current.session.id, throughSequence: history.at(-1)!.sequenceNum, topicThroughSequence: 0 }
      const context = await current.modelContext(current.firstId)

      // The barrier holds the app reader after its first graph read. A third
      // connection can now change unpinned state or prove it waits on a pin.
      await current.pool.query(`CREATE FUNCTION ${latch}() RETURNS trigger LANGUAGE plpgsql
        SET search_path=pg_catalog,public,pg_temp AS $fixture$
        BEGIN
          IF NEW.workspace_id='${current.workspaceId}'::uuid THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('${latch}',0));
          END IF;
          RETURN NULL;
        END $fixture$;
        CREATE TRIGGER ${latch} AFTER INSERT ON application_field_observations FOR EACH ROW EXECUTE FUNCTION ${latch}()`)

      const before = await counts(current.workspaceId)
      barrier = await current.pool.connect()
      await barrier.query('BEGIN')
      const locker = (await barrier.query<{ pid: number }>(
        'SELECT pg_backend_pid() pid,pg_advisory_xact_lock(hashtextextended($1,0))', [latch])).rows[0]
      mutator = await current.pool.connect()
      await mutator.query('BEGIN')
      await mutator.query("SET LOCAL statement_timeout='5s'")
      const writer = (await mutator.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]

      const readAsOriginalMember = (started?: (pid: number) => void) => runWithAgentAccess(context.execution.security.access, async () => {
        const client = await getAppPool().connect()
        try {
          await client.query('BEGIN')
          await applyRLSGucs(client, current.firstId, current.assistantId)
          await applyApplicationRLSContext(client, context.execution)
          const reader = (await client.query<{ pid: number; role: string; login: string }>(
            'SELECT pg_backend_pid() pid,current_user AS role,session_user AS login')).rows[0]
          expect(reader).toMatchObject({ role: 'app_user', login: 'app_user' })
          started?.(reader.pid)
          const captured = await captureConversationQuery(client, current.workspaceId, selection)
          await client.query('COMMIT')
          return captured.history.slice(1).map(entry => entry.row?.id)
        } finally {
          releaseApplicationTransactionBinding(client)
          await rollbackAndRelease(client)
        }
      }).then(value => ({ value }), error => ({ error }))

      let readerPid: number | undefined
      pending = readAsOriginalMember(pid => { readerPid = pid })

      const blockedBy = async (pid: number, blocker: number) => (await current.pool.query<{ blocked: boolean }>(
        'SELECT $2::integer=ANY(pg_blocking_pids($1)) blocked', [pid, blocker])).rows[0].blocked
      await expect.poll(async () => {
        return readerPid !== undefined && blockedBy(readerPid, locker.pid)
      }, { timeout: 8_000 }).toBe(true)

      if (change === 'hold') {
        expect((await mutator.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,
          review_state,classification_revision,holding_reason)
          SELECT workspace_id,'session_message',id,scope_version::text,'held',1,'Concurrent fixture hold' FROM session_messages WHERE id=$1`,
        [first.id])).rowCount).toBe(1)
        await mutator.query('COMMIT')
        await barrier.query('ROLLBACK')
        expect(await pending).toMatchObject({ error: { code: '42501', message: 'scope_source_changed' } })
        expect(await counts(current.workspaceId)).toEqual(before)
      } else {
        const membership = mutator
        pendingChange = membership.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",
          [current.workspaceId, current.firstId]).then(async result => {
          await membership.query('COMMIT')
          return { updated: result.rowCount }
        }).catch(error => ({error}))
        await expect.poll(() => blockedBy(writer.pid, readerPid!), { timeout: 4_000 }).toBe(true)
        await barrier.query('ROLLBACK')
        expect(await pending).toEqual({ value: history.map(message => message.id) })
        expect(await pendingChange).toEqual({ updated: 1 })
        expect(await readAsOriginalMember()).toMatchObject({ error: { code: '42501', message: 'scope_source_changed' } })
      }

      const stillAuthorized = await current.modelContext(current.secondId)
      const recaptured = await readAdmittedSessionQuery({ ...selection, authority: stillAuthorized })
      expect(recaptured.history.map(message => message.id)).toEqual(history.slice(change === 'hold' ? 1 : 0).map(message => message.id))
    } finally {
      if (barrier) await rollbackAndRelease(barrier)
      await pending
      await pendingChange
      if (mutator) await rollbackAndRelease(mutator)
      await current.pool.query(`DROP TRIGGER IF EXISTS ${latch} ON application_field_observations;DROP FUNCTION IF EXISTS ${latch}()`)
      await current.cleanup()
    }
  }, 60_000)

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
    await frame(async client => {
      const captured=await acquire(client,3,3)
      expect(captured?.annotations.slice(1).map((row:Json)=>row.row.id)).not.toContain(messageIds[1])
    })
    // Keep the privacy hold intact; disposable workspace cleanup owns teardown.
  }, 60_000)

  it('refuses before materialization when a private capture helper changes', async () => {
    const before = await counts()
    await frame(async client => {
      await client.query('SAVEPOINT helper_drift')
      try {
        await client.query(`SELECT ${helper}('drift')`)
        await expect(acquire(client)).rejects.toMatchObject({code:'42501',message:'scope_source_changed'})
      } finally { await client.query('ROLLBACK TO SAVEPOINT helper_drift;RELEASE SAVEPOINT helper_drift') }
    })
    expect(await counts()).toEqual(before)
  })

  it('has removed the old query entry points from the installed database',async()=>{
    const rows=(await f.pool.query(`SELECT to_regprocedure(signature) routine FROM unnest($1::text[]) signature`,[[
      'read_native_turn_session_query(uuid,uuid,integer,integer)',
      'read_native_retained_session_query(uuid,uuid,integer,integer)',
      'read_native_session_query_evidence(uuid,uuid,integer,integer)',
      'read_native_application_session_history(uuid,uuid,integer)',
      'read_native_application_session_topics(uuid,uuid,integer)',
    ]])).rows
    expect(rows.every(row=>row.routine===null)).toBe(true)
  })

  it('does not expose selector compiler, completed frames or materializer to app_user', async () => frame(async client => {
    const rows = (await client.query(`SELECT p.oid::regprocedure::text signature FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[])
      AND has_function_privilege(current_user,p.oid,'EXECUTE')`, [[
      'conversation_dag(uuid,jsonb,jsonb)', 'conversation_dag_edges(uuid,jsonb)',
      'native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)',
      'application_materialize_field_envelope(uuid,jsonb,integer)',
    ]])).rows
    expect(rows).toEqual([])
  }))
})
