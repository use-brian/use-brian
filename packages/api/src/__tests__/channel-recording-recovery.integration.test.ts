/** [COMP:api/channel-recording] Reviewed history reaches the model and delivery. */
import {randomUUID,randomBytes} from 'node:crypto'
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest'
import {getAppPool,getPool,query,queryWithRLS} from '../db/client.js'
import {admitTelegramRecording,recordDeliveredTelegramMessage} from '../channel-recording.js'
import {createDbChannelIntegrationStore,encryptCredentials} from '../db/channel-integrations.js'
import {applyTelegramRecordingRecovery} from '../channel-recording-recovery.js'
import {processChannelMessage,type ChannelPipelineParams} from '../routes/channel-pipeline.js'
import {createDbMemoryStore} from '../db/memory-store.js'
import {createDbCapabilityStore} from '../db/capability-store.js'
import {findAssistantById} from '../db/users.js'
const {runTurn,inject}=vi.hoisted(()=>({runTurn:vi.fn(),inject:vi.fn()}))
vi.mock('../turn/kernel.js',async original=>({...await original<typeof import('../turn/kernel.js')>(),runAssistantTurn:runTurn}))
vi.mock('../turn/prepare.js',()=>({prepareAssistantRun:vi.fn(async input=>({model:input.model,tools:input.candidateTools,trustedContext:'',userVisibleContext:''}))}))
vi.mock('../mcp/inject.js',()=>({injectMcpTools:inject}))
const {assertLocalFixture}=await import(new URL('../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const [owner,other,workspace,assistant,channel,integration,source]=Array.from({length:7},()=>randomUUID())
const conversation='-1000008241:topic:24',question='Our fictional meeting is December 9.',answer='The fictional meeting date is recorded.'
const credentialKey=randomBytes(32),integrationStore=createDbChannelIntegrationStore(credentialKey)
let recovered:string

describe.sequential('[COMP:api/channel-recording] recovered public history reaches Telegram',()=>{
 beforeAll(async()=>{
  await query(`INSERT INTO users(id,auth_provider,auth_provider_id,name) SELECT id,'test',id::text,'Fictional recorder' FROM unnest($1::uuid[]) id`,[[owner,other]])
  await query("INSERT INTO workspaces(id,name,owner_user_id,plan) VALUES($1,'Fictional recovery',$2,'pro')",[workspace,owner])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'admin','confidential')",[workspace,owner,other])
  await query("INSERT INTO assistants(id,name,workspace_id,clearance) VALUES($1,'Fictional recovery assistant',$2,'internal')",[assistant,workspace])
  await query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Fictional recovery bot')",[channel,workspace])
  const config={requireMentionOverrides:[{chatId:'-1000008241',topicId:24}],deliveryAudienceBindings:[{version:1,channelId:'-1000008241',clearance:'internal',expiresAt:null,approvedAt:'2026-10-01T00:00:00Z',projectIds:[],audienceType:'group',compartments:[],recipientUserId:null,approvedByUserId:owner}]}
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
  }finally{await query('ALTER TABLE session_messages ENABLE TRIGGER aaab_recording_privacy_message')}
 })
 afterAll(async()=>{vi.restoreAllMocks();await getAppPool().end();await getPool().end()})
 it('publishes reviewed text into a new epoch and leaves original history held',async()=>{
  const p=await queryWithRLS(owner,'SELECT preview_telegram_recording_recovery($1,$2,$3) AS value',[owner,workspace,channel])
  const candidate=p.rows[0].value.candidates.find((r:{sessionId:string})=>r.sessionId===source)
  expect(candidate).toMatchObject({messageCount:2,skippedMessageCount:2})
  const r=await applyTelegramRecordingRecovery({actorId:owner,workspaceId:workspace,channelId:channel,sessionId:source,snapshotToken:candidate.snapshotToken})
  recovered=r.sessionId
  expect(recovered).not.toBe(source)
  expect((await query('SELECT recording_privacy_held FROM sessions WHERE id=$1',[source])).rows[0]).toEqual({recording_privacy_held:true})
 })
 it('runs normal history, sender account-tool authority, final delivery and follow-up',async()=>{
  const failures:string[]=[]
  vi.spyOn(console,'error').mockImplementation((...args)=>failures.push(args.map(String).join(' ')))
  const injections:Array<{actorIdentity:{userId:string}}>=[]
  inject.mockImplementation(async input=>{injections.push(input);input.tools.set('fictionalCalendarRead',{name:'fictionalCalendarRead',description:'Fictional read',inputSchema:{type:'object',properties:{}},execute:async()=>({content:'Fixture'})});return{unavailable:[],searchableSources:[]}})
  const final={content:[{type:'text',text:'The fictional date is December 9.'}],stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1},model:'fixture'}
  runTurn.mockImplementation(async({sink})=>{await sink.onEvent({type:'assistant_turn',response:final,toolResults:[]});await sink.onEvent({type:'turn_complete',response:final});return{finalText:final.content[0].text}})
  const sent:string[]=[],provider={name:'fixture',models:[],async *stream(){yield{type:'text_delta',text:'{"topic_label":"fictional","confidence":1}'}},createSession(){return{send:()=>this.stream()}}}
  async function turn(id:string,text:string){
   const recording=await admitTelegramRecording({integrationId:integration,conversationId:conversation,assistantId:assistant,providerMessageId:id,text,senderUserId:other})
   expect(recording?.session.id).toBe(recovered)
   const selectedAssistant=await findAssistantById(assistant)
   expect(selectedAssistant).not.toBeNull()
   await processChannelMessage({recording,admittedAnswerContext:{kind:'continue'},assistant:selectedAssistant!,
    userId:other,ownerId:owner,isIdentified:true,senderLinkedIdentity:true,externalGuest:false,channelType:'telegram',channelId:conversation,isGroupChat:true,channelIntegrationId:integration,channelIntegrationStore:integrationStore,
    incomingChannelMessageId:id,messageText:text,userContentBlocks:[{type:'text',text}],abortController:new AbortController(),modelAlias:'standard',provider,systemPrompt:'Fixture prompt',tools:new Map(),memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore(),connectorStore:{},mcpSettingsStore:{},
    hooks:{onConfirmationRequired:async()=>{},sendError:async(error:Error)=>{throw error},sendResponse:async(text:string)=>{sent.push(text);await recordDeliveredTelegramMessage({channelId:conversation,providerMessageId:`reply-${id}`,text,botId:'987658241',botUsername:'fictional_recovery_bot'});return{channelMessageId:`reply-${id}`}}}} as unknown as ChannelPipelineParams)
  }
  await turn('1005','What date did we agree?')
  expect(runTurn).toHaveBeenCalledOnce()
  const first=runTurn.mock.calls[0][0]
  expect(JSON.stringify(first.loop.messages)).toContain(question)
  expect(JSON.stringify(first.loop.messages)).toContain(answer)
  expect(JSON.stringify(first.loop.messages)).not.toContain('PRIVATE_')
  expect(first.loop.tools.has('fictionalCalendarRead'),failures.join('\n')).toBe(true)
  expect(first.loop.context.userId).toBe(other)
  expect(injections[0].actorIdentity.userId).toBe(other)
  expect(sent).toEqual([final.content[0].text])
  await turn('1006','Remind me again.')
  expect(runTurn).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(runTurn.mock.calls[1][0].loop.messages)).toContain('What date did we agree?')
  expect(JSON.stringify(runTurn.mock.calls[1][0].loop.messages)).toContain(final.content[0].text)
  expect((await query("SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1 AND role='assistant'",[recovered])).rows[0].count).toBeGreaterThan(1)
 })
})
