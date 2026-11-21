import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildVerificationPreview, runAutomaticVerification } from '../../project-harness/verification.js'
import type { HarnessRevision } from '../../project-harness/contracts.js'

// Actual 8269 migration, real restricted app_user. Minimal FK prerequisites;
// canonical shared-Project/department predicate SQL is loaded, not stubbed true.
let db: PGlite
const owner = randomUUID(), participant = randomUUID(), oversight = randomUUID(), outsider = randomUUID()
const expired = randomUUID(), assistant = randomUUID(), otherAssistant = randomUUID()
const w = randomUUID(), p = randomUUID(), legacy = randomUUID(), second = randomUUID()
const body = { schemaVersion: 1 as const, rules: [], codeChecks: [], acceptanceScenarios: [] }
const migration = (name: string) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8')
const query = async <T = Record<string, unknown>>(actor: string, sql: string, params: unknown[] = [], gucs: Record<string, string> = {}) =>
  db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE app_user')
    await tx.query("SELECT set_config('app.current_user_id',$1,true)", [actor])
    for (const [key, value] of Object.entries(gucs)) await tx.query('SELECT set_config($1,$2,true)', [key, value])
    return tx.query<T>(sql, params)
  })
const reviewer=randomUUID(), ownerSession=randomUUID(), reviewerSession=randomUUID(), participantSession=randomUUID(), oversightSession=randomUUID()
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE harness_migration_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE,CREATE ON SCHEMA public TO harness_migration_owner;
    SET ROLE harness_migration_owner;
    -- Simulate production's broad defaults; migration must explicitly revoke DML.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO app_user;
    CREATE TABLE workspaces(id uuid PRIMARY KEY, department_read_v2 boolean DEFAULT true, project_shared_spaces boolean DEFAULT true);
    CREATE TABLE workspace_members(workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE, user_id uuid, role text, clearance text DEFAULT 'internal');
    CREATE TABLE assistants(id uuid PRIMARY KEY, workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE, clearance text DEFAULT 'internal');
    CREATE TABLE workspace_projects(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,status text DEFAULT 'active', UNIQUE(workspace_id,id));
    CREATE TABLE project_shared_scopes(project_id uuid PRIMARY KEY REFERENCES workspace_projects(id) ON DELETE CASCADE,workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,status text DEFAULT 'active');
    CREATE TABLE project_shared_members(project_id uuid REFERENCES project_shared_scopes(project_id) ON DELETE CASCADE,user_id uuid,assistant_id uuid,expires_at timestamptz);
    CREATE TABLE project_shared_owners(workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,project_id uuid REFERENCES project_shared_scopes(project_id) ON DELETE CASCADE,user_id uuid);
    CREATE TABLE department_edges(workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,department_id uuid,user_id uuid,assistant_id uuid,clearance text,expires_at timestamptz);
    CREATE FUNCTION sensitivity_rank(s text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE s WHEN 'public' THEN 1 WHEN 'internal' THEN 2 WHEN 'confidential' THEN 3 END $$;
    CREATE FUNCTION effective_member_team_compartments(a uuid,w uuid) RETURNS text[] LANGUAGE sql AS $$ SELECT NULL::text[] $$;
    CREATE FUNCTION effective_member_read_compartments(a uuid,w uuid) RETURNS text[] LANGUAGE sql AS $$ SELECT NULL::text[] $$;
    CREATE FUNCTION department_read_grants() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT '{}'::jsonb $$;
  `)
  const source = migration('749_project_shared_spaces.sql')
  await db.exec(source.slice(source.indexOf('CREATE FUNCTION public.project_member_live'), source.indexOf('-- ── Label integrity')))
  await db.exec(`CREATE OR REPLACE FUNCTION department_read_grants() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT department_read_grants_for(nullif(current_setting('app.current_user_id',true),'')::uuid) $$;`)
  await db.exec(`CREATE TABLE users(id uuid PRIMARY KEY,auth_version int DEFAULT 0);
    CREATE TABLE auth_sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id) ON DELETE CASCADE,auth_version int DEFAULT 0,expires_at timestamptz DEFAULT now()+interval '1 day',revoked_at timestamptz);`)
  const principalSource = migration('8003_application_projection_authority.sql')
  await db.exec(principalSource.slice(principalSource.indexOf('CREATE FUNCTION department_principal_grant_snapshot'), principalSource.indexOf('-- The added generic family')))
  await db.exec(migration('8335_project_harnesses.sql'))
  await db.exec(migration('8336_project_harness_verification.sql'))
  await db.query('INSERT INTO workspaces(id) VALUES($1)', [w])
  for (const [id, role] of [[reviewer, 'member'], [owner, 'member'], [participant, 'member'], [oversight, 'owner'], [outsider, 'member'], [expired, 'member']]) {
    await db.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)', [w, id, role])
  }
  for (const id of [p, legacy, second]) await db.query('INSERT INTO workspace_projects(id,workspace_id) VALUES($1,$2)', [id, w])
  for (const id of [p, second]) await db.query('INSERT INTO project_shared_scopes(project_id,workspace_id) VALUES($1,$2)', [id, w])
  for (const id of [owner, participant, reviewer]) await db.query('INSERT INTO project_shared_members(project_id,user_id) VALUES($1,$2)', [p, id])
  await db.query("INSERT INTO project_shared_members(project_id,user_id,expires_at) VALUES($1,$2,now()-interval '1 day')", [p, expired])
  await db.query('INSERT INTO project_shared_owners VALUES($1,$2,$3)', [w, p, owner])
  await db.query('INSERT INTO project_shared_owners VALUES($1,$2,$3)', [w,p,reviewer])
  for (const [id,sid] of [[owner,ownerSession],[reviewer,reviewerSession],[participant,participantSession],[oversight,oversightSession]]) {
    await db.query('INSERT INTO users(id) VALUES($1)',[id])
    await db.query('INSERT INTO auth_sessions(id,user_id) VALUES($1,$2)',[sid,id])
  }
  for (const id of [assistant, otherAssistant]) await db.query('INSERT INTO assistants(id,workspace_id) VALUES($1,$2)', [id, w])
  await db.query('INSERT INTO project_shared_members(project_id,assistant_id) VALUES($1,$2)', [p, assistant])
}, 30_000)
afterAll(async () => { await db?.close() })

// Owner-only commands: simulate the trusted server connection, not app_user.
const system = async <T = Record<string, any>>(actor: string, sql: string, params: unknown[] = [], gucs: Record<string,string> = {}) => db.transaction(async tx => {
  await tx.query("SELECT set_config('app.current_user_id',$1,true)",[actor])
  for (const [key,value] of Object.entries(gucs)) await tx.query('SELECT set_config($1,$2,true)',[key,value])
  return tx.query<T>(sql,params)
})
const definition = { ...body, acceptanceScenarios: [{key:'journey',title:'Journey',preconditions:['Ready'],steps:['Observe'],criteria:[{key:'visible',observation:'Visible',evidence:'Observation'}]}] }
async function fixture(executor='human') {
  const product = (await query<{result:{id:string}}>(owner,'SELECT project_harness_write_node($1,$2,NULL,NULL,$3,0) result',[w,p,{name:'Surface'}])).rows[0].result.id
  const r = (await query<{result:Record<string,any>}>(owner,'SELECT project_harness_put($1,$2,$3,NULL,0,$4) result',[w,p,product,definition])).rows[0].result
  const revision: HarnessRevision = {id:r.id,workspaceId:w,projectId:p,scope:{kind:'product',productId:product},revision:1,definition,createdBy:owner,createdAt:r.created_at}
  const approve = (actor=reviewer,sid=reviewerSession) => system(actor,'SELECT harness_execution_approve($1,$2,$3,$4,1,$5) result',[w,p,r.id,sid,'Independent review'])
  const a = (await approve()).rows[0].result
  const id=randomUUID()
  const preview=buildVerificationPreview({runId:id,revision,scenarioKey:'journey',build:{buildId:'b',deploymentId:'d'},target:{url:'https://example.com/',permittedOrigins:['https://example.com']},environment:{environmentId:'qa',locale:'en',timezone:'UTC',viewport:{width:100,height:100}}})
  const create = (actor=participant,sid=participantSession) => {
    const newId=randomUUID()
    const packet=buildVerificationPreview({runId:newId,revision,scenarioKey:'journey',build:preview.build,target:preview.target,environment:preview.environment})
    return system(actor,'SELECT harness_execution_create($1,$2,$3,$4,$5,$6,$7) result',[w,p,a.id,sid,newId,executor,packet])
  }
  await system(participant,'SELECT harness_execution_create($1,$2,$3,$4,$5,$6,$7)',[w,p,a.id,participantSession,id,executor,preview])
  const action=(mode:string,payload:unknown={},actor=participant,sid:string|null=participantSession,gucs={}) => system(actor,'SELECT harness_execution_action($1,$2,$3,$4,$5,$6) result',[w,p,id,sid,mode,payload],gucs)
  return {product,revision,a,id,preview,approve,create,action}
}
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII='

describe('8270 execution authority under ordinary owner and restricted role',()=>{
  it('requires independent live human owner approval; no assistant, stale session or author approval',async()=>{
    const f=await fixture()
    await expect(f.approve(owner,ownerSession)).rejects.toThrow('harness_independent_reviewer_required')
    await expect(f.approve(participant,participantSession)).rejects.toThrow('harness_owner_required')
    await expect(f.approve(reviewer,ownerSession)).rejects.toThrow('harness_human_required')
    await expect(system(reviewer,'SELECT harness_execution_approve($1,$2,$3,$4,1,$5)',[w,p,f.revision.id,reviewerSession,'review'],{'app.v2_assistant_id':assistant})).rejects.toThrow('harness_human_required')
    await db.query('UPDATE users SET auth_version=1 WHERE id=$1',[reviewer])
    await expect(f.approve()).rejects.toThrow('harness_human_required')
    await db.query('UPDATE users SET auth_version=0 WHERE id=$1',[reviewer])
  })
  it('denies every command/helper and all direct writes to app_user, even forged bypass GUCs',async()=>{
    const f=await fixture('agent')
    const gucs={'app.system_bypass':'true','app.harness_write':'true','app.v2_system':'true'}
    for(const sql of [
      `SELECT harness_execution_action('${w}','${p}','${f.id}',NULL,'claim_agent')`,
      `SELECT harness_execution_human('${participant}','${participantSession}')`,
      `SELECT harness_execution_authority('${w}','${p}','${f.revision.id}')`,
      `SELECT harness_execution_expire('${w}','${p}')`,
      `UPDATE project_harness_runs SET status='passed'`,
      `DELETE FROM project_harness_approvals`,
      `INSERT INTO project_harness_evidence(id) VALUES(gen_random_uuid())`,
      `INSERT INTO project_harness_execution_audit(id) VALUES(gen_random_uuid())`,
    ]) await expect(query(participant,sql,[],gucs)).rejects.toThrow('permission denied')
    const acl=(await db.query<{proname:string,allowed:boolean}>(`SELECT proname,has_function_privilege('app_user',oid,'EXECUTE') allowed FROM pg_proc WHERE proname LIKE 'harness_execution_%'`)).rows
    expect(acl.length).toBeGreaterThan(5); expect(acl.every(x=>!x.allowed)).toBe(true)
    for(const table of ['approvals','runs','evidence','execution_audit']) {
      expect((await query(outsider,`SELECT * FROM project_harness_${table}`)).rows).toEqual([])
    }
    expect((await query(oversight,'SELECT * FROM project_harness_runs WHERE id=$1',[f.id])).rows).toHaveLength(1)
  })
  it('permits admitted participant runs but not oversight, other session or other requester',async()=>{
    const f=await fixture()
    await expect(f.create(oversight,oversightSession)).rejects.toThrow('harness_participant_required')
    await expect(f.action('evidence_human',{criterionKey:'visible',text:'Seen'},owner,ownerSession)).rejects.toThrow('harness_requester_required')
    await expect(f.action('evidence_human',{criterionKey:'visible',text:'Seen'},participant,ownerSession)).rejects.toThrow('harness_human_required')
    const e=(await f.action('evidence_human',{criterionKey:'visible',text:'Seen'})).rows[0].result
    expect(e.provenance).toBe('human_reported'); expect(e.base64).toBeNull()
    await expect(f.action('evidence_agent',{criterionKey:'visible',base64:png})).rejects.toThrow('harness_run_conflict')
  })
  it('binds results to persisted criterion evidence; immutable append-only history, single completion',async()=>{
    const f=await fixture()
    const e=(await f.action('evidence_human',{criterionKey:'visible',text:'Seen'})).rows[0].result
    const blocked=runAutomaticVerification(f.preview)
    const result={...blocked,status:'passed',criteria:[{criterionKey:'visible',status:'passed',evidenceIds:[e.id]}],evidence:[{id:e.id,criterionKey:'visible',kind:'observation',reference:e.id}]}
    await expect(f.action('complete_human',{...result,evidence:[{...result.evidence[0],reference:'external'}]})).rejects.toThrow('harness_invalid_input')
    const other=await fixture()
    await expect(other.action('complete_human',{...result,binding:runAutomaticVerification(other.preview).binding})).rejects.toThrow('harness_invalid_input')
    expect((await f.action('complete_human',result)).rows[0].result.status).toBe('passed')
    await expect(f.action('complete_human',result)).rejects.toThrow('harness_run_conflict')
    await expect(db.query('UPDATE project_harness_evidence SET text=$1 WHERE id=$2',['changed',e.id])).rejects.toThrow('harness_history_immutable')
    await expect(db.query('DELETE FROM project_harness_approvals WHERE id=$1',[f.a.id])).rejects.toThrow('harness_history_immutable')
    await expect(db.query('UPDATE project_harness_runs SET preview=$1 WHERE id=$2',[{},f.id])).rejects.toThrow('harness_run_conflict')
    await expect(db.query('DELETE FROM project_harness_execution_audit WHERE run_id=$1',[f.id])).rejects.toThrow('harness_history_immutable')
    expect((await db.query<{event:string}>('SELECT event FROM project_harness_execution_audit WHERE run_id=$1 ORDER BY created_at',[f.id])).rows.map(x=>x.event)).toEqual(['pending','running','evidence_human','passed'])
  })
  it('claims agent once, bounds PNG evidence and binds completion; system commands need no self-asserted bypass',async()=>{
    const f=await fixture('agent')
    await expect(f.action('authorize_agent',{},participant,null)).rejects.toThrow('harness_run_conflict')
    expect((await f.action('claim_agent',{},participant,null)).rows[0].result.status).toBe('running')
    await expect(f.action('claim_agent',{},participant,null)).rejects.toThrow('harness_run_conflict')
    await f.action('authorize_agent',{},participant,null)
    for(const base64 of ['abc',Buffer.alloc(50).toString('base64'),'A'.repeat(2796205)]) await expect(f.action('evidence_agent',{criterionKey:'visible',base64},participant,null)).rejects.toThrow('harness_invalid_input')
    const e=(await f.action('evidence_agent',{criterionKey:'visible',base64:png},participant,null)).rows[0].result
    expect(e.provenance).toBe('isolated_browser'); expect(e.content_type).toBe('image/png'); expect(e.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect((await f.action('complete_agent',runAutomaticVerification(f.preview),participant,null)).rows[0].result.status).toBe('blocked')
    await expect(f.action('complete_agent',runAutomaticVerification(f.preview),participant,null)).rejects.toThrow('harness_run_conflict')
  })
  it('latest head invalidates approval for new runs and every ongoing agent action',async()=>{
    const f=await fixture('agent')
    await f.action('claim_agent',{},participant,null)
    await query(owner,'SELECT project_harness_put($1,$2,$3,NULL,1,$4)',[w,p,f.product,definition])
    for(const mode of ['authorize_agent','evidence_agent','complete_agent']) await expect(f.action(mode,{},participant,null)).rejects.toThrow('harness_revision_stale')
    await expect(f.create()).rejects.toThrow('harness_revision_stale')
    // Cancellation remains possible after a head is superseded.
    expect((await f.action('cancel')).rows[0].result.status).toBe('cancelled')
    await expect(f.action('complete_agent',runAutomaticVerification(f.preview),participant,null)).rejects.toThrow('harness_run_conflict')
  })
  it('reauthorizes stored session, reviewer ownership, requester membership, active ancestry, capability and quarantine',async()=>{
    const f=await fixture('agent'); await f.action('claim_agent',{},participant,null)
    const check=()=>f.action('authorize_agent',{},participant,null)
    await db.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[participantSession]); await expect(check()).rejects.toThrow('harness_human_required')
    await db.query('UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1',[participantSession])
    await db.query('DELETE FROM project_shared_owners WHERE user_id=$1',[reviewer]); await expect(check()).rejects.toThrow('harness_owner_required')
    await db.query('INSERT INTO project_shared_owners VALUES($1,$2,$3)',[w,p,reviewer])
    await db.query("UPDATE project_shared_members SET expires_at=now()-interval '1 second' WHERE user_id=$1",[participant]); await expect(check()).rejects.toThrow()
    await db.query('UPDATE project_shared_members SET expires_at=NULL WHERE user_id=$1',[participant])
    await query(owner,'SELECT project_harness_write_node($1,$2,NULL,$3,$4,1)',[w,p,f.product,{status:'archived'}]); await expect(check()).rejects.toThrow('harness_archived')
    await query(owner,'SELECT project_harness_write_node($1,$2,NULL,$3,$4,2)',[w,p,f.product,{status:'active'}])
    await db.exec('UPDATE workspaces SET project_shared_spaces=false'); await expect(check()).rejects.toThrow('harness_not_found'); await db.exec('UPDATE workspaces SET project_shared_spaces=true')
    await db.exec("UPDATE project_shared_scopes SET status='quarantined'"); await expect(check()).rejects.toThrow('harness_not_found'); await db.exec("UPDATE project_shared_scopes SET status='active'")
  })
  it('expires lazily with an immutable audit event and refuses late completion',async()=>{
    const f=await fixture('agent')
    // Fixture-only time travel via a new owner insert; expiry itself is immutable.
    const id=randomUUID()
    await db.query(`INSERT INTO project_harness_runs(id,workspace_id,project_id,revision_id,approval_id,requested_by,auth_session_id,executor,preview,created_at,expires_at)
      SELECT $1,workspace_id,project_id,revision_id,approval_id,requested_by,auth_session_id,executor,preview,now()-interval '1 hour',now()-interval '1 minute' FROM project_harness_runs WHERE id=$2`,[id,f.id])
    await expect(system(participant,'SELECT harness_execution_action($1,$2,$3,NULL,$4)',[w,p,id,'claim_agent'])).rejects.toThrow('harness_run_conflict')
    await system(participant,'SELECT harness_execution_expire($1,$2)',[w,p])
    expect((await db.query<{status:string}>('SELECT status FROM project_harness_runs WHERE id=$1',[id])).rows[0].status).toBe('expired')
    await expect(system(participant,'SELECT harness_execution_action($1,$2,$3,NULL,$4,$5)',[w,p,id,'complete_agent',runAutomaticVerification(f.preview)])).rejects.toThrow('harness_run_conflict')
  })
})

describe('reviewer principal reauthorization, teardown and post-lock clocks',()=>{
  it('rejects new and ongoing runs after reviewer clearance falls below internal without changing requester identity',async()=>{
    const f=await fixture('agent'); await f.action('claim_agent',{},participant,null)
    const before=await system(participant,`SELECT harness_execution_authority($1,$2,$3,$4),current_setting('app.current_user_id') actor`,[w,p,f.revision.id,reviewer])
    expect(before.rows[0].actor).toBe(participant)
    await db.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[w,reviewer])
    try {
      await expect(f.create()).rejects.toThrow('harness_owner_required')
      for(const mode of ['authorize_agent','evidence_agent','complete_agent']) {
        const payload=mode==='evidence_agent'?{criterionKey:'visible',base64:png}:mode==='complete_agent'?runAutomaticVerification(f.preview):{}
        await expect(f.action(mode,payload,participant,null)).rejects.toThrow('harness_owner_required')
      }
    } finally { await db.query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[w,reviewer]) }
    await f.action('authorize_agent',{},participant,null)
    expect((await f.create()).rows[0].result.status).toBe('pending')
  })
  it('preserves shared-project historical reads after Product and Project archival',async()=>{
    const f=await fixture()
    const e=(await f.action('evidence_human',{criterionKey:'visible',text:'Recorded before archival'})).rows[0].result
    await f.action('complete_human',runAutomaticVerification(f.preview))
    await query(owner,'SELECT project_harness_write_node($1,$2,NULL,$3,$4,1)',[w,p,f.product,{status:'archived'}])
    await db.query("UPDATE workspace_projects SET status='archived' WHERE id=$1",[p])
    try {
      for(const actor of [participant,oversight]) {
        expect((await query(actor,'SELECT * FROM project_harness_approvals WHERE id=$1',[f.a.id])).rows).toHaveLength(1)
        expect((await query(actor,'SELECT * FROM project_harness_runs WHERE id=$1',[f.id])).rows).toHaveLength(1)
        expect((await query(actor,'SELECT * FROM project_harness_evidence WHERE id=$1',[e.id])).rows).toHaveLength(1)
        expect((await query(actor,'SELECT * FROM project_harness_execution_audit WHERE run_id=$1',[f.id])).rows.length).toBeGreaterThan(0)
      }
      await expect(f.create()).rejects.toThrow('harness_archived')
      expect((await query(outsider,'SELECT * FROM project_harness_evidence WHERE id=$1',[e.id])).rows).toEqual([])
    } finally { await db.query("UPDATE workspace_projects SET status='active' WHERE id=$1",[p]) }
  })
  it('permits only complete workspace teardown cascades, retaining ordinary immutable history protection',async()=>{
    const f=await fixture()
    const e=(await f.action('evidence_human',{criterionKey:'visible',text:'Immutable'})).rows[0].result
    const tables=['project_harness_approvals','project_harness_runs','project_harness_evidence','project_harness_execution_audit']
    for(const table of tables) {
      await expect(db.query(`DELETE FROM ${table} WHERE workspace_id=$1`,[w])).rejects.toThrow('harness_history_immutable')
    }
    await expect(db.query('DELETE FROM workspace_projects WHERE id=$1',[p])).rejects.toThrow('harness_history_immutable')
    await expect(db.query('UPDATE project_harness_evidence SET text=$1 WHERE id=$2',['rewrite',e.id])).rejects.toThrow('harness_history_immutable')
    const rollback=new Error('rollback successful teardown fixture')
    await expect(db.transaction(async tx=>{
      await tx.query('DELETE FROM workspaces WHERE id=$1',[w])
      for(const table of [...tables,'project_harness_revisions','project_harness_products','project_harness_components','workspace_projects','project_shared_scopes']) {
        expect((await tx.query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[w])).rows).toEqual([])
      }
      throw rollback
    })).rejects.toBe(rollback)
    expect((await query(participant,'SELECT * FROM project_harness_runs WHERE id=$1',[f.id])).rows).toHaveLength(1)
  })
  it('account/session erasure does not rewrite historical attribution or retain a usable human session',async()=>{
    const f=await fixture('agent'); await f.action('claim_agent',{},participant,null)
    await expect(db.transaction(async tx=>{
      await tx.query('DELETE FROM users WHERE id=$1',[participant])
      expect((await tx.query('SELECT * FROM auth_sessions WHERE user_id=$1',[participant])).rows).toEqual([])
      expect((await tx.query<{requested_by:string}>('SELECT requested_by FROM project_harness_runs WHERE id=$1',[f.id])).rows[0].requested_by).toBe(participant)
      await tx.query("SELECT set_config('app.current_user_id',$1,true)",[participant])
      await tx.query('SELECT harness_execution_action($1,$2,$3,NULL,$4)',[w,p,f.id,'authorize_agent'])
    })).rejects.toThrow('harness_human_required')
  })
  it('checks session wall-clock expiry after locks and rejects sequential expiry inside an older transaction',async()=>{
    const source=(await db.query<{source:string}>("SELECT pg_get_functiondef('harness_execution_human(uuid,uuid)'::regprocedure) source")).rows[0].source
    expect(source.indexOf('s.expires_at>clock_timestamp()')).toBeGreaterThan(source.indexOf('FOR SHARE OF s,u'))
    await expect(db.transaction(async tx=>{
      await tx.query("UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '20 milliseconds' WHERE id=$1",[participantSession])
      await tx.exec('SELECT pg_sleep(0.04)')
      await tx.query('SELECT harness_execution_human($1,$2)',[participant,participantSession])
    })).rejects.toThrow('harness_human_required')
  })
  it('reauthorizes human session after the authority call for authorize, evidence and completion (single-connection fault injection)',async()=>{
    const f=await fixture('agent'); await f.action('claim_agent',{},participant,null)
    const source=(await db.query<{source:string}>("SELECT pg_get_functiondef('harness_execution_authority(uuid,uuid,uuid,uuid)'::regprocedure) source")).rows[0].source
    // Transaction-local test replacement expires the session after the real
    // authority checks/locks, then waits. This is NOT a two-connection lock test.
    const injected=source.replace(' RETURN r;',` UPDATE public.auth_sessions SET expires_at=clock_timestamp()+interval '20 milliseconds' WHERE id='${participantSession}';\n PERFORM pg_sleep(0.04);\n RETURN r;`)
    expect(injected).not.toBe(source)
    for(const mode of ['authorize_agent','evidence_agent','complete_agent']) {
      await expect(db.transaction(async tx=>{
        await tx.exec(injected)
        await tx.query("SELECT set_config('app.current_user_id',$1,true)",[participant])
        const payload=mode==='evidence_agent'?{criterionKey:'visible',base64:png}:mode==='complete_agent'?runAutomaticVerification(f.preview):{}
        await tx.query('SELECT harness_execution_action($1,$2,$3,NULL,$4,$5)',[w,p,f.id,mode,payload])
      })).rejects.toThrow('harness_human_required')
    }
    expect((await query(participant,'SELECT * FROM project_harness_evidence WHERE run_id=$1',[f.id])).rows).toEqual([])
    await f.action('authorize_agent',{},participant,null)
  })
  it('rechecks run expiry after authority before authorization, evidence or completion (single-connection delay)',async()=>{
    const f=await fixture('agent'); await f.action('claim_agent',{},participant,null)
    const source=(await db.query<{source:string}>("SELECT pg_get_functiondef('harness_execution_authority(uuid,uuid,uuid,uuid)'::regprocedure) source")).rows[0].source
    const injected=source.replace(' RETURN r;', ' PERFORM pg_sleep(0.15);\n RETURN r;')
    for(const mode of ['authorize_agent','evidence_agent','complete_agent']) {
      await expect(db.transaction(async tx=>{
        await tx.exec(injected)
        await tx.query("SELECT set_config('app.current_user_id',$1,true)",[participant])
        const id=randomUUID()
        const packet=buildVerificationPreview({runId:id,revision:f.revision,scenarioKey:'journey',build:f.preview.build,target:f.preview.target,environment:f.preview.environment})
        // Fresh fixture insert, not a mutation of immutable expiry. The SQL
        // action starts before its expiry and returns from authority after it.
        await tx.query(`INSERT INTO project_harness_runs(id,workspace_id,project_id,revision_id,approval_id,requested_by,auth_session_id,executor,preview,status,started_at,expires_at)
          SELECT $1,workspace_id,project_id,revision_id,approval_id,requested_by,auth_session_id,executor,$3::jsonb,'running',clock_timestamp(),clock_timestamp()+interval '100 milliseconds' FROM project_harness_runs WHERE id=$2`,[id,f.id,packet])
        await tx.query('SELECT harness_execution_action($1,$2,$3,NULL,$4,$5)',[w,p,id,mode,mode==='evidence_agent'?{criterionKey:'visible',base64:png}:mode==='complete_agent'?runAutomaticVerification(packet):{}])
      })).rejects.toThrow('harness_run_conflict')
    }
  })
})
