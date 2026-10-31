import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { boundScopeSources, ContextScopeAccumulator, type ScopeSource } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { listWorkspaceFilesIndexRanked } from '../../db/workspace-files.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { withSessionMessagePublication } from '../../db/session-context-revisions.js'
import { publishNativeSessionMessage } from '../../db/session-message-publication.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const wrapper = `deferred_work_fixture_${randomUUID().replaceAll('-', '')}`
const rollback = new Error('Fictional transaction rollback')
const constraint = 'application_field_derivation_dependencies'
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let files: ScopeSource[]
let sources: ScopeSource[]
type State = { headers: number; work: number; pending: number; queued: number; fallback: boolean; fired: number; processed: number; batches: number; originalFields: number }

async function authority() {
  const unbounded = await f.execution(), maximumAccess = { ...unbounded.security.ceiling, clearance: f.envelope.sensitivity,
    compartments: f.envelope.compartments, mutationCompartments: [], projectIds: f.envelope.projectIds }
  const execution = (await resolveExecutionContextSystem({ userId: f.ownerId, workspaceId: f.workspaceId,
    assistant: (await findAssistantById(f.assistantId))!, memberMode: 'member', sharedAudience: true,
    session: f.session, sessionAuthority: f.session, identity: unbounded.identity, ownership: unbounded.ownership,
    lifecycle: unbounded.lifecycle, maximumAccess, maximumAccessCurrent: async () => maximumAccess })).executionContext
  return { execution, accumulator: new ContextScopeAccumulator() }
}
async function operation<T = unknown>(client: Pick<PoolClient, 'query'>, action: string, payload: unknown = {}): Promise<T> {
  return (await client.query<{ value: T }>(`SELECT public.${wrapper}($1,$2,$3) AS value`, [f.workspaceId, action, payload])).rows[0].value
}
const state = (client: Pick<PoolClient, 'query'>) => operation<State>(client, 'state')
async function emptyQueue() {
  expect(await state(f.pool)).toMatchObject({ headers: 0, work: 0, pending: 0, fired: 0, processed: 0 })
}
async function publish(run: (client: PoolClient, id: string) => Promise<void>, before?: (client: PoolClient) => Promise<void>) {
  const current = await authority()
  return withSessionMessagePublication(current, sources, async client => {
    await before?.(client)
    const row = await publishNativeSessionMessage({ sessionId: f.session.id, role: 'assistant',
      content: 'Fictional deferred publication', senderAssistantId: f.assistantId, authority: current,
      derivationTarget: f.envelope, derivation: { producer: 'fixture:deferred-work', sources } }, client)
    await run(client, row.id)
    return row
  })
}
async function rolledBack(run: (client: PoolClient, id: string) => Promise<void>) {
  await expect(publish(async (client, id) => { await run(client, id); throw rollback })).rejects.toBe(rollback)
  await emptyQueue()
}
async function outcome(run: () => Promise<unknown>) {
  try { await run(); return { success: true } }
  catch (error) {
    if (error === rollback) return { success: true }
    const value = error as { code?: string; message: string; cause?: { code?: string; message?: string } }
    return { code: value.cause?.code ?? value.code, message: value.cause?.message ?? value.message }
  }
}

describe.sequential('[COMP:api/application-persistence] deferred native field work', () => {
  beforeAll(async () => {
    f = await persistentContextFixture()
    await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
      SELECT $1,'/fictional/deferred-'||n||'.txt','Fictional deferred file '||n,'fixture://deferred-'||n,$2,'user','internal'
      FROM generate_series(1,50) n`, [f.workspaceId, f.ownerId])
    await f.history()
    files = (await listWorkspaceFilesIndexRanked((await authority()).execution.security.access, 50)).flatMap(file => boundScopeSources(file))
    expect(files).toHaveLength(50)
    let through = 3
    for (let turn = 0; turn < 2; turn++) {
      const current = await authority()
      const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, authority: current })
      const memory = await createDbMemoryStore().getIndex(current.execution.security.access, false, current)
      expect(memory).toHaveLength(0)
      const inputs = new ContextScopeAccumulator({ sources: [...boundScopeSources(query), ...boundScopeSources(memory), ...files] }).evidence.sources!
      const row = await publishNativeSessionMessage({ sessionId: f.session.id, role: 'assistant',
        content: `Fictional retained file turn ${turn + 1}`, senderAssistantId: f.assistantId, authority: current,
        derivationTarget: f.envelope, derivation: { producer: 'fixture:deferred-setup', sources: inputs } })
      through = row.sequenceNum
    }
    const current = await authority()
    const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, authority: current })
    const memory = await createDbMemoryStore().getIndex(current.execution.security.access, false, current)
    sources = new ContextScopeAccumulator({ sources: [...boundScopeSources(query), ...boundScopeSources(memory), ...files] }).evidence.sources!
    expect(sources.filter(source => source.resourceKind === 'application_field').length).toBeGreaterThan(2)
    // A separate relation schedules a real catalog/source change between two
    // groups of dependency events without modifying their guarded inventory.
    await f.pool.query(`CREATE TABLE public.${wrapper}_barrier(workspace_id uuid NOT NULL);
      REVOKE ALL ON public.${wrapper}_barrier FROM PUBLIC,app_user;
      CREATE FUNCTION public.${wrapper}_barrier() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $barrier$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM native_field_dependency_work WHERE workspace_id=NEW.workspace_id AND fired AND NOT processed)
          OR NOT EXISTS(SELECT 1 FROM native_field_dependency_batches WHERE workspace_id=NEW.workspace_id AND pending_events>0)
          THEN RAISE EXCEPTION 'Fixture did not reach pending fired work';END IF;
        INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
          VALUES(NEW.workspace_id,'workspace_file','${files[0].resourceId}'::uuid,'${files[0].version}','held',1,'Fictional interleaved source hold');
        ALTER FUNCTION public.validate_native_field_dependency_batch(uuid,uuid,jsonb) COST 101;
        RETURN NEW;
      END $barrier$;
      REVOKE ALL ON FUNCTION public.${wrapper}_barrier() FROM PUBLIC,app_user;
      CREATE CONSTRAINT TRIGGER ${wrapper}_barrier AFTER INSERT ON public.${wrapper}_barrier
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.${wrapper}_barrier()`)
    await f.pool.query(`CREATE FUNCTION public.${wrapper}(w uuid,action text,payload jsonb) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE d uuid;selected scope_derivation_sources;definition text;body text;output_id uuid;event_count integer;
      BEGIN
        IF action='state' THEN RETURN jsonb_build_object(
          'headers',(SELECT count(*) FROM native_field_dependency_batches WHERE workspace_id=w),
          'work',(SELECT count(*) FROM native_field_dependency_work WHERE workspace_id=w),
          'pending',coalesce((SELECT sum(pending_events) FROM native_field_dependency_batches WHERE workspace_id=w),0),
          'queued',coalesce((SELECT sum(queued_events) FROM native_field_dependency_batches WHERE workspace_id=w),0),
          'fallback',coalesce((SELECT bool_or(fallback) FROM native_field_dependency_batches WHERE workspace_id=w),false),
          'fired',(SELECT count(*) FROM native_field_dependency_work WHERE workspace_id=w AND fired),
          'processed',(SELECT count(*) FROM native_field_dependency_work WHERE workspace_id=w AND processed),
          'batches',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='validate_native_field_dependency_batch(uuid,uuid,jsonb)'::regprocedure),0),
          'originalFields',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='application_current_field_snapshot(uuid,uuid)'::regprocedure),0));
        ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);RETURN '{}'::jsonb;
        ELSIF action='guard' THEN RETURN to_jsonb(application_native_dependency_batch_helpers_current());
        ELSIF action='barrier' THEN INSERT INTO public.${wrapper}_barrier VALUES(w);RETURN '{}'::jsonb;
        ELSIF action='disable' THEN
          SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid='application_native_dependency_batch_helpers_current()'::regprocedure;
          EXECUTE replace(definition,body,'BEGIN RETURN false;END');RETURN '{}'::jsonb;
        ELSIF action='hold' THEN
          INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
            VALUES(w,'workspace_file',(payload->>'id')::uuid,payload->>'version','held',1,'Fictional pending source hold');RETURN '{}'::jsonb;
        ELSIF action='labels' THEN UPDATE workspace_files SET sensitivity='confidential' WHERE workspace_id=w AND id=(payload->>'id')::uuid;RETURN '{}'::jsonb;
        ELSIF action='drift' THEN ALTER FUNCTION public.validate_native_field_dependency_batch(uuid,uuid,jsonb) COST 101;RETURN '{}'::jsonb;
        ELSIF action='dependency_reader_drift' THEN ALTER FUNCTION public.read_application_field_dependencies(uuid,text[],uuid[],text[]) COST 101;RETURN '{}'::jsonb;
        ELSIF action='default_drift' THEN ALTER TABLE public.native_field_dependency_work ALTER COLUMN processed SET DEFAULT true;RETURN '{}'::jsonb;
        ELSIF action='column_acl_drift' THEN GRANT SELECT(source) ON public.native_field_dependency_work TO app_user;RETURN '{}'::jsonb;
        ELSIF action='policy_drift' THEN CREATE POLICY fictional_work_policy ON public.native_field_dependency_work FOR SELECT TO app_user USING(true);RETURN '{}'::jsonb;
        ELSIF action='rule_drift' THEN CREATE RULE fictional_work_rule AS ON INSERT TO public.native_field_dependency_work DO INSTEAD NOTHING;RETURN '{}'::jsonb;
        END IF;
        SELECT id INTO d FROM scope_derivations WHERE workspace_id=w AND resource_kind='session_message' AND resource_id=(payload->>'message')::uuid;
        IF d IS NULL THEN RAISE EXCEPTION 'Missing fictional derivation';END IF;
        IF action='qualifies' THEN RETURN to_jsonb(validate_native_field_dependency_batch(w,d,
          (SELECT jsonb_agg(source ORDER BY id) FROM native_field_dependency_work WHERE workspace_id=w AND derivation_id=d)));
        ELSIF action='queued' THEN RETURN (SELECT jsonb_agg(source ORDER BY id) FROM native_field_dependency_work WHERE workspace_id=w AND derivation_id=d);
        ELSIF action='edges' THEN RETURN (SELECT jsonb_agg(to_jsonb(edge) ORDER BY source_kind,source_id) FROM scope_derivation_sources edge WHERE workspace_id=w AND derivation_id=d);
        END IF;
        SELECT * INTO selected FROM scope_derivation_sources WHERE workspace_id=w AND derivation_id=d
          AND source_kind=coalesce(payload->>'kind','application_field') ORDER BY source_id LIMIT 1;
        IF selected.derivation_id IS NULL THEN RAISE EXCEPTION 'Missing fictional source edge';END IF;
        IF action='fill_limit' THEN
          SELECT pending_events INTO event_count FROM native_field_dependency_batches WHERE workspace_id=w AND derivation_id=d;
          IF event_count IS NULL OR event_count>=100 THEN RAISE EXCEPTION 'Unexpected fictional initial event count';END IF;
          FOR event_count IN event_count..99 LOOP
            UPDATE scope_derivation_sources SET source_version=source_version WHERE derivation_id=d AND source_kind=selected.source_kind AND source_id=selected.source_id;
          END LOOP;
        ELSIF action='repeat' THEN
          UPDATE scope_derivation_sources SET source_version=source_version WHERE derivation_id=d AND source_kind=selected.source_kind AND source_id=selected.source_id;
          UPDATE scope_derivation_sources SET source_version=source_version WHERE derivation_id=d AND source_kind=selected.source_kind AND source_id=selected.source_id;
        ELSIF action='ignored' THEN INSERT INTO scope_derivation_sources SELECT (selected).* ON CONFLICT DO NOTHING;
        ELSIF action='upsert' THEN INSERT INTO scope_derivation_sources SELECT (selected).*
          ON CONFLICT (derivation_id,source_kind,source_id) DO UPDATE SET source_version=excluded.source_version;
        ELSIF action='replace' THEN
          DELETE FROM scope_derivation_sources WHERE derivation_id=d AND source_kind=selected.source_kind AND source_id=selected.source_id;
          INSERT INTO scope_derivation_sources SELECT (selected).*;
        ELSIF action='delete' THEN DELETE FROM scope_derivation_sources WHERE derivation_id=d AND source_kind=selected.source_kind AND source_id=selected.source_id;
        ELSIF action='stale_then_restore' THEN
          UPDATE scope_derivation_sources SET source_version='fictional-stale-source-version' WHERE derivation_id=d AND source_kind=selected.source_kind AND source_id=selected.source_id;
          UPDATE scope_derivation_sources SET source_version=selected.source_version WHERE derivation_id=d AND source_kind=selected.source_kind AND source_id=selected.source_id;
        ELSE RAISE EXCEPTION 'Unknown fictional operation';END IF;
        RETURN to_jsonb(selected);
      END $fixture$;
      REVOKE ALL ON FUNCTION public.${wrapper}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.${wrapper}(uuid,text,jsonb) TO app_user`)
    await emptyQueue()
  }, 180_000)
  afterAll(async () => {
    try {
      await getPool().query(`DROP FUNCTION IF EXISTS public.${wrapper}(uuid,text,jsonb);
        DROP TABLE IF EXISTS public.${wrapper}_barrier;
        DROP FUNCTION IF EXISTS public.${wrapper}_barrier()`)
      await f?.cleanup()
    }
    finally { await getAppPool().end(); await getPool().end() }
  })

  it('commits an actual publication only after draining queued work and leaves no transaction work', async () => {
    const row = await publish(async (client, id) => {
      expect(await operation(client, 'guard')).toBe(true)
      const pending = await state(client)
      expect(pending.headers).toBe(1);expect(pending.work).toBeGreaterThan(2)
      expect(pending.pending).toBe(pending.work);expect(pending.fired).toBe(0)
      const queued = await operation<unknown[]>(client, 'queued', { message: id })
      const edges = await operation<unknown[]>(client, 'edges', { message: id })
      const keys = (values: unknown[]) => values.map(value => JSON.stringify(value)).sort()
      expect(keys(queued)).toEqual(keys(edges))
    })
    await emptyQueue()
    const read = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: row.sequenceNum, authority: await authority() })
    expect(read.history.some(message => message.id === row.id && message.content === 'Fictional deferred publication')).toBe(true)
  }, 90_000)

  it('uses one fresh batch at the unchanged named constraint boundary', async () => rolledBack(async (client, id) => {
    expect(await operation(client, 'qualifies', { message: id })).toBe(true)
    await operation(client, 'trace')
    const before = await state(client)
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    const after = await state(client)
    expect(after).toMatchObject({ headers: 0, work: 0, pending: 0, fired: 0, processed: 0 })
    expect(after.batches - before.batches).toBe(1)
    expect(after.originalFields).toBe(before.originalFields)
  }), 90_000)

  it('keeps the original named constraint active when enqueue is ineligible', async () => {
    await expect(publish(async client => {
      expect(await state(client)).toMatchObject({ headers: 0, work: 0 })
      await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
      throw rollback
    }, async client => { await operation(client, 'disable');expect(await operation(client, 'guard')).toBe(false) })).rejects.toBe(rollback)
    await emptyQueue()
  }, 90_000)

  it('retains original per-field checks for a genuine no-file cohort', async () => {
    const current = await authority()
    const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: 3, authority: current })
    const memory = await createDbMemoryStore().getIndex(current.execution.security.access, false, current)
    const inputs = new ContextScopeAccumulator({ sources: [...boundScopeSources(query), ...boundScopeSources(memory)] }).evidence.sources!
    await expect(withSessionMessagePublication(current, inputs, async client => {
      const row = await publishNativeSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional no-file publication',
        authority: current, derivationTarget: f.envelope, derivation: { producer: 'fixture:no-file-deferred', sources: inputs } }, client)
      expect((await state(client)).work).toBeGreaterThan(0)
      expect(await operation(client, 'qualifies', { message: row.id })).toBe(false)
      await operation(client, 'trace')
      const before = await state(client)
      await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
      const after = await state(client)
      expect(after).toMatchObject({ headers: 0, work: 0, pending: 0 })
      expect(after.originalFields).toBeGreaterThan(before.originalFields)
      throw rollback
    })).rejects.toBe(rollback)
    await emptyQueue()
  }, 90_000)

  it('preserves immediate and deferred mode transitions for later source updates', async () => rolledBack(async (client, id) => {
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    await operation(client, 'repeat', { message: id })
    expect(await state(client)).toMatchObject({ headers: 0, work: 0, pending: 0 })
    await client.query(`SET CONSTRAINTS ${constraint} DEFERRED`)
    await operation(client, 'repeat', { message: id })
    expect(await state(client)).toMatchObject({ headers: 1, work: 2, pending: 2, fired: 0, processed: 0 })
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    expect(await state(client)).toMatchObject({ headers: 0, work: 0, pending: 0 })
  }), 90_000)

  it.each(['repeat', 'ignored', 'upsert'] as const)('preserves %s event semantics without phantom or collapsed work', async action => rolledBack(async (client, id) => {
    const before = await state(client)
    const changed = await operation(client, action, { message: id })
    const pending = await state(client)
    const newEvents = action === 'repeat' ? 2 : action === 'upsert' ? 1 : 0
    expect(pending.work - before.work).toBe(newEvents)
    expect(pending.pending).toBe(pending.work)
    const queued = await operation<unknown[]>(client, 'queued', { message: id })
    expect(queued.filter(row => JSON.stringify(row) === JSON.stringify(changed))).toHaveLength(1 + newEvents)
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    expect(await state(client)).toMatchObject({ headers: 0, work: 0, pending: 0 })
  }), 90_000)

  it('restores pending scheduling state after a savepoint rollback', async () => rolledBack(async (client, id) => {
    const before = await state(client)
    await client.query('SAVEPOINT fictional_work')
    await operation(client, 'repeat', { message: id })
    expect((await state(client)).work).toBe(before.work + 2)
    await client.query('ROLLBACK TO SAVEPOINT fictional_work')
    expect(await state(client)).toEqual(before)
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    expect(await state(client)).toMatchObject({ headers: 0, work: 0, pending: 0 })
  }), 90_000)

  it('bounds duplicate event batches and keeps original checks after the 101st event', async () => rolledBack(async (client, id) => {
    expect(await operation(client, 'guard')).toBe(true)
    await operation(client, 'fill_limit', { message: id, kind: 'workspace_file' })
    expect(await state(client)).toMatchObject({ headers: 1, work: 100, pending: 100, queued: 100, fallback: false })
    await operation(client, 'upsert', { message: id, kind: 'workspace_file' })
    expect(await state(client)).toMatchObject({ headers: 1, work: 101, pending: 101, queued: 101, fallback: true })
    await operation(client, 'trace')
    const before = await state(client)
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    const after = await state(client)
    expect(after).toMatchObject({ headers: 0, work: 0, pending: 0, queued: 0, batches: before.batches })
    expect(after.originalFields).toBeGreaterThan(before.originalFields)
  }), 180_000)

  for (const change of ['hold', 'labels', 'delete', 'replace', 'stale_then_restore'] as const) it(`matches the original result after ${change} while work is pending`, async () => {
    const attempt = (original: boolean) => outcome(() => publish(async (client, id) => {
      if (!original) expect((await state(client)).work).toBeGreaterThan(0)
      else expect(await state(client)).toMatchObject({ headers: 0, work: 0 })
      await operation(client, change, { message: id, id: files[0].resourceId, version: files[0].version })
      await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
      throw rollback
    }, original ? async client => { await operation(client, 'disable');expect(await operation(client, 'guard')).toBe(false) } : undefined))
    const actual = await attempt(false), expected = await attempt(true)
    expect(actual).toEqual(expected)
    if (change !== 'stale_then_restore') expect(actual).not.toEqual({ success: true })
    // Canonical application-field lineage is immutable: scheduling cannot
    // make deleting or replacing its original source declarations legal.
    if (change === 'delete' || change === 'replace') expect(actual).toMatchObject({ message: 'scope_evidence_immutable' })
    await emptyQueue()
  }, 90_000)

  for (const change of ['drift', 'dependency_reader_drift']) it(`replays original validation after ${change} and clears the queued metadata`, async () => rolledBack(async client => {
    expect((await state(client)).work).toBeGreaterThan(0)
    await operation(client, 'trace');await operation(client, change)
    expect(await operation(client, 'guard')).toBe(false)
    const before = await state(client)
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`)
    expect(await state(client)).toMatchObject({ headers: 0, work: 0, pending: 0, batches: before.batches })
  }), 90_000)

  it('replays already fired work when source and helper metadata change before the last commit event', async () => {
    const before = (await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1', [f.session.id])).rows[0].count
    const actual = await outcome(() => publish(async (client, id) => {
      expect(await operation(client, 'guard')).toBe(true)
      expect((await state(client)).work).toBeGreaterThan(2)
      await operation(client, 'barrier')
      // A raw file edge has no application-field dependencies on its own.
      // Previously fired field events must be replayed after the barrier.
      await operation(client, 'repeat', { message: id, kind: 'workspace_file' })
    }))
    expect(actual).toMatchObject({ message: 'scope_source_changed' })
    expect((await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1', [f.session.id])).rows[0].count).toBe(before)
    expect(await operation(f.pool, 'guard')).toBe(true)
    expect((await f.pool.query('SELECT 1 FROM scope_resource_states WHERE workspace_id=$1 AND resource_id=$2', [f.workspaceId, files[0].resourceId])).rows).toEqual([])
    await emptyQueue()
  }, 90_000)

  for (const change of ['default_drift', 'column_acl_drift', 'policy_drift', 'rule_drift']) it(`refuses changed queue ${change} before enqueue and preserves original denial`, async () => {
    const actual = await outcome(() => publish(async client => {
      expect(await state(client)).toMatchObject({ headers: 0, work: 0 })
      await operation(client, 'hold', { id: files[0].resourceId, version: files[0].version })
    }, async client => {
      await operation(client, change)
      expect(await operation(client, 'guard')).toBe(false)
    }))
    expect(actual).toMatchObject({ message: 'scope_source_changed' })
    expect(await operation(f.pool, 'guard')).toBe(true)
    await emptyQueue()
  }, 90_000)

  it('keeps scheduling tables and helpers inaccessible to the application role', async () => {
    const current = await authority(), client = await getAppPool().connect()
    try { await runWithAgentAccess(current.execution.security.access, async () => {
      await client.query('BEGIN');await applyRLSGucs(client, f.ownerId)
      for (const table of ['native_field_dependency_batches', 'native_field_dependency_work']) {
        const result = (await client.query(`SELECT has_table_privilege(current_user,$1,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed,
          (SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass) AS rls`, [table])).rows[0]
        expect(result).toEqual({ allowed: false, rls: true })
      }
      for (const signature of ['enqueue_native_field_dependency_work()', 'validate_native_field_dependency_batch(uuid,uuid,jsonb)', 'application_native_dependency_batch_helpers_current()']) {
        expect((await client.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed).toBe(false)
      }
      const sequence = (await client.query("SELECT pg_get_serial_sequence('public.native_field_dependency_work','id') AS name")).rows[0].name
      expect(sequence).toBeTruthy()
      expect((await client.query("SELECT has_sequence_privilege(current_user,$1,'USAGE,SELECT,UPDATE') AS allowed", [sequence])).rows[0].allowed).toBe(false)
    }) } finally { await rollbackAndRelease(client) }
  })
})
