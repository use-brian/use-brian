import {randomUUID} from 'node:crypto'
import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest'
import {z} from 'zod'
import type {LLMProvider, Message, StreamChunk} from '@use-brian/agent-runtime/providers/types.js'
import type {ScopeSource} from '@use-brian/agent-runtime/security/derived-scope.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {buildTool} from '@use-brian/agent-runtime/tools/types.js'
import {getAppPool,getPool,queryWithRLS} from '../../db/client.js'
import {conversationAnchorWriteAdmissionActive,initializeConversationVisibility} from '../../db/conversation-visibility.js'
import {findAssistantById} from '../../db/users.js'
import {createDbCapabilityStore} from '../../db/capability-store.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {updateSelfEntityAttributes} from '../../db/entities-store.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import { addSessionMessage,findOrCreateSession } from '../../db/sessions.js'
import {processChannelMessage,type ChannelHooks} from '../../routes/channel-pipeline.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] actual attended channel field publication',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 const guests:string[]=[]
 beforeAll(async()=>{await initializeConversationVisibility();expect(conversationAnchorWriteAdmissionActive()).toBe(true)})
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined
  await getPool().query('DELETE FROM users WHERE id=ANY($1::uuid[])',[guests.splice(0)])})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function setup(input:{adaptive?:boolean;withdrawDuringAssessment?:boolean;guest?:boolean;quarantinedHistory?:boolean}={}){
  fixture=await persistentContextFixture();const f=fixture
  const actor=input.guest?randomUUID():f.ownerId
  if(input.guest){guests.push(actor);await f.pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[actor])}
  if(input.quarantinedHistory){
   const prior=await findOrCreateSession({assistantId:f.assistantId,userId:actor,channelType:'telegram',channelId:'15550001111'})
   const scope={...f.envelope,userId:actor}
   await addSessionMessage({sessionId:prior.id,role:'assistant',content:[{type:'text',text:'Fictional previously delivered history.'}],scope})
   const excluded=await addSessionMessage({sessionId:prior.id,role:'assistant',content:[{type:'text',text:'Fictional quarantined history.'}],scope})
   await f.pool.query(`INSERT INTO public.conversation_message_quarantine(session_id,message_id,reason)
    VALUES($1,$2,'missing_stamp')`,[prior.id,excluded.id])
  }
  if(input.adaptive)await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1",[f.workspaceId])
  const assessmentInputs:string[]=[],assessmentAuthored:boolean[]=[],prompts:unknown[]=[]
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
  if(input.guest)scripts.shift()
  let sends=0,backgroundText:string|undefined='Fictional title'
  const provider:LLMProvider={name:'fictional-channel',models:['fixture'],
   async *stream(options){
    const serialized=JSON.stringify(options.messages)
    if(serialized.includes('recentConversation')){
     assessmentInputs.push(serialized)
     assessmentAuthored.push((await f.pool.query("SELECT id FROM session_messages WHERE session_id=$1 AND role='user'",[sessionRef.id])).rows.length===1)
     if(input.withdrawDuringAssessment)await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.ownerId])
     yield{type:'message_start',model:'fixture'};yield{type:'text_delta',text:'{"research":false}'};yield{type:'message_end',stopReason:'end_turn',usage};return
    }
    yield{type:'message_start',model:'fixture'};if(backgroundText)yield{type:'text_delta',text:backgroundText};yield{type:'message_end',stopReason:'end_turn',usage}
   },
   createSession(options){prompts.push(options);return{send(_messages:Message[]){return(async function*(){for(const chunk of scripts[sends++]??[])yield chunk})()}}}}
  const hooks:ChannelHooks={async onConfirmationRequired(){throw new Error('Unexpected fixture confirmation')},async sendResponse(text){responses.push(text)},async sendError(error){errors.push(error)},
   async onAssistantMessageSaved(message){saved.push(message.id);committed.push((await f.pool.query('SELECT id FROM session_messages WHERE id=$1',[message.id])).rows.length===1)}}
  const run=()=>processChannelMessage({userId:actor,ownerId:f.ownerId,assistant,isIdentified:!input.guest,externalGuest:input.guest,channelType:'telegram',channelId:'15550001111',isGroupChat:false,
   senderUserId:actor,messageText:input.adaptive?'Compare the fictional options using several independent sources and explain their current differences.':'Fictional channel input',
   userContentBlocks:[{type:'text',text:input.adaptive?'Compare the fictional options using several independent sources and explain their current differences.':'Fictional channel input'}],modelAlias:undefined,adaptiveResearchEnabled:input.adaptive,
   abortController:new AbortController(),provider,systemPrompt:'Fictional local channel fixture',tools:new Map([[tool.name,tool]]),memoryStore:createDbMemoryStore(),
   capabilityStore:createDbCapabilityStore(),hooks,sessionRef})
  return{f,actor,run,sessionRef,sourceSets,saved,responses,errors,committed,prompts,assessmentInputs,assessmentAuthored,mainSends:()=>sends,disableBackgroundText:()=>{backgroundText=undefined}}
 }
 it('receives a new verified guest direct message only at the Public General record floor',async()=>{
  const current=await setup({guest:true});await current.run()
  expect(current.errors).toEqual([])
  expect(current.responses.join(' ')).toContain('Fictional admitted channel response')
  const {rows:[envelope]}=await current.f.pool.query(`SELECT visibility,cap,compartments FROM conversation_envelopes WHERE session_id=$1`,[current.sessionRef.id])
  expect(envelope).toEqual({visibility:'workspace',cap:'public',compartments:[]})
  const visible=await queryWithRLS(current.f.firstId,`SELECT role,content,sensitivity,user_id FROM session_messages WHERE session_id=$1 ORDER BY sequence_num`,[current.sessionRef.id])
  expect(visible.rows).toMatchObject([{role:'user',sensitivity:'public',user_id:null},{role:'assistant',sensitivity:'public',user_id:null}])
 })
 it('assesses the actual channel request only after authored input is stored and admitted',async()=>{
  const current=await setup({adaptive:true});await current.run()
  expect(current.errors).toEqual([]);expect(current.assessmentInputs).toHaveLength(1);expect(current.assessmentAuthored).toEqual([true])
  expect(current.responses.join(' ')).toContain('Fictional admitted channel response')
 })
 it('keeps quarantined dialogue out of the original provider classifier and main turn',async()=>{
  const current=await setup({adaptive:true,quarantinedHistory:true});await current.run()
  expect(current.errors).toEqual([])
  expect(current.assessmentInputs).toHaveLength(1)
  expect(current.assessmentInputs[0]).toContain('Fictional previously delivered history.')
  expect(current.assessmentInputs[0]).not.toContain('Fictional quarantined history.')
  expect(current.responses.join(' ')).toContain('Fictional admitted channel response')
 })
 it('does not enter the main channel provider after actual assessment authority is withdrawn',async()=>{
  const current=await setup({adaptive:true,withdrawDuringAssessment:true})
  await expect(current.run()).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
  expect(current.assessmentInputs).toHaveLength(1);expect(current.assessmentAuthored).toEqual([true]);expect(current.mainSends()).toBe(0)
  expect(current.responses).toEqual([]);expect(current.saved).toEqual([])
 })
 it('retains original query field observations and announces only committed channel pairs',async()=>{
  const current=await setup()
  const self=await updateSelfEntityAttributes({userId:current.f.ownerId,workspaceId:current.f.workspaceId,displayName:'Fictional channel identity',attributes:{name:'Fictional channel identity',role:{title:'Fictional planner'},licenses:['Fictional qualification']}})
  await current.run()
  expect(current.errors).toEqual([]);expect(current.responses.join(' ')).toContain('Fictional admitted channel response')
  expect(JSON.stringify(current.prompts)).toContain('Fictional channel identity')
  expect(JSON.stringify(current.prompts)).toContain('Fictional planner')
  const lineage=async(ids:string[])=> (await current.f.pool.query<{kind:string;id:string;version:string}>(`WITH RECURSIVE nodes(kind,id,version) AS(
   SELECT 'session_message',id,scope_version::text FROM session_messages WHERE workspace_id=$1 AND id=ANY($2::uuid[])
   UNION SELECT edge.source_kind,edge.source_id,edge.source_version FROM nodes n JOIN scope_derivations d
    ON d.workspace_id=$1 AND d.resource_kind=n.kind AND d.resource_id=n.id AND d.resource_version=n.version
    JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id
  ) SELECT * FROM nodes`,[current.f.workspaceId,ids])).rows
  const retained=await lineage(current.saved)
  const profileFields=(await current.f.pool.query('SELECT fields FROM application_field_resources WHERE workspace_id=$1 AND id=ANY($2::uuid[])',
    [current.f.workspaceId,retained.filter(n=>n.kind==='application_field').map(n=>n.id)])).rows
  expect(profileFields.some(row=>row.fields.includes('profile.role')&&row.fields.includes('profile.extra'))).toBe(true)
  expect(retained).toContainEqual(expect.objectContaining({kind:'entity',id:self.id}))
  expect(current.sourceSets).toHaveLength(1);expect(current.sourceSets[0].some(source=>source.resourceKind==='application_field')).toBe(true)
  const pair=(await current.f.pool.query<{id:string}>(`SELECT id FROM session_messages WHERE session_id=$1 AND (content @> '[{"type":"tool_use"}]'::jsonb OR content @> '[{"type":"tool_result"}]'::jsonb)`,[current.sessionRef.id])).rows
  expect(pair).toHaveLength(2)
  for(const row of pair){
   const roots=await lineage([row.id])
   for(const source of current.sourceSets[0].filter(source=>source.resourceKind==='application_field'))
    expect(roots).toContainEqual({kind:'application_field',id:source.resourceId,version:source.version})
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
