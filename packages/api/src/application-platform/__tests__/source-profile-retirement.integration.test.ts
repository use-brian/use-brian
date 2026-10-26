/** Genuine SQL-port predecessor setup; no fabricated approvals, grants or maxima. */
import {createHash,randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import type {PoolClient} from 'pg'
import express from 'express'
import request from 'supertest'
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest'
import type {ExecutionContext} from '@use-brian/core'
const {createLocalFixture,cleanRuntimeEnvironment,assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
const boundary='8124_application_source_host_retirement.sql'
const signatures=['application_prepare_source_setup(uuid,uuid,jsonb)','application_apply_source_setup(uuid,uuid)','application_scoped_grant_allowed_before_records(uuid,jsonb)']
let fixture:Awaited<ReturnType<typeof createLocalFixture>>|undefined,x:any,db:any,management:any,execution:ExecutionContext,old:any,current:any,runtime:any
let closed=false
let appId:string,service:string,profile:string,binding:string,nativeGrant:string,externalGrant:string,pendingGrant:string,pendingCredential:string,pendingSetup:string,consumedSetup:string,approval:string
let command:(value:unknown)=>Promise<any>,beforeCatalog:any[],protectedCatalog:any[],saved:any,credentialState:any,bindingState:any,callbackCount=0
const predecessorHash='f1d54afc5e9f0dfee0853e06d7b6da752da36bbc597725f05a48de96c1b53e03'
const sourceSql=await readFile(new URL('../../../migrations/'+boundary,import.meta.url),'utf8')
async function catalog(names=signatures){return(await db.getPool().query(`SELECT p.oid::text,to_jsonb(p)-'prosrc' AS properties,p.prosrc FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY p.oid`,[names])).rows}
async function savedState(){return(await db.getPool().query(`SELECT to_jsonb(r) AS review,(SELECT to_jsonb(a) FROM application_source_setup_approvals a WHERE a.review_id=r.id) AS approval,
 (SELECT count(*)::int FROM connector_source_profiles p WHERE p.id=r.profile_id) AS profiles,
 (SELECT count(*)::int FROM external_source_resources e WHERE e.profile_id=r.profile_id) AS resources
 FROM application_source_setup_reviews r WHERE r.id=$1`,[pendingSetup])).rows[0]}
async function native<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{
 return db.runWithAgentAccess(execution.security.access,async()=>{const client=await db.getAppPool().connect()
  try{await client.query('BEGIN');await db.applyRLSGucs(client,execution.security.access.userId);await client.query("SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)",[execution.assistant.id]);const value=await operation(client);await client.query('COMMIT');return value}
  catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}})
}
async function reviewedExternal(input:any,apply=true){
 return management.transaction(x.f.ownerId,x.f.workspaceId,(client:PoolClient)=>management.withReleaseAuthority(client,x.f.ownerId,x.f.workspaceId,appId,async()=>{
  const {prepareExternalSourceGrantRelease}=await import('../source-service-binding.js')
  await prepareExternalSourceGrantRelease(client,x.f.ownerId,x.f.workspaceId,appId,input)
  const id=(await client.query('SELECT application_prepare_grant_review($1,$2) AS id',[appId,input])).rows[0].id
  expect((await client.query('SELECT application_scoped_grant_allowed($1,$2) AS allowed',[appId,input])).rows[0].allowed).toBe(true)
  if(!apply)return id
  await prepareExternalSourceGrantRelease(client,x.f.ownerId,x.f.workspaceId,appId,input)
  return(await client.query('SELECT application_apply_grant_review($1) AS id',[id])).rows[0].id
 }),true)
}
const protectedNames=['source_service_authority_fingerprint(uuid,uuid,uuid,uuid,uuid,uuid)','external_source_authority_fingerprint(uuid,uuid)',
 'application_scoped_qualified(uuid,uuid)','application_scoped_grant_allowed(uuid,jsonb)','application_scoped_credential_current(uuid,uuid)',
 'prepare_source_service_binding(uuid,uuid,uuid,uuid,uuid,timestamptz)','activate_source_service_binding(uuid,uuid)',
 'application_native_module_lifecycle_revision(uuid,uuid,text)']
let workflowId:string
let external:any,setup:any,key:any,allOtherFunctions:any,authorityBefore:any
async function otherFunctions(){return(await db.getPool().query("SELECT p.oid::text,md5(to_jsonb(p)::text) AS fingerprint FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT p.oid=ANY($1::regprocedure[]) ORDER BY p.oid",[signatures])).rows}
async function authorityState(){
 const result:Record<string,unknown>={}
 for(const table of ['application_clients','application_scoped_activations','application_source_setup_reviews','connector_source_profiles','application_access_grants','application_grant_reviews','application_api_credentials','application_credential_reviews','application_credential_grants','source_service_bindings','external_source_resources','external_source_observations'])
  result[table]=(await db.getPool().query(`SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]') AS value FROM ${table} r WHERE workspace_id=$1`,[x.f.workspaceId])).rows[0].value
 result.approvals=(await db.getPool().query("SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') AS value FROM application_source_setup_approvals a JOIN application_source_setup_reviews r ON r.id=a.review_id WHERE r.workspace_id=$1",[x.f.workspaceId])).rows[0].value
 return result
}
async function preparePredecessor(){
 db=await import('../../db/client.js');old=await import('./fixtures/source-onboarding-pre-retirement.js');current=await import('../source-onboarding.js')
 const {sourceModeFixture}=await import('./fixtures/source-modes.js');x=await sourceModeFixture()
 const {configureConnectorSourceRuntimeFactory}=await import('../source-runtime.js');configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
 await db.getPool().query("UPDATE connector_source_profiles SET status='revoked' WHERE workspace_id=$1",[x.f.workspaceId])
 const {ApplicationManagementService}=await import('../management.js'),{ApplicationPlatformService}=await import('../service.js'),{createCanonicalNativeApplicationModule}=await import('../native-adapters.js')
 management=new ApplicationManagementService(new ApplicationPlatformService([createCanonicalNativeApplicationModule()]))
 command=async value=>management.executeCommand(x.f.ownerId,x.f.workspaceId,value,{audience:'human',assistantId:x.f.assistantId})
 appId=(await command({kind:'register',input:{moduleKey:'native',name:'Fictional source retirement',mode:'api_client',origins:[],redirectUris:[]}})).id
 service=(await command({kind:'service.prepare',appId,input:{name:'Fictional source service',idempotencyKey:randomUUID()}})).serviceUserId
 const activation=await command({kind:'activation.review',appId});await command({kind:'activation.apply',appId,reviewId:activation.id})
 execution=await management.nativeSchemaExecution(x.f.ownerId,x.f.workspaceId,x.f.assistantId)
 const instance=(await db.getPool().query('SELECT original_connector_instance_id AS id,audience FROM connector_source_profiles WHERE workspace_id=$1',[x.f.workspaceId])).rows[0]
 setup={instanceId:instance.id,tenant:'mode-fixture',audience:instance.audience,recordId:'record-1',fields:['description','cost'],effectBinding:'command_v1'}
 consumedSetup=(await native<any>(c=>old.prepareApplicationSourceSetup(c,execution,appId,setup))).reviewId
 profile=(await native<any>(c=>old.applyApplicationSourceSetup(c,execution,appId,consumedSetup))).profileId
 pendingSetup=(await native<any>(c=>old.prepareApplicationSourceSetup(c,execution,appId,setup))).reviewId
 const interrupted=new Error('fictional_pre_apply_interruption')
 await expect(native(c=>old.applyApplicationSourceSetup(new Proxy(c,{get(target,property){
  if(property==='query')return async(...args:any[])=>{if(String(args[0]).startsWith('SELECT application_apply_source_setup('))throw interrupted;return(target.query as any)(...args)}
  const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value}}),execution,appId,pendingSetup))).rejects.toBe(interrupted)
 approval=(await db.getPool().query('SELECT id FROM application_source_setup_approvals WHERE review_id=$1',[pendingSetup])).rows[0].id
 await x.sourcePool.query("INSERT INTO accounts(kind,id) VALUES('service',$1)",[service])
 await x.sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('service',$1,'record-1',ARRAY['description','cost'],ARRAY['read','context','derive','retain','mutate'])",[service])
 const nativeProposal={principal:{kind:'service',userId:service},origin:{kind:'native',moduleKey:'native'},typeKey:'company',actions:['read','create','command:create_company'],readFields:['name'],writeFields:['name'],selector:{kind:'self'},expiresAt:null,parentGrantId:null,compartments:[],projectIds:[],clearance:'confidential'}
 const review=await command({kind:'grant.review',appId,input:nativeProposal});expect(review.canIssue).toBe(true);nativeGrant=(await command({kind:'grant.apply',appId,reviewId:review.id})).grantId
 const issue=async(grantIds:string[])=>{const review=await command({kind:'credential.review',appId,input:{name:'Fictional service key',kind:'service',serviceUserId:service,grantIds,expiresAt:new Date(Date.now()+1800_000).toISOString()}});expect(review.canIssue).toBe(true);const result=await command({kind:'credential.deliver',appId,reviewId:review.id});expect(result.secretAvailable).toBe(true);return result}
 const bootstrap=await issue([nativeGrant]),prospective=(await command({kind:'source.binding.review',appId,input:{profileId:profile,credentialId:bootstrap.credentialId,expiresAt:new Date(Date.now()+1200_000).toISOString()}})).reviewId
 external={principal:{kind:'service',userId:service},origin:{kind:'external',connectorInstanceId:instance.id,sourceTenant:'mode-fixture'},typeKey:'case',actions:['read','command:source.derive','command:source.retain','command:source.mutate'],readFields:['description','cost'],writeFields:['cost'],selector:{kind:'ids',ids:['record-1']},expiresAt:null,parentGrantId:null,compartments:[],projectIds:[],clearance:'confidential'}
 externalGrant=await reviewedExternal(external);key=await issue([nativeGrant,externalGrant])
 await command({kind:'source.binding.revoke',appId,bindingId:prospective});await command({kind:'credential.revoke',appId,credentialId:bootstrap.credentialId})
 const {createDbWorkflowStore}=await import('../../db/workflow-store.js'),{captureAuthoringAuthoritySystem}=await import('../../context-scope/workflow-authority.js')
 const authority=await captureAuthoringAuthoritySystem({userId:x.f.ownerId,workspaceId:x.f.workspaceId,assistantId:x.f.assistantId})
 workflowId=(await createDbWorkflowStore().create({userId:x.f.ownerId,workspaceId:x.f.workspaceId,name:'Fictional retired source operation',authoringAuthority:authority,definition:{startStepId:'retired',steps:[{id:'retired',type:'tool_call',toolName:'sourceEffect',arguments:{}}]}})).id
 binding=(await command({kind:'source.binding.review',appId,input:{profileId:profile,credentialId:key.credentialId,workflowId,expiresAt:new Date(Date.now()+1200_000).toISOString()}})).reviewId
 await command({kind:'source.binding.apply',appId,reviewId:binding})
 pendingGrant=await reviewedExternal(external,false)
 const pending=await command({kind:'credential.review',appId,input:{name:'Fictional pending key',kind:'service',serviceUserId:service,grantIds:[nativeGrant,externalGrant],expiresAt:new Date(Date.now()+1800_000).toISOString()}});expect(pending.canIssue).toBe(true);pendingCredential=pending.id
 const {resolveSourceServiceExecution}=await import('../source-service-binding.js');runtime=await resolveSourceServiceExecution(binding)
 credentialState=(await db.getPool().query('SELECT to_jsonb(c) AS value FROM application_api_credentials c WHERE id=$1',[key.credentialId])).rows[0].value
 bindingState=(await db.getPool().query('SELECT to_jsonb(b) AS value FROM source_service_bindings b WHERE id=$1',[binding])).rows[0].value
 saved=await savedState();expect(saved.review.consumed).toBe(false);expect(saved.profiles).toBe(0);expect(saved.approval.id).toBe(approval)
 beforeCatalog=await catalog();protectedCatalog=await catalog(protectedNames)
 // A late prerequisite failure rolls back any earlier guarded replacement.
 const client=await db.getPool().connect()
 try{for(const change of [
  'GRANT EXECUTE ON FUNCTION application_scoped_grant_allowed_before_records(uuid,jsonb) TO PUBLIC',
  'ALTER FUNCTION application_apply_source_setup(uuid,uuid) STABLE',
  'ALTER FUNCTION application_prepare_source_setup(uuid,uuid,jsonb) SET search_path=public,pg_temp',
  'REVOKE EXECUTE ON FUNCTION application_prepare_source_setup(uuid,uuid,jsonb) FROM app_user',
  "CREATE OR REPLACE FUNCTION application_scoped_grant_allowed_before_records(a uuid,p jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$BEGIN RETURN true;END$$"
 ]){await client.query('BEGIN');await client.query(change);await expect(client.query(sourceSql)).rejects.toMatchObject({code:'55000'});await client.query('ROLLBACK')}}
 finally{await client.query('ROLLBACK');client.release()}
 expect(await catalog()).toEqual(beforeCatalog);allOtherFunctions=await otherFunctions();authorityBefore=await authorityState()
}

async function cleanup(){
 if(closed)return;closed=true
 const {configureConnectorSourceRuntimeFactory}=await import('../source-runtime.js');configureConnectorSourceRuntimeFactory(undefined)
 try{await x?.cleanup();if(service)await db?.getPool().query('DELETE FROM users WHERE id=$1',[service])}
 finally{await db?.getAppPool().end();await db?.getPool().end()}
}

describe.sequential('[COMP:api/source-service-binding] normal host retirement upgrade',()=>{
 beforeAll(async()=>{
  // Test-only predecessor contains the packet-start logic; remaps are mechanical.
  let predecessor=await readFile(new URL('./fixtures/source-onboarding-pre-retirement.ts',import.meta.url),'utf8')
  for(const [oldPath,newPath] of [['../../../db/','../db/'],['../../../mcp/','../mcp/'],['../../../context-scope/','../context-scope/'],["from '../../connector-runtime-authority.js'","from './connector-runtime-authority.js'"],["from '../../source-runtime.js'","from './source-runtime.js'"],["from '../../source-access.js'","from './source-access.js'"]])predecessor=predecessor.replaceAll(oldPath,newPath)
  expect(createHash('sha256').update(predecessor).digest('hex')).toBe(predecessorHash)
  fixture=await createLocalFixture({env:cleanRuntimeEnvironment(process.env),runtimeRole:'app_user',beforeApplyFile:boundary,beforeApply:async({env}:any)=>{callbackCount++;Object.assign(process.env,env);await assertLocalFixture(env);try{await preparePredecessor()}catch(error){await cleanup();throw error}}})
  await assertLocalFixture(fixture.env)
 },120_000)
 afterAll(async()=>{try{await cleanup()}finally{await fixture?.dispose()}})
 it('preserves all function properties/identity and applies the full real chain once',async()=>{
  expect(callbackCount).toBe(1)
  const after=await catalog();expect(after.map((v:any)=>v.properties)).toEqual(beforeCatalog.map((v:any)=>v.properties));expect(after.every((v:any,i:number)=>v.prosrc!==beforeCatalog[i].prosrc)).toBe(true)
  expect(await catalog(protectedNames)).toEqual(protectedCatalog);expect(await otherFunctions()).toEqual(allOtherFunctions);expect(await authorityState()).toEqual(authorityBefore)
  expect((await db.getPool().query('SELECT count(*)::int AS n FROM _migrations WHERE name=$1',[boundary])).rows[0].n).toBe(1)
  const {tsImport}=await import('tsx/esm/api');const {runMigrations}=await tsImport('../../../scripts/migrate.ts',import.meta.url);expect((await runMigrations({databaseUrl:fixture!.adminUrl})).appliedCount).toBe(0)
  const identity=(await db.getAppPool().query("SELECT current_user,session_user,r.rolsuper,r.rolbypassrls,EXISTS(SELECT 1 FROM pg_class c WHERE c.relowner=r.oid AND c.oid='application_source_setup_reviews'::regclass) AS owns,EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS membership FROM pg_roles r WHERE r.rolname=current_user")).rows[0]
  expect(identity).toEqual({current_user:'app_user',session_user:'app_user',rolsuper:false,rolbypassrls:false,owns:false,membership:false})
 })
 it('refuses real pending approved command setup before network and SQL writes while consumed replay keeps its identity',async()=>{
  const reads=x.source.counters.reads,auth=x.source.counters.authorizations
  await expect(native(c=>current.applyApplicationSourceSetup(c,execution,appId,pendingSetup))).rejects.toMatchObject({code:'access_unavailable'})
  expect(x.source.counters.reads).toBe(reads);expect(x.source.counters.authorizations).toBe(auth)
  await expect(native(c=>c.query('SELECT application_apply_source_setup($1,$2)',[pendingSetup,approval]))).rejects.toMatchObject({code:'42501'})
  expect(await savedState()).toEqual(saved)
  expect(await native(c=>current.applyApplicationSourceSetup(c,execution,appId,consumedSetup))).toEqual({profileId:profile})
  expect((await db.getPool().query('SELECT proposal FROM application_source_setup_reviews WHERE id=$1',[consumedSetup])).rows[0].proposal.effectBinding).toBe('command_v1')
 })
 it('fails an actual pre-retirement bound workflow without dispatch or model fallback despite advertised callbacks',async()=>{
  const {configureConnectorSourceRuntimeFactory}=await import('../source-runtime.js'),{createDbWorkflowRunStore,createDbWorkflowStore}=await import('../../db/workflow-store.js'),{resolveWorkflowRunScope}=await import('../../context-scope/workflow-authority.js'),{buildWorkflowToolRegistry}=await import('../../workflow/mcp-bridge.js'),{advanceWorkflowRun}=await import('@use-brian/core')
  const effect=vi.fn(),reconcile=vi.fn(),model=vi.fn(async()=>{throw new Error('No model fallback')})
  configureConnectorSourceRuntimeFactory(async(input:any)=>{const value=await x.factory(input);return value?{...value,effectBinding:'command_v1',effect,reconcile}:null},{instances:x.instances})
  try{
   const runs=createDbWorkflowRunStore(),run=await runs.createRun({workflowId,workspaceId:x.f.workspaceId,triggeredBy:null,triggerKind:'schedule'})
   const outcome=await advanceWorkflowRun({abortSignal:new AbortController().signal,workflowStore:createDbWorkflowStore(),runStore:runs,resolvePrimary:async()=>x.f.assistantId,resolveRunScope:resolveWorkflowRunScope,
    buildToolRegistry:async scope=>{const tools=await buildWorkflowToolRegistry({firstParty:new Map([['sourceEffect',{} as never]]),connectorStore:{} as never,settingsStore:{} as never},scope);expect(tools.has('sourceEffect')).toBe(false);expect(tools.has('sourceReconcile')).toBe(false);return tools},consultTransport:{send:model},pauseRunForWait:async()=>{}},run.id)
   expect(outcome).toMatchObject({kind:'failed',error:{reason:'tool_not_found'}})
   expect(effect).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();expect(model).not.toHaveBeenCalled();expect(x.source.counters.effects).toBe(0)
   expect((await db.getPool().query('SELECT output FROM workflow_step_runs WHERE run_id=$1',[run.id])).rows.every((row:{output:unknown})=>row.output===null)).toBe(true)
  }finally{configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})}
 })
 it('refuses fresh and saved command grant/key issuance but preserves current credential/binding generations and reads',async()=>{
  expect((await native(c=>c.query('SELECT application_scoped_grant_allowed($1,$2) AS allowed',[appId,external]))).rows[0].allowed).toBe(false)
  const base={...external,actions:['read','command:source.derive','command:source.retain'],writeFields:[]};expect((await native(c=>c.query('SELECT application_scoped_grant_allowed($1,$2) AS allowed',[appId,base]))).rows[0].allowed).toBe(true)
  await expect(command({kind:'grant.review',appId,input:external})).rejects.toMatchObject({code:'operation_not_available'})
  await expect(command({kind:'grant.apply',appId,reviewId:pendingGrant})).rejects.toMatchObject({code:'access_unavailable'})
  await expect(command({kind:'credential.deliver',appId,reviewId:pendingCredential})).rejects.toMatchObject({code:'access_unavailable'})
  expect((await db.getPool().query('SELECT consumed_grant_id FROM application_grant_reviews WHERE id=$1',[pendingGrant])).rows[0].consumed_grant_id).toBeNull()
  expect((await db.getPool().query('SELECT consumed_credential_id FROM application_credential_reviews WHERE id=$1',[pendingCredential])).rows[0].consumed_credential_id).toBeNull()
  const fresh=await command({kind:'credential.review',appId,input:{name:'Fictional denied key',kind:'service',serviceUserId:service,grantIds:[externalGrant],expiresAt:new Date(Date.now()+1800_000).toISOString()}});expect(fresh.canIssue).toBe(false)
  expect((await db.getPool().query('SELECT to_jsonb(c) AS value FROM application_api_credentials c WHERE id=$1',[key.credentialId])).rows[0].value).toEqual(credentialState)
  expect((await db.getPool().query('SELECT to_jsonb(b) AS value FROM source_service_bindings b WHERE id=$1',[binding])).rows[0].value).toEqual(bindingState)
  const {resolveSourceServiceExecution}=await import('../source-service-binding.js'),{ContextScopeAccumulator}=await import('@use-brian/core');const currentExecution=await resolveSourceServiceExecution(binding)
  const credentials=await x.instances.getAuthCredentialsSystem(setup.instanceId),readRuntime=await x.factory({workspaceId:x.f.workspaceId,instanceId:setup.instanceId,execution:currentExecution,accumulator:new ContextScopeAccumulator(),headers:{Authorization:'Bearer '+credentials.token}})
  expect(JSON.stringify(await readRuntime.read('readRecord',{id:'record-1',fields:['description']}))).toContain('Fictional released fact')
  const {createSourceAccessClient}=await import('../source-access.js'),{getSharedSourceDeployment}=await import('../source-runtime.js'),deployment=getSharedSourceDeployment()!
  const client=createSourceAccessClient(currentExecution,{issuer:deployment.issuer,audience:setup.audience,workspaceId:x.f.workspaceId,connectorInstanceId:setup.instanceId,sourceBaseUrl:x.source.url,mcpUrl:x.source.url+'/mcp',tenant:setup.tenant,bindingRevision:'1',subject:{kind:'service',id:service,executingAssistantId:x.f.assistantId}},
   {...deployment.keys!,admit:async()=>{await currentExecution.security.authority.assertCurrent();return{bindingRevision:'1',actor:{kind:'service' as const,serviceUserId:service}}}},{headers:{Authorization:'Bearer '+credentials.token}})
  expect(await client.reconcile({version:'ub.source.v1',idempotencyKey:'fictional-unknown-receipt'})).toMatchObject({state:'not_applied'})
  expect(x.source.counters.effects).toBe(0)
  await command({kind:'credential.revoke',appId,credentialId:key.credentialId});await expect(currentExecution.security.authority.assertCurrent()).rejects.toBeDefined()
 })
 it('keeps default read authoring and strict authenticated HTTP/MCP rejection before source calls',async()=>{
  const {ApplicationPlatformService}=await import('../service.js'),{createCanonicalNativeApplicationModule}=await import('../native-adapters.js'),{applicationPlatformRoutes}=await import('../../routes/application-platform.js'),{authSessionStore}=await import('../../db/auth-session-store.js'),{createTokens}=await import('../../auth/jwt.js'),{requireAuth}=await import('../../auth/middleware.js')
  const secret='fictional-source-retirement-session',session=await authSessionStore.create(x.f.ownerId,{deviceLabel:'Fictional browser',userAgent:'Fixture',ipAddress:'127.0.0.1'}),token=createTokens(x.f.ownerId,secret,session!).accessToken
  const app=express();app.use(express.json());app.use('/api/applications',applicationPlatformRoutes({service:new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),management:{service:management,requireAuth:requireAuth(secret),origins:['https://host.example']}}))
  const path=`/api/applications/workspaces/${x.f.workspaceId}/management`,before={...x.source.counters}
  for(const effectBinding of ['command_v1',null,'unknown']){
   const body={kind:'source.profile.review',appId,input:{...setup,effectBinding}}
   const http=await request(app).post(path+'/commands').set('Authorization','Bearer '+token).set('Origin','https://host.example').send(body);expect(http.status).toBe(400);expect(http.body.error).toBe('invalid_value')
   const mcp=await request(app).post(path+'/mcp').query({assistantId:x.f.assistantId}).set('Authorization','Bearer '+token).set('Accept','application/json, text/event-stream').set('MCP-Protocol-Version','2025-11-25').send({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'applicationManage',arguments:{command:body}}})
   const event=mcp.text.split('\n').find(line=>line.startsWith('data: '))!;const reply=JSON.parse(event.slice(6));expect(reply.result.isError).toBe(true);expect(reply.result.content[0].text).toContain('MCP error -32602');expect(reply.result.content[0].text).toContain("Unrecognized key(s) in object: 'effectBinding'")
  }
  expect(x.source.counters).toEqual(before)
  // Existing uniqueness requires revoking the prior live profile before a
  // replacement. This separate fictional revocation is not migration behavior.
  await db.getPool().query("UPDATE connector_source_profiles SET status='revoked' WHERE id=$1",[profile])
  await expect(native(c=>current.applyApplicationSourceSetup(c,execution,appId,consumedSetup))).rejects.toMatchObject({code:'42501'})
  const {effectBinding,...readSetup}=setup;const reviewed=await command({kind:'source.profile.review',appId,input:readSetup});const result=await command({kind:'source.profile.apply',appId,reviewId:reviewed.reviewId})
  expect((await db.getPool().query('SELECT source_effect_binding FROM connector_source_profiles WHERE id=$1',[result.profileId])).rows[0].source_effect_binding).toBeNull()
 })
})
