import {afterAll,afterEach,describe,expect,it} from 'vitest'
import express from 'express'
import request from 'supertest'
import {boundScopeSources,type LLMProvider} from '@use-brian/core'
import {assertSourceModelInputAuthority} from '../model-source-authority.js'
import {generateTitle} from '../../routes/attended-session-title.js'
import {brainRoutes} from '../../routes/brain.js'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {getAppPool,getPool,applyRLSGucs,runWithAgentAccess} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {createDbEntitiesStore} from '../../db/entities-store.js'
import {createDbEntityLinksStore} from '../../db/entity-links-store.js'
import {createDbRetrievalStore} from '../../db/retrieval-store.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {retainedKnowledgeFixture} from './fixtures/retained-knowledge.js'
import {knowledgeSourcePolicyFixture} from './fixtures/knowledge-source-policy.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const secret='fictional-native-source-card-secret',store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof retainedKnowledgeFixture>>
type Policy=Awaited<ReturnType<typeof knowledgeSourcePolicyFixture>>
describe.sequential('[COMP:api/application-persistence] actual native Knowledge source-card fields',()=>{
 let c:Fixture|undefined,policy:Policy|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);try{await policy?.cleanup()}finally{policy=undefined;await c?.cleanup();c=undefined}})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(bound=true){
  c=await retainedKnowledgeFixture();const f=c
  configureConnectorSourceRuntimeFactory(f.source.factory,{instances:f.source.instances})
  if(bound){
   const team=await createDbWorkspaceGroupStore().createTeam(f.f.ownerId,f.f.workspaceId,{name:'Fictional source setup',key:'fictional-source-setup'})
   await f.f.pool.query("UPDATE workspace_access_policies SET access_mode='departments',setup_state='ready',default_department_id=$2 WHERE workspace_id=$1",[f.f.workspaceId,team.id])
  }
  const source=await store.createSource({workspaceId:f.f.workspaceId,sourceType:'local',repo:'/srv/fictional-protected-source',branch:'local',rootPath:'fictional',
   ...(bound?{binding:{sensitivity:'internal' as const,compartments:[],projectIds:[]}}:{})},bound?{actorUserId:f.f.ownerId}:undefined)
  const input={workspaceId:f.f.workspaceId,path:'fictional-source-projection',title:'Fictional source projection',content:'Fictional source projection body',sensitivity:'internal' as const,sourceId:source.id,sourceSha:'fictional-source-revision',compartments:[],projectIds:[],actorId:f.f.ownerId}
  const entry=await(async()=>{
   if(!bound)return store.create({...input,createdBy:f.f.ownerId})
   const authority=await store.captureSourceSync(source);if(!authority)throw new Error('Actual configured sync authority required')
   try{return await store.upsertByPath(input,authority)}finally{await store.releaseSourceSync(authority)}
  })()
  const app=express(),links=createDbEntityLinksStore();app.use(express.json());app.use('/brain',requireAuth(secret),brainRoutes({entitiesStore:createDbEntitiesStore({entityLinks:links}),entityLinksStore:links,retrievalStore:createDbRetrievalStore(),knowledgeStore:store}))
  const tokens=new Map<string,string>()
  for(const user of [f.f.ownerId,f.f.secondId]){
   const device=await authSessionStore.create(user,{deviceLabel:'Fictional source-card device',userAgent:null,ipAddress:null});if(!device)throw new Error('Actual source-card device required')
   tokens.set(user,createTokens(user,secret,device).accessToken)
  }
  const read=(user=f.f.ownerId)=>request(app).get('/brain/knowledge/'+entry.id+'?'+new URLSearchParams({workspaceId:f.f.workspaceId})).set('Authorization','Bearer '+tokens.get(user))
  const snapshot=async()=>(await f.f.pool.query("SELECT read_scope_source($1,'knowledge_source',$2) AS source",[f.f.workspaceId,source.id])).rows[0].source
  const mask=async(user:Fixture['f']['ownerId'])=>{
   const ctx=await f.context(user,true),client=await getAppPool().connect()
   try{return await runWithAgentAccess(ctx.executionContext!.security.access,async()=>{await client.query('BEGIN');await applyRLSGucs(client,user)
    const row=(await client.query<{mask:{readFields:string[]}|null}>("SELECT read_native_application_field_mask($1,'{\"kind\":\"native\",\"moduleKey\":\"native\"}','knowledge_source',$2,$3) AS mask",[f.f.workspaceId,source.id,source.bindingVersion])).rows[0].mask
    await client.query('COMMIT');return row})}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
  }
  return{f,source,entry,read,snapshot,mask}
 }
 it('enforces an actual source-location role contraction before native HTTP provenance and keeps an independent current reader usable',async()=>{
  const {f,source,entry,read,snapshot,mask}=await setup();policy=await knowledgeSourcePolicyFixture(f.f)
  expect((await mask(f.f.ownerId))?.readFields).toContain('repo');const initial=await read();expect(initial.status,JSON.stringify(initial.body)).toBe(200);expect(initial.body.source.repo).toBe(source.repo)
  const before=await snapshot();await policy.revoke(f.f.ownerId)
  expect((await mask(f.f.ownerId))?.readFields).not.toContain('repo');expect((await mask(f.f.secondId))?.readFields).toContain('repo')
  const held=await read();expect(held.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(held.body)).not.toContain(source.repo);expect(JSON.stringify(held.body)).not.toContain(entry.content)
  const current=await read(f.f.secondId);expect(current.status,JSON.stringify(current.body)).toBe(200);expect(current.body.source.repo).toBe(source.repo);expect(await snapshot()).toEqual(before)
 })
 it('holds malformed registered source-card policy metadata instead of falling back to raw source bytes',async()=>{
  const {f,source,entry,read,mask}=await setup();policy=await knowledgeSourcePolicyFixture(f.f)
  expect((await mask(f.f.ownerId))?.readFields).toContain('repo');expect((await read()).status).toBe(200)
  await policy.malformed();expect(await mask(f.f.ownerId)).toBeNull()
  const held=await read();expect(held.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(held.body)).not.toContain(source.repo);expect(JSON.stringify(held.body)).not.toContain(entry.content)
 })
 it('holds an unknown historical source binding rather than guessing native General source authority',async()=>{
  const {source,entry,read,snapshot}=await setup(false);expect(await snapshot()).toBeNull()
  const held=await read();expect(held.status).toBeGreaterThanOrEqual(400);expect(JSON.stringify(held.body)).not.toContain(source.repo);expect(JSON.stringify(held.body)).not.toContain(entry.content)
 })
 for(const change of ['source-location role','mutable sync metadata'] as const)it(`holds cached source-card fields before model extraction after ${change} while preserving a current independent reader`,async()=>{
  const {f,source,snapshot}=await setup();policy=await knowledgeSourcePolicyFixture(f.f)
  const first=await f.context(f.f.ownerId,true),projection=await store.getSourceForViewer(first.executionContext!.security.access,source.id,{execution:first.executionContext!,accumulator:first.scopeAccumulator})
  expect(projection?.repo).toBe(source.repo);if(!projection)throw new Error('Actual source-card projection required')
  const sources=boundScopeSources(projection)
  expect(sources.filter(source=>source.resourceKind==='knowledge_source')).toHaveLength(1)
  const fields=sources.filter(source=>source.resourceKind==='application_field');expect(fields).toHaveLength(1)
  expect((await f.f.pool.query(`SELECT resource_id,selection,fields FROM application_field_resources WHERE workspace_id=$1 AND id=$2`,[f.f.workspaceId,fields[0].resourceId])).rows)
   .toEqual([{resource_id:source.id,selection:'read',fields:['branch','id','lastSyncedAt','repo','rootPath','sourceType']}])
  const shared=await f.context(f.f.secondId,true);shared.scopeAccumulator.note({sources});await expect(assertSourceModelInputAuthority(shared)).resolves.toBeUndefined()
  const before=await snapshot()
  if(change==='source-location role')await policy.revoke(f.f.ownerId)
  else await f.f.pool.query('UPDATE workspace_knowledge_sources SET last_synced_at=clock_timestamp() WHERE id=$1',[source.id])
  expect(await snapshot()).toEqual(before)
  const replay=await f.context(f.f.ownerId,true);replay.scopeAccumulator.note({sources});let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-source-card',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},stream:async function*(){calls++;
   yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional source title'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  await expect(generateTitle(provider,[{role:'user',get content(){extractions++;return JSON.stringify(projection)}}],'fixture',()=>assertSourceModelInputAuthority(replay)))
   .rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
  const second=await f.context(f.f.secondId,true),current=change==='source-location role'?projection:await store.getSourceForViewer(second.executionContext!.security.access,source.id,{execution:second.executionContext!,accumulator:second.scopeAccumulator})
  expect(current?.repo).toBe(source.repo);if(!current)throw new Error('Independent current source-card projection required')
  if(change==='mutable sync metadata')expect(current.lastSyncedAt).toBeInstanceOf(Date)
  second.scopeAccumulator.note({sources:boundScopeSources(current)})
  await expect(generateTitle(provider,[{role:'user',content:JSON.stringify(current)}],'fixture',()=>assertSourceModelInputAuthority(second)))
   .resolves.toEqual({title:'Fictional source title',model:'fixture',usage:{inputTokens:2,outputTokens:2}})
  expect(calls).toBe(1)
 })
})
