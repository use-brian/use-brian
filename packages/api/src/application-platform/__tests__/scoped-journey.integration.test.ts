/** Actual owner issuance, app SDK and Brian MCP. No app authority is seeded. */
import {createPublicKey,randomBytes,randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import express from 'express'
import request from 'supertest'
import {createApplicationClient} from '@use-brian/brian-app/application'
import {createServiceTransport} from '@use-brian/brian-app/module'
import pg from 'pg'
import {pauseWorkflowRunForWait,resumeWorkflowWaitJob} from '../../workflow/wait-lifecycle.js'
import {createDbJobStore} from '../../db/job-store.js'
import {createWorkspaceStore} from '../../db/workspace-store.js'
import {workflowsRoutes} from '../../routes/workflows.js'
import {createJobExecutor} from '../../scheduling/executor.js'
import {createWorkflowDependencyPreflight} from '../../workflow/dependency-preflight.js'
import {advanceWorkflowRun} from '@use-brian/core'
import {createConnectorInstanceStore} from '../../db/connector-instance-store.js'
import {createConnectorActorKeyStore} from '../connector-actor-keys.js'
import {createConnectorActorVerifier} from '@use-brian/brian-app/connector'
import {createConnectorSourceRuntimeFactory,configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {createDbWorkflowStore,createDbWorkflowRunStore} from '../../db/workflow-store.js'
import {captureAuthoringAuthoritySystem,resolveWorkflowRunScope} from '../../context-scope/workflow-authority.js'
import {buildWorkflowToolRegistry} from '../../workflow/mcp-bridge.js'
import {independentSourceSchema,independentSourceReplayConsumer,startIndependentSource} from './fixtures/independent-source.js'
import {getPool,getAppPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {getCompanyById,getDealById} from '../../db/crm.js'
import {ApplicationPlatformService} from '../service.js'
import {ApplicationManagementService} from '../management.js'
import {createCanonicalNativeApplicationModule} from '../native-adapters.js'
import {applicationPlatformRoutes} from '../../routes/application-platform.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-management] [COMP:workflow/wait-lifecycle] supported scoped application journey',()=>{
 const referenceServiceIds:string[]=[]
 const pool=getPool(),workspaceId=randomUUID(),ownerId=randomUUID(),memberId=randomUUID(),assistantId=randomUUID()
 const signingSecret='fictional-scoped-native-session',service=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
 const management=new ApplicationManagementService(service),http=express();http.use(express.json());http.use('/api/applications',applicationPlatformRoutes({service,management:{service:management,requireAuth:requireAuth(signingSecret),origins:['https://host.example']}}))
 const server=http.listen(0,'127.0.0.1'),nativeTokens=new Map<string,string>();let apiOrigin:string,appId:string,serviceUserId:string
 const base=`/api/applications/workspaces/${workspaceId}`
 beforeAll(async()=>{
  if(!server.listening)await once(server,'listening');apiOrigin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  for(const id of [ownerId,memberId])await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional scoped application',$2)",[workspaceId,ownerId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')",[workspaceId,ownerId,memberId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional service assistant',$2,$3,'primary','confidential')",[assistantId,ownerId,workspaceId])
  for(const id of [ownerId,memberId]){const session=await authSessionStore.create(id,{deviceLabel:'Fictional native browser',userAgent:'Fixture',ipAddress:'127.0.0.1'});nativeTokens.set(id,createTokens(id,signingSecret,session!).accessToken)}
 })
 afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,memberId,...referenceServiceIds,...(serviceUserId?[serviceUserId]:[])]]);await getAppPool().end();await pool.end()})
 async function command(value:Record<string,unknown>,actor=ownerId){return request(http).post(`${base}/management/commands`).set('Authorization',`Bearer ${nativeTokens.get(actor)}`).set('Origin','https://host.example').send(value)}
 async function checked(value:Record<string,unknown>){const result=await command(value);expect(result.status,JSON.stringify({kind:value.kind,type:(value.input as {typeKey?:string}|undefined)?.typeKey,response:result.body})).toBe(200);return result.body}
 function sdk(token:string){return createApplicationClient({appId,transport:createServiceTransport({apiOrigin,credential:async()=>({kind:'service',token})})})}
 async function brian(token:string,name:string,args:unknown){const r=await fetch(`${apiOrigin}/api/applications/${appId}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});expect(r.status).toBe(200);const text=await r.text(),line=text.split('\n').find(x=>x.startsWith('data: ')),result=JSON.parse(line?line.slice(6):text).result;expect(result.isError,JSON.stringify(result)).not.toBe(true);return JSON.parse(result.content[0].text)}
 const proposal=(typeKey:'company'|'deal')=>({principal:{kind:'service',userId:serviceUserId},origin:{kind:'native',moduleKey:'native'},typeKey,
  actions:typeKey==='company'?['read','query','create','patch','command:create_company','command:patch_company','command:patch_records']:['read','query','create','patch','command:create_deal','command:set_deal_stage','command:patch_records'],
  readFields:typeKey==='company'?['name','domain']:['name','companyId','stage','amount','currencyCode'],writeFields:typeKey==='company'?['name','domain']:['name','companyId','stage','amount','currencyCode'],
  selector:{kind:'self'},expiresAt:null,parentGrantId:null,compartments:[],projectIds:[],clearance:'internal'})
 async function issue(grantIds:string[]){const review=await checked({kind:'credential.review',appId,input:{name:'Fictional app key',kind:'service',serviceUserId,grantIds,expiresAt:new Date(Date.now()+3600_000).toISOString()}});expect(review.canIssue).toBe(true);const delivered=await checked({kind:'credential.deliver',appId,reviewId:review.id});expect(delivered.secretAvailable).toBe(true);expect(delivered.secret).toMatch(/^sk_app_/);const replay=await checked({kind:'credential.deliver',appId,reviewId:review.id});expect(replay).toEqual({credentialId:delivered.credentialId,secretAvailable:false});return delivered}
 it('uses supported owner activation, grant reviews and one-time credentials for SDK/Brian canonical company and deal changes',async()=>{
  appId=(await checked({kind:'register',input:{moduleKey:'native',name:'Fictional operations client',mode:'api_client',origins:[],redirectUris:[]}})).id
  serviceUserId=(await checked({kind:'service.prepare',appId,input:{name:'Fictional operations service',idempotencyKey:randomUUID()}})).serviceUserId
  expect((await pool.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,serviceUserId])).rowCount).toBe(0)
  const before=await checked({kind:'grant.review',appId,input:proposal('company')});expect(before.canIssue).toBe(false)
  expect((await command({kind:'grant.apply',appId,reviewId:before.id})).status).toBe(403)
  const activation=await checked({kind:'activation.review',appId});expect(activation.profile).toBe('canonical_service_v1')
  expect((await command({kind:'activation.apply',appId,reviewId:activation.id},memberId)).status).toBe(403)
  await checked({kind:'activation.apply',appId,reviewId:activation.id})
  const grants:string[]=[]
  for(const kind of ['company','deal'] as const){const review=await checked({kind:'grant.review',appId,input:proposal(kind)});expect(review.canIssue).toBe(true);const applied=await checked({kind:'grant.apply',appId,reviewId:review.id});grants.push(applied.grantId);expect((await checked({kind:'grant.apply',appId,reviewId:review.id})).grantId).toBe(applied.grantId)}
  const first=await issue(grants),client=sdk(first.secret)
  const created=await client.command('create_company',{idempotencyKey:randomUUID(),input:{name:'Fictional workshop',domain:'workshop.example'}}),companyId=created.resources[0].id
  expect(await brian(first.secret,'applicationQuery',{queryKey:'get',input:{type:'company',id:companyId}})).toMatchObject({ref:{id:companyId,version:'1'},values:{name:'Fictional workshop'}})
  const changed=await brian(first.secret,'applicationCommand',{commandKey:'patch_company',command:{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id:companyId,patch:{domain:'updated.example'}}}})
  expect(changed.resources[0]).toMatchObject({id:companyId,version:'2'})
  expect(await client.get('company',companyId)).toMatchObject({ref:{id:companyId,version:'2'},values:{domain:'updated.example'}})
  expect((await client.query('company',{fields:['name','domain'],filters:[{field:'domain',op:'eq',value:'updated.example'}],sort:[],aggregate:[],limit:5})).records.map(r=>r.ref.id)).toEqual([companyId])
  const deal=await client.command('create_deal',{idempotencyKey:randomUUID(),input:{name:'Fictional opportunity',companyId,amount:'37.25',currencyCode:'USD'}}),dealId=deal.resources[0].id
  await brian(first.secret,'applicationCommand',{commandKey:'set_deal_stage',command:{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id:dealId,stage:'proposal'}}})
  expect(await client.get('deal',dealId)).toMatchObject({ref:{id:dealId,version:'2'},values:{companyId,stage:'proposal'}})
  const native={workspaceId,userId:memberId,assistantId,assistantKind:'primary' as const}
  expect(await getCompanyById(native,companyId)).toMatchObject({id:companyId,domain:'updated.example'})
  expect(await getDealById(native,dealId)).toMatchObject({id:dealId,companyId,stage:'proposal'})
  const replacement=await issue(grants);await checked({kind:'credential.revoke',appId,credentialId:first.credentialId})
  await expect(client.get('company',companyId)).rejects.toMatchObject({code:'authentication_required'})
  expect(await sdk(replacement.secret).get('company',companyId)).toMatchObject({ref:{id:companyId}})
  await checked({kind:'activation.revoke',appId});await expect(sdk(replacement.secret).get('company',companyId)).rejects.toMatchObject({code:'grant_revoked'})
  const renewed=await checked({kind:'activation.review',appId});await checked({kind:'activation.apply',appId,reviewId:renewed.id})
  await expect(sdk(replacement.secret).get('company',companyId)).rejects.toMatchObject({code:'grant_revoked'})
  // Corrupt/missing authority is a negative test only, never setup for a successful path.
  await pool.query('DELETE FROM application_scoped_activations WHERE app_id=$1',[appId])
  await expect(sdk(replacement.secret).get('company',companyId)).rejects.toMatchObject({code:'grant_revoked'})
  const recreated=await checked({kind:'activation.review',appId});await checked({kind:'activation.apply',appId,reviewId:recreated.id})
  await expect(sdk(replacement.secret).get('company',companyId)).rejects.toMatchObject({code:'grant_revoked'})
  expect((await pool.query("SELECT application_runtime_qualified($1,'application_data') AS ready",[workspaceId])).rows[0].ready).toBe(false)
 },60_000)
 it('runs the shipped reference client against supported HTTP management, SDK and registered MCP',async()=>{
  const {createReferenceApi,runNativeReference}=await import(new URL('../../../../../scripts/application-platform/reference-operations.mjs',import.meta.url).href)
  const result=await runNativeReference(createReferenceApi({apiOrigin,workspaceId,nativeToken:nativeTokens.get(ownerId),managementOrigin:'https://host.example'}))
  referenceServiceIds.push(serviceUserId,result.serviceUserId)
  // The next cases continue the exact app/service returned by the shipped native stage.
  appId=result.appId;serviceUserId=result.serviceUserId
  expect(result).toMatchObject({appId:expect.any(String),companyId:expect.any(String),dealId:expect.any(String),retiredDealId:expect.any(String),retirement:'closed_lost_history_retained',nativeKeyRevoked:true})
  expect(await getCompanyById({workspaceId,userId:memberId,assistantId,assistantKind:'primary'},result.companyId)).toMatchObject({domain:'updated.example'})
  expect(result.retiredDealId).not.toBe(result.dealId)
  expect(await getDealById({workspaceId,userId:memberId,assistantId,assistantKind:'primary'},result.retiredDealId)).toMatchObject({id:result.retiredDealId,stage:'lost',companyId:result.companyId})
 },60_000)
 it('keeps unsupported principals, client modes, resources, fields and deployed commands unavailable',async()=>{
  const active=await checked({kind:'activation.review',appId});await checked({kind:'activation.apply',appId,reviewId:active.id})
  for(const change of [{principal:{kind:'member',userId:memberId}},{typeKey:'person',readFields:['name'],writeFields:['name']},{readFields:['name','aliases']},{actions:['read','command:create_task']}]){
   const review=await command({kind:'grant.review',appId,input:{...proposal('company'),...change}})
   if(review.status===200){expect(review.body.canIssue).toBe(false);expect((await command({kind:'grant.apply',appId,reviewId:review.body.id})).status).not.toBe(200)}else expect([400,403,409]).toContain(review.status)
  }
  const other=(await checked({kind:'register',input:{moduleKey:'native',name:'Fictional browser client',mode:'external_frontend',origins:['https://client.example'],redirectUris:['https://client.example/callback']}})).id
  expect((await command({kind:'activation.review',appId:other})).status).toBe(403)
  expect((await command({kind:'activation.apply',appId,reviewId:randomUUID()})).status).toBe(403)
 })
 it('uses independent source approval, real reissue and binding activation for protected workflow wait/resume/revoke',async()=>{
  const role='scoped_source_'+randomBytes(6).toString('hex'),password=randomBytes(24).toString('hex')
  await pool.query("CREATE ROLE "+role+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '"+password+"'")
  await pool.query('CREATE SCHEMA '+role+' AUTHORIZATION '+role)
  const url=new URL(process.env.DATABASE_URL!);url.username=role;url.password=password
  const sourcePool=new pg.Pool({connectionString:url.href,options:'-c search_path='+role+',pg_catalog',max:3})
  let source:Awaited<ReturnType<typeof startIndependentSource>>|undefined
  try{
   await sourcePool.query(independentSourceSchema)
   // Independent source operator/session and records bootstrap. Service rights use source administration.
   await sourcePool.query("INSERT INTO accounts(kind,id,administrative) VALUES('human',$1,true)",[ownerId])
   await sourcePool.query('INSERT INTO assistants(id) VALUES($1)',[assistantId])
   await sourcePool.query("INSERT INTO records(id,kind,data) VALUES('order-1','purchase',$1)",[{description:'Fictional purchase',cost:'37.25'}])
   const encryptionKey=randomBytes(32),issuer='https://'+randomUUID()+'.brain.example',audience='https://source.example',transportToken=randomBytes(24).toString('base64url'),operatorToken=randomBytes(24).toString('base64url')
   const keys=createConnectorActorKeyStore(encryptionKey),instances=createConnectorInstanceStore(encryptionKey);await keys.rotateSystem(issuer)
   const instance=await instances.createWorkspaceInstance({workspaceId,createdBy:ownerId,provider:randomUUID(),label:'Fictional independently approved source',custom:true,connected:true,compartments:[],projectIds:[],sensitivity:'confidential',credentials:{type:'bearer',token:transportToken}})
   const verifier=createConnectorActorVerifier({issuer,audience,workspaceId,connectorInstanceId:instance.id,trustedKey:async kid=>{const jwk=(await keys.publicJwks(issuer)).keys.find(k=>k.kid===kid);return jwk?{key:createPublicKey({key:jwk,format:'jwk'})}:null},consumeReplay:independentSourceReplayConsumer(sourcePool)})
   source=await startIndependentSource({pool:sourcePool,tenant:'fictional-tenant',transportToken,verifyActor:verifier,uiSessions:new Map([[operatorToken,{kind:'human',id:ownerId,executingAssistantId:assistantId}]])})
   await instances.update(ownerId,instance.id,{url:source.url+'/mcp'})
   const factory=createConnectorSourceRuntimeFactory({issuer,keys,instances});configureConnectorSourceRuntimeFactory(factory,{instances})
   async function sourceGrant(kind:'human'|'service',accountId:string,actions=['read','context','derive','retain']){
    const response=await fetch(source!.url+'/ui/grants',{method:'POST',headers:{Authorization:'Bearer '+operatorToken,'Content-Type':'application/json'},body:JSON.stringify({kind,accountId,assistantId,recordId:'order-1',fields:['description','cost'],actions})});expect(response.status).toBe(200)
   }
   const setupInput={instanceId:instance.id,tenant:'fictional-tenant',audience,recordId:'order-1',fields:['description','cost']}
   const setup=await checked({kind:'source.profile.review',appId,input:setupInput})
   expect((await command({kind:'source.profile.apply',appId,reviewId:setup.reviewId})).status).toBe(403)
   await sourceGrant('human',ownerId)
   const {createReferenceApi,prepareReferenceSourceProfile,runSourceReference}=await import(new URL('../../../../../scripts/application-platform/reference-operations.mjs',import.meta.url).href)
   const referenceApi=createReferenceApi({apiOrigin,workspaceId,nativeToken:nativeTokens.get(ownerId),managementOrigin:'https://host.example'})
   const profileId=await prepareReferenceSourceProfile(referenceApi,appId,setupInput)
   const bootstrapReview=await checked({kind:'grant.review',appId,input:{...proposal('company'),clearance:'confidential',actions:['read','create','command:create_company'],readFields:['name'],writeFields:['name']}})
   const bootstrapGrant=(await checked({kind:'grant.apply',appId,reviewId:bootstrapReview.id})).grantId,bootstrap=await issue([bootstrapGrant])
   const pending=(await checked({kind:'source.binding.review',appId,input:{profileId,credentialId:bootstrap.credentialId,expiresAt:new Date(Date.now()+30*60_000).toISOString()}})).reviewId
   const external={principal:{kind:'service',userId:serviceUserId},origin:{kind:'external',connectorInstanceId:instance.id,sourceTenant:'fictional-tenant'},typeKey:'purchase',actions:['read','command:source.derive','command:source.retain'],readFields:['description','cost'],writeFields:[],selector:{kind:'ids',ids:['order-1']},parentGrantId:null,expiresAt:null,compartments:[],projectIds:[],clearance:'confidential'}
   expect((await command({kind:'grant.review',appId,input:external})).status).toBe(403)
   await sourceGrant('service',serviceUserId)
   await checked({kind:'source.binding.revoke',appId,bindingId:pending})
   await checked({kind:'credential.revoke',appId,credentialId:bootstrap.credentialId})
   const workflows=createDbWorkflowStore({resolveAuthoringPrimary:async(workspace,client)=>(await client.query("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary' LIMIT 1",[workspace])).rows[0]?.id??null}),runs=createDbWorkflowRunStore(),jobs=createDbJobStore()
   const resolvePrimary=async(workspace:string)=>(await pool.query("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary' LIMIT 1",[workspace])).rows[0]?.id??null
   const deps={abortSignal:new AbortController().signal,workflowStore:workflows,runStore:runs,resolvePrimary,resolveRunScope:resolveWorkflowRunScope,
    buildToolRegistry:(scope:Parameters<typeof buildWorkflowToolRegistry>[1])=>buildWorkflowToolRegistry({firstParty:new Map(),connectorStore:{} as never,settingsStore:{} as never},scope),consultTransport:{async send(){throw new Error('No model call is part of this workflow')}},pauseRunForWait:(params:Parameters<typeof pauseWorkflowRunForWait>[0])=>pauseWorkflowRunForWait(params,{jobStore:jobs,runStore:runs,resolvePrimary})}
   http.use('/api',requireAuth(signingSecret),workflowsRoutes({workflowStore:workflows,runStore:runs,workspaceStore:createWorkspaceStore(),executorDeps:deps,
    resolvePrimary,preflightConnectorTool:createWorkflowDependencyPreflight({}).preflightConnectorTool,
    resolveAuthoringAuthority:async(params,capture)=>capture?capture():captureAuthoringAuthoritySystem({...params,assistantId:(await resolvePrimary(params.workspaceId))!})}))
   const reference=await runSourceReference(referenceApi,{workspaceId,appId,serviceUserId,...setupInput,profileId})
   expect(reference).toMatchObject({accepted:true,effect:'committed',outputUnavailable:true,runId:expect.any(String)});for(const key of ['status','vars','steps','error','output','counts'])expect(reference).not.toHaveProperty(key)
   const workflow={id:reference.workflowId},binding=reference.bindingId,credential={credentialId:reference.credentialId}
   expect((await command({kind:'source.binding.review',appId,input:{profileId,credentialId:credential.credentialId,workflowId:randomUUID(),expiresAt:new Date(Date.now()+20*60_000).toISOString()}})).status).toBe(403)
   const foreignWorkspace=randomUUID(),foreignAssistant=randomUUID()
   try{
    // Native workspace/assistant fixture bootstrap only; the workflow itself uses HTTP.
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional unrelated workspace',$2)",[foreignWorkspace,memberId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[foreignWorkspace,memberId])
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional unrelated assistant',$2,$3,'primary','confidential')",[foreignAssistant,memberId,foreignWorkspace])
    const foreign=await request(http).post('/api/workflows').set('Authorization','Bearer '+nativeTokens.get(memberId)).send({workspaceId:foreignWorkspace,name:'Fictional unrelated workflow',definition:{startStepId:'pause',steps:[{id:'pause',type:'wait',until:{duration:{minutes:1}}}]}})
    expect(foreign.status,JSON.stringify(foreign.body)).toBe(201)
    expect((await request(http).post('/api/workflows/'+foreign.body.id+'/run').set('Authorization','Bearer '+nativeTokens.get(ownerId)).send({})).status).toBe(404)
    expect((await command({kind:'source.binding.review',appId,input:{profileId,credentialId:credential.credentialId,workflowId:foreign.body.id,expiresAt:new Date(Date.now()+20*60_000).toISOString()}})).status).toBe(403)
    expect((await pool.query('SELECT 1 FROM workflow_runs WHERE workflow_id=$1',[foreign.body.id])).rowCount).toBe(0)
   }finally{await pool.query('DELETE FROM workspaces WHERE id=$1',[foreignWorkspace])}
   const beforeCount=(await pool.query('SELECT count(*)::int AS count FROM workflow_runs WHERE workflow_id=$1',[workflow.id])).rows[0].count
   expect((await request(http).post('/api/workflows/'+workflow.id+'/run').set('Authorization','Bearer '+nativeTokens.get(memberId)).send({})).status).toBe(403)
   expect((await pool.query('SELECT count(*)::int AS count FROM workflow_runs WHERE workflow_id=$1',[workflow.id])).rows[0].count).toBe(beforeCount)
   expect((await request(http).post('/api/workflows/'+randomUUID()+'/run').set('Authorization','Bearer '+nativeTokens.get(ownerId)).send({})).status).toBe(404)
   const run={id:reference.runId}
   const saved=(await runs.getRunSystem(run.id))!;expect(saved.vars.__contextScopeEvidence).toBeTruthy()
   expect(JSON.stringify((await pool.query('SELECT output FROM workflow_step_runs WHERE run_id=$1',[run.id])).rows)).toContain('Fictional purchase')
   // Real native and legacy readers cannot consume scoped protected output or its step trail.
   for(const viewer of [ownerId,memberId]){expect(await runs.getRunById(viewer,run.id)).toBeNull();expect(await runs.listStepRuns(viewer,run.id)).toEqual([]);expect((await request(http).get('/api/workflows/'+workflow.id+'/runs/'+run.id).set('Authorization','Bearer '+nativeTokens.get(viewer))).status).toBe(404)}
   const dispatch=createJobExecutor({jobStore:jobs,runWorkflowFromJob:job=>resumeWorkflowWaitJob(job,{jobStore:jobs,runStore:runs,workflowStore:workflows,executorDeps:deps})})
   async function dueWait(runId:string){
    const rows=(await pool.query<{id:string}>('SELECT id FROM scheduled_jobs WHERE workflow_id=$1 AND channel_id=$2 AND workflow_step_run_id IS NOT NULL AND enabled',[workflow.id,runId])).rows
    expect(rows).toHaveLength(1)
    // Advance only the fixture clock deadline, never an authority or receipt.
    await pool.query('UPDATE scheduled_jobs SET next_run_at=clock_timestamp() WHERE id=$1',[rows[0].id])
    const due=(await jobs.getDueJobs()).find(job=>job.id===rows[0].id);expect(due).toBeTruthy();expect(due!.workflowStepRunId).toBeTruthy();return due!
   }
   const waitJob=await dueWait(run.id);expect(await dispatch(waitJob)).toBe('workflow wait wake-up: completed');expect((await jobs.get(waitJob.id))?.enabled).toBe(false)
   const next=await request(http).post('/api/workflows/'+workflow.id+'/run').set('Authorization','Bearer '+nativeTokens.get(ownerId)).send({})
   expect(next.status).toBe(202);expect(next.body).toEqual({accepted:true,effect:'committed',runId:expect.any(String),outputUnavailable:true})
   const revokedRun={id:next.body.runId},revokedJob=await dueWait(revokedRun.id)
   expect((await fetch(source.url+'/ui/grants',{method:'DELETE',headers:{Authorization:'Bearer '+operatorToken,'Content-Type':'application/json'},body:JSON.stringify({kind:'service',accountId:serviceUserId,recordId:'order-1'})})).status).toBe(200)
   await expect(dispatch(revokedJob)).rejects.toThrow(/workflow wait wake-up .* failed/)
   expect((await runs.getRunSystem(revokedRun.id))?.status).toBe('failed')
   expect((await pool.query("SELECT output FROM workflow_step_runs WHERE run_id=$1 AND step_id='readAgain' AND output IS NOT NULL",[revokedRun.id])).rows).toEqual([])
   await checked({kind:'source.binding.revoke',appId,bindingId:binding})
   const countAfterRevoke=(await pool.query('SELECT count(*)::int AS count FROM workflow_runs WHERE workflow_id=$1',[workflow.id])).rows[0].count
   expect((await request(http).post('/api/workflows/'+workflow.id+'/run').set('Authorization','Bearer '+nativeTokens.get(ownerId)).send({})).status).toBe(403)
   expect((await pool.query('SELECT count(*)::int AS count FROM workflow_runs WHERE workflow_id=$1',[workflow.id])).rows[0].count).toBe(countAfterRevoke)
   expect(source.counters.effects).toBe(0)
   expect((await pool.query("SELECT application_runtime_qualified($1,'connector_source') AS ready",[workspaceId])).rows[0].ready).toBe(false)
  }finally{configureConnectorSourceRuntimeFactory(undefined);await source?.close();await sourcePool.end();await pool.query('DROP SCHEMA '+role+' CASCADE');await pool.query('DROP ROLE '+role)}
 },60_000)

})
