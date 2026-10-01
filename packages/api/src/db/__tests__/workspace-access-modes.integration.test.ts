import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error The disposable fixture is a repository-local JS utility.
import { assertLocalFixture } from '../../../../../scripts/crm/local-fixture.mjs'

// Deliberately fail rather than silently skip: this suite requires the owned PG18 fixture.
describe('workspace access modes M1 PostgreSQL foundation', () => {
  let db: pg.Client
  const query = (sql: string, values: unknown[] = []) => db.query(sql, values)
  const row = async (sql: string, values: unknown[] = []) => (await query(sql, values)).rows[0]
  async function denied(sql: string, values: unknown[], error: RegExp) {
    await query('SAVEPOINT rejected_write')
    try { await expect(query(sql, values)).rejects.toThrow(error) }
    finally { await query('ROLLBACK TO SAVEPOINT rejected_write'); await query('RELEASE SAVEPOINT rejected_write') }
  }
  async function user() {
    return (await row(`INSERT INTO users(auth_provider,auth_provider_id) VALUES('test',$1) RETURNING id`, [randomUUID()])).id as string
  }
  async function workspace() {
    const owner = await user()
    const w = (await row(`INSERT INTO workspaces(name,purpose,owner_user_id,is_personal) VALUES('Access modes','test',$1,false) RETURNING id`, [owner])).id as string
    await query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [w, owner])
    return { w, owner }
  }
  async function team(w: string, owner: string) {
    const id = randomUUID(), key = `team:${id}`
    await query(`INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Default',$3,'team',$1::uuid::text,$4)`, [id,w,owner,key])
    await query(`INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Default',$3,'team',$4)`, [w,key,owner,id])
    await query(`INSERT INTO workspace_group_compartment_grants(group_id,compartment_key,granted_by_user_id) VALUES($1,$2,$3)`, [id,key,owner])
    return id
  }
  async function simple() {
    const f = await workspace(), department = await team(f.w, f.owner)
    await query(`UPDATE workspace_access_policies SET access_mode='simple',default_department_id=$2,setup_state='ready' WHERE workspace_id=$1`, [f.w,department])
    return { ...f, department }
  }
  async function plan(w: string, owner: string, key = randomUUID()) {
    return row(`INSERT INTO workspace_access_migration_plans(workspace_id,actor_user_id,source_mode,target_mode,manifest_revision,schema_revision,policy_revision,inventory_revision,proposal_hash,idempotency_key,expires_at)
      VALUES($1,$2,'departments','simple','m1','620',1,1,repeat('a',64),$3,now()+interval '1 hour') RETURNING *`, [w,owner,key])
  }
  async function item(w: string, p: string, subject: string, key = randomUUID()) {
    return row(`INSERT INTO workspace_access_migration_items(workspace_id,plan_id,subject_kind,subject_id,proposed_action,reason,before_state,after_state,evidence_versions,dependency_versions,idempotency_key)
      VALUES($1,$2,'member',$3,'{}','test','{}','{}','{}','{}',$4) RETURNING *`, [w,p,subject,key])
  }
  beforeAll(async () => {
    await assertLocalFixture()
    db = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await db.connect()
    expect((await row(`SELECT count(*)::int n FROM _migrations WHERE name='621_workspace_access_modes.sql'`)).n).toBe(1)
  })
  afterAll(async () => { await db?.end() })
  beforeEach(async () => { await query('BEGIN') })
  afterEach(async () => { await query('ROLLBACK') })

  it('preserves populated pre-620 principals, grants, effective access and classification on upgrade', async () => {
    // Restore only 620's additive schema inside this rollback-only transaction.
    // The fixture separately proves that the complete real migration runner succeeds.
    await query(`DROP TABLE workspace_access_migration_items,workspace_access_migration_plans;
      DROP FUNCTION guard_workspace_access_migration();
      DROP FUNCTION guard_workspace_access_mode(),audit_workspace_access_mode(),guard_workspace_default_package(),admit_simple_workspace_principal() CASCADE;
      ALTER TABLE workspace_access_policies DROP COLUMN access_mode,DROP COLUMN default_department_id,DROP COLUMN setup_state;
      ALTER TABLE workspace_groups DROP CONSTRAINT workspace_groups_workspace_id_id_key;
      ALTER TABLE workspace_access_command_reviews DROP CONSTRAINT workspace_access_command_reviews_workspace_id_id_key;`)
    const f = await workspace(), department = await team(f.w,f.owner), member = await user()
    await query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'member','confidential','assigned')`, [f.w,member])
    await query(`INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)`, [department,member])
    await query(`UPDATE workspace_access_policies SET classification_mode='strict' WHERE workspace_id=$1`, [f.w])
    await query(`INSERT INTO assistants(name,workspace_id,owner_user_id) VALUES('Private',$1,$2)`, [f.w,f.owner])
    const snapshot = async () => ({
      members: (await query('SELECT * FROM workspace_members WHERE workspace_id=$1 ORDER BY user_id',[f.w])).rows,
      assistants: (await query('SELECT * FROM assistants WHERE workspace_id=$1',[f.w])).rows,
      groups: (await query('SELECT * FROM workspace_groups WHERE workspace_id=$1',[f.w])).rows,
      grants: (await query('SELECT * FROM workspace_group_members WHERE group_id=$1 ORDER BY user_id',[department])).rows,
      effective: await row('SELECT effective_member_team_compartments($1,$2) AS teams',[member,f.w]),
      policy: await row('SELECT classification_mode,revision,updated_at FROM workspace_access_policies WHERE workspace_id=$1',[f.w]),
    })
    const before = await snapshot()
    const sql = (await readFile(new URL('../../../migrations/621_workspace_access_modes.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'')
    await query(sql)
    expect(await snapshot()).toEqual(before)
    expect(await row('SELECT access_mode,setup_state,default_department_id FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).toEqual({access_mode:'departments',setup_state:'legacy',default_department_id:null})
    const fresh = await workspace()
    expect(await row('SELECT access_mode,setup_state,classification_mode FROM workspace_access_policies WHERE workspace_id=$1',[fresh.w])).toEqual({access_mode:'departments',setup_state:'legacy',classification_mode:'legacy'})
  })

  it('enforces local active flat defaults and reverse package guards, even for privileged writes', async () => {
    const a = await workspace(), b = await workspace(), local = await team(a.w,a.owner), foreign = await team(b.w,b.owner)
    await denied(`UPDATE workspace_access_policies SET access_mode='simple' WHERE workspace_id=$1`,[a.w],/workspace_access_simple_default/)
    await denied(`UPDATE workspace_access_policies SET default_department_id=$2 WHERE workspace_id=$1`,[a.w,foreign],/access_mode_default_invalid/)
    await query(`UPDATE workspace_groups SET status='archived' WHERE id=$1`,[local])
    await denied(`UPDATE workspace_access_policies SET default_department_id=$2 WHERE workspace_id=$1`,[a.w,local],/access_mode_default_invalid/)
    await query(`UPDATE workspace_groups SET status='active',read_all=true WHERE id=$1`,[local])
    await denied(`UPDATE workspace_access_policies SET access_mode='simple',default_department_id=$2 WHERE workspace_id=$1`,[a.w,local],/access_mode_default_invalid/)
    await query(`UPDATE workspace_groups SET read_all=false WHERE id=$1`,[local])
    const other = await team(a.w,a.owner)
    await query(`INSERT INTO workspace_group_compartment_grants(group_id,compartment_key) VALUES($1,$2)`,[local,`team:${other}`])
    await denied(`UPDATE workspace_access_policies SET access_mode='simple',default_department_id=$2 WHERE workspace_id=$1`,[a.w,local],/access_mode_default_invalid/)
    await query(`DELETE FROM workspace_group_compartment_grants WHERE group_id=$1 AND compartment_key=$2`,[local,`team:${other}`])
    await query(`UPDATE workspace_access_policies SET access_mode='simple',default_department_id=$2 WHERE workspace_id=$1`,[a.w,local])
    for (const sql of [`UPDATE workspace_groups SET read_all=true WHERE id=$1`,`UPDATE workspace_groups SET status='archived' WHERE id=$1`,`DELETE FROM workspace_groups WHERE id=$1`]) {
      await denied(sql,[local],/access_mode_default_(in_use|invalid)|Teams archive instead of delete/)
    }
    await denied(`INSERT INTO workspace_group_compartment_grants(group_id,compartment_key) VALUES($1,$2)`,[local,`team:${other}`],/access_mode_default_package_widened/)
    await denied(`DELETE FROM workspace_access_policies WHERE workspace_id=$1`,[a.w],/access_policy_delete_forbidden/)
  })

  it('auto-binds new shared principals without changing private ownership, clearance or Project defaults', async () => {
    const f = await simple(), member = await user()
    await query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')`,[f.w,member])
    expect(await row(`SELECT role,clearance,team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`,[f.w,member])).toEqual({role:'member',clearance:'confidential',team_scope_mode:'assigned'})
    expect((await row('SELECT effective_member_team_compartments($1,$2) teams',[member,f.w])).teams).toEqual([`team:${f.department}`])
    const project = (await row(`INSERT INTO workspace_projects(workspace_id,name,normalized_name,created_by) VALUES($1,'Project','project',$2) RETURNING id`,[f.w,f.owner])).id
    for (const [kind,owner,bound] of [['standard',null,true],['primary',f.owner,true],['app',f.owner,true],['standard',f.owner,false]] as const) {
      const assistant = await row(`INSERT INTO assistants(name,workspace_id,owner_user_id,kind,app_type,clearance,project_scope_mode,default_project_id) VALUES('Admission',$1,$2,$3,CASE WHEN $3='app' THEN 'distribution' ELSE NULL END,'confidential','all',$4) RETURNING id`,[f.w,owner,kind,project])
      expect(await row(`SELECT owner_user_id,clearance,project_scope_mode,default_project_id,team_scope_mode,default_workspace_group_id FROM assistants WHERE id=$1`,[assistant.id])).toEqual({owner_user_id:owner,clearance:'confidential',project_scope_mode:'all',default_project_id:project,team_scope_mode:bound?'assigned':'legacy',default_workspace_group_id:bound?f.department:null})
      expect((await query('SELECT * FROM workspace_group_assistants WHERE assistant_id=$1',[assistant.id])).rowCount).toBe(bound?1:0)
    }
  })

  it('enforces local plan/item references, one active transition, monotonic versions and retry identities', async () => {
    const a = await workspace(), b = await workspace(), p = await plan(a.w,a.owner), foreign = await plan(b.w,b.owner)
    const i = await item(a.w,p.id,a.owner)
    const review = await row(`INSERT INTO workspace_access_command_reviews(workspace_id,actor_user_id,idempotency_key,intent_hash,command,policy_revision,changes,payload_hash,expires_at)
      VALUES($1,$2,$3,repeat('b',64),'{}',1,'[]',repeat('c',64),now()+interval '1 hour') RETURNING id`,[b.w,b.owner,randomUUID()])
    const scope = await row(`INSERT INTO workspace_scope_reviews(workspace_id,created_by,resource_kind,action,reason,payload_hash,policy_revision,selection_revision)
      VALUES($1,$2,'task','hold','test',repeat('d',64),1,1) RETURNING id`,[b.w,b.owner])
    await denied('UPDATE workspace_access_migration_plans SET command_review_id=$2 WHERE id=$1',[p.id,review.id],/foreign key/)
    await denied('UPDATE workspace_access_migration_items SET command_review_id=$2 WHERE id=$1',[i.id,review.id],/foreign key/)
    await denied('UPDATE workspace_access_migration_items SET scope_review_id=$2 WHERE id=$1',[i.id,scope.id],/foreign key/)

    for (const status of ['paused','stale','blocked']) {
      await query('UPDATE workspace_access_migration_plans SET status=$2 WHERE id=$1',[p.id,status])
      await query('SAVEPOINT duplicate_plan')
      await expect(plan(a.w,a.owner)).rejects.toThrow(/workspace_access_migration_one_active/)
      await query('ROLLBACK TO SAVEPOINT duplicate_plan')
    }
    expect((await row('SELECT version FROM workspace_access_migration_plans WHERE id=$1',[p.id])).version).toBe('4')
    await denied('UPDATE workspace_access_migration_items SET plan_id=$2 WHERE id=$1',[i.id,foreign.id],/access_migration_identity_immutable/)
    await denied('UPDATE workspace_access_migration_plans SET idempotency_key=$2 WHERE id=$1',[p.id,randomUUID()],/access_migration_identity_immutable/)
    await denied('UPDATE workspace_access_migration_items SET workspace_id=$2 WHERE id=$1',[i.id,b.w],/access_migration_identity_immutable/)
    await query('SAVEPOINT invalid_item')
    await expect(item(a.w,foreign.id,a.owner)).rejects.toThrow(/foreign key/)
    await query('ROLLBACK TO SAVEPOINT invalid_item')
    await expect(item(a.w,p.id,b.owner)).rejects.toThrow(/access_migration_subject_invalid/)
    await query('ROLLBACK TO SAVEPOINT invalid_item')
    await expect(item(a.w,p.id,a.owner,i.idempotency_key)).rejects.toThrow(/unique constraint/)
    await query('ROLLBACK TO SAVEPOINT invalid_item')
    await query(`UPDATE workspace_access_migration_plans SET status='completed' WHERE id=$1`,[p.id])
    await query('SAVEPOINT retry_plan')
    await expect(plan(a.w,a.owner,p.idempotency_key)).rejects.toThrow(/unique constraint/)
    await query('ROLLBACK TO SAVEPOINT retry_plan')
    await plan(a.w,a.owner)
    await query('UPDATE workspace_access_migration_items SET version=999,status=\'stale\' WHERE id=$1',[i.id])
    expect((await row('SELECT version FROM workspace_access_migration_items WHERE id=$1',[i.id])).version).toBe('2')
  })

  it('denies outsider reads and writes under a real non-bypass role; admins can read but not write', async () => {
    const f = await workspace(), p = await plan(f.w,f.owner), i = await item(f.w,p.id,f.owner), outsider = await user()
    expect(await row(`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='assurance_app'`)).toEqual({rolsuper:false,rolbypassrls:false})
    await query(`SET LOCAL ROLE assurance_app`)
    await query(`SELECT set_config('app.system_bypass','false',true),set_config('app.current_user_id',$1,true)`,[outsider])
    for (const [table,id] of [['workspace_access_migration_plans',p.id],['workspace_access_migration_items',i.id]]) {
      expect((await query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows).toEqual([])
      expect((await query(`UPDATE ${table} SET status='cancelled' WHERE id=$1`,[id])).rowCount).toBe(0)
      expect((await query(`DELETE FROM ${table} WHERE id=$1`,[id])).rowCount).toBe(0)
    }
    await query('SAVEPOINT outsider_insert')
    await expect(item(f.w,p.id,f.owner)).rejects.toThrow(/row-level security/)
    await query('ROLLBACK TO SAVEPOINT outsider_insert')
    await query(`SELECT set_config('app.current_user_id',$1,true)`,[f.owner])
    for (const table of ['workspace_access_migration_plans','workspace_access_migration_items']) {
      expect((await query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.w])).rowCount).toBe(1)
      expect((await query(`UPDATE ${table} SET status='cancelled' WHERE workspace_id=$1`,[f.w])).rowCount).toBe(0)
    }
    await query('RESET ROLE')
  })

  it('allows workspace deletion to cascade through a Simple default, admissions, plans and items', async () => {
    const f = await simple(), p = await plan(f.w,f.owner)
    await item(f.w,p.id,f.owner)
    const member = await user()
    await query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')`,[f.w,member])
    await query('DELETE FROM workspaces WHERE id=$1',[f.w])
    for (const table of ['workspace_access_policies','workspace_groups','workspace_members','workspace_access_migration_plans','workspace_access_migration_items']) {
      expect((await query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.w])).rows).toEqual([])
    }
  })
})
