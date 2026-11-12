/** [COMP:api/home-apps-store] Real ordinary-owner upgrade and app-role isolation. */
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {afterAll,beforeAll,describe,expect,it} from 'vitest'
import type {PoolClient} from 'pg'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
// The regression deliberately reuses one system connection after SET LOCAL resets.
process.env.PG_POOL_MAX='1'
const {getPool,getAppPool}=await import('../client.js')
const {listHomeApps}=await import('../home-apps-store.js')
const pool=getPool(),appPool=getAppPool()
const [owner,member,outsider,workspace,otherWorkspace,app,otherApp]=Array.from({length:7},()=>randomUUID())
const migration=new URL('../../../migrations/8266_home_app_role_isolation.sql',import.meta.url)
const fixtureSnapshot=async()=>({
 registry:(await pool.query('SELECT * FROM workspace_home_apps WHERE id=ANY($1::uuid[]) ORDER BY id',[[app,otherApp]])).rows,
 state:(await pool.query('SELECT * FROM home_app_state WHERE app_id=ANY($1::uuid[]) ORDER BY app_id',[[app,otherApp]])).rows,
 acl:(await pool.query("SELECT oid,relowner,relacl FROM pg_class WHERE oid IN('workspace_home_apps'::regclass,'home_app_state'::regclass) ORDER BY oid")).rows,
})
// Fixture-only execution uses the exact immutable migration bytes and its own
// BEGIN/COMMIT. It does not forge, delete or otherwise modify ledger entries.
const applyRoleMigration=async()=>{await pool.query(await readFile(migration,'utf8'))}
async function asApp<T>(actor:string,bypass:string,run:(connection:PoolClient)=>Promise<T>):Promise<T>{
 const connection=await appPool.connect()
 try{
  await connection.query('BEGIN')
  await connection.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.system_bypass',$2,true)",[actor,bypass])
  return await run(connection)
 }finally{await connection.query('ROLLBACK');connection.release()}
}

beforeAll(async()=>{
 expect((await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
  .toEqual({rolsuper:false,rolbypassrls:false})
 expect((await appPool.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
  .toEqual({current_user:'app_user',rolsuper:false,rolbypassrls:false})
 for(const id of [owner,member,outsider])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
 await pool.query("INSERT INTO workspaces(id,name,owner_user_id,is_personal,department_read_v2) VALUES($1,'Fictional Home fixture',$3,false,false),($2,'Fictional Other fixture',$4,false,false)",[workspace,otherWorkspace,owner,outsider])
 await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$3,'owner'),($1,$4,'member'),($2,$5,'owner')",[workspace,otherWorkspace,owner,member,outsider])
 await pool.query("SELECT set_config('app.current_user_id',$1,false)",[owner])
 await pool.query(`INSERT INTO workspace_home_apps(id,workspace_id,kind,name,root_path,manifest,granted_scopes,granted_by,granted_at)
  VALUES($1,$3,'upload','Fictional granted app','/apps/fixture/','{"manifestVersion":1,"name":"Fixture","entry":"index.html"}',
   '{"data":"read","identity":false,"net":[]}',$5,now()),($2,$4,'upload','Fictional other app','/apps/other/','{}',NULL,NULL,NULL)`,[app,otherApp,workspace,otherWorkspace,owner])
 await pool.query("INSERT INTO home_app_state(app_id,workspace_id,user_id,data) VALUES($1,$3,NULL,'{\"retained\":true}'),($2,$4,NULL,'{\"other\":true}')",[app,otherApp,workspace,otherWorkspace])
},30_000)
afterAll(async()=>{await appPool.end();await pool.end()})

describe.sequential('[COMP:api/home-apps-store] pooled actor and role authority',()=>{
 it('reproduces the released policy failure, upgrades exact SQL, and preserves rows, grants and ACLs',async()=>{
  const before=await fixtureSnapshot()
  // Recreate only the released policy layout on this owned disposable fixture.
  // This keeps the regression meaningful even when fresh CI already applied8266.
  await pool.query(`ALTER TABLE workspace_home_apps FORCE ROW LEVEL SECURITY;
   ALTER TABLE home_app_state FORCE ROW LEVEL SECURITY;
   DROP POLICY IF EXISTS home_apps_system_bypass ON workspace_home_apps;
   CREATE POLICY home_apps_system_bypass ON workspace_home_apps USING(COALESCE(current_setting('app.system_bypass',true),'true')='true');
   DROP POLICY IF EXISTS home_app_state_system_bypass ON home_app_state;
   CREATE POLICY home_app_state_system_bypass ON home_app_state USING(COALESCE(current_setting('app.system_bypass',true),'true')='true');
   ALTER POLICY home_apps_workspace_member ON workspace_home_apps USING(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid));
   ALTER POLICY home_app_state_workspace_member ON home_app_state USING(workspace_id IN(SELECT workspace_id FROM workspace_members WHERE user_id=current_setting('app.current_user_id',true)::uuid));`)
  // A transaction-local setting with no session default reverts to empty, not NULL.
  await pool.query('RESET app.current_user_id')
  await pool.query('BEGIN')
  await pool.query("SELECT set_config('app.current_user_id',$1,true)",[owner])
  await pool.query('COMMIT')
  expect((await pool.query("SELECT current_setting('app.current_user_id',true) actor")).rows[0].actor).toBe('')
  await expect(listHomeApps(workspace)).rejects.toMatchObject({code:'22P02'})
  await applyRoleMigration()
  expect(await fixtureSnapshot()).toEqual(before)
  expect((await listHomeApps(workspace)).map(row=>row.id)).toEqual([app])
  expect((await pool.query("SELECT bool_and(relrowsecurity AND NOT relforcerowsecurity) ok FROM pg_class WHERE oid IN('workspace_home_apps'::regclass,'home_app_state'::regclass)")).rows[0].ok).toBe(true)
  expect((await pool.query("SELECT count(*)::integer n FROM pg_policies WHERE tablename IN('workspace_home_apps','home_app_state') AND policyname LIKE '%system_bypass'")).rows[0].n).toBe(0)
 })

 it('uses ordinary owner authority for system reads and state writes after actor reset',async()=>{
  await pool.query("SELECT set_config('app.system_bypass','',false)")
  expect((await listHomeApps(workspace)).map(row=>row.id)).toEqual([app])
  await pool.query("UPDATE home_app_state SET data=data||'{\"systemWrite\":true}' WHERE app_id=$1",[app])
  expect((await pool.query('SELECT data FROM home_app_state WHERE app_id=$1',[app])).rows[0].data)
   .toEqual({retained:true,systemWrite:true})
 })

 it('keeps owner/member reads and writes confined to their workspace regardless of bypass settings',async()=>{
  for(const actor of [owner,member])for(const bypass of ['', 'true'])await asApp(actor,bypass,async connection=>{
   expect((await connection.query('SELECT id FROM workspace_home_apps WHERE id=ANY($1::uuid[]) ORDER BY id',[[app,otherApp]])).rows).toEqual([{id:app}])
   expect((await connection.query('SELECT app_id FROM home_app_state WHERE app_id=ANY($1::uuid[])',[[app,otherApp]])).rows).toEqual([{app_id:app}])
   expect((await connection.query("UPDATE home_app_state SET data=data||'{\"memberWrite\":true}' WHERE app_id=$1 RETURNING app_id",[app])).rows).toEqual([{app_id:app}])
   expect((await connection.query("UPDATE workspace_home_apps SET name='Denied mutation' WHERE id=$1 RETURNING id",[otherApp])).rows).toEqual([])
  })
 })

 it('denies blank, missing-member and other-workspace actors without UUID errors or mutable bypass authority',async()=>{
  for(const actor of ['','00000000-0000-0000-0000-000000000000',randomUUID(),outsider])for(const bypass of ['', 'true'])await asApp(actor,bypass,async connection=>{
   expect((await connection.query('SELECT id FROM workspace_home_apps WHERE id=$1',[app])).rows).toEqual([])
   expect((await connection.query('SELECT app_id FROM home_app_state WHERE app_id=$1',[app])).rows).toEqual([])
   expect((await connection.query("UPDATE home_app_state SET data='{}' WHERE app_id=$1 RETURNING app_id",[app])).rows).toEqual([])
   await connection.query('SAVEPOINT denied_registry_insert')
   await expect(connection.query("INSERT INTO workspace_home_apps(workspace_id,kind,name,root_path) VALUES($1,'upload','Denied app','/apps/denied/')",[workspace])).rejects.toMatchObject({code:'42501'})
   await connection.query('ROLLBACK TO SAVEPOINT denied_registry_insert')
   await expect(connection.query("INSERT INTO home_app_state(app_id,workspace_id,user_id,data) VALUES($1,$2,NULL,'{}')",[app,workspace])).rejects.toMatchObject({code:'42501'})
  })
 })
})
