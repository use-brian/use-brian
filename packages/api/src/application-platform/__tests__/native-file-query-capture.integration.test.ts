import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { boundScopeSources, ContextScopeAccumulator, type ExecutionContext, type ScopeSource } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createMemory } from '../../db/memories.js'
import { listWorkspaceFilesIndexRanked } from '../../db/workspace-files.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { withSessionMessagePublication } from '../../db/session-context-revisions.js'
import { publishNativeSessionMessage } from '../../db/session-message-publication.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { createDbSavedViewStore } from '../../db/saved-views-store.js'
import { pinPreparedExternalSourceAuthority } from '../retained-source-authority.js'
import { sourceModeFixture } from './fixtures/source-modes.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
type Json = Record<string, any>
const wrapper = `file_capture_fixture_${randomUUID().replaceAll('-', '')}`
const frameSignature = 'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'
const currentSignature = 'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'
const snapshotsSignature = 'read_native_file_session_field_snapshots(uuid,uuid[],text[])'
const guardSignature = 'application_native_file_capture_helpers_current()'
let modes: Awaited<ReturnType<typeof sourceModeFixture>>
let execution: ExecutionContext
let files: ScopeSource[]
let roots: { kinds: string[]; ids: string[]; versions: string[] }
let pageSource: ScopeSource
let externalSource: ScopeSource
let through: number
let replyIds: string[]

async function operation(client: PoolClient, action: string, payload: unknown = {}) {
  return (await client.query<{ value: Json | null }>(`SELECT ${wrapper}($1,$2,$3) AS value`, [modes.f.workspaceId, action, payload])).rows[0].value
}
async function frame<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await getAppPool().connect()
  try {
    return await runWithAgentAccess(execution.security.access, async () => {
      await client.query('BEGIN')
      await applyRLSGucs(client, execution.security.access.userId)
      await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [execution.assistant.id])
      return await run(client)
    })
  } finally { await rollbackAndRelease(client) }
}
async function baseline<T>(client: PoolClient, read: () => Promise<T>) {
  await client.query('SAVEPOINT original_capture')
  try { await operation(client, 'disable'); expect(await operation(client, 'guard')).toBe(false); return await read() }
  finally { await client.query('ROLLBACK TO SAVEPOINT original_capture') }
}
async function outcome<T>(client: PoolClient, read: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  await client.query('SAVEPOINT read_outcome')
  try { return { value: await read() } }
  catch (error) { const e = error as { code?: string; message: string }; return { error: e.code ?? e.message } }
  finally { await client.query('ROLLBACK TO SAVEPOINT read_outcome') }
}
async function history(client: PoolClient) {
  return (await client.query('SELECT value FROM read_native_application_session_history($1,$2,$3)', [modes.f.workspaceId, modes.f.session.id, through])).rows
}
const capture = (client: PoolClient) => operation(client, 'capture', { session: modes.f.session.id, through })

describe.sequential('[COMP:api/application-persistence] private file query capture', () => {
  beforeAll(async () => {
    modes = await sourceModeFixture('confidential')
    const f = modes.f
    const remote = await modes.runtime()
    await remote.runtime.call('readRecord', { id: 'record-1', fields: ['description'] })
    externalSource = remote.accumulator.evidence.sources!.find(source => source.resourceKind === 'external_source')!
    expect(externalSource).toBeDefined()
    const space = randomUUID()
    await f.pool.query("INSERT INTO teamspaces(id,workspace_id,name,created_by) VALUES($1,$2,'Fictional capture space',$3)", [space, f.workspaceId, f.ownerId])
    await f.pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)', [space, f.ownerId])
    const page = await createDbSavedViewStore().createDraft({ userId: f.ownerId, workspaceId: f.workspaceId,
      name: 'Fictional capture Page', entity: 'tasks', viewType: 'table', binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] }, teamspaceId: space, state: 'saved' }, { provenance: { kind: 'human-authored', actorId: f.ownerId } })
    pageSource = (await f.pool.query(`SELECT read_page_event_authority($1,page_event_revision,$3) AS authority FROM saved_views WHERE id=$2`,
      [f.workspaceId, page.id, f.ownerId])).rows[0].authority.boundaries.find((entry: { role: string }) => entry.role === 'changed').savedSource
    await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
      SELECT $1,'/fictional/capture-'||n||'.txt','Fictional capture file '||n,'fixture://capture-'||n,$2,'user','confidential' FROM generate_series(1,50) n`, [f.workspaceId, f.ownerId])
    const unbounded = await f.execution(), maximumAccess = { ...unbounded.security.ceiling, clearance: f.envelope.sensitivity,
      compartments: f.envelope.compartments, mutationCompartments: [], projectIds: f.envelope.projectIds }
    execution = (await resolveExecutionContextSystem({ userId: f.ownerId, workspaceId: f.workspaceId, assistant: (await findAssistantById(f.assistantId))!,
      memberMode: 'member', sharedAudience: true, session: f.session, sessionAuthority: f.session, identity: unbounded.identity,
      ownership: unbounded.ownership, lifecycle: unbounded.lifecycle, maximumAccess, maximumAccessCurrent: async () => maximumAccess })).executionContext
    const initial = await f.history()
    through = initial.at(-1)!.sequenceNum
    files = (await listWorkspaceFilesIndexRanked(execution.security.access, 50)).flatMap(file => boundScopeSources(file))
    expect(files).toHaveLength(50)
    replyIds = []
    for (let turn = 0; turn < 2; turn++) {
      const authority = { execution, accumulator: new ContextScopeAccumulator() }
      const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, authority })
      const memory = await createDbMemoryStore().getIndex(execution.security.access, false, authority)
      expect(memory).toHaveLength(0)
      const sources = new ContextScopeAccumulator({ sources: [...boundScopeSources(query), ...boundScopeSources(memory), ...files] }).evidence.sources!
      const row = await withSessionMessagePublication(authority, sources, client => publishNativeSessionMessage({ sessionId: f.session.id,
        role: 'assistant', content: [{ type: 'text', text: `Fictional file-backed reply ${turn + 1}` }], senderAssistantId: f.assistantId,
        authority, derivationTarget: f.envelope, derivation: { producer: 'fixture:file-capture', sources } }, client))
      through = row.sequenceNum; replyIds.push(row.id)
    }
    const messages = (await f.pool.query<{ id: string; version: string }>('SELECT id,scope_version::text AS version FROM session_messages WHERE session_id=$1 ORDER BY sequence_num', [f.session.id])).rows
    roots = { kinds: messages.map(() => 'session_message'), ids: messages.map(row => row.id), versions: messages.map(row => row.version) }
    await f.pool.query(`CREATE FUNCTION ${wrapper}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE kinds text[];ids uuid[];versions text[];source jsonb;output jsonb;derivation uuid;definition text;body text;signature text;
      BEGIN
        kinds:=ARRAY(SELECT jsonb_array_elements_text(payload->'kinds'));
        ids:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(payload->'ids') value);
        versions:=ARRAY(SELECT jsonb_array_elements_text(payload->'versions'));
        IF action='guard' THEN RETURN to_jsonb(application_native_file_capture_helpers_current());
        ELSIF action='frame' THEN RETURN read_native_file_session_cohort_frame(w,kinds,ids,versions,true);
        ELSIF action='current' THEN RETURN to_jsonb(application_native_file_frame_current(w,kinds,ids,versions,payload->'frame'));
        ELSIF action='capture' THEN RETURN capture_native_session_projection_batch(w,(payload->>'session')::uuid,(payload->>'through')::integer,'session_message');
        ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);
        ELSIF action='stats' THEN
          RETURN jsonb_build_object('frames',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure),0),
            'checks',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure),0),
            'snapshots',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='read_native_file_session_field_snapshots(uuid,uuid[],text[])'::regprocedure),0));
        ELSIF action='disable' THEN
          EXECUTE 'CREATE OR REPLACE FUNCTION public.application_native_file_capture_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''BEGIN RETURN false;END''';
        ELSIF action='hold' THEN
          INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
            VALUES(w,'workspace_file',(payload->>'id')::uuid,payload->>'version','held',1,'Fictional capture hold');
        ELSIF action='labels' THEN UPDATE workspace_files SET sensitivity='internal' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
        ELSIF action='predecessor' THEN
          INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity,superseded_by)
            VALUES(w,'/fictional/new-predecessor','Fictional predecessor','fixture://predecessor',current_setting('app.current_user_id')::uuid,'user','confidential',(payload->>'id')::uuid);
        ELSIF action='derive' THEN
          source:=payload->'source';output:=payload->'output';
          IF source->>'resourceKind'='external_source' AND external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed';END IF;
          INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
            SELECT w,'workspace_file',(output->>'resourceId')::uuid,output->>'version','fixture:new-file-ancestry',NULL,NULL,output->>'sensitivity',
              ARRAY(SELECT jsonb_array_elements_text(output->'compartments')),ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(output->'projectIds') value),revision
              FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
          INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
            SELECT DISTINCT w,derivation,item->>'resourceKind',(item->>'resourceId')::uuid,item->>'version'
            FROM jsonb_array_elements(jsonb_build_array(source)||CASE WHEN source->>'resourceKind' LIKE 'page_%'
              THEN coalesce(read_page_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid)->'requiredSources','[]'::jsonb)
              ELSE '[]'::jsonb END) item;
          SET CONSTRAINTS ALL IMMEDIATE;
          SET CONSTRAINTS ALL DEFERRED;
        ELSIF action='drift_body' THEN
          EXECUTE 'CREATE OR REPLACE FUNCTION public.application_native_file_frame_current(w uuid,kinds text[],ids uuid[],versions text[],frame jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''BEGIN RETURN true;END''';
        ELSIF action='drift_acl' THEN GRANT EXECUTE ON FUNCTION application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb) TO app_user;
        ELSIF action IN('drift_frame','drift_snapshots','drift_original_guard') THEN
          signature:=CASE WHEN action='drift_frame' THEN 'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'
            WHEN action='drift_original_guard' THEN 'application_memory_statement_helpers_current()'
            ELSE 'read_native_file_session_field_snapshots(uuid,uuid[],text[])' END;
          SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid=signature::regprocedure;
          EXECUTE replace(definition,body,CASE WHEN action='drift_original_guard' THEN 'BEGIN RETURN true;END'
            ELSE 'BEGIN RAISE EXCEPTION ''Unsafe fixture helper invoked'';END' END);
        ELSE RAISE EXCEPTION 'Unknown fixture operation';END IF;
        RETURN '{}'::jsonb;
      END $fixture$;
      REVOKE ALL ON FUNCTION ${wrapper}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${wrapper}(uuid,text,jsonb) TO app_user`)
  }, 120_000)
  afterAll(async () => {
    try { await getPool().query(`DROP FUNCTION IF EXISTS ${wrapper}(uuid,text,jsonb)`); await modes?.cleanup() }
    finally { await getAppPool().end(); await getPool().end() }
  })

  it('preserves full history and query capture for two committed file-backed turns', async () => {
    await frame(async client => {
      expect(await operation(client, 'guard')).toBe(true)
      const candidate = await operation(client, 'frame', roots)
      expect(candidate).toMatchObject({ admitted: true })
      expect(candidate!.memo.memoryStatement.workspaceId).toBe(modes.f.workspaceId)
      expect(await operation(client, 'current', { ...roots, frame: candidate })).toBe(true)
      const rows = await history(client)
      expect(rows).toEqual(await baseline(client, () => history(client)))
      await operation(client, 'trace')
      const before = await operation(client, 'stats')
      const result = await capture(client)
      expect(result).not.toBeNull()
      const after = await operation(client, 'stats')
      expect(after!.frames - before!.frames).toBe(2)
      expect(after!.checks).toBe(before!.checks)
      expect(after!.snapshots).toBe(before!.snapshots)
      expect(result).toEqual(await baseline(client, () => capture(client)))
    })
    const query = await readAdmittedSessionQuery({ sessionId: modes.f.session.id, throughSequence: through,
      authority: { execution, accumulator: new ContextScopeAccumulator() } })
    for (const id of replyIds) expect(query.history.some(row => row.id === id)).toBe(true)
  }, 90_000)

  for (const change of ['hold', 'labels', 'predecessor', 'Page', 'external'] as const) it(`discards a file frame after new ${change} evidence and retains original read behavior`, async () => {
    await frame(async client => {
      const prepared = change === 'external' ? await modes.coordinator.prepare(execution, [externalSource], 'retain') : undefined
      const candidate = await operation(client, 'frame', roots)
      expect(candidate).toMatchObject({ admitted: true })
      if (prepared) await pinPreparedExternalSourceAuthority(client, execution, prepared)
      if (change === 'Page' || change === 'external') await operation(client, 'derive', { output: files[0], source: change === 'Page' ? pageSource : externalSource })
      else await operation(client, change, { id: files[0].resourceId, version: files[0].version })
      expect(await operation(client, 'current', { ...roots, frame: candidate })).toBe(false)
      const read = () => outcome(client, () => history(client))
      expect(await read()).toEqual(await baseline(client, read))
    })
  }, 90_000)

  for (const change of ['drift_body', 'drift_acl', 'drift_frame', 'drift_snapshots', 'drift_original_guard']) it(`keeps canonical fallback after ${change}`, async () => frame(async client => {
    const candidate = await operation(client, 'frame', roots)
    expect(candidate).toMatchObject({ admitted: true })
    await operation(client, change)
    expect(await operation(client, 'guard')).toBe(false)
    if (change !== 'drift_frame') expect(await operation(client, 'frame', roots)).toBeNull()
    expect(await history(client)).toEqual(await baseline(client, () => history(client)))
  }), 90_000)

  it('keeps all new helpers private and refuses no-file or unsupported roots', async () => frame(async client => {
    for (const signature of [frameSignature, currentSignature, snapshotsSignature, guardSignature]) {
      expect((await client.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed', [signature])).rows[0].allowed).toBe(false)
    }
    expect(await operation(client, 'frame', { kinds: ['session_message'], ids: [roots.ids[0]], versions: [roots.versions[0]] })).toBeNull()
    expect(await operation(client, 'frame', { kinds: [pageSource.resourceKind], ids: [pageSource.resourceId], versions: [pageSource.version] })).toBeNull()
    expect(await outcome(client, () => operation(client, 'frame', { kinds: [], ids: [], versions: [] }))).toEqual({ error: '22023' })
    expect(await operation(client, 'current', { ...roots, frame: {} })).toBe(false)
  }))

  it('keeps a no-file history capture on its original path without invoking the new helpers', async () => frame(async client => {
    await operation(client, 'trace')
    const before = await operation(client, 'stats')
    const read = () => operation(client, 'capture', { session: modes.f.session.id, through: 3 })
    expect(await read()).toEqual(await baseline(client, read))
    expect(await operation(client, 'stats')).toEqual(before)
  }), 90_000)

  it('leaves genuine historical Memory fields on the original family', async () => frame(async client => {
    const memory = await createMemory({ workspaceId: modes.f.workspaceId, assistantId: modes.f.assistantId, userId: null,
      summary: 'Fictional historical source', sensitivity: 'internal', createdByUserId: modes.f.ownerId }, undefined, client)
    const value = (await client.query<{ value: { sources: ScopeSource[] } | null }>('SELECT read_native_memory_history_projection($1,$2,$3) AS value',
      [modes.f.workspaceId, memory.id, memory.scopeVersion])).rows[0].value
    expect(value).not.toBeNull()
    const historical = value!.sources.filter(source => source.resourceKind === 'application_field')
    expect(historical.length).toBeGreaterThan(0)
    const sources = [...historical, files[0]]
    const args = { kinds: sources.map(source => source.resourceKind), ids: sources.map(source => source.resourceId), versions: sources.map(source => source.version) }
    expect(await operation(client, 'frame', args)).toBeNull()
    expect((await client.query('SELECT read_native_file_session_evidence($1,$2,$3,$4,true) AS value',
      [modes.f.workspaceId, args.kinds, args.ids, args.versions])).rows[0].value).toBeNull()
  }))

  it('discards an actually seeded batch when a file predecessor changes during capture', async () => {
    const trigger = `${wrapper}_barrier`
    await getPool().query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $barrier$
      BEGIN
        IF current_setting('app.fixture_file_capture_barrier',true)='on' AND NEW.type_key='session_message'
          AND NEW.domain->>'sessionId'=TG_ARGV[0] AND NEW.domain->>'throughSequence'=TG_ARGV[1] THEN
          IF NOT EXISTS(SELECT 1 FROM pg_stat_xact_user_functions WHERE funcid='read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure AND calls>0)
            THEN RAISE EXCEPTION 'Fixture did not reach a seeded file frame';END IF;
          PERFORM set_config('app.fixture_file_capture_barrier','off',true);
          INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity,superseded_by)
            VALUES(NEW.workspace_id,'/fictional/mid-capture-predecessor','Fictional capture predecessor','fixture://capture-barrier',
              current_setting('app.current_user_id')::uuid,'user','confidential',TG_ARGV[2]::uuid);
          PERFORM set_config('app.fixture_file_capture_changed','on',true);
        END IF;
        RETURN NEW;
      END $barrier$;
      REVOKE ALL ON FUNCTION ${trigger}() FROM PUBLIC;
      CREATE TRIGGER ${trigger} BEFORE INSERT ON application_query_domains FOR EACH ROW EXECUTE FUNCTION ${trigger}('${modes.f.session.id}','${through}','${files[0].resourceId}')`)
    try {
      await frame(async client => {
        await operation(client, 'trace')
        await client.query("SELECT set_config('app.fixture_file_capture_barrier','on',true)")
        expect(await capture(client)).toBeNull()
        expect((await client.query("SELECT current_setting('app.fixture_file_capture_changed',true) AS changed")).rows[0].changed).toBe('on')
        expect((await operation(client, 'stats'))!.frames).toBeGreaterThan(0)
        const current = await history(client)
        expect(current).toEqual(await baseline(client, () => history(client)))
      })
    } finally {
      await getPool().query(`DROP TRIGGER IF EXISTS ${trigger} ON application_query_domains; DROP FUNCTION IF EXISTS ${trigger}()`)
    }
  }, 90_000)
})
