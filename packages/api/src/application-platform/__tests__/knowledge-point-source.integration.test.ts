import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {createKnowledgeTools,type LLMProvider} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {assertSourceModelInputAuthority} from '../model-source-authority.js'
import {generateTitle} from '../../routes/attended-session-title.js'
import {retainedKnowledgeFixture} from './fixtures/retained-knowledge.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof retainedKnowledgeFixture>>
describe.sequential('[COMP:api/application-persistence] actual retained-source knowledge point reads',()=>{
 let saved:Fixture|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);await saved?.cleanup();saved=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function fixture(){saved=await retainedKnowledgeFixture();return saved}
 it('holds independently retained content at the actual ID point reader without original current source authority',async()=>{
  const c=await fixture(),context=await c.context()
  const tool=createKnowledgeTools(store).find(tool=>tool.name==='readKnowledgeEntry')!
  expect((await tool.execute({id:c.row.id},context)).data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  const actual=await store.getById(context.executionContext!.security.access,c.row.id)
  expect(actual).toBeNull()
 })
 it('rechecks an actual independent source grant before returning the Knowledge tool body and preserves a second reader and canonical metadata',async()=>{
  const c=await fixture(),first=await c.context(),second=await c.context(c.f.secondId)
  const tool=createKnowledgeTools(store).find(tool=>tool.name==='readKnowledgeEntry')!
  expect((await tool.execute({id:c.row.id},first)).data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  expect((await tool.execute({id:c.row.id},second)).data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  const before=await c.snapshot()
  await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  const refused=await tool.execute({id:c.row.id},first)
  expect(refused.isError).toBe(true)
  expect(JSON.stringify(refused)).not.toContain('Fictional protected Knowledge bytes')
  expect((await tool.execute({id:c.row.id},second)).data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  expect(await c.snapshot()).toEqual(before)
 })
 for(const reader of ['legacy','original host'] as const)it(`holds a retained Knowledge successor without matching immutable observations at the actual ${reader} ID reader`,async()=>{
  const c=await fixture(),context=await c.context(),tool=createKnowledgeTools(store).find(tool=>tool.name==='readKnowledgeEntry')!
  expect((await tool.execute({id:c.row.id},context)).data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  const original=await c.snapshot()
  await c.f.pool.query("UPDATE knowledge_entries SET title='Fictional retained Knowledge successor' WHERE id=$1",[c.row.id])
  const current=await c.snapshot()
  expect(current.version).not.toBe(original.version)
  expect((await c.f.pool.query("SELECT resource_version FROM scope_derivations WHERE workspace_id=$1 AND resource_kind='knowledge_entry' AND resource_id=$2",[c.f.workspaceId,c.row.id])).rows).toEqual([{resource_version:original.version}])
  if(reader==='legacy')expect(await store.getById(context.executionContext!.security.access,c.row.id)).toBeNull()
  else{
   const result=await tool.execute({id:c.row.id},context)
   expect(result.isError).toBe(true)
   expect(JSON.stringify(result)).not.toContain('Fictional protected Knowledge bytes')
  }
 })

 it('holds cached actual Knowledge tool content before text extraction/provider dispatch after independent withdrawal and keeps a separate current model reader usable',async()=>{
  const c=await fixture()
  configureConnectorSourceRuntimeFactory(c.source.factory,{instances:c.source.instances})
  const context=await c.context(c.f.ownerId,true),tool=createKnowledgeTools(store).find(tool=>tool.name==='readKnowledgeEntry')!
  const shared=await c.context(),sharedResult=await tool.execute({id:c.row.id},shared)
  if(!sharedResult.scopeEvidence)throw new Error('Shared Knowledge tool must retain evidence')
  shared.scopeAccumulator.note(sharedResult.scopeEvidence)
  await expect(assertSourceModelInputAuthority(shared)).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  const result=await tool.execute({id:c.row.id},context)
  expect(result.data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  if(!result.scopeEvidence)throw new Error('Actual Knowledge tool output must carry canonical evidence')
  context.scopeAccumulator.note(result.scopeEvidence)
  await expect(assertSourceModelInputAuthority(context)).resolves.toBeUndefined()
  const before=await c.snapshot()
  await c.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[c.f.ownerId])
  let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-knowledge-source',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},
   stream:async function*(){calls++;yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional current Knowledge title'};
    yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  const messages=[{role:'user' as const,get content(){extractions++;return JSON.stringify(result.data)}}]
  await expect(generateTitle(provider,messages,'fixture',()=>assertSourceModelInputAuthority(context))).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
  expect(await c.snapshot()).toEqual(before)
  const other=await c.context(c.f.secondId,true),current=await tool.execute({id:c.row.id},other)
  expect(current.data).toMatchObject({content:'Fictional protected Knowledge bytes'})
  if(!current.scopeEvidence)throw new Error('Independent Knowledge reader must carry canonical evidence')
  other.scopeAccumulator.note(current.scopeEvidence)
  await expect(generateTitle(provider,[{role:'user',content:JSON.stringify(current.data)}],'fixture',()=>assertSourceModelInputAuthority(other))).resolves.toEqual({title:'Fictional current Knowledge title',model:'fixture',usage:{inputTokens:2,outputTokens:2}})
  expect(calls).toBe(1)
  expect(await c.snapshot()).toEqual(before)
 })

})
