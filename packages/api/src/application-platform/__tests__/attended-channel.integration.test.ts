import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {z} from 'zod'
import {buildTool,boundScopeSources,type ScopeSource,type LLMProvider,type Message,type StreamChunk} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {findAssistantById} from '../../db/users.js'
import {createDbCapabilityStore} from '../../db/capability-store.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {readAdmittedSessionQuery} from '../../db/session-query-reader.js'
import {processChannelMessage,type ChannelHooks} from '../../routes/channel-pipeline.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] actual attended channel field publication',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(){
  fixture=await persistentContextFixture();const f=fixture
  const assistant=await findAssistantById(f.assistantId);if(!assistant)throw new Error('Missing actual fixture assistant')
  const sourceSets:ScopeSource[][]=[],saved:string[]=[],responses:string[]=[],errors:Error[]=[],committed:boolean[]=[]
  const sessionRef:{id?:string}={}
  const tool=buildTool({name:'fixtureReadSession',description:'Read current fixture history',inputSchema:z.object({read:z.literal(true)}),isReadOnly:true,isConcurrencySafe:true,
   async execute(_input,context){
    if(!context.executionContext||!context.scopeAccumulator)throw new Error('Missing actual channel authority')
    const high=(await f.pool.query<{sequence:number}>('SELECT coalesce(max(sequence_num),0)::int AS sequence FROM session_messages WHERE session_id=$1',[context.sessionId])).rows[0].sequence
    const result=await readAdmittedSessionQuery({sessionId:context.sessionId,throughSequence:high,authority:{execution:context.executionContext,accumulator:context.scopeAccumulator}})
    sourceSets.push([...boundScopeSources(result)])
    return{data:{history:result.history.map(row=>({id:row.id,content:row.content}))}}
   }})
  const usage={inputTokens:3,outputTokens:2},scripts:StreamChunk[][]=[[
   {type:'message_start',model:'fixture'},{type:'tool_use_start',id:'fictional-channel-query',name:tool.name},
   {type:'tool_use_delta',id:'fictional-channel-query',input:'{"read":true}'},{type:'tool_use_end',id:'fictional-channel-query'},
   {type:'message_end',stopReason:'tool_use',usage}],
   [{type:'message_start',model:'fixture'},{type:'text_delta',text:'Fictional admitted channel response'},{type:'message_end',stopReason:'end_turn',usage}]]
  let sends=0,backgroundText:string|undefined='Fictional title'
  const provider:LLMProvider={name:'fictional-channel',models:['fixture'],
   async *stream(){yield{type:'message_start',model:'fixture'};if(backgroundText)yield{type:'text_delta',text:backgroundText};yield{type:'message_end',stopReason:'end_turn',usage}},
   createSession(){return{send(_messages:Message[]){return(async function*(){for(const chunk of scripts[sends++]??[])yield chunk})()}}}}
  const hooks:ChannelHooks={async onConfirmationRequired(){throw new Error('Unexpected fixture confirmation')},async sendResponse(text){responses.push(text)},async sendError(error){errors.push(error)},
   async onAssistantMessageSaved(message){saved.push(message.id);committed.push((await f.pool.query('SELECT id FROM session_messages WHERE id=$1',[message.id])).rows.length===1)}}
  const run=()=>processChannelMessage({userId:f.ownerId,ownerId:f.ownerId,assistant,isIdentified:true,channelType:'telegram',channelId:'15550001111',isGroupChat:false,
   senderUserId:f.ownerId,messageText:'Fictional channel input',userContentBlocks:[{type:'text',text:'Fictional channel input'}],modelAlias:undefined,
   abortController:new AbortController(),provider,systemPrompt:'Fictional local channel fixture',tools:new Map([[tool.name,tool]]),memoryStore:createDbMemoryStore(),
   capabilityStore:createDbCapabilityStore(),hooks,sessionRef})
  return{f,run,sessionRef,sourceSets,saved,responses,errors,committed,disableBackgroundText:()=>{backgroundText=undefined}}
 }
 it('retains original query field observations and announces only committed channel pairs',async()=>{
  const current=await setup();await current.run()
  expect(current.errors).toEqual([]);expect(current.responses.join(' ')).toContain('Fictional admitted channel response')
  expect(current.sourceSets).toHaveLength(1);expect(current.sourceSets[0].some(source=>source.resourceKind==='application_field')).toBe(true)
  const pair=(await current.f.pool.query<{id:string}>(`SELECT id FROM session_messages WHERE session_id=$1 AND (content @> '[{"type":"tool_use"}]'::jsonb OR content @> '[{"type":"tool_result"}]'::jsonb)`,[current.sessionRef.id])).rows
  expect(pair).toHaveLength(2)
  for(const row of pair){
   const roots=(await current.f.pool.query<{source_id:string;source_version:string}>(`SELECT edge.source_id,edge.source_version FROM scope_derivations d JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2 AND edge.source_kind='application_field'`,[current.f.workspaceId,row.id])).rows
   for(const source of current.sourceSets[0].filter(source=>source.resourceKind==='application_field'))expect(roots).toContainEqual({source_id:source.resourceId,source_version:source.version})
  }
  expect(current.committed.length).toBeGreaterThan(0);expect(current.committed).not.toContain(false)
 })
 it('rolls the complete channel batch back on a later result insert without saved-row events',async()=>{
  const current=await setup();current.disableBackgroundText()
  await current.f.pool.query(`ALTER TABLE session_messages ADD CONSTRAINT fixture_channel_pair_failure CHECK(workspace_id<>'${current.f.workspaceId}'::uuid OR NOT content @> '[{"type":"tool_result"}]'::jsonb) NOT VALID`)
  try{
   await current.run().catch(error=>current.errors.push(error))
   expect(current.sourceSets).toHaveLength(1)
   expect(current.errors.length).toBeGreaterThan(0);expect(current.saved).toEqual([]);expect(current.responses).toEqual([])
   expect((await current.f.pool.query(`SELECT id FROM session_messages WHERE session_id=$1 AND role='assistant'`,[current.sessionRef.id])).rows).toEqual([])
  }finally{await current.f.pool.query('ALTER TABLE session_messages DROP CONSTRAINT fixture_channel_pair_failure')}
 })
})
