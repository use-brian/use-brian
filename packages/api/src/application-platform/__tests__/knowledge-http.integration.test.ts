import type {PoolClient} from 'pg'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import express from 'express'
import request from 'supertest'
import {brainRoutes} from '../../routes/brain.js'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {createDbEntitiesStore} from '../../db/entities-store.js'
import {createDbEntityLinksStore} from '../../db/entity-links-store.js'
import {createDbRetrievalStore} from '../../db/retrieval-store.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {retainedKnowledgeFixture} from './fixtures/retained-knowledge.js'
import {knowledgeFieldPolicyFixture} from './fixtures/knowledge-field-policy.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const secret='fictional-native-brain-knowledge-secret',store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof retainedKnowledgeFixture>>
type Policy=Awaited<ReturnType<typeof knowledgeFieldPolicyFixture>>
describe.sequential('[COMP:api/application-persistence] [COMP:brain/knowledge-detail-http] actual native Brain Knowledge HTTP',()=>{
 let c:Fixture|undefined,policy:Policy|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);try{await policy?.cleanup()}finally{policy=undefined;await c?.cleanup();c=undefined}})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  c=await retainedKnowledgeFixture();const f=c
  configureConnectorSourceRuntimeFactory(f.source.factory,{instances:f.source.instances})
  const links=createDbEntityLinksStore(),app=express();app.use(express.json())
  app.use('/brain',requireAuth(secret),brainRoutes({entitiesStore:createDbEntitiesStore({entityLinks:links}),entityLinksStore:links,retrievalStore:createDbRetrievalStore(),knowledgeStore:store}))
  async function device(userId:string){
   const auth=await authSessionStore.create(userId,{deviceLabel:'Fictional Knowledge HTTP device',userAgent:null,ipAddress:null})
   if(!auth)throw new Error('Actual native device required')
   return{auth,token:createTokens(userId,secret,auth).accessToken}
  }
  const first=await device(f.f.ownerId),second=await device(f.f.secondId)
  const read=(token=first.token,assistantId?:string,id=f.row.id)=>request(app).get('/brain/knowledge/'+id+'?'+new URLSearchParams({workspaceId:f.f.workspaceId,...(assistantId?{assistantId}:{})})).set('Authorization','Bearer '+token)
  return{f,app,device,first,second,read}
 }
 it('uses actual native credentials for retained detail, holds one withdrawn source reader and keeps the independent reader usable without creating chats',async()=>{
  const {f,first,second,read}=await setup(),before=await f.snapshot(),sessions=(await f.f.pool.query('SELECT id FROM sessions WHERE workspace_id=$1 ORDER BY id',[f.f.workspaceId])).rows
  const initial=await read();expect(initial.status,JSON.stringify(initial.body)).toBe(200)
  expect(initial.body).toMatchObject({id:f.row.id,content:f.row.content});expect(initial.headers['cache-control']).toBe('no-store')
  await f.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.f.ownerId])
  const held=await read(first.token);expect(held.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(held.body)).not.toContain(f.row.content)
  const current=await read(second.token);expect(current.status,JSON.stringify(current.body)).toBe(200);expect(current.body.content).toBe(f.row.content)
  expect(await f.snapshot()).toEqual(before);expect((await f.f.pool.query('SELECT id FROM sessions WHERE workspace_id=$1 ORDER BY id',[f.f.workspaceId])).rows).toEqual(sessions)
 })
 it('enforces actual native field roles on HTTP bodies and retains a second currently authorized reader',async()=>{
  const {f,second,read}=await setup();policy=await knowledgeFieldPolicyFixture(f.f)
  expect((await read()).status).toBe(200)
  await policy.revoke(f.f.ownerId,'body_reader')
  const held=await read();expect(held.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(held.body)).not.toContain(f.row.content)
  const current=await read(second.token);expect(current.status,JSON.stringify(current.body)).toBe(200);expect(current.body.content).toBe(f.row.content)
 })
 it('rechecks the original native device after real point capture before HTTP exposure',async()=>{
  const {f,first,device,read}=await setup();expect((await read()).status).toBe(200)
  let captures=0;const queries=new Map<PoolClient,PoolClient['query']>()
  const trace=(client:PoolClient)=>{
   if(queries.has(client))return
   const original=client.query;queries.set(client,original)
   client.query=function(...args:unknown[]){
    const result=Reflect.apply(original,client,args)
    if(typeof args[0]==='string'&&args[0].includes('SELECT read_native_knowledge_point_projection'))return Promise.resolve(result).then(async rows=>{
     captures++;expect(await authSessionStore.revokeForUser(f.f.ownerId,first.auth.id)).toBe(true);return rows
    })
    return result
   } as typeof client.query
  }
  getAppPool().on('acquire',trace)
  try{const held=await read();expect(captures).toBe(1);expect(held.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(held.body)).not.toContain(f.row.content)}
  finally{getAppPool().off('acquire',trace);for(const[client,query]of queries)client.query=query}
  const other=await device(f.f.ownerId),current=await read(other.token)
  expect(current.status,JSON.stringify(current.body)).toBe(200);expect(current.body.content).toBe(f.row.content)
 })
 it('keeps a selected lower viewpoint as a deny-only cap on the real primary invocation',async()=>{
  const {f,read}=await setup(),selected=crypto.randomUUID()
  await f.f.pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional public viewpoint',$2,$3,'standard','public')",[selected,f.f.ownerId,f.f.workspaceId])
  const held=await read(undefined,selected);expect(held.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(held.body)).not.toContain(f.row.content)
  const current=await read();expect(current.status,JSON.stringify(current.body)).toBe(200);expect(current.body.content).toBe(f.row.content)
  const ordinary=await store.create({workspaceId:f.f.workspaceId,path:'fictional-public-point',title:'Fictional public body',content:'Fictional public Knowledge bytes',sensitivity:'public',createdBy:f.f.ownerId})
  const allowed=await read(undefined,selected,ordinary.id);expect(allowed.status,JSON.stringify(allowed.body)).toBe(200);expect(allowed.body.content).toBe(ordinary.content)
 })
 it('preserves the original body, native navigation and source-provenance projection through actual authenticated SQL',async()=>{
  const {f,read}=await setup(),source=await store.createSource({workspaceId:f.f.workspaceId,sourceType:'local',repo:'/srv/fictional-knowledge',branch:'local',rootPath:''})
  const entry=await store.create({workspaceId:f.f.workspaceId,path:'features/fictional-identity.md',title:'Fictional identity guide',summary:'Fictional identity summary',
   content:'# Fictional identity guide\n\nFictional long-form body',tags:['identity','merge'],sensitivity:'confidential',metadata:{url:'notes-app://open/fictional-note'},sourceId:source.id,sourceSha:'fictional-sha',createdBy:f.f.ownerId})
  const response=await read(undefined,undefined,entry.id);expect(response.status,JSON.stringify(response.body)).toBe(200)
  expect(response.body).toMatchObject({id:entry.id,path:entry.path,title:entry.title,summary:entry.summary,content:entry.content,tags:entry.tags,sensitivity:'confidential',sourceId:source.id,sourceSha:'fictional-sha',
   navigationUrl:'notes-app://open/fictional-note',source:{id:source.id,sourceType:'local',repo:'/srv/fictional-knowledge',branch:'local',rootPath:''}})
 })
 it('preserves the original foreign-workspace 404 through real RLS rather than a forged store row',async()=>{
  const {read}=await setup(),other=await persistentContextFixture()
  try{
   const entry=await store.create({workspaceId:other.workspaceId,path:'fictional-foreign',title:'Fictional foreign point',content:'Fictional foreign bytes',sensitivity:'public',createdBy:other.ownerId})
   const response=await read(undefined,undefined,entry.id);expect(response.status).toBe(404);expect(JSON.stringify(response.body)).not.toContain(entry.content)
  }finally{await other.cleanup()}
 })
 it('preserves the original nonmember 404 without any native point payload capture',async()=>{
  const {f,read,device}=await setup(),outsider=crypto.randomUUID()
  await f.f.pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[outsider])
  let captures=0;const queries=new Map<PoolClient,PoolClient['query']>()
  const trace=(client:PoolClient)=>{
   if(queries.has(client))return
   const original=client.query;queries.set(client,original)
   client.query=function(...args:unknown[]){if(typeof args[0]==='string'&&args[0].includes('read_native_knowledge_point_projection'))captures++;return Reflect.apply(original,client,args)} as typeof client.query
  }
  try{
   const credential=await device(outsider);getAppPool().on('acquire',trace)
   const response=await read(credential.token);expect(response.status).toBe(404);expect(captures).toBe(0);expect(JSON.stringify(response.body)).not.toContain(f.row.content)
  }finally{getAppPool().off('acquire',trace);for(const[client,query]of queries)client.query=query;await f.f.pool.query('DELETE FROM users WHERE id=$1',[outsider])}
 })
 it('holds when the actual primary authority is unavailable and never substitutes a different assistant',async()=>{
  const {f,read}=await setup();expect((await read()).status).toBe(200)
  await f.f.pool.query("UPDATE assistants SET kind='standard' WHERE id=$1",[f.f.assistantId])
  try{const held=await read();expect(held.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(held.body)).not.toContain(f.row.content)}
  finally{await f.f.pool.query("UPDATE assistants SET kind='primary' WHERE id=$1",[f.f.assistantId])}
  expect((await read()).status).toBe(200)
 })
 it('holds related-query uncertainty instead of silently delivering a false empty relation',async()=>{
  const {f,read}=await setup()
  const target=await store.create({workspaceId:f.f.workspaceId,path:'fictional-related-http-target',title:'Fictional related HTTP target',content:'Fictional related HTTP bytes',sensitivity:'internal',createdBy:f.f.ownerId})
  const parent=await store.create({workspaceId:f.f.workspaceId,path:'fictional-related-http-parent',title:'Fictional related HTTP parent',content:'Fictional parent HTTP bytes',sensitivity:'internal',createdBy:f.f.ownerId})
  await f.f.pool.query('UPDATE knowledge_entries SET related_ids=ARRAY[$2::uuid] WHERE id=$1',[parent.id,target.id])
  const initial=await read(undefined,undefined,parent.id)
  expect(initial.status,JSON.stringify(initial.body)).toBe(200);expect(initial.body.related).toEqual([{id:target.id,title:target.title,path:target.path}])
  // The actual query domain includes a retained candidate whose current
  // independent source connection is now unavailable. It cannot certify absence.
  await f.f.pool.query("UPDATE connector_instance SET connected=false WHERE workspace_id=$1",[f.f.workspaceId])
  try{
   const held=await read(undefined,undefined,parent.id);expect(held.status).toBeGreaterThanOrEqual(400)
   expect(JSON.stringify(held.body)).not.toContain(parent.content)
  }finally{await f.f.pool.query("UPDATE connector_instance SET connected=true WHERE workspace_id=$1",[f.f.workspaceId])}
  const current=await read(undefined,undefined,parent.id)
  expect(current.status,JSON.stringify(current.body)).toBe(200);expect(current.body.related).toEqual(initial.body.related)
 })
 it('rechecks actual current membership on the next HTTP request and keeps another current reader usable',async()=>{
  const {f,second,read}=await setup();expect((await read(second.token)).status).toBe(200)
  const before=await f.snapshot()
  await f.f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.f.workspaceId,f.f.secondId])
  const held=await read(second.token);expect(held.status).toBe(404);expect(JSON.stringify(held.body)).not.toContain(f.row.content)
  const current=await read();expect(current.status,JSON.stringify(current.body)).toBe(200);expect(current.body.content).toBe(f.row.content);expect(await f.snapshot()).toEqual(before)
 })
 it('holds unavailable source provenance instead of delivering a false missing-source card',async()=>{
  const {f,read}=await setup(),source=await store.createSource({workspaceId:f.f.workspaceId,sourceType:'local',repo:'/srv/fictional-provenance',branch:'local'})
  const entry=await store.create({workspaceId:f.f.workspaceId,path:'fictional-source-card',title:'Fictional source card',content:'Fictional source-card bytes',sensitivity:'internal',sourceId:source.id,createdBy:f.f.ownerId})
  const initial=await read(undefined,undefined,entry.id);expect(initial.status,JSON.stringify(initial.body)).toBe(200);expect(initial.body.source.id).toBe(source.id)
  await f.f.pool.query('ALTER TABLE workspace_knowledge_sources RENAME TO r3_knowledge_http_sources_held')
  try{const held=await read(undefined,undefined,entry.id);expect(held.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(held.body)).not.toContain(entry.content)}
  finally{await f.f.pool.query('ALTER TABLE r3_knowledge_http_sources_held RENAME TO workspace_knowledge_sources')}
  const current=await read(undefined,undefined,entry.id);expect(current.status,JSON.stringify(current.body)).toBe(200);expect(current.body.source).toEqual(initial.body.source)
 })
})
