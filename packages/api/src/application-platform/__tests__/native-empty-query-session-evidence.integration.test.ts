import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { boundScopeSources, ContextScopeAccumulator, type ExecutionContext, type ScopeEvidence, type ScopeSource } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { createDbKnowledgeStore } from '../../db/knowledge-store.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { listLegacyCanonicalTasks } from '../../db/task-reader.js'
import { listWorkspaceFilesIndexRanked } from '../../db/workspace-files.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { readSessionQueryFrame, withSessionMessagePublication } from '../../db/session-context-revisions.js'
import { publishNativeSessionMessage } from '../../db/session-message-publication.js'
import { publishSessionTitle, readSessionTitle } from '../../db/session-title-store.js'
import { createTask } from '../../db/tasks.js'
import { recordDerivedResource } from '../../db/derived-scope-store.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { validateCallerScopeEvidence } from '../../context-scope/caller-evidence.js'
import { tryNativeInvocationEvidence } from '../../context-scope/native-invocation-evidence.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const knowledge = createDbKnowledgeStore()
const fixtures: Awaited<ReturnType<typeof persistentContextFixture>>[] = []
const wrapper = `empty_query_fixture_${randomUUID().replaceAll('-', '')}`
type Json = Record<string, any>
const evidenceFacade = 'read_native_empty_query_evidence'
const canonicalEvidence = (evidence: ScopeEvidence) => ({ ...evidence, sources: [...evidence.sources ?? []]
  .sort((a, b) => `${a.resourceKind}:${a.resourceId}:${a.version}`.localeCompare(`${b.resourceKind}:${b.resourceId}:${b.version}`)) })

/** Forward every real query; bypass only the new facade for the original path. */
function observed(client: PoolClient, fallback: boolean, queries: string[]) {
  return { query: async (sql: string, args?: unknown[]) => {
    queries.push(sql)
    if (fallback && sql.includes(evidenceFacade)) return { rows: [{ value: null }] }
    return client.query(sql, args)
  } } as Pick<PoolClient, 'query'>
}
async function facade(client: Pick<PoolClient, 'query'>, workspaceId: string, sources: readonly ScopeSource[]) {
  return (await client.query<{ value: Json | null }>(`SELECT ${evidenceFacade}($1,$2,$3,$4) AS value`,
    [workspaceId, sources.map(source => source.resourceKind), sources.map(source => source.resourceId), sources.map(source => source.version)])).rows[0].value
}

/** Test-only owner wrapper: production helper ACLs stay unchanged. DDL is rolled back. */
async function operation(client: PoolClient, workspaceId: string, kind: string, payload: unknown = {}) {
  return (await client.query<{ value: Json }>(`SELECT ${wrapper}($1,$2,$3) AS value`, [workspaceId, kind, payload])).rows[0].value
}
async function frame<T>(execution: ExecutionContext, read: (client: PoolClient) => Promise<T>) {
  const client = await getAppPool().connect()
  try {
    return await runWithAgentAccess(execution.security.access, async () => {
      await client.query('BEGIN')
      await applyRLSGucs(client, execution.security.access.userId)
      await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [execution.assistant.id])
      return await read(client)
    })
  } finally { await rollbackAndRelease(client) }
}
async function baseline<T>(client: PoolClient, workspaceId: string, read: () => Promise<T>) {
  await client.query('SAVEPOINT original_evaluation')
  try {
    await operation(client, workspaceId, 'disable')
    return await read()
  } finally { await client.query('ROLLBACK TO SAVEPOINT original_evaluation') }
}
async function outcome<T>(client: PoolClient, read: () => Promise<T>): Promise<{ value: T } | { error: string | undefined }> {
  await client.query('SAVEPOINT observed_outcome')
  try { return { value: await read() } }
  catch (error) {
    const failure = error as { code?: string; reason?: string; message?: string }
    return { error: failure.code ?? failure.reason ?? failure.message }
  } finally { await client.query('ROLLBACK TO SAVEPOINT observed_outcome') }
}
function roots(sources: readonly ScopeSource[]) {
  return { kinds: sources.map(source => source.resourceKind), ids: sources.map(source => source.resourceId), versions: sources.map(source => source.version) }
}
async function setup() {
  const f = await persistentContextFixture(); fixtures.push(f)
  await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
    SELECT $1,'/fictional/leaf-'||n||'.txt','Fictional leaf '||n,'fixture://leaf-'||n,$2,'user','internal'
    FROM generate_series(1,3) n`, [f.workspaceId, f.ownerId])
  const history = await f.history(), unbounded = await f.execution(f.firstId)
  // All prompt inputs must use the same shared-room ceiling as persisted
  // history. Broad workspace absence is not evidence for a narrower room.
  const maximumAccess = { ...unbounded.security.ceiling, clearance: f.envelope.sensitivity,
    compartments: f.envelope.compartments, mutationCompartments: [], projectIds: f.envelope.projectIds }
  const execution = (await resolveExecutionContextSystem({ userId: f.firstId, workspaceId: f.workspaceId,
    assistant: (await findAssistantById(f.assistantId))!, memberMode: 'member', sharedAudience: true,
    session: f.session, sessionAuthority: f.session, identity: unbounded.identity, ownership: unbounded.ownership,
    lifecycle: unbounded.lifecycle, maximumAccess, maximumAccessCurrent: async () => maximumAccess })).executionContext
  const authority = { execution, accumulator: new ContextScopeAccumulator() }
  const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: history.at(-1)!.sequenceNum, authority })
  const summaries = await knowledge.listSummaries(execution.security.access, authority)
  const tasks = await listLegacyCanonicalTasks(execution.security.access, {})
  const memories = await createDbMemoryStore().getIndex(execution.security.access, false, authority)
  const files = await listWorkspaceFilesIndexRanked(execution.security.access, 3)
  expect(summaries).toHaveLength(0); expect(tasks).toHaveLength(0)
  const evidence = new ContextScopeAccumulator({ sources: [
    ...boundScopeSources(query), ...boundScopeSources(summaries), ...boundScopeSources(tasks),
    ...boundScopeSources(memories), ...files.flatMap(file => boundScopeSources(file)),
  ] }).evidence
  const domains = (await f.pool.query<{ id: string; version: string; type: string }>(`SELECT r.id,o.version,r.type_key AS type
    FROM application_field_resources r JOIN application_field_observations o ON o.workspace_id=r.workspace_id AND o.resource_id=r.id
    WHERE r.workspace_id=$1 AND r.selection='query_domain' AND r.type_key IN('knowledge_entry','task')
      AND r.id=ANY($2::uuid[]) ORDER BY r.type_key`, [f.workspaceId, evidence.sources!.map(source => source.resourceId)])).rows
  expect(domains.map(domain => domain.type)).toEqual(['knowledge_entry', 'task'])
  return { f, execution, authority, evidence, domains, files, history }
}

describe.sequential('[COMP:api/application-persistence] empty query worklist equivalence', () => {
  beforeAll(async () => {
    await getPool().query(`CREATE FUNCTION ${wrapper}(w uuid,operation text,payload jsonb) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      BEGIN
        IF operation='disable' THEN
          EXECUTE 'CREATE OR REPLACE FUNCTION public.application_empty_query_helpers_current() RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''SELECT false''';
          RETURN '{}'::jsonb;
        ELSIF operation='guard' THEN
          RETURN to_jsonb(application_memory_statement_helpers_current());
        ELSIF operation='field' THEN
          RETURN application_session_eval_field(w,(payload->>'id')::uuid,payload->>'version',coalesce(payload->'memo','{}'));
        ELSIF operation='scope' THEN
          RETURN application_session_eval_scope(w,'session_message',(payload->>'id')::uuid,payload->>'version',coalesce(payload->'memo','{}'));
        ELSIF operation='current' THEN
          RETURN to_jsonb(application_empty_query_worklist_current(w,payload));
        ELSIF operation='reset' THEN
          RETURN application_empty_query_worklist_reset(payload);
        ELSIF operation='proof' THEN
          RETURN read_native_empty_query_session_evidence(w,
            ARRAY(SELECT jsonb_array_elements_text(payload->'kinds')),
            ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(payload->'ids') value),
            ARRAY(SELECT jsonb_array_elements_text(payload->'versions')),true);
        ELSIF operation='drift' THEN
          EXECUTE 'ALTER FUNCTION public.application_empty_query_worklist_reset(jsonb) COST 987';
          RETURN '{}'::jsonb;
        ELSIF operation='grant' THEN
          EXECUTE 'GRANT EXECUTE ON FUNCTION public.application_empty_query_worklist_reset(jsonb) TO app_user';
          RETURN '{}'::jsonb;
        ELSIF operation='body' THEN
          EXECUTE 'CREATE OR REPLACE FUNCTION public.application_empty_query_worklist_current(w uuid,memo jsonb) RETURNS boolean
            LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''SELECT true''';
          RETURN '{}'::jsonb;
        ELSIF operation='reset_body' THEN
          EXECUTE 'CREATE OR REPLACE FUNCTION public.application_empty_query_worklist_reset(memo jsonb) RETURNS jsonb
            LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''SELECT memo''';
          RETURN '{}'::jsonb;
        ELSIF operation='proof_body' THEN
          EXECUTE 'CREATE OR REPLACE FUNCTION public.read_native_empty_query_session_evidence(w uuid,kinds text[],ids uuid[],versions text[],include_memory boolean) RETURNS jsonb
            LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS ''SELECT jsonb_build_object(''''admitted'''',true,''''immutable'''',''''[]''''::jsonb,''''current'''',''''[]''''::jsonb)''';
          RETURN '{}'::jsonb;
        END IF;
        RAISE EXCEPTION 'Unknown synthetic operation';
      END $fixture$;
      REVOKE ALL ON FUNCTION ${wrapper}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${wrapper}(uuid,text,jsonb) TO app_user;`)
  })
  afterAll(async () => {
    try {
      for (const f of fixtures) await f.cleanup()
      await getPool().query(`DROP FUNCTION IF EXISTS ${wrapper}(uuid,text,jsonb)`)
    } finally { await getAppPool().end(); await getPool().end() }
  })

  it('preserves complete evidence and history output while keeping optimization helpers private', async () => {
    const c = await setup()
    await frame(c.execution, async client => {
      expect(await operation(client, c.f.workspaceId, 'guard')).toBe(true)
      for (const signature of ['application_empty_query_worklist_current(uuid,jsonb)', 'application_empty_query_worklist_reset(jsonb)',
        'application_empty_query_helpers_current()', 'read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)']) {
        expect((await client.query('SELECT has_function_privilege(current_user,$1,\'execute\') AS allowed', [signature])).rows[0].allowed).toBe(false)
      }
      const proof = await operation(client, c.f.workspaceId, 'proof', roots(c.evidence.sources!))
      expect(proof).toMatchObject({ admitted: true })
      const read = () => validateCallerScopeEvidence(c.evidence, c.execution.security.ceiling, client)
      expect(await read()).toEqual(await baseline(client, c.f.workspaceId, read))
      const history = async () => (await client.query('SELECT value FROM read_native_application_session_history($1,$2,$3)',
        [c.f.workspaceId, c.f.session.id, c.history.at(-1)!.sequenceNum])).rows
      expect(await history()).toEqual(await baseline(client, c.f.workspaceId, history))
    })
  })

  it('uses the complete empty-domain facade at the actual invocation boundary without repeated field reads', async () => {
    const c = await setup(), originalQueries: string[] = [], optimizedQueries: string[] = []
    const expected = await frame(c.execution, async client => {
      expect(await facade(client, c.f.workspaceId, c.evidence.sources!)).toMatchObject({ admitted: true })
      const original = await validateCallerScopeEvidence(c.evidence, c.execution.security.ceiling, observed(client, true, originalQueries))
      const optimized = await validateCallerScopeEvidence(c.evidence, c.execution.security.ceiling, observed(client, false, optimizedQueries))
      expect(canonicalEvidence(optimized)).toEqual(canonicalEvidence(original))
      return original
    })
    expect(originalQueries.some(sql => sql.includes('read_native_session_field_dependencies'))).toBe(true)
    expect(optimizedQueries.some(sql => sql.includes(evidenceFacade))).toBe(true)
    expect(optimizedQueries.some(sql => sql.includes('read_native_session_field_dependencies'))).toBe(false)
    const invocation = await tryNativeInvocationEvidence(c.execution, c.evidence, c.execution.security.ceiling, 'caller')
    expect(invocation).not.toBeNull()
    expect(canonicalEvidence(invocation!)).toEqual(canonicalEvidence(expected))
  })

  for (const mutation of ['body', 'proof_body'] as const) it(`falls back through the real validator after private ${mutation} changes`, async () => {
    const c = await setup(), queries: string[] = []
    await frame(c.execution, async client => {
      const expected = await validateCallerScopeEvidence(c.evidence, c.execution.security.ceiling, observed(client, true, []))
      await operation(client, c.f.workspaceId, mutation)
      expect(await facade(client, c.f.workspaceId, c.evidence.sources!)).toBeNull()
      const actual = await validateCallerScopeEvidence(c.evidence, c.execution.security.ceiling, observed(client, false, queries))
      expect(canonicalEvidence(actual)).toEqual(canonicalEvidence(expected))
      expect(queries.some(sql => sql.includes('read_native_session_field_dependencies'))).toBe(true)
    })
  })

  it('leaves a nonempty Knowledge domain on its original validator', async () => {
    const c = await setup()
    await knowledge.create({ workspaceId: c.f.workspaceId, path: 'fictional-nonempty', title: 'Fictional nonempty domain',
      content: 'Fictional visible candidate', sensitivity: 'internal', createdBy: c.f.ownerId })
    const summaries = await knowledge.listSummaries(c.execution.security.access, c.authority)
    expect(summaries).toHaveLength(1)
    const evidence = new ContextScopeAccumulator({ sources: boundScopeSources(summaries) }).evidence
    await frame(c.execution, async client => {
      expect(await facade(client, c.f.workspaceId, evidence.sources!)).toBeNull()
      const original = await validateCallerScopeEvidence(evidence, c.execution.security.ceiling, observed(client, true, []))
      const actual = await validateCallerScopeEvidence(evidence, c.execution.security.ceiling, observed(client, false, []))
      expect(canonicalEvidence(actual)).toEqual(canonicalEvidence(original))
    })
  })

  it('reads an empty-domain-derived title through the actual title path and preserves fallback and holds', async () => {
    const c = await setup()
    const title = await publishSessionTitle({ sessionId: c.f.session.id, title: 'Fictional empty-domain discussion', manual: false,
      expectedRevision: null, authority: c.authority, derivation: { producer: 'fixture:empty-query-title', sources: c.evidence.sources! } })
    expect(title).not.toBeNull()
    expect(await readSessionTitle(c.f.session.id, c.authority)).toMatchObject({ title: title!.title, revisionId: title!.revisionId })
    const compare = async (client: PoolClient) => {
      const original = await client.query('SELECT read_native_file_session_title_revision($1,$2,$3) AS value', [c.f.workspaceId, c.f.session.id, title!.revisionId])
      const optimized = await client.query('SELECT read_native_empty_query_session_title_revision($1,$2,$3) AS value', [c.f.workspaceId, c.f.session.id, title!.revisionId])
      expect(optimized.rows[0].value).toEqual(original.rows[0].value)
      return optimized.rows[0].value
    }
    await frame(c.execution, async client => {
      expect(await compare(client)).toEqual({ title: title!.title, manual: false })
      for (const mutation of ['body', 'proof_body']) {
        await client.query('SAVEPOINT title_helper_drift')
        try {
          await operation(client, c.f.workspaceId, mutation)
          expect(await compare(client)).toEqual({ title: title!.title, manual: false })
        } finally { await client.query('ROLLBACK TO SAVEPOINT title_helper_drift') }
      }
    })
    await c.f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1', [c.f.session.id])
    await frame(c.execution, async client => { expect(await compare(client)).toBeNull() })
    await expect(readSessionTitle(c.f.session.id, c.authority)).rejects.toMatchObject({ reason: 'authority_changed' })
  })

  it('accepts only bounded canonical root arrays under the restricted application role', async () => {
    const c = await setup(), sources = c.evidence.sources!
    await frame(c.execution, async client => {
      const args = [c.f.workspaceId, sources.map(source => source.resourceKind), sources.map(source => source.resourceId), sources.map(source => source.version)]
      for (const invalid of [
        [c.f.workspaceId, [], [], []],
        [c.f.workspaceId, args[1], [], args[3]],
        [c.f.workspaceId, ['application_field'], [randomUUID()], ['1']],
        [randomUUID(), args[1], args[2], args[3]],
        [c.f.workspaceId, ['application_field'], [sources[0].resourceId], ['unknown-version']],
        [c.f.workspaceId, Array(101).fill(sources[0].resourceKind), Array(101).fill(sources[0].resourceId), Array(101).fill(sources[0].version)],
      ]) {
        const result = await outcome(client, async () => (await client.query<{ value: Json | null }>(
          `SELECT ${evidenceFacade}($1,$2,$3,$4) AS value`, invalid)).rows[0].value)
        if ('value' in result) expect(result.value?.admitted).not.toBe(true)
      }
      expect((await client.query('SELECT has_function_privilege(current_user,$1,\'execute\') AS allowed',
        [`${evidenceFacade}(uuid,text[],uuid[],text[])`])).rows[0].allowed).toBe(true)
      for (const signature of ['read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)',
        'session_context_empty_query_revision_allowed(uuid,uuid)', 'read_session_context_empty_query_revision(uuid,uuid)',
        'application_empty_query_facades_current()']) {
        expect((await client.query('SELECT has_function_privilege(current_user,$1,\'execute\') AS allowed', [signature])).rows[0].allowed).toBe(false)
      }
    })
    const owner = await getPool().connect()
    try {
      await owner.query('BEGIN')
      await owner.query("SELECT set_config('app.current_user_id',$1,true)", [c.f.firstId])
      expect(await facade(owner, c.f.workspaceId, sources)).toBeNull()
    } finally { await rollbackAndRelease(owner) }
  })

  for (const change of ['member clearance', 'file hold'] as const) it(`preserves current ${change} denial through the public facade`, async () => {
    const c = await setup()
    if (change === 'member clearance') await c.f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [c.f.workspaceId, c.f.firstId])
    else {
      const source = boundScopeSources(c.files[0])[0]
      await c.f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
        VALUES($1,'workspace_file',$2,$3,'held',1,'Fictional review hold')`, [c.f.workspaceId, source.resourceId, source.version])
    }
    await frame(c.execution, async client => {
      expect((await facade(client, c.f.workspaceId, c.evidence.sources!))?.admitted).not.toBe(true)
      const original = await outcome(client, () => validateCallerScopeEvidence(c.evidence, c.execution.security.ceiling, observed(client, true, [])))
      const actual = await outcome(client, () => validateCallerScopeEvidence(c.evidence, c.execution.security.ceiling, observed(client, false, [])))
      expect(actual).toEqual(original)
      expect(actual).toHaveProperty('error')
    })
  })

  it('publishes the same durable reply and preserves fresh access revocation', async () => {
    const c = await setup()
    const input = { sessionId: c.f.session.id, authority: c.authority, role: 'assistant',
      content: [{ type: 'text', text: 'Fictional response with empty query evidence' }],
      senderAssistantId: c.f.assistantId, derivationTarget: c.f.envelope,
      derivation: { producer: 'fixture:empty-query-reply', sources: c.evidence.sources! } }
    const written = await withSessionMessagePublication(c.authority, c.evidence.sources!, async client => {
      const write = () => publishNativeSessionMessage(input, client)
      const original = await baseline(client, c.f.workspaceId, write)
      const optimized = await write()
      const comparable = (row: typeof original) => ({ role: row.role, content: row.content, sequence: row.sequenceNum,
        sessionId: row.sessionId, scope: boundScopeSources(row).map(({ resourceId: _id, ...scope }) => scope) })
      expect(comparable(optimized)).toEqual(comparable(original))
      return optimized
    })
    expect((await c.f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1', [c.f.session.id])).rows[0].count).toBe(4)
    const fresh = await c.f.modelContext(c.f.firstId)
    const history = await readAdmittedSessionQuery({ sessionId: c.f.session.id, throughSequence: written.sequenceNum, authority: fresh })
    if (!history.history.some(row => row.id === written.id)) {
      const diagnosis = await readSessionQueryFrame(fresh, [], async client => {
        const original = await baseline(client, c.f.workspaceId, async () => (await client.query('SELECT value FROM read_native_application_session_history($1,$2,$3)',
          [c.f.workspaceId, c.f.session.id, written.sequenceNum])).rows)
        const optimized = (await client.query('SELECT value FROM read_native_application_session_history($1,$2,$3)',
          [c.f.workspaceId, c.f.session.id, written.sequenceNum])).rows
        const fields = []
        for (const source of c.evidence.sources!.filter(source => source.resourceKind === 'application_field')) {
          const metadata = (await c.f.pool.query('SELECT type_key,selection FROM application_field_resources WHERE id=$1', [source.resourceId])).rows[0]
          fields.push({ ...metadata, held: (await operation(client, c.f.workspaceId, 'field', { id: source.resourceId, version: source.version })).value?.held })
        }
        return { value: { originalRows: original.length, optimizedRows: optimized.length, actualRows: history.history.length, fields },
          sources: optimized.flatMap(row => row.value.sources) }
      })
      expect.fail(`Synthetic reply was withheld after publication: ${JSON.stringify(diagnosis)}`)
    }
    const root = { id: written.id, version: boundScopeSources(written)[0].version }
    const extendedKey = `empty-native:session_message:${root.id}:${root.version}`
    const captured = await frame(c.execution, async client => {
      const first = await operation(client, c.f.workspaceId, 'scope', root)
      expect(first.value).toBe(true)
      expect(first.memo[extendedKey]?.value).toBe(true)
      expect(Object.keys(first.memo.emptyQueries ?? {}).length).toBeGreaterThanOrEqual(2)
      expect((await operation(client, c.f.workspaceId, 'scope', { ...root, memo: first.memo })).value).toBe(true)
      await client.query('SAVEPOINT native_helper_drift')
      try {
        await operation(client, c.f.workspaceId, 'body')
        const fallback = await operation(client, c.f.workspaceId, 'scope', { ...root, memo: first.memo })
        expect(fallback.value).toBe(true)
        expect(fallback.memo).not.toHaveProperty(extendedKey)
        expect(fallback.memo).not.toHaveProperty('emptyQueries')
      } finally { await client.query('ROLLBACK TO SAVEPOINT native_helper_drift') }
      return first
    })
    await knowledge.create({ workspaceId: c.f.workspaceId, path: 'fictional-later', title: 'Fictional later candidate',
      content: 'Fictional content after reply', sensitivity: 'internal', createdBy: c.f.ownerId })
    await frame(c.execution, async client => {
      const expected = await baseline(client, c.f.workspaceId, () => operation(client, c.f.workspaceId, 'scope', root))
      const actual = await operation(client, c.f.workspaceId, 'scope', { ...root, memo: captured.memo })
      expect(actual.value).toBe(expected.value)
      expect(actual.value).toBe(false)
    })
    await c.f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [c.f.workspaceId, c.f.firstId])
    await expect(publishNativeSessionMessage({ ...input, authority: fresh })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect((await c.f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1', [c.f.session.id])).rows[0].count).toBe(4)
  })

  for (const sensitivity of ['internal', 'confidential'] as const) it(`rechecks an empty domain after a new ${sensitivity} candidate`, async () => {
    const c = await setup(), domain = c.domains.find(value => value.type === 'knowledge_entry')!
    const captured = await frame(c.execution, client => operation(client, c.f.workspaceId, 'field', domain))
    expect(Object.keys(captured.memo.emptyQueries ?? {})).toHaveLength(1)
    await knowledge.create({ workspaceId: c.f.workspaceId, path: 'fictional-added', title: 'Fictional new candidate', content: 'Fictional new content', sensitivity, createdBy: c.f.ownerId })
    await frame(c.execution, async client => {
      const current = await operation(client, c.f.workspaceId, 'current', captured.memo)
      expect(current).toBe(sensitivity === 'confidential')
      const read = () => operation(client, c.f.workspaceId, 'field', domain)
      expect((await read()).value).toEqual((await baseline(client, c.f.workspaceId, read)).value)
      const validate = () => outcome(client, () => validateCallerScopeEvidence(c.evidence, c.execution.security.ceiling, client))
      const actual = await validate()
      expect(actual).toEqual(await baseline(client, c.f.workspaceId, validate))
      expect('error' in actual).toBe(sensitivity === 'internal')
    })
  })

  it('invalidates an actually empty Task domain when a visible task is created', async () => {
    const c = await setup(), domain = c.domains.find(value => value.type === 'task')!
    const captured = await frame(c.execution, client => operation(client, c.f.workspaceId, 'field', domain))
    expect(Object.keys(captured.memo.emptyQueries ?? {})).toHaveLength(1)
    await createTask(c.f.firstId, { workspaceId: c.f.workspaceId, title: 'Fictional added task', access: c.execution.security.access,
      sensitivity: 'internal', visibility: { userId: null, assistantId: null } })
    await frame(c.execution, async client => {
      expect(await operation(client, c.f.workspaceId, 'current', captured.memo)).toBe(false)
      const read = () => operation(client, c.f.workspaceId, 'field', domain)
      expect((await read()).value).toEqual((await baseline(client, c.f.workspaceId, read)).value)
      expect((await read()).value).not.toMatchObject({ held: false })
    })
  })

  it('delegates newly derived file ancestry to the unchanged proof', async () => {
    const c = await setup(), output = boundScopeSources(c.files[0])[0], source = boundScopeSources(c.files[1])[0]
    await recordDerivedResource(c.f.pool, { producer: 'fixture:new-file-lineage', sources: [source] }, output, c.f.firstId)
    await frame(c.execution, async client => {
      expect(await operation(client, c.f.workspaceId, 'proof', roots(c.evidence.sources!))).toBeNull()
      const read = () => outcome(client, () => validateCallerScopeEvidence(c.evidence, c.execution.security.ceiling, client))
      const result = await read()
      expect(result).toEqual(await baseline(client, c.f.workspaceId, read))
      expect(result).toHaveProperty('value')
    })
  })

  it('preserves busy cycle sentinels and the original Memory proof when discarding completed entries', async () => {
    const c = await setup(), domain = c.domains[0], key = `field:${domain.id}:${domain.version}`
    const memoryStatement = { workspaceId: c.f.workspaceId, marker: 'synthetic-original-proof' }
    const memo = { [key]: { busy: true }, 'field:completed': { value: { held: false } },
      'empty-native:completed': { value: true }, emptyQueries: { synthetic: {} }, memoryStatement }
    await frame(c.execution, async client => {
      expect(await operation(client, c.f.workspaceId, 'reset', memo)).toEqual({ [key]: { busy: true }, memoryStatement })
      const read = () => operation(client, c.f.workspaceId, 'field', { ...domain, memo })
      expect((await read()).value).toBeUndefined()
      expect((await baseline(client, c.f.workspaceId, read)).value).toBeUndefined()
    })
  })

  it('refuses a cyclic field dependency graph after an empty observation was captured', async () => {
    const c = await setup(), [first, second] = c.domains
    const captured = await frame(c.execution, client => operation(client, c.f.workspaceId, 'field', first))
    await c.f.pool.query(`INSERT INTO application_field_observation_sources(workspace_id,resource_id,version,source_kind,source_id,source_version)
      VALUES($1,$2,$3,'application_field',$4,$5),($1,$4,$5,'application_field',$2,$3)`,
    [c.f.workspaceId, first.id, first.version, second.id, second.version])
    await frame(c.execution, async client => {
      expect(await operation(client, c.f.workspaceId, 'current', captured.memo)).toBe(false)
      const read = () => outcome(client, () => operation(client, c.f.workspaceId, 'field', { ...first, memo: captured.memo }))
      const actual = await read()
      expect(actual).toEqual(await baseline(client, c.f.workspaceId, read))
      if ('value' in actual) expect(actual.value.value).not.toMatchObject({ held: false })
    })
  })

  for (const mutation of ['drift', 'grant'] as const) it(`falls back to original evaluation after private helper ${mutation}`, async () => {
    const c = await setup(), domain = c.domains[0]
    await frame(c.execution, async client => {
      const captured = await operation(client, c.f.workspaceId, 'field', domain)
      const expected = (await baseline(client, c.f.workspaceId, () => operation(client, c.f.workspaceId, 'field', domain))).value
      await operation(client, c.f.workspaceId, mutation)
      expect(await operation(client, c.f.workspaceId, 'proof', roots(c.evidence.sources!))).toBeNull()
      expect((await operation(client, c.f.workspaceId, 'field', { ...domain, memo: captured.memo })).value).toEqual(expected)
    })
  })

  for (const mutation of ['body', 'reset_body'] as const) it(`discards retained native results after helper ${mutation} changes`, async () => {
    const c = await setup(), domain = c.domains[0]
    const native = (await c.f.pool.query<{ id: string; version: string }>(`SELECT r.id,o.version
      FROM application_field_resources r JOIN application_field_observations o ON o.workspace_id=r.workspace_id AND o.resource_id=r.id
      WHERE r.workspace_id=$1 AND r.type_key='session_message' AND r.resource_id=$2 AND r.selection='query'
        AND r.id=ANY($3::uuid[])`, [c.f.workspaceId, c.history[0].id, c.evidence.sources!.map(source => source.resourceId)])).rows[0]
    expect(native).toBeDefined()
    const captured = await frame(c.execution, async client => {
      const empty = await operation(client, c.f.workspaceId, 'field', domain)
      return operation(client, c.f.workspaceId, 'field', { ...native, memo: empty.memo })
    })
    expect(captured.memo[`field:${native.id}:${native.version}`]?.value).toMatchObject({ held: false })
    const activeKey = 'field:synthetic-active', completedKey = 'field:synthetic-completed'
    const memoryStatement = { workspaceId: c.f.workspaceId, marker: 'synthetic proof without Memory roots' }
    captured.memo = { ...captured.memo, [activeKey]: { busy: true }, [completedKey]: { value: { held: false } }, memoryStatement }
    await c.f.pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1', [c.history[0].id])
    await frame(c.execution, async client => {
      const expected = (await baseline(client, c.f.workspaceId, () => operation(client, c.f.workspaceId, 'field', native))).value
      expect(expected).not.toMatchObject({ held: false })
      await operation(client, c.f.workspaceId, mutation)
      const actual = await operation(client, c.f.workspaceId, 'field', { ...native, memo: captured.memo })
      expect(actual.value).toEqual(expected)
      expect(actual.memo[activeKey]).toEqual({ busy: true })
      expect(actual.memo.memoryStatement).toEqual(memoryStatement)
      expect(actual.memo).not.toHaveProperty(completedKey)
    })
  })

  for (const hold of ['source', 'recording privacy'] as const) it(`retains canonical worklist overflow and ${hold} hold refusal`, async () => {
    const c = await setup(), domain = c.domains[0]
    await frame(c.execution, async client => {
      const memo = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`field:synthetic-${i}`, { value: { held: false } }]))
      const read = () => operation(client, c.f.workspaceId, 'field', { ...domain, memo })
      expect((await read()).value).toEqual((await baseline(client, c.f.workspaceId, read)).value)
      expect((await read()).value).toBeUndefined()
    })
    if (hold === 'source') {
      const source = boundScopeSources(c.files[0])[0]
      await c.f.pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
        VALUES($1,'workspace_file',$2,$3,'held',1,'Fictional review hold')`, [c.f.workspaceId, source.resourceId, source.version])
    } else await c.f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1', [c.f.session.id])
    await frame(c.execution, async client => {
      const read = () => outcome(client, () => validateCallerScopeEvidence(c.evidence, c.execution.security.ceiling, client))
      const actual = await read()
      expect(actual).toEqual(await baseline(client, c.f.workspaceId, read))
      expect(actual).toHaveProperty('error')
    })
  })
})
