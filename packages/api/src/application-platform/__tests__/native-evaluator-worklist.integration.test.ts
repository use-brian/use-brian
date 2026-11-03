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
type Root = { kind: string; id: string; version: string }
const wrapper = `detached_evaluator_fixture_${randomUUID().replaceAll('-', '')}`
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let execution: ExecutionContext
let files: ScopeSource[]
let roots: { kinds: string[]; ids: string[]; versions: string[] }
let through: number
const replies: string[] = []
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
  const root: Root = { kind: 'session_message', id: replies.at(-1)!, version: '1' }
  const memo = { ...result.memo, nativeWorklist: true }
  delete memo[`native:${root.kind}:${root.id}:${root.version}`]
  return { seed, root, memo }
}
async function compare(client: PoolClient, input: Json) {
  const original = await operation(client, 'original', input)
  const detached = await operation(client, 'detached', input)
  expect(detached).toEqual(original)
  return detached
}

describe.sequential('[COMP:api/application-persistence] detached native evaluator worklists', () => {
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
    roots = { kinds: rows.map(() => 'session_message'), ids: rows.map(row => row.id), versions: rows.map(row => row.version) }
    await f.pool.query(`CREATE FUNCTION ${wrapper}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE kinds text[];ids uuid[];versions text[];nodes jsonb;memo jsonb;result jsonb;seed jsonb;
        definition text;body text;signature text;root jsonb;
      BEGIN
        kinds:=ARRAY(SELECT jsonb_array_elements_text(payload->'kinds'));
        ids:=ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(payload->'ids') value);
        versions:=ARRAY(SELECT jsonb_array_elements_text(payload->'versions'));
        IF action='guard' THEN RETURN to_jsonb(application_native_worklist_helpers_current());
        ELSIF action='frame' THEN RETURN read_native_file_session_cohort_frame(w,kinds,ids,versions,true);
        ELSIF action='evidence' THEN RETURN read_native_file_session_evidence(w,kinds,ids,versions,true);
        ELSIF action='seed' THEN
          SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
          RETURN native_worklist_seed(w,nodes);
        ELSIF action='current' THEN RETURN to_jsonb(native_worklist_frame_current(w,payload));
        ELSIF action IN('original','detached') THEN
          memo:=payload->'memo';seed:=payload->'seed';root:=payload->'root';
          IF action='original' AND memo->'nativeWorklist'='true'::jsonb THEN memo:=jsonb_set(memo,'{nativeWorklist}',seed);END IF;
          IF payload->>'mode'='field' THEN
            IF action='original' THEN result:=native_worklist_eval_field(w,(root->>'id')::uuid,root->>'version',memo);
            ELSE result:=native_detached_eval_field(w,(root->>'id')::uuid,root->>'version',memo,seed);END IF;
          ELSIF payload->>'mode'='point' THEN
            IF action='original' THEN result:=native_worklist_eval_point_state(w,root->>'kind',(root->>'id')::uuid,ARRAY['content'],memo);
            ELSE result:=native_detached_eval_point_state(w,root->>'kind',(root->>'id')::uuid,ARRAY['content'],memo,seed);END IF;
          ELSE
            IF action='original' THEN result:=native_worklist_eval_scope(w,root->>'kind',(root->>'id')::uuid,root->>'version',memo);
            ELSE result:=native_detached_eval_scope(w,root->>'kind',(root->>'id')::uuid,root->>'version',memo,seed);END IF;
          END IF;
          RETURN jsonb_set(result,'{memo}',(result->'memo')-'nativeWorklist')||jsonb_build_object('worklistEnabled',coalesce(jsonb_typeof(result#>'{memo,nativeWorklist}')='object' OR result#>'{memo,nativeWorklist}'='true'::jsonb,false));
        ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);
        ELSIF action='stats' THEN RETURN (SELECT coalesce(jsonb_object_agg(p.proname,s.calls),'{}') FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid);
        ELSIF action='hold' THEN INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
          VALUES(w,'workspace_file',(payload->>'id')::uuid,payload->>'version','held',1,'Fictional evaluator hold');
        ELSIF action='cycle' THEN
          UPDATE workspace_files SET superseded_by=(payload->>'second')::uuid WHERE workspace_id=w AND id=(payload->>'first')::uuid;
          UPDATE workspace_files SET superseded_by=(payload->>'first')::uuid WHERE workspace_id=w AND id=(payload->>'second')::uuid;
        ELSIF action='body' THEN UPDATE session_messages SET content='"Fictional changed evaluator body"'::jsonb WHERE workspace_id=w AND id=(payload->>'id')::uuid;
        ELSIF action='disable' THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.application_native_worklist_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''BEGIN RETURN false;END''';
        ELSIF action='drift_guard' THEN EXECUTE 'CREATE OR REPLACE FUNCTION public.application_native_worklist_helpers_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''BEGIN RAISE EXCEPTION ''''fictional_unknown_detached_guard'''';END''';
        ELSIF action='drift_acl' THEN GRANT EXECUTE ON FUNCTION native_detached_eval_scope(uuid,text,uuid,text,jsonb,jsonb) TO app_user;
        ELSIF action='drift_body' THEN
          signature:='native_detached_eval_scope(uuid,text,uuid,text,jsonb,jsonb)';
          SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid=signature::regprocedure;
          EXECUTE replace(definition,body,body||E'\n-- Fictional detached evaluator drift');
        ELSE RAISE EXCEPTION 'Unknown detached evaluator fixture operation';END IF;
        RETURN NULL;
      END $fixture$;
      REVOKE ALL ON FUNCTION ${wrapper}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${wrapper}(uuid,text,jsonb) TO app_user`)
  }, 180_000)
  afterAll(async () => {
    try { await f?.pool.query(`DROP FUNCTION IF EXISTS ${wrapper}(uuid,text,jsonb)`); await f?.cleanup() }
    finally { await getAppPool().end(); await getPool().end() }
  })

  it('preserves the complete evidence and published history with private transport and final canonical verification', async () => {
    await frame(async client => {
      expect(await operation(client, 'guard')).toBe(true)
      await operation(client, 'trace')
      const before = await operation(client, 'stats')
      const actual = await operation(client, 'frame', roots)
      expect(actual).toMatchObject({ admitted: true })
      expect(actual.memo).not.toHaveProperty('nativeWorklist')
      const after = await operation(client, 'stats')
      expect((after.native_detached_eval_field ?? 0) - (before.native_detached_eval_field ?? 0)).toBeGreaterThan(0)
      expect((after.native_worklist_frame_current ?? 0) - (before.native_worklist_frame_current ?? 0)).toBeGreaterThan(0)
      expect((after.read_admitted_native_scope_snapshot ?? 0) - (before.read_admitted_native_scope_snapshot ?? 0)).toBeGreaterThanOrEqual(50)
      await operation(client, 'disable')
      expectScheduledFrame(actual, await operation(client, 'frame', roots))
    })
    const actual = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: through, authority: authority() })
    for (const id of replies) expect(actual.history.some(row => row.id === id)).toBe(true)
  }, 120_000)

  it('matches unchanged evaluators on overlapping ancestry while retaining every field check', async () => frame(async client => {
    const input = await prepared(client)
    const completed = Object.entries(input.memo).filter(([key, value]) => key.startsWith('native:') && (value as Json).value === true)
    expect(completed.length).toBeGreaterThan(0)
    await operation(client, 'trace')
    const before = await operation(client, 'stats')
    const original = await operation(client, 'original', input)
    const middle = await operation(client, 'stats')
    const actual = await operation(client, 'detached', input)
    const after = await operation(client, 'stats')
    expect(actual).toEqual(original)
    expect(actual.value).toBe(true)
    expect((after.native_detached_eval_field ?? 0) - (middle.native_detached_eval_field ?? 0))
      .toBe((middle.native_worklist_eval_field ?? 0) - (before.native_worklist_eval_field ?? 0))
    expect((after.native_detached_eval_field ?? 0) - (middle.native_detached_eval_field ?? 0)).toBeGreaterThan(0)
    expect(await compare(client, { ...input, mode: 'point' })).toHaveProperty('value')
  }), 90_000)

  for (const status of ['busy', 'false', 'missing-value', 'missing-external', 'nonempty-external', 'extended']) {
    it(`does not treat ${status} entries as completed ordinary native proofs`, async () => frame(async client => {
      const input = await prepared(client)
      const key = `native:session_message:${replies[0]}:1`
      if (status === 'busy') input.memo[key] = { busy: true }
      else if (status === 'false') input.memo[key] = { value: false, external: [] }
      else if (status === 'missing-value') input.memo[key] = { external: [] }
      else if (status === 'missing-external') input.memo[key] = { value: true }
      else if (status === 'nonempty-external') input.memo[key] = { value: true, external: [{ id: randomUUID(), version: '1' }] }
      else { delete input.memo[key]; input.memo[`empty-${key}`] = { value: true, external: [] } }
      expect(await compare(client, input)).toHaveProperty('memo')
    }), 90_000)
  }

  it('preserves busy-cycle refusal before reset and preserves busy sentinels during invalidation', async () => frame(async client => {
    const input = await prepared(client), key = `native:${input.root.kind}:${input.root.id}:${input.root.version}`
    const busy = { ...input, memo: { ...input.memo, [key]: { busy: true }, [`empty-${key}`]: { value: true, external: [] } } }
    expect(await compare(client, busy)).toMatchObject({ value: false, worklistEnabled: true })
    const sentinel = `native:session_message:${randomUUID()}:1`
    input.memo[sentinel] = { busy: true }
    input.memo[`empty-${key}`] = { value: true, external: [] }
    await operation(client, 'trace')
    const before = await operation(client, 'stats')
    const actual = await compare(client, input)
    const after = await operation(client, 'stats')
    expect(actual.worklistEnabled).toBe(false)
    expect(actual.memo[sentinel]).toEqual({ busy: true })
    expect(actual.memo.memoryStatement).toEqual(input.memo.memoryStatement)
    expect((after.application_scope_lineage ?? 0) - (before.application_scope_lineage ?? 0)).toBeGreaterThan(0)
  }), 120_000)

  it('uses canonical fallback for an authentic root outside the seeded closure and for an absent marker', async () => frame(async client => {
    const input = await prepared(client)
    const narrow = { kinds: ['session_message'], ids: [replies[0]], versions: ['1'] }
    const seed = await operation(client, 'seed', narrow)
    expect(seed.edges).not.toHaveProperty(`${input.root.kind}:${input.root.id}:${input.root.version}`)
    const memo = { memoryStatement: input.memo.memoryStatement, nativeWorklist: true }
    expect(await compare(client, { ...input, seed, memo })).toHaveProperty('value')
    const disabled = { ...input.memo }; delete disabled.nativeWorklist
    expect(await compare(client, { ...input, memo: disabled })).toMatchObject({ worklistEnabled: false })
  }), 120_000)

  for (const marker of [false, null]) it(`does not enable a detached frame with a ${marker} marker`, async () => frame(async client => {
    const input = await prepared(client)
    const seed = structuredClone(input.seed)
    for (const current of Object.values(seed.currents) as Json[]) if (current.source) current.source.held = true
    const actual = await compare(client, { ...input, seed, mode: 'point', memo: { ...input.memo, nativeWorklist: marker } })
    expect(actual).toHaveProperty('value')
    expect(actual.worklistEnabled).toBe(false)
  }), 90_000)

  it('preserves the original memo complexity boundary', async () => frame(async client => {
    const input = await prepared(client)
    const memo: Json = { nativeWorklist: true }
    for (let i = 0; i < 4096; i++) memo[`fictional-completed:${i}`] = { value: true, external: [] }
    expect(await compare(client, { ...input, memo })).toMatchObject({ value: false })
  }))

  it('terminates an actual predecessor cycle with the same scope result', async () => frame(async client => {
    await operation(client, 'cycle', { first: files[0].resourceId, second: files[1].resourceId })
    const root: Root = { kind: 'workspace_file', id: files[0].resourceId, version: files[0].version }
    const seed = await operation(client, 'seed', { kinds: [root.kind], ids: [root.id], versions: [root.version] })
    expect(seed.nodes.some((node: Root) => node.id === files[1].resourceId)).toBe(true)
    expect(await compare(client, { root, seed, memo: { nativeWorklist: true } })).toHaveProperty('value')
  }), 90_000)

  it('rejects a held leaf at the independent final boundary and preserves canonical evidence fallback', async () => frame(async client => {
    const input = await prepared(client)
    expect(await operation(client, 'current', input.seed)).toBe(true)
    await operation(client, 'hold', { id: files[0].resourceId, version: files[0].version })
    expect(await operation(client, 'current', input.seed)).toBe(false)
    await compare(client, input)
    const read = () => outcome(client, () => operation(client, 'evidence', roots))
    const actual = await read()
    await operation(client, 'disable')
    expect(await read()).toEqual(actual)
    expect(actual).not.toMatchObject({ value: { admitted: true } })
  }), 120_000)

  it('continues reading point payloads freshly with an existing completed memo', async () => frame(async client => {
    const input = await prepared(client)
    const root: Root = { kind: 'session_message', id: roots.ids[0], version: roots.versions[0] }
    const before = await compare(client, { ...input, root, mode: 'point' })
    await operation(client, 'body', { id: root.id })
    const after = await compare(client, { ...input, root, mode: 'point' })
    expect(after).not.toEqual(before)
  }), 90_000)

  for (const change of ['drift_body', 'drift_acl', 'drift_guard']) it(`retains original fallback after ${change}`, async () => frame(async client => {
    await client.query('SAVEPOINT detached_baseline')
    await operation(client, 'disable')
    const original = await operation(client, 'evidence', roots)
    await client.query('ROLLBACK TO SAVEPOINT detached_baseline')
    await operation(client, change)
    if (change !== 'drift_guard') expect(await operation(client, 'guard')).toBe(false)
    expect(await operation(client, 'evidence', roots)).toEqual(original)
  }), 120_000)

  it('keeps every newly named evaluator inaccessible to the application role', async () => frame(async client => {
    const helpers = (await client.query<{ signature: string; allowed: boolean }>(`SELECT oid::regprocedure::text signature,
      has_function_privilege(current_user,oid,'EXECUTE') allowed FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'native_detached_%'`)).rows
    expect(helpers).toHaveLength(8)
    expect(helpers.filter(row => row.allowed)).toEqual([])
  }))
})
