/** Actual legacy task readers retain canonical current field/query/history admission. */
import { randomBytes,randomUUID } from 'node:crypto'
import { z } from 'zod'
import { beforeAll,beforeEach,afterEach,afterAll,describe,it,expect } from 'vitest'
import { boundScopeSources,type AccessContext,type ScopeSource,type TaskRecord } from '@use-brian/core'
import type { ApplicationAccessGrant } from '@use-brian/shared'
import { getPool,getAppPool,applyRLSGucs } from '../../db/client.js'
import { createTask,updateTask,getTaskById,resolveTaskById,listTasks,getTaskHistory,listTasksBySourceEpisode,findRecentDuplicateTask } from '../../db/tasks.js'
import { LEGACY_TASK_FULL_FIELDS } from '../../db/task-reader.js'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { hashSecret } from '../../db/api-key-store.js'
import { authenticateApplicationCredential,mintApplicationCredentialSecret } from '../credentials.js'
import { loadApplicationCredentialStateSystem } from '../auth-store.js'
import { authenticateApplicationOAuth } from '../oauth-auth.js'
import { resolveApplicationExecutionContext } from '../execution-context.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalNativeApplicationModule } from '../native-adapters.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
describe('[COMP:api/application-records] canonical legacy task readers',()=>{
 const owner=getPool(),userId=randomUUID(),readerId=randomUUID(),assistantId=randomUUID()
 const fixtureUsers=[userId,readerId],fixtureOAuthClients:string[]=[]
 let workspaceId:string,episodeId:string,originalId:string,liveId:string,otherId:string,access:AccessContext,reader:AccessContext
 beforeAll(async()=>{
  for(const id of [userId,readerId])await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await owner.query(`CREATE FUNCTION task_reader_fixture_catalog(w uuid,o jsonb,t text) RETURNS jsonb
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   DECLARE keys text[];fields jsonb;
   BEGIN
    keys:=application_native_field_keys(t);
    SELECT jsonb_agg(jsonb_build_object('key',key,'read','[["reader"]]'::jsonb,'write','[["writer"]]'::jsonb,
     'releaseReadTo','["external_user","service"]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) INTO fields FROM unnest(keys) key;
    RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','task-reader-1','policyVersion','task-reader-1','fieldKeys',keys,'fields',fields,
     'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));
   END $$;
   REVOKE ALL ON FUNCTION task_reader_fixture_catalog(uuid,jsonb,text) FROM PUBLIC;
   CREATE FUNCTION task_reader_fixture_metadata(w uuid,o jsonb,t text,i text) RETURNS jsonb
   LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   DECLARE source jsonb;BEGIN source:=read_scope_source(w,'task',i::uuid);
    IF source IS NULL THEN RETURN NULL;END IF;
    RETURN (task_reader_fixture_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',source->>'version','source',source);
   END $$;
   REVOKE ALL ON FUNCTION task_reader_fixture_metadata(uuid,jsonb,text,text) FROM PUBLIC;
   INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
    VALUES('native','task-reader-1',ARRAY['reader','writer'],'task_reader_fixture_metadata(uuid,jsonb,text,text)'::regprocedure,'task_reader_fixture_catalog(uuid,jsonb,text)'::regprocedure)`)

 })
 beforeEach(async()=>{
  workspaceId=randomUUID();episodeId=randomUUID();access={workspaceId,userId,assistantId,assistantKind:'primary',clearance:'confidential'};reader={...access,userId:readerId}
  await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional task read boundaries',$2,false)",[workspaceId,userId])
  for(const id of [userId,readerId])await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[workspaceId,id,id===userId?'owner':'member'])
  await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional task reader',$2,$3,'primary','confidential')",[assistantId,userId,workspaceId])
  const original=await createTask(userId,{workspaceId,title:'Fictional original task',sourceEpisodeId:episodeId,sourceStartMs:1234,access});originalId=original.id
  const changed=await updateTask(userId,original.id,{status:'in_progress'},undefined,{access});expect(changed).not.toBeNull();liveId=changed!.id
  otherId=(await createTask(userId,{workspaceId,title:'Fictional other task',status:'todo',access})).id
  await owner.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}','task','native')`,[workspaceId])
  for(const [id,role] of [[userId,'reader'],[userId,'writer'],[readerId,'reader']])await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id,starts_at) VALUES($1,'native',$2,$3,$4,'2020-01-01T00:00:00Z')",[workspaceId,id,role,userId])
 })
 afterEach(async()=>{await owner.query('DELETE FROM workspaces WHERE id=$1',[workspaceId])})
 afterAll(async()=>{
  await owner.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
  await owner.query('DROP FUNCTION task_reader_fixture_metadata(uuid,jsonb,text,text);DROP FUNCTION task_reader_fixture_catalog(uuid,jsonb,text)')
  if(fixtureOAuthClients.length)await owner.query('DELETE FROM oauth_clients WHERE client_id=ANY($1::text[])',[fixtureOAuthClients])
  await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[fixtureUsers])
  await getAppPool().end();await owner.end()
 })
 async function provisionApplication(kind:'member'|'service',options:{readFields:string[];writeFields:string[];actions:ApplicationAccessGrant['actions'];ids:string[];issuerId?:string}) {
  const appId=randomUUID(),grantId=randomUUID(),issuerId=options.issuerId??userId
  let actorId=userId
  if(kind==='service') {
   actorId=randomUUID();fixtureUsers.push(actorId)
   await owner.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1,'channel',$2)",[actorId,`app-service:${appId}:${randomUUID()}`])
  }
  await owner.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id)
   VALUES($1,$2,'native','Fictional canonical task client','api_client',$3,$4)`,[appId,workspaceId,assistantId,issuerId])
  const grant:ApplicationAccessGrant={id:grantId,appId,workspaceId,principal:{kind,userId:actorId},origin:{kind:'native',moduleKey:'native'},typeKey:'task',
   actions:options.actions,readFields:options.readFields,writeFields:options.writeFields,selector:{kind:'ids',ids:options.ids},version:1,status:'active',
   startsAt:'2020-01-01T00:00:00.000Z',expiresAt:null,parentGrantId:null,compartments:[],projectIds:[],clearance:'confidential'}
  await owner.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,
   resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance,starts_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,'task',$8,$9,$10,$11,'{}','{}','confidential',$12)`,
   [grantId,appId,workspaceId,kind,actorId,issuerId,grant.origin,grant.actions,grant.readFields,grant.writeFields,grant.selector,grant.startsAt])
  const maximum={version:1,grants:[grant]}
  if(kind==='service') {
   const secret=await mintApplicationCredentialSecret()
   await owner.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
    VALUES($1,$2,$3,$4,$5,'Fictional task service key','service',$6,$7,now()+interval '1 hour')`,[secret.id,appId,workspaceId,issuerId,actorId,secret.secretHash,grantId])
   await owner.query('INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)',[secret.id,appId,workspaceId,grantId,maximum])
   const credential=await authenticateApplicationCredential(secret.token,appId,loadApplicationCredentialStateSystem)
   expect(credential).not.toBeNull()
   return {appId,grantId,actorId,authentication:{credential:credential!}}
  }
  const client=await createDbOAuthClientStore().register({clientName:'Fictional task member app',clientUri:'https://portal.example',redirectUris:['https://portal.example/callback'],tokenEndpointAuthMethod:'none'})
  fixtureOAuthClients.push(client.clientId)
  await owner.query('UPDATE application_clients SET oauth_client_id=$2 WHERE id=$1',[appId,client.clientId])
  const authorizationId=randomUUID(),secret=randomBytes(32).toString('base64url')
  await owner.query(`INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,audience,application_client_id,access_token_hash,access_token_expires_at)
   VALUES($1,$2,$3,$4,'read_write','application',$5,$6,now()+interval '1 hour')`,[authorizationId,client.clientId,actorId,workspaceId,appId,await hashSecret(secret)])
  await owner.query('INSERT INTO application_oauth_bindings(authorization_id,app_id,workspace_id,principal_user_id,parent_grant_id,maximum_grants) VALUES($1,$2,$3,$4,$5,$6)',
   [authorizationId,appId,workspaceId,actorId,grantId,JSON.stringify([maximum])])
  const user=await authenticateApplicationOAuth(`oat_${authorizationId}_${secret}`,appId)
  expect(user).not.toBeNull()
  return {appId,grantId,actorId,authentication:{user:user!}}
 }
 function legacyTaskApplication() {
  const base=createCanonicalNativeApplicationModule()
  return new ApplicationPlatformService([{...base,application:{...base.application!,queries:[...base.application!.queries,'legacy_task']},queries:{...base.queries,
   legacy_task:{input:z.object({id:z.string().uuid()}).strict(),authorize:async()=>{},execute:({execution,transaction},raw)=>getTaskById(execution.security.access,(raw as {id:string}).id,transaction)},
  }}])
 }
 function legacyTaskHistoryApplication() {
  const base=createCanonicalNativeApplicationModule()
  return new ApplicationPlatformService([{...base,application:{...base.application!,queries:[...base.application!.queries,'legacy_task_history']},queries:{...base.queries,
   legacy_task_history:{input:z.object({id:z.string().uuid()}).strict(),authorize:async()=>{},execute:({execution},raw)=>getTaskHistory(execution.security.access,(raw as {id:string}).id)},
  }}])
 }
 async function taskRows() {return(await owner.query('SELECT to_jsonb(t) AS value FROM tasks t WHERE workspace_id=$1 ORDER BY id',[workspaceId])).rows}
 async function current(source:ScopeSource){const client=await getAppPool().connect();try{await client.query('BEGIN');await applyRLSGucs(client,readerId);return(await client.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,source.resourceId,source.version])).rows[0].value}finally{await client.query('ROLLBACK');client.release()}}
 const revoke=()=>owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2 AND role_key='reader'",[workspaceId,userId])
 it('Q02/Q05 preserves strict physical lookup, forward resolution, DTO shape and current physical CAS evidence',async()=>{
  expect(await getTaskById(access,originalId)).toBeNull()
  const row=await resolveTaskById(access,originalId)
  expect(row).toMatchObject({id:liveId,logicalId:originalId,title:'Fictional original task',status:'in_progress',externalRef:{},attributes:{},assigneeId:null,home:null})
  expect(row!.createdAt).toBeInstanceOf(Date);expect(row!.updatedAt).toBeInstanceOf(Date)
  expect(boundScopeSources(row!)[0]).toMatchObject({resourceKind:'task',resourceId:liveId,version:'2'})
  expect(boundScopeSources(row!).some(source=>source.resourceKind==='application_field')).toBe(true)
  expect(await getTaskById(access,randomUUID())).toBeNull()
 })
 it('Q02/Q08 keeps compact legacy filters and captures every candidate before filtering and ordering',async()=>{
  const rows=await listTasks(reader,{status:'todo',includeArchived:true,limit:500})
  expect(rows.map(row=>row.id)).toEqual([otherId]);expect(Object.hasOwn(rows[0],'externalRef')).toBe(false);expect(Object.hasOwn(rows[0],'createdAt')).toBe(false)
  expect(boundScopeSources(rows).length).toBeGreaterThan(1)
  await revoke()
  await expect(listTasks(access,{status:'done'})).rejects.toMatchObject({code:'access_unavailable'})
  expect((await listTasks(reader,{status:'todo'})).map(row=>row.id)).toEqual([otherId])
 })
 it('Q02/Q03 refuses protected point and resolved bodies after role contraction while an independent current reader succeeds',async()=>{
  await revoke()
  await expect(getTaskById(access,liveId)).rejects.toMatchObject({code:'access_unavailable'})
  await expect(resolveTaskById(access,originalId)).rejects.toMatchObject({code:'access_unavailable'})
  expect(await getTaskById(reader,liveId)).toMatchObject({id:liveId,title:'Fictional original task'})
 })
 it('Q02 retains empty/excluded task domain evidence across a future canonical insertion',async()=>{
  const empty=await listTasks(reader,{status:'done'});expect(empty).toEqual([])
  const sources=boundScopeSources(empty),domain=(await owner.query("SELECT id FROM application_field_resources WHERE id=ANY($1::uuid[]) AND selection='query_domain'",[sources.map(source=>source.resourceId)])).rows[0]
  expect(domain).toBeDefined();const source=sources.find(source=>source.resourceId===domain.id)!;expect(await current(source)).toMatchObject({held:false})
  await createTask(userId,{workspaceId,title:'Fictional future task',access})
  const changed=await current(source);expect(changed===null||changed.held===true).toBe(true)
 })
 it('Q02/Q05 preserves exact physical history and includes canonical raw in-place before-images',async()=>{
  const client=await getAppPool().connect();try{await client.query('BEGIN');await applyRLSGucs(client,userId);await client.query('UPDATE tasks SET title=$2,updated_at=clock_timestamp() WHERE id=$1',[liveId,'Fictional raw current title']);await client.query('COMMIT')}finally{await client.query('ROLLBACK');client.release()}
  const rows=await getTaskHistory(reader,originalId)
  expect(rows.map(row=>({id:row.id,title:row.title,status:row.status}))).toEqual([
   {id:originalId,title:'Fictional original task',status:'todo'},
   {id:liveId,title:'Fictional original task',status:'in_progress'},
   {id:liveId,title:'Fictional raw current title',status:'in_progress'},
  ])
  expect(rows.every(row=>row.logicalId===originalId)).toBe(true)
  const field=boundScopeSources(rows).find(source=>source.resourceKind==='application_field')!;expect(await current(field)).toMatchObject({held:false})
  expect(await getTaskHistory(reader,randomUUID())).toEqual([])
 })
 it('Q02/Q08 admits recording filter, ordering, moment and verification fields before returning legacy recording rows',async()=>{
  const rows=await listTasksBySourceEpisode(reader,episodeId)
  expect(rows).toEqual([{id:liveId,title:'Fictional original task',status:'in_progress',assigneeId:null,sourceStartMs:1234,verified:false}])
  expect(boundScopeSources(rows).length).toBeGreaterThan(1)
  await revoke();await expect(listTasksBySourceEpisode(access,randomUUID())).rejects.toMatchObject({code:'access_unavailable'})
  expect(await listTasksBySourceEpisode(reader,episodeId)).toEqual(rows)
 })
 it('Q03 refuses a task reader using another authenticated transaction actor',async()=>{
  const client=await getAppPool().connect();try{await client.query('BEGIN');await applyRLSGucs(client,readerId);await expect(getTaskById(access,liveId,client)).rejects.toMatchObject({code:'access_unavailable'})}finally{await client.query('ROLLBACK');client.release()}
 })
 it('Q03/Q04/Q05 refuses legacy full task DTO writes, noops and duplicate returns after reader contraction without changing a row',async()=>{
  const before=await taskRows();let preconditionCalls=0,insertedCalls=0
  await revoke()
  expect((await owner.query("SELECT role_key FROM application_native_role_assignments WHERE workspace_id=$1 AND user_id=$2 AND status='active'",[workspaceId,userId])).rows).toEqual([{role_key:'writer'}])
  const operations=[
   ()=>updateTask(userId,liveId,{title:'Fictional hidden task write'},undefined,{access}),
   ()=>updateTask(userId,liveId,{},undefined,{access}),
   ()=>updateTask(userId,liveId,{status:'done'},undefined,{access,precondition:()=>{preconditionCalls++;return 'noop'}}),
   ()=>findRecentDuplicateTask(userId,{workspaceId,title:'Fictional other task',status:'todo',access}),
   ()=>createTask(userId,{workspaceId,title:'Fictional other task',status:'todo',access},undefined,undefined,{deduplicate:true,onInserted:()=>{insertedCalls++}}),
  ]
  for(const operation of operations) {
   await expect(operation()).rejects.toMatchObject({code:'access_unavailable'})
   expect(await taskRows()).toEqual(before)
  }
  expect(preconditionCalls).toBe(0);expect(insertedCalls).toBe(0)
  expect(await getTaskById(reader,liveId)).toMatchObject({id:liveId,title:'Fictional original task'})
 })
 it('Q03/Q05/Q06 retains actual member application write-only task patches and ref-only replay under stricter legacy read admission',async()=>{
  await owner.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,readerId])
  await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id,starts_at) VALUES($1,'native',$2,'writer',$3,'2020-01-01T00:00:00Z')",[workspaceId,readerId,userId])
  const application=await provisionApplication('member',{readFields:[],writeFields:['title'],actions:['patch','command:patch_task'],ids:[originalId],issuerId:readerId})
  await revoke()
  await expect(getTaskById(access,liveId)).rejects.toMatchObject({code:'access_unavailable'})
  const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),command={idempotencyKey:randomUUID(),expectedVersion:'2',input:{id:liveId,patch:{title:'Fictional write-only task change'}}}
  const receipt=await dispatcher.command(await resolveApplicationExecutionContext(application.authentication),'native','patch_task',command)
  expect(receipt.resources).toEqual([{workspaceId,origin:{kind:'native',moduleKey:'native'},typeKey:'task',id:originalId,version:'3'}])
  expect(JSON.stringify(receipt)).not.toContain('Fictional write-only task change')
  const current=(await owner.query('SELECT id,title,scope_version::text AS version FROM tasks WHERE workspace_id=$1 AND logical_id=$2 AND valid_to IS NULL',[workspaceId,originalId])).rows
  expect(current).toEqual([{id:expect.any(String),title:'Fictional write-only task change',version:'3'}])
  expect(await getTaskById(reader,current[0].id)).toMatchObject({title:'Fictional write-only task change'})
  await expect(getTaskById(access,current[0].id)).rejects.toMatchObject({code:'access_unavailable'})
  expect(await dispatcher.command(await resolveApplicationExecutionContext(application.authentication),'native','patch_task',command)).toEqual(receipt)
  expect((await owner.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[receipt.id])).rows[0].count).toBe(1)
  expect((await owner.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[receipt.id])).rows[0].count).toBe(1)
 })
 it('Q02/Q03/Q08 admits an exact released nonmember service through the actual legacy task getter and holds private siblings and issuer contraction',async()=>{
  const privateId=(await createTask(userId,{workspaceId,title:'Fictional private sibling task',visibility:{userId,assistantId:null},access})).id
  const application=await provisionApplication('service',{readFields:[...LEGACY_TASK_FULL_FIELDS],writeFields:[],actions:['read','query'],ids:[originalId,privateId]})
  const dispatcher=legacyTaskApplication(),execution=await resolveApplicationExecutionContext(application.authentication)
  expect((await owner.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,application.actorId])).rows).toEqual([])
  const row=await dispatcher.query(execution,'native','legacy_task',{id:liveId}) as TaskRecord|null
  expect(row).toMatchObject({id:liveId,logicalId:originalId,title:'Fictional original task',status:'in_progress',externalRef:{},attributes:{},assigneeId:null,home:null})
  expect(row!.createdAt).toBeInstanceOf(Date);expect(row!.updatedAt).toBeInstanceOf(Date)
  expect(boundScopeSources(row!).some(source=>source.resourceKind==='application_field')).toBe(true)
  expect(await dispatcher.query(await resolveApplicationExecutionContext(application.authentication),'native','legacy_task',{id:otherId})).toBeNull()
  expect(await dispatcher.query(await resolveApplicationExecutionContext(application.authentication),'native','legacy_task',{id:privateId})).toBeNull()
  await revoke()
  await expect(dispatcher.query(execution,'native','legacy_task',{id:liveId})).rejects.toMatchObject({reason:'authority_changed'})
  await expect(dispatcher.query(await resolveApplicationExecutionContext(application.authentication),'native','legacy_task',{id:liveId})).rejects.toMatchObject({code:'access_unavailable'})
  expect(await getTaskById(reader,liveId)).toMatchObject({id:liveId,title:'Fictional original task'})
 })

 it('Q02/Q05 invalidates nonempty task history collection evidence after a new legacy revision while an old physical observation remains current',async()=>{
  const rows=await getTaskHistory(reader,originalId)
  expect(rows.map(row=>row.id)).toEqual([originalId,liveId])
  const sources=boundScopeSources(rows)
  const domains=(await owner.query("SELECT id FROM application_field_resources WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND type_key='task_history_domain' AND selection='query_domain'",[workspaceId,sources.map(source=>source.resourceId)])).rows
  expect(domains).toHaveLength(1)
  const collection=sources.filter(source=>source.resourceId===domains[0].id)
  expect(collection).toHaveLength(1)
  const original=boundScopeSources(rows[0]).find(source=>source.resourceKind==='application_field')!
  expect(original).toBeDefined();expect(await current(original)).toMatchObject({held:false})
  for(const source of collection)expect(await current(source)).toMatchObject({held:false})
  const changed=await updateTask(userId,liveId,{title:'Fictional later history revision'},undefined,{access})
  expect(changed).toMatchObject({logicalId:originalId,title:'Fictional later history revision'})
  for(const source of collection){const state=await current(source);expect(state===null||state.held===true).toBe(true)}
  expect(await current(original)).toMatchObject({held:false})
  const fresh=await getTaskHistory(reader,originalId)
  expect(fresh.map(row=>row.id)).toEqual([originalId,liveId,changed!.id])
  expect(fresh[2].title).toBe('Fictional later history revision')
 })
 it('Q02/Q03 requires actual history rights for registered legacy history queries and admits exact history without a query grant',async()=>{
  const withoutHistory=await provisionApplication('member',{readFields:[...LEGACY_TASK_FULL_FIELDS],writeFields:[],actions:['read','query'],ids:[originalId]})
  const known=await legacyTaskApplication().query(await resolveApplicationExecutionContext(withoutHistory.authentication),'native','legacy_task',{id:liveId})
  expect(known).toMatchObject({id:liveId,logicalId:originalId,title:'Fictional original task'})
  const dispatcher=legacyTaskHistoryApplication()
  await expect(dispatcher.query(await resolveApplicationExecutionContext(withoutHistory.authentication),'native','legacy_task_history',{id:originalId})).rejects.toMatchObject({code:'access_unavailable'})
  const exactHistory=await provisionApplication('member',{readFields:[...LEGACY_TASK_FULL_FIELDS],writeFields:[],actions:['read','history'],ids:[originalId]})
  expect((await owner.query('SELECT actions FROM application_access_grants WHERE id=$1',[exactHistory.grantId])).rows[0].actions).toEqual(['read','history'])
  const rows=await dispatcher.query(await resolveApplicationExecutionContext(exactHistory.authentication),'native','legacy_task_history',{id:originalId}) as TaskRecord[]
  expect(rows.map(row=>({id:row.id,title:row.title,status:row.status}))).toEqual([
   {id:originalId,title:'Fictional original task',status:'todo'},
   {id:liveId,title:'Fictional original task',status:'in_progress'},
  ])
  expect(boundScopeSources(rows).length).toBeGreaterThan(rows.length)
  expect(rows.every(row=>row.logicalId===originalId)).toBe(true)
  expect((await getTaskHistory(reader,originalId)).map(row=>row.id)).toEqual([originalId,liveId])
 })

})
