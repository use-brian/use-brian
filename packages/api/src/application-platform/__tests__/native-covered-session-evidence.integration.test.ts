import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { boundScopeSources, ContextScopeAccumulator, type ExecutionContext, type ScopeEvidence, type ScopeSource } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { listWorkspaceFilesIndexRanked } from '../../db/workspace-files.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { readRetainedContextFrame, withSessionMessagePublication, writeSessionContextRevision } from '../../db/session-context-revisions.js'
import { publishNativeSessionMessage, publishNativeSessionMessageBatch } from '../../db/session-message-publication.js'
import { addSessionMessage } from '../../db/sessions.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { validateCallerScopeEvidence } from '../../context-scope/caller-evidence.js'
import { tryNativeInvocationEvidence } from '../../context-scope/native-invocation-evidence.js'
import { readNativeSessionEvidence } from '../native-session-evidence.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const wrapper = `covered_evidence_fixture_${randomUUID().replaceAll('-', '')}`
const constraint = 'application_field_derivation_dependencies'
const rollback = new Error('Fictional covered publication rollback')
const guard = 'application_native_covered_evidence_helpers_current()'
type Json = Record<string, any>
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let execution: ExecutionContext
let files: ScopeSource[]
let sources: ScopeSource[]
let through: number
const authority = () => ({ execution, accumulator: new ContextScopeAccumulator() })
const keys = (values: unknown[]) => values.map(value => JSON.stringify(value)).sort()
const normalized = (value: ScopeEvidence) => ({ ...value, sources: [...value.sources ?? []].sort((a, b) =>
  `${a.resourceKind}:${a.resourceId}:${a.version}`.localeCompare(`${b.resourceKind}:${b.resourceId}:${b.version}`)) })
const args = (values = sources) => [f.workspaceId, values.map(s => s.resourceKind), values.map(s => s.resourceId), values.map(s => s.version)]

async function operation<T = Json>(client: Pick<PoolClient, 'query'>, action: string, payload: unknown = {}): Promise<T> {
  return (await client.query<{ value: T }>(`SELECT public.${wrapper}($1,$2,$3) AS value`, [f.workspaceId, action, JSON.stringify(payload)])).rows[0].value
}
async function frame<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  return readRetainedContextFrame(authority(), [], async client => {
    // The101-message fixture verifies semantics under concurrent test load.
    // Product timeout and real latency measurements remain unchanged.
    await client.query("SET LOCAL statement_timeout='60s'")
    return run(client)
  })
}
async function isolated<T>(client: PoolClient, run: () => Promise<T>): Promise<T> {
  const name = `covered_${randomUUID().replaceAll('-', '')}`
  await client.query(`SAVEPOINT ${name}`)
  try { return await run() } finally { await client.query(`ROLLBACK TO SAVEPOINT ${name}`);await client.query(`RELEASE SAVEPOINT ${name}`) }
}
async function emptyQueue() {
  expect(await operation(f.pool, 'state')).toMatchObject({ work: 0, headers: 0, pending: 0, fired: 0, processed: 0 })
}
async function publish(run?: (client: PoolClient, id: string) => Promise<void>, before?: (client: PoolClient) => Promise<void>, inputs = sources) {
  const current = authority()
  return withSessionMessagePublication(current, inputs, async client => {
    await client.query("SET LOCAL statement_timeout='60s'")
    await before?.(client)
    const [row] = await publishNativeSessionMessageBatch({ sessionId: f.session.id,
      messages: [{ role: 'assistant', content: 'Fictional covered response', senderAssistantId: f.assistantId }], authority: current, derivationTarget: f.envelope,
      derivation: { producer: 'fixture:covered-publication', sources: inputs } }, client)
    await run?.(client, row.id)
    return row
  })
}
async function rolledBack(run: (client: PoolClient, id: string) => Promise<void>, inputs = sources) {
  await expect(publish(async (client, id) => { await run(client, id); throw rollback }, undefined, inputs)).rejects.toBe(rollback)
  await emptyQueue()
}
function canonicalClient(client: PoolClient, queries: string[]) {
  return { query: async (sql: string, params?: unknown[]) => {
    queries.push(sql)
    // Decline only the optional large proof, so the actual original validator
    // still supplies the baseline rather than a fabricated admission result.
    if (sql.includes('read_native_turn_scope_evidence') || sql.includes('read_native_covered_session_evidence')) return { rows: [{ value: null }] }
    return client.query(sql, params)
  } } as Pick<PoolClient, 'query'>
}
async function executionInputs(client: PoolClient) {
  const proof = await operation(client, 'frame', sources)
  expect(proof.admitted).toBe(true)
  return proof.executionRoots.map((root: Json) => {
    const original = sources.find(source => source.resourceKind === root.kind && source.resourceId === root.id && source.version === root.version)
    expect(original).toBeDefined()
    return original!
  }) as ScopeSource[]
}
async function originalPreparationWindows(client: PoolClient, inputs: ScopeSource[]) {
  return isolated(client, async () => {
    await operation(client, 'disable_prepare')
    const parts: Json[] = []
    for (let offset = 0; offset < inputs.length; offset += 100) parts.push(await operation(client, 'prepare', {
      session: f.session.id, sources: inputs.slice(offset, offset + 100), target: f.envelope,
    }))
    const retained = new Map<string, ScopeSource>()
    for (const part of parts) for (const source of part.retained as ScopeSource[]) {
      const key = `${source.resourceKind}:${source.resourceId}`
      if (retained.has(key)) expect(source).toEqual(retained.get(key))
      retained.set(key, source)
    }
    const ranks = ['public', 'internal', 'confidential']
    const scope = { ...parts[0].scope,
      sensitivity: ranks[Math.max(...parts.map(part => ranks.indexOf(part.scope.sensitivity)))],
      compartments: [...new Set(parts.flatMap(part => part.scope.compartments as string[]))].sort(),
      projectIds: [...new Set(parts.flatMap(part => part.scope.projectIds as string[]))].sort() }
    return { scope, retained: [...retained.values()].sort((a, b) => `${a.resourceKind}:${a.resourceId}`.localeCompare(`${b.resourceKind}:${b.resourceId}`)) }
  })
}

describe.sequential('[COMP:api/application-persistence] execution-only native evidence covers', () => {
  beforeAll(async () => {
    f = await persistentContextFixture()
    await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
      SELECT $1,'/fictional/covered-'||n||'.txt','Fictional covered file '||n,'fixture://covered-'||n,$2,'user','internal'
      FROM generate_series(1,50) n`, [f.workspaceId, f.ownerId])
    const unbounded = await f.execution(f.firstId), maximumAccess = { ...unbounded.security.ceiling,
      clearance: f.envelope.sensitivity, compartments: f.envelope.compartments, mutationCompartments: [], projectIds: f.envelope.projectIds }
    execution = (await resolveExecutionContextSystem({ userId: f.firstId, workspaceId: f.workspaceId,
      assistant: (await findAssistantById(f.assistantId))!, memberMode: 'member', sharedAudience: true,
      session: f.session, sessionAuthority: f.session, identity: unbounded.identity, ownership: unbounded.ownership,
      lifecycle: unbounded.lifecycle, maximumAccess, maximumAccessCurrent: async () => maximumAccess })).executionContext
    files = (await listWorkspaceFilesIndexRanked(execution.security.access, 50)).flatMap(boundScopeSources)
    expect(files).toHaveLength(50)
    for (let index = 0; index < 101; index++) await addSessionMessage({ sessionId: f.session.id, role: 'user',
      content: `Fictional covered request ${index}`, scope: f.envelope })
    const memory = await createDbMemoryStore().getIndex(execution.security.access, false, authority())
    expect(memory).toHaveLength(0)
    const seed = await publishNativeSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional file-backed seed',
      senderAssistantId: f.assistantId, authority: authority(), derivationTarget: f.envelope,
      derivation: { producer: 'fixture:covered-seed', sources: [...files, ...boundScopeSources(memory)] } })
    through = seed.sequenceNum
    const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, authority: authority() })
    sources = new ContextScopeAccumulator({ sources: [...boundScopeSources(query), ...boundScopeSources(memory), ...files] }).evidence.sources!
    expect(sources.length).toBeGreaterThan(100)
    expect(sources.filter(source => source.resourceKind === 'application_field').length).toBeGreaterThan(100)
    expect(sources.length).toBeLessThan(4096)
    await f.pool.query(`CREATE FUNCTION public.${wrapper}(w uuid,action text,payload jsonb) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE definition text;body text;signature text;d uuid;selected scope_derivation_sources;i integer;
        kinds text[];ids uuid[];versions text[];
      BEGIN
        IF action='state' THEN RETURN jsonb_build_object(
          'headers',(SELECT count(*) FROM native_field_dependency_batches WHERE workspace_id=w),
          'work',(SELECT count(*) FROM native_field_dependency_work WHERE workspace_id=w),
          'pending',coalesce((SELECT sum(pending_events) FROM native_field_dependency_batches WHERE workspace_id=w),0),
          'queued',coalesce((SELECT sum(queued_events) FROM native_field_dependency_batches WHERE workspace_id=w),0),
          'fallback',coalesce((SELECT bool_or(fallback) FROM native_field_dependency_batches WHERE workspace_id=w),false),
          'fired',(SELECT count(*) FROM native_field_dependency_work WHERE workspace_id=w AND fired),
          'processed',(SELECT count(*) FROM native_field_dependency_work WHERE workspace_id=w AND processed),
          'covered',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='validate_native_covered_field_dependency_work(uuid,uuid,bigint)'::regprocedure),0),
          'preparations',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)'::regprocedure),0),
          'cohortProofs',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure),0),
          'coveredFrames',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='read_native_covered_session_frame(uuid,text[],uuid[],text[])'::regprocedure),0),
          'fieldEvaluations',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='application_session_eval_field(uuid,uuid,text,jsonb)'::regprocedure),0),
          'original',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='application_current_field_snapshot(uuid,uuid)'::regprocedure),0));
        ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);RETURN '{}';
        ELSIF action='guards' THEN RETURN jsonb_build_object('covered',application_native_covered_evidence_helpers_current(),
          'deferred',application_native_dependency_batch_helpers_current(),'reference',application_native_field_reference_helpers_current());
        ELSIF action='queue_guard' THEN RETURN to_jsonb(application_native_covered_queue_current());
        ELSIF action IN('prepare','prepare_private') THEN
          IF action='prepare_private' THEN RETURN prepare_native_session_message_covered(w,(payload->>'session')::uuid,
            'fixture:covered-prepare',payload->'sources',payload->'target');END IF;
          RETURN prepare_native_session_message_batch(w,(payload->>'session')::uuid,'fixture:covered-prepare',payload->'sources',payload->'target');
        ELSIF action IN('frame','cover') THEN
          kinds:=ARRAY(SELECT x->>'resourceKind' FROM jsonb_array_elements(payload) x);
          ids:=ARRAY(SELECT (x->>'resourceId')::uuid FROM jsonb_array_elements(payload) x);
          versions:=ARRAY(SELECT x->>'version' FROM jsonb_array_elements(payload) x);
          IF action='frame' THEN RETURN read_native_covered_session_frame(w,kinds,ids,versions);END IF;
          RETURN application_native_root_cover(w,(SELECT jsonb_agg(jsonb_build_object('kind',x->'resourceKind','id',x->'resourceId','version',x->'version')) FROM jsonb_array_elements(payload) x));
        ELSIF action IN('disable','guard_raise','cover_drift','frame_drift','acl_drift','disable_prepare','prepare_guard_raise','old_guard_raise') THEN
          signature:=CASE action WHEN 'cover_drift' THEN 'application_native_root_cover(uuid,jsonb)'
            WHEN 'frame_drift' THEN 'read_native_covered_session_frame(uuid,text[],uuid[],text[])'
            WHEN 'disable_prepare' THEN 'application_native_transcript_prepare_helpers_current()'
            WHEN 'prepare_guard_raise' THEN 'application_native_transcript_prepare_helpers_current()'
            WHEN 'old_guard_raise' THEN 'application_native_dependency_batch_helpers_current()' ELSE '${guard}' END;
          IF action='acl_drift' THEN GRANT EXECUTE ON FUNCTION public.application_native_root_cover(uuid,jsonb) TO app_user;RETURN '{}';END IF;
          SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid=signature::regprocedure;
          EXECUTE replace(definition,body,CASE WHEN action IN('guard_raise','prepare_guard_raise','old_guard_raise') THEN 'BEGIN RAISE EXCEPTION ''Unknown fictional guard invoked'';END'
            WHEN action IN('disable','disable_prepare') THEN 'BEGIN RETURN false;END' ELSE 'BEGIN RETURN NULL;END' END);RETURN '{}';
        ELSIF action='hold' THEN
          INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
          VALUES(w,'workspace_file',(payload->>'id')::uuid,payload->>'version','held',1,'Fictional covered source hold');RETURN '{}';
        ELSIF action='labels' THEN UPDATE workspace_files SET sensitivity='confidential' WHERE workspace_id=w AND id=(payload->>'id')::uuid;RETURN '{}';
        ELSIF action='retire_memory' THEN UPDATE memories SET valid_to=now() WHERE workspace_id=w AND id=(payload->>'id')::uuid;RETURN '{}';
        ELSIF action='independent_files' THEN
          INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
            SELECT w,'/fictional/${wrapper}/'||n,'Fictional independent cover leaf','fixture://independent/'||n,
              (SELECT owner_user_id FROM workspaces WHERE id=w),'user','internal' FROM generate_series(1,101) n;
          RETURN (SELECT jsonb_agg(read_scope_source(w,'workspace_file',id)) FROM workspace_files
            WHERE workspace_id=w AND path LIKE '/fictional/${wrapper}/%');
        ELSIF action='actor' THEN PERFORM set_config('app.current_user_id',payload->>'id',true);RETURN '{}';
        END IF;
        SELECT id INTO d FROM scope_derivations WHERE workspace_id=w AND resource_kind='session_message' AND resource_id=(payload->>'message')::uuid;
        IF d IS NULL THEN RAISE EXCEPTION 'Missing fictional covered derivation';END IF;
        IF action='edges' THEN RETURN (SELECT jsonb_agg(to_jsonb(s) ORDER BY source_kind,source_id) FROM scope_derivation_sources s WHERE workspace_id=w AND derivation_id=d);
        ELSIF action='queued' THEN RETURN (SELECT jsonb_agg(source ORDER BY id) FROM native_field_dependency_work WHERE workspace_id=w AND derivation_id=d);
        ELSIF action='qualifies' THEN RETURN to_jsonb(validate_native_covered_field_dependency_work(w,d,txid_current()));
        ELSIF action='undeclared_domain' THEN
          INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
            VALUES(w,d,'application_field',(payload#>>'{source,resourceId}')::uuid,payload#>>'{source,version}');
          RETURN '{}';
        ELSIF action IN('repeat','repeat_domain') THEN
          IF action='repeat_domain' THEN
            SELECT s.* INTO STRICT selected FROM scope_derivation_sources s JOIN application_field_resources r
              ON r.workspace_id=s.workspace_id AND r.id=s.source_id
              WHERE s.workspace_id=w AND s.derivation_id=d AND s.source_kind='application_field'
                AND r.type_key='session_message' AND r.selection='query_domain' ORDER BY s.source_id LIMIT 1;
          ELSE
            SELECT * INTO STRICT selected FROM scope_derivation_sources WHERE workspace_id=w AND derivation_id=d AND source_kind='workspace_file' ORDER BY source_id LIMIT 1;
          END IF;
          FOR i IN 1..(payload->>'count')::integer LOOP
            UPDATE scope_derivation_sources SET source_version=source_version WHERE workspace_id=w AND derivation_id=d AND source_kind=selected.source_kind AND source_id=selected.source_id;
          END LOOP;RETURN '{}';
        END IF;
        RAISE EXCEPTION 'Unknown fictional covered operation';
      END $fixture$;
      REVOKE ALL ON FUNCTION public.${wrapper}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.${wrapper}(uuid,text,jsonb) TO app_user`)
    await emptyQueue()
  }, 240_000)
  afterAll(async () => {
    try { await getPool().query(`DROP FUNCTION IF EXISTS public.${wrapper}(uuid,text,jsonb)`);await f?.cleanup() }
    finally { await getAppPool().end();await getPool().end() }
  })

  it('returns complete canonical caller evidence while privately covering more than one hundred original roots', async () => frame(async client => {
    expect(await operation(client, 'guards')).toEqual({ covered: true, deferred: true, reference: true })
    const proof = await operation(client, 'frame', sources)
    expect(proof.admitted).toBe(true)
    expect(proof.executionRoots.length).toBeGreaterThan(0);expect(proof.executionRoots.length).toBeLessThanOrEqual(100)
    const originalTuples = new Set(sources.map(s => `${s.resourceKind}:${s.resourceId}:${s.version}`))
    for (const root of proof.executionRoots) expect(originalTuples.has(`${root.kind}:${root.id}:${root.version}`)).toBe(true)
    const lineage = new Set(proof.lineage.map((s: Json) => `${s.kind}:${s.id}:${s.version}`))
    for (const key of originalTuples) expect(lineage.has(key)).toBe(true)
    expect(proof.immutable.filter((s: Json) => s.resourceKind === 'application_field').length).toBeGreaterThan(100)
    const actual = await validateCallerScopeEvidence({ sources }, execution.security.ceiling, client)
    const queries: string[] = []
    const baseline = await validateCallerScopeEvidence({ sources }, execution.security.ceiling, canonicalClient(client, queries))
    expect(normalized(actual)).toEqual(normalized(baseline))
    expect(queries.some(sql => sql.includes('read_native_turn_scope_evidence'))).toBe(true)
    for (const source of sources) expect(actual.sources).toContainEqual(source)
    const value = (await client.query('SELECT read_native_covered_session_evidence($1,$2,$3,$4) AS value', args())).rows[0].value
    expect(Object.keys(value).sort()).toEqual(['admitted', 'current', 'immutable'])
  }), 180_000)

  it('uses the complete large-evidence path at the actual invocation boundary', async () => {
    const admitted = await tryNativeInvocationEvidence(execution, { sources }, execution.security.ceiling, 'caller')
    expect(admitted).not.toBeNull()
    for (const source of sources) expect(admitted!.sources).toContainEqual(source)
  }, 120_000)

  it('preserves the complete prepared scope and retained sources while sharing only fresh field evaluation', async () => frame(async client => {
    const inputs = await executionInputs(client)
    expect(inputs.length).toBeLessThanOrEqual(100)
    const payload = { session: f.session.id, sources: inputs, target: f.envelope }
    await operation(client, 'trace');const before = await operation(client, 'state')
    const actual = await operation(client, 'prepare', payload), after = await operation(client, 'state')
    expect(actual.retained.length).toBeGreaterThan(100)
    expect(after.preparations - before.preparations).toBe(1)
    const baseline = await isolated(client, async () => {
      await operation(client, 'disable_prepare')
      const start = await operation(client, 'state'), value = await operation(client, 'prepare', payload), end = await operation(client, 'state')
      expect(after.fieldEvaluations - before.fieldEvaluations).toBeLessThan(end.fieldEvaluations - start.fieldEvaluations)
      return value
    })
    expect(actual).toEqual(baseline)
    for (const source of inputs) expect(actual.retained).toContainEqual(source)
  }), 180_000)

  it('matches the union of independent original preparation windows for every large-input source and floor', async () => frame(async client => {
    const payload = { session: f.session.id, sources, target: f.envelope }
    const actual = await operation(client, 'prepare', payload)
    expect(actual).toEqual(await originalPreparationWindows(client, sources))
    for (const source of sources) expect(actual.retained).toContainEqual(source)
    // The original helper advertises4096 inputs but its metadata reader had a
    //100-root implementation limit. Keep this distinct from output equivalence.
    await expect(isolated(client, async () => { await operation(client, 'disable_prepare');return operation(client, 'prepare', payload) })).rejects.toBeDefined()
  }), 180_000)

  it('falls back to the original preparation without executing an altered preparation guard', async () => frame(async client => isolated(client, async () => {
    const payload = { session: f.session.id, sources: await executionInputs(client), target: f.envelope }
    const expected = await operation(client, 'prepare', payload)
    await operation(client, 'prepare_guard_raise')
    expect(await operation(client, 'prepare', payload)).toEqual(expected)
  })), 180_000)

  it('preserves missing native D1 behavior and its immutable label floor during preparation', async () => frame(async client => {
    const absent = { ...files[0], resourceId: randomUUID() }
    const payload = { session: f.session.id, sources: [...await executionInputs(client), absent], target: f.envelope }
    const actual = await operation(client, 'prepare', payload)
    const expected = await isolated(client, async () => { await operation(client, 'disable_prepare');return operation(client, 'prepare', payload) })
    expect(actual).toEqual(expected)
    expect(actual.retained.some((source: ScopeSource) => source.resourceId === absent.resourceId)).toBe(false)
    expect(actual.scope.sensitivity).toBe(f.envelope.sensitivity)
  }), 180_000)

  it('preserves retired Memory D1 behavior through the unchanged full native reader', async () => {
    const other = await persistentContextFixture()
    try {
      const memory = await other.memory('Fictional lifecycle preparation fact')
      const current = { execution: await other.execution(other.firstId), accumulator: new ContextScopeAccumulator() }
      await readRetainedContextFrame(current, [], async client => {
        const full = (await client.query('SELECT read_admitted_native_scope_snapshot($1,$2,$3) AS value', [other.workspaceId, 'memory', memory.id])).rows[0].value
        expect(full?.held).toBe(false)
        const source: ScopeSource = { workspaceId: other.workspaceId, userId: full.userId, assistantId: full.assistantId,
          sensitivity: full.sensitivity, compartments: full.compartments, projectIds: full.projectIds,
          resourceKind: 'memory', resourceId: memory.id, version: full.version }
        const run = async (action: string, payload: unknown = {}) => (await client.query(`SELECT public.${wrapper}($1,$2,$3) AS value`, [other.workspaceId, action, payload])).rows[0].value
        await run('retire_memory', { id: memory.id })
        const payload = { session: other.session.id, sources: [source], target: other.envelope }
        expect(await run('prepare_private', payload)).toBeNull()
        const actual = await run('prepare', payload)
        const expected = await isolated(client, async () => { await run('disable_prepare');return run('prepare', payload) })
        expect(actual).toEqual(expected)
        expect(actual.retained).toEqual([])
        expect(actual.scope.sensitivity).toBe(source.sensitivity)
      })
    } finally { await other.cleanup() }
  }, 120_000)

  it('commits a real large publication retaining every original source declaration and reads it back', async () => {
    const row = await publish(async (client, id) => {
      const pending = await operation(client, 'state')
      expect(pending.work).toBeGreaterThan(100);expect(pending.fallback).toBe(false)
      expect(pending.pending).toBe(pending.work);expect(pending.processed).toBe(0)
      const edges = await operation<Json[]>(client, 'edges', { message: id })
      expect(keys(await operation<unknown[]>(client, 'queued', { message: id }))).toEqual(keys(edges))
      for (const source of sources) expect(edges.some(edge => edge.source_kind === source.resourceKind
        && edge.source_id === source.resourceId && edge.source_version === source.version)).toBe(true)
      expect(pending.preparations).toBe(2)
    }, client => operation(client, 'trace').then(() => undefined))
    await emptyQueue()
    const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: row.sequenceNum, authority: authority() })
    expect(query.history.find(message => message.id === row.id)?.content).toBe('Fictional covered response')
    // Classification consumes BODY only; including a negative topics query
    // through this same message would make the new annotation depend on its
    // own prior absence rather than mirror the real classifier contract.
    const body = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: row.sequenceNum,
      topicThroughSequence: 0, authority: authority() })
    expect(await writeSessionContextRevision({ sessionId: f.session.id, parentId: row.id, kind: 'message_annotation',
      content: { topicLabel: 'Fictional large context', topicConfidence: 0.9, replyToText: null }, authority: authority(),
      derivation: { producer: 'fixture:covered-annotation', sources: [...boundScopeSources(body), ...files] } })).not.toBeNull()
    const annotated = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: row.sequenceNum, authority: authority() })
    expect(annotated.annotations.some(annotation => annotation.id === row.id && annotation.topicLabel === 'Fictional large context')).toBe(true)
  }, 180_000)

  it('keeps the existing single-message writer limit separate from the large chat batch contract', async () => {
    await expect(publishNativeSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional legacy writer boundary',
      authority: authority(), derivationTarget: f.envelope, derivation: { producer: 'fixture:legacy-root-bound', sources } }))
      .rejects.toMatchObject({ code: 'scope_evidence_missing' })
    await emptyQueue()
  }, 120_000)

  it('validates the expanded field set once at the real named constraint boundary', async () => rolledBack(async (client, id) => {
    // The worker cannot admit pending, unfired events before the real boundary.
    expect(await operation(client, 'qualifies', { message: id })).toBe(false)
    await operation(client, 'trace');const before = await operation(client, 'state')
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    const after = await operation(client, 'state')
    expect(after).toMatchObject({ headers: 0, work: 0, pending: 0, fired: 0, processed: 0 })
    expect(after.covered - before.covered).toBe(1)
    expect(after.cohortProofs - before.cohortProofs).toBe(1)
    expect(after.original).toBe(before.original)
  }), 120_000)

  it('retains duplicate full-NEW events past one hundred and restores them on savepoint rollback', async () => rolledBack(async (client, id) => {
    const before = await operation(client, 'state')
    await client.query('SAVEPOINT duplicate_events')
    await operation(client, 'repeat', { message: id, count: 101 })
    const pending = await operation(client, 'state')
    expect(pending.work - before.work).toBe(101);expect(pending.pending).toBe(pending.work)
    expect(pending.fallback).toBe(false);expect(pending.processed).toBe(0)
    await client.query('ROLLBACK TO SAVEPOINT duplicate_events')
    expect(await operation(client, 'state')).toEqual(before)
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    expect(await operation(client, 'state')).toMatchObject({ work: 0, headers: 0 })
  }), 120_000)

  it('keeps immediate then deferred updates fresh and leaves no prior proof result', async () => rolledBack(async (client, id) => {
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    await operation(client, 'repeat', { message: id, count: 1 })
    expect(await operation(client, 'state')).toMatchObject({ work: 0, headers: 0 })
    await client.query(`SET CONSTRAINTS ${constraint} DEFERRED`)
    await operation(client, 'repeat', { message: id, count: 101 })
    expect(await operation(client, 'state')).toMatchObject({ work: 101, pending: 101, processed: 0, fallback: false })
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    expect(await operation(client, 'state')).toMatchObject({ work: 0, headers: 0 })
  }), 120_000)

  it('covers more than one hundred expanded fields even when only two source events are pending', async () => rolledBack(async (client, id) => {
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    await client.query(`SET CONSTRAINTS ${constraint} DEFERRED`)
    await operation(client, 'repeat_domain', { message: id, count: 2 })
    expect(await operation(client, 'state')).toMatchObject({ work: 2, pending: 2, processed: 0, fallback: false })
    expect(await operation(client, 'qualifies', { message: id })).toBe(false)
    await operation(client, 'trace');const before = await operation(client, 'state')
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    const after = await operation(client, 'state')
    expect(after.covered - before.covered).toBe(1)
    expect(after.original).toBe(before.original)
    expect(after).toMatchObject({ work: 0, headers: 0 })
  }), 120_000)

  it('refuses a real added query-domain edge whose expanded field obligations were never declared', async () => {
    const domainIds = new Set((await f.pool.query<{ id: string }>(`SELECT id FROM application_field_resources
      WHERE workspace_id=$1 AND type_key='session_message' AND selection='query_domain'`, [f.workspaceId])).rows.map(row => row.id))
    const domain = sources.find(source => source.resourceKind === 'application_field' && domainIds.has(source.resourceId))!
    expect(domain).toBeDefined()
    let inserted = false
    await expect(publish(async (client, id) => {
      await operation(client, 'undeclared_domain', { message: id, source: domain })
      inserted = true
      await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    }, undefined, files)).rejects.toMatchObject({ message: 'scope_evidence_missing' })
    expect(inserted).toBe(true)
    await emptyQueue()
  }, 120_000)

  for (const change of ['hold', 'labels'] as const) it(`rejects a fresh ${change} while large publication work is pending`, async () => {
    let reached = false
    await expect(publish(async client => {
      expect((await operation(client, 'state')).work).toBeGreaterThan(100)
      reached = true
      await operation(client, change, { id: files[0].resourceId, version: files[0].version })
      await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    })).rejects.toMatchObject({ message: expect.stringMatching(/^scope_(source_changed|operation_denied|visibility_incompatible|evidence_missing)$/) })
    expect(reached).toBe(true)
    await emptyQueue()
  }, 120_000)

  for (const change of ['hold', 'labels'] as const) it(`preserves canonical caller denial after a file ${change}`, async () => frame(async client => isolated(client, async () => {
    await operation(client, change, { id: files[0].resourceId, version: files[0].version })
    for (const baseline of [false, true]) await expect(isolated(client, () => validateCallerScopeEvidence({ sources }, execution.security.ceiling,
      baseline ? canonicalClient(client, []) : client))).rejects.toBeDefined()
  })), 120_000)

  it('preserves every original private-label floor even when its identity is covered by another root', async () => frame(async client => {
    const privateInput = structuredClone(sources)
    privateInput.find(source => source.resourceKind === 'workspace_file')!.userId = f.secondId
    await expect(validateCallerScopeEvidence({ sources: privateInput }, execution.security.ceiling, client)).rejects.toMatchObject({ diagnostic: 'user_visibility' })
  }))

  it('declines more than one hundred independent representatives without truncating the original caller sources', async () => frame(async client => isolated(client, async () => {
    const leaves = await operation<ScopeSource[]>(client, 'independent_files')
    expect(leaves).toHaveLength(101)
    const inputs = [sources.find(source => source.resourceKind === 'application_field')!, ...leaves]
    expect((await client.query('SELECT read_native_covered_session_evidence($1,$2,$3,$4) AS value', args(inputs))).rows[0].value).toBeNull()
    const actual = await validateCallerScopeEvidence({ sources: inputs }, execution.security.ceiling, client)
    expect(normalized(actual)).toEqual(normalized(await validateCallerScopeEvidence({ sources: inputs }, execution.security.ceiling, canonicalClient(client, []))))
    for (const leaf of leaves) expect(actual.sources?.some(source => source.resourceId === leaf.resourceId && source.version === leaf.version)).toBe(true)
  })), 120_000)

  it('declines oversized identity input before constructing an unbounded proof', async () => frame(async client => {
    const oversized = Array.from({ length: 4097 }, () => sources[0])
    expect((await client.query('SELECT read_native_covered_session_evidence($1,$2,$3,$4) AS value', args(oversized))).rows[0].value).toBeNull()
    let queried = false
    expect(await readNativeSessionEvidence({ query: async () => { queried = true;throw new Error('Oversized native input queried SQL') } } as Pick<PoolClient, 'query'>,
      f.workspaceId, oversized)).toBeNull()
    expect(queried).toBe(false)
  }))

  it('does not cover a changed original field version by a current ancestor identity', async () => frame(async client => {
    const stale = structuredClone(sources)
    stale.find(source => source.resourceKind === 'application_field')!.version = 'fictional-unrecorded-version'
    for (const baseline of [false, true]) await expect(isolated(client, () => validateCallerScopeEvidence({ sources: stale }, execution.security.ceiling,
      baseline ? canonicalClient(client, []) : client))).rejects.toBeDefined()
  }), 120_000)

  for (const change of ['guard_raise', 'cover_drift', 'frame_drift', 'acl_drift'] as const) it(`selects the original complete caller path after ${change}`, async () => frame(async client => isolated(client, async () => {
    const expected = await validateCallerScopeEvidence({ sources }, execution.security.ceiling, canonicalClient(client, []))
    await operation(client, change)
    expect((await client.query('SELECT read_native_covered_session_evidence($1,$2,$3,$4) AS value', args())).rows[0].value).toBeNull()
    expect(normalized(await validateCallerScopeEvidence({ sources }, execution.security.ceiling, client))).toEqual(normalized(expected))
  })), 180_000)

  it('replays original pending publication validation after covered helper drift', async () => rolledBack(async client => {
    await operation(client, 'cover_drift')
    await operation(client, 'trace');const before = await operation(client, 'state')
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    const after = await operation(client, 'state')
    expect(after).toMatchObject({ headers: 0, work: 0, pending: 0 })
    expect(after.original).toBeGreaterThan(before.original)
  }), 180_000)

  it('rejects a changed queue guard before invoking its unknown body', async () => frame(async client => isolated(client, async () => {
    expect(await operation(client, 'queue_guard')).toBe(true)
    await operation(client, 'old_guard_raise')
    expect(await operation(client, 'queue_guard')).toBe(false)
  })))

  it('exposes only identity facades and uses native requirements for small roots', async () => frame(async client => {
    const privateNames = ['application_native_covered_evidence_helpers_current', 'application_native_root_cover',
      'read_native_covered_session_frame', 'read_native_covered_memory_frame', 'application_native_covered_queue_current',
      'validate_native_covered_field_dependency_work', 'prepare_native_session_message_covered', 'application_native_transcript_prepare_helpers_current']
    const privileges = await client.query<{ proname: string; permitted: boolean }>(`SELECT proname,has_function_privilege(current_user,oid,'EXECUTE') AS permitted
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`, [privateNames])
    expect(privileges.rows.map(row => row.proname).sort()).toEqual(privateNames.sort())
    expect(privileges.rows.every(row => !row.permitted)).toBe(true)
    const calls: string[] = []
    await readNativeSessionEvidence({ query: async (sql: string, params?: unknown[]) => { calls.push(sql);return client.query(sql, params) } } as Pick<PoolClient, 'query'>,
      f.workspaceId, sources.filter(source => source.resourceKind === 'application_field').slice(0, 1))
    expect(calls[0]).toContain('read_native_turn_scope_evidence')
    expect(calls.some(sql => sql.includes('read_native_covered_session_evidence'))).toBe(false)
  }))

  it('requires the original reader grants before a newly granted facade can begin a proof', async () => {
    const client = await getPool().connect(), role = `fictional_covered_reader_${randomUUID().replaceAll('-', '')}`
    try {
      await client.query('BEGIN')
      await client.query(`CREATE ROLE ${role} NOLOGIN`)
      await client.query(`GRANT EXECUTE ON FUNCTION read_native_covered_session_evidence(uuid,text[],uuid[],text[]),public.${wrapper}(uuid,text,jsonb) TO ${role}`)
      await client.query("SELECT set_config('track_functions','all',true),set_config('app.current_user_id',$1,true),set_config('app.v2_assistant_id',$2,true)", [f.firstId, f.assistantId])
      await client.query(`SET SESSION AUTHORIZATION ${role}`)
      expect(await operation(client, 'guards')).toEqual({ covered: true, deferred: true, reference: true })
      expect((await client.query(`SELECT has_function_privilege(session_user,'read_native_covered_session_evidence(uuid,text[],uuid[],text[])','EXECUTE') AS facade,
        has_function_privilege(session_user,'read_native_attended_memory_evidence(uuid,text[],uuid[],text[])','EXECUTE') AS original`)).rows[0])
        .toEqual({ facade: true, original: false })
      const before = await operation(client, 'state')
      expect((await client.query('SELECT read_native_covered_session_evidence($1,$2,$3,$4) AS value', args())).rows[0].value).toBeNull()
      expect((await operation(client, 'state')).coveredFrames).toBe(before.coveredFrames)
    } finally { await client.query('RESET SESSION AUTHORIZATION');await client.query('ROLLBACK');client.release() }
  })
})
