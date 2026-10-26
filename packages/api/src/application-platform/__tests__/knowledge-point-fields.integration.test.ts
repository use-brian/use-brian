import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {createKnowledgeTools,type LLMProvider} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbKnowledgeStore} from '../../db/knowledge-store.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {assertSourceModelInputAuthority} from '../model-source-authority.js'
import {generateTitle} from '../../routes/attended-session-title.js'
import {retainedKnowledgeFixture} from './fixtures/retained-knowledge.js'
import {knowledgeFieldPolicyFixture} from './fixtures/knowledge-field-policy.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const store=createDbKnowledgeStore()
type Fixture=Awaited<ReturnType<typeof retainedKnowledgeFixture>>
type Policy=Awaited<ReturnType<typeof knowledgeFieldPolicyFixture>>
describe.sequential('[COMP:api/application-persistence] actual Knowledge ID and related identity fields',()=>{
 let c:Fixture|undefined,policy:Policy|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);try{await policy?.cleanup()}finally{policy=undefined;await c?.cleanup();c=undefined}})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function fixture(){c=await retainedKnowledgeFixture();policy=await knowledgeFieldPolicyFixture(c.f);return{c,policy}}
 async function ordinary(current:Fixture,path:string){return store.create({workspaceId:current.f.workspaceId,path,title:'Fictional point field entry',content:'Fictional point field bytes',
  sensitivity:current.source.root.sensitivity,compartments:[...current.source.root.compartments],projectIds:[...current.source.root.projectIds],createdBy:current.f.ownerId})}
 it('holds actual ordinary native ID payloads after field-role contraction without an original host and preserves a separate current reader',async()=>{
  const {c,policy}=await fixture(),row=await ordinary(c,'fictional-native-point'),first=await c.context(c.f.ownerId,true),second=await c.context(c.f.secondId,true)
  expect(await store.getById(first.executionContext!.security.access,row.id)).toMatchObject({content:'Fictional point field bytes'})
  const before=(await c.f.pool.query("SELECT read_scope_source($1,'knowledge_entry',$2) AS source",[c.f.workspaceId,row.id])).rows[0].source
  await policy.revoke(c.f.ownerId,'body_reader')
  expect(await store.getById(first.executionContext!.security.access,row.id)).toBeNull()
  expect(await store.getById(second.executionContext!.security.access,row.id)).toMatchObject({content:'Fictional point field bytes'})
  expect((await c.f.pool.query("SELECT read_scope_source($1,'knowledge_entry',$2) AS source",[c.f.workspaceId,row.id])).rows[0].source).toEqual(before)
 })
 it('keeps an allowed related identity while its body is held by the actual per-record field contract',async()=>{
  const {c,policy}=await fixture(),parent=await ordinary(c,'fictional-point-parent'),target=await ordinary(c,'fictional-point-target')
  await policy.protect(target.id,'content','target_body_reader')
  await c.f.pool.query('UPDATE knowledge_entries SET related_ids=ARRAY[$2::uuid] WHERE id=$1',[parent.id,target.id])
  const context=await c.context(c.f.ownerId,true),tool=createKnowledgeTools(store).find(value=>value.name==='readKnowledgeEntry')!
  const projection=await tool.execute({id:parent.id},context)
  expect(projection.data).toMatchObject({relatedEntries:[target.id]})
  if(!projection.scopeEvidence)throw new Error('Allowed identity must carry canonical observations')
  const held=await tool.execute({id:target.id},await c.context(c.f.ownerId,true))
  expect(held.isError).toBe(true);expect(JSON.stringify(held)).not.toContain('Fictional point field bytes')
  await policy.grant(c.f.secondId,'target_body_reader')
  const replay=await c.context(c.f.secondId,true);replay.scopeAccumulator.note(projection.scopeEvidence)
  // Its extra body permission cannot invalidate the same already admitted
  // identity-only observation. The actual current field check still applies.
  await expect(assertSourceModelInputAuthority(replay)).resolves.toBeUndefined()
  expect((await tool.execute({id:target.id},await c.context(c.f.secondId,true))).data).toMatchObject({content:'Fictional point field bytes'})
 })
 it('invalidates cached related absence under a fresh actual lease when a retained target identity becomes readable',async()=>{
  const {c,policy}=await fixture(),parent=await ordinary(c,'fictional-point-absence'),target=c.row
  configureConnectorSourceRuntimeFactory(c.source.factory,{instances:c.source.instances})
  await policy.protect(target.id,'id','identity_reader')
  await c.f.pool.query('UPDATE knowledge_entries SET related_ids=ARRAY[$2::uuid] WHERE id=$1',[parent.id,target.id])
  const context=await c.context(c.f.ownerId,true),tool=createKnowledgeTools(store).find(value=>value.name==='readKnowledgeEntry')!,result=await tool.execute({id:parent.id},context)
  expect(result.isError).not.toBe(true);expect(JSON.stringify(result.data)).not.toContain(target.id)
  if(!result.scopeEvidence)throw new Error('Actual point absence must retain current field observations')
  context.scopeAccumulator.note(result.scopeEvidence);await expect(assertSourceModelInputAuthority(context)).resolves.toBeUndefined()
  const before=(await c.f.pool.query("SELECT read_scope_source($1,'knowledge_entry',$2) AS source",[c.f.workspaceId,parent.id])).rows[0].source
  await policy.grant(c.f.ownerId,'identity_reader');await policy.grant(c.f.secondId,'identity_reader')
  // A new canonical device/session/lease rules out an old lease's epoch alone
  // explaining this cached-data refusal. Its original observations must hold.
  const replay=await c.context(c.f.ownerId,true);replay.scopeAccumulator.note(result.scopeEvidence)
  let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-point-identity',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},stream:async function*(){calls++;
   yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional identity title'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  await expect(generateTitle(provider,[{role:'user',get content(){extractions++;return JSON.stringify(result.data)}}],'fixture',()=>assertSourceModelInputAuthority(replay)))
   .rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
  const second=await c.context(c.f.secondId,true),current=await tool.execute({id:parent.id},second)
  expect(current.data).toMatchObject({relatedEntries:[target.id]})
  if(!current.scopeEvidence)throw new Error('Independent current point must retain observations')
  second.scopeAccumulator.note(current.scopeEvidence)
  await expect(generateTitle(provider,[{role:'user',content:JSON.stringify(current.data)}],'fixture',()=>assertSourceModelInputAuthority(second)))
   .resolves.toEqual({title:'Fictional identity title',model:'fixture',usage:{inputTokens:2,outputTokens:2}})
  expect(calls).toBe(1)
  expect((await c.f.pool.query("SELECT read_scope_source($1,'knowledge_entry',$2) AS source",[c.f.workspaceId,parent.id])).rows[0].source).toEqual(before)
 })
})
