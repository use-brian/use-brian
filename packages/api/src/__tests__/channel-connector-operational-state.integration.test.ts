/** [COMP:api/channel-recording] Operational connector progress must not cancel a
 * retained channel turn. Database admission, archive client, tool injection,
 * preparation, kernel, currentness and recording delivery are real. Only model
 * and archive HTTP transports are synthetic; no production database is used. */
import {randomBytes,randomUUID} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,it,onTestFinished,vi} from 'vitest'
import {createGeminiProvider,createRoutingProvider,wrapProvider} from '@use-brian/core'
import {getAppPool,getPool,query} from '../db/client.js'
import {admitTelegramRecording,changeChannelRecording,confirmChannelRecordingOwner,recordDeliveredTelegramMessage} from '../channel-recording.js'
import {createDbChannelIntegrationStore,encryptCredentials} from '../db/channel-integrations.js'
import {createConnectorInstanceStore,type ConnectorInstance} from '../db/connector-instance-store.js'
import {createConnectorGrantStore} from '../db/connector-grant-store.js'
import {createDbConnectorStore} from '../db/connector-store.js'
import {createDbMcpSettingsStore} from '../db/mcp-settings-store.js'
import {createDbAssistantConnectorStore} from '../db/assistant-connector-store.js'
import {createDbMemoryStore} from '../db/memory-store.js'
import {createDbCapabilityStore} from '../db/capability-store.js'
import {createDbLinkedAccountStore} from '../db/linked-accounts.js'
import {channelLinkBindsHere} from '../db/channel-user-store.js'
import {findAssistantById} from '../db/users.js'
import {createDecisionRuntime} from '../decision-runtime.js'
import {createChatArchiveTools} from '../chat-archive/chat-tools.js'
import {MessageStoreClient} from '../chat-archive/message-store-client.js'
import {processChannelMessage,type ChannelPipelineParams} from '../routes/channel-pipeline.js'
import {channelUserErrorText} from '../routes/_channel-error-text.js'

const {assertLocalFixture}=await import(new URL('../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const [owner,workspace,assistant,channel,integration]=Array.from({length:5},()=>randomUUID())
const conversation='-1000001001:topic:17',bot='987650001',sender='9100001001'
const key=randomBytes(32),instances=createConnectorInstanceStore(key),grants=createConnectorGrantStore()
const connectorStore=createDbConnectorStore(key),settings=createDbMcpSettingsStore()
const assistantConnectors=createDbAssistantConnectorStore(),linkedAccounts=createDbLinkedAccountStore()
const integrationStore=createDbChannelIntegrationStore(key),capabilityStore=createDbCapabilityStore()
const retainedMarker='The fictional observatory visit remains planned for Friday.'
const resultMarker='Fictional archive evidence: observatory meeting at ten.'
const finalText='I reviewed the three archive searches and found the mailbox search capability.'
const safeNotice="I couldn't share the reply in this chat because access to some information couldn't be verified. If you requested changes, they may already be saved. Check their status before repeating the request."
let sessionId:string,mailbox:ConnectorInstance,history:unknown,bindings:unknown
const historySnapshot=async()=>(await query(`SELECT id,role,content,sequence_num,channel_message_id,sender_user_id,
 sensitivity,compartments,project_ids,scope_version,scope_held FROM session_messages
 WHERE session_id=$1 AND channel_message_id=ANY($2::text[]) ORDER BY sequence_num`,[sessionId,['retained-question','retained-answer']])).rows
const bindingSnapshot=async()=>(await query(`SELECT s.user_id,s.assistant_id,s.visibility,s.effective_clearance,s.context_group_id,
 s.context_project_id,s.context_compartments,s.recording_policy_id,s.recording_revision,s.recording_privacy_held,
 ci.recording_owner_user_id,ci.config->'deliveryAudienceBindings' approval,
 (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.id) FROM connector_grant g WHERE g.connector_instance_id=$3) grants
 FROM sessions s JOIN channel_integrations ci ON ci.id=$2 WHERE s.id=$1`,[sessionId,integration,mailbox.id])).rows
const incoming=(id:string,text:string)=>admitTelegramRecording({integrationId:integration,conversationId:conversation,
 assistantId:assistant,providerMessageId:id,text,senderUserId:owner})
const delivered=(id:string,text:string)=>recordDeliveredTelegramMessage({channelId:conversation,providerMessageId:id,text,
 botId:bot,botUsername:'fictional_operational_bot'})
type ModelRequest={contents?:unknown;tools?:unknown;generationConfig?:{responseMimeType?:string;
 responseJsonSchema?:{properties?:{answers?:{properties?:Record<string,{properties:{value:{enum?:string[]}}}>}}}}}
const modelResponse=(parts:unknown[])=>new Response('data: '+JSON.stringify({candidates:[{content:{role:'model',parts},finishReason:'STOP'}],
 usageMetadata:{promptTokenCount:3,candidatesTokenCount:2}})+'\n\n',{headers:{'content-type':'text/event-stream'}})

describe.sequential('[COMP:api/channel-recording] connector operational progress during retained Telegram turns',()=>{
 beforeAll(async()=>{
  expect((await query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
   .toEqual({rolsuper:false,rolbypassrls:false})
  const app=await getAppPool().connect()
  try{expect((await app.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0])
   .toEqual({current_user:'app_user',rolsuper:false,rolbypassrls:false})}finally{app.release()}
  await query("INSERT INTO users(id,auth_provider,auth_provider_id,name) VALUES($1::uuid,'test',$1::text,'Fictional archive speaker')",[owner])
  await query("INSERT INTO workspaces(id,name,owner_user_id,plan,department_read_v2,project_shared_spaces) VALUES($1,'Fictional operational continuity',$2,'pro',true,false)",[workspace,owner])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspace,owner])
  await query("INSERT INTO assistants(id,name,workspace_id,clearance) VALUES($1,'Fictional continuity assistant',$2,'confidential')",[assistant,workspace])
  await linkedAccounts.upsert({userId:owner,assistantId:assistant,provider:'telegram',providerId:sender})
  await query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Fictional continuity bot')",[channel,workspace])
  const config={requireMentionOverrides:[{chatId:'-1000001001',topicId:17}],deliveryAudienceBindings:[{version:1,
   channelId:'-1000001001',clearance:'confidential',expiresAt:null,approvedAt:'2026-10-01T00:00:00Z',projectIds:[],
   audienceType:'group',compartments:[],companyWide:true,recipientUserId:null,approvedByUserId:owner}]}
  await query("INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id,config) VALUES($1,$2,'telegram',$3,$4,$5)",
   [integration,channel,encryptCredentials({bot_token:'fictional-operational-bot',webhook_secret:'fictional-operational-hook'},key),bot,config])
  await query('INSERT INTO channel_assistants(channel_id,assistant_id,external_surface_id) VALUES($1,$2,$3)',[channel,assistant,conversation])
  await confirmChannelRecordingOwner(integration,owner)
  const personal=await incoming('initial-personal','Create a recording for this fictional conversation.')
  expect(personal).not.toBeNull()
  await changeChannelRecording({integrationId:integration,actorId:owner,id:personal!.policy.id,revision:personal!.policy.revision,
   enabled:true,destination:'workspace',projectId:null})
  const retained=await incoming('retained-question',retainedMarker)
  sessionId=retained!.session.id
  await delivered('retained-answer','The fictional Friday plan is recorded.')
  mailbox=await instances.createUserInstance({userId:owner,createdBy:owner,provider:'imap',label:'Fictional mailbox',custom:false,
   connected:true,credentials:{type:'imap',email:'reader@example.invalid',appPassword:'fictional-password',imapHost:'imap.example.invalid',imapPort:993,smtpHost:'smtp.example.invalid',smtpPort:465},
   config:{mailboxIdle:{status:'connected',since:'2030-01-01T00:00:00Z',lastEventAt:null,lastError:null}}})
  await grants.create({actingUserId:owner,connectorInstanceId:mailbox.id,targetType:'workspace',targetId:workspace,compartments:[],projectIds:[]})
  await assistantConnectors.setEnabled(assistant,'imap',true)
  history=await historySnapshot();expect(history).toHaveLength(2)
  bindings=await bindingSnapshot()
 },30_000)
 afterAll(async()=>{
  vi.unstubAllGlobals()
  // The owned clone is disposed by the maintained fixture runner. Keep immutable
  // recording ancestry intact until that complete database cleanup.
  await getAppPool().end();await getPool().end()
 })

 async function runTurn(id:string,authorityChange:boolean){
  const mainRequests:ModelRequest[]=[],archiveOwners:string[]=[],sent:string[]=[],errors:Error[]=[],notices:string[]=[]
  const abortController=new AbortController();let pending:Promise<void>|undefined
  onTestFinished(async()=>{abortController.abort();await pending?.catch(()=>undefined);vi.unstubAllGlobals()})
  const provider=createRoutingProvider({gemini:wrapProvider(createGeminiProvider({kind:'ai-studio',
   endpoint:model=>`https://operational-model.example/models/${model}`,headers:async()=>({})}))})
  const archive=new MessageStoreClient({baseUrl:'https://archive.example',secret:'fictional-archive-signature',fetchImpl:async(raw,init)=>{
   expect(String(raw)).toBe('https://archive.example/search')
   const body=JSON.parse(String(init?.body));archiveOwners.push(body.owner_user_id)
   return Response.json({hits:[{instance_id:'fictional-archive',conversation_id:'fictional-room',source:'whatsapp',
    segment_text:resultMarker}],embedding_coverage:{partial:false,pending:0,capped:false,note:'complete'}})
  }})
  vi.stubGlobal('fetch',vi.fn(async(raw:unknown,init?:RequestInit)=>{
   const url=new URL(String(raw));expect(url.origin).toBe('https://operational-model.example')
   const request=JSON.parse(String(init?.body)) as ModelRequest
   const main=url.pathname.endsWith('/gemini-3.6-flash')&&request.generationConfig?.responseMimeType!=='application/json'
   if(main){
    mainRequests.push(request)
    expect(JSON.stringify(request.contents)).toContain(retainedMarker)
    const round=mainRequests.length
    if(round<=3)return modelResponse([{functionCall:{id:`archive-${id}-${round}`,name:'searchChatHistory',args:{query:`fictional observatory ${round}`}},thoughtSignature:`fictional-${round}`}])
    expect(archiveOwners).toEqual([owner,owner,owner])
    if(round===4){
     expect(JSON.stringify(request.contents)).toContain(resultMarker)
     await instances.setConfigSystem(mailbox.id,authorityChange?{authorityBoundary:'changed'}:
      {mailboxIdle:{status:'reconnecting',since:'2030-01-01T00:05:00Z',lastEventAt:null,lastError:'Fictional connection closed'}})
     return modelResponse([{functionCall:{id:`discovery-${id}`,name:'mcp_search',args:{query:'search mailbox emails',limit:1}},thoughtSignature:'fictional-discovery'}])
    }
    expect(round).toBe(5)
    expect(JSON.stringify(request.contents)).toContain('mcp_search')
    expect(JSON.stringify(request.contents)).toContain('functionResponse')
    expect(JSON.stringify(request.contents)).toContain('imapSearchMessages')
    return modelResponse([{text:finalText}])
   }
   const properties=request.generationConfig?.responseJsonSchema?.properties?.answers?.properties
   const text=properties?JSON.stringify({answers:Object.fromEntries(Object.entries(properties).map(([field,value])=>{
    const choices=value.properties.value.enum??[]
    return[field,{value:['ordinary','continue','__new_topic__','none'].find(candidate=>choices.includes(candidate))??choices[0]}]
   }))}):'{"research":false,"operate_site":false,"reason":null,"topic_label":"fictional","state":"continue","confidence":1}'
   return modelResponse([{text}])
  }))
  const messageText='Review the archived messages and find the mailbox search capability.'
  const recording=await incoming(id,messageText);expect(recording!.session.id).toBe(sessionId)
  const selected=await findAssistantById(assistant),linked=await linkedAccounts.findByProvider('telegram',sender)
  expect(linked!.userId).toBe(owner)
  const senderLinkedIdentity=await channelLinkBindsHere(linked,assistant,owner,workspace);expect(senderLinkedIdentity).toBe(true)
  const publishSessionEvent=vi.fn(),onCleanup=vi.fn(async()=>{})
  pending=processChannelMessage({recording,admittedAnswerContext:{kind:'continue'},assistant:selected!,userId:owner,ownerId:owner,
   isIdentified:true,senderLinkedIdentity,externalGuest:false,channelType:'telegram',channelId:conversation,isGroupChat:true,
   channelIntegrationId:integration,channelIntegrationStore:integrationStore,incomingChannelMessageId:id,messageText,
   userContentBlocks:[{type:'text',text:messageText}],abortController,modelAlias:'standard',adaptiveResearchEnabled:false,
   decisionRuntime:createDecisionRuntime({llmProvider:provider,defaultLlmModel:'gemini-3.6-flash-standard'}),
   configuredProviders:new Set(['gemini']),provider,systemPrompt:'Use the supplied archive tools and then discover mailbox search.',
   tools:new Map(createChatArchiveTools({client:archive}).map(tool=>[tool.name,tool])),memoryStore:createDbMemoryStore(),capabilityStore,
   connectorStore,mcpSettingsStore:settings,assistantConnectorStore:assistantConnectors,connectorInstanceStore:instances,connectorGrantStore:grants,
   publishSessionEvent,hooks:{onCleanup,onConfirmationRequired:async()=>{throw new Error('Read-only discovery unexpectedly requested confirmation')},
    sendError:async(error:Error)=>{errors.push(error);notices.push(channelUserErrorText(error))},
    sendResponse:async(text:string)=>{sent.push(text);await delivered(`reply-${id}`,text);return{channelMessageId:`reply-${id}`}}}
  } as unknown as ChannelPipelineParams)
  await pending
  return{mainRequests,archiveOwners,sent,errors,notices,publishSessionEvent,onCleanup}
 }

 it('delivers after three archive searches and MCP discovery despite ordinary mailbox status progress',async()=>{
  const result=await runTurn('operational-positive',false)
  expect(result.errors).toEqual([]);expect(result.notices).toEqual([])
  expect(result.archiveOwners).toEqual([owner,owner,owner]);expect(result.mainRequests).toHaveLength(5)
  expect(result.sent).toEqual([finalText]);expect(result.onCleanup).toHaveBeenCalledOnce()
  const reply=(await query('SELECT role,content FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',[sessionId,'reply-operational-positive'])).rows
  expect(reply).toEqual([{role:'assistant',content:[{type:'text',text:finalText}]}])
  expect(result.publishSessionEvent).toHaveBeenCalledWith({kind:'turn_completed',sessionId,payload:{senderUserId:owner}})
  expect(await historySnapshot()).toEqual(history);expect(await bindingSnapshot()).toEqual(bindings)
  expect((await query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[sessionId])).rows[0]).toEqual({status:'idle',turn_lease_token:null})
 },90_000)
 it('refuses a genuine connector configuration change and sends a fixed safe terminal notice',async()=>{
  const result=await runTurn('authority-negative',true)
  expect(result.archiveOwners).toEqual([owner,owner,owner]);expect(result.mainRequests).toHaveLength(4)
  expect(result.sent).toEqual([]);expect(result.errors).toHaveLength(1);expect(result.onCleanup).toHaveBeenCalledOnce()
  expect(result.errors[0].name).toBe('AuthorityChangedError');expect(result.notices).toEqual([safeNotice])
  expect((await query('SELECT id FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',[sessionId,'reply-authority-negative'])).rows).toEqual([])
  expect(await historySnapshot()).toEqual(history);expect(await bindingSnapshot()).toEqual(bindings)
  expect((await query('SELECT status,turn_lease_token,turn_end_reason FROM sessions WHERE id=$1',[sessionId])).rows[0]).toEqual({status:'failed',turn_lease_token:null,turn_end_reason:'failed'})
 },90_000)
})
