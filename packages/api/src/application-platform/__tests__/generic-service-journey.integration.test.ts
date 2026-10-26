/** Supported management-issued service over arbitrary canonical generic schemas. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApplicationClient } from '@use-brian/brian-app/application'
import { createServiceTransport } from '@use-brian/brian-app/module'
import type { PropertyDef } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { ApplicationPlatformService } from '../service.js'
import { ApplicationManagementService } from '../management.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
import { applicationPlatformRoutes } from '../../routes/application-platform.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-management] [COMP:api/application-records] supported general record service', () => {
 const pool=getPool(), workspaceId=randomUUID(), ownerId=randomUUID(), memberId=randomUUID(), assistantId=randomUUID()
 const secret='fictional-generic-service-session', service=new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
 const management=new ApplicationManagementService(service), http=express(), tokens=new Map<string,string>(), serviceIds:string[]=[]
 http.use(express.json());http.use('/api/applications',applicationPlatformRoutes({service,management:{service:management,requireAuth:requireAuth(secret),origins:['https://host.example']}}))
 const server=http.listen(0,'127.0.0.1');let origin:string,appId:string,serviceUserId:string,typeId:string,typeKey:string
 const properties:PropertyDef[]=[{name:'title',config:{kind:'text'},required:true,unique:true},{name:'state',config:{kind:'select',options:[{id:'open',name:'Open'},{id:'closed',name:'Closed'}]}},{name:'quantity',config:{kind:'number',format:'int',minimum:1,maximum:100}}]
 const store=createDbDocEntityStore({actorUserId:ownerId}),base=`/api/applications/workspaces/${workspaceId}`
 beforeAll(async()=>{
  if(!server.listening)await once(server,'listening');origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  for(const id of [ownerId,memberId])await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional generic application',$2)",[workspaceId,ownerId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')",[workspaceId,ownerId,memberId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional record assistant',$2,$3,'primary','confidential')",[assistantId,ownerId,workspaceId])
  for(const id of [ownerId,memberId]){const session=await authSessionStore.create(id,{deviceLabel:'Fictional native browser',userAgent:'Fixture',ipAddress:'127.0.0.1'});tokens.set(id,createTokens(id,secret,session!).accessToken)}
  const schema=await store.createEntityType({workspaceId,name:'Fictional work register',properties,createdBy:ownerId});typeId=schema.id;typeKey=`record.${typeId}`
 })
 afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,memberId,...serviceIds]]);await getAppPool().end();await pool.end()})
 const data=(title:string)=>({title:{kind:'text',value:title},state:{kind:'select',value:'open'},quantity:{kind:'number',value:2}})
 async function command(value:Record<string,unknown>,actor=ownerId){return request(http).post(`${base}/management/commands`).set('Authorization',`Bearer ${tokens.get(actor)}`).set('Origin','https://host.example').send(value)}
 async function checked(value:Record<string,unknown>){const result=await command(value);if(result.status===503)await management.executeCommand(ownerId,workspaceId,value);expect(result.status,JSON.stringify(result.body)).toBe(200);return result.body}
 const client=(token:string)=>createApplicationClient({appId,transport:createServiceTransport({apiOrigin:origin,credential:async()=>({kind:'service',token})})})
 function proposal(extra:Record<string,unknown>={}){return {principal:{kind:'service',userId:serviceUserId},origin:{kind:'generic',entityTypeId:typeId},typeKey,actions:['read','query','history','schema','create','patch','delete','command:record_create','command:record_patch','command:record_delete','command:record_batch'],readFields:['title','state','quantity'],writeFields:['title','state','quantity'],selector:{kind:'self'},parentGrantId:null,expiresAt:null,compartments:[],projectIds:[],clearance:'internal',...extra}}
 async function issue(grantIds:string[]){const review=await checked({kind:'credential.review',appId,input:{name:'Fictional record key',kind:'service',serviceUserId,grantIds,expiresAt:new Date(Date.now()+3600_000).toISOString()}});expect(review.canIssue).toBe(true);return checked({kind:'credential.deliver',appId,reviewId:review.id})}
 async function setup(){
  appId=(await checked({kind:'register',input:{moduleKey:'records',name:'Fictional general records',mode:'api_client',origins:[],redirectUris:[]}})).id
  serviceUserId=(await checked({kind:'service.prepare',appId,input:{name:'Fictional records service',idempotencyKey:randomUUID()}})).serviceUserId;serviceIds.push(serviceUserId)
  const before=await checked({kind:'grant.review',appId,input:proposal()});expect(before.canIssue).toBe(false)
  const review=await checked({kind:'activation.review',appId});expect(review.profile).toBe('canonical_records_service_v1')
  expect((await command({kind:'activation.apply',appId,reviewId:review.id},memberId)).status).toBe(403)
  await checked({kind:'activation.apply',appId,reviewId:review.id})
  const grant=await checked({kind:'grant.review',appId,input:proposal()});expect(grant.canIssue).toBe(true)
  const applied=await checked({kind:'grant.apply',appId,reviewId:grant.id}),credential=await issue([applied.grantId])
  return {sdk:client(credential.secret),credential,grantId:applied.grantId}
 }
 it('activates arbitrary declared schemas and performs canonical CRUD, history, import rollback and replay through HTTP SDK',async()=>{
  const {sdk}=await setup()
  expect((await pool.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,serviceUserId])).rowCount).toBe(0)
  const key=randomUUID(),create={idempotencyKey:key,input:{operation:'create',type:typeKey,data:data('Initial')}}
  const created=await sdk.command('record_create',create),id=created.resources[0].id
  expect((await sdk.command('record_create',create)).id).toBe(created.id)
  expect(await sdk.get(typeKey,id)).toMatchObject({ref:{id,version:'1'},values:{title:{value:'Initial'}}})
  const changed=await sdk.command('record_patch',{idempotencyKey:randomUUID(),expectedVersion:'1',input:{operation:'patch',type:typeKey,id,data:{state:{kind:'select',value:'closed'}}}})
  expect(changed.resources[0].version).toBe('2')
  expect(await sdk.query(typeKey,{fields:['title','state'],filters:[{field:'state',op:'eq',value:'closed'}],sort:[],aggregate:[],limit:10})).toMatchObject({records:[{ref:{id}}]})
  const history=await sdk.history(typeKey,id) as Array<{ref:{version:string}}>
  expect(history.map(row=>row.ref.version)).toEqual(['2','1'])
  for(const invalid of [{}, {...data('Invalid'),state:{kind:'select',value:'unknown'}}, {...data('Invalid'),quantity:{kind:'number',value:0}}, {...data('Invalid'),hidden:{kind:'text',value:'refuse'}}]){
   await expect(sdk.command('record_create',{idempotencyKey:randomUUID(),input:{operation:'create',type:typeKey,data:invalid}})).rejects.toBeDefined()
  }
  const before=(await pool.query('SELECT count(*)::int AS count FROM application_operation_receipts WHERE application_client_id=$1',[appId])).rows[0].count
  await expect(sdk.command('record_batch',{idempotencyKey:randomUUID(),input:{operations:[{operation:'create',type:typeKey,data:data('Rollback')},{operation:'create',type:typeKey,data:{}}]}})).rejects.toBeDefined()
  expect((await pool.query('SELECT count(*)::int AS count FROM application_operation_receipts WHERE application_client_id=$1',[appId])).rows[0].count).toBe(before)
  expect((await pool.query("SELECT count(*)::int AS count FROM entity_instances WHERE entity_type_id=$1 AND data->'title'->>'value'='Rollback'",[typeId])).rows[0].count).toBe(0)
  const batch=await sdk.command('record_batch',{idempotencyKey:randomUUID(),input:{operations:[{operation:'create',type:typeKey,data:data('Imported one')},{operation:'create',type:typeKey,data:data('Imported two')}]}})
  expect(batch.resources).toHaveLength(2)
  const deleted=await sdk.command('record_delete',{idempotencyKey:randomUUID(),expectedVersion:'2',input:{operation:'delete',type:typeKey,id}})
  expect(deleted.resources[0].id).toBe(id);await expect(sdk.get(typeKey,id)).rejects.toBeDefined()
 },60_000)
 it('keeps actual schema review validation and concurrent unique/CAS outcomes at canonical boundaries',async()=>{
  const {sdk}=await setup()
  const bad=await checked({kind:'schema.preview',schemaId:typeId,input:{expectedVersion:1,properties:[]}})
  expect(bad.canApply).toBe(false)
  const unique=await Promise.allSettled([' Concurrent ','concurrent'].map(title=>sdk.command('record_create',{idempotencyKey:randomUUID(),input:{operation:'create',type:typeKey,data:data(title)}})))
  expect(unique.filter(v=>v.status==='fulfilled')).toHaveLength(1)
  const record=unique.find(v=>v.status==='fulfilled');if(record?.status!=='fulfilled')throw new Error('No unique winner')
  const id=record.value.resources[0].id
  const cas=await Promise.allSettled(['First change','Second change'].map(title=>sdk.command('record_patch',{idempotencyKey:randomUUID(),expectedVersion:'1',input:{operation:'patch',type:typeKey,id,data:{title:{kind:'text',value:title}}}})))
  expect(cas.filter(v=>v.status==='fulfilled')).toHaveLength(1)
  expect(cas.filter(v=>v.status==='rejected')).toHaveLength(1)
  expect(await sdk.get(typeKey,id)).toMatchObject({ref:{version:'2'}})
 },60_000)
 it('denies widened fields/types/client modes and invalidates credentials on current grant and activation contraction',async()=>{
  const {sdk,credential,grantId}=await setup()
  const created=await sdk.command('record_create',{idempotencyKey:randomUUID(),input:{operation:'create',type:typeKey,data:data('Revocation record')}})
  for(const extra of [{principal:{kind:'member',userId:memberId}},{readFields:['title','not-declared']},{actions:['read','command:create_company']},{typeKey:'foreign.records'}]){
   const result=await command({kind:'grant.review',appId,input:proposal(extra)})
   if(result.status===200){expect(result.body.canIssue).toBe(false);expect((await command({kind:'grant.apply',appId,reviewId:result.body.id})).status).not.toBe(200)}else expect([400,403,409]).toContain(result.status)
  }
  await checked({kind:'grant.revoke',appId,grantId});await expect(sdk.get(typeKey,created.resources[0].id)).rejects.toBeDefined()
  await checked({kind:'activation.revoke',appId});await expect(client(credential.secret).catalog()).rejects.toBeDefined()
  const review=await checked({kind:'activation.review',appId});await checked({kind:'activation.apply',appId,reviewId:review.id});await expect(client(credential.secret).catalog()).rejects.toBeDefined()
  expect((await pool.query("SELECT application_runtime_qualified($1,'application_data') AS qualified",[workspaceId])).rows[0].qualified).toBe(false)
 },60_000)
})
