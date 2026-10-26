import type {PoolClient} from 'pg'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {createKnowledgeTools} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {retainedKnowledgeFixture} from './fixtures/retained-knowledge.js'
import {knowledgeFieldPolicyFixture} from './fixtures/knowledge-field-policy.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof retainedKnowledgeFixture>>
type Policy=Awaited<ReturnType<typeof knowledgeFieldPolicyFixture>>
describe.sequential('[COMP:api/application-persistence] actual native Knowledge destination write fields',()=>{
 let c:Fixture|undefined,policy:Policy|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);try{await policy?.cleanup()}finally{policy=undefined;await c?.cleanup();c=undefined}})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it('refuses a withdrawn destination write field before INSERT under a fresh original lease while preserving a separately authorized writer and original observations',async()=>{
  c=await retainedKnowledgeFixture();const f=c;configureConnectorSourceRuntimeFactory(f.source.factory,{instances:f.source.instances})
  policy=await knowledgeFieldPolicyFixture(f.f,{requireBodyWriter:true});await policy.grant(f.f.ownerId,'body_writer');await policy.grant(f.f.secondId,'body_writer')
  const rule={id:'fictional-write-fields-rule',name:'Fictional typed capture',instructions:'Save the approved fictional entry',targetSourceId:null,targetLabel:'Manual entries',pathPrefix:'',defaultSensitivity:'internal' as const}
  const tools=createKnowledgeTools(store,{allowWrites:true,captureRules:[rule]}),read=tools.find(t=>t.name==='readKnowledgeEntry')!,create=tools.find(t=>t.name==='addKnowledgeEntry')!
  async function consumed(userId:Fixture['f']['ownerId']){const context=await f.context(userId,true),result=await read.execute({id:f.row.id},context);expect(result.isError,JSON.stringify(result)).not.toBe(true);expect(result.data).toMatchObject({content:f.row.content});if(!result.scopeEvidence?.sources?.length)throw new Error('Actual read observations required');context.scopeAccumulator.note(result.scopeEvidence);return context}
  const first=await consumed(f.f.ownerId),other=await consumed(f.f.secondId),original=structuredClone(first.scopeAccumulator.evidence),otherOriginal=structuredClone(other.scopeAccumulator.evidence),before=await f.snapshot()
  await policy.revoke(f.f.ownerId,'body_writer')
  const denied=await f.context(f.f.ownerId,true);denied.scopeAccumulator.note(original)
  const stillReadable=await read.execute({id:f.row.id},await f.context(f.f.ownerId,true));expect(stillReadable.isError).not.toBe(true);expect(stillReadable.data).toMatchObject({content:f.row.content})
  let inserts=0;const queries=new Map<PoolClient,PoolClient['query']>()
  const trace=(client:PoolClient)=>{if(queries.has(client))return;const old=client.query;queries.set(client,old);client.query=function(...args:unknown[]){if(typeof args[0]==='string'&&args[0].includes('INSERT INTO knowledge_entries'))inserts++;return Reflect.apply(old,client,args)} as typeof client.query}
  const input=(path:string)=>({path,title:'Fictional field-controlled create',content:'Fictional destination bytes',captureRuleId:rule.id})
  getAppPool().on('acquire',trace)
  let result
  try{result=await create.execute(input('fictional-write-field-held'),denied)}finally{getAppPool().off('acquire',trace);for(const[client,query]of queries)client.query=query}
  expect(result.isError,JSON.stringify(result)).toBe(true);expect(inserts).toBe(0)
  expect((await f.f.pool.query('SELECT id FROM knowledge_entries WHERE workspace_id=$1 AND path=$2',[f.f.workspaceId,'fictional-write-field-held'])).rows).toEqual([])
  const current=await f.context(f.f.secondId,true);current.scopeAccumulator.note(otherOriginal)
  const success=await create.execute(input('fictional-write-field-current'),current);expect(success.isError,JSON.stringify(success)).not.toBe(true)
  expect((await f.f.pool.query('SELECT id FROM knowledge_entries WHERE workspace_id=$1 AND path=$2',[f.f.workspaceId,'fictional-write-field-current'])).rows).toHaveLength(1)
  expect(await f.snapshot()).toEqual(before)
 })
 const rule={id:'fictional-write-intent-rule',name:'Fictional native write intent',instructions:'Save the approved fictional entry',targetSourceId:null,targetLabel:'Manual entries',pathPrefix:'',defaultSensitivity:'internal' as const}
 const tools=createKnowledgeTools(store,{allowWrites:true,captureRules:[rule]}),read=tools.find(t=>t.name==='readKnowledgeEntry')!,create=tools.find(t=>t.name==='addKnowledgeEntry')!
 const input=(path:string)=>({path,title:'Fictional destination field intent',content:'Fictional destination bytes',captureRuleId:rule.id})
 async function consumed(f:Fixture,userId:Fixture['f']['ownerId']){const context=await f.context(userId,true),result=await read.execute({id:f.row.id},context);expect(result.isError,JSON.stringify(result)).not.toBe(true);if(!result.scopeEvidence?.sources?.length)throw new Error('Actual input observations required');context.scopeAccumulator.note(result.scopeEvidence);return context}
 async function rows(f:Fixture,path:string){return(await f.f.pool.query('SELECT id FROM knowledge_entries WHERE workspace_id=$1 AND path=$2',[f.f.workspaceId,path])).rows}
 it('rolls back an actual INSERT when the new record has a stricter write mask than its catalog and preserves an independent writer',async()=>{
  c=await retainedKnowledgeFixture();const f=c;configureConnectorSourceRuntimeFactory(f.source.factory,{instances:f.source.instances})
  policy=await knowledgeFieldPolicyFixture(f.f);await policy.grant(f.f.secondId,'body_writer')
  const first=await consumed(f,f.f.ownerId),other=await consumed(f,f.f.secondId),before=await f.snapshot()
  let inserted=0;const queries=new Map<PoolClient,PoolClient['query']>()
  const trace=(client:PoolClient)=>{if(queries.has(client))return;const original=client.query;queries.set(client,original);client.query=function(...args:unknown[]){
   const result=Reflect.apply(original,client,args)
   if(typeof args[0]==='string'&&args[0].includes('INSERT INTO knowledge_entries'))return Promise.resolve(result).then(async value=>{
    inserted++;await policy!.protectWrite(value.rows[0].id,'content','body_writer');return value
   })
   return result
  } as typeof client.query}
  getAppPool().on('acquire',trace)
  try{
   const held=await create.execute(input('fictional-record-field-held'),first);expect(held.isError,JSON.stringify(held)).toBe(true);expect(inserted).toBe(1);expect(await rows(f,'fictional-record-field-held')).toEqual([])
   const success=await create.execute(input('fictional-record-field-current'),other);expect(success.isError,JSON.stringify(success)).not.toBe(true);expect(inserted).toBe(2);expect(await rows(f,'fictional-record-field-current')).toHaveLength(1)
  }finally{getAppPool().off('acquire',trace);for(const[client,query]of queries)client.query=query}
  expect(await f.snapshot()).toEqual(before)
 })
 it('checks an optional field when explicitly supplied, including an empty value, while preserving omitted-field creation and an authorized writer',async()=>{
  c=await retainedKnowledgeFixture();const f=c;configureConnectorSourceRuntimeFactory(f.source.factory,{instances:f.source.instances})
  policy=await knowledgeFieldPolicyFixture(f.f);await policy.protectCatalogWrite('tags','body_writer');await policy.grant(f.f.secondId,'body_writer')
  const first=await consumed(f,f.f.ownerId),other=await consumed(f,f.f.secondId),before=await f.snapshot()
  const success=await create.execute(input('fictional-omitted-optional'),first);expect(success.isError,JSON.stringify(success)).not.toBe(true);expect(await rows(f,'fictional-omitted-optional')).toHaveLength(1)
  const original=structuredClone(first.scopeAccumulator.evidence),fresh=await f.context(f.f.ownerId,true);fresh.scopeAccumulator.note(original)
  let inserted=0;const queries=new Map<PoolClient,PoolClient['query']>()
  const trace=(client:PoolClient)=>{if(queries.has(client))return;const old=client.query;queries.set(client,old);client.query=function(...args:unknown[]){if(typeof args[0]==='string'&&args[0].includes('INSERT INTO knowledge_entries'))inserted++;return Reflect.apply(old,client,args)} as typeof client.query}
  getAppPool().on('acquire',trace)
  try{const held=await create.execute({...input('fictional-explicit-empty-held'),tags:[]},fresh);expect(held.isError,JSON.stringify(held)).toBe(true);expect(inserted).toBe(0)}finally{getAppPool().off('acquire',trace);for(const[client,query]of queries)client.query=query}
  expect(await rows(f,'fictional-explicit-empty-held')).toEqual([])
  const current=await create.execute({...input('fictional-explicit-current'),tags:['fictional']},other);expect(current.isError,JSON.stringify(current)).not.toBe(true);expect(await rows(f,'fictional-explicit-current')).toHaveLength(1)
  expect(await f.snapshot()).toEqual(before)
 })
})
