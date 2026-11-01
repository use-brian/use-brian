import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { boundScopeSources, ContextScopeAccumulator, type ExecutionContext, type ScopeSource } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { listWorkspaceFilesIndexRanked } from '../../db/workspace-files.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { writeSessionContextRevision } from '../../db/session-context-revisions.js'
import { publishNativeSessionMessage } from '../../db/session-message-publication.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
type Json = Record<string, any>
const wrapper = `annotation_source_fixture_${randomUUID().replaceAll('-', '')}`
const extraRole = `annotation_reader_${randomUUID().replaceAll('-', '')}`
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let execution: ExecutionContext
let files: ScopeSource[]
let roots: { kinds: string[]; ids: string[]; versions: string[] }
let through: number
const replies: string[] = []
let revisionId: string
const authority = () => ({ execution, accumulator: new ContextScopeAccumulator() })
async function operation<T = Json>(client: Pick<PoolClient, 'query'>, action: string, payload: unknown = {}): Promise<T> {
  return (await client.query<{ value: T }>(`SELECT public.${wrapper}($1,$2,$3) AS value`, [f.workspaceId, action, payload])).rows[0].value
}
async function frame<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await getAppPool().connect()
  try { return await runWithAgentAccess(execution.security.access, async () => {
    await client.query('BEGIN')
    await applyRLSGucs(client, execution.security.access.userId)
    await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [execution.assistant.id])
    return await run(client)
  }) } finally { await rollbackAndRelease(client) }
}
async function outcome(client: PoolClient, read: () => Promise<unknown>) {
  await client.query('SAVEPOINT evaluator_outcome')
  try { return { value: await read() } }
  catch (error) { const e = error as { code?: string; message: string }; return { error: e.code, message: e.message } }
  finally { await client.query('ROLLBACK TO SAVEPOINT evaluator_outcome') }
}
function expectScheduledFrame(actual: Json, original: Json) {
  const { memo: actualMemo, ...actualEvidence } = actual
  const { memo: originalMemo, ...originalEvidence } = original
  expect(actualEvidence).toEqual(originalEvidence)
  for (const [key, value] of Object.entries(originalMemo)) expect(actualMemo[key]).toEqual(value)
  for (const key of Object.keys(actualMemo).filter(key => !(key in originalMemo))) {
    expect(key).toMatch(/^native:(session_message|session_context_revision|memory|workspace_file):/)
    expect(actual.lineage.some((node: Json) => key === `native:${node.kind}:${node.id}:${node.version}`)).toBe(true)
    expect(actualMemo[key]).toEqual({ value: true, external: [] })
  }
}
async function prepared(client: PoolClient) {
  const result = await operation(client, 'frame', roots)
  expect(result).toMatchObject({ admitted: true })
  const seed = await operation(client, 'seed', roots)
  expect(seed).not.toBeNull()
  const checked = await operation(client, 'prime', { memo: { ...result.memo, nativeWorklist: true }, seed, revision: revisionId })
  expect(checked.value).toBe(true)
  const memo = checked.memo
  expect(memo[`native:session_context_revision:${revisionId}:1`]).toMatchObject({ value: true })
  return { seed, memo, message: replies.at(-1)! }
}

describe.sequential('[COMP:api/application-persistence] annotation source worklists', () => {
  beforeAll(async () => {
    f = await persistentContextFixture()
    await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
      SELECT $1,'/fictional/worklist-'||n||'.txt','Fictional worklist file '||n,'fixture://worklist-'||n,$2,'user','internal'
      FROM generate_series(1,50) n`, [f.workspaceId, f.ownerId])
    await f.history()
    const unbounded = await f.execution(f.firstId), maximumAccess = { ...unbounded.security.ceiling,
      clearance: f.envelope.sensitivity, compartments: f.envelope.compartments, mutationCompartments: [], projectIds: f.envelope.projectIds }
    execution = (await resolveExecutionContextSystem({ userId: f.firstId, workspaceId: f.workspaceId,
      assistant: (await findAssistantById(f.assistantId))!, memberMode: 'member', sharedAudience: true,
      session: f.session, sessionAuthority: f.session, identity: unbounded.identity, ownership: unbounded.ownership,
      lifecycle: unbounded.lifecycle, maximumAccess, maximumAccessCurrent: async () => maximumAccess })).executionContext
    files = (await listWorkspaceFilesIndexRanked(execution.security.access, 50)).flatMap(boundScopeSources)
    expect(files).toHaveLength(50)
    through = 3
    for (let turn = 0; turn < 2; turn++) {
      const current = authority(), query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, authority: current })
      const memory = await createDbMemoryStore().getIndex(execution.security.access, false, current)
      const sources = new ContextScopeAccumulator({ sources: [...boundScopeSources(query), ...boundScopeSources(memory), ...files] }).evidence.sources!
      const row = await publishNativeSessionMessage({ sessionId: f.session.id, role: 'assistant',
        content: `Fictional worklist reply ${turn + 1}`, senderAssistantId: f.assistantId, authority: current,
        derivationTarget: f.envelope, derivation: { producer: 'fixture:detached-evaluator', sources } })
      through = row.sequenceNum; replies.push(row.id)
    }
    const current = authority(), body = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, topicThroughSequence: 0, authority: current })
    // Classify the latest reply. Earlier replies retain a negative topic query
    // bounded before this message; retroactive feedback is tested separately.
    expect(await writeSessionContextRevision({ sessionId: f.session.id, parentId: replies.at(-1), kind: 'message_annotation',
      content: { topicLabel: 'Fictional file topic', topicConfidence: 0.9, replyToText: null }, authority: current,
      derivation: { producer: 'fixture:detached-topic', sources: [...boundScopeSources(body), ...files] } })).not.toBeNull()
    const rows = (await f.pool.query<{ id: string; version: string }>('SELECT id,scope_version::text AS version FROM session_messages WHERE session_id=$1 ORDER BY sequence_num', [f.session.id])).rows
    revisionId = (await f.pool.query<{ id: string }>('SELECT scope_revision_id AS id FROM session_message_annotation_heads WHERE message_id=$1', [replies.at(-1)])).rows[0].id
    roots = { kinds: rows.map(() => 'session_message'), ids: rows.map(row => row.id), versions: rows.map(row => row.version) }
    roots.kinds.push('session_context_revision'); roots.ids.push(revisionId); roots.versions.push('1')

    await f.pool.query(`CREATE ROLE ${extraRole} NOLOGIN`)
    await f.pool.query(`CREATE FUNCTION ${wrapper}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE kinds text[];ids uuid[];versions text[];nodes jsonb;memo jsonb;result jsonb;seed jsonb;definition text;body text;signature text;team uuid;request_id uuid;deadline timestamptz;
      BEGIN
        kinds:=ARRAY(SELECT jsonb_array_elements_text(payload->'kinds'));
        ids:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(payload->'ids') value);
        versions:=ARRAY(SELECT jsonb_array_elements_text(payload->'versions'));
        IF action='guard' THEN RETURN to_jsonb(application_native_worklist_helpers_current());
        ELSIF action='frame' THEN RETURN read_native_file_session_cohort_frame(w,kinds,ids,versions,true);
        ELSIF action='seed' THEN
          SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
          RETURN native_worklist_seed(w,nodes);
        ELSIF action='current' THEN RETURN to_jsonb(native_worklist_frame_current(w,payload));
        ELSIF action='prime' THEN RETURN native_detached_eval_scope(w,'session_context_revision',(payload->>'revision')::uuid,'1',payload->'memo',payload->'seed');
        ELSIF action IN('original','point') THEN
          memo:=payload->'memo';seed:=payload->'seed';
          IF action='original' THEN
            IF memo->'nativeWorklist'='true'::jsonb THEN memo:=jsonb_set(memo,'{nativeWorklist}',seed);END IF;
            result:=native_worklist_eval_point_state(w,'session_message_annotation',(payload->>'message')::uuid,ARRAY['topicLabel','topicConfidence','replyToText'],memo);
          ELSE result:=native_detached_eval_point_state(w,'session_message_annotation',(payload->>'message')::uuid,ARRAY['topicLabel','topicConfidence','replyToText'],memo,seed);END IF;
          IF result IS NULL THEN RETURN NULL;END IF;
          RETURN jsonb_set(result,'{memo}',(result->'memo')-'nativeWorklist');
        ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);
        ELSIF action='stats' THEN RETURN (SELECT coalesce(jsonb_object_agg(p.proname,s.calls),'{}') FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid);
        ELSIF action='payload_fault' THEN
          -- Owner-only rollback fault injection: exercise fresh payload selection
          -- without changing any guarded reader or leaving the immutable trigger disabled.
          ALTER TABLE session_context_revision_contents DISABLE TRIGGER session_context_content_guard;
          UPDATE session_context_revision_contents SET content=jsonb_set(content,'{topicLabel}','"Fictional replacement payload"')
            WHERE workspace_id=w AND revision_id=(payload->>'revision')::uuid;
          ALTER TABLE session_context_revision_contents ENABLE TRIGGER session_context_content_guard;
        ELSIF action='grant' THEN
          team:=gen_random_uuid();request_id:=gen_random_uuid();deadline:=clock_timestamp()+interval '10 seconds';
          INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES(team,w,'Fictional expiring team',(payload->>'owner')::uuid,'team','fictional-expiring-'||team,'team:'||team);
          UPDATE workspace_members SET team_scope_mode='assigned',compartments=NULL WHERE workspace_id=w AND user_id=current_setting('app.current_user_id')::uuid;
          INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
            VALUES(request_id,w,current_setting('app.current_user_id')::uuid,'member',current_setting('app.current_user_id')::uuid,team,'Fictional timed read',clock_timestamp()-interval '1 day',deadline,repeat('a',64),1,'approved',(payload->>'owner')::uuid,clock_timestamp());
          INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
            SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=request_id;
          PERFORM set_config('app.agent_compartments','null',true);
          RETURN jsonb_build_object('expiresAt',deadline,'label','team:'||team,'compartments',effective_member_read_compartments(current_setting('app.current_user_id')::uuid,w));
        ELSIF action='wait_grant' THEN
          PERFORM pg_sleep(greatest(0,extract(epoch FROM ((payload->>'expiresAt')::timestamptz-clock_timestamp())))+0.03);
          RETURN to_jsonb(effective_member_read_compartments(current_setting('app.current_user_id')::uuid,w));
        ELSIF action='revision_version' THEN UPDATE session_context_scope_revisions SET scope_version=2 WHERE workspace_id=w AND id=(payload->>'revision')::uuid;
        ELSIF action='revision_hold' THEN UPDATE session_context_scope_revisions SET scope_held=true WHERE workspace_id=w AND id=(payload->>'revision')::uuid;
        ELSIF action='review_hold_fault' THEN
          -- Revisions are not direct review targets. Inject a legacy/corrupt
          -- review row to prove the read boundary still refuses it.
          ALTER TABLE scope_resource_states DISABLE TRIGGER scope_resource_states_reference;
          INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
            VALUES(w,'session_context_revision',(payload->>'revision')::uuid,'1','held',1,'Fictional annotation hold');
          ALTER TABLE scope_resource_states ENABLE TRIGGER scope_resource_states_reference;
        ELSIF action='message_hold' THEN UPDATE session_messages SET scope_held=true WHERE workspace_id=w AND id=(payload->>'message')::uuid;
        ELSIF action='recording' THEN UPDATE sessions SET recording_privacy_held=true WHERE workspace_id=w AND id=(payload->>'session')::uuid;
        ELSIF action='labels' THEN UPDATE workspace_files SET sensitivity='confidential' WHERE workspace_id=w AND id=(payload->>'file')::uuid;
        ELSIF action='body' THEN UPDATE session_messages SET content='"Fictional changed annotation parent"'::jsonb WHERE workspace_id=w AND id=(payload->>'message')::uuid;
        ELSIF action='actor' THEN PERFORM set_config('app.current_user_id',payload->>'actor',true);
        ELSIF action='ceiling' THEN PERFORM set_config('app.agent_clearance','public',true);
        ELSIF action='disable' THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.application_native_worklist_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''BEGIN RETURN false;END''';
        ELSIF action='reader_drift' THEN
          signature:=payload->>'signature';
          IF payload->>'kind'='cost' THEN EXECUTE 'ALTER FUNCTION '||signature||' COST 101';
          ELSIF payload->>'kind'='acl' THEN EXECUTE 'GRANT EXECUTE ON FUNCTION '||signature||' TO ${extraRole}';
          ELSE
            SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid=signature::regprocedure;
            EXECUTE replace(definition,body,body||E'\n-- Fictional skipped reader drift');
          END IF;
        ELSIF action='drift_acl' THEN GRANT EXECUTE ON FUNCTION native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb) TO app_user;
        ELSIF action='drift_body' THEN
          SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid='native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)'::regprocedure;
          EXECUTE replace(definition,body,body||E'\n-- Fictional point contract drift');
        ELSE RAISE EXCEPTION 'Unknown annotation fixture operation';END IF;
        RETURN NULL;
      END $fixture$;
      REVOKE ALL ON FUNCTION ${wrapper}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${wrapper}(uuid,text,jsonb) TO app_user`)
  }, 180_000)
  afterAll(async () => {
    try { await f?.pool.query(`DROP FUNCTION IF EXISTS ${wrapper}(uuid,text,jsonb)`); await f?.cleanup(); await f?.pool.query(`DROP ROLE IF EXISTS ${extraRole}`) }
    finally { await getAppPool().end(); await getPool().end() }
  })

  it('preserves complete proof JSON and committed annotation readback while retaining final canonical verification', async () => {
    await frame(async client => {
      expect(await operation(client, 'guard')).toBe(true)
      await operation(client, 'trace')
      const before = await operation(client, 'stats'), actual = await operation(client, 'frame', roots)
      expect(actual).toMatchObject({ admitted: true })
      expect(actual.memo).not.toHaveProperty('nativeWorklist')
      const after = await operation(client, 'stats')
      expect((after.native_worklist_frame_current ?? 0) - (before.native_worklist_frame_current ?? 0)).toBeGreaterThan(0)
      expect((after.read_admitted_native_scope_snapshot ?? 0) - (before.read_admitted_native_scope_snapshot ?? 0)).toBeGreaterThanOrEqual(50)
      await operation(client, 'disable')
      expectScheduledFrame(actual, await operation(client, 'frame', roots))
    })
    const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, authority: authority() })
    expect(query.annotations.find(row => row.id === replies.at(-1))?.topicLabel).toBe('Fictional file topic')
    for (const id of replies) expect(query.history.some(row => row.id === id)).toBe(true)
  }, 120_000)

  it('reuses only the annotation source and keeps payload and privacy checks on each visit', async () => frame(async client => {
    const input = await prepared(client)
    await operation(client, 'trace')
    const before = await operation(client, 'stats'), original = await operation(client, 'original', input)
    const middle = await operation(client, 'stats'), actual = await operation(client, 'point', input)
    const after = await operation(client, 'stats')
    expect(actual).toEqual(original)
    expect(actual.value.values.topicLabel).toBe('Fictional file topic')
    expect((middle.session_context_revision_native ?? 0) - (before.session_context_revision_native ?? 0)).toBeGreaterThan(0)
    expect((after.session_context_revision_native ?? 0) - (middle.session_context_revision_native ?? 0)).toBe(0)
    expect((after.recording_source_read_allowed ?? 0) - (middle.recording_source_read_allowed ?? 0)).toBeGreaterThan(0)
  }), 90_000)

  for (const marker of ['missing', 'false', 'null']) it(`uses canonical point semantics with a ${marker} marker`, async () => frame(async client => {
    const input = await prepared(client)
    if (marker === 'missing') delete input.memo.nativeWorklist
    else input.memo.nativeWorklist = marker === 'false' ? false : null
    await operation(client, 'trace')
    const before = await operation(client, 'stats')
    expect(await operation(client, 'point', input)).toEqual(await operation(client, 'original', input))
    const after = await operation(client, 'stats')
    expect((after.session_context_revision_native ?? 0) - (before.session_context_revision_native ?? 0)).toBeGreaterThan(0)
  }), 90_000)

  for (const shape of ['workspace', 'closed', 'missing-edge', 'version']) it(`falls back for ${shape} frame mismatch`, async () => frame(async client => {
    const input = await prepared(client)
    if (shape === 'workspace') input.seed.workspaceId = randomUUID()
    else if (shape === 'closed') input.seed.closed = false
    else if (shape === 'missing-edge') delete input.seed.edges[`session_context_revision:${revisionId}:1`]
    else input.seed.currents[`session_context_revision:${revisionId}`].source.version = '2'
    expect(await operation(client, 'point', input)).toEqual(await operation(client, 'original', input))
  }), 90_000)

  for (const change of ['revision_hold', 'review_hold_fault', 'message_hold', 'recording', 'labels', 'body', 'actor', 'ceiling']) {
    it(`invalidates the enclosing proof after ${change}`, async () => frame(async client => {
      const input = await prepared(client)
      await operation(client, change, { revision: revisionId, message: replies.at(-1), session: f.session.id, file: files[0].resourceId, actor: f.secondId })
      expect(await operation(client, 'current', input.seed)).toBe(false)
      if (['revision_hold', 'review_hold_fault', 'recording'].includes(change)) {
        const actual = await operation(client, 'point', input)
        expect(actual?.value).toBeUndefined()
        expect(actual).toEqual(await operation(client, 'original', input))
      }
      // Parent-body/current-scope changes may leave an invocation-local point
      // source reusable; they must never survive the final complete proof.
      const actual = await outcome(client, () => operation(client, 'frame', roots))
      await operation(client, 'disable')
      expect(await outcome(client, () => operation(client, 'frame', roots))).toEqual(actual)
    }), 90_000)
  }

  it('preserves the immutable revision-version constraint', async () => frame(async client => {
    expect(await outcome(client, () => operation(client, 'revision_version', { revision: revisionId })))
      .toMatchObject({ error: '22023', message: 'scope_evidence_immutable' })
  }))

  it('reads annotation payload again even when its admitted source snapshot is reused', async () => frame(async client => {
    const input = await prepared(client)
    expect((await operation(client, 'point', input)).value.values.topicLabel).toBe('Fictional file topic')
    await operation(client, 'payload_fault', { revision: revisionId })
    const actual = await operation(client, 'point', input)
    expect(actual.value.values.topicLabel).toBe('Fictional replacement payload')
    expect(actual).toEqual(await operation(client, 'original', input))
  }), 90_000)

  it('rechecks an actual timed read grant after it expires without a metadata mutation', async () => frame(async client => {
    const grant = await operation(client, 'grant', { owner: f.ownerId })
    expect(grant.compartments).toContain(grant.label)
    const seed = await operation(client, 'seed', roots)
    expect(seed).not.toBeNull()
    expect(await operation(client, 'current', seed)).toBe(true)
    expect(await operation(client, 'wait_grant', grant)).not.toContain(grant.label)
    expect(await operation(client, 'current', seed)).toBe(false)
  }), 90_000)

  for (const drift of ['drift_body', 'drift_acl']) it(`refuses ${drift} and retains canonical fallback`, async () => frame(async client => {
    const baseline = await operation(client, 'frame', roots)
    await operation(client, drift)
    expect(await operation(client, 'guard')).toBe(false)
    expectScheduledFrame(baseline, await operation(client, 'frame', roots))
  }), 90_000)

  it('reads a canonically replaced annotation head through the original reader when it is outside the seed', async () => {
    const input = await frame(client => prepared(client))
    const current = authority(), body = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, topicThroughSequence: 0, authority: current })
    const replacement = await writeSessionContextRevision({ sessionId: f.session.id, parentId: replies.at(-1), kind: 'message_annotation',
      expectedRevision: revisionId, content: { topicLabel: 'Fictional replacement head', topicConfidence: 0.8, replyToText: null },
      authority: current, derivation: { producer: 'fixture:annotation-replacement', sources: [...boundScopeSources(body), ...files] } })
    expect(replacement).not.toBeNull()
    expect(input.seed.currents).not.toHaveProperty(`session_context_revision:${replacement!.id}`)
    await frame(async client => {
      await operation(client, 'trace')
      const before = await operation(client, 'stats'), actual = await operation(client, 'point', input)
      const after = await operation(client, 'stats')
      expect(actual.value.values.topicLabel).toBe('Fictional replacement head')
      expect(actual).toEqual(await operation(client, 'original', input))
      expect((after.session_context_revision_native ?? 0) - (before.session_context_revision_native ?? 0)).toBeGreaterThan(0)
    })
  }, 120_000)

  it('pins every skipped reader body, cost and ACL before allowing reuse', async () => frame(async client => {
    const readers = [
      'session_context_revision_native(uuid,uuid)', 'session_context_revision_snapshot(uuid,uuid)',
      'session_context_parent_snapshot(uuid,uuid)', 'session_personal_audience(sessions)',
      'session_workspace_audience(sessions)', 'session_project_audience(sessions,boolean)', 'project_labels_allowed(jsonb,uuid,text[],boolean)',
    ]
    for (const signature of readers) for (const kind of ['cost', 'body', 'acl']) {
      await client.query('SAVEPOINT reader_drift')
      try {
        await operation(client, 'reader_drift', { signature, kind })
        expect(await operation(client, 'guard'), `${signature}: ${kind}`).toBe(false)
      } finally { await client.query('ROLLBACK TO SAVEPOINT reader_drift') }
      expect(await operation(client, 'guard')).toBe(true)
    }
  }), 90_000)

  it('does not expose the private point or worklist frames to the application role', async () => {
    const result = await getAppPool().query<{ allowed: boolean }>(`SELECT has_function_privilege(current_user,oid,'EXECUTE') AS allowed FROM pg_proc
      WHERE oid IN ('native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)'::regprocedure,
      'native_worklist_seed(uuid,jsonb)'::regprocedure,'native_worklist_frame_current(uuid,jsonb)'::regprocedure)`)
    expect(result.rows).toHaveLength(3)
    expect(result.rows.every(row => !row.allowed)).toBe(true)
  })
})
