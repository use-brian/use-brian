/** Actual forward migration and trigger under an isolated in-process SQL engine.
 * Canonical helper proof ports/member floor are controlled here; the native
 * HTTP suite exercises their production implementations under app_user.
 */
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
const migrations = new URL('../../../migrations/', import.meta.url)
const migration = await readFile(new URL('8331_project_chat_creation_admission.sql', migrations), 'utf8')
const previous = await readFile(new URL('8221_workspace_mcp_oauth.sql', migrations), 'utf8')
const portableSource = await readFile(new URL('8274_inputtable_executable_contracts.sql', migrations), 'utf8')
const executableType = portableSource.match(/CREATE TYPE public\.native_executable_contract_v1 AS\([\s\S]*?\n\);/)?.[0]
if (!executableType) throw new Error('Missing reviewed portable executable type')
const original = previous.slice(previous.indexOf('CREATE OR REPLACE FUNCTION public.require_session_creation_admission()'), previous.indexOf('END $function$;') + 'END $function$;'.length)
const w = '11111111-1111-4111-8111-111111111111', u = '22222222-2222-4222-8222-222222222222'
const a = '33333333-3333-4333-8333-333333333333', p = '44444444-4444-4444-8444-444444444444'
const other = '55555555-5555-4555-8555-555555555555'
let db: PGlite
beforeEach(async () => {
  db = new PGlite()
  await db.exec(`CREATE ROLE fixture_owner; GRANT CREATE ON SCHEMA public TO fixture_owner; SET ROLE fixture_owner;
    CREATE TABLE workspaces(id uuid,department_read_v2 boolean,project_shared_spaces boolean);
    CREATE TABLE assistants(id uuid,workspace_id uuid,clearance text);
    CREATE TABLE workspace_access_policies(workspace_id uuid,revision bigint,setup_state text,access_mode text,default_department_id uuid);
    CREATE TABLE workspace_members(workspace_id uuid,user_id uuid,role text,clearance text);
    CREATE TABLE workspace_projects(id uuid,workspace_id uuid,status text);
    CREATE TABLE project_shared_scopes(project_id uuid,workspace_id uuid,status text);
    CREATE TABLE project_shared_members(project_id uuid,user_id uuid,assistant_id uuid,expires_at timestamptz);
    CREATE TABLE sessions(id uuid DEFAULT gen_random_uuid(),assistant_id uuid,user_id uuid,workspace_id uuid,visibility text,
      mode text,anchor_kind text DEFAULT 'none',anchor_ref text,channel_type text,channel_id text,app_id text,app_origin text,
      effective_clearance text,context_group_id uuid,context_project_id uuid,context_compartments text[]);
    CREATE TABLE _migrations(name text);
    INSERT INTO _migrations VALUES('8328_conversation_graph_frontier.sql');
    ${executableType}
    CREATE TABLE native_turn_contract_helpers(signature text,contract public.native_executable_contract_v1 NOT NULL);
    CREATE FUNCTION sensitivity_rank(t text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
      SELECT array_position(ARRAY['public','internal','confidential'],t) $$;
    CREATE FUNCTION project_member_live(p uuid,k text,i uuid) RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS(SELECT 1 FROM project_shared_members WHERE project_id=p AND (expires_at IS NULL OR expires_at>clock_timestamp())
        AND CASE WHEN k='user' THEN user_id=i ELSE assistant_id=i END) $$;
    CREATE FUNCTION member_operation_scope_allows(w uuid,t text,c text[],mutation boolean) RETURNS boolean LANGUAGE sql AS $$
      SELECT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=current_setting('app.current_user_id')::uuid
       AND sensitivity_rank(t)<=sensitivity_rank(clearance)) $$;
    CREATE FUNCTION agent_visibility_allows(uuid,uuid,uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION personal_web_session_scope_allows(uuid,uuid,uuid,uuid,uuid,text[]) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
    ${original}
    REVOKE ALL ON FUNCTION require_session_creation_admission() FROM PUBLIC;
    CREATE TRIGGER zzzz_session_creation_admission BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION require_session_creation_admission();
    INSERT INTO workspaces VALUES('${w}',true,true);
    INSERT INTO assistants VALUES('${a}','${w}','internal');
    INSERT INTO workspace_access_policies VALUES('${w}',7,'ready','simple',NULL);
    INSERT INTO workspace_members VALUES('${w}','${u}','member','internal');
    INSERT INTO workspace_projects VALUES('${p}','${w}','active');
    INSERT INTO project_shared_scopes VALUES('${p}','${w}','active');
    INSERT INTO project_shared_members VALUES('${p}','${u}',NULL,NULL),('${p}',NULL,'${a}',NULL);
    SELECT set_config('app.current_user_id','${u}',false);`)
  // Use the actual ambient ceiling predicates, not receipt-supplied grants.
  for (const [file, start, end] of [
    ['573_agent_mutation_ceiling.sql', 'CREATE FUNCTION agent_mutation_scope_allows', 'DO $$'],
    ['585_agent_read_ceiling.sql', 'CREATE FUNCTION agent_scope_grant_allows', 'DO $$'],
  ]) {
    const sql = await readFile(new URL(file!, migrations), 'utf8')
    await db.exec(sql.slice(sql.indexOf(start!), sql.indexOf(end!)))
  }
  for (const name of ['native_turn_helpers_current','native_turn_publication_contract','native_retained_helpers_current']) {
    await db.exec(`CREATE FUNCTION ${name}() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$`)
  }
})
afterEach(async () => { await db?.close() })
const receipt = () => ({ protocol: '1', provenance: 'authenticated_chat_root', workspaceId: w, policyRevision: '7', actor: u, userId: u, assistantId: a, anchorKind: 'none', sensitivity: 'internal', channelType: 'web', channelId: 'fresh', appId: 'Use Brian', appOrigin: 'chat', groupId: null, projectId: p, compartments: [`project:${p}`] })
async function insert(patch: Record<string, unknown> = {}, row: { project?: string; label?: string; channel?: string; sensitivity?: string; group?: string } = {}) {
  await db.exec('BEGIN')
  try {
    await db.query("SELECT set_config('app.session_creation_admission',$1,true)", [JSON.stringify({ ...receipt(), ...patch })])
    return await db.query(`INSERT INTO sessions(assistant_id,user_id,workspace_id,visibility,channel_type,channel_id,app_id,app_origin,effective_clearance,context_group_id,context_project_id,context_compartments)
      VALUES($1,$2,$3,'workspace','web',$4,'Use Brian','chat',$5,$6,$7,$8) RETURNING id`, [a,u,w,row.channel ?? 'fresh',row.sensitivity ?? 'internal',row.group ?? null,row.project ?? p,[row.label ?? `project:${p}`]])
  } finally { await db.exec('ROLLBACK') }
}
async function state() {
  return (await db.query<{ metadata: unknown; body: string; registration: unknown }>(`SELECT to_jsonb(p)-'prosrc' metadata,p.prosrc body,(SELECT to_jsonb(t) FROM pg_trigger t WHERE t.tgname='zzzz_session_creation_admission') registration FROM pg_proc p WHERE p.oid='require_session_creation_admission()'::regprocedure`)).rows[0]!
}
describe.sequential('Project chat forward SQL admission', () => {
  it('preserves metadata/ACL/trigger registration, fixes the labelled room, and retains exact one-use receipts', async () => {
    const before = await state()
    await expect(insert()).rejects.toThrow('workspace_creation_scope_unavailable')
    await db.exec(migration)
    const after = await state()
    expect(after.metadata).toEqual(before.metadata); expect(after.registration).toEqual(before.registration)
    expect((await insert()).rows).toHaveLength(1)
    await db.exec('BEGIN')
    try {
      await db.query("SELECT set_config('app.session_creation_admission',$1,true)", [JSON.stringify(receipt())])
      const sql = `INSERT INTO sessions(assistant_id,user_id,workspace_id,visibility,channel_type,channel_id,app_id,app_origin,effective_clearance,context_project_id,context_compartments) VALUES('${a}','${u}','${w}','workspace','web','fresh','Use Brian','chat','internal','${p}',ARRAY['project:${p}'])`
      await db.exec(sql)
      expect((await db.query<{ value: string }>("SELECT current_setting('app.session_creation_admission',true) value")).rows[0]!.value).toBe('')
      await expect(db.exec(sql)).rejects.toThrow('workspace_creation_admission_required')
    } finally { await db.exec('ROLLBACK') }
  })
  it.each([
    { policyRevision: '6' }, { actor: other }, { assistantId: other }, { projectId: other },
    { channelId: 'wrong' }, { appOrigin: 'studio' }, { anchorKind: 'channel' }, { compartments: [] }, { sensitivity: 'public' },
  ])('refuses receipt mismatch %j before the new authority leg', async patch => {
    await db.exec(migration)
    await expect(insert(patch)).rejects.toThrow('workspace_creation_admission_required')
  })
  it.each([
    `DELETE FROM project_shared_members WHERE user_id='${u}'`,
    `DELETE FROM project_shared_members WHERE assistant_id='${a}'`,
    `UPDATE project_shared_members SET expires_at=clock_timestamp()-interval '1 second'`,
    `UPDATE project_shared_scopes SET status='quarantined'`,
    `UPDATE workspace_projects SET status='archived'`,
    `UPDATE workspaces SET project_shared_spaces=false`,
    `UPDATE workspaces SET department_read_v2=false`,
    `UPDATE workspace_members SET clearance='public'`,
    `UPDATE assistants SET clearance='confidential'`,
    `SELECT set_config('app.agent_project_ids','[]',false)`,
    `SELECT set_config('app.agent_mutation_compartments','[]',false)`,
    `SELECT set_config('app.agent_clearance','public',false)`,
  ])('rejects matching receipts after current authority changes: %s', async change => {
    await db.exec(migration); await db.exec(change)
    await expect(insert()).rejects.toThrow('workspace_creation_scope_unavailable')
  })
  it('rejects a Department/Project audience pair even with a matching receipt', async () => {
    await db.exec(migration)
    await expect(insert({ groupId: other }, { group: other })).rejects.toThrow('workspace_creation_scope_unavailable')
  })
  it('refuses unreviewed source, metadata, registration, and pin consumers without rebaselining', async () => {
    await db.exec(`ALTER FUNCTION require_session_creation_admission() SECURITY INVOKER`)
    await expect(db.exec(migration)).rejects.toThrow('project_chat_creation_predecessor_changed')
    await db.exec('ROLLBACK')
  })
  it('refuses the historical fingerprint registry instead of rebaselining it', async () => {
    await db.exec('ALTER TABLE native_turn_contract_helpers ADD COLUMN fingerprint text')
    await expect(db.exec(migration)).rejects.toThrow('project_chat_creation_canonical_predecessor_required')
    await db.exec('ROLLBACK')
  })
  it('refuses a disabled creation trigger', async () => {
    await db.exec('ALTER TABLE sessions DISABLE TRIGGER zzzz_session_creation_admission')
    await expect(db.exec(migration)).rejects.toThrow('query returned no rows')
    await db.exec('ROLLBACK')
  })
  it('refuses an unexpected body pin consumer', async () => {
    await db.exec(`DO $$ BEGIN EXECUTE 'CREATE FUNCTION unexpected_pin() RETURNS text LANGUAGE sql AS '||quote_literal('SELECT '||quote_literal((SELECT prosrc FROM pg_proc WHERE oid='require_session_creation_admission()'::regprocedure))); END $$`)
    await expect(db.exec(migration)).rejects.toThrow('project_chat_creation_unexpected_pin_consumer')
    await db.exec('ROLLBACK')
  })
})
