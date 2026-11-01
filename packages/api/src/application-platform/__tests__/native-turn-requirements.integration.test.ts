import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { boundScopeSources, ContextScopeAccumulator, type ExecutionContext } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from '../../db/client.js'
import { readAdmittedSessionQuery } from '../../db/session-query-reader.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { findAssistantById } from '../../db/users.js'
import { listWorkspaceFilesIndexRanked } from '../../db/workspace-files.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { publishNativeSessionMessage } from '../../db/session-message-publication.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
type Json = Record<string, any>
const wrapper = `turn_requirements_fixture_${randomUUID().replaceAll('-', '')}`
let f: Awaited<ReturnType<typeof persistentContextFixture>>, execution: ExecutionContext
let roots: { kind: string; id: string; version: string }[]
let plainRoots: typeof roots
let pointRoots: typeof roots
let messageId: string
async function operation(client: PoolClient, action: string, payload: unknown = {}): Promise<Json> {
  return (await client.query(`SELECT ${wrapper}($1,$2,$3) value`, [f.workspaceId, action, JSON.stringify(payload)])).rows[0].value
}
async function frame<T>(run: (client: PoolClient) => Promise<T>, isolation = 'REPEATABLE READ') {
  const client = await getAppPool().connect()
  try {
    return await runWithAgentAccess(execution.security.access, async () => {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`)
      await applyRLSGucs(client, execution.security.access.userId)
      await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [execution.assistant.id])
      return run(client)
    })
  } finally { await rollbackAndRelease(client) }
}
const sorted = (rows: Json[]) => rows.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))

describe.sequential('[COMP:api/native-turn-frame] distinct native requirements', () => {
  beforeAll(async () => {
    f = await persistentContextFixture()
    const history = await f.history();messageId = history[0].id
    const unbounded = await f.execution(f.firstId), maximumAccess = { ...unbounded.security.ceiling,
      clearance: f.envelope.sensitivity, compartments: f.envelope.compartments, mutationCompartments: [], projectIds: f.envelope.projectIds }
    execution = (await resolveExecutionContextSystem({ userId: f.firstId, workspaceId: f.workspaceId,
      assistant: (await findAssistantById(f.assistantId))!, memberMode: 'member', sharedAudience: true,
      session: f.session, sessionAuthority: f.session, identity: unbounded.identity, ownership: unbounded.ownership,
      lifecycle: unbounded.lifecycle, maximumAccess, maximumAccessCurrent: async () => maximumAccess })).executionContext
    const file = (await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
      VALUES($1,'/fictional/requirements.txt','Fictional dependency file','fixture://requirements',$2,'user','internal') RETURNING id,scope_version::text version`, [f.workspaceId,f.ownerId])).rows[0]
    const files = (await listWorkspaceFilesIndexRanked(execution.security.access, 10)).flatMap(boundScopeSources)
    for (let turn = 0; turn < 2; turn++) {
      const authority = { execution, accumulator: new ContextScopeAccumulator() }
      const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: 3 + turn, authority })
      const memory = await createDbMemoryStore().getIndex(execution.security.access, false, authority)
      if (turn === 0) pointRoots = boundScopeSources(query.history[0]).map(source => ({ kind: source.resourceKind, id: source.resourceId, version: source.version }))
      await publishNativeSessionMessage({ sessionId: f.session.id, role: 'assistant', content: `Fictional dependency reply ${turn}`,
        senderAssistantId: f.assistantId, authority, derivationTarget: f.envelope,
        derivation: { producer: 'fixture:native-requirements', sources: [...boundScopeSources(query), ...boundScopeSources(memory), ...files] } })
    }
    roots = (await f.pool.query("SELECT 'session_message' kind,id,scope_version::text version FROM session_messages WHERE session_id=$1 ORDER BY id", [f.session.id])).rows
    plainRoots = roots.filter(root => history.some(message => message.id === root.id))
    plainRoots.push({ kind: 'workspace_file', id: file.id, version: file.version })
    roots.push({ kind: 'workspace_file', id: file.id, version: file.version })
    pointRoots.push({ kind: 'workspace_file', id: file.id, version: file.version })
    await f.pool.query(`CREATE FUNCTION ${wrapper}(w uuid,action text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE ks text[];ids uuid[];vs text[];
      BEGIN
        IF action='read' THEN RETURN read_native_turn_requirements(w,payload);
        ELSIF action='canonical' THEN
          SELECT array_agg(n->>'kind'),array_agg((n->>'id')::uuid),array_agg(n->>'version') INTO ks,ids,vs FROM jsonb_array_elements(payload) n;
          RETURN read_native_file_session_cohort_frame(w,ks,ids,vs,true);
        ELSIF action='history' THEN RETURN (SELECT jsonb_agg(value) FROM read_native_application_session_history(w,(payload->>'session')::uuid,(payload->>'through')::integer));
        ELSIF action='v2' THEN UPDATE workspaces SET department_read_v2=true WHERE id=w;
        ELSIF action='head' THEN RETURN publish_native_session_context_revision(w,(payload->>'session')::uuid,'message_annotation',
          (payload->>'id')::uuid,gen_random_uuid(),'{"topicLabel":"Fictional new topic","topicConfidence":0.9,"replyToText":null}',
          'fixture:native-requirements',payload->'sources',NULL,NULL,NULL);
        ELSIF action='manifest' THEN DELETE FROM native_turn_contract_helpers WHERE signature='native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)';
        ELSIF action='drift' THEN ALTER FUNCTION native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb) COST 101;
        ELSIF action='trace' THEN PERFORM set_config('track_functions','all',true);
        ELSIF action='stats' THEN RETURN coalesce((SELECT jsonb_object_agg(p.proname,s.calls) FROM pg_stat_xact_user_functions s JOIN pg_proc p ON p.oid=s.funcid),'{}');
        ELSIF action='hold' THEN UPDATE session_messages SET scope_held=true WHERE workspace_id=w AND id=(payload->>'id')::uuid;
        ELSIF action='version' THEN UPDATE session_messages SET scope_version=scope_version+1 WHERE workspace_id=w AND id=(payload->>'id')::uuid;
        ELSIF action='body' THEN UPDATE session_messages SET content='[{"type":"text","text":"Fictional changed body"}]' WHERE workspace_id=w AND id=(payload->>'id')::uuid;
        ELSIF action='revoke' THEN UPDATE workspace_members SET clearance='public' WHERE workspace_id=w AND user_id=(payload->>'id')::uuid;
        ELSIF action='privacy' THEN UPDATE sessions SET recording_privacy_held=true WHERE workspace_id=w AND id=(payload->>'id')::uuid;
        ELSE RAISE EXCEPTION 'Unknown fixture operation';END IF;
        RETURN '{}'::jsonb;
      END $fixture$;
      REVOKE ALL ON FUNCTION ${wrapper}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION ${wrapper}(uuid,text,jsonb) TO app_user`)
  }, 120_000)
  afterAll(async () => {
    try { await getPool().query(`DROP FUNCTION IF EXISTS ${wrapper}(uuid,text,jsonb)`);await f?.cleanup() }
    finally { await getAppPool().end();await getPool().end() }
  })
  it('matches complete canonical current and immutable evidence on overlapping legacy history', async () => frame(async client => {
    const actual = await operation(client, 'read', roots), canonical = await operation(client, 'canonical', roots)
    expect(actual.available).toBe(true);expect(actual.admitted).toBe(true);expect(canonical.admitted).toBe(true)
    expect(sorted(actual.current)).toEqual(sorted(canonical.current))
    expect(sorted(actual.immutable)).toEqual(sorted(canonical.immutable))
    expect(actual.counts.points).toBeGreaterThan(0)
  }), 30_000)
  it('reads each distinct point once without recursive field or scope evaluation', async () => frame(async client => {
    await operation(client, 'trace')
    const actual = await operation(client, 'read', roots), stats = await operation(client, 'stats')
    expect(actual.available).toBe(true)
    expect(stats.native_turn_read_point).toBe(actual.counts.points)
    expect(stats.native_detached_eval_point_state ?? 0).toBe(0)
    expect(stats.native_detached_eval_field ?? 0).toBe(0)
    expect(stats.native_detached_eval_scope ?? 0).toBe(0)
    expect(stats.read_external_source_dependencies ?? 0).toBe(0)
  }), 30_000)
  it('keeps all private state and payload readers unavailable to the application role', async () => frame(async client => {
    const rows = (await client.query(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
      AND (p.proname LIKE 'native_turn_%' OR p.proname='read_native_turn_requirements')
      AND has_function_privilege(current_user,p.oid,'EXECUTE')`)).rows
    expect(rows).toEqual([])
  }))
  it('captures a coherent statement under read committed', async () => {
    expect((await frame(client => operation(client, 'read', roots), 'READ COMMITTED')).available).toBe(true)
  })
  it('does not admit a newly held source', async () => frame(async client => {
    await operation(client, 'hold', { id: messageId })
    expect((await operation(client, 'read', roots)).available).toBe(false)
  }))
  it('sees a separately committed contraction at the next read-committed boundary', async () => {
    try {
      expect((await frame(client => operation(client, 'read', roots), 'READ COMMITTED')).available).toBe(true)
      await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId,f.firstId])
      expect((await frame(client => operation(client, 'read', roots), 'READ COMMITTED')).available).toBe(false)
    } finally { await f.pool.query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId,f.firstId]) }
  })
  it('holds the original member mutation fence until the boundary transaction ends', async () => frame(async client => {
    expect((await operation(client, 'read', roots)).available).toBe(true)
    const writer = await f.pool.connect()
    try {
      await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'")
      await expect(writer.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId,f.firstId])).rejects.toMatchObject({ code: '55P03' })
    } finally { await writer.query('ROLLBACK');writer.release() }
  }))
  it('does not reuse an earlier membership permission', async () => frame(async client => {
    expect((await operation(client, 'read', roots)).available).toBe(true)
    await operation(client, 'revoke', { id: f.firstId })
    expect((await operation(client, 'read', roots)).available).toBe(false)
  }))
  it('keeps the complete recording privacy path for held sessions', async () => frame(async client => {
    await operation(client, 'privacy', { id: f.session.id })
    expect((await operation(client, 'read', roots)).available).toBe(false)
  }))
  it('recomputes payload witnesses even when the source version is unchanged', async () => frame(async client => {
    const before = await operation(client, 'read', roots)
    await operation(client, 'body', { id: messageId })
    const after = await operation(client, 'read', roots)
    expect(before.available).toBe(true)
    expect(after.available).toBe(false)
  }), 30_000)
  it('emits only the original cohort after a live source version advances', async () => frame(async client => {
    await operation(client, 'version', { id: messageId })
    const actual = await operation(client, 'read', pointRoots), canonical = await operation(client, 'canonical', pointRoots)
    expect(actual.available).toBe(true);expect(canonical.admitted).toBe(true)
    expect(sorted(actual.current)).toEqual(sorted(canonical.current))
    expect(sorted(actual.immutable)).toEqual(sorted(canonical.immutable))
  }))
  it('matches native source admission under the v2 department policy', async () => frame(async client => {
    await operation(client, 'v2')
    const actual = await operation(client, 'read', plainRoots), canonical = await operation(client, 'canonical', plainRoots)
    expect(actual.available).toBe(true);expect(canonical.admitted).toBe(true)
    expect(sorted(actual.current)).toEqual(sorted(canonical.current))
    expect(sorted(actual.immutable)).toEqual(sorted(canonical.immutable))
  }))
  it('invalidates a frozen negative annotation when a new head appears', async () => frame(async client => {
    const source = { ...f.envelope, resourceKind: 'session_message', resourceId: messageId, version: '1' }
    await operation(client, 'head', { session: f.session.id, id: messageId, sources: [source] })
    expect((await operation(client, 'read', roots)).available).toBe(false)
  }), 30_000)
  it('falls back for a denied physical candidate without globally denying its valid empty query', async () => frame(async client => {
    await operation(client, 'hold', { id: messageId })
    const rows = await operation(client, 'history', { session: f.session.id, through: 1 })
    const candidates = (rows as unknown as Json[]).flatMap(row => row.sources).map(source => ({ kind: source.resourceKind, id: source.resourceId, version: source.version }))
    candidates.push(roots.find(root => root.kind === 'workspace_file')!)
    expect((await operation(client, 'read', candidates)).available).toBe(false)
    expect((await operation(client, 'canonical', candidates)).admitted).toBe(true)
  }), 30_000)
  it('does not admit direct domain metadata as source authority', async () => frame(async client => {
    expect((await operation(client, 'read', [{ kind: 'application_query_domain', id: randomUUID(), version: '1' }])).available).toBe(false)
  }))
  it('refuses changed private helper contracts before selecting payload', async () => frame(async client => {
    await operation(client, 'drift')
    const result = await operation(client, 'read', roots)
    expect(result).toEqual({ available: false, reason: 'reader_contract_changed' })
  }))
  it('rejects a missing helper-manifest entry', async () => frame(async client => {
    await operation(client, 'manifest')
    expect(await operation(client, 'read', roots)).toEqual({ available: false, reason: 'reader_contract_changed' })
  }))
  it.each(['workflow_evidence_envelope_visible(uuid,jsonb)','application_query_scope_admits_point(jsonb,jsonb)'])('authenticates preexisting %s before enrolling it into the reader contract', async signature => {
    const sql = (await readFile(new URL('../../../migrations/8183_native_turn_requirements.sql', import.meta.url), 'utf8'))
      .replace(/^BEGIN;$/m, '').replace(/COMMIT;\s*$/, '')
    const owner = await f.pool.connect()
    try {
      await owner.query('BEGIN')
      const original = (await owner.query("SELECT pg_get_functiondef(oid) definition,prosrc FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows[0]
      await owner.query(original.definition.replace(original.prosrc, 'BEGIN RETURN true;END'))
      await expect(owner.query(sql)).rejects.toThrow(/prerequisite body changed:/)
    } finally { await owner.query('ROLLBACK');owner.release() }
  })
  it.each([false,true])('sanitizes inherited private-helper grants and refuses unexpected grantees (%s)', async unexpected => {
    const sql = await readFile(new URL('../../../migrations/8183_native_turn_requirements.sql', import.meta.url), 'utf8')
    const sweep = sql.match(/DO \$\$ DECLARE f regprocedure; BEGIN FOR f IN SELECT oid::regprocedure FROM pg_proc[\s\S]*?END \$\$;/)![0]
    const owner = await f.pool.connect(), suffix = randomUUID().replaceAll('-', ''), probe = `native_turn_acl_probe_${suffix}`, role = `turn_acl_${suffix}`
    try {
      await owner.query('BEGIN')
      await owner.query('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO app_user')
      await owner.query(`CREATE FUNCTION ${probe}() RETURNS boolean LANGUAGE sql AS 'SELECT true'`)
      expect((await owner.query('SELECT has_function_privilege(\'app_user\',$1,\'EXECUTE\') allowed', [`${probe}()`])).rows[0].allowed).toBe(true)
      if (unexpected) {
        await owner.query(`CREATE ROLE ${role}`);await owner.query(`GRANT EXECUTE ON FUNCTION ${probe}() TO ${role}`)
        await expect(owner.query(sweep)).rejects.toThrow(/native_turn_private_acl/)
      } else {
        await owner.query(sweep)
        expect((await owner.query('SELECT has_function_privilege(\'app_user\',$1,\'EXECUTE\') allowed', [`${probe}()`])).rows[0].allowed).toBe(false)
      }
    } finally { await owner.query('ROLLBACK');owner.release() }
  })
  it('returns unavailable for an uncompiled family rather than an empty dependency list', async () => frame(async client => {
    expect((await operation(client, 'read', [{ kind: 'external_source', id: randomUUID(), version: '1' }])).available).toBe(false)
  }))
})
