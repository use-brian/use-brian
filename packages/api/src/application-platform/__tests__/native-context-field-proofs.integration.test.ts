import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { listWorkspaceFilesIndexRanked } from '../../db/workspace-files.js'
import { addSessionMessage } from '../../db/sessions.js'
import { readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { withSessionMessagePublication, writeSessionContextRevision, readSessionContextRevisions } from '../../db/session-context-revisions.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const fixtureName = `context_fields_${randomUUID().replaceAll('-', '')}`
const rollback = new Error('Fictional context proof rollback')
let f: Awaited<ReturnType<typeof persistentContextFixture>>
let execution: ExecutionContext
let sources: ScopeSource[]
let file: ScopeSource
let messageId: string
const authority = () => ({ execution, accumulator: new ContextScopeAccumulator() })
async function action<T = any>(client: Pick<PoolClient, 'query'>, kind: string, payload: unknown = {}): Promise<T> {
  return (await client.query<{ value: T }>(`SELECT public.${fixtureName}($1,$2,$3) value`, [f.workspaceId, kind, JSON.stringify(payload)])).rows[0].value
}
async function tx(run: (client: PoolClient) => Promise<void>) {
  await expect(withSessionMessagePublication(authority(), sources, async client => { await run(client);throw rollback })).rejects.toBe(rollback)
}
async function savepoint<T>(client: PoolClient, run: () => Promise<T>) {
  await client.query('SAVEPOINT context_proof_case')
  try { return await run() } finally { await client.query('ROLLBACK TO SAVEPOINT context_proof_case') }
}
async function publish(client: PoolClient, kind = 'session_title', id = randomUUID(), input = sources) {
  return (await client.query<{ value: any }>('SELECT publish_native_session_context_revision($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,NULL) value',
    [f.workspaceId, f.session.id, kind, kind === 'session_title' ? f.session.id : messageId, id,
      kind === 'session_title' ? { title: 'Fictional proof title', manual: false } : { topicLabel: 'Fictional proof topic', topicConfidence: 0.9, replyToText: null },
      'fixture:context-field-proof', JSON.stringify(input)])).rows[0].value
}
async function outcome(run: () => Promise<unknown>) {
  try { return { value: await run() } } catch (error) { const failure = error as { code?: string; message: string };return { code: failure.code, message: failure.message } }
}

describe.sequential('[COMP:api/application-persistence] native context field proof passes', () => {
  beforeAll(async () => {
    f = await persistentContextFixture()
    await f.pool.query(`INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
      VALUES($1,'/fictional/context-proof.txt','Fictional context proof','fixture://context-proof',$2,'user','internal')`, [f.workspaceId, f.ownerId])
    const initial = await f.execution(f.firstId)
    const ceiling = { ...initial.security.ceiling, clearance: f.envelope.sensitivity, compartments: [], mutationCompartments: [], projectIds: [] }
    execution = (await resolveExecutionContextSystem({ userId: f.firstId, workspaceId: f.workspaceId,
      assistant: (await findAssistantById(f.assistantId))!, memberMode: 'member', sharedAudience: true,
      session: f.session, sessionAuthority: f.session, identity: initial.identity, ownership: initial.ownership,
      lifecycle: initial.lifecycle, maximumAccess: ceiling, maximumAccessCurrent: async () => ceiling })).executionContext
    file = (await listWorkspaceFilesIndexRanked(execution.security.access, 50)).flatMap(boundScopeSources)[0]
    const message = await addSessionMessage({ sessionId: f.session.id, role: 'user', content: 'Fictional current request', scope: f.envelope })
    messageId = message.id
    const memory = await createDbMemoryStore().getIndex(execution.security.access, false, authority())
    const query = await readAdmittedSessionQuery({ sessionId: f.session.id, throughSequence: message.sequenceNum, topicThroughSequence: 0, authority: authority() })
    const raw = (await f.pool.query('SELECT read_scope_source($1,\'session_message\',$2) value', [f.workspaceId, messageId])).rows[0].value
    delete raw.held;delete raw.validTo;delete raw.retractedAt
    sources = new ContextScopeAccumulator({ sources: [...boundScopeSources(query), ...boundScopeSources(memory), file, raw] }).evidence.sources!
    await f.pool.query(`CREATE FUNCTION public.${fixtureName}(w uuid,action text,payload jsonb) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE definition text;body text;signature text;
      BEGIN
        IF action='stats' THEN RETURN jsonb_build_object('proof',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='conversation_dag(uuid,jsonb,jsonb)'::regprocedure),0),
          'legacy',coalesce((SELECT calls FROM pg_stat_xact_user_functions WHERE funcid='read_native_context_field_currents(uuid,jsonb)'::regprocedure),0),
          'rows',(SELECT count(*) FROM session_context_scope_revisions WHERE workspace_id=w),
          'heads',(SELECT count(*) FROM session_title_heads WHERE workspace_id=w));
        ELSIF action='track' THEN PERFORM set_config('track_functions','all',true);RETURN 'true'::jsonb;
        ELSIF action='helper' THEN RETURN read_native_context_field_currents(w,payload);
        ELSIF action='guard' THEN RETURN to_jsonb(application_native_context_fields_current());
        ELSIF action='disable' OR action='guard_body' OR action='helper_body' THEN
          signature:=CASE WHEN action='helper_body' THEN 'conversation_dag(uuid,jsonb,jsonb)' ELSE 'native_turn_helpers_current()' END;
          IF action<>'helper_body' THEN EXECUTE 'ALTER FUNCTION public.native_turn_helpers_current() COST 101';RETURN 'true'::jsonb;END IF;
          SELECT pg_get_functiondef(oid),prosrc INTO definition,body FROM pg_proc WHERE oid=signature::regprocedure;
          EXECUTE replace(definition,body,CASE WHEN action='disable' THEN 'BEGIN RETURN false;END' ELSE 'BEGIN RAISE EXCEPTION ''fictional_unknown_context_helper_invoked'';END' END);RETURN 'true'::jsonb;
        ELSIF action='hold' THEN INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
          VALUES(w,'workspace_file',(payload->>'id')::uuid,'1','held',1,'Fictional context proof hold');RETURN 'true'::jsonb;
        ELSIF action='arm' THEN PERFORM set_config('app.fictional_context_proof_drift',payload->>'mode',true);RETURN 'true'::jsonb;
        ELSIF action='acl' THEN RETURN jsonb_build_object('helper',has_function_privilege('app_user','conversation_dag(uuid,jsonb,jsonb)','EXECUTE'),
          'guard',has_function_privilege('app_user','native_turn_helpers_current()','EXECUTE'));
        END IF;
        RAISE EXCEPTION 'Unknown fictional action';
      END $fixture$;
      REVOKE ALL ON FUNCTION public.${fixtureName}(uuid,text,jsonb) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.${fixtureName}(uuid,text,jsonb) TO app_user`)
    await f.pool.query(`CREATE FUNCTION public.${fixtureName}_after() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture$
      DECLARE definition text;body text;mode text:=current_setting('app.fictional_context_proof_drift',true);
      BEGIN
        IF NEW.workspace_id='${f.workspaceId}'::uuid AND mode IN('guard','hold')
         AND EXISTS(SELECT 1 FROM session_context_scope_revisions WHERE workspace_id=NEW.workspace_id AND id=NEW.revision_id AND parent_kind='session_title') THEN
          IF mode='guard' THEN
           ALTER FUNCTION public.native_turn_helpers_current() COST 101;
          END IF;
          IF mode='hold' THEN INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
            VALUES(NEW.workspace_id,'workspace_file','${file.resourceId}'::uuid,'1','held',1,'Fictional context proof hold');END IF;
        END IF;
        RETURN NULL;
      END $fixture$;
      CREATE TRIGGER ${fixtureName}_after AFTER INSERT ON session_context_revision_contents FOR EACH ROW EXECUTE FUNCTION public.${fixtureName}_after()`)
  }, 120_000)
  afterAll(async () => {
    if (f) {
      await f.pool.query(`DROP TRIGGER IF EXISTS ${fixtureName}_after ON session_context_revision_contents;DROP FUNCTION IF EXISTS public.${fixtureName}_after();DROP FUNCTION IF EXISTS public.${fixtureName}(uuid,text,jsonb)`)
      await f.cleanup()
    }
    await getAppPool().end();await getPool().end()
  })
  it('commits and reads a real annotation with the complete original sources', async () => {
    const revision = await writeSessionContextRevision({ sessionId: f.session.id, parentId: messageId, kind: 'message_annotation',
      content: { topicLabel: 'Fictional committed topic', topicConfidence: 0.9, replyToText: null }, authority: authority(),
      derivation: { producer: 'fixture:context-field-proof', sources } })
    expect(revision).not.toBeNull()
    const read = await readSessionContextRevisions(f.session.id, 'message_annotation', authority(), { parentId: messageId })
    expect(read[0].content.topicLabel).toBe('Fictional committed topic')
  })
  it('preserves full title output and performs two independent proof passes without duplicate DML', async () => {
    await tx(async client => {
      await action(client, 'track');const before = await action(client, 'stats'), id = randomUUID()
      const actual = await publish(client, 'session_title', id)
      await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
      const after = await action(client, 'stats')
      expect(actual.source).toMatchObject({resourceKind:'session_context_revision',resourceId:id})
      expect(Number.isFinite(new Date(actual.createdAt).getTime())).toBe(true)
      expect(after.proof - before.proof).toBe(2)
      expect(after.legacy - before.legacy).toBe(0)
      expect(after.rows - before.rows).toBe(2);expect(after.heads - before.heads).toBe(1)
      await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')
    })
  })
  it.each(['guard_body', 'helper_body'])('refuses changed %s before executing untrusted SQL or writing', async kind => {
    await tx(async client => {
      const before = await action(client, 'stats')
      const result = await savepoint(client, async () => {
        await action(client, kind)
        return outcome(() => publish(client))
      })
      expect(result).toMatchObject({code:'42501',message:'scope_source_changed'})
      expect((await action(client, 'stats')).rows).toBe(before.rows)
    })
  })
  it('refuses malformed source identity before publication', async () => {
    await tx(async client => {
      const malformed = [{ ...sources[0], resourceId: 'fictional-invalid-id' }]
      const before = await action(client,'stats')
      const result = await savepoint(client, () => outcome(() => publish(client,'session_title',randomUUID(),malformed as ScopeSource[])))
      expect(result).toHaveProperty('code')
      expect((await action(client,'stats')).rows).toBe(before.rows)
    })
  })
  it('retains the original current-source refusal for a held file before any DML', async () => {
    await tx(async client => {
      await action(client, 'hold', { id: file.resourceId });const before = await action(client, 'stats')
      const actual = await savepoint(client, () => outcome(() => publish(client)))
      expect(actual).toHaveProperty('code', '42501')
      expect((await action(client, 'stats')).rows).toBe(before.rows)
    })
  })
  it('rolls back title publication when the contract changes after the first write', async () => {
    await tx(async client => {
      const before = await action(client,'stats')
      const result = await savepoint(client, async () => {
        await action(client,'arm',{mode:'guard'})
        return outcome(() => publish(client))
      })
      expect(result).toMatchObject({code:'42501',message:'scope_source_changed'})
      expect((await action(client,'stats')).rows).toBe(before.rows)
    })
  })
  it('rejects a real hold appearing between title passes and rolls all DML back', async () => {
    await tx(async client => {
      const before = await action(client, 'stats')
      const result = await savepoint(client, async () => { await action(client, 'arm', { mode: 'hold' });return outcome(async () => {await publish(client);await client.query('SET CONSTRAINTS application_field_derivation_dependencies IMMEDIATE')}) })
      expect(result).toHaveProperty('code', '42501');expect(result).not.toHaveProperty('message', 'fictional_unknown_context_guard_invoked')
      expect((await action(client, 'stats')).rows).toBe(before.rows)
    })
  })
  it('keeps both proof helpers private', async () => {
    expect(await action(f.pool, 'acl')).toEqual({ helper: false, guard: false })
  })
})
