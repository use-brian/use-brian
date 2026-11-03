import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { boundScopeSources, ContextScopeAccumulator, type ExecutionContext, type ScopeSource } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { listWorkspaceFilesIndexRanked } from '../../db/workspace-files.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { readSessionContextRevisions, withSessionMessagePublication, writeSessionContextRevision } from '../../db/session-context-revisions.js'
import { publishNativeSessionMessage } from '../../db/session-message-publication.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const fixtureName = `reference_fixture_${randomUUID().replaceAll('-', '')}`
const guard = 'application_native_field_reference_helpers_current()'
const snapshot = 'read_native_field_reference_snapshot(uuid,uuid,uuid,text)'
const rollback = new Error('Fictional reference rollback')
type Json = Record<string, any>
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let execution: ExecutionContext
let files: ScopeSource[]
let sources: ScopeSource[]
let field: ScopeSource
let messageId: string
let derivationId: string
let through: number
const authority = () => ({ execution, accumulator: new ContextScopeAccumulator() })
async function operation<T = Json | null>(client: Pick<PoolClient, 'query'>, action: string, payload: unknown = {}): Promise<T> {
  return (await client.query<{ value: T }>(`SELECT public.${fixtureName}($1,$2,$3) AS value`, [f.workspaceId, action, payload])).rows[0].value
}
async function frame<T>(run: (client: PoolClient) => Promise<T>, owner = false) {
  const client = await (owner ? getPool() : getAppPool()).connect()
  try { return await runWithAgentAccess(execution.security.access, async () => {
    await client.query('BEGIN'); await applyRLSGucs(client, execution.security.access.userId)
    await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [execution.assistant.id])
    return await run(client)
  }) } finally { await rollbackAndRelease(client) }
}
async function outcome(client: PoolClient, run: () => Promise<unknown>) {
  await client.query('SAVEPOINT observed_reference')
  try { return { value: await run() } }
  catch (error) { const failure = error as { code?: string; message: string }; return { error: failure.code, message: failure.message } }
  finally { await client.query('ROLLBACK TO SAVEPOINT observed_reference') }
}
async function baseline<T>(client: PoolClient, run: () => Promise<T>) {
  await client.query('SAVEPOINT original_reference')
  try { await operation(client, 'disable'); expect(await operation(client, 'guard')).toBe(false); return await run() }
  finally { await client.query('ROLLBACK TO SAVEPOINT original_reference') }
}
const reference = (client: PoolClient, source: Pick<ScopeSource, 'resourceKind' | 'resourceId' | 'version'> = field, canonical = false, target = derivationId) =>
  operation(client, canonical ? 'canonical_reference' : 'reference', { ...source, derivationId: target })
async function publication(run: (client: PoolClient, id: string, derivation: string) => Promise<void>, inputs = sources) {
  // A rejected invocation stays revoked even if its fixture transaction rolls
  // back the policy change; each publication owns a real separate lease.
  const fresh = (await resolveExecutionContextSystem({ userId: f.firstId, workspaceId: f.workspaceId,
    assistant: (await findAssistantById(f.assistantId))!, memberMode: 'member', sharedAudience: true,
    session: f.session, sessionAuthority: f.session, identity: execution.identity, ownership: execution.ownership,
    lifecycle: execution.lifecycle, maximumAccess: execution.security.ceiling,
    maximumAccessCurrent: async () => execution.security.ceiling })).executionContext
  const current = { execution: fresh, accumulator: new ContextScopeAccumulator() }
  return withSessionMessagePublication(current, inputs, async client => {
    const row = await publishNativeSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional reference publication',
      senderAssistantId: f.assistantId, authority: current, derivationTarget: f.envelope,
      derivation: { producer: 'fixture:reference-publication', sources: inputs } }, client)
    const d = await operation<string>(client, 'derivation_id', { message: row.id })
    await run(client, row.id, d)
    return row
  })
}
async function transactionOutcome(run: () => Promise<unknown>) {
  try { await run(); return { accepted: true } }
  catch (error) {
    if (error === rollback) return { accepted: true }
    const failure = error as { code?: string; message: string; cause?: { code?: string; message?: string } }
    return { error: failure.cause?.code ?? failure.code, message: failure.cause?.message ?? failure.message }
  }
}
async function emptyQueue() {
  expect((await f.pool.query('SELECT 1 FROM native_field_dependency_work WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
  expect((await f.pool.query('SELECT 1 FROM native_field_dependency_batches WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
}

describe.sequential('[COMP:api/application-persistence] immediate native field references', () => {
  beforeAll(async () => {
    f = await persistentContextFixture()
    await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
      SELECT $1,'/fictional/reference-'||n||'.txt','Fictional reference file '||n,'fixture://reference-'||n,$2,'user','internal'
      FROM generate_series(1,50) n`, [f.workspaceId, f.ownerId])
    await f.history()
    const unbounded = await f.execution(f.firstId), maximumAccess = { ...unbounded.security.ceiling,
      clearance: f.envelope.sensitivity, compartments: f.envelope.compartments, mutationCompartments: [], projectIds: f.envelope.projectIds }
    execution = (await resolveExecutionContextSystem({ userId: f.firstId, workspaceId: f.workspaceId,
      assistant: (await findAssistantById(f.assistantId))!, memberMode: 'member', sharedAudience: true,
      session: f.session, sessionAuthority: f.session, identity: unbounded.identity, ownership: unbounded.ownership,
      lifecycle: unbounded.lifecycle, maximumAccess, maximumAccessCurrent: async () => maximumAccess })).executionContext
    files = (await listWorkspaceFilesIndexRanked(execution.security.access, 50)).flatMap(file => boundScopeSources(file))
    expect(files).toHaveLength(50); through = 3
    for (let turn = 0; turn < 2; turn++) {
      const current = authority(), query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, authority: current })
      const memory = await createDbMemoryStore().getIndex(execution.security.access, false, current)
      sources = new ContextScopeAccumulator({ sources: [...boundScopeSources(query), ...boundScopeSources(memory), ...files] }).evidence.sources!
      const row = await publishNativeSessionMessage({ sessionId: f.session.id, role: 'assistant',
        content: `Fictional reference history ${turn + 1}`, senderAssistantId: f.assistantId, authority: current,
        derivationTarget: f.envelope, derivation: { producer: 'fixture:reference-history', sources } })
      through = row.sequenceNum; messageId = row.id
    }
    // Annotation inputs retain the BODY prefix, not the topic-head query that
    // this very annotation is about to advance.
    const current = authority(), query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, topicThroughSequence: 0, authority: current })
    const memory = await createDbMemoryStore().getIndex(execution.security.access, false, current)
    sources = new ContextScopeAccumulator({ sources: [...boundScopeSources(query), ...boundScopeSources(memory), ...files] }).evidence.sources!
    derivationId = (await f.pool.query("SELECT id FROM scope_derivations WHERE workspace_id=$1 AND resource_kind='session_message' AND resource_id=$2", [f.workspaceId, messageId])).rows[0].id
    // These tables isolate the real BEFORE function's predicate from separate
    // immutable-lineage/deferred validators. They never replace a canonical
    // relation or fabricate a source snapshot, and all probes roll back.
    await f.pool.query(`CREATE SCHEMA ${fixtureName};
      CREATE TABLE ${fixtureName}.scope_derivation_sources(workspace_id uuid,derivation_id uuid,source_kind text,source_id uuid,source_version text);
      CREATE TRIGGER reference BEFORE INSERT ON ${fixtureName}.scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION public.validate_scope_resource_reference();
      CREATE TABLE ${fixtureName}.scope_resource_states(workspace_id uuid,resource_kind text,resource_id uuid,resource_version text);
      CREATE TRIGGER reference BEFORE INSERT ON ${fixtureName}.scope_resource_states FOR EACH ROW EXECUTE FUNCTION public.validate_scope_resource_reference();
      CREATE TABLE ${fixtureName}.scope_derivations(workspace_id uuid,resource_kind text,resource_id uuid,resource_version text,
        user_id uuid,assistant_id uuid,sensitivity text,compartments text[],project_ids uuid[]);
      CREATE TRIGGER reference BEFORE INSERT ON ${fixtureName}.scope_derivations FOR EACH ROW EXECUTE FUNCTION public.validate_scope_resource_reference();
      REVOKE ALL ON SCHEMA ${fixtureName} FROM PUBLIC,app_user;
      REVOKE ALL ON ALL TABLES IN SCHEMA ${fixtureName} FROM PUBLIC,app_user;
      CREATE FUNCTION public.${fixtureName}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE definition text;body text;signature text;envelope jsonb;output jsonb;
      BEGIN
        IF action='guard' THEN RETURN to_jsonb(application_native_field_reference_helpers_current());
        ELSIF action='guards' THEN RETURN jsonb_build_object('reference',application_native_field_reference_helpers_current(),
          'deferred',application_native_dependency_batch_helpers_current(),'files',application_native_file_capture_helpers_current(),
          'original',application_memory_statement_helpers_current());
        ELSIF action='snapshot' THEN RETURN read_native_field_reference_snapshot(w,(payload->>'derivationId')::uuid,(payload->>'resourceId')::uuid,payload->>'version');
        ELSIF action='derivation_id' THEN RETURN to_jsonb((SELECT id FROM scope_derivations WHERE workspace_id=w AND resource_kind='session_message' AND resource_id=(payload->>'message')::uuid));
        ELSIF action='queue' THEN RETURN jsonb_build_object('work',(SELECT count(*) FROM native_field_dependency_work WHERE workspace_id=w),
          'headers',(SELECT count(*) FROM native_field_dependency_batches WHERE workspace_id=w));
        ELSIF action='original' THEN RETURN read_scope_source(w,payload->>'resourceKind',(payload->>'resourceId')::uuid);
        ELSIF action='edge_exists' THEN RETURN to_jsonb(EXISTS(SELECT 1 FROM scope_derivation_sources WHERE workspace_id=w
          AND derivation_id=(payload->>'derivationId')::uuid AND source_kind=payload->>'resourceKind' AND source_id=(payload->>'resourceId')::uuid));
        ELSIF action='dependencies' THEN RETURN (SELECT coalesce(jsonb_agg(source),'[]') FROM read_application_field_dependencies(w,
          ARRAY[payload->>'resourceKind'],ARRAY[(payload->>'resourceId')::uuid],ARRAY[payload->>'version']));
        ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);RETURN '{}'::jsonb;
        ELSIF action='stats' THEN RETURN jsonb_build_object(
          'shortcut',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='${snapshot}'::regprocedure),0),
          'original',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='application_current_field_snapshot(uuid,uuid)'::regprocedure),0));
        ELSIF action='disable' THEN
          SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid='${guard}'::regprocedure;
          EXECUTE replace(definition,body,'BEGIN RETURN false;END');RETURN '{}'::jsonb;
        ELSIF action='reference' THEN
          INSERT INTO ${fixtureName}.scope_derivation_sources VALUES(w,(payload->>'derivationId')::uuid,payload->>'resourceKind',(payload->>'resourceId')::uuid,payload->>'version');
        ELSIF action='canonical_reference' THEN
          INSERT INTO public.scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
            VALUES(w,(payload->>'derivationId')::uuid,payload->>'resourceKind',(payload->>'resourceId')::uuid,payload->>'version') ON CONFLICT DO NOTHING;
        ELSIF action='review' THEN
          INSERT INTO ${fixtureName}.scope_resource_states VALUES(w,payload->>'resourceKind',(payload->>'resourceId')::uuid,payload->>'version');
        ELSIF action='derivation' THEN
          INSERT INTO ${fixtureName}.scope_derivations VALUES(w,payload->>'resourceKind',(payload->>'resourceId')::uuid,payload->>'version',NULL,NULL,
            payload->>'sensitivity','{}','{}');
        ELSIF action='hold' THEN
          INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
            VALUES(w,payload->>'resourceKind',(payload->>'resourceId')::uuid,payload->>'version','held',1,'Fictional immediate source hold');
        ELSIF action='labels' THEN UPDATE workspace_files SET sensitivity='confidential' WHERE workspace_id=w AND id=(payload->>'resourceId')::uuid;
        ELSIF action='permission' THEN UPDATE workspace_members SET clearance='public' WHERE workspace_id=w AND user_id='${f.firstId}'::uuid;
        ELSIF action='delete_output' THEN DELETE FROM session_messages WHERE workspace_id=w AND id=(payload->>'message')::uuid;
        ELSIF action='fk_drift' THEN
          SELECT t.tgname INTO STRICT signature FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_constraint c ON c.oid=t.tgconstraint
            WHERE c.conrelid='public.scope_derivation_sources'::regclass AND c.confrelid='public.scope_derivations'::regclass
            AND t.tgrelid='public.scope_derivations'::regclass AND p.proname='RI_FKey_cascade_del';
          EXECUTE format('ALTER TABLE public.scope_derivations DISABLE TRIGGER %I',signature);
        ELSIF action='drift' THEN
          signature:=payload->>'signature';
          IF payload->>'mode'='acl' THEN EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO app_user';
          ELSIF payload->>'mode'='body' THEN
            SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid=to_regprocedure('public.'||signature);
            EXECUTE replace(definition,body,body||E'\n-- fictional metadata drift');
          ELSE EXECUTE 'ALTER FUNCTION public.'||signature||' COST 101';END IF;
        ELSIF action IN('unobserved','capture_extra') THEN
          envelope:=application_compute_field_envelope(w,'{"kind":"native","moduleKey":"native"}','session_message','${messageId}'::uuid,'identity',NULL,ARRAY['id']);
          IF envelope IS NULL THEN RAISE EXCEPTION 'Missing fictional unobserved field';END IF;
          IF action='capture_extra' THEN PERFORM application_materialize_field_envelope(w,envelope);RETURN envelope->'source';END IF;
          INSERT INTO application_field_resources(id,workspace_id,origin,type_key,resource_id,selection,selected_version,fields,field_identity,identity)
            VALUES((envelope->>'resourceId')::uuid,w,envelope->'origin',envelope->>'typeKey',(envelope->>'id')::uuid,envelope->>'selection',envelope->>'selectedVersion',
              ARRAY(SELECT jsonb_array_elements_text(envelope->'fields')),envelope->>'fieldIdentity',envelope->>'identity') ON CONFLICT DO NOTHING;
          IF EXISTS(SELECT 1 FROM application_field_observations WHERE resource_id=(envelope->>'resourceId')::uuid) THEN RAISE EXCEPTION 'Fictional field already observed';END IF;
          RETURN envelope->'source';
        ELSE RAISE EXCEPTION 'Unknown fictional reference operation';END IF;
        RETURN '"accepted"'::jsonb;
      END $fixture$;
      REVOKE ALL ON FUNCTION public.${fixtureName}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.${fixtureName}(uuid,text,jsonb) TO app_user`)
    // Choose an already declared native field; its immutable observation is
    // real, while current admission remains the deferred validator's job.
    const candidates = (await f.pool.query<{ id: string; version: string }>(`SELECT source_id AS id,source_version AS version
      FROM scope_derivation_sources WHERE derivation_id=$1 AND source_kind='application_field' ORDER BY source_id`, [derivationId])).rows
    for (const candidate of candidates) {
      const source = sources.find(value => value.resourceKind === 'application_field' && value.resourceId === candidate.id && value.version === candidate.version)
      if (source) { field = source; break }
    }
    expect(field).toBeDefined()
  }, 180_000)
  afterAll(async () => {
    try { await f?.pool.query(`DROP FUNCTION IF EXISTS public.${fixtureName}(uuid,text,jsonb);DROP SCHEMA IF EXISTS ${fixtureName} CASCADE`); await f?.cleanup() }
    finally { await getAppPool().end(); await getPool().end() }
  })

  it('uses immutable identity only on a current-transaction canonical output and still drains fresh validation', async () => {
    const row = await publication(async (client, _id, target) => {
      expect(await operation(client, 'guards')).toEqual({ reference: true, deferred: true, files: true, original: true })
      expect(await operation(client, 'snapshot', { ...field, derivationId: target })).toEqual({
        workspaceId: f.workspaceId, resourceKind: 'application_field', resourceId: field.resourceId, version: field.version,
      })
      await operation(client, 'trace')
      const before = (await operation(client, 'stats'))!, queued = await operation(client, 'queue')
      expect(await reference(client, field, true, target)).toBe('accepted')
      const after = (await operation(client, 'stats'))!
      expect(after.shortcut).toBeGreaterThan(before.shortcut)
      expect(after.original).toBe(before.original)
      expect(await operation(client, 'queue')).toEqual(queued) // ignored conflict adds no work
      // The same qualifying identity and current transaction must not grant
      // the shortcut to a different relation with the same unqualified name.
      expect(await reference(client, field, false, target)).toBe('accepted')
      const foreign = (await operation(client, 'stats'))!
      expect(foreign.shortcut).toBe(after.shortcut)
      expect(foreign.original).toBeGreaterThan(after.original)
      await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
      expect(await operation(client, 'queue')).toEqual({ work: 0, headers: 0 })
    })
    await emptyQueue()
    const read = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: row.sequenceNum, authority: authority() })
    expect(read.history.some(message => message.id === row.id && message.content === 'Fictional reference publication')).toBe(true)
  }, 180_000)

  it('publishes and reads a real annotation after accumulated file-backed history', async () => {
    const annotation = await writeSessionContextRevision({ sessionId: f.session.id, parentId: messageId, kind: 'message_annotation',
      content: { topicLabel: 'Fictional accumulated topic', topicConfidence: 0.9, replyToText: null }, authority: authority(),
      derivation: { producer: 'fixture:reference-annotation', sources } })
    expect(annotation).not.toBeNull()
    const read = await readSessionContextRevisions(f.session.id, 'message_annotation', authority(), { parentId: messageId })
    expect(read).toHaveLength(1);expect(read[0].content.topicLabel).toBe('Fictional accumulated topic')
    expect(await operation(f.pool, 'guards')).toMatchObject({ reference: true, deferred: true })
    await emptyQueue()
  }, 180_000)

  it('preserves original behavior for older outputs and a same-named noncanonical table', async () => frame(async client => {
    expect(await operation(client, 'snapshot', { ...field, derivationId })).toBeNull()
    await operation(client, 'trace')
    const before = (await operation(client, 'stats'))!
    for (const canonical of [false, true]) {
      expect(await outcome(client, () => reference(client, field, canonical))).toEqual(
        await baseline(client, () => outcome(client, () => reference(client, field, canonical))))
    }
    const after = (await operation(client, 'stats'))!
    expect(after.original).toBeGreaterThan(before.original)
    // Application fields are held through their canonical physical source,
    // not through the review API for native physical resource kinds.
    const held = (await operation(client, 'capture_extra')) as unknown as ScopeSource
    await operation(client, 'hold', files[0])
    expect(await operation(client, 'original', held)).toEqual({ held: true })
    expect(await outcome(client, () => reference(client, held))).toEqual({ value: 'accepted' })
    expect(await baseline(client, () => outcome(client, () => reference(client, held)))).toEqual({ value: 'accepted' })
  }), 90_000)

  it('uses the original reader for missing observations and stale unknown versions', async () => {
    await expect(publication(async (client, _id, target) => {
      const unobserved = (await operation(client, 'unobserved')) as unknown as ScopeSource
      for (const source of [unobserved, { ...field, resourceId: randomUUID() }, { ...field, version: 'fictional-stale-version' }]) {
        expect(await operation(client, 'snapshot', { ...source, derivationId: target })).toBeNull()
        expect(await outcome(client, () => reference(client, source, true, target))).toEqual(
          await baseline(client, () => outcome(client, () => reference(client, source, true, target))))
      }
      throw rollback
    })).rejects.toBe(rollback)
    await emptyQueue()
  }, 180_000)

  for (const change of ['hold', 'labels', 'permission']) for (const boundary of ['commit', 'named'])
    it(`prevents durable publication after ${change} at the ${boundary} boundary`, async () => {
      let attempted: string | undefined
      const result = await transactionOutcome(() => publication(async (client, id, target) => {
        attempted = id
        expect(await operation(client, 'snapshot', { ...field, derivationId: target })).not.toBeNull()
        await operation(client, change, files[0])
        if (boundary === 'named') await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
      }))
      expect(attempted).toBeDefined();expect(result).not.toEqual({ accepted: true })
      expect((await f.pool.query('SELECT 1 FROM session_messages WHERE id=$1', [attempted])).rows).toEqual([])
      await emptyQueue()
    }, 180_000)

  for (const change of ['hold', 'labels']) it(`checks an actual newly inserted stale field at the deferred boundary after ${change}`, async () => {
    let inserted = false
    const result = await transactionOutcome(() => publication(async (client, _id, target) => {
      const extra = (await operation(client, 'capture_extra')) as unknown as ScopeSource
      expect(await operation(client, 'edge_exists', { ...extra, derivationId: target })).toBe(false)
      await operation(client, change, files[0])
      expect(await operation(client, 'snapshot', { ...extra, derivationId: target })).not.toBeNull()
      const before = (await operation(client, 'queue'))!
      expect(await reference(client, extra, true, target)).toBe('accepted')
      expect(await operation(client, 'edge_exists', { ...extra, derivationId: target })).toBe(true)
      expect((await operation(client, 'queue'))!.work).toBe(before.work + 1)
      inserted = true
      await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
    }))
    expect(inserted).toBe(true)
    expect(result).toMatchObject({ message: 'scope_source_changed' })
    await emptyQueue()
  }, 180_000)

  it('allows a repaired intermediate state and ignored conflict without caching admission', async () => {
    const row = await publication(async (client, _id, target) => {
      await client.query('SAVEPOINT fictional_reference_repair')
      await operation(client, 'hold', files[0])
      const before = await operation(client, 'queue')
      // This identity can be structurally valid while its current inputs are
      // held. A no-op conflict writes nothing and cannot grant admission.
      expect(await reference(client, field, true, target)).toBe('accepted')
      expect(await operation(client, 'queue')).toEqual(before)
      await client.query('ROLLBACK TO SAVEPOINT fictional_reference_repair')
      await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
      expect(await operation(client, 'queue')).toEqual({ work: 0, headers: 0 })
    })
    await emptyQueue()
    const read = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: row.sequenceNum, authority: authority() })
    expect(read.history.some(message => message.id === row.id)).toBe(true)
  }, 180_000)

  it('rejects a new field reference whose actual transitive field declaration is missing', async () => {
    const latest = (await f.pool.query('SELECT max(sequence_num)::int AS sequence FROM session_messages WHERE session_id=$1', [f.session.id])).rows[0].sequence
    const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: latest, topicThroughSequence: 0, authority: authority() })
    let extra: ScopeSource | undefined
    await frame(async client => {
      for (const candidate of boundScopeSources(query).filter(source => source.resourceKind === 'application_field')) {
        if (sources.some(source => source.resourceId === candidate.resourceId)) continue
        const dependencies = await operation<ScopeSource[]>(client, 'dependencies', candidate)
        if (dependencies.some(dependency => dependency.resourceId !== candidate.resourceId
          && !sources.some(source => source.resourceId === dependency.resourceId && source.version === dependency.version))) { extra = candidate;break }
      }
    })
    expect(extra).toBeDefined()
    let inserted = false
    const result = await transactionOutcome(() => publication(async (client, _id, target) => {
      expect(await operation(client, 'snapshot', { ...extra!, derivationId: target })).not.toBeNull()
      expect(await operation(client, 'edge_exists', { ...extra!, derivationId: target })).toBe(false)
      expect(await reference(client, extra!, true, target)).toBe('accepted');inserted = true
      await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
    }))
    expect(inserted).toBe(true)
    expect(result).toMatchObject({ message: 'scope_evidence_missing' })
    await emptyQueue()
  }, 180_000)

  it('uses the original reference path if a parent-side cascade trigger changes', async () => {
    await expect(publication(async (client, _id, target) => {
      await operation(client, 'fk_drift');expect(await operation(client, 'guard')).toBe(false)
      await operation(client, 'trace')
      const before = (await operation(client, 'stats'))!
      const actual = await outcome(client, () => reference(client, field, true, target))
      const after = (await operation(client, 'stats'))!
      expect(after.shortcut).toBe(before.shortcut);expect(after.original).toBeGreaterThan(before.original)
      expect(actual).toEqual(await baseline(client, () => outcome(client, () => reference(client, field, true, target))))
      throw rollback
    })).rejects.toBe(rollback)
    await emptyQueue()
  }, 180_000)

  it('cannot leave an admitted publication after its physical output is deleted while work is pending', async () => {
    let attempted: string | undefined
    await transactionOutcome(() => publication(async (client, id) => {
      attempted = id;await operation(client, 'delete_output', { message: id })
      await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
    }))
    expect(attempted).toBeDefined()
    expect((await f.pool.query('SELECT 1 FROM session_messages WHERE id=$1', [attempted])).rows).toEqual([])
    await emptyQueue()
  }, 180_000)

  for (const [signature, mode] of [[snapshot, 'body'], [snapshot, 'acl'], ['application_current_field_snapshot(uuid,uuid)', 'cost'],
    ['recording_source_read_allowed(uuid,text,uuid)', 'cost']] as const)
    it(`falls back after ${signature} ${mode} changes during publication`, async () => {
      await expect(publication(async (client, _id, target) => {
        await operation(client, 'drift', { signature, mode })
        expect(await operation(client, 'guard')).toBe(false)
        const actual = await outcome(client, () => reference(client, field, true, target))
        expect(actual).toEqual(await baseline(client, () => outcome(client, () => reference(client, field, true, target))))
        await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
        expect(await operation(client, 'queue')).toEqual({ work: 0, headers: 0 })
        throw rollback
      })).rejects.toBe(rollback)
      await emptyQueue()
    }, 180_000)

  it('leaves non-field references, review reads and derivation-envelope checks unchanged', async () => frame(async client => {
    await operation(client, 'trace')
    const before = (await operation(client, 'stats'))!
    for (const action of ['reference', 'review', 'derivation']) {
      const payload = { ...files[0], derivationId, sensitivity: action === 'derivation' ? 'confidential' : 'internal' }
      const actual = await outcome(client, () => operation(client, action, payload))
      expect(actual).toEqual(await baseline(client, () => outcome(client, () => operation(client, action, payload))))
      if (action === 'derivation') expect(actual).toMatchObject({ message: 'scope_envelope_mismatch' })
      else expect(actual).toEqual({ value: 'accepted' })
    }
    expect((await operation(client, 'stats'))!.shortcut).toBe(before.shortcut)
  }))

  it('keeps new helpers private and uses original behavior for an owner SQL role', async () => {
    await frame(async client => {
      for (const signature of [snapshot, guard]) expect((await client.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed).toBe(false)
    })
    await frame(async client => {
      expect(await operation(client, 'snapshot', { ...field, derivationId })).toBeNull()
      expect(await outcome(client, () => reference(client))).toEqual(await baseline(client, () => outcome(client, () => reference(client))))
    }, true)
  })
})
