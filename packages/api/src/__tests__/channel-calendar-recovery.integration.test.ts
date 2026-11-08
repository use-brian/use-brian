/** [COMP:api/channel-recording] A real connected Calendar read reaches the next
 * managed model request and Telegram delivery after large-history recovery.
 * Only Google/model HTTP is synthetic; injection, policy, preparation, kernel,
 * source admission, publication and the receiving adapter remain real. */
import {randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll,beforeAll,describe,expect,it,onTestFinished,vi} from 'vitest'
import {createGeminiProvider,createRoutingProvider,wrapProvider} from '@use-brian/core'
import {getAppPool,getPool,query,queryWithRLS} from '../db/client.js'
import {admitTelegramRecording,recordDeliveredTelegramMessage} from '../channel-recording.js'
import {applyTelegramRecordingRecovery} from '../channel-recording-recovery.js'
import {createDbChannelIntegrationStore,encryptCredentials} from '../db/channel-integrations.js'
import {createConnectorInstanceStore,type ConnectorInstance} from '../db/connector-instance-store.js'
import {createConnectorGrantStore} from '../db/connector-grant-store.js'
import {createDbConnectorStore} from '../db/connector-store.js'
import {createDbMcpSettingsStore} from '../db/mcp-settings-store.js'
import {createDbAssistantConnectorStore} from '../db/assistant-connector-store.js'
import {createDbMemoryStore} from '../db/memory-store.js'
import {createDbCapabilityStore} from '../db/capability-store.js'
import {createMemory} from '../db/memories.js'
import {createDbLinkedAccountStore} from '../db/linked-accounts.js'
import {channelLinkBindsHere} from '../db/channel-user-store.js'
import {findAssistantById} from '../db/users.js'
import {createDecisionRuntime} from '../decision-runtime.js'
import {_resetConnectorConfigCache} from '../connector-config.js'
import {processChannelMessage,type ChannelPipelineParams} from '../routes/channel-pipeline.js'

const {assertLocalFixture}=await import(new URL('../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const [owner,workspace,assistant,channel,integration,legacy]=Array.from({length:6},()=>randomUUID())
const conversation='-1000008246:topic:26',historyRows=255,privateRows=289
const timeMin='2030-12-09T00:00:00Z',timeMax='2030-12-10T00:00:00Z'
const eventMarker='Fictional observatory planning meeting'
const finalText=`Your calendar has ${eventMarker} on December 9 at 10:00 UTC.`
const credentialKey=randomBytes(32),instances=createConnectorInstanceStore(credentialKey)
const connectorStore=createDbConnectorStore(credentialKey),grants=createConnectorGrantStore()
const settings=createDbMcpSettingsStore(),assistantConnectors=createDbAssistantConnectorStore()
const integrationStore=createDbChannelIntegrationStore(credentialKey)
const linkedAccounts=createDbLinkedAccountStore(),telegramSender='91000082463'
let recovered:string,calendar:ConnectorInstance,configDirectory:string

type ModelRequest={contents?:Array<{role?:string;parts?:Array<Record<string,unknown>>}>;tools?:unknown;generationConfig?:{
 responseMimeType?:string;responseJsonSchema?:{properties?:{answers?:{properties?:Record<string,{properties:{value:{enum?:string[];type:string}}}>}}}
}}
function modelResponse(parts:unknown[]){
 return new Response('data: '+JSON.stringify({candidates:[{content:{role:'model',parts},finishReason:'STOP'}],
  usageMetadata:{promptTokenCount:3,candidatesTokenCount:2}})+'\n\n',{headers:{'content-type':'text/event-stream'}})
}

describe.sequential('[COMP:api/channel-recording] recovered Telegram Calendar continuation',()=>{
 beforeAll(async()=>{
  // Resolve the real connector config through its public file port, isolated
  // from any developer account or deployment credentials on this machine.
  configDirectory=await mkdtemp(join(tmpdir(),'brian-calendar-recovery-'))
  const configPath=join(configDirectory,'connectors.config.json')
  await writeFile(configPath,JSON.stringify({google:{clientId:'fictional-calendar-client',clientSecret:'fictional-calendar-secret'}}))
  vi.stubEnv('CONNECTORS_CONFIG_PATH',configPath);_resetConnectorConfigCache()
  await query("INSERT INTO users(id,auth_provider,auth_provider_id,name) VALUES($1::uuid,'test',$1::text,'Fictional calendar speaker')",[owner])
  await query("INSERT INTO workspaces(id,name,owner_user_id,plan) VALUES($1,'Fictional Calendar recovery',$2,'pro')",[workspace,owner])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspace,owner])
  await query("INSERT INTO assistants(id,name,workspace_id,clearance) VALUES($1,'Fictional Calendar assistant',$2,'internal')",[assistant,workspace])
  await linkedAccounts.upsert({userId:owner,assistantId:assistant,provider:'telegram',providerId:telegramSender})
  await query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Fictional Calendar bot')",[channel,workspace])
  const config={requireMentionOverrides:[{chatId:'-1000008246',topicId:26}],deliveryAudienceBindings:[{version:1,
   channelId:'-1000008246',clearance:'internal',expiresAt:null,approvedAt:'2026-10-01T00:00:00Z',projectIds:[],
   audienceType:'group',compartments:[],companyWide:true,recipientUserId:null,approvedByUserId:owner}]}
  await query("INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id,config) VALUES($1,$2,'telegram',$3,'987658246',$4)",
   [integration,channel,encryptCredentials({bot_token:'fictional-calendar-bot',webhook_secret:'fictional-calendar-hook'},credentialKey),config])
  await query('INSERT INTO channel_assistants(channel_id,assistant_id,external_surface_id) VALUES($1,$2,$3)',[channel,assistant,conversation])
  await query(`INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id,visibility,anchor_kind,anchor_ref,effective_clearance,clearance_source,title)
   VALUES($1,$2,$3,$4,'telegram',$5,'workspace','channel',$5,'internal','anchor','Fictional Calendar legacy history')`,[legacy,assistant,owner,workspace,conversation])
  // Same isolated old-writer setup as the recovery boundary suite. Product
  // recovery performs the actual reviewed copy into a new recording epoch.
  await query('ALTER TABLE session_messages DISABLE TRIGGER aaab_recording_privacy_message')
  try{
   await query(`INSERT INTO session_messages(session_id,role,content,sequence_num,channel_message_id,sender_user_id,
    workspace_id,sensitivity,compartments,project_ids,scope_version,scope_held)
    SELECT $1,CASE WHEN n%2=0 THEN 'user' ELSE 'assistant' END,
     jsonb_build_array(jsonb_build_object('type','text','text','Fictional Calendar retained turn '||n||'.')),
     n,(n+2000)::text,CASE WHEN n%2=0 THEN $3::uuid ELSE NULL END,$2,'internal','{}','{}',1,false
    FROM generate_series(1,$4::int) n`,[legacy,workspace,owner,historyRows])
   await query(`INSERT INTO session_messages(session_id,role,content,sequence_num,workspace_id,sensitivity,compartments,project_ids,scope_version,scope_held)
    VALUES($1,'assistant','[{"type":"text","text":"PRIVATE_UNDELIVERED_CALENDAR_HISTORY"}]',256,$2,'internal','{}','{}',1,false)`,[legacy,workspace])
  }finally{await query('ALTER TABLE session_messages ENABLE TRIGGER aaab_recording_privacy_message')}
  const preview=(await queryWithRLS(owner,'SELECT preview_telegram_recording_recovery($1,$2,$3) AS value',[owner,workspace,channel])).rows[0].value
  const candidate=preview.candidates.find((row:{sessionId:string})=>row.sessionId===legacy)
  expect(candidate).toMatchObject({messageCount:historyRows,skippedMessageCount:1})
  recovered=(await applyTelegramRecordingRecovery({actorId:owner,workspaceId:workspace,channelId:channel,sessionId:legacy,snapshotToken:candidate.snapshotToken})).sessionId
  expect(recovered).not.toBe(legacy)
  for(let n=1;n<=privateRows;n++)await createMemory({workspaceId:workspace,userId:owner,assistantId:assistant,createdByUserId:owner,
   scope:n%3===0?'workspace':'shared',summary:`PRIVATE_CALENDAR_MEMORY_${n}`,sensitivity:'internal'})
  await query(`UPDATE memories SET valid_from=now()-interval '2 days',scope_held=n.value BETWEEN 69 AND 70,
   valid_to=CASE WHEN n.value NOT IN(1,2,3,69,70) THEN now()-interval '1 day' ELSE NULL END
   FROM(SELECT id,substring(summary from 'PRIVATE_CALENDAR_MEMORY_([0-9]+)$')::int value FROM memories WHERE workspace_id=$1) n
   WHERE memories.id=n.id`,[workspace])
  expect((await query(`SELECT count(*)::int total,count(*) FILTER(WHERE user_id IS NOT NULL)::int private,
   count(*) FILTER(WHERE valid_to IS NULL AND NOT scope_held)::int current,count(*) FILTER(WHERE scope_held)::int held
   FROM memories WHERE workspace_id=$1`,[workspace])).rows[0]).toEqual({total:privateRows,private:privateRows,current:3,held:2})
  calendar=await instances.createUserInstance({userId:owner,createdBy:owner,provider:'gcal',label:'Fictional speaker Calendar',custom:false,
   connected:true,credentials:{type:'oauth',client_id:'google_refresh',client_secret:'fictional-speaker-refresh'}})
  await grants.create({actingUserId:owner,connectorInstanceId:calendar.id,targetType:'workspace',targetId:workspace,compartments:[],projectIds:[]})
  await assistantConnectors.setEnabled(assistant,'gcal',true)
  await settings.setPolicy({assistantId:assistant,userId:owner,serverName:'gcal',toolName:'googleCalendarListEvents',policy:'allow',classification:'read'})
 })
 afterAll(async()=>{
  vi.unstubAllGlobals();vi.unstubAllEnvs();_resetConnectorConfigCache()
  try{
   if(calendar)await instances.delete(owner,calendar.id)
   await query('DELETE FROM workspaces WHERE id=$1',[workspace])
   await query('DELETE FROM users WHERE id=$1',[owner])
  }finally{
   if(configDirectory)await rm(configDirectory,{recursive:true,force:true})
   await getAppPool().end();await getPool().end()
  }
 })

 async function runCalendarTurn(id:string,change?:'disconnect-before-tool'|'hold-before-continuation'){
  const mainRequests:ModelRequest[]=[],googleRequests:URL[]=[],sent:string[]=[],oauthTokens:string[]=[]
  const milestones:Array<{phase:string;elapsedMs:number}>=[],started=performance.now()
  const mark=(phase:string)=>milestones.push({phase,elapsedMs:Math.round(performance.now()-started)})
  const abortController=new AbortController()
  let pending:Promise<void>|undefined
  onTestFinished(async()=>{abortController.abort();await pending?.catch(()=>undefined)})
  const provider=createRoutingProvider({gemini:wrapProvider(createGeminiProvider({kind:'ai-studio',endpoint:model=>`https://calendar-model.example/models/${model}`,headers:async()=>({})}))})
  vi.stubGlobal('fetch',vi.fn(async(raw:unknown,init?:RequestInit)=>{
   const url=new URL(String(raw))
   if(url.href==='https://oauth2.googleapis.com/token'){
    oauthTokens.push(new URLSearchParams(String(init?.body)).get('refresh_token')??'')
    return Response.json({access_token:'fictional-speaker-access',expires_in:3600,token_type:'Bearer'})
   }
   if(url.origin==='https://www.googleapis.com'&&url.pathname==='/calendar/v3/calendars/primary/events'){
    googleRequests.push(url);mark('calendar-http')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fictional-speaker-access')
    expect(url.searchParams.get('timeMin')).toBe(timeMin);expect(url.searchParams.get('timeMax')).toBe(timeMax)
    if(change==='hold-before-continuation')await query('UPDATE session_messages SET scope_held=true WHERE session_id=$1 AND sequence_num=1',[recovered])
    return Response.json({items:[{id:'fictional-event',summary:eventMarker,start:{dateTime:'2030-12-09T10:00:00Z'},end:{dateTime:'2030-12-09T11:00:00Z'}}]})
   }
   // This allowlist guarantees the test can never make a live provider request.
   expect(url.origin).toBe('https://calendar-model.example')
   const request=JSON.parse(String(init?.body)) as ModelRequest
   const main=url.pathname.endsWith('/gemini-3.6-flash')&&request.generationConfig?.responseMimeType!=='application/json'
   if(main){
    mainRequests.push(request);mark(mainRequests.length===1?'first-model-wire':'continuation-model-wire')
    expect(JSON.stringify(request)).not.toContain('PRIVATE_')
    expect(JSON.stringify(request)).toContain(`Fictional Calendar retained turn ${historyRows}.`)
    if(mainRequests.length===1){
     expect(JSON.stringify(request.tools)).toContain('mcp_call')
     if(change==='disconnect-before-tool')await instances.setConnectedSystem(calendar.id,false)
     return modelResponse([{functionCall:{id:'calendar-read',name:'mcp_call',args:{server:'gcal',tool:'googleCalendarListEvents',args:{calendarId:'primary',timeMin,timeMax}}},thoughtSignature:'fictional-calendar-signature'}])
    }
    expect(mainRequests).toHaveLength(2)
    expect(googleRequests).toHaveLength(1)
    expect(JSON.stringify(request.contents)).toContain(eventMarker)
    expect(JSON.stringify(request.contents)).toContain('functionResponse')
    return modelResponse([{text:finalText}])
   }
   const properties=request.generationConfig?.responseJsonSchema?.properties?.answers?.properties
   const text=properties?JSON.stringify({answers:Object.fromEntries(Object.entries(properties).map(([key,field])=>{
    const values=field.properties.value.enum??[]
    return[key,{value:['ordinary','continue','__new_topic__','none'].find(value=>values.includes(value))??values[0]}]
   }))}):'{"research":false,"operate_site":false,"reason":null,"topic_label":"fictional","state":"continue","confidence":1}'
   return modelResponse([{text}])
  }))
  const recording=await admitTelegramRecording({integrationId:integration,conversationId:conversation,assistantId:assistant,providerMessageId:id,
   text:'Check my calendar for December 9 and tell me the meeting.',senderUserId:owner})
  expect(recording?.session.id).toBe(recovered)
  const selected=await findAssistantById(assistant);expect(selected).not.toBeNull()
  const linked=await linkedAccounts.findByProvider('telegram',telegramSender);expect(linked).not.toBeNull()
  expect(linked!.userId).toBe(owner)
  const senderLinkedIdentity=await channelLinkBindsHere(linked,assistant,owner,workspace)
  expect(senderLinkedIdentity).toBe(true)
  const isIdentified=linked!.userId===owner&&senderLinkedIdentity
  pending=processChannelMessage({recording,admittedAnswerContext:{kind:'continue'},assistant:selected!,userId:owner,ownerId:owner,
   isIdentified,senderLinkedIdentity,externalGuest:false,channelType:'telegram',channelId:conversation,isGroupChat:true,
   channelIntegrationId:integration,channelIntegrationStore:integrationStore,incomingChannelMessageId:id,
   messageText:'Check my calendar for December 9 and tell me the meeting.',userContentBlocks:[{type:'text',text:'Check my calendar for December 9 and tell me the meeting.'}],
   abortController,modelAlias:'standard',adaptiveResearchEnabled:false,
   decisionRuntime:createDecisionRuntime({llmProvider:provider,defaultLlmModel:'gemini-3.6-flash-standard'}),configuredProviders:new Set(['gemini']),provider,
   systemPrompt:'Use the actual Calendar read tool for this fictional request.',tools:new Map(),memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore(),
   connectorStore,mcpSettingsStore:settings,assistantConnectorStore:assistantConnectors,connectorInstanceStore:instances,connectorGrantStore:grants,
   hooks:{onConfirmationRequired:async()=>{throw new Error('Read-only Calendar request unexpectedly required confirmation')},sendError:async(error:Error)=>{throw error},
    sendResponse:async(text:string)=>{mark('telegram-delivery');sent.push(text)
     await recordDeliveredTelegramMessage({channelId:conversation,providerMessageId:`calendar-reply-${id}`,text,botId:'987658246',botUsername:'fictional_calendar_bot'})
     return{channelMessageId:`calendar-reply-${id}`}}}} as unknown as ChannelPipelineParams)
  let error:unknown
  try{await pending}catch(caught){error=caught}finally{mark('turn-finished')}
  const failure=error as {name?:string;code?:string;reason?:string;diagnostic?:string;verificationPhase?:string;verificationSqlstateClass?:string}|undefined
  console.info('[recovered Telegram Calendar timing]',{historyRows,privateRows,milestones,
   failure:failure?{name:failure.name,code:failure.code,reason:failure.reason,diagnostic:failure.diagnostic,
    verificationPhase:failure.verificationPhase,verificationSqlstateClass:failure.verificationSqlstateClass}:undefined})
  return{mainRequests,googleRequests,oauthTokens,sent,error,elapsedMs:performance.now()-started}
 }

 it('executes the connected speaker Calendar read and delivers its actual result after a second model request',async()=>{
  const result=await runCalendarTurn('3101')
  expect(result.error).toBeUndefined()
  expect(result.mainRequests).toHaveLength(2);expect(result.googleRequests).toHaveLength(1)
  expect(result.oauthTokens.length).toBeGreaterThan(0)
  expect(result.oauthTokens.every(token=>token==='fictional-speaker-refresh')).toBe(true)
  expect(result.sent).toEqual([finalText])
  const rows=(await query(`SELECT role,channel_message_id,content,sender_user_id FROM session_messages
   WHERE session_id=$1 AND channel_message_id=ANY($2::text[]) ORDER BY sequence_num`,[recovered,['3101','calendar-reply-3101']])).rows
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({role:'user',channel_message_id:'3101',sender_user_id:owner})
  expect(rows[1]).toMatchObject({role:'assistant',channel_message_id:'calendar-reply-3101'})
  expect(JSON.stringify(rows[1].content)).toContain(eventMarker)
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_')
  expect((await query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[recovered])).rows[0]).toEqual({status:'idle',turn_lease_token:null})
 },90_000)
 it('withdraws a disconnected account before the emitted Calendar call reaches Google',async()=>{
  try{
   const result=await runCalendarTurn('3102','disconnect-before-tool')
   expect(result.mainRequests).toHaveLength(1);expect(result.googleRequests).toHaveLength(0)
   expect(JSON.stringify(result.sent)).not.toContain(eventMarker)
  }finally{await instances.setConnectedSystem(calendar.id,true)}
 },90_000)
 it('withholds the second provider request after a source hold during the actual Calendar response',async()=>{
  const result=await runCalendarTurn('3103','hold-before-continuation')
  expect(result.mainRequests).toHaveLength(1);expect(result.googleRequests).toHaveLength(1)
  expect(JSON.stringify(result.sent)).not.toContain(eventMarker)
  expect((await query('SELECT id FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',[recovered,'calendar-reply-3103'])).rows).toEqual([])
 },90_000)
})
