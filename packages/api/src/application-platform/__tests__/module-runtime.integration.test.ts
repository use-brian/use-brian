/** Deployed business module uses real current roles, supported issuance and canonical transactions. */
import {readFile} from 'node:fs/promises'
import { randomUUID,randomBytes,createHash } from 'node:crypto'
import { once } from 'node:events'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApplicationClient,createFetchTransport } from '@use-brian/brian-app/application'
import { createServiceTransport } from '@use-brian/brian-app/module'
import { getPool,getAppPool,queryWithRLS } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { createCompany } from '../../db/crm.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import {createDbOAuthClientStore} from '../../db/oauth-client-store.js'
import {createWorkspaceStore} from '../../db/workspace-store.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { ApplicationPlatformService } from '../service.js'
import { ApplicationManagementService } from '../management.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
import { createCanonicalNativeApplicationModule } from '../native-adapters.js'
import { applicationPlatformRoutes } from '../../routes/application-platform.js'
import { purchaseProperties } from '../purchasing/module.js'
import { createDeployedPurchaseModule } from '../purchasing/host.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-management] [COMP:api/application-records] deployed semantic module service',()=>{
 const pool=getPool(),workspaceId=randomUUID(),ownerId=randomUUID(),assistantId=randomUUID(),serviceIds:string[]=[]
 const secret='fictional-module-native-session',tokens=new Map<string,string>(),http=express();http.use(express.json())
 const store=createDbDocEntityStore({actorUserId:ownerId});let origin:string,appId:string,companyId:string,ids:{requestTypeId:string;lineItemTypeId:string;orderTypeId:string},fields:Record<string,string[]>,platform:ApplicationPlatformService,management:ApplicationManagementService
 const server=http.listen(0,'127.0.0.1'),base=`/api/applications/workspaces/${workspaceId}`
 beforeAll(async()=>{
  if(!server.listening)await once(server,'listening');origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[ownerId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional purchasing workspace',$2)",[workspaceId,ownerId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,ownerId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional purchase assistant',$2,$3,'primary','confidential')",[assistantId,ownerId,workspaceId])
  const session=await authSessionStore.create(ownerId,{deviceLabel:'Fictional native browser',userAgent:'Fixture',ipAddress:'127.0.0.1'});tokens.set(ownerId,createTokens(ownerId,secret,session!).accessToken)
  companyId=(await createCompany(ownerId,{workspaceId,name:'Fictional supplier',access:{workspaceId,userId:ownerId,assistantId,assistantKind:'primary'},mergeByName:false})).id
  const temporary:{requestTypeId:string;lineItemTypeId:string;orderTypeId:string}={requestTypeId:randomUUID(),lineItemTypeId:randomUUID(),orderTypeId:randomUUID()}
  const requestType=await store.createEntityType({workspaceId,name:'Fictional requests',properties:purchaseProperties(temporary).request,createdBy:ownerId})
  temporary.requestTypeId=requestType.id
  const lineType=await store.createEntityType({workspaceId,name:'Fictional line items',properties:purchaseProperties(temporary).lineItem,createdBy:ownerId})
  const orderType=await store.createEntityType({workspaceId,name:'Fictional orders',properties:purchaseProperties(temporary).order,createdBy:ownerId})
  ids={requestTypeId:requestType.id,lineItemTypeId:lineType.id,orderTypeId:orderType.id}
  fields=Object.fromEntries([requestType,lineType,orderType].map(schema=>[schema.id,schema.properties.map(field=>field.name)]))
  // Ordinary source-owned deployment registers ports, never per-actor data authority.
  await pool.query(await readFile(new URL('../../../../../examples/application-platform/operations/deploy.sql',import.meta.url),'utf8'))
  const generic=createCanonicalGenericApplicationModule(),module=createDeployedPurchaseModule()
  const service=platform=new ApplicationPlatformService([createCanonicalNativeApplicationModule(),generic,module]);management=new ApplicationManagementService(service)
  http.use('/api/applications',applicationPlatformRoutes({service,management:{service:management,requireAuth:requireAuth(secret),origins:['https://host.example']},oauth:{clientStore:createDbOAuthClientStore(),workspaceStore:createWorkspaceStore(),signingSecret:secret,webAppUrl:'https://host.example',requireAuth:requireAuth(secret)}}))
  // Explicit owner reviews bootstrap roles before schema ownership; no role fixture seeds.
  for(const roleKey of ['requester','manager'])await govern({kind:'assign_role',userId:ownerId,roleKey,startsAt:new Date(Date.now()-1000).toISOString(),expiresAt:null})
  for(const schemaId of Object.values(ids))await govern({kind:'bind_owner',entityTypeId:schemaId})
  await govern({kind:'configure',operationKey:'set_schemas',input:ids})
  expect((await pool.query('SELECT request_type_id AS id FROM purchasing_schema_bindings WHERE workspace_id=$1',[workspaceId])).rows[0].id).toBe(ids.requestTypeId)
  appId=(await checked({kind:'register',input:{moduleKey:'purchasing',name:'Fictional purchase application',mode:'api_client',origins:[],redirectUris:[]}})).id
  const review=await checked({kind:'activation.review',appId});expect(review.profile).toBe('canonical_module_service_v1');await checked({kind:'activation.apply',appId,reviewId:review.id})
 })
 afterAll(async()=>{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))
  await pool.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);await pool.query("DELETE FROM application_native_configuration_operations WHERE module_key='purchasing';DELETE FROM application_deployed_module_capabilities WHERE module_key='purchasing';DELETE FROM application_native_field_contracts WHERE module_key='purchasing'")
  await pool.query('DROP FUNCTION purchasing_read_schema_bindings(uuid);DROP FUNCTION purchasing_metadata(uuid,jsonb,text,text);DROP FUNCTION purchasing_catalog(uuid,jsonb,text);DROP FUNCTION purchasing_configure_schemas(uuid,jsonb);DROP FUNCTION purchasing_schema_shape(uuid,uuid,uuid,uuid);DROP FUNCTION purchasing_configuration_revision(uuid);DROP TABLE purchasing_schema_bindings')
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,...serviceIds]]);await getAppPool().end();await pool.end()
 })
 async function command(value:Record<string,unknown>){return request(http).post(`${base}/management/commands`).set('Authorization',`Bearer ${tokens.get(ownerId)}`).set('Origin','https://host.example').send(value)}
 async function checked(value:Record<string,unknown>){const result=await command(value);if(result.status===503)await management.executeCommand(ownerId,workspaceId,value);expect(result.status,JSON.stringify({kind:value.kind,result:result.body})).toBe(200);return result.body}
 async function govern(operation:unknown){const catalog=await checked({kind:'governance.catalog',input:{moduleKey:'purchasing'}});const review=await checked({kind:'governance.preview',input:{moduleKey:'purchasing',expectedRevision:catalog.revision,operation}});return checked({kind:'governance.apply',reviewId:review.id,input:{}})}
 const sdk=(token:string)=>createApplicationClient({appId,transport:createServiceTransport({apiOrigin:origin,credential:async()=>({kind:'service',token})})})
 async function serviceUser(role:'requester'|'manager'){
  const user=(await checked({kind:'service.prepare',appId,input:{name:'Fictional '+role,idempotencyKey:randomUUID()}})).serviceUserId as string;serviceIds.push(user)
  await govern({kind:'assign_role',userId:user,roleKey:role,startsAt:new Date(Date.now()-1000).toISOString(),expiresAt:null});return user
 }
 async function grant(userId:string,typeId:string,selection:{kind:'self'}|{kind:'ids';ids:string[]},actions:string[],readFields=fields[typeId],writeFields=fields[typeId],principalKind:'service'|'member'='service'){
  const review=await checked({kind:'grant.review',appId,input:{principal:{kind:principalKind,userId},origin:{kind:'generic',entityTypeId:typeId},typeKey:'record.'+typeId,actions,readFields,writeFields,selector:selection,parentGrantId:null,expiresAt:null,compartments:[],projectIds:[],clearance:'internal'}})
  expect(review.canIssue).toBe(true);return (await checked({kind:'grant.apply',appId,reviewId:review.id})).grantId as string
 }
 async function reference(userId:string){const review=await checked({kind:'grant.review',appId,input:{principal:{kind:'service',userId},origin:{kind:'native',moduleKey:'native'},typeKey:'company',actions:['read'],readFields:[],writeFields:[],selector:{kind:'ids',ids:[companyId]},parentGrantId:null,expiresAt:null,compartments:[],projectIds:[],clearance:'internal'}});expect(review.canIssue).toBe(true);return (await checked({kind:'grant.apply',appId,reviewId:review.id})).grantId as string}
 async function issue(user:string,grantIds:string[]){const review=await checked({kind:'credential.review',appId,input:{name:'Fictional module key',kind:'service',serviceUserId:user,grantIds,expiresAt:new Date(Date.now()+3600_000).toISOString()}});expect(review.canIssue).toBe(true);const delivered=await checked({kind:'credential.deliver',appId,reviewId:review.id});return sdk(delivered.secret)}
 const query=(id:string)=>'record.'+id
 let requestId:string,lineIds:string[],requester:ReturnType<typeof sdk>,manager:ReturnType<typeof sdk>,managerId:string
 it('issues real service roles and semantic commands, preserves canonical company links and protects costs',async()=>{
  const user=await serviceUser('requester'),grants=[await reference(user)]
  for(const id of [ids.requestTypeId,ids.lineItemTypeId])grants.push(await grant(user,id,{kind:'self'},['read','query','create','patch','command:create_request','command:submit_request'],fields[id].filter(key=>!['budget','unitCost','total'].includes(key))))
  requester=await issue(user,grants);requestId=randomUUID();lineIds=[randomUUID(),randomUUID()]
  const receipt=await requester.command('create_request',{idempotencyKey:randomUUID(),input:{id:requestId,title:'Fictional approval',companyId,budget:'10.00',lines:[{id:lineIds[0],title:'First',quantity:2,unitCost:'0.10'},{id:lineIds[1],title:'Second',quantity:3,unitCost:'0.20'}]}})
  expect(receipt.resources).toHaveLength(3)
  expect(await requester.get(query(ids.requestTypeId),requestId)).toMatchObject({values:{company:{value:companyId},state:{value:'draft'}}})
  const line=await requester.get(query(ids.lineItemTypeId),lineIds[0]);expect(line.values).not.toHaveProperty('unitCost')
  await expect(store.updateEntity(workspaceId,requestId,{data:{state:{kind:'text',value:'ordered'}},lastEditedBy:ownerId},{actorUserId:ownerId,expectedRecordVersion:'1'})).rejects.toBeDefined()
  await expect(store.createEntity({workspaceId,entityTypeId:ids.lineItemTypeId,data:{title:{kind:'text',value:'Forbidden append'},request:{kind:'relation',value:requestId},quantity:{kind:'number',value:1},unitCost:{kind:'text',value:'1'}},sourceApp:'api',createdBy:ownerId,lastEditedBy:ownerId})).rejects.toBeDefined()
  await expect(requester.query(query(ids.lineItemTypeId),{fields:['title'],filters:[{field:'unitCost',op:'eq',value:'0.10'}],sort:[],aggregate:[],limit:10})).rejects.toBeDefined()
  await requester.command('submit_request',{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id:requestId}})
  await expect(requester.command('approve_order',{idempotencyKey:randomUUID(),expectedVersion:'2',input:{id:requestId,orderId:randomUUID()}})).rejects.toMatchObject({code:'access_unavailable'})
  await expect(requester.command('record_batch',{idempotencyKey:randomUUID(),input:{operations:[]}})).rejects.toMatchObject({code:'access_unavailable'})
  managerId=await serviceUser('manager');const managerGrants=[await reference(managerId)]
  managerGrants.push(await grant(managerId,ids.requestTypeId,{kind:'ids',ids:[requestId]},['read','query','patch','command:approve_order']))
  managerGrants.push(await grant(managerId,ids.lineItemTypeId,{kind:'ids',ids:lineIds},['read','query']))
  managerGrants.push(await grant(managerId,ids.orderTypeId,{kind:'self'},['read','query','create','command:approve_order']))
  manager=await issue(managerId,managerGrants)
  expect((await manager.get(query(ids.lineItemTypeId),lineIds[0])).values.unitCost).toMatchObject({value:'0.10'})
 },60_000)
 it('approves exact decimals once and commits request/order/revision/audit/outbox atomically with CAS and replay',async()=>{
  const orderId=randomUUID(),key=randomUUID(),input={idempotencyKey:key,expectedVersion:'2',input:{id:requestId,orderId}}
  await pool.query(`CREATE FUNCTION purchase_fixture_outbox_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional atomic outbox refusal';END $$;CREATE TRIGGER purchase_fixture_outbox_refusal BEFORE INSERT ON application_committed_events FOR EACH ROW WHEN (NEW.module_key='purchasing') EXECUTE FUNCTION purchase_fixture_outbox_refusal()`)
  try{await expect(manager.command('approve_order',input)).rejects.toBeDefined()}finally{await pool.query('DROP TRIGGER purchase_fixture_outbox_refusal ON application_committed_events;DROP FUNCTION purchase_fixture_outbox_refusal()')}
  expect((await pool.query('SELECT data FROM entity_instances WHERE id=$1',[requestId])).rows[0].data.state.value).toBe('submitted')
  expect((await pool.query('SELECT 1 FROM entity_instances WHERE id=$1',[orderId])).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM application_operation_receipts WHERE application_client_id=$1 AND idempotency_key=$2',[appId,key])).rowCount).toBe(0)
  const receipt=await manager.command('approve_order',input);expect(receipt.resources).toHaveLength(2)
  expect(await manager.command('approve_order',input)).toEqual(receipt)
  expect(await manager.get(query(ids.orderTypeId),orderId)).toMatchObject({values:{total:{value:'0.8'},company:{value:companyId}}})
  expect((await pool.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[receipt.id])).rows[0].count).toBe(1)
  expect((await pool.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[receipt.id])).rows[0].count).toBe(1)
  await expect(manager.command('approve_order',{...input,idempotencyKey:randomUUID(),input:{id:requestId,orderId:randomUUID()}})).rejects.toBeDefined()
 },60_000)
 it('invokes the same semantic handlers through actual native member HTTP and registered MCP with session audience separation',async()=>{
  const id=randomUUID(),line=randomUUID(),native=request(http),header=`Bearer ${tokens.get(ownerId)}`
  const result=await native.post(`${base}/modules/command`).set('Authorization',header).set('Origin','https://host.example').send({moduleKey:'purchasing',commandKey:'create_request',command:{idempotencyKey:randomUUID(),input:{id,title:'Native member purchase',companyId,budget:'5',lines:[{id:line,title:'Native line',quantity:1,unitCost:'0.25'}]}}})
  expect(result.status,JSON.stringify(result.body)).toBe(200);expect(result.body.resources).toHaveLength(2)
  async function mcp(method:string,params:unknown){const response=await fetch(`${origin}${base}/modules/mcp?moduleKey=purchasing`,{method:'POST',headers:{Authorization:header,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});expect(response.status).toBe(200);const body=await response.text(),line=body.split('\n').find(value=>value.startsWith('data: '));return JSON.parse(line?line.slice(6):body).result}
  const tools=await mcp('tools/list',{});expect(tools.tools.map((tool:{name:string})=>tool.name)).toContain('nativeModuleCommand')
  const changed=await mcp('tools/call',{name:'nativeModuleCommand',arguments:{commandKey:'submit_request',command:{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id}}}})
  expect(changed.isError,JSON.stringify(changed)).not.toBe(true)
  const read=await native.post(`${base}/modules/query`).set('Authorization',header).send({moduleKey:'purchasing',queryKey:'get',input:{type:query(ids.requestTypeId),id}})
  expect(read.status,JSON.stringify(read.body)).toBe(200);expect(read.body.values.state.value).toBe('submitted')
  expect((await native.post(`${base}/modules/query`).send({moduleKey:'purchasing',queryKey:'get',input:{type:query(ids.requestTypeId),id}})).status).toBe(401)
  expect((await native.post(`${base}/modules/query`).set('Authorization',header).send({moduleKey:'purchasing',assistantId:randomUUID(),queryKey:'get',input:{type:query(ids.requestTypeId),id}})).status).toBe(403)
  expect((await native.post(`${base}/modules/command`).set('Authorization',header).send({moduleKey:'purchasing',commandKey:'record_batch',command:{idempotencyKey:randomUUID(),input:{operations:[]}}})).status).toBe(404)
 },60_000)
 it('preserves installed identities, current credentials and exact receipts across explicit reference and normal host swaps',async()=>{
  const actor=await serviceUser('requester'),grants=[await reference(actor)]
  grants.push(await grant(actor,ids.requestTypeId,{kind:'self'},['read','query','history','create','patch','command:create_request','command:submit_request']))
  grants.push(await grant(actor,ids.lineItemTypeId,{kind:'self'},['read','query','create','patch','command:create_request','command:submit_request']))
  const review=await checked({kind:'credential.review',appId,input:{name:'Fictional continuity key',kind:'service',serviceUserId:actor,grantIds:grants,expiresAt:new Date(Date.now()+3600_000).toISOString()}})
  expect(review.canIssue).toBe(true)
  const delivered=await checked({kind:'credential.deliver',appId,reviewId:review.id}),id=randomUUID(),lineId=randomUUID(),key=randomUUID()
  const input={idempotencyKey:key,input:{id,title:'Fictional host continuity',companyId,budget:'2',lines:[{id:lineId,title:'Preserved line',quantity:1,unitCost:'0.25'}]}}
  const extraType=await store.createEntityType({workspaceId,name:'Fictional independent note',properties:[purchaseProperties(ids).request[0]],createdBy:ownerId})
  const extra=await store.createEntity({workspaceId,entityTypeId:extraType.id,data:{title:{kind:'text',value:'Canonical record remains'}},sourceApp:'api',createdBy:ownerId,lastEditedBy:ownerId})
  let active:ReturnType<typeof http.listen>|undefined
  const open=async(reference:boolean)=>{
   if(active){active.closeAllConnections();await new Promise<void>(resolve=>active!.close(()=>resolve()));active=undefined}
   const service=new ApplicationPlatformService([createCanonicalNativeApplicationModule(),createCanonicalGenericApplicationModule(),...(reference?[createDeployedPurchaseModule()]:[])])
   expect([...service.registry.applications.keys()].sort()).toEqual(reference?['native','purchasing','records']:['native','records'])
   const host=express();host.use(express.json());host.use('/api/applications',applicationPlatformRoutes({service,management:{service:new ApplicationManagementService(service),requireAuth:requireAuth(secret),origins:['https://host.example']}}))
   active=host.listen(0,'127.0.0.1');if(!active.listening)await once(active,'listening')
   return request(active)
  }
  const servicePath=`/api/applications/${appId}`,header=`Bearer ${delivered.secret}`,nativeHeader=`Bearer ${tokens.get(ownerId)}`
  const command=(host:ReturnType<typeof request>,operation:string,envelope:object,reconcile=false)=>host.post(`${servicePath}/commands/${operation}${reconcile?'/reconcile':''}`).set('Authorization',header).send(envelope)
  const snapshot=async()=>{
   const tables=['workspace_modules','application_clients','entity_types','purchasing_schema_bindings','application_native_resource_owners','application_native_role_assignments','application_access_grants','application_api_credentials','application_operation_receipts','application_command_audit','application_committed_events']
   const result:Record<string,unknown>={}
   for(const table of tables)result[table]=(await pool.query(`SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') AS value FROM (SELECT to_jsonb(entry)-'last_used_at' AS value FROM ${table} entry WHERE workspace_id=$1) snapshots`,[workspaceId])).rows[0].value
   result.records=(await pool.query('SELECT * FROM entity_instances WHERE id=ANY($1::uuid[]) ORDER BY id',[[id,lineId,extra.id]])).rows
   result.history=(await pool.query('SELECT * FROM application_record_revisions WHERE workspace_id=$1 AND entity_instance_id=ANY($2::uuid[]) ORDER BY entity_instance_id,record_version',[workspaceId,[id,lineId,extra.id]])).rows
   return result
  }
  try{
   let host=await open(true)
   const created=await command(host,'create_request',input);expect(created.status,JSON.stringify(created.body)).toBe(200);const receipt=created.body
   expect(receipt.resources).toHaveLength(2)
   const saved=await snapshot()
   host=await open(false)
   const absent=await command(host,'create_request',input);expect(absent.status,JSON.stringify(absent.body)).toBe(404);expect(absent.body).toMatchObject({error:'operation_not_available',effect:'none'})
   const recoveryAbsent=await command(host,'create_request',input,true);expect(recoveryAbsent.status).toBe(404);expect(recoveryAbsent.body.error).toBe('operation_not_available')
   const native=await host.post(`${base}/modules/query`).set('Authorization',nativeHeader).send({moduleKey:'native',queryKey:'get',input:{type:'company',id:companyId}});expect(native.status,JSON.stringify(native.body)).toBe(200)
   const record=await host.post(`${base}/modules/query`).set('Authorization',nativeHeader).send({moduleKey:'records',queryKey:'get',input:{type:query(extraType.id),id:extra.id}});expect(record.status,JSON.stringify(record.body)).toBe(200);expect(record.body.ref.id).toBe(extra.id)
   const raw=await host.post(`${base}/modules/command`).set('Authorization',nativeHeader).send({moduleKey:'records',commandKey:'record_batch',command:{idempotencyKey:randomUUID(),input:{operations:[{operation:'patch',type:query(ids.requestTypeId),id,expectedVersion:'1',data:{state:{kind:'text',value:'ordered'}}}]}}});expect(raw.status,JSON.stringify(raw.body)).toBe(403)
   expect(await snapshot()).toEqual(saved)
   host=await open(true)
   const read=await host.get(`${servicePath}/records/${query(ids.requestTypeId)}/${id}`).set('Authorization',header);expect(read.status,JSON.stringify(read.body)).toBe(200);expect(read.body.ref).toMatchObject({id,version:'1'})
   const reconciled=await command(host,'create_request',input,true);expect(reconciled.status,JSON.stringify(reconciled.body)).toBe(200);expect(reconciled.body).toEqual({state:'applied',receipt})
   const replay=await command(host,'create_request',input);expect(replay.status,JSON.stringify(replay.body)).toBe(200);expect(replay.body).toEqual(receipt)
   const conflict=await command(host,'create_request',{...input,input:{...input.input,title:'Different exact input'}});expect(conflict.status,JSON.stringify(conflict.body)).toBe(409);expect(conflict.body.error).toBe('record_version_conflict')
   expect(await snapshot()).toEqual(saved)
   const next={idempotencyKey:randomUUID(),expectedVersion:'1',input:{id}},submitted=await command(host,'submit_request',next);expect(submitted.status,JSON.stringify(submitted.body)).toBe(200)
   expect((await command(host,'submit_request',next)).body).toEqual(submitted.body)
   expect((await pool.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[submitted.body.id])).rows[0].count).toBe(1)
   expect((await pool.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[submitted.body.id])).rows[0].count).toBe(1)
   const advanced=await snapshot();host=await open(false);expect((await command(host,'submit_request',next)).status).toBe(404);expect(await snapshot()).toEqual(advanced)
   host=await open(true);const restored=await command(host,'create_request',input,true);expect(restored.status,JSON.stringify(restored.body)).toBe(200);expect(restored.body).toEqual({state:'applied',receipt});expect(await snapshot()).toEqual(advanced)
   await checked({kind:'credential.revoke',appId,credentialId:delivered.credentialId})
   const revoked=await snapshot()
   const refusedRecovery=await command(host,'create_request',input,true),refusedCommand=await command(host,'submit_request',{...next,idempotencyKey:randomUUID(),expectedVersion:'2'})
   for(const denied of [refusedRecovery,refusedCommand]){expect(denied.status).toBe(401);expect(denied.body).toMatchObject({error:'authentication_required',effect:'none'})}
   expect(await snapshot()).toEqual(revoked)
   expect((await pool.query('SELECT count(*)::int AS count FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,key])).rows[0].count).toBe(1)
  }finally{if(active){active.closeAllConnections();await new Promise<void>(resolve=>active!.close(()=>resolve()))}}
 },60_000)
 it('executes genuine member PKCE semantic writes through the deployed workspace configuration and exact reviewed grants',async()=>{
  const prior=appId,redirectUri='https://purchase.example/callback',browserOrigin='https://purchase.example'
  const frontend=await checked({kind:'register',input:{moduleKey:'purchasing',name:'Fictional member frontend',mode:'external_frontend',origins:[browserOrigin],redirectUris:[redirectUri]}})
  try{appId=frontend.id
   const activation=await checked({kind:'activation.review',appId});expect(activation.profile).toBe('canonical_module_frontend_v1');expect(activation.scope.principal).toBe('member');await checked({kind:'activation.apply',appId,reviewId:activation.id})
   const actions=['read','query','history','create','patch','command:create_request','command:submit_request','command:approve_order']
   for(const typeId of Object.values(ids))await grant(ownerId,typeId,{kind:'self'},actions,fields[typeId],fields[typeId],'member')
   const proposal={principal:{kind:'member',userId:ownerId},origin:{kind:'native',moduleKey:'native'},typeKey:'company',actions:['read'],readFields:[],writeFields:[],selector:{kind:'ids',ids:[companyId]},parentGrantId:null,expiresAt:null,compartments:[],projectIds:[],clearance:'internal'}
   const reference=await checked({kind:'grant.review',appId,input:proposal});expect(reference.canIssue).toBe(true);await checked({kind:'grant.apply',appId,reviewId:reference.id})
   const base='/api/applications/'+appId,verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url')
   const flow=await request(http).get(base+'/authorize').query({client_id:frontend.oauthClientId,redirect_uri:redirectUri,response_type:'code',code_challenge:challenge,code_challenge_method:'S256',scope:'read_write'})
   expect(flow.status).toBe(302);const signed=new URL(flow.headers.location).searchParams.get('req')!
   const review=await request(http).get(base+'/consent').query({req:signed}).set('Authorization','Bearer '+tokens.get(ownerId));expect(review.status,JSON.stringify(review.body)).toBe(200)
   const allowed=await request(http).post(base+'/consent').set('Authorization','Bearer '+tokens.get(ownerId)).send({req:signed,workspaceId,decision:'allow',review:review.body.application.review});expect(allowed.status,JSON.stringify(allowed.body)).toBe(200)
   const code=new URL(allowed.body.redirectUrl).searchParams.get('code')
   const exchanged=await request(http).post(base+'/token').set('Origin',browserOrigin).type('form').send({grant_type:'authorization_code',client_id:frontend.oauthClientId,redirect_uri:redirectUri,code,code_verifier:verifier});expect(exchanged.status,JSON.stringify(exchanged.body)).toBe(200)
   const client=createApplicationClient({appId,transport:createFetchTransport({apiOrigin:origin,credential:async()=>exchanged.body.access_token,fetch:async(input,init)=>fetch(input,{...init,headers:{...init?.headers,Origin:browserOrigin}})})}),id=randomUUID(),orderId=randomUUID()
   await client.command('create_request',{idempotencyKey:randomUUID(),input:{id,title:'Member browser purchase',companyId,budget:'5',lines:[{id:randomUUID(),title:'Browser line',quantity:2,unitCost:'0.25'}]}})
   await client.command('submit_request',{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id}})
   await client.command('approve_order',{idempotencyKey:randomUUID(),expectedVersion:'2',input:{id,orderId}})
   expect(await client.get(query(ids.orderTypeId),orderId)).toMatchObject({values:{total:{value:'0.5'}}})
   await expect(client.command('record_batch',{idempotencyKey:randomUUID(),input:{operations:[]}})).rejects.toMatchObject({code:'access_unavailable'})
   await govern({kind:'configure',operationKey:'set_schemas',input:ids})
   await expect(client.catalog()).rejects.toBeDefined()
  }finally{appId=prior}
 },60_000)
 it('bootstraps only an explicit current owner self-review once and serializes competing initial reviews',async()=>{
  const work=randomUUID(),agent=randomUUID(),peer=randomUUID();serviceIds.push(peer)
  await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[peer])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional module setup',$2)",[work,ownerId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','confidential')",[work,ownerId,peer])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional setup assistant',$2,$3,'primary','confidential')",[agent,ownerId,work])
  const session=await authSessionStore.create(peer,{deviceLabel:'Fictional member',userAgent:'Fixture',ipAddress:'127.0.0.1'}),peerToken=createTokens(peer,secret,session!).accessToken
  const invoke=(body:Record<string,unknown>,bearer=tokens.get(ownerId))=>request(http).post(`/api/applications/workspaces/${work}/management/commands`).set('Authorization','Bearer '+bearer).send(body)
  const catalog=async()=>{const result=await invoke({kind:'governance.catalog',input:{moduleKey:'purchasing'}});expect(result.status,JSON.stringify(result.body)).toBe(200);return result.body}
  const proposal=(roleKey:string,userId=ownerId)=>({kind:'assign_role',userId,roleKey,startsAt:new Date(Date.now()-1000).toISOString(),expiresAt:null})
  const preview=(revision:string,operation:unknown,bearer?:string)=>invoke({kind:'governance.preview',input:{moduleKey:'purchasing',expectedRevision:revision,operation}},bearer)
  try{
   const current=await catalog()
   expect((await preview(current.revision,proposal('manager',peer))).status).toBe(403)
   expect((await preview(current.revision,proposal('manager',peer),peerToken)).status).toBe(403)
   const operation=proposal('requester'),reviews=await Promise.all([preview(current.revision,operation),preview(current.revision,operation)])
   expect(reviews.map(row=>row.status)).toEqual([200,200])
   const applied=await Promise.all(reviews.map(row=>invoke({kind:'governance.apply',reviewId:row.body.id,input:{}})))
   expect(applied.map(row=>row.status).sort()).toEqual([200,409])
   const schema=await store.createEntityType({workspaceId:work,name:'Fictional setup schema',properties:[{name:'title',required:true,config:{kind:'text'}}],createdBy:ownerId})
   const beforeBind=await catalog(),bind=await preview(beforeBind.revision,{kind:'bind_owner',entityTypeId:schema.id});expect(bind.status,JSON.stringify(bind.body)).toBe(200)
   expect((await invoke({kind:'governance.apply',reviewId:bind.body.id,input:{}})).status).toBe(200)
   // Manager has no role history here, but schema ownership closes initial bootstrap.
   expect((await preview((await catalog()).revision,proposal('manager'))).status).toBe(403)
   const active=(await catalog()).roleAssignments.find((row:{roleKey:string})=>row.roleKey==='requester'),revoke=await preview((await catalog()).revision,{kind:'revoke_role',assignmentId:active.id,expectedVersion:active.version})
   expect(revoke.status).toBe(200);expect((await invoke({kind:'governance.apply',reviewId:revoke.body.id,input:{}})).status).toBe(200)
   expect((await invoke({kind:'governance.catalog',input:{moduleKey:'purchasing'}})).status).toBe(403)
   expect((await preview(beforeBind.revision,proposal('requester'))).status).toBe(403)
  }finally{await pool.query('DELETE FROM workspaces WHERE id=$1',[work])}
 },60_000)
 it('rejects an over-budget approval through actual native module HTTP without an order, revision, receipt, audit or outbox effect',async()=>{
  const id=randomUUID(),lineId=randomUUID(),orderId=randomUUID(),key=randomUUID(),header=`Bearer ${tokens.get(ownerId)}`
  const invoke=(commandKey:string,command:Record<string,unknown>)=>request(http).post(`${base}/modules/command`).set('Authorization',header).set('Origin','https://host.example').send({moduleKey:'purchasing',commandKey,command})
  expect((await invoke('create_request',{idempotencyKey:randomUUID(),input:{id,title:'Fictional over-budget approval',companyId,budget:'0.19',lines:[{id:lineId,title:'Exact budget boundary',quantity:2,unitCost:'0.10'}]}})).status).toBe(200)
  expect((await invoke('submit_request',{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id}})).status).toBe(200)
  const counts=async()=>(await pool.query(`SELECT (SELECT count(*)::int FROM application_operation_receipts WHERE workspace_id=$1 AND module_key='purchasing') AS receipts,(SELECT count(*)::int FROM application_command_audit WHERE workspace_id=$1 AND module_key='purchasing') AS audits,(SELECT count(*)::int FROM application_committed_events WHERE workspace_id=$1 AND module_key='purchasing') AS events`,[workspaceId])).rows[0]
  const before=await counts(),denied=await invoke('approve_order',{idempotencyKey:key,expectedVersion:'2',input:{id,orderId}})
  expect(denied.status,JSON.stringify(denied.body)).toBe(400);expect(denied.body).toMatchObject({error:'invalid_value',effect:'none'})
  const current=await request(http).post(`${base}/modules/query`).set('Authorization',header).send({moduleKey:'purchasing',queryKey:'get',input:{type:query(ids.requestTypeId),id}})
  expect(current.status,JSON.stringify(current.body)).toBe(200);expect(current.body).toMatchObject({ref:{version:'2'},values:{state:{value:'submitted'},budget:{value:'0.19'}}})
  expect((await pool.query('SELECT 1 FROM entity_instances WHERE id=$1',[orderId])).rowCount).toBe(0)
  expect((await pool.query('SELECT 1 FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,key])).rowCount).toBe(0)
  expect(await counts()).toEqual(before)
 },60_000)
 it('serializes competing actual native approval commands at the canonical CAS boundary and commits exactly one order, receipt, audit and event',async()=>{
  const id=randomUUID(),lineId=randomUUID(),orders=[randomUUID(),randomUUID()],keys=[randomUUID(),randomUUID()],header=`Bearer ${tokens.get(ownerId)}`
  const invoke=(commandKey:string,command:Record<string,unknown>)=>request(http).post(`${base}/modules/command`).set('Authorization',header).set('Origin','https://host.example').send({moduleKey:'purchasing',commandKey,command})
  expect((await invoke('create_request',{idempotencyKey:randomUUID(),input:{id,title:'Fictional competing approvals',companyId,budget:'1.00',lines:[{id:lineId,title:'Exact concurrent approval',quantity:2,unitCost:'0.10'}]}})).status).toBe(200)
  expect((await invoke('submit_request',{idempotencyKey:randomUUID(),expectedVersion:'1',input:{id}})).status).toBe(200)
  const commands=orders.map((orderId,index)=>({idempotencyKey:keys[index],expectedVersion:'2',input:{id,orderId}}))
  const results=await Promise.all(commands.map(command=>invoke('approve_order',command)))
  expect(results.map(row=>row.status).sort(),JSON.stringify(results.map(row=>row.body))).toEqual([200,409])
  const winner=results.findIndex(row=>row.status===200),loser=1-winner
  expect(results[loser].body).toMatchObject({error:'record_version_conflict',effect:'none'})
  const receipt=results[winner].body;expect(receipt.resources).toHaveLength(2)
  expect((await pool.query('SELECT id FROM entity_instances WHERE id=ANY($1::uuid[])',[orders])).rows.map(row=>row.id)).toEqual([orders[winner]])
  expect((await pool.query('SELECT 1 FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,keys[loser]])).rowCount).toBe(0)
  expect((await pool.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[receipt.id])).rows[0].count).toBe(1)
  expect((await pool.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[receipt.id])).rows[0].count).toBe(1)
  const current=await request(http).post(`${base}/modules/query`).set('Authorization',header).send({moduleKey:'purchasing',queryKey:'get',input:{type:query(ids.requestTypeId),id}})
  expect(current.status).toBe(200);expect(current.body).toMatchObject({ref:{version:'3'},values:{state:{value:'ordered'},total:{value:'0.2'}}})
  const replay=await invoke('approve_order',commands[winner]);expect(replay.status).toBe(200);expect(replay.body).toEqual(receipt)
  expect((await pool.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[receipt.id])).rows[0].count).toBe(1)
 },60_000)
 it('denies registry and current role drift and runtime registration writes without borrowing an owner',async()=>{
  await expect(queryWithRLS(ownerId,"INSERT INTO application_deployed_module_capabilities(module_key,contract_version,commands,queries) VALUES('purchasing','forged',ARRAY['forged'],'{}')")).rejects.toMatchObject({code:'42501'})
  const catalog=await checked({kind:'governance.catalog',input:{moduleKey:'purchasing'}}),role=catalog.roleAssignments.find((row:{userId:string;roleKey:string})=>row.userId===managerId&&row.roleKey==='manager')
  await govern({kind:'revoke_role',assignmentId:role.id,expectedVersion:role.version})
  await expect(manager.command('approve_order',{idempotencyKey:randomUUID(),expectedVersion:'3',input:{id:requestId,orderId:randomUUID()}})).rejects.toBeDefined()
  const registered=platform.registry.applications.get('purchasing')!,mutable=platform.registry.applications as Map<string,typeof registered>
  const nativeRead=()=>request(http).post(`${base}/modules/query`).set('Authorization','Bearer '+tokens.get(ownerId)).send({moduleKey:'purchasing',queryKey:'get',input:{type:query(ids.requestTypeId),id:requestId}})
  expect((await nativeRead()).status).toBe(200)
  const readWithDefinition = (definition: typeof registered) => {
    const modules = [...platform.registry.applications.values()].map(module => module.key === definition.key ? definition : module)
    const service = new ApplicationPlatformService(modules)
    const isolated = express(); isolated.use(express.json())
    isolated.use('/api/applications', applicationPlatformRoutes({ service,
      management: { service: new ApplicationManagementService(service), requireAuth: requireAuth(secret), origins: ['https://host.example'] } }))
    return request(isolated).post(`${base}/modules/query`).set('Authorization', 'Bearer ' + tokens.get(ownerId))
      .send({ moduleKey: 'purchasing', queryKey: 'get', input: { type: query(ids.requestTypeId), id: requestId } })
  }
  const forged = { ...registered, application: { ...registered.application, version: 'forged', policyCapabilities: [] } }
  mutable.set('purchasing', forged)
  expect((await nativeRead()).status).toBe(200)
  expect((await readWithDefinition(forged)).status).toBe(403)
  await pool.query("UPDATE application_deployed_module_capabilities SET default_state='disabled' WHERE module_key='purchasing'")
  expect((await nativeRead()).status).toBe(403)
  await pool.query("UPDATE application_deployed_module_capabilities SET default_state='enabled' WHERE module_key='purchasing'")
  await pool.query("DELETE FROM application_deployed_module_capabilities WHERE module_key='purchasing'")
  expect((await nativeRead()).status).toBe(403)
  expect((await readWithDefinition({ ...registered, application: { ...registered.application, policyCapabilities: [] } })).status).toBe(403)
  await pool.query("INSERT INTO application_deployed_module_capabilities(module_key,contract_version,commands,queries,dependencies) VALUES('purchasing','1',ARRAY['create_request','submit_request','approve_order'],ARRAY['get','query','history'],ARRAY['records','native'])")
  expect((await nativeRead()).status).toBe(200)
  await pool.query("UPDATE application_deployed_module_capabilities SET contract_version='stale' WHERE module_key='purchasing'")
  await expect(manager.catalog()).rejects.toBeDefined()
  expect((await command({kind:'activation.review',appId})).status).toBe(403)
 },60_000)
})
