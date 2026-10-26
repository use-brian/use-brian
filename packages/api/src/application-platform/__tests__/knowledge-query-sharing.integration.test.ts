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
describe.sequential('[COMP:api/application-persistence] actual Knowledge query independent reuse',()=>{
 let c:Fixture|undefined
 afterEach(async()=>{configureConnectorSourceRuntimeFactory(undefined);await c?.cleanup();c=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 for(const name of ['searchKnowledge','browseKnowledge'] as const)it(`reuses actual ${name} evidence under an independent current reader without borrowing source grants`,async()=>{
  c=await retainedKnowledgeFixture();const f=c
  configureConnectorSourceRuntimeFactory(f.source.factory,{instances:f.source.instances})
  const tool=createKnowledgeTools(store).find(tool=>tool.name===name)!,input=name==='searchKnowledge'?{query:'fictional'}:{}
  const first=await f.context(f.f.ownerId,true),second=await f.context(f.f.secondId,true)
  // Equal explicit deny-only bounds make this the same actual workspace domain.
  const a=await tool.execute(input,{...first,compartments:[],projectIds:[]})
  const b=await tool.execute(input,{...second,compartments:[],projectIds:[]})
  expect(a.isError).not.toBe(true);expect(b.isError).not.toBe(true)
  expect(JSON.stringify(a.data)).toContain(f.row.id);expect(b.data).toEqual(a.data)
  if(!a.scopeEvidence||!b.scopeEvidence)throw new Error('Actual query observations required')
  async function domain(ids:string[]){
   const rows=(await f.f.pool.query<{domain:Record<string,unknown>}>(`SELECT q.domain FROM application_field_resources r
    JOIN application_query_domains q ON q.workspace_id=r.workspace_id AND q.id=r.resource_id
    WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND r.selection='query_domain'`,[f.f.workspaceId,ids])).rows
   expect(rows).toHaveLength(1);return rows[0].domain
  }
  const da=await domain(a.scopeEvidence.sources!.map(source=>source.resourceId)),db=await domain(b.scopeEvidence.sources!.map(source=>source.resourceId))
  expect(db.bounds).toEqual(da.bounds);expect(db.candidates).toEqual(da.candidates);expect(db.policies).toEqual(da.policies)
  const before=await f.snapshot(),replay=await f.context(f.f.secondId,true)
  replay.scopeAccumulator.note(a.scopeEvidence)
  let extractions=0,calls=0
  const provider:LLMProvider={name:'fictional-query-reuse',models:['fixture'],createSession(){throw new Error('Stateless fixture required')},stream:async function*(){calls++;
   yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'Fictional reused query title'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:2,outputTokens:2}}}}
  await expect(generateTitle(provider,[{role:'user',get content(){extractions++;return JSON.stringify(a.data)}}],'fixture',()=>assertSourceModelInputAuthority(replay)))
   .resolves.toEqual({title:'Fictional reused query title',model:'fixture',usage:{inputTokens:2,outputTokens:2}})
  expect(extractions).toBeGreaterThan(0);expect(calls).toBe(1)
  await f.source.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.f.secondId])
  const contracted=await f.context(f.f.secondId,true);contracted.scopeAccumulator.note(a.scopeEvidence);extractions=0;calls=0
  await expect(generateTitle(provider,[{role:'user',get content(){extractions++;return JSON.stringify(a.data)}}],'fixture',()=>assertSourceModelInputAuthority(contracted)))
   .rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(extractions).toBe(0);expect(calls).toBe(0)
  const stillAllowed=await f.context(f.f.ownerId,true);stillAllowed.scopeAccumulator.note(a.scopeEvidence)
  await expect(assertSourceModelInputAuthority(stillAllowed)).resolves.toBeUndefined()
  expect(await f.snapshot()).toEqual(before)
 })
 it('holds native query payloads when the physical Knowledge schema introduces an unsupported private axis',async()=>{
  c=await retainedKnowledgeFixture();const f=c
  configureConnectorSourceRuntimeFactory(f.source.factory,{instances:f.source.instances})
  const tool=createKnowledgeTools(store).find(tool=>tool.name==='searchKnowledge')!
  const original=await tool.execute({query:'fictional'},await f.context(f.f.ownerId,true))
  expect(JSON.stringify(original.data)).toContain(f.row.id)
  const before=await f.snapshot()
  // A physical default makes the new private axis real without performing a
  // semantic UPDATE that correctly advances the retained row's version.
  const ddl=(await f.f.pool.query<{sql:string}>("SELECT format('ALTER TABLE knowledge_entries ADD COLUMN assistant_id uuid DEFAULT %L::uuid',$1::text) AS sql",[f.f.assistantId])).rows[0].sql
  await f.f.pool.query(ddl)
  try{
   expect((await f.f.pool.query<{assistant_id:string}>('SELECT assistant_id FROM knowledge_entries WHERE id=$1',[f.row.id])).rows[0].assistant_id).toBe(f.f.assistantId)
   const held=await tool.execute({query:'fictional'},await f.context(f.f.ownerId,true))
   expect(held.isError).toBe(true);expect(JSON.stringify(held)).not.toContain(f.row.id);expect(JSON.stringify(held)).not.toContain(f.row.path)
  }finally{await f.f.pool.query('ALTER TABLE knowledge_entries DROP COLUMN assistant_id')}
  const current=await tool.execute({query:'fictional'},await f.context(f.f.ownerId,true))
  expect(JSON.stringify(current.data)).toContain(f.row.id);expect(await f.snapshot()).toEqual(before)
 })
})
