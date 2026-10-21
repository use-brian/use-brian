import type {PoolClient} from 'pg'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {createKnowledgeTools,type ToolContext} from '@use-brian/core'
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
describe.sequential('[COMP:api/application-persistence] actual derived manual Knowledge creation',()=>{
 let saved:Fixture|undefined,policy:Policy|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);try{await policy?.cleanup()}finally{policy=undefined;await saved?.cleanup();saved=undefined}})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 const rule={id:'fictional-manual-rule',name:'Fictional manual capture',instructions:'Save the approved fictional Knowledge entry',targetSourceId:null,targetLabel:'Manual entries',pathPrefix:'',defaultSensitivity:'internal' as const}
 const tools=createKnowledgeTools(store,{allowWrites:true,captureRules:[rule]})
 const reader=tools.find(tool=>tool.name==='readKnowledgeEntry')!,creator=tools.find(tool=>tool.name==='addKnowledgeEntry')!
 async function setup(){saved=await retainedKnowledgeFixture();configureConnectorSourceRuntimeFactory(saved.source.factory,{instances:saved.source.instances});return saved}
 async function consumed(c:Fixture,userId=c.f.ownerId){const context=await c.context(userId,true),result=await reader.execute({id:c.row.id},context);expect(result.isError).not.toBe(true);expect(result.data).toMatchObject({content:c.row.content});if(!result.scopeEvidence?.sources?.length)throw new Error('Actual source Knowledge read must carry complete observations');context.scopeAccumulator.note(result.scopeEvidence);return context}
 const input=(path:string)=>({path,title:'Fictional derived manual entry',content:'Fictional derived manual bytes',captureRuleId:rule.id})
 async function rows(c:Fixture,path:string){return(await c.f.pool.query('SELECT id FROM knowledge_entries WHERE workspace_id=$1 AND path=$2',[c.f.workspaceId,path])).rows}
 it('persists every exact source and field observation through the actual manual create and independently holds the resulting row after withdrawal',async()=>{
  const c=await setup(),context=await consumed(c),sources=context.scopeAccumulator.evidence.sources!,path='fictional-derived-create'
  const result=await creator.execute(input(path),context);expect(result.isError,JSON.stringify(result)).not.toBe(true)
  const [row]=await rows(c,path);expect(row).toBeDefined()
  const edges=(await c.f.pool.query(`SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id AND s.workspace_id=d.workspace_id WHERE d.workspace_id=$1 AND d.resource_kind='knowledge_entry' AND d.resource_id=$2`,[c.f.workspaceId,row.id])).rows
  expect(edges.map(edge=>[edge.source_kind,edge.source_id,edge.source_version].join(':')).sort()).toEqual([...new Set(sources.map(source=>[source.resourceKind,source.resourceId,source.version].join(':')))].sort())
  expect(result.scopeEvidence?.sources?.some(source=>source.resourceKind==='knowledge_entry'&&source.resourceId===row.id)).toBe(true)
  const before=await c.snapshot();await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  const held=await reader.execute({id:row.id},await c.context(c.f.ownerId,true));expect(held.isError).toBe(true);expect(JSON.stringify(held)).not.toContain(input(path).content)
  const current=await reader.execute({id:row.id},await c.context(c.f.secondId,true));expect(current.isError,JSON.stringify(current)).not.toBe(true);expect(current.data).toMatchObject({content:input(path).content});expect(await c.snapshot()).toEqual(before)
 })
 it('refuses a withdrawn source before the actual insert and keeps a separately authorized writer usable',async()=>{
  const c=await setup(),first=await consumed(c),second=await consumed(c,c.f.secondId),before=await c.snapshot()
  await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  const held=await creator.execute(input('fictional-withdrawn-create'),first);expect(held.isError,JSON.stringify(held)).toBe(true);expect(await rows(c,'fictional-withdrawn-create')).toEqual([])
  const current=await creator.execute(input('fictional-current-create'),second);expect(current.isError,JSON.stringify(current)).not.toBe(true);expect(await rows(c,'fictional-current-create')).toHaveLength(1);expect(await c.snapshot()).toEqual(before)
 })
 it('refuses a consumed field whose actual role was withdrawn before the manual write',async()=>{
  const c=await setup();policy=await knowledgeFieldPolicyFixture(c.f);const first=await consumed(c),second=await consumed(c,c.f.secondId)
  await policy.revoke(c.f.ownerId,'body_reader')
  const held=await creator.execute(input('fictional-field-held-create'),first);expect(held.isError,JSON.stringify(held)).toBe(true);expect(await rows(c,'fictional-field-held-create')).toEqual([])
  const originalSecond=structuredClone(second.scopeAccumulator.evidence),freshSecond=await c.context(c.f.secondId,true);freshSecond.scopeAccumulator.note(originalSecond)
  const current=await creator.execute(input('fictional-field-current-create'),freshSecond);expect(current.isError,JSON.stringify(current)).not.toBe(true);expect(await rows(c,'fictional-field-current-create')).toHaveLength(1)
 })
 it('does not turn copied consumed evidence without the original execution into an authored root',async()=>{
  const c=await setup(),original=await consumed(c),missing:ToolContext={...original,executionContext:undefined}
  const result=await creator.execute(input('fictional-missing-host-create'),missing);expect(result.isError,JSON.stringify(result)).toBe(true);expect(await rows(c,'fictional-missing-host-create')).toEqual([])
 })
 it('preserves uncertain publication after actual post-commit contraction and never claims that the committed row was not saved',async()=>{
  const c=await setup();policy=await knowledgeFieldPolicyFixture(c.f);const context=await consumed(c),path='fictional-post-commit-create'
  let revoked=0;const queries=new Map<PoolClient,PoolClient['query']>(),written=new WeakSet<PoolClient>()
  const trace=(client:PoolClient)=>{
   if(queries.has(client))return
   const original=client.query;queries.set(client,original)
   client.query=function(...args:unknown[]){
    const sql=typeof args[0]==='string'?args[0]:''
    if(sql.includes('INSERT INTO knowledge_entries'))written.add(client)
    const result=Reflect.apply(original,client,args)
    if(sql==='COMMIT'&&written.has(client)){written.delete(client);return Promise.resolve(result).then(async value=>{revoked++;await policy!.revoke(c.f.ownerId,'body_reader');return value})}
    return result
   } as typeof client.query
  }
  getAppPool().on('acquire',trace)
  let result
  try{result=await creator.execute(input(path),context)}finally{getAppPool().off('acquire',trace);for(const[client,query]of queries)client.query=query}
  expect(revoked).toBe(1);expect(result.isError).toBe(true);expect(await rows(c,path)).toHaveLength(1)
  expect(result.meta).toMatchObject({retrySafe:false,operationMayHaveExecuted:true})
  expect(JSON.stringify(result)).not.toMatch(/Nothing was saved|did not run/)
  expect(JSON.stringify(result)).not.toContain(input(path).content)
  const [row]=await rows(c,path),second=await reader.execute({id:row.id},await c.context(c.f.secondId,true))
  expect(second.isError,JSON.stringify(second)).not.toBe(true);expect(second.data).toMatchObject({content:input(path).content})
 })
})
