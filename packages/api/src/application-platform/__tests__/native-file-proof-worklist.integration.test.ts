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
import { addSessionMessage, createWorkspaceChatSession } from '../../db/sessions.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
type Json = Record<string, any>
const wrapper = `proof_worklist_fixture_${randomUUID().replaceAll('-', '')}`
const guardSignature = 'application_native_worklist_helpers_current()'
const proofSignature = 'read_native_file_worklist_evidence(uuid,text[],uuid[],text[],boolean,boolean)'
const seedSignature = 'native_worklist_seed(uuid,jsonb)'
const currentSignature = 'native_worklist_frame_current(uuid,jsonb)'
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let execution: ExecutionContext
let files: ScopeSource[]
let roots: { kinds: string[]; ids: string[]; versions: string[] }
let through: number
const replies: string[] = []
const authority = () => ({ execution, accumulator: new ContextScopeAccumulator() })

async function operation<T = Json | null>(client: Pick<PoolClient, 'query'>, action: string, payload: unknown = {}): Promise<T> {
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
  await client.query('SAVEPOINT proof_outcome')
  try { return { value: await read() } }
  catch (error) { const e = error as { code?: string; message: string }; return { error: e.code, message: e.message } }
  finally { await client.query('ROLLBACK TO SAVEPOINT proof_outcome') }
}
async function baseline<T>(client: PoolClient, read: () => Promise<T>) {
  await client.query('SAVEPOINT original_proof')
  try { await operation(client, 'disable'); expect(await operation(client, 'guard')).toBe(false); return await read() }
  finally { await client.query('ROLLBACK TO SAVEPOINT original_proof') }
}
const evidence = (client: PoolClient) => operation(client, 'evidence', roots)
const capture = (client: PoolClient, type = 'session_message', highWater = through) =>
  operation(client, 'capture', { session: f.session.id, through: highWater, type })
const history = async (client: PoolClient) => (await client.query(
  'SELECT value FROM read_native_application_session_history($1,$2,$3)', [f.workspaceId, f.session.id, through])).rows

describe.sequential('[COMP:api/application-persistence] invocation-local native proof worklists', () => {
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
        derivationTarget: f.envelope, derivation: { producer: 'fixture:proof-worklist', sources } })
      through = row.sequenceNum; replies.push(row.id)
    }
    const current = authority(), body = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, topicThroughSequence: 0, authority: current })
    // Classify the latest reply. Earlier replies retain a negative topic query
    // bounded before this message; retroactive feedback is tested separately.
    expect(await writeSessionContextRevision({ sessionId: f.session.id, parentId: replies.at(-1), kind: 'message_annotation',
      content: { topicLabel: 'Fictional file topic', topicConfidence: 0.9, replyToText: null }, authority: current,
      derivation: { producer: 'fixture:worklist-topic', sources: [...boundScopeSources(body), ...files] } })).not.toBeNull()
    const rows = (await f.pool.query<{ id: string; version: string }>('SELECT id,scope_version::text AS version FROM session_messages WHERE session_id=$1 ORDER BY sequence_num', [f.session.id])).rows
    roots = { kinds: rows.map(() => 'session_message'), ids: rows.map(row => row.id), versions: rows.map(row => row.version) }
    await f.pool.query(`CREATE FUNCTION ${wrapper}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE kinds text[];ids uuid[];versions text[];nodes jsonb;definition text;body text;signature text;derivation uuid;
      BEGIN
        kinds:=ARRAY(SELECT jsonb_array_elements_text(payload->'kinds'));
        ids:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(payload->'ids') value);
        versions:=ARRAY(SELECT jsonb_array_elements_text(payload->'versions'));
        IF action='guard' THEN RETURN to_jsonb(application_native_worklist_helpers_current());
        ELSIF action='evidence' THEN RETURN read_native_file_session_evidence(w,kinds,ids,versions,true);
        ELSIF action='private' THEN RETURN read_native_file_worklist_evidence(w,kinds,ids,versions,true,false);
        ELSIF action='frame' THEN RETURN read_native_file_session_cohort_frame(w,kinds,ids,versions,true);
        ELSIF action='seed' THEN
          SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
          RETURN native_worklist_seed(w,nodes);
        ELSIF action='current' THEN RETURN to_jsonb(native_worklist_frame_current(w,payload));
        ELSIF action='nodes' THEN RETURN (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') FROM application_scope_lineage(w,kinds,ids,versions) n);
        ELSIF action='edges' THEN RETURN (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e::text),'[]') FROM (
          SELECT DISTINCT n.kind parent_kind,n.id parent_id,n.version parent_version,d.* FROM application_scope_lineage(w,kinds,ids,versions) n
          CROSS JOIN LATERAL application_scope_source_edges(w,n.kind,n.id,n.version) d) e);
        ELSIF action='capture' THEN RETURN capture_native_session_projection_batch(w,(payload->>'session')::uuid,(payload->>'through')::integer,payload->>'type');
        ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);
        ELSIF action='stats' THEN RETURN (SELECT coalesce(jsonb_object_agg(p.proname,s.calls),'{}') FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid);
        ELSIF action IN('disable','disable_kernel') THEN
          EXECUTE 'CREATE OR REPLACE FUNCTION public.application_native_worklist_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''BEGIN RETURN false;END''';
          IF action='disable' THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.application_native_file_capture_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''BEGIN RETURN false;END''';END IF;
        ELSIF action='disable_capture' THEN
          EXECUTE 'CREATE OR REPLACE FUNCTION public.application_native_file_capture_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''BEGIN RETURN false;END''';
        ELSIF action='drift_guard' THEN
          EXECUTE 'CREATE OR REPLACE FUNCTION public.application_native_worklist_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''BEGIN RAISE EXCEPTION ''''fictional_unknown_worklist_guard_invoked'''';END''';
        ELSIF action='hold' THEN INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
          VALUES(w,'workspace_file',(payload->>'id')::uuid,payload->>'version','held',1,'Fictional worklist hold');
        ELSIF action='labels' THEN UPDATE workspace_files SET sensitivity='confidential' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
        ELSIF action='recording' THEN UPDATE sessions SET recording_privacy_held=true WHERE workspace_id=w AND id=(payload->>'session')::uuid;
        ELSIF action='membership' THEN DELETE FROM workspace_members WHERE workspace_id=w AND user_id=current_setting('app.current_user_id')::uuid;
        ELSIF action='body' THEN UPDATE session_messages SET content='"Fictional changed body"'::jsonb WHERE workspace_id=w AND id=(payload->>'id')::uuid;
        ELSIF action='native' THEN RETURN read_admitted_native_scope_snapshot(w,payload->>'kind',(payload->>'id')::uuid);
        ELSIF action='edge' THEN
          INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
            SELECT w,'workspace_file',(payload->>'output')::uuid,'1','fixture:closed-edge',NULL,NULL,'internal','{}','{}',revision
              FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
          INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
            VALUES(w,derivation,'workspace_file',(payload->>'source')::uuid,'1');
          SET CONSTRAINTS ALL IMMEDIATE;
          SET CONSTRAINTS ALL DEFERRED;
        ELSIF action='dense' THEN
          INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity,superseded_by)
            SELECT ids[n],w,'/fictional/dense-'||ids[n],'Fictional bounded predecessor','fixture://dense-'||ids[n],
              current_setting('app.current_user_id')::uuid,'user','internal',ids[n+1]
            FROM generate_subscripts(ids,1) n;
        ELSIF action='drift_acl' THEN GRANT EXECUTE ON FUNCTION native_worklist_frame_current(uuid,jsonb) TO app_user;
        ELSIF action='drift_current' THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.native_worklist_frame_current(w uuid,worklist_frame jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''BEGIN RETURN true;END''';
        ELSIF action IN('drift_original','drift_policy','drift_primitive') THEN
          signature:=CASE WHEN action='drift_original' THEN 'read_admitted_native_scope_snapshot(uuid,text,uuid)'
            WHEN action='drift_primitive' THEN 'native_worklist_source_primitive_v2(uuid,text,uuid,jsonb)'
            ELSE 'application_session_eval_point_state(uuid,text,uuid,text[],jsonb)' END;
          SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid=signature::regprocedure;
          IF action='drift_policy' THEN EXECUTE replace(definition,body,replace(body,'BEGIN',E'BEGIN\n IF t=''session_message'' AND ''content''=ANY(fields) THEN RETURN NULL;END IF;'));
          ELSE EXECUTE replace(definition,body,body||E'\n-- Fictional original helper metadata drift');END IF;
        ELSE RAISE EXCEPTION 'Unknown proof fixture operation';END IF;
        RETURN NULL;
      END $fixture$;
      REVOKE ALL ON FUNCTION ${wrapper}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${wrapper}(uuid,text,jsonb) TO app_user`)
  }, 180_000)
  afterAll(async () => {
    try { await f?.pool.query(`DROP FUNCTION IF EXISTS ${wrapper}(uuid,text,jsonb)`); await f?.cleanup() }
    finally { await getAppPool().end(); await getPool().end() }
  })

  it('preserves complete evidence and real committed replies while reducing Page walks', async () => {
    await frame(async client => {
      expect(await operation(client, 'guard')).toBe(true)
      await operation(client, 'trace')
      const before = await operation<Json>(client, 'stats')
      const actual = await evidence(client)
      expect(actual).toMatchObject({ admitted: true })
      const optimized = await operation<Json>(client, 'stats')
      expect(await baseline(client, () => evidence(client))).toEqual(actual)
      const original = await operation<Json>(client, 'stats')
      expect((optimized.read_native_file_worklist_evidence ?? 0) - (before.read_native_file_worklist_evidence ?? 0)).toBeGreaterThan(0)
      expect((optimized.native_worklist_frame_current ?? 0) - (before.native_worklist_frame_current ?? 0)).toBeGreaterThan(0)
      expect((optimized.native_worklist_seed ?? 0) - (before.native_worklist_seed ?? 0)).toBeGreaterThanOrEqual(2)
      expect((optimized.read_resource_page_dependencies ?? 0) - (before.read_resource_page_dependencies ?? 0))
        .toBeLessThan((original.read_resource_page_dependencies ?? 0) - (optimized.read_resource_page_dependencies ?? 0))
      expect(await history(client)).toEqual(await baseline(client, () => history(client)))
      const retained = await operation(client, 'frame', roots)
      expect(retained).toMatchObject({ admitted: true })
      expect(retained!.memo).not.toHaveProperty('nativeWorklist')
    })
    const current = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, authority: authority() })
    for (const id of replies) expect(current.history.some(row => row.id === id)).toBe(true)
  }, 120_000)

  it('independently rebuilds final source snapshots from identities with canonical-equivalent results', async () => frame(async client => {
    const seed = await operation(client, 'seed', roots)
    expect(seed).not.toBeNull()
    const nativeCount = Object.keys(seed!.currents).length
    expect(nativeCount).toBeGreaterThanOrEqual(50)
    for (const node of Object.values(seed!.currents) as Json[]) {
      expect(node.source).toEqual(await operation(client, 'native', { kind: node.kind, id: node.id }))
    }
    await operation(client, 'trace')
    const before = await operation<Json>(client, 'stats')
    expect(await operation(client, 'current', seed)).toBe(true)
    const after = await operation<Json>(client, 'stats')
    expect((after.native_worklist_seed ?? 0) - (before.native_worklist_seed ?? 0)).toBe(1)
    expect((after.native_worklist_current ?? 0) - (before.native_worklist_current ?? 0)).toBe(nativeCount)
    // The seed starts with empty currents. Its source readers cannot borrow
    // the original native snapshots or any previous field admission memo.
    expect((after.native_worklist_snapshot ?? 0) - (before.native_worklist_snapshot ?? 0)).toBe(0)
    const changed = structuredClone(seed!)
    const key = Object.keys(changed.currents)[0]
    changed.currents[key].source = null
    expect(await operation(client, 'current', changed)).toBe(false)
  }), 90_000)

  it('preserves canonical frame evidence and only adds completed native scope entries', async () => frame(async client => {
    const actual = await operation(client, 'frame', roots)
    expect(actual).toMatchObject({ admitted: true })
    await operation(client, 'disable_kernel')
    const original = await operation(client, 'frame', roots)
    expect(original).toMatchObject({ admitted: true })
    const { memo: actualMemo, ...actualEvidence } = actual!
    const { memo: originalMemo, ...originalEvidence } = original!
    expect(actualEvidence).toEqual(originalEvidence)
    for (const [key, value] of Object.entries(originalMemo)) expect(actualMemo[key]).toEqual(value)
    for (const key of Object.keys(actualMemo).filter(key => !(key in originalMemo))) {
      expect(key).toMatch(/^native:(session_message|session_context_revision|memory|workspace_file):/)
      expect(actual!.lineage.some((node: Json) => key === `native:${node.kind}:${node.id}:${node.version}`)).toBe(true)
      expect(actualMemo[key]).toEqual({ value: true, external: [] })
    }
  }), 90_000)

  it('evaluates shared field obligations in dependency order without repeated recursive visits', async () => frame(async client => {
    const nodes = await operation<Json[]>(client, 'nodes', roots)
    const fieldCount = nodes.filter(node => node.kind === 'application_field').length
    expect(fieldCount).toBeGreaterThan(0)
    await operation(client, 'trace')
    const before = await operation<Json>(client, 'stats')
    const actual = await evidence(client)
    expect(actual).toMatchObject({ admitted: true })
    const after = await operation<Json>(client, 'stats')
    const fieldVisits = (after.native_detached_eval_field ?? 0) - (before.native_detached_eval_field ?? 0)
    expect(fieldVisits).toBeGreaterThan(0)
    expect(fieldVisits).toBeLessThanOrEqual(fieldCount * 3)
    expect(actual).toEqual(await baseline(client, () => evidence(client)))
  }), 90_000)

  for (const type of ['session_message', 'session_message_annotation']) it(`preserves the complete ${type} capture`, async () => frame(async client => {
    await operation(client, 'trace')
    const before = await operation<Json>(client, 'stats')
    const actual = await capture(client, type)
    expect(actual).not.toBeNull()
    const after = await operation<Json>(client, 'stats')
    expect((after.read_native_file_session_cohort_frame ?? 0) - (before.read_native_file_session_cohort_frame ?? 0)).toBe(2)
    expect((after.application_native_file_frame_current ?? 0) - (before.application_native_file_frame_current ?? 0)).toBe(0)
    expect((after.read_native_file_session_field_snapshots ?? 0) - (before.read_native_file_session_field_snapshots ?? 0)).toBe(0)
    expect((after.read_native_session_field_snapshots ?? 0) - (before.read_native_session_field_snapshots ?? 0)).toBe(0)
    expect(actual).toEqual(await baseline(client, () => capture(client, type)))
  }), 120_000)

  for (const change of ['hold', 'labels', 'recording', 'membership']) it(`rejects a retained worklist after current ${change} changes`, async () => frame(async client => {
    const seed = await operation(client, 'seed', roots)
    expect(seed).not.toBeNull()
    expect(await operation(client, 'current', seed)).toBe(true)
    await operation(client, change, { id: files[0].resourceId, version: files[0].version, session: f.session.id })
    expect(await operation(client, 'current', seed)).toBe(false)
    const read = () => outcome(client, () => evidence(client))
    expect(await read()).toEqual(await baseline(client, read))
  }), 90_000)

  for (const change of ['actor', 'ceiling']) it(`refuses a worklist under a different ${change} even when source identities remain unchanged`, async () => frame(async client => {
    const seed = await operation(client, 'seed', roots)
    expect(seed).not.toBeNull()
    expect(await operation(client, 'current', seed)).toBe(true)
    if (change === 'actor') await client.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.agent_actor_id',$1,true)", [f.secondId])
    else await client.query("SELECT set_config('app.agent_clearance','confidential',true)")
    expect(await operation(client, 'current', seed)).toBe(false)
    const read = () => outcome(client, () => evidence(client))
    expect(await read()).toEqual(await baseline(client, read))
  }), 90_000)

  it('rechecks an initially absent native source instead of retaining a cached absence', async () => frame(async client => {
    const id = randomUUID(), absent = { kinds: ['workspace_file'], ids: [id], versions: ['1'] }
    const seed = await operation(client, 'seed', absent)
    expect(seed).not.toBeNull()
    expect(seed!.currents[`workspace_file:${id}`].source).toBeNull()
    expect(await operation(client, 'current', seed)).toBe(true)
    await operation(client, 'dense', { ids: [id] })
    expect(await operation(client, 'native', { kind: 'workspace_file', id })).toMatchObject({ held: false })
    expect(await operation(client, 'current', seed)).toBe(false)
  }))

  it('rejects a changed directed edge even when every node and native source snapshot is unchanged', async () => frame(async client => {
    const nodes = await operation(client, 'nodes', roots)
    const edges = await operation(client, 'edges', roots)
    const source = { kind: 'workspace_file', id: files[0].resourceId }
    const originalSource = await operation(client, 'native', source)
    expect(originalSource).toMatchObject({ held: false })
    const seed = await operation(client, 'seed', roots)
    expect(await operation(client, 'current', seed)).toBe(true)
    await operation(client, 'edge', { output: files[0].resourceId, source: files[1].resourceId })
    expect(await operation(client, 'nodes', roots)).toEqual(nodes)
    expect(await operation(client, 'edges', roots)).not.toEqual(edges)
    expect(await operation(client, 'native', source)).toEqual(originalSource)
    expect(await operation(client, 'current', seed)).toBe(false)
    const read = () => outcome(client, () => history(client))
    expect(await read()).toEqual(await baseline(client, read))
  }), 120_000)

  it('reads changed body fields canonically instead of reusing a native metadata snapshot as payload', async () => frame(async client => {
    expect(await evidence(client)).toMatchObject({ admitted: true })
    await operation(client, 'body', { id: roots.ids[0] })
    const read = () => outcome(client, () => history(client))
    const actual = await read()
    expect(actual).toEqual(await baseline(client, read))
    expect(JSON.stringify(actual)).not.toContain('Fictional earlier request')
  }), 90_000)

  for (const change of ['drift_acl', 'drift_current', 'drift_original', 'drift_policy', 'drift_primitive']) it(`uses canonical fallback after ${change}`, async () => frame(async client => {
    expect(await evidence(client)).toMatchObject({ admitted: true })
    await operation(client, change)
    expect(await operation(client, 'guard')).toBe(false)
    expect(await operation(client, 'private', roots)).toBeNull()
    const read = () => outcome(client, () => history(client))
    const actual = await read()
    expect(actual).toEqual(await baseline(client, read))
    if (change === 'drift_policy') expect(JSON.stringify(actual)).not.toContain('Fictional earlier request')
  }), 90_000)

  it('keeps worklists private and preserves the original no-file capture', async () => frame(async client => {
    for (const signature of [guardSignature, proofSignature, seedSignature, currentSignature]) {
      expect((await client.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed).toBe(false)
    }
    const inventory = (await client.query<{ signature: string; allowed: boolean }>(`SELECT oid::regprocedure::text AS signature,
      has_function_privilege(current_user,oid,'EXECUTE') AS allowed FROM pg_proc WHERE pronamespace='public'::regnamespace
      AND (proname LIKE 'native_worklist_%' OR proname IN('application_native_worklist_helpers_current','read_native_file_worklist_evidence'))`)).rows
    expect(inventory.some(row => row.signature.startsWith('native_worklist_source_primitive_v2('))).toBe(true)
    expect(inventory.filter(row => row.allowed)).toEqual([])
    const read = () => capture(client, 'session_message', 3)
    expect(await read()).toEqual(await baseline(client, read))
  }), 90_000)

  it('preserves the original file-frame guard independently of the new worklist guard', async () => frame(async client => {
    expect(await operation(client, 'frame', roots)).toMatchObject({ admitted: true })
    await operation(client, 'disable_capture')
    expect(await operation(client, 'guard')).toBe(true)
    expect(await operation(client, 'frame', roots)).toBeNull()
    const read = () => capture(client)
    expect(await read()).toEqual(await baseline(client, read))
  }), 90_000)

  it('takes the original public evidence and private-frame paths without invoking an altered worklist guard', async () => frame(async client => {
    const expectedEvidence = await baseline(client, () => evidence(client))
    await client.query('SAVEPOINT original_guard_frame')
    let expectedFrame: Json | null
    try {
      await operation(client, 'disable_kernel')
      expectedFrame = await operation(client, 'frame', roots)
      expect(expectedFrame).toMatchObject({ admitted: true })
    } finally { await client.query('ROLLBACK TO SAVEPOINT original_guard_frame') }
    await operation(client, 'drift_guard')
    // The external metadata gate must reject the unknown body before it raises.
    expect(await evidence(client)).toEqual(expectedEvidence)
    expect(await operation(client, 'frame', roots)).toEqual(expectedFrame!)
  }), 120_000)

  it('retains canonical invalid-input and root-bound behavior', async () => frame(async client => {
    for (const payload of [
      { kinds: [], ids: [], versions: [] },
      { kinds: ['session_message'], ids: [roots.ids[0]], versions: [] },
      { kinds: Array(101).fill('session_message'), ids: Array(101).fill(roots.ids[0]), versions: Array(101).fill('1') },
      { kinds: ['unsupported_source'], ids: [randomUUID()], versions: ['1'] },
    ]) {
      const read = () => outcome(client, () => operation(client, 'evidence', payload))
      expect(await read()).toEqual(await baseline(client, read))
    }
  }))

  it('declines a genuinely dense canonical graph before building an unbounded worklist', async () => frame(async client => {
    const ids = Array.from({ length: 183 }, () => randomUUID())
    await operation(client, 'dense', { ids })
    const denseRoot = { kinds: ['workspace_file'], ids: [ids.at(-1)!], versions: ['1'] }
    const nodes = await operation<Json[]>(client, 'nodes', denseRoot)
    const edges = await operation<Json[]>(client, 'edges', denseRoot)
    expect(nodes).toHaveLength(183)
    expect(edges.length).toBeGreaterThan(16_384)
    expect(await operation(client, 'seed', denseRoot)).toBeNull()
    expect(await operation(client, 'private', denseRoot)).toBeNull()
  }), 120_000)

  it('retains the original capture for a genuine transcript with more than one hundred roots', async () => {
    const session = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.firstId, workspaceId: f.workspaceId,
      effectiveClearance: 'internal', authenticatedHuman: true })
    let boundary = 0
    for (let i = 0; i < 101; i++) boundary = (await addSessionMessage({ sessionId: session.id, role: 'user',
      content: `Fictional bounded request ${i}`, scope: f.envelope })).sequenceNum
    const unbounded = await f.execution(f.firstId, session)
    const bounded = (await resolveExecutionContextSystem({ userId: f.firstId, workspaceId: f.workspaceId,
      assistant: (await findAssistantById(f.assistantId))!, memberMode: 'member', sharedAudience: true, session, sessionAuthority: session,
      identity: unbounded.identity, ownership: unbounded.ownership, lifecycle: unbounded.lifecycle,
      maximumAccess: execution.security.ceiling, maximumAccessCurrent: async () => execution.security.ceiling })).executionContext
    const current = { execution: bounded, accumulator: new ContextScopeAccumulator() }
    const memory = await createDbMemoryStore().getIndex(bounded.security.access, false, current)
    const sources = [...files, ...boundScopeSources(memory)]
    boundary = (await publishNativeSessionMessage({ sessionId: session.id, role: 'assistant', content: 'Fictional bounded file reply',
      senderAssistantId: f.assistantId, authority: current, derivationTarget: f.envelope,
      derivation: { producer: 'fixture:bounded-file-history', sources } })).sequenceNum
    await frame(async client => {
      await operation(client, 'trace')
      const before = await operation<Json>(client, 'stats')
      const read = () => operation(client, 'capture', { session: session.id, through: boundary, type: 'session_message' })
      const actual = await read()
      expect(actual).not.toBeNull()
      const after = await operation<Json>(client, 'stats')
      expect((after.read_native_file_session_cohort_frame ?? 0) - (before.read_native_file_session_cohort_frame ?? 0)).toBe(0)
      expect(actual).toEqual(await baseline(client, read))
    })
  }, 180_000)

  it('evaluates a newly selected annotation head outside the recorded query closure through canonical readers', async () => {
    const originalQuery = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, authority: authority() })
    const observations = boundScopeSources(originalQuery)
    const oldRoots = { kinds: observations.map(source => source.resourceKind), ids: observations.map(source => source.resourceId), versions: observations.map(source => source.version) }
    const oldNodes = await frame(client => operation<Json[]>(client, 'nodes', oldRoots))
    const current = authority(), body = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, topicThroughSequence: 0, authority: current })
    const head = (await f.pool.query<{ scope_revision_id: string }>('SELECT scope_revision_id FROM session_message_annotation_heads WHERE workspace_id=$1 AND message_id=$2', [f.workspaceId, replies.at(-1)])).rows[0]
    expect(head).toBeDefined()
    const replacement = await writeSessionContextRevision({ sessionId: f.session.id, parentId: replies.at(-1), kind: 'message_annotation',
      content: { topicLabel: 'Fictional newly selected topic', topicConfidence: 0.9, replyToText: null }, authority: current,
      expectedRevision: head.scope_revision_id,
      derivation: { producer: 'fixture:unknown-current-head', sources: [...boundScopeSources(body), ...files] } })
    expect(replacement).not.toBeNull()
    expect(oldNodes.some(node => node.id === replacement!.id)).toBe(false)
    await frame(async client => {
      const actual = await operation(client, 'evidence', oldRoots)
      expect(actual).toEqual(await baseline(client, () => operation(client, 'evidence', oldRoots)))
      const read = async () => (await client.query('SELECT value FROM read_native_application_session_topics($1,$2,$3)', [f.workspaceId, f.session.id, through])).rows
      const topics = await read()
      expect(topics).toEqual(await baseline(client, read))
      expect(JSON.stringify(topics)).toContain('Fictional newly selected topic')
    })
  }, 120_000)

  for (const change of ['hold', 'body', 'ceiling', 'actor']) it(`does not emit stale rows when ${change} changes after field materialization begins`, async () => {
    // A new real high-water mark makes the domain observation an INSERT,
    // rather than a harmless ON CONFLICT against an earlier captured query.
    through = (await addSessionMessage({ sessionId: f.session.id, role: 'user',
      content: `Fictional materialization request ${change}`, scope: f.envelope })).sequenceNum
    const trigger = `${wrapper}_m`
    await f.pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $barrier$
      BEGIN
        IF NEW.workspace_id=TG_ARGV[0]::uuid AND current_setting('app.fixture_worklist_barrier',true)='on'
          AND EXISTS(SELECT 1 FROM application_field_resources r WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.resource_id
            AND r.selection='query_domain' AND r.type_key='session_message') THEN
          IF NOT EXISTS(SELECT 1 FROM pg_stat_xact_user_functions WHERE funcid='native_worklist_seed(uuid,jsonb)'::regprocedure
            AND calls>current_setting('app.fixture_worklist_seed_count')::bigint) THEN RAISE EXCEPTION 'Fixture did not reach the initial native proof';END IF;
          PERFORM set_config('app.fixture_worklist_barrier','off',true);
          IF TG_ARGV[1]='hold' THEN
            INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
              VALUES(NEW.workspace_id,'workspace_file',TG_ARGV[2]::uuid,TG_ARGV[3],'held',1,'Fictional materialization hold');
          ELSIF TG_ARGV[1]='body' THEN UPDATE session_messages SET content='"Fictional replacement during materialization"'::jsonb WHERE workspace_id=NEW.workspace_id AND id=TG_ARGV[4]::uuid;
          ELSIF TG_ARGV[1]='actor' THEN
            PERFORM set_config('app.current_user_id',TG_ARGV[5],true);PERFORM set_config('app.agent_actor_id',TG_ARGV[5],true);
          ELSE PERFORM set_config('app.agent_clearance','public',true);END IF;
          PERFORM set_config('app.fixture_worklist_changed','on',true);
        END IF;
        RETURN NEW;
      END $barrier$;
      REVOKE ALL ON FUNCTION ${trigger}() FROM PUBLIC;
      CREATE TRIGGER ${trigger} AFTER INSERT ON application_field_observations FOR EACH ROW EXECUTE FUNCTION ${trigger}(
        '${f.workspaceId}','${change}','${files[0].resourceId}','${files[0].version}','${roots.ids[0]}','${f.secondId}')`)
    try {
      await frame(async client => {
        await operation(client, 'trace')
        const before = await operation<Json>(client, 'stats')
        await client.query("SELECT set_config('app.fixture_worklist_seed_count',$1,true),set_config('app.fixture_worklist_barrier','on',true)", [String(before.native_worklist_seed ?? 0)])
        const actual = await outcome(client, () => capture(client))
        // outcome rolls back the statement and its mutation together on error;
        // the trigger itself proves that the mutation followed a real seed.
        expect(actual).toHaveProperty('error')
        expect((actual as { error: string }).error).toBe('42501')
        const after = await operation<Json>(client, 'stats')
        expect(after.native_worklist_seed).toBeGreaterThan(before.native_worklist_seed ?? 0)
        expect(after[trigger]).toBeGreaterThan(before[trigger] ?? 0)
        await client.query("SELECT set_config('app.fixture_worklist_barrier','off',true)")
        const read = () => history(client)
        expect(await read()).toEqual(await baseline(client, read))
      })
    } finally {
      await f.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON application_field_observations; DROP FUNCTION IF EXISTS ${trigger}()`)
    }
  }, 120_000)

})
