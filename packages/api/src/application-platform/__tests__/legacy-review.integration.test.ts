/** Pending historical application reviews survive SQL new-authoring retirement. */
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg, { type Pool, type PoolClient } from 'pg'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMemory } from '../../db/memories.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'

const { createLocalFixture, cleanRuntimeEnvironment, assertLocalFixture, runCommand } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
const boundary='8121_application_legacy_authoring_retirement.sql'
const sql = await readFile(new URL('../../../migrations/'+boundary,import.meta.url),'utf8')
const historical = await readFile(new URL('../../../migrations/8089_application_legacy_review.sql',import.meta.url),'utf8')
const functions = [...historical.matchAll(/CREATE FUNCTION ([a-z_]+)\(([^]*?) AS \$\$([^]*?)\$\$;/g)]
  .map(match => ({ name:match[1],body:match[3] }))
const names=functions.map(fn=>fn.name)
type Review={id:string;version:string;payloadHash:string;status:string;items:Array<{resourceId:string;status:string;replacementId:string|null;resultVersion:string|null}>}
type Case={workspaceId:string;actorId:string;memberId:string;foreignId:string;assistantId:string;otherAssistantId:string;departmentId:string|null;sourceId:string;ids:string[];review:Review}
let fixture:Awaited<ReturnType<typeof createLocalFixture>>|undefined,owner:Pool,app:Pool,setup:Pool,appClosed=false
let beforeCatalog:any[],beforeData:any,ordinaryIdentity:any,callbackCount=0,prerequisiteRejections=0
const poolFailures:string[]=[],pools=new Set<Pool>(),closedPools=new Set<Pool>()
const pool=(url:string,max:number)=>{const result=new pg.Pool({connectionString:url,max});pools.add(result);result.on('error',error=>poolFailures.push(error.message));return result}
async function close(value:Pool|undefined){if(value&&!closedPools.has(value)){closedPools.add(value);await value.end()}}
const cases=new Map<string,Case>()
const administrator='legacy_retirement_fixture_admin',observer='legacy_retirement_fixture_observer',installer='legacy_retirement_owner',copyDatabase='legacy_review_upgrade_fixture'
const password=randomBytes(32).toString('hex'),installerPassword=randomBytes(32).toString('hex')
let dumpFile:string,ordinaryUrl:string,copyApplied=0,primaryIdentity:any
async function migrateCopy(){const {tsImport}=await import('tsx/esm/api');const {runMigrations}=await tsImport('../../../scripts/migrate.ts',import.meta.url);return runMigrations({databaseUrl:ordinaryUrl})}

async function native<T>(pool:Pool,f:Case,fn:(client:PoolClient)=>Promise<T>,options:{actor?:string;assistant?:string;application?:boolean}={}):Promise<T>{
 const client=await pool.connect()
 try{await client.query('BEGIN');await client.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.v2_assistant_id',$2,true),set_config('app.application_id',$3,true)",[options.actor??f.actorId,options.assistant??f.assistantId,options.application?randomUUID():'']);const result=await fn(client);await client.query('COMMIT');return result}
 catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
}
async function preview(f:Case,ids=f.ids,options:Parameters<typeof native>[3]={}):Promise<Review>{
 return native(app,f,async client=>(await client.query("SELECT application_legacy_review_preview($1,$2,'memory',$3,'release','Fictional retained review') AS value",[f.workspaceId,f.assistantId,ids])).rows[0].value,options)
}
async function view(f:Case,options:Parameters<typeof native>[3]={}):Promise<Review>{return native(app,f,async client=>(await client.query('SELECT application_legacy_review_view($1,$2,$3) AS value',[f.workspaceId,f.assistantId,f.review.id])).rows[0].value,options)}
async function apply(f:Case,review=f.review,cancel=false,options:Parameters<typeof native>[3]={}):Promise<Review>{return native(app,f,async client=>(await client.query('SELECT application_legacy_review_apply($1,$2,$3,$4,$5,$6) AS value',[f.workspaceId,f.assistantId,review.id,review.version,review.payloadHash,cancel])).rows[0].value,options)}
async function roleIdentity(pool:Pool){return(await pool.query(`SELECT current_user,session_user,r.rolsuper,r.rolbypassrls,r.rolinherit,
 (SELECT count(*)::int FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS memberships,
 (SELECT count(*)::int FROM pg_class c WHERE c.relowner=r.oid AND c.oid='public.workspace_scope_reviews'::regclass) AS owns_reviews
 FROM pg_roles r WHERE r.rolname=current_user`)).rows[0]}
async function catalog(){return(await owner.query(`SELECT p.oid::text,p.proname,p.proowner::text,p.prosrc,p.proconfig,p.prosecdef,p.provolatile,p.proparallel,p.proisstrict,p.proleakproof,p.prokind,
 p.proargtypes::text,p.proargnames,p.proargmodes,p.prorettype::regtype::text,pg_get_expr(p.proargdefaults,0) AS defaults,
 coalesce((SELECT jsonb_agg(jsonb_build_object('grantor',a.grantor::text,'grantee',a.grantee::text,'role',r.rolname,'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type)
 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a LEFT JOIN pg_roles r ON r.oid=a.grantee),'[]') AS acl
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname`,[names])).rows}
async function data(f?:Case){const values=f?[f.workspaceId]:[];const condition=f?' WHERE workspace_id=$1':'';const result:Record<string,unknown>={}
 for(const table of ['workspace_scope_reviews','workspace_scope_review_items','memories','scope_derivations','scope_derivation_sources','scope_resource_states','workspace_access_events']){
  result[table]=(await owner.query(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') AS rows FROM public.${table} r${condition}`,values)).rows[0].rows
 }return result}
async function createCase(label:string,privateRow=true,count=1,placed=false):Promise<Case>{
 const f:Case={workspaceId:randomUUID(),actorId:randomUUID(),memberId:randomUUID(),foreignId:randomUUID(),assistantId:randomUUID(),otherAssistantId:randomUUID(),departmentId:placed?randomUUID():null,sourceId:'',ids:[],review:null as unknown as Review}
 const client=await owner.connect()
 try{await client.query('BEGIN')
  for(const id of [f.actorId,f.memberId,f.foreignId])await client.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await client.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional retained recovery',$2)",[f.workspaceId,f.actorId])
  for(const id of [f.actorId,f.memberId])await client.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[f.workspaceId,id,id===f.actorId?'owner':'member'])
  if(f.departmentId)f.departmentId=(await createDbWorkspaceGroupStore(client).createTeam(f.actorId,f.workspaceId,{name:'Fictional review department',key:'fictional-review'})).id
  for(const id of [f.assistantId,f.otherAssistantId])await client.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,placement_department_id) VALUES($1,'Fictional recovery assistant',$2,$3,'standard','confidential',$4)",[id,f.actorId,f.workspaceId,id===f.assistantId?f.departmentId:null])
  if(f.departmentId){await client.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','owner') ON CONFLICT DO NOTHING",[f.workspaceId,f.departmentId,f.actorId]);await client.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','assistant') ON CONFLICT DO NOTHING",[f.workspaceId,f.departmentId,f.assistantId])}
  const params={workspaceId:f.workspaceId,userId:privateRow?f.actorId:null,assistantId:f.assistantId,createdByUserId:f.actorId,summary:'Fictional retained source',detail:'Fictional exact source details',sensitivity:'internal' as const,tags:['fictional','retained']}
  const source=await createMemory(params,undefined,client);f.sourceId=source.id
  const snapshot=(await client.query("SELECT read_scope_source($1,'memory',$2) AS value",[f.workspaceId,source.id])).rows[0].value
  for(let index=0;index<count;index++){
   const target=await createMemory({...params,summary:'Fictional held content',detail:'Fictional exact retained details',derivation:{producer:'fixture:retained-review',sources:[snapshot]}},undefined,client)
   await client.query('UPDATE memories SET scope_held=true WHERE workspace_id=$1 AND id=$2',[f.workspaceId,target.id]);f.ids.push(target.id)
  }
  await client.query('COMMIT')
 }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
 f.review=await preview(f);cases.set(label,f);return f
}
async function preparePending(){
 for(const [name,priv,count,placed] of [['private',true,1,false],['shared',false,1,false],['pages',true,26,false],['source',true,1,false],['policy',true,1,false],['admin',true,1,false],['assistant',true,1,true],['rollback',true,1,false]] as const)await createCase(name,priv,count,placed)
 for(const [name,priv,count,placed] of [['transport-private',true,1,false],['transport-shared',false,1,false],['transport-pages',true,26,false],['transport-source',true,1,false],['transport-policy',true,1,false],['transport-admin',true,1,false],['transport-assistant',true,1,true],['transport-uncertain',true,1,false]] as const)await createCase(name,priv,count,placed)
 const f=cases.get('private')!
 for(const options of [{actor:f.memberId},{actor:f.foreignId},{application:true}])await expect(preview(f,f.ids,options)).rejects.toMatchObject({code:'42501'})
 await expect(native(owner,f,async client=>client.query("SELECT application_legacy_review_preview($1,$2,'memory',$3,'release','Fictional denied owner')",[f.workspaceId,f.assistantId,f.ids]))).rejects.toMatchObject({code:'42501'})
 await expect(preview(cases.get('shared')!,f.ids)).rejects.toMatchObject({code:'42501'})
 // Canonical creation followed by owned-fixture historical-state changes. No raw
 // Memory INSERT or fabricated review JSON can substitute for the actual preview.
 for(const kind of ['authorless','administrator-held','wrong-owner','wrong-private-owner']){
  const denied=await createCase('denied-'+kind,true)
  if(kind==='authorless')await owner.query('UPDATE memories SET created_by_user_id=NULL,created_by_assistant_id=NULL WHERE id=$1',[denied.ids[0]])
  if(kind==='wrong-owner')await owner.query('UPDATE memories SET created_by_user_id=$2 WHERE id=$1',[denied.ids[0],denied.memberId])
  if(kind==='wrong-private-owner')await owner.query('UPDATE memories SET user_id=$2 WHERE id=$1',[denied.ids[0],denied.memberId])
  if(kind==='administrator-held')await owner.query("INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason) SELECT workspace_id,'memory',id,scope_version::text,'held',1,'administrator_review' FROM memories WHERE id=$1",[denied.ids[0]])
  await expect(preview(denied)).rejects.toMatchObject({code:'42501'})
 }
}
async function provePrerequisites(){
 const changes=[
  'ALTER FUNCTION application_legacy_repair_plan(uuid,uuid) SECURITY INVOKER',
  "ALTER FUNCTION application_legacy_repair_plan(uuid,uuid) SET search_path=public,pg_temp",
  "CREATE OR REPLACE FUNCTION application_legacy_repair_plan(w uuid,i uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$BEGIN RETURN NULL;END$$",
  'GRANT EXECUTE ON FUNCTION application_legacy_repair_plan(uuid,uuid) TO PUBLIC',
  `GRANT EXECUTE ON FUNCTION application_legacy_repair_plan(uuid,uuid) TO ${observer}`,
  `GRANT EXECUTE ON FUNCTION application_legacy_inventory(uuid,uuid,text,uuid) TO ${observer}`,
  'GRANT EXECUTE ON FUNCTION application_legacy_review_view(uuid,uuid,uuid) TO app_user WITH GRANT OPTION',
  'REVOKE EXECUTE ON FUNCTION application_legacy_review_view(uuid,uuid,uuid) FROM app_user',
 ]
 for(const change of changes){const client=await owner.connect();try{await client.query('BEGIN');await client.query(change);await expect(client.query(sql)).rejects.toMatchObject({code:'55000'});prerequisiteRejections++;await client.query('ROLLBACK')}finally{await client.query('ROLLBACK');client.release()}}
 for(const attribute of ['SUPERUSER','BYPASSRLS']){
  try{await setup.query(`ALTER ROLE app_user ${attribute}`);const client=await owner.connect();try{await expect(client.query(sql)).rejects.toMatchObject({code:'55000'});prerequisiteRejections++;await client.query('ROLLBACK')}finally{client.release()}}
  finally{await setup.query(`ALTER ROLE app_user NO${attribute}`)}
 }
 for(const inherit of [false,true]){
  try{await setup.query(`GRANT legacy_retirement_owner TO app_user WITH INHERIT ${inherit}`)
   expect((await owner.query("SELECT pg_has_role('app_user','legacy_retirement_owner','MEMBER') AS member,pg_has_role('app_user','legacy_retirement_owner','USAGE') AS inherited")).rows[0]).toEqual({member:true,inherited:inherit})
   const client=await owner.connect();try{await expect(client.query(sql)).rejects.toMatchObject({code:'55000'});prerequisiteRejections++;await client.query('ROLLBACK')}finally{client.release()}
  }finally{await setup.query('REVOKE legacy_retirement_owner FROM app_user')}
 }
 expect((await roleIdentity(app)).memberships).toBe(0)
 expect(await catalog()).toEqual(beforeCatalog);expect(await data()).toEqual(beforeData)
 expect((await owner.query('SELECT count(*)::int AS n FROM _migrations WHERE name=$1',[boundary])).rows[0].n).toBe(0)
}

describe.sequential('[COMP:api/application-legacy-review] retained pending recovery after SQL authoring retirement',()=>{
 beforeAll(async()=>{
  fixture=await createLocalFixture({env:cleanRuntimeEnvironment(process.env),runtimeRole:'app_user',beforeApplyFile:boundary,beforeApply:async({adminUrl,appUrl,env}:{adminUrl:string;appUrl:string;env:Record<string,string>})=>{
   callbackCount++;owner=pool(adminUrl,4);app=pool(appUrl,4)
   await owner.query(`CREATE ROLE ${administrator} LOGIN PASSWORD '${password}' SUPERUSER NOINHERIT;
    CREATE ROLE ${observer} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${installer} LOGIN PASSWORD '${installerPassword}' NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB NOREPLICATION`)
   const setupUrl=new URL(adminUrl);setupUrl.username=administrator;setupUrl.password=password;setup=pool(setupUrl.href,2)
   try{
    await preparePending();beforeCatalog=await catalog();beforeData=await data()
    dumpFile=join(dirname(env.BRIAN_ASSURANCE_FIXTURE),'pending-upgrade.dump')
    await runCommand('pg_dump',['--format=custom','--no-owner','--file',dumpFile],{env})
   }catch(error){await close(app);appClosed=true;await close(owner);await close(setup);throw error}
  }})
  await assertLocalFixture(fixture.env)
  // The maintained primary's immutable bootstrap role completes its normal run.
  // The real ordinary-owner proof uses its genuine pre8121 snapshot, never a
  // regrant or a forged pending review. Business IDs/hashes/data remain exact.
  primaryIdentity=await roleIdentity(owner);expect(primaryIdentity.current_user).toBe('assurance_owner');expect(primaryIdentity.rolsuper).toBe(true)
  expect(await data()).toEqual(beforeData)
  const primaryCatalog=await catalog()
  for(let i=0;i<primaryCatalog.length;i++){
   const {acl:beforeAcl,...before}=beforeCatalog[i],{acl:afterAcl,...after}=primaryCatalog[i];expect(after).toEqual(before)
   expect(afterAcl).toEqual(['application_legacy_inventory','application_legacy_review_preview'].includes(after.proname)?beforeAcl.filter((a:any)=>a.role!=='app_user'):beforeAcl)
  }
  expect((await owner.query('SELECT count(*)::int AS n FROM _migrations WHERE name=$1',[boundary])).rows[0].n).toBe(1)
  await setup.query(`CREATE DATABASE ${copyDatabase} OWNER ${administrator}`)
  const copyAdminUrl=new URL(fixture.adminUrl);copyAdminUrl.username=administrator;copyAdminUrl.password=password;copyAdminUrl.pathname='/'+copyDatabase
  expect(copyAdminUrl.hostname).toBe('127.0.0.1');expect(copyAdminUrl.port).toBe(new URL(fixture.adminUrl).port)
  await runCommand('pg_restore',['--no-owner','--exit-on-error','--dbname',copyDatabase,dumpFile],{env:{...fixture.env,PGUSER:administrator,PGPASSWORD:password,PGDATABASE:copyDatabase}})
  const copySetup=pool(copyAdminUrl.href,2)
  // REASSIGN's shared ownership effect is bounded: this role owns ONLY this
  // explicitly created copied database; the primary and templates are excluded.
  expect((await copySetup.query('SELECT datname FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=$1) ORDER BY datname',[administrator])).rows).toEqual([{datname:copyDatabase}])
  expect((await copySetup.query('SELECT current_database() AS name')).rows[0].name).toBe(copyDatabase)
  await copySetup.query(`REASSIGN OWNED BY ${administrator} TO ${installer}`)
  const installerUrl=new URL(copyAdminUrl);installerUrl.username=installer;installerUrl.password=installerPassword;ordinaryUrl=installerUrl.href
  const runtimeUrl=new URL(fixture.appUrl);runtimeUrl.pathname='/'+copyDatabase
  await close(owner);await close(app);await close(setup)
  owner=pool(ordinaryUrl,4);app=pool(runtimeUrl.href,4);setup=copySetup;appClosed=false
  ordinaryIdentity=await roleIdentity(owner)
  expect(ordinaryIdentity).toEqual({current_user:installer,session_user:installer,rolsuper:false,rolbypassrls:false,rolinherit:false,memberships:0,owns_reviews:1})
  expect(await data()).toEqual(beforeData);beforeCatalog=await catalog()
  expect((await owner.query('SELECT count(*)::int AS n FROM _migrations WHERE name=$1',[boundary])).rows[0].n).toBe(0)
  await provePrerequisites()
  copyApplied=(await migrateCopy()).appliedCount
 },120_000)
 afterAll(async()=>{for(const value of pools)await close(value);await fixture?.dispose();expect(poolFailures).toEqual([])})
 it('installs once as the ordinary owner, changes exactly two ACLs and preserves all data',async()=>{
  expect(callbackCount).toBe(1);expect(copyApplied).toBe(4);expect(prerequisiteRejections).toBe(12);expect(await roleIdentity(owner)).toEqual(ordinaryIdentity)
  expect(await roleIdentity(app)).toEqual({current_user:'app_user',session_user:'app_user',rolsuper:false,rolbypassrls:false,rolinherit:false,memberships:0,owns_reviews:0})
  expect((await owner.query('SELECT name FROM _migrations WHERE name=ANY($1::text[]) ORDER BY name',[[boundary,'8122_application_native_module_availability.sql','8123_native_task_review_classification.sql','8124_application_source_host_retirement.sql']])).rows).toEqual([{name:boundary},{name:'8122_application_native_module_availability.sql'},{name:'8123_native_task_review_classification.sql'},{name:'8124_application_source_host_retirement.sql'}])
  expect((await owner.query('SELECT count(*)::int AS n FROM _migrations WHERE name=$1',[boundary])).rows[0].n).toBe(1)
  expect(await data()).toEqual(beforeData)
  expect((await migrateCopy()).appliedCount).toBe(0)
  const after=await catalog();expect(after).toHaveLength(functions.length)
  for(let i=0;i<after.length;i++){
   const {acl:oldAcl,...oldMetadata}=beforeCatalog[i],{acl:newAcl,...newMetadata}=after[i]
   expect(newMetadata).toEqual(oldMetadata);expect(newMetadata.prosrc).toBe(functions.find(fn=>fn.name===newMetadata.proname)!.body)
   expect(newAcl).toEqual(['application_legacy_inventory','application_legacy_review_preview'].includes(newMetadata.proname)?oldAcl.filter((entry:any)=>entry.role!=='app_user'):oldAcl)
   expect(newAcl.every((entry:any)=>!entry.grantable&&[installer,'app_user'].includes(entry.role))).toBe(true)
   const allowed=(await owner.query("SELECT has_function_privilege('app_user',$1::oid,'EXECUTE') AS value",[newMetadata.oid])).rows[0].value
   expect(allowed).toBe(['application_legacy_review_view','application_legacy_review_apply'].includes(newMetadata.proname))
  }
 })
 it('denies new SQL inventory/preview to native administrators while original reviews remain metadata-only',async()=>{
  const f=cases.get('private')!,before=await data(f)
  await expect(preview(f)).rejects.toMatchObject({code:'42501'})
  await expect(native(app,f,client=>client.query("SELECT application_legacy_inventory($1,$2,'memory',NULL)",[f.workspaceId,f.assistantId]))).rejects.toMatchObject({code:'42501'})
  const saved=await view(f);expect(saved).toEqual(f.review);expect(JSON.stringify(saved)).not.toMatch(/Fictional held content|Fictional exact retained details/)
  expect(await data(f)).toEqual(before)
 })
 it.each(['private','shared'])('preserves exact %s partition, authorship, content and envelope with fresh complete lineage',async name=>{
  const f=cases.get(name)!,original=(await owner.query('SELECT to_jsonb(m) AS value FROM memories m WHERE id=$1',[f.ids[0]])).rows[0].value
  const applied=await apply(f);expect(applied.status).toBe('complete');expect(applied.id).toBe(f.review.id);expect(applied.payloadHash).toBe(f.review.payloadHash)
  const replacementId=applied.items[0].replacementId!;expect(replacementId).toMatch(/^[a-f0-9-]{36}$/)
  const replacement=(await owner.query('SELECT to_jsonb(m) AS value FROM memories m WHERE id=$1',[replacementId])).rows[0].value
  for(const column of ['assistant_id','user_id','app_id','workspace_id','scope','tags','summary','detail','confidence','sensitivity','source','source_session_id','created_by_user_id','created_by_assistant_id','source_episode_id','verified_by_user_id','verified_at','original_scope','original_sensitivity','original_summary','compartments','project_ids'])expect(replacement[column],column).toEqual(original[column])
  expect(replacement.user_id).toBe(name==='private'?f.actorId:null);expect(replacement.scope_held).toBe(false);expect(replacement.valid_to).toBeNull()
  const retired=(await owner.query('SELECT scope_held,valid_to,superseded_by FROM memories WHERE id=$1',[f.ids[0]])).rows[0];expect(retired.scope_held).toBe(true);expect(retired.valid_to).not.toBeNull();expect(retired.superseded_by).toBe(replacementId)
  const lineage=(await owner.query("SELECT d.resource_version,d.user_id,d.assistant_id,s.source_kind,s.source_id,s.source_version FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='memory' AND d.resource_id=$2",[f.workspaceId,replacementId])).rows
  expect(lineage).toEqual([{resource_version:String(replacement.scope_version),user_id:original.user_id,assistant_id:original.assistant_id,source_kind:'memory',source_id:f.sourceId,source_version:'1'}])
  expect(await apply(f)).toEqual(applied)
 })
 it('pages original saved IDs, refuses future CAS, replays and cancels without reverting committed replacements',async()=>{
  const f=cases.get('pages')!;await expect(apply(f,{...f.review,version:'999'})).rejects.toMatchObject({code:'40001'})
  const page=await apply(f);expect(page.status).toBe('running');expect(page.items.filter(item=>item.status==='applied')).toHaveLength(25)
  expect(await apply(f)).toEqual(page)
  const cancelled=await apply(f,page,true);expect(cancelled.status).toBe('cancelled');expect(cancelled.items.filter(item=>item.status==='cancelled')).toHaveLength(1)
  expect(cancelled.items.filter(item=>item.replacementId)).toEqual(page.items.filter(item=>item.replacementId));expect(await apply(f,cancelled)).toEqual(cancelled)
  expect((await owner.query('SELECT count(*)::int AS n FROM memories WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND scope_held AND superseded_by IS NOT NULL',[f.workspaceId,f.ids])).rows[0].n).toBe(25)
 })
 it.each(['source','policy'])('marks changed current %s stale without copying',async name=>{
  const f=cases.get(name)!
  if(name==='source')await owner.query('UPDATE memories SET summary=$2 WHERE id=$1',[f.sourceId,'Fictional changed source'])
  else await owner.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1',[f.workspaceId])
  const result=await apply(f);expect(result.status).toBe('stale');expect(result.items[0].replacementId).toBeNull()
  expect((await owner.query('SELECT scope_held,superseded_by FROM memories WHERE id=$1',[f.ids[0]])).rows[0]).toEqual({scope_held:true,superseded_by:null})
 })
 it('rechecks revoked administrator, placement and exact selected assistant; rejects app audience and owner pool',async()=>{
  const admin=cases.get('admin')!,assistant=cases.get('assistant')!,before=await data(admin)
  await owner.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[admin.workspaceId,admin.actorId])
  await expect(apply(admin)).rejects.toMatchObject({code:'42501'})
  await owner.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[admin.workspaceId,admin.actorId])
  // Same statement as the supported archiveTeam path, on its actual native
  // app_user transaction. Owner-edge/last-owner guards remain intact.
  expect((await native(app,assistant,client=>client.query("UPDATE workspace_groups SET status='archived' WHERE id=$1 AND kind='team' AND status='active' RETURNING id",[assistant.departmentId]))).rowCount).toBe(1)
  await expect(apply(assistant)).rejects.toMatchObject({code:'42501'})
  for(const options of [{actor:admin.memberId},{actor:admin.foreignId},{application:true},{assistant:admin.otherAssistantId}])await expect(apply(admin,admin.review,false,options)).rejects.toMatchObject({code:'42501'})
  await expect(native(owner,admin,client=>client.query('SELECT application_legacy_review_apply($1,$2,$3,$4,$5,false)',[admin.workspaceId,admin.assistantId,admin.review.id,admin.review.version,admin.review.payloadHash]))).rejects.toMatchObject({code:'42501'})
  expect(await data(admin)).toEqual(before)
 })
 it('denies inherited-owner invocation through the existing native authority check',async()=>{
  const f=cases.get('admin')!,before=await data(f)
  try{await setup.query('GRANT legacy_retirement_owner TO app_user WITH INHERIT TRUE')
   expect((await app.query("SELECT current_user,session_user,pg_has_role(current_user,'legacy_retirement_owner','USAGE') AS inherited")).rows[0]).toEqual({current_user:'app_user',session_user:'app_user',inherited:true})
   await expect(preview(f)).rejects.toMatchObject({code:'42501',message:'access_unavailable'})
   await expect(apply(f)).rejects.toMatchObject({code:'42501',message:'access_unavailable'})
  }finally{await setup.query('REVOKE legacy_retirement_owner FROM app_user')}
  expect((await roleIdentity(app)).memberships).toBe(0);expect(await data(f)).toEqual(before)
 })
 it('rolls back every copy/lineage/retirement/progress effect when lineage fails, then retries original review',async()=>{
  const f=cases.get('rollback')!,before=await data(f)
  await owner.query(`CREATE FUNCTION legacy_review_fixture_lineage_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.workspace_id='${f.workspaceId}'::uuid THEN RAISE EXCEPTION 'fictional_lineage_failure';END IF;RETURN NEW;END$$;
   CREATE TRIGGER legacy_review_fixture_lineage_failure BEFORE INSERT ON scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION legacy_review_fixture_lineage_failure()`)
  try{await expect(apply(f)).rejects.toMatchObject({code:'P0001',message:'fictional_lineage_failure'});expect(await data(f)).toEqual(before)}
  finally{await owner.query('DROP TRIGGER legacy_review_fixture_lineage_failure ON scope_derivation_sources;DROP FUNCTION legacy_review_fixture_lineage_failure()')}
  expect((await apply(f)).status).toBe('complete')
 })
 it('keeps private helpers and raw held data/proposal writes unavailable to app_user',async()=>{
  const f=cases.get('admin')!,before=await data(f)
  for(const query of ['SELECT application_legacy_repair_plan($1,$2)','SELECT application_legacy_review_authorize($1,$2)'])await expect(native(app,f,client=>client.query(query,[f.workspaceId,f.ids[0]]))).rejects.toMatchObject({code:'42501'})
  expect(await native(app,f,async client=>(await client.query('SELECT id,summary FROM memories WHERE id=$1',[f.ids[0]])).rows)).toEqual([])
  const changed=await native(app,f,client=>client.query("UPDATE workspace_scope_reviews SET reason='Fictional unreviewed mutation' WHERE id=$1",[f.review.id]));expect(changed.rowCount).toBe(0)
  const raw=await native(app,f,client=>client.query('UPDATE memories SET user_id=NULL WHERE id=$1',[f.ids[0]]));expect(raw.rowCount).toBe(0)
  expect(await data(f)).toEqual(before)
 })
 it('recovers genuine primary pre8121 reviews through current authenticated HTTP and MCP',async()=>{
  // Isolated child binds every global auth/system/app pool to the maintained
  // PRIMARY fixture; copied ordinary-owner proof above remains independent.
  const transport=Object.fromEntries([...cases].filter(([key])=>key.startsWith('transport-')))
  const logPath=join(fixture!.directory,'legacy-transport.log')
  try{await runCommand(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.integration.config.ts','src/application-platform/__tests__/legacy-review-transport.integration.test.ts','--no-file-parallelism'],{
   cwd:fileURLToPath(new URL('../../../',import.meta.url)),env:{...fixture!.env,BRIAN_ASSURANCE_LEGACY_CASES:JSON.stringify(transport)},logPath,
  })}finally{console.log(await readFile(logPath,'utf8').catch(()=> 'Transport child produced no log'))}
 })
 it('accepts the exact no-app_user prerequisite state as an ordinary owner without recreating grants or data',async()=>{
  // Final rehearsal only: these are the fresh fixture's own role/grants. Closing
  // clients prevents accidental reuse; cleanup is OS-owned and needs no role.
  await close(app);appClosed=true
  const before=await data(),metadata=await catalog()
  const primarySetupUrl=new URL(fixture!.adminUrl);primarySetupUrl.username=administrator;primarySetupUrl.password=password
  const primarySetup=pool(primarySetupUrl.href,1)
  expect((await primarySetup.query('SELECT current_database() AS name')).rows[0].name).toBe('brian_assurance')
  await primarySetup.query('DROP OWNED BY app_user');await close(primarySetup)
  expect((await setup.query('SELECT current_database() AS name')).rows[0].name).toBe(copyDatabase)
  await setup.query('DROP OWNED BY app_user;DROP ROLE app_user')
  expect((await owner.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='app_user'")).rows[0].n).toBe(0)
  expect(await roleIdentity(owner)).toEqual(ordinaryIdentity)
  await owner.query(sql)
  expect(await data()).toEqual(before)
  const after=await catalog();for(let i=0;i<after.length;i++){const {acl:oldAcl,...old}=metadata[i],{acl,...current}=after[i];expect(current).toEqual(old);expect(acl).toEqual(oldAcl.filter((a:any)=>a.role!=='app_user'))}
  expect((await owner.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='app_user'")).rows[0].n).toBe(0)
 })
})
