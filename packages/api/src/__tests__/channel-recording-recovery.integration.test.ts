/** [COMP:api/channel-recording] Reviewed history reaches the model and delivery. */
import {randomUUID,randomBytes} from 'node:crypto'
import {z} from 'zod'
import {afterAll,beforeAll,describe,expect,it,onTestFinished,vi} from 'vitest'
import {getAppPool,getPool,query,queryWithRLS,applyRLSGucs,rollbackAndRelease,runWithAgentAccess} from '../db/client.js'
import {buildTool,createGeminiProvider,createRoutingProvider,wrapProvider,type ExecutionContext,type ScopeSource} from '@use-brian/core'
import {admitTelegramRecording,recordDeliveredTelegramMessage} from '../channel-recording.js'
import {createDbChannelIntegrationStore,encryptCredentials} from '../db/channel-integrations.js'
import {applyTelegramRecordingRecovery} from '../channel-recording-recovery.js'
import {processChannelMessage,type ChannelPipelineParams} from '../routes/channel-pipeline.js'
import {createDbMemoryStore} from '../db/memory-store.js'
import {createDbCapabilityStore} from '../db/capability-store.js'
import {findAssistantById} from '../db/users.js'
import {createDecisionRuntime} from '../decision-runtime.js'
const {runTurn,inject,nativeQueries}=vi.hoisted(()=>({runTurn:vi.fn(),inject:vi.fn(),nativeQueries:[] as Array<{available:boolean;sources:number;fields:ScopeSource[]}>}))
vi.mock('../turn/kernel.js',async original=>({...await original<typeof import('../turn/kernel.js')>(),runAssistantTurn:runTurn}))
vi.mock('../turn/prepare.js',()=>({prepareAssistantRun:vi.fn(async input=>({model:input.model,tools:input.candidateTools,trustedContext:'',userVisibleContext:''}))}))
vi.mock('../mcp/inject.js',()=>({injectMcpTools:inject}))
// Observe the genuine admitted reader without replacing native SQL or proof.
vi.mock('../application-platform/native-session-query-evidence.js',async original=>{
 const real=await original<typeof import('../application-platform/native-session-query-evidence.js')>()
 return{...real,readNativeSessionQueryEvidence:async(...args:Parameters<typeof real.readNativeSessionQueryEvidence>)=>{
  const result=await real.readNativeSessionQueryEvidence(...args)
  nativeQueries.push({available:result!==null,sources:result?.sources.length??0,fields:result?.sources.filter(source=>source.resourceKind==='application_field')??[]})
  return result
 }}
})
const {assertLocalFixture}=await import(new URL('../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const [owner,other,workspace,assistant,channel,integration,source]=Array.from({length:7},()=>randomUUID())
const conversation='-1000008241:topic:24',question='Our fictional meeting is December 9.',answer='The fictional meeting date is recorded.'
const originalConsoleError=console.error.bind(console)
const credentialKey=randomBytes(32),integrationStore=createDbChannelIntegrationStore(credentialKey)
// The installed incident had 255 eligible public rows. Two-row fixtures do
// not exercise the native history/annotation query boundary at that size.
const publicHistoryRows=255
let recovered:string
let verifiedExecution:ExecutionContext|undefined

function expectPublicHistory(value:unknown){
 const serialized=JSON.stringify(value)
 for(const text of [question,answer,...Array.from({length:publicHistoryRows-2},(_,index)=>`Fictional retained public turn ${index+1}.`)])expect(serialized).toContain(text)
 expect(serialized).not.toContain('PRIVATE_')
}

/** The same non-owner role and GUC setup used by native session frames. The
 * lookup itself independently rechecks current SQL policy; no allow is reused. */
async function nativeProof(sessionId=recovered,roots?:ScopeSource[],whileOpen?:(value:unknown,pid:number)=>Promise<void>) {
 const execution=verifiedExecution
 if(!execution)throw new Error('The genuine Telegram kernel execution was not reached')
 return runWithAgentAccess(execution.security.access,async()=>{
  const client=await getAppPool().connect()
  try{
   await client.query('BEGIN')
   expect((await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
   await applyRLSGucs(client,other)
   await client.query("SELECT set_config('app.v2_assistant_id',$1,true)",[assistant])
   await client.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[workspace])
   const result=roots
    ?await client.query('SELECT read_native_turn_scope_evidence($1,$2) AS value',[workspace,JSON.stringify(roots.map(root=>({kind:root.resourceKind,id:root.resourceId,version:root.version})))])
    :await client.query('SELECT read_native_turn_session_query($1,$2,$3,$3) AS value',[workspace,sessionId,publicHistoryRows])
   if(whileOpen)await whileOpen(result.rows[0].value,(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
   return result.rows[0].value
  }finally{await rollbackAndRelease(client)}
 })
}

describe.sequential('[COMP:api/channel-recording] recovered public history reaches Telegram',()=>{
 beforeAll(async()=>{
  await query(`INSERT INTO users(id,auth_provider,auth_provider_id,name) SELECT id,'test',id::text,'Fictional recorder' FROM unnest($1::uuid[]) id`,[[owner,other]])
  await query("INSERT INTO workspaces(id,name,owner_user_id,plan) VALUES($1,'Fictional recovery',$2,'pro')",[workspace,owner])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'admin','confidential')",[workspace,owner,other])
  await query("INSERT INTO assistants(id,name,workspace_id,clearance) VALUES($1,'Fictional recovery assistant',$2,'internal')",[assistant,workspace])
  await query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Fictional recovery bot')",[channel,workspace])
  const config={requireMentionOverrides:[{chatId:'-1000008241',topicId:24}],deliveryAudienceBindings:[{version:1,channelId:'-1000008241',clearance:'internal',expiresAt:null,approvedAt:'2026-10-01T00:00:00Z',projectIds:[],audienceType:'group',compartments:[],companyWide:true,recipientUserId:null,approvedByUserId:owner}]}
  await query("INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id,config) VALUES($1,$2,'telegram',$4,'987658241',$3)",[integration,channel,config,encryptCredentials({bot_token:'fictional',webhook_secret:'fictional'},credentialKey)])
  await query('INSERT INTO channel_assistants(channel_id,assistant_id,external_surface_id) VALUES($1,$2,$3)',[channel,assistant,conversation])
  await query(`INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id,visibility,anchor_kind,anchor_ref,effective_clearance,clearance_source,title)
    VALUES($1,$2,$3,$4,'telegram',$5,'workspace','channel',$5,'internal','anchor','Fictional old history')`,[source,assistant,owner,workspace,conversation])
  // An isolated old-writer fixture. Restore the named quarantine trigger even
  // if fixture setup fails; no product path disables it.
  await query('ALTER TABLE session_messages DISABLE TRIGGER aaab_recording_privacy_message')
  try{
   for(const [index,[role,text,provider]] of [['user',question,'1001'],['assistant',answer,'1002'],['assistant','PRIVATE_UNDELIVERED',null]].entries())
    await query(`INSERT INTO session_messages(session_id,role,content,sequence_num,channel_message_id,sender_user_id,workspace_id,sensitivity,compartments,project_ids,scope_version,scope_held)
      VALUES($1,$2,$3,$4,$5,$6,$7,'internal','{}','{}',1,false)`,[source,role,JSON.stringify([{type:'text',text}]),index+1,provider,role==='user'?owner:null,workspace])
   await query(`INSERT INTO session_messages(session_id,role,content,sequence_num,channel_message_id,workspace_id,sensitivity,compartments,project_ids,scope_version,scope_held)
      VALUES($1,'assistant',$2,4,'1004',$3,'internal','{}','{}',1,false)`,[source,JSON.stringify([{type:'text',text:'PRIVATE_NARRATION'},{type:'tool_use',name:'lookup',id:'private',input:{secret:'PRIVATE_TOOL'}}]),workspace])
   await query(`INSERT INTO session_messages(session_id,role,content,sequence_num,channel_message_id,sender_user_id,
      workspace_id,sensitivity,compartments,project_ids,scope_version,scope_held)
      SELECT $1,CASE WHEN n%2=0 THEN 'user' ELSE 'assistant' END,
        jsonb_build_array(jsonb_build_object('type','text','text','Fictional retained public turn '||n||'.')),
        n+4,(n+2000)::text,CASE WHEN n%2=0 THEN $3::uuid ELSE NULL END,$2,'internal','{}','{}',1,false
      FROM generate_series(1,$4::int) n`,[source,workspace,owner,publicHistoryRows-2])
  }finally{await query('ALTER TABLE session_messages ENABLE TRIGGER aaab_recording_privacy_message')}
 })
 afterAll(async()=>{vi.unstubAllGlobals();vi.restoreAllMocks();await getAppPool().end();await getPool().end()})
 it('publishes reviewed text into a new epoch and leaves original history held',async()=>{
  const p=await queryWithRLS(owner,'SELECT preview_telegram_recording_recovery($1,$2,$3) AS value',[owner,workspace,channel])
  const candidate=p.rows[0].value.candidates.find((r:{sessionId:string})=>r.sessionId===source)
  expect(candidate).toMatchObject({messageCount:publicHistoryRows,skippedMessageCount:2})
  const r=await applyTelegramRecordingRecovery({actorId:owner,workspaceId:workspace,channelId:channel,sessionId:source,snapshotToken:candidate.snapshotToken})
  recovered=r.sessionId
  expect(recovered).not.toBe(source)
  expect((await query('SELECT recording_privacy_held FROM sessions WHERE id=$1',[source])).rows[0]).toEqual({recording_privacy_held:true})
  expect((await query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1',[recovered])).rows[0].count).toBe(publicHistoryRows)
 })
 async function createChannelHarness(kernel?:typeof import('../turn/kernel.js').runAssistantTurn){
  const failures:string[]=[]
  vi.spyOn(console,'error').mockImplementation((...args)=>{failures.push(args.map(String).join(' '));originalConsoleError(...args)})
  const injections:Array<{actorIdentity:{userId:string}}>=[]
  inject.mockImplementation(async input=>{injections.push(input);input.tools.set('fictionalCalendarRead',buildTool({name:'fictionalCalendarRead',description:'Fictional read',inputSchema:z.object({}),isReadOnly:true,isConcurrencySafe:true,execute:async()=>({data:'Fixture'})}));return{unavailable:[],searchableSources:[]}})
  const final={content:[{type:'text',text:'The fictional date is December 9.'}],stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1},model:'fixture'}
  let nativeQueryStart=0
  runTurn.mockImplementation(async input=>{
   const {sink,loop}=input
   expect(nativeQueries.slice(nativeQueryStart).some(proof=>proof.available&&proof.sources>=publicHistoryRows)).toBe(true)
   verifiedExecution=loop.context.executionContext
   if(kernel)return kernel(input)
   await sink.onEvent({type:'assistant_turn',response:final,toolResults:[]});await sink.onEvent({type:'turn_complete',response:final});return{finalText:final.content[0].text}
  })
  const sent:string[]=[],providerRequests:unknown[]=[],mainRequests:unknown[]=[]
  const provider=createRoutingProvider({gemini:wrapProvider(createGeminiProvider({kind:'ai-studio',endpoint:model=>`https://fictional.example/models/${model}`,headers:async()=>({})}))})
  // Keep the real boot provider's input-admission ownership. Only its network
  // transport is synthetic; it returns a valid answer for every typed question.
  vi.stubGlobal('fetch',vi.fn(async(url:unknown,init?:RequestInit)=>{
   expect(String(url)).toMatch(/^https:\/\/fictional\.example\/models\//)
   const request=JSON.parse(String(init?.body))
   providerRequests.push(request)
   const main=String(url).endsWith('/gemini-3.6-flash')&&request.generationConfig?.responseMimeType!=='application/json'
   if(main)mainRequests.push(request)
   const properties=request.generationConfig?.responseJsonSchema?.properties?.answers?.properties as Record<string,{properties:{value:{enum?:string[];type:string}}}>|undefined
   const text=main?'Fictional complete reply.':properties?JSON.stringify({answers:Object.fromEntries(Object.entries(properties).map(([id,field])=>{
    const values=field.properties.value.enum??[]
    const value=['ordinary','continue','__new_topic__','none'].find(candidate=>values.includes(candidate))??values[0]
    return[id,{value}]
   }))}):'{"research":false,"operate_site":false,"reason":null,"topic_label":"fictional","state":"continue","confidence":1}'
   return new Response('data: '+JSON.stringify({candidates:[{content:{parts:[{text}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:2}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
  }))
  const decisionRuntime=createDecisionRuntime({llmProvider:provider,defaultLlmModel:'gemini-3.6-flash-standard'})
  async function turn(id:string,text:string){
   nativeQueryStart=nativeQueries.length
   const started=performance.now()
   const abortController=new AbortController()
   let pending:Promise<void>|undefined
   onTestFinished(async()=>{abortController.abort();await pending?.catch(()=>undefined)})
   const recording=await admitTelegramRecording({integrationId:integration,conversationId:conversation,assistantId:assistant,providerMessageId:id,text,senderUserId:other})
   expect(recording?.session.id).toBe(recovered)
   const selectedAssistant=await findAssistantById(assistant)
   expect(selectedAssistant).not.toBeNull()
   pending=processChannelMessage({recording,admittedAnswerContext:{kind:'continue'},assistant:selectedAssistant!,
    userId:other,ownerId:owner,isIdentified:true,senderLinkedIdentity:true,externalGuest:false,channelType:'telegram',channelId:conversation,isGroupChat:true,channelIntegrationId:integration,channelIntegrationStore:integrationStore,
    incomingChannelMessageId:id,messageText:text,userContentBlocks:[{type:'text',text}],abortController,modelAlias:'standard',adaptiveResearchEnabled:true,decisionRuntime,configuredProviders:new Set(['gemini']),provider,systemPrompt:'Fixture prompt',tools:new Map(),memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore(),connectorStore:{},mcpSettingsStore:{},
    hooks:{onConfirmationRequired:async()=>{},sendError:async(error:Error)=>{throw error},sendResponse:async(text:string)=>{sent.push(text);await recordDeliveredTelegramMessage({channelId:conversation,providerMessageId:`reply-${id}`,text,botId:'987658241',botUsername:'fictional_recovery_bot'});return{channelMessageId:`reply-${id}`}}}} as unknown as ChannelPipelineParams)
   await pending
   expect(failures).toEqual([])
   const elapsedMs=performance.now()-started
   console.info('[recovered Telegram turn timing]',{publicHistoryRows,elapsedMs:Math.round(elapsedMs)})
   expect(abortController.signal.aborted).toBe(false)
  }
  return{turn,failures,injections,final,sent,providerRequests,mainRequests}
 }
 let normalHarness:Awaited<ReturnType<typeof createChannelHarness>>
 it('runs normal history, sender account-tool authority and final delivery',async()=>{
  normalHarness=await createChannelHarness()
  await normalHarness.turn('1005','What date did we agree?')
  expect(runTurn).toHaveBeenCalledOnce()
  expect(normalHarness.providerRequests.length).toBeGreaterThan(0)
  expect(JSON.stringify(normalHarness.providerRequests)).toContain(`Fictional retained public turn ${publicHistoryRows-2}.`)
  expect(JSON.stringify(normalHarness.providerRequests)).not.toContain('PRIVATE_')
  const first=runTurn.mock.calls[0][0]
  expectPublicHistory(first.loop.messages)
  expect(first.loop.tools.has('fictionalCalendarRead'),normalHarness.failures.join('\n')).toBe(true)
  expect(first.loop.context.userId).toBe(other)
  expect(normalHarness.injections[0].actorIdentity.userId).toBe(other)
  expect(normalHarness.sent).toEqual([normalHarness.final.content[0].text])
 })
 it('retains the delivered reply in the subsequent Telegram follow-up',async()=>{
  if(!normalHarness)throw new Error('The preceding Telegram delivery did not initialize its harness')
  await normalHarness.turn('1006','Remind me again.')
  expect(runTurn).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(runTurn.mock.calls[1][0].loop.messages)).toContain('What date did we agree?')
  expect(JSON.stringify(runTurn.mock.calls[1][0].loop.messages)).toContain(normalHarness.final.content[0].text)
  expect((await query("SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1 AND role='assistant'",[recovered])).rows[0].count).toBeGreaterThan(1)
 })
 let realHarness:Awaited<ReturnType<typeof createChannelHarness>>
 it('delivers recovered history through the actual kernel and managed provider boundary',async()=>{
  const real=await vi.importActual<typeof import('../turn/kernel.js')>('../turn/kernel.js')
  const realPreparation=await vi.importActual<typeof import('../turn/prepare.js')>('../turn/prepare.js')
  const preparation=await import('../turn/prepare.js')
  vi.mocked(preparation.prepareAssistantRun).mockImplementation(realPreparation.prepareAssistantRun)
  realHarness=await createChannelHarness(real.runAssistantTurn)
  await realHarness.turn('1007','Hi')
  expect(realHarness.mainRequests).toHaveLength(1)
  expect(JSON.stringify(realHarness.mainRequests[0])).toContain('fictionalCalendarRead')
  expect(runTurn.mock.calls.at(-1)?.[0].loop.context.userId).toBe(other)
  expectPublicHistory(realHarness.mainRequests[0])
  expect(realHarness.injections.at(-1)?.actorIdentity.userId).toBe(other)
  expect(realHarness.sent).toEqual(['Fictional complete reply.'])
  expect((await query("SELECT channel_message_id FROM session_messages WHERE session_id=$1 AND role='assistant' AND channel_message_id=$2",[recovered,'reply-1007'])).rows).toEqual([{channel_message_id:'reply-1007'}])
  expect((await query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[recovered])).rows[0]).toEqual({status:'idle',turn_lease_token:null})
 })
 it('keeps the actual kernel reply available to the next managed provider turn',async()=>{
  if(!realHarness)throw new Error('The preceding actual kernel turn did not initialize its harness')
  await realHarness.turn('1008','Thanks')
  expect(realHarness.mainRequests).toHaveLength(2)
  expectPublicHistory(realHarness.mainRequests[1])
  expect(JSON.stringify(realHarness.mainRequests[1])).toContain('Fictional complete reply.')
  expect(realHarness.sent).toEqual(['Fictional complete reply.','Fictional complete reply.'])
  expect((await query("SELECT channel_message_id FROM session_messages WHERE session_id=$1 AND role='assistant' AND channel_message_id=$2",[recovered,'reply-1008'])).rows).toEqual([{channel_message_id:'reply-1008'}])
  expect((await query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[recovered])).rows[0]).toEqual({status:'idle',turn_lease_token:null})
 })

 it('uses native proof for the current Work epoch while held legacy history retains its fallback',async()=>{
  expect(await nativeProof()).toMatchObject({proof:{admitted:true}})
  expect(await nativeProof(source)).toBeNull()
 })
 it.each([
  ['stopped policy',"UPDATE channel_recording_policies SET enabled=false WHERE session_id=$1","UPDATE channel_recording_policies SET enabled=true WHERE session_id=$1",()=>[[recovered],[recovered]]],
  ['changed epoch',"UPDATE channel_recording_policies SET revision=revision+1 WHERE session_id=$1","UPDATE channel_recording_policies SET revision=revision-1 WHERE session_id=$1",()=>[[recovered],[recovered]]],
  ['Personal destination mismatch',"UPDATE channel_recording_policies SET destination='personal' WHERE session_id=$1","UPDATE channel_recording_policies SET destination='workspace' WHERE session_id=$1",()=>[[recovered],[recovered]]],
  ['recorder mismatch',"UPDATE channel_integrations SET recording_owner_user_id=$2 WHERE id=$1","UPDATE channel_integrations SET recording_owner_user_id=$2 WHERE id=$1",()=>[[integration,other],[integration,owner]]],
  ['revoked integration',"UPDATE channel_integrations SET status='revoked' WHERE id=$1","UPDATE channel_integrations SET status='active' WHERE id=$1",()=>[[integration],[integration]]],
  ['revoked channel',"UPDATE channels SET status='revoked' WHERE id=$1","UPDATE channels SET status='active' WHERE id=$1",()=>[[channel],[channel]]],
  ['unrouted topic',"UPDATE channel_assistants SET external_surface_id=$2 WHERE channel_id=$1","UPDATE channel_assistants SET external_surface_id=$2 WHERE channel_id=$1",()=>[[channel,'-1000008241:topic:99'],[channel,conversation]]],
 ] as const)('keeps %s ineligible for native Work proof without asserting historical deletion',async(_label,mutate,restore,values)=>{
  const [mutateArgs,restoreArgs]=values()
  await query(mutate,[...mutateArgs])
  try{expect(await nativeProof()).toBeNull()}
  finally{await query(restore,[...restoreArgs])}
 })
 it.each([['sender',()=>other],['recorder',()=>owner]] as const)('rejects native Work proof after %s membership ends',async(_label,user)=>{
  const id=user()
  await query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspace,id])
  try{expect(await nativeProof()).toBeNull()}
  finally{await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')",[workspace,id,id===owner?'owner':'admin'])}
 })
 it.each(['null approver','revoked approver','missing audience type','invalid company-wide scope'] as const)('declines an applicable malformed binding: %s',async condition=>{
  const original=(await query('SELECT config FROM channel_integrations WHERE id=$1',[integration])).rows[0].config
  const invalid={...original.deliveryAudienceBindings[0]}
  if(condition==='null approver')invalid.approvedByUserId=null
  if(condition==='revoked approver')invalid.approvedByUserId=randomUUID()
  if(condition==='missing audience type')delete invalid.audienceType
  if(condition==='invalid company-wide scope')invalid.compartments=[`team:${randomUUID()}`]
  await query('UPDATE channel_integrations SET config=$2 WHERE id=$1',[integration,{...original,deliveryAudienceBindings:[...original.deliveryAudienceBindings,invalid]}])
  try{expect(await nativeProof()).toBeNull()}
  finally{await query('UPDATE channel_integrations SET config=$2 WHERE id=$1',[integration,original])}
 })
 it('serializes an exact-topic route insertion and then rejects the shadowed parent route',async()=>{
  const sibling=randomUUID()
  await query("INSERT INTO assistants(id,name,workspace_id,clearance) VALUES($1,'Fictional route replacement',$2,'internal')",[sibling,workspace])
  await query('UPDATE channel_assistants SET external_surface_id=$2 WHERE channel_id=$1',[channel,'-1000008241'])
  let insertion:Promise<unknown>|undefined,settled=false
  try{
   await nativeProof(recovered,undefined,async(value,pid)=>{
    expect(value).toMatchObject({proof:{admitted:true}})
    insertion=query('/* recording-native-route-phantom */ INSERT INTO channel_assistants(channel_id,assistant_id,external_surface_id) VALUES($1,$2,$3)',[channel,sibling,conversation])
    void insertion.then(()=>{settled=true},()=>{settled=true})
    await vi.waitFor(async()=>{
     const waiting=await query(`SELECT 1 FROM pg_stat_activity WHERE state='active'
       AND query LIKE '/* recording-native-route-phantom */%' AND $1=ANY(pg_blocking_pids(pid))`,[pid])
     expect(waiting.rows.length).toBeGreaterThan(0)
    },{timeout:1500,interval:20})
    expect(settled).toBe(false)
   })
   await insertion
   expect(await nativeProof()).toBeNull()
  }finally{
   await insertion?.catch(()=>undefined)
   await query('DELETE FROM channel_assistants WHERE channel_id=$1 AND assistant_id=$2',[channel,sibling])
   await query('UPDATE channel_assistants SET external_surface_id=$2 WHERE channel_id=$1',[channel,conversation])
   await query('DELETE FROM assistants WHERE id=$1',[sibling])
  }
 })
 it('refuses a held message reached beneath a genuine query-domain field root',async()=>{
  const fields=nativeQueries.flatMap(proof=>proof.fields)
  const domain=(await query("SELECT id FROM application_field_resources WHERE id=ANY($1::uuid[]) AND type_key='session_message' AND selection='query_domain' LIMIT 1",[fields.map(field=>field.resourceId)])).rows[0]
  expect(domain).toBeDefined()
  const root=fields.find(field=>field.resourceId===domain.id)!
  expect(await nativeProof(recovered,[root])).toMatchObject({admitted:true})
  const message=(await query('SELECT id FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',[recovered,'1001'])).rows[0].id
  await query('UPDATE session_messages SET scope_held=true WHERE id=$1',[message])
  try{
   const proof=await nativeProof(recovered,[root])
   expect(proof===null||proof.admitted===false).toBe(true)
   expect((await query('SELECT recording_privacy_held FROM sessions WHERE id=$1',[recovered])).rows[0].recording_privacy_held).toBe(false)
  }finally{await query('UPDATE session_messages SET scope_held=false WHERE id=$1',[message])}
 })
 it('withholds a reclassified message instead of reusing its old internal payload',async()=>{
  expect(JSON.stringify(await nativeProof())).toContain(question)
  const message=(await query('SELECT id FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',[recovered,'1001'])).rows[0].id
  await query("UPDATE session_messages SET sensitivity='confidential' WHERE id=$1",[message])
  try{expect(JSON.stringify(await nativeProof())).not.toContain(question)}
  finally{await query("UPDATE session_messages SET sensitivity='internal' WHERE id=$1",[message])}
 })

})
