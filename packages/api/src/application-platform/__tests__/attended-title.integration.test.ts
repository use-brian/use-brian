import {attendedSessionTurnCount,readAttendedSessionHistory} from '../../routes/attended-session-context.js'
import {publishNativeSessionMessageBatch} from '../../db/session-message-publication.js'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {boundScopeSources,type LLMProvider} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {addSessionMessage} from '../../db/sessions.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {publishSessionTitle,readSessionTitle} from '../../db/session-title-store.js'
import {generateAttendedSessionTitle} from '../../routes/attended-session-title.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const usage={inputTokens:5,outputTokens:4}
function provider(text='Fictional generated session title',before?:()=>Promise<void>,toolUse=false){
 const inputs:unknown[]=[]
 const value:LLMProvider={name:'fictional-attended-title',models:['fixture'],createSession(){throw new Error('Stateless title provider required')},
  stream:async function*(input){inputs.push(structuredClone(input.messages));yield{type:'message_start',model:'fixture'};await before?.()
   yield{type:'text_delta',text}
   if(toolUse){yield{type:'tool_use_start',id:'fictional-title-tool',name:'fictionalTool'};yield{type:'tool_use_delta',id:'fictional-title-tool',input:'{}'};yield{type:'tool_use_end',id:'fictional-title-tool'}}
   yield{type:'message_end',stopReason:toolUse?'tool_use':'end_turn',usage}
  }}
 return{value,inputs}
}
describe.sequential('[COMP:api/application-persistence] actual attended title model boundaries',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){fixture=await persistentContextFixture();const f=fixture;await f.history();return f}
 it('keeps trivial chat untitled until an admitted substantive user turn arrives',async()=>{
  fixture=await persistentContextFixture();const f=fixture
  await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'test'}],scope:f.envelope})
  await addSessionMessage({sessionId:f.session.id,role:'assistant',content:[{type:'text',text:'I’m here.'}],scope:f.envelope})
  const llm=provider()
  expect(await generateAttendedSessionTitle({authority:await f.modelContext(),provider:llm.value,model:'fixture'}))
   .toMatchObject({title:null,usage:null,model:null,written:false})
  expect(llm.inputs).toEqual([])
  expect((await f.pool.query('SELECT scope_revision_id FROM session_title_heads WHERE session_id=$1',[f.session.id])).rows).toEqual([])
  await addSessionMessage({sessionId:f.session.id,role:'user',content:[{type:'text',text:'Fictional planning request'}],scope:f.envelope})
  expect(await generateAttendedSessionTitle({authority:await f.modelContext(),provider:llm.value,model:'fixture'}))
   .toMatchObject({title:'Fictional generated session title',written:true})
  expect(llm.inputs).toHaveLength(1)
 })
 it('retains complete actual query and consumed memory ancestry before title text compaction',async()=>{
  const f=await setup(),authority=await f.modelContext(),memory=await f.memory('Fictional consumed turn memory')
  const row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id);expect(row).not.toBeNull()
  authority.accumulator.note({sources:boundScopeSources(row!)})
  const llm=provider(),result=await generateAttendedSessionTitle({authority,provider:llm.value,model:'fixture'})
  expect(result).toMatchObject({title:'Fictional generated session title',written:true});expect(llm.inputs).toHaveLength(1)
  expect(JSON.stringify(llm.inputs[0])).toContain('Fictional earlier request')
  const title=await readSessionTitle(f.session.id,await f.modelContext()),edges=(await f.pool.query(`SELECT edge.source_kind,edge.source_id FROM scope_derivations d
   JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id
   WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND d.resource_id=$2`,[f.workspaceId,title!.revisionId])).rows
  expect(edges).toContainEqual({source_kind:'memory',source_id:memory.id})
  expect(edges.filter(edge=>edge.source_kind==='application_field').length).toBeGreaterThan(1)
  expect(boundScopeSources(result)).toMatchObject([{resourceKind:'session_context_revision',resourceId:title!.revisionId}])
  expect(authority.accumulator.evidence.sources).toEqual(expect.arrayContaining(boundScopeSources(result)))
 })
 it('never uses an unproved legacy title as a model excerpt or preserved channel prefix',async()=>{
  const f=await setup(),authority=await f.modelContext(),llm=provider(),prefixInputs:Array<string|null|undefined>=[]
  await f.pool.query("UPDATE sessions SET title='[fictional-held] Fictional unproved legacy secret' WHERE id=$1",[f.session.id])
  const result=await generateAttendedSessionTitle({authority,provider:llm.value,model:'fixture',channelPrefix:title=>{prefixInputs.push(title);return title?.match(/^\[[^\]]+\]/)?.[0]??null}})
  expect(result).toMatchObject({title:'Fictional generated session title',written:true})
  expect(JSON.stringify(llm.inputs)).not.toContain('fictional-held');expect(JSON.stringify(llm.inputs)).not.toContain('unproved legacy secret')
  expect(prefixInputs).toEqual([undefined])
  expect((await f.pool.query('SELECT title FROM sessions WHERE id=$1',[f.session.id])).rows).toEqual([{title:null}])
 })
 it('does not dispatch the title provider after the original member authority is revoked',async()=>{
  const f=await setup(),authority=await f.modelContext(f.firstId),llm=provider()
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(generateAttendedSessionTitle({authority,provider:llm.value,model:'fixture'})).rejects.toMatchObject({reason:'authority_changed'})
  expect(llm.inputs).toEqual([]);expect((await f.pool.query('SELECT scope_revision_id FROM session_title_heads WHERE session_id=$1',[f.session.id])).rows).toEqual([])
 })
 it('withholds provider output after a consumed source contracts and keeps an independently authorized generator usable',async()=>{
  const f=await setup(),authority=await f.modelContext(f.firstId),memory=await f.memory('Fictional contracting title source'),store=createDbMemoryStore()
  const row=await store.getById(authority.execution.security.access,memory.id);expect(row).not.toBeNull();authority.accumulator.note({sources:boundScopeSources(row!)})
  const llm=provider('Fictional withheld source title',async()=>{await f.pool.query("UPDATE memories SET sensitivity='confidential' WHERE id=$1",[memory.id])})
  await expect(generateAttendedSessionTitle({authority,provider:llm.value,model:'fixture'})).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(llm.inputs).toHaveLength(1);expect((await f.pool.query('SELECT scope_revision_id FROM session_title_heads WHERE session_id=$1',[f.session.id])).rows).toEqual([])
  const other=await f.modelContext(f.secondId),current=await store.getById(other.execution.security.access,memory.id);expect(current).not.toBeNull();other.accumulator.note({sources:boundScopeSources(current!)})
  const allowed=provider('Fictional independent current title')
  expect(await generateAttendedSessionTitle({authority:other,provider:allowed.value,model:'fixture'})).toMatchObject({title:'Fictional independent current title',written:true})
 })
 it('keeps a manual title that wins the actual head CAS while the provider is running',async()=>{
  const f=await setup(),authority=await f.modelContext(),llm=provider('Fictional stale automatic title',async()=>{
   const manualAuthority=await f.modelContext(),input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,authority:manualAuthority})
   expect(await publishSessionTitle({sessionId:f.session.id,title:'Fictional fresh manual choice',manual:true,expectedRevision:null,authority:manualAuthority,
    derivation:{producer:'fixture:concurrent-manual-title',sources:boundScopeSources(input)}})).not.toBeNull()
  })
  expect(await generateAttendedSessionTitle({authority,provider:llm.value,model:'fixture'})).toMatchObject({title:null,written:false})
  expect(await readSessionTitle(f.session.id,await f.modelContext())).toMatchObject({title:'Fictional fresh manual choice',manual:true})
  expect((await f.pool.query("SELECT count(*)::int AS n FROM session_context_scope_revisions WHERE session_id=$1 AND parent_kind='session_title'",[f.session.id])).rows).toEqual([{n:1}])
 })
 it('skips title generation for an admitted existing manual choice',async()=>{
  const f=await setup(),authority=await f.modelContext(),input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:0,authority})
  await publishSessionTitle({sessionId:f.session.id,title:'Fictional existing manual title',manual:true,expectedRevision:null,authority,
   derivation:{producer:'fixture:existing-manual-title',sources:boundScopeSources(input)}})
  const llm=provider();expect(await generateAttendedSessionTitle({authority:await f.modelContext(),provider:llm.value,model:'fixture'})).toMatchObject({title:null,written:false})
  expect(llm.inputs).toEqual([])
 })
 it('never publishes tool-carrying provider narration as a title or first-message fallback',async()=>{
  const f=await setup(),llm=provider('Fictional private title planning narration',undefined,true)
  expect(await generateAttendedSessionTitle({authority:await f.modelContext(),provider:llm.value,model:'fixture'})).toMatchObject({title:null,written:false})
  expect(llm.inputs).toHaveLength(1)
  expect((await f.pool.query("SELECT id FROM session_context_scope_revisions WHERE session_id=$1 AND parent_kind='session_title'",[f.session.id])).rows).toEqual([])
 })
 it('counts original admitted user inputs through a filtered context window and rechecks every later count use',async()=>{
  const f=await setup(),authority=await f.modelContext(f.firstId),input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority})
  await publishNativeSessionMessageBatch({sessionId:f.session.id,authority,derivationTarget:f.envelope,derivation:{producer:'fixture:count-tool-pairs',sources:boundScopeSources(input)},
   messages:[{role:'assistant',content:[{type:'tool_use',id:'fictional-count-tool',name:'fictionalTool',input:{}}]},
    {role:'user',content:[{type:'tool_result',toolUseId:'fictional-count-tool',name:'fictionalTool',content:'Fictional tool output'}]}]})
  const history=await readAttendedSessionHistory(authority,f.session.id,100)
  expect(history).toEqual([]);expect(await attendedSessionTurnCount(authority,history)).toBe(2)
  await expect(attendedSessionTurnCount(authority,[...history])).rejects.toMatchObject({code:'scope_evidence_missing'})
  await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
  await expect(attendedSessionTurnCount(authority,history)).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  const other=await f.modelContext(f.secondId),current=await readAttendedSessionHistory(other,f.session.id,100)
  expect(await attendedSessionTurnCount(other,current)).toBe(2)
 })
 it('publishes a first title over a real seventeen-pair persisted transcript with all original sources',async()=>{
  const f=await setup(),authority=await f.modelContext(f.firstId),input=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority}),sources=[...boundScopeSources(input)]
  for(let n=0;n<17;n++){
   const memory=await f.memory('Fictional large title source '+n),row=await createDbMemoryStore().getById(authority.execution.security.access,memory.id)
   expect(row).not.toBeNull();sources.push(...boundScopeSources(row!))
  }
  authority.accumulator.note({sources})
  await publishNativeSessionMessageBatch({sessionId:f.session.id,authority,derivationTarget:f.envelope,derivation:{producer:'fixture:large-title-cohort',sources},
   messages:Array.from({length:17},(_,n)=>[{role:'assistant' as const,content:[{type:'tool_use' as const,id:'fictional-large-title-'+n,name:'fictionalTool',input:{}}]},
    {role:'user' as const,content:[{type:'tool_result' as const,toolUseId:'fictional-large-title-'+n,name:'fictionalTool',content:'Fictional tool output'}]}]).flat()})
  const llm=provider(),result=await generateAttendedSessionTitle({authority,provider:llm.value,model:'fixture'})
  expect(result).toMatchObject({title:'Fictional generated session title',written:true});expect(llm.inputs).toHaveLength(1)
  const title=await readSessionTitle(f.session.id,await f.modelContext(f.secondId))
  expect(title).toMatchObject({title:'Fictional generated session title'})
  const retained=(await f.pool.query<{source_id:string}>(`SELECT edge.source_id FROM scope_derivations d JOIN scope_derivation_sources edge
   ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision'
   AND d.resource_id=$2 AND edge.source_kind='memory'`,[f.workspaceId,title!.revisionId])).rows.map(row=>row.source_id)
  for(const source of sources.filter(s=>s.resourceKind==='memory'))expect(retained).toContain(source.resourceId)
 })

})
