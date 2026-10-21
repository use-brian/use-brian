import {randomUUID} from 'node:crypto'
import {beforeAll,afterAll,describe,it,expect} from 'vitest'
import express from 'express'
import request from 'supertest'
import {getPool,getAppPool} from '../../db/client.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {createDbDocEntityStore} from '../../db/doc-entity-store.js'
import {ApplicationPlatformService} from '../service.js'
import {ApplicationManagementService} from '../management.js'
import {createCanonicalGenericApplicationModule} from '../generic-adapter.js'
import {applicationPlatformRoutes} from '../../routes/application-platform.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-management] native human and Brian management',()=>{
 const owner=getPool(),workspaceId=randomUUID(),foreignWorkspaceId=randomUUID(),actorId=randomUUID(),memberId=randomUUID(),foreignId=randomUUID(),assistantId=randomUUID()
 const secret='fictional-management-session-secret',service=new ApplicationPlatformService([createCanonicalGenericApplicationModule()]),management=new ApplicationManagementService(service)
 const http=express();http.use(express.json());http.use('/api/applications',applicationPlatformRoutes({service,management:{service:management,requireAuth:requireAuth(secret),origins:['https://host.example']}}))
 const base=`/api/applications/workspaces/${workspaceId}`,tokens=new Map<string,string>();let appId:string,schemaId:string,recordId:string
 const properties=[{name:'title',config:{kind:'text' as const},required:true}]
 beforeAll(async()=>{
  for(const id of [actorId,memberId,foreignId])await owner.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[id])
  for(const [id,user] of [[workspaceId,actorId],[foreignWorkspaceId,foreignId]]){
   await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional management workspace',$2)",[id,user])
   await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[id,user])
  }
  await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')",[workspaceId,memberId])
  await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional governance assistant',$2,$3,'primary','confidential')",[assistantId,actorId,workspaceId])
  for(const actor of [actorId,memberId,foreignId]){const session=await authSessionStore.create(actor,{deviceLabel:'Fictional management browser',userAgent:'Fixture',ipAddress:'127.0.0.1'});tokens.set(actor,createTokens(actor,secret,session!).accessToken)}
  const store=createDbDocEntityStore({actorUserId:actorId}),schema=await store.createEntityType({workspaceId,name:'Fictional requests',createdBy:actorId,properties});schemaId=schema.id
  recordId=(await store.createEntity({workspaceId,entityTypeId:schemaId,createdBy:actorId,lastEditedBy:actorId,sourceApp:'api',data:{title:{kind:'text',value:'Fictional request'}}})).id
  appId=(await management.create(actorId,{workspaceId,moduleKey:'records',name:'Fictional application',mode:'api_client',origins:[],redirectUris:[]})).id
 })
 afterAll(async()=>{await owner.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[[workspaceId,foreignWorkspaceId]]);await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[actorId,memberId,foreignId]]);await getAppPool().end();await owner.end()})
 const command=(body:Record<string,unknown>,actor=actorId)=>request(http).post(`${base}/management/commands`).set('Authorization',`Bearer ${tokens.get(actor)}`).set('Origin','https://host.example').send(body)
 function rpc(method:string,params?:unknown,actor=actorId){return request(http).post(`${base}/management/mcp`).set('Authorization',`Bearer ${tokens.get(actor)}`).set('Accept','application/json, text/event-stream').set('MCP-Protocol-Version','2025-11-25').send({jsonrpc:'2.0',id:1,method,...(params?{params}:{})})}
 const decode=(response:{text:string;body:unknown})=>{const line=response.text.split('\n').find(s=>s.startsWith('data: '));return line?JSON.parse(line.slice(6)):response.body as any}
 async function tool(body:unknown,actor=actorId){const r=decode(await rpc('tools/call',{name:'applicationManage',arguments:{command:body}},actor));return {reply:r.result??r,value:r.result?.content?.[0]?.text?JSON.parse(r.result.content[0].text):null}}
 async function overview(app?:string){const r=decode(await rpc('tools/call',{name:'applicationManagementOverview',arguments:app?{appId:app}:{}}));expect(r.result?.isError,JSON.stringify(r)).not.toBe(true);return JSON.parse(r.result.content[0].text)}
 const grant=()=>({principal:{kind:'member',userId:actorId},origin:{kind:'generic',entityTypeId:schemaId},typeKey:'request',actions:['read','query'],readFields:['title'],writeFields:[],selector:{kind:'ids',ids:[recordId]},expiresAt:new Date(Date.now()+3600_000).toISOString(),parentGrantId:null,compartments:[],projectIds:[],clearance:'internal'})
 it('M01 refuses owner-pool governance and genuine nonadministrator/nonmember/foreign actors',async()=>{
  await expect(new ApplicationManagementService(service,owner).overview(actorId,workspaceId)).rejects.toMatchObject({code:'access_unavailable'})
  for(const actor of [memberId,foreignId]){const response=await request(http).get(`${base}/management`).set('Authorization',`Bearer ${tokens.get(actor)}`);expect(response.status).toBe(403)}
  expect((await request(http).get(`${base}/management`)).status).toBe(401)
  expect((await request(http).get(`/api/applications/workspaces/${foreignWorkspaceId}/management`).set('Authorization',`Bearer ${tokens.get(actorId)}`)).status).toBe(403)
 })
 it('M01 binds actual native actor/assistant and refuses app audience or unregistered origins',async()=>{
  const response=await request(http).get(`${base}/management`).set('Authorization',`Bearer ${tokens.get(actorId)}`).query({appId})
  expect(response.status).toBe(200);expect(response.body.governance).toMatchObject({state:'unavailable',moduleKey:'records',catalog:null});expect(response.body.actor).toEqual({userId:actorId,assistantId});expect(response.body.links.access).toBe(`/w/${workspaceId}/organization?section=access`);expect(response.body.clients.some((c:any)=>c.id===appId)).toBe(true)
  expect((await command({kind:'status',appId,status:'suspended'}).set('Origin','https://foreign.example')).status).toBe(403)
  expect((await request(http).get(`${base}/management`).query({actorId:foreignId}).set('Authorization',`Bearer ${tokens.get(actorId)}`)).status).toBe(400)
 })
 it('M01 native browser preflight accepts the client timezone header without exposing management data',async()=>{
  const preflight=await request(http).options(`${base}/management`).set('Origin','https://host.example').set('Access-Control-Request-Method','GET').set('Access-Control-Request-Headers','authorization,x-client-timezone')
  expect(preflight.status).toBe(204);expect(preflight.text).toBe('');expect(preflight.headers['access-control-allow-origin']).toBe('https://host.example');expect(preflight.headers['access-control-allow-headers'].toLowerCase().split(',').map((value:string)=>value.trim())).toEqual(expect.arrayContaining(['authorization','x-client-timezone']));expect(preflight.headers['cache-control']).toBe('no-store')
  expect((await request(http).options(`${base}/management`).set('Origin','https://foreign.example')).status).toBe(403)
  expect((await request(http).get(`${base}/management`).set('Origin','https://host.example').set('X-Client-Timezone','Asia/Shanghai')).status).toBe(401)
  const current=await request(http).get(`${base}/management`).set('Origin','https://host.example').set('X-Client-Timezone','Asia/Shanghai').set('Authorization',`Bearer ${tokens.get(actorId)}`)
  expect(current.status).toBe(200);expect(current.body.actor.userId).toBe(actorId);expect(current.body.readiness.qualified).toBe(false)
 })
 it('M01 registration through HTTP and Brian reaches the same deployed module contract',async()=>{
  const body={kind:'register',input:{moduleKey:'records',name:'Fictional HTTP registration',mode:'api_client',origins:[],redirectUris:[]}}
  const human=await command(body),brian=await tool({...body,input:{...body.input,name:'Fictional Brian registration'}})
  expect(human.status).toBe(200);expect(brian.value).toMatchObject({error:'grant_revoked',effect:'committed',retrySafe:false});const registered=await owner.query("SELECT module_key FROM application_clients WHERE workspace_id=$1 AND name='Fictional Brian registration'",[workspaceId]);expect(registered.rows).toEqual([{module_key:human.body.moduleKey}]);const current=await overview();expect(current.clients.filter((client:{name:string})=>client.name==='Fictional Brian registration')).toHaveLength(1);expect(current.clients.find((client:{name:string})=>client.name==='Fictional Brian registration').moduleKey).toBe(human.body.moduleKey)
  expect((await command({...body,input:{...body.input,moduleKey:'missing_module'}})).status).toBe(409)
 })
 it('M01 denies foreign app selection instead of returning an empty authorized projection',async()=>{
  const value=await request(http).get(`${base}/management`).query({appId:randomUUID()}).set('Authorization',`Bearer ${tokens.get(actorId)}`)
  expect(value.status).toBe(403)
 })
 it('M02 and M07 safe grant reviews retain exact ceilings but unqualified apply refuses in both transports',async()=>{
  const input=grant(),human=await command({kind:'grant.review',appId,input}),brian=await tool({kind:'grant.review',appId,input})
  expect(human.status).toBe(200);expect(human.body.canIssue).toBe(false);expect(brian.value.canIssue).toBe(false)
  expect(brian.value.proposal.readFields??brian.value.proposal.read_fields).toEqual(['title'])
  const a=await command({kind:'grant.apply',appId,reviewId:human.body.id}),b=await tool({kind:'grant.apply',appId,reviewId:brian.value.id})
  expect(a.status).not.toBe(200);expect(b.reply.isError).toBe(true);expect(a.body.error).toBe(b.value.error)
 })
 it('M02 validates the actor again when applying a saved review after native administration is withdrawn',async()=>{
  const review=await command({kind:'grant.review',appId,input:grant()});expect(review.status).toBe(200)
  await owner.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,actorId])
  try {expect((await command({kind:'grant.apply',appId,reviewId:review.body.id})).status).toBe(403);const denied=await rpc('tools/call',{name:'applicationManage',arguments:{command:{kind:'grant.apply',appId,reviewId:review.body.id}}});expect(denied.status).toBe(403)}
  finally {await owner.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,actorId])}
 })
 it('M02 human and Brian revocations use the same canonical audit and stay idempotent',async()=>{
  const ids:string[]=[randomUUID(),randomUUID()]
  for(const id of ids)await owner.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance)
   VALUES($1,$2,$3,'member',$4,$4,$5,'request',ARRAY['read'],ARRAY['title'],'{}',$6,'{}','{}','internal')`,[id,appId,workspaceId,actorId,{kind:'generic',entityTypeId:schemaId},{kind:'ids',ids:[recordId]}])
  const revoked=await command({kind:'grant.revoke',appId,grantId:ids[0]});expect(revoked.body.revoked,JSON.stringify(revoked.body)).toBe(true)
  expect((await tool({kind:'grant.revoke',appId,grantId:ids[1]})).value).toMatchObject({effect:'committed',retrySafe:false});expect((await owner.query("SELECT status FROM application_access_grants WHERE id=$1",[ids[1]])).rows[0].status).toBe('revoked')
  const current=await overview(appId);expect(current.grants.filter((grant:{id:string;status:string})=>ids.includes(grant.id)&&grant.status==='revoked')).toHaveLength(2);expect((await tool({kind:'grant.revoke',appId,grantId:ids[1]})).value.revoked).toBe(false)
  expect((await command({kind:'grant.revoke',appId,grantId:ids[0]})).body.revoked).toBe(false)
  const audit=await owner.query("SELECT actor_user_id,resource_id FROM application_authority_events WHERE app_id=$1 AND action='grant_revoked' AND resource_id=ANY($2::uuid[])",[appId,ids])
  expect(audit.rows).toHaveLength(2);expect(audit.rows.every(row=>row.actor_user_id===actorId)).toBe(true)
 })
 it('M02 schema previews share canonical saved review authority and stale versions refuse',async()=>{
  const schema=(await createDbDocEntityStore({actorUserId:actorId}).getEntityType(workspaceId,schemaId))!
  const body={kind:'schema.preview',schemaId,input:{expectedVersion:schema.schemaVersion,properties:schema.properties}}
  const human=await command(body),brian=await tool(body)
  expect(human.status).toBe(200);expect(brian.reply.isError,JSON.stringify(brian)).not.toBe(true);expect(brian.value.proposed).toEqual(human.body.proposed)
  const result=await command({kind:'schema.apply',reviewId:human.body.id,input:{}});expect(result.status).toBe(200)
  expect((await command({kind:'schema.apply',reviewId:brian.value.id,input:{}})).status).not.toBe(200)
 })
 it('M03 Brian credential delivery is a safe human-only link and never invokes secret delivery',async()=>{
  const result=await tool({kind:'credential.deliver',appId,reviewId:randomUUID()})
  expect(result.reply.isError).not.toBe(true);expect(result.value.nativeDeliveryRequired).toBe(true)
  expect(result.value.link).toContain('/studio/programmatic-access?application=');expect(result.value).not.toHaveProperty('secret')
  expect(JSON.stringify(result)).not.toMatch(/sk_app_|BEGIN PRIVATE KEY|secretHash|encrypted_private_key/)
 })
 it('M03 invalid or expired human delivery never regenerates or replays a secret',async()=>{
  const reviewId=randomUUID()
  for(let n=0;n<2;n++){const response=await command({kind:'credential.deliver',appId,reviewId});expect(response.status).not.toBe(200);expect(response.body).not.toHaveProperty('secret')}
 })
 it('M03 consumed synthetic receipts return no previous secret and mint no replacement',async()=>{
  // Fixture bootstrap represents historical consumed state, not qualified issuance.
  // The actual native route, RLS, SQL apply function and qualification gate remain active.
  const grantId=randomUUID(),credentialId=randomUUID(),reviewId=randomUUID();
  const prepared=await command({kind:'service.prepare',appId,input:{name:'Fictional replay service',idempotencyKey:randomUUID()}});expect(prepared.status).toBe(200);const serviceUserId=prepared.body.serviceUserId;
  await owner.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance)
   VALUES($1,$2,$3,'service',$7,$4,$5,'request',ARRAY['read'],ARRAY['title'],'{}',$6,'{}','{}','internal')`,[grantId,appId,workspaceId,actorId,{kind:'generic',entityTypeId:schemaId},{kind:'ids',ids:[recordId]},serviceUserId]);
  const storedHash='scrypt$synthetic-unusable-fixture';
  await owner.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
   VALUES($1,$2,$3,$4,$7,'Fictional consumed credential','service',$5,$6,now()+interval '1 hour')`,[credentialId,appId,workspaceId,actorId,storedHash,grantId,serviceUserId]);
  await owner.query(`INSERT INTO application_credential_reviews(id,workspace_id,app_id,actor_user_id,proposal,authority_hash,consumed_credential_id)
   VALUES($1,$2,$3,$4,'{}',repeat('0',64),$5)`,[reviewId,workspaceId,appId,actorId,credentialId]);
  for(let attempt=0;attempt<2;attempt++){
   const reply=await command({kind:'credential.deliver',appId,reviewId});
   expect(reply.status).toBe(200);expect(reply.body).toEqual({credentialId,secretAvailable:false});
  }
  const denied=await command({kind:'credential.deliver',appId,reviewId},memberId);expect(denied.status).toBe(403);expect(denied.body).not.toHaveProperty('credentialId');
  const persisted=await owner.query('SELECT secret_hash FROM application_api_credentials WHERE id=$1',[credentialId]);expect(persisted.rows).toEqual([{secret_hash:storedHash}]);
  expect((await owner.query('SELECT count(*)::int AS count FROM application_api_credentials WHERE app_id=$1',[appId])).rows[0].count).toBe(1);
  expect((await owner.query("SELECT application_runtime_qualified($1,'application_data') AS qualified",[workspaceId])).rows[0].qualified).toBe(false);
 })
 it('M03 preparation creates a distinct named service without enrolling it as staff',async()=>{
  const key=randomUUID(),body={kind:'service.prepare',appId,input:{name:'Fictional service principal',idempotencyKey:key}},a=await command(body),b=await tool(body)
  expect(a.status).toBe(200);expect(b.value.serviceUserId).toBe(a.body.serviceUserId)
  expect((await owner.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,a.body.serviceUserId])).rows).toHaveLength(0)
 })
 it('M04 missing source capability and legacy repair are unavailable, never qualified empty success',async()=>{
  const response=await request(http).get(`${base}/management`).set('Authorization',`Bearer ${tokens.get(actorId)}`)
  expect(response.status).toBe(200);expect(response.body.sources).toMatchObject({state:'unavailable',items:[]})
  expect(response.body.readiness).toEqual({qualified:false,reason:'consumer_qualification_incomplete',legacyReview:'unavailable',canActivate:false})
  expect(JSON.stringify(response.body)).not.toMatch(/secret_hash|encrypted_private_key|privateKey/)
 })
 it('M06 native account loss clears authorization at the actual read endpoint',async()=>{
  await owner.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,actorId])
  try {expect((await request(http).get(`${base}/management`).set('Authorization',`Bearer ${tokens.get(actorId)}`)).status).toBe(403)}
  finally {await owner.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,actorId])}
 })
 it('M07 actual runtime qualification is false and suspended application activation refuses',async()=>{
  expect((await owner.query("SELECT application_runtime_qualified($1,'application_data') AS ready",[workspaceId])).rows[0].ready).toBe(false)
  expect((await command({kind:'status',appId,status:'suspended'})).status).toBe(200)
  const human=await command({kind:'status',appId,status:'active'}),brian=await tool({kind:'status',appId,status:'active'})
  expect(human.status).toBe(409);expect(human.body.error).toBe('operation_not_available');expect(brian.value.error).toBe(human.body.error)
 })
})
