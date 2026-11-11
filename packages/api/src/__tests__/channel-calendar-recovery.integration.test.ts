/** [COMP:api/channel-recording] A real connected Calendar read reaches the next
 * managed model request and Telegram delivery after large-history recovery.
 * Google/model HTTP and blob storage are synthetic; injection, policy, preparation, kernel,
 * source admission, publication and the receiving adapter remain real. */
import {randomBytes,randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll,beforeAll,describe,expect,it,onTestFinished,vi} from 'vitest'
import {ContextScopeAccumulator,createGeminiProvider,createRoutingProvider,wrapProvider} from '@use-brian/core'
import {getAppPool,getPool,query,queryWithRLS,runWithAgentAccess} from '../db/client.js'
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
import {readSessionById,readSessionMessageScopeSource} from '../db/sessions.js'
import {readAdmittedSessionQuery} from '../db/session-query-reader.js'
import {withSessionMessagePublication} from '../db/session-context-revisions.js'
import {resolveExecutionContextSystem} from '../context-scope/execution-context.js'
import {createDbWorkspaceFilesStore} from '../db/workspace-files-store.js'
import {createDbLinkedAccountStore} from '../db/linked-accounts.js'
import {channelLinkBindsHere} from '../db/channel-user-store.js'
import {findAssistantById} from '../db/users.js'
import {createDecisionRuntime} from '../decision-runtime.js'
import {_resetConnectorConfigCache} from '../connector-config.js'
import {processChannelMessage,type ChannelPipelineParams} from '../routes/channel-pipeline.js'
import {assertRetainedNativeQueryCapacity} from './fixtures/native-session-capacity.js'
import {createRecordingTranscriptFixture} from './fixtures/recording-transcript-chain.js'

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
const workspaceFilesStore=createDbWorkspaceFilesStore(),capabilityStore=createDbCapabilityStore()
const integrationStore=createDbChannelIntegrationStore(credentialKey)
const linkedAccounts=createDbLinkedAccountStore(),telegramSender='91000082463'
let recovered:string,calendar:ConnectorInstance,configDirectory:string
let retainedHistory:unknown,retainedBindings:unknown,retainedLegacyAnnotation:unknown
const indexedTranscriptMarker='Fictional indexed recording'
let indexedFileIds:string[]=[],transcriptFileId:string,mediaFileId:string
const readRetainedHistory=async()=>(await query(`SELECT id,session_id,role,content,sequence_num,created_at,channel_message_id,
 sender_user_id,sender_assistant_id,published_sender_name,sensitivity,compartments,project_ids,scope_version,scope_held
 FROM session_messages WHERE session_id=$1 AND sequence_num<=$2 ORDER BY sequence_num`,[recovered,historyRows])).rows
const readRetainedBindings=async()=>(await query(`SELECT to_jsonb(p) policy,
 ci.recording_owner_user_id,ci.config->'deliveryAudienceBindings' approval,
 (SELECT jsonb_agg(to_jsonb(ac) ORDER BY ac.id) FROM assistant_capabilities ac WHERE ac.assistant_id=$3) capabilities
 FROM channel_recording_policies p JOIN channel_integrations ci ON ci.id=p.integration_id
 WHERE p.integration_id=$1 AND p.conversation_id=$2`,[integration,conversation,assistant])).rows
const readRetainedLegacyAnnotation=async()=>(await query(`SELECT to_jsonb(r) revision,c.content,
 (SELECT jsonb_agg(jsonb_build_object('kind',s.source_kind,'id',s.source_id,'version',s.source_version)
  ORDER BY s.source_kind,s.source_id,s.source_version) FROM scope_derivations d JOIN scope_derivation_sources s
  ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id WHERE d.workspace_id=r.workspace_id
  AND d.resource_kind='session_context_revision' AND d.resource_id=r.id) sources
 FROM session_context_scope_revisions r JOIN session_context_revision_contents c ON c.workspace_id=r.workspace_id AND c.revision_id=r.id
 WHERE r.workspace_id=$1 AND r.session_id=$2 AND r.parent_kind='message_annotation'
 AND r.parent_id=(SELECT id FROM session_messages WHERE session_id=$2 AND channel_message_id='legacy-topic-input')`,[workspace,recovered])).rows
const readAnnotationShape=async()=>(await query(`SELECT count(DISTINCT h.message_id)::int heads,count(DISTINCT f.id)::int frames
 FROM session_message_annotation_heads h LEFT JOIN scope_derivations d ON d.workspace_id=h.workspace_id
 AND d.resource_kind='session_context_revision' AND d.resource_id=h.scope_revision_id
 LEFT JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id AND s.source_kind='session_context_revision'
 LEFT JOIN native_turn_frames f ON f.workspace_id=s.workspace_id AND f.id=s.source_id WHERE h.session_id=$1`,[recovered])).rows[0]
async function recordingAuthority(){
 const selected=await findAssistantById(assistant),session=await readSessionById(recovered)
 expect(selected).not.toBeNull();expect(session).not.toBeNull()
 const {executionContext:execution}=await resolveExecutionContextSystem({userId:owner,workspaceId:workspace,assistant:selected!,
  session:session!,sessionAuthority:session!,memberMode:'member',sharedAudience:true,ignoreSessionBinding:true,
  identity:{kind:'attended',principal:{kind:'workspace_member',userId:owner,authenticationKind:'verified_channel'}},
  ownership:{kind:'workspace',workspaceId:workspace},lifecycle:{sessionId:recovered,sessionPersisted:true,
   channelType:'telegram',channelId:conversation,abortSignal:new AbortController().signal}})
 return{execution,accumulator:new ContextScopeAccumulator()}
}

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
  await query("INSERT INTO workspaces(id,name,owner_user_id,plan,department_read_v2,project_shared_spaces) VALUES($1,'Fictional Calendar recovery',$2,'pro',true,false)",[workspace,owner])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspace,owner])
  await query("INSERT INTO assistants(id,name,workspace_id,clearance) VALUES($1,'Fictional Calendar assistant',$2,'confidential')",[assistant,workspace])
  await linkedAccounts.upsert({userId:owner,assistantId:assistant,provider:'telegram',providerId:telegramSender})
  await query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Fictional Calendar bot')",[channel,workspace])
  const config={requireMentionOverrides:[{chatId:'-1000008246',topicId:26}],deliveryAudienceBindings:[{version:1,
   channelId:'-1000008246',clearance:'confidential',expiresAt:null,approvedAt:'2026-10-01T00:00:00Z',projectIds:[],
   audienceType:'group',compartments:[],companyWide:true,recipientUserId:null,approvedByUserId:owner}]}
  await query("INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id,config) VALUES($1,$2,'telegram',$3,'987658246',$4)",
   [integration,channel,encryptCredentials({bot_token:'fictional-calendar-bot',webhook_secret:'fictional-calendar-hook'},credentialKey),config])
  await query('INSERT INTO channel_assistants(channel_id,assistant_id,external_surface_id) VALUES($1,$2,$3)',[channel,assistant,conversation])
  await query(`INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id,visibility,anchor_kind,anchor_ref,effective_clearance,clearance_source,title)
   VALUES($1,$2,$3,$4,'telegram',$5,'workspace','channel',$5,'confidential','anchor','Fictional Calendar legacy history')`,[legacy,assistant,owner,workspace,conversation])
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
  retainedHistory=await readRetainedHistory();expect(retainedHistory).toHaveLength(historyRows)
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
  await capabilityStore.grant({assistantId:assistant,capability:'files',grantedByUserId:owner})
  // Preserve the real optional input lane:48ordinary indexed files and one
  // transcript with genuine episode/recording/media-file ancestry. Blob I/O is
  // synthetic; intake, publication, source guards and the ranked index are real.
  await query(`INSERT INTO workspace_files(workspace_id,path,parent_path,name,mime,size_bytes,storage_uri,
   created_by_user_id,sensitivity,user_id,assistant_id,compartments,project_ids)
   SELECT $1,'/references/fictional-'||n||'.md','/references','Fictional reference '||n||'.md','text/markdown',1,
    'gs://fictional-index/reference-'||n,$2,CASE WHEN n<=2 THEN 'public' ELSE 'internal' END,NULL,NULL,'{}','{}'
   FROM generate_series(1,48) n`,[workspace,owner])
  const fileAuthority=await recordingAuthority()
  const chain=await createRecordingTranscriptFixture(fileAuthority,indexedTranscriptMarker)
  mediaFileId=chain.mediaFileId;transcriptFileId=chain.transcriptFileId
  await runWithAgentAccess(fileAuthority.execution.security.access,async()=>{
   const indexed=await workspaceFilesStore.listIndexRanked(fileAuthority.execution.security.access,50)
   expect(indexed).toHaveLength(49);expect(indexed[0].id).toBe(transcriptFileId)
   indexedFileIds=indexed.map(row=>row.id)
  })
  retainedBindings=await readRetainedBindings();expect(retainedBindings).toHaveLength(1)
 })
 afterAll(async()=>{
  vi.unstubAllGlobals();vi.unstubAllEnvs();_resetConnectorConfigCache()
  // Keep the recording's immutable ancestry and failure evidence together.
  // The maintained owned fixture disposes this complete synthetic database.
  if(configDirectory)await rm(configDirectory,{recursive:true,force:true})
  await getAppPool().end();await getPool().end()
 })

 async function runCalendarTurn(id:string,change?:'disconnect-before-tool'|'hold-before-continuation'|'hold-file-before-continuation'|'prior-topic'|'prior-topic-timeout'|'trivial-topic'){
  const mainRequests:ModelRequest[]=[],googleRequests:URL[]=[],sent:string[]=[],oauthTokens:string[]=[]
  const priorTopic=change==='prior-topic'||change==='prior-topic-timeout'||change==='trivial-topic'
  const messageText=change==='trivial-topic'?'Hi':priorTopic?'Continue planning the fictional observatory trip.':'Check my calendar for December 9 and tell me the meeting.'
  const priorReply='The fictional observatory planning discussion continues.'
  let classifierDeadlines=0
  const originalWarn=console.warn.bind(console)
  const warningObserver=change==='prior-topic-timeout'?vi.spyOn(console,'warn').mockImplementation((...args)=>{
   if(args.some(value=>typeof value==='string'&&value.includes('[topic-classifier]')&&value.includes('deadline exceeded')))classifierDeadlines++
   originalWarn(...args)
  }):undefined
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
    if(change==='hold-file-before-continuation')await query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
     SELECT workspace_id,'workspace_file',id,scope_version::text,'held',1,'Fictional recording source hold' FROM workspace_files WHERE id=$1`,[mediaFileId])
    return Response.json({items:[{id:'fictional-event',summary:eventMarker,start:{dateTime:'2030-12-09T10:00:00Z'},end:{dateTime:'2030-12-09T11:00:00Z'}}]})
   }
   // This allowlist guarantees the test can never make a live provider request.
   expect(url.origin).toBe('https://calendar-model.example')
   const request=JSON.parse(String(init?.body)) as ModelRequest
   const main=url.pathname.endsWith('/gemini-3.6-flash')&&request.generationConfig?.responseMimeType!=='application/json'
   if(change==='prior-topic-timeout'&&!main&&request.generationConfig?.responseMimeType==='application/json'){
    const signal=init?.signal
    if(!signal)throw new Error('The fictional classifier transport requires its real deadline signal')
    classifierDeadlines++
    await new Promise<never>((_resolve,reject)=>{
     const abort=()=>reject(signal.reason??new Error('Fictional classifier deadline'))
     if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})
    })
   }
   if(main){
    mainRequests.push(request);mark(mainRequests.length===1?'first-model-wire':'continuation-model-wire')
    expect(JSON.stringify(request)).not.toContain('PRIVATE_')
    expect(JSON.stringify(request)).toContain(`Fictional Calendar retained turn ${historyRows}.`)
    expect(JSON.stringify(request)).toContain(indexedTranscriptMarker)
    if(priorTopic)return modelResponse([{text:priorReply}])
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
   text:messageText,senderUserId:owner})
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
   messageText,userContentBlocks:[{type:'text',text:messageText}],replyToMessageId:change==='trivial-topic'?undefined:26,
   abortController,modelAlias:'standard',adaptiveResearchEnabled:false,
   decisionRuntime:createDecisionRuntime({llmProvider:provider,defaultLlmModel:'gemini-3.6-flash-standard'}),configuredProviders:new Set(['gemini']),provider,
   systemPrompt:'Use the actual Calendar read tool for this fictional request.',tools:new Map(),memoryStore:createDbMemoryStore(),capabilityStore,workspaceFilesStore,
   connectorStore,mcpSettingsStore:settings,assistantConnectorStore:assistantConnectors,connectorInstanceStore:instances,connectorGrantStore:grants,
   hooks:{onConfirmationRequired:async()=>{throw new Error('Read-only Calendar request unexpectedly required confirmation')},sendError:async(error:Error)=>{throw error},
    sendResponse:async(text:string)=>{mark('telegram-delivery');sent.push(text)
     await recordDeliveredTelegramMessage({channelId:conversation,providerMessageId:`calendar-reply-${id}`,text,botId:'987658246',botUsername:'fictional_calendar_bot'})
     return{channelMessageId:`calendar-reply-${id}`}}}} as unknown as ChannelPipelineParams)
  let error:unknown
  try{await pending}catch(caught){error=caught}finally{warningObserver?.mockRestore();mark('turn-finished')}
  const failure=error as {name?:string;code?:string;reason?:string;diagnostic?:string;verificationPhase?:string;verificationSqlstateClass?:string}|undefined
  console.info('[recovered Telegram Calendar timing]',{historyRows,privateRows,milestones,
   failure:failure?{name:failure.name,code:failure.code,reason:failure.reason,diagnostic:failure.diagnostic,
    verificationPhase:failure.verificationPhase,verificationSqlstateClass:failure.verificationSqlstateClass}:undefined})
  return{mainRequests,googleRequests,oauthTokens,sent,error,classifierDeadlines,priorReply,elapsedMs:performance.now()-started}
 }

 it('retains a generic historical annotation with both original query domains and all original field sources',async()=>{
  const authority=await recordingAuthority()
  // The historical writer read the255-row dialogue, then the newly received
  // input with the previous topic boundary. Both original collections remain
  // factual parents of its immutable generic annotation.
  await readAdmittedSessionQuery({sessionId:recovered,throughSequence:historyRows,topicThroughSequence:historyRows,authority})
  const recording=await admitTelegramRecording({integrationId:integration,conversationId:conversation,assistantId:assistant,
   providerMessageId:'legacy-topic-input',text:'Remember the fictional observatory planning discussion.',senderUserId:owner})
  expect(recording?.session.id).toBe(recovered)
  const message=(await query('SELECT id,sequence_num FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',[recovered,'legacy-topic-input'])).rows[0]
  expect(message.sequence_num).toBe(historyRows+1)
  await readAdmittedSessionQuery({sessionId:recovered,throughSequence:historyRows+1,topicThroughSequence:historyRows,
   currentMessageId:message.id,currentMessageSequence:message.sequence_num,authority})
  const parent=await readSessionMessageScopeSource(workspace,message.id);expect(parent).not.toBeNull()
  const sources=new ContextScopeAccumulator({sources:[...(authority.accumulator.evidence.sources??[]),parent!]}).evidence.sources??[]
  // Select the actual canonical historical generic branch in this disposable
  // fixture. The only removed code is its optional native-frame dispatch;
  // every source/actor/destination check, write and deferred guard is retained.
  // Canonical helpers, owners, grants and fingerprints are never modified.
  const signature='publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)'
  const original=(await query<{body:string;definition:string;ownerSql:string;security:unknown}>(`SELECT prosrc body,pg_get_functiondef(oid) definition,
   quote_ident(pg_get_userbyid(proowner)) "ownerSql",jsonb_build_object('owner',proowner,'definer',prosecdef,'config',proconfig,'volatility',provolatile,'parallel',proparallel,'language',prolang) security
   FROM pg_proc WHERE oid=$1::regprocedure`,[signature])).rows[0]
  const dispatch=" IF k='message_annotation' AND native_turn_helpers_current() IS TRUE THEN\n  framed:=publish_native_turn_annotation(w,s,p,i,payload,producer,sources,expected_revision,expected_generation);\n  IF framed IS NOT NULL THEN RETURN NULLIF(framed->'value','null'::jsonb);END IF;\n END IF;\n"
  expect(original.body.split(dispatch)).toHaveLength(2)
  const port=`fixture_legacy_annotation_${randomUUID().replaceAll('-','')}`
  const guard=` IF w IS DISTINCT FROM '${workspace}'::uuid OR s IS DISTINCT FROM '${recovered}'::uuid OR k IS DISTINCT FROM 'message_annotation' THEN RAISE EXCEPTION 'Fictional legacy publisher boundary' USING ERRCODE='42501';END IF;\n`
  const body=original.body.replace(dispatch,()=>guard)
  const definition=original.definition.replace('FUNCTION public.publish_native_session_context_revision(',`FUNCTION public.${port}(`).replace(original.body,()=>body)
  expect(definition).not.toBe(original.definition)
  const annotationId=randomUUID()
  try{
   await query(definition)
   await query(`ALTER FUNCTION public.${port}(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer) OWNER TO ${original.ownerSql};
    REVOKE ALL ON FUNCTION public.${port}(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.${port}(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer) TO app_user`)
   expect((await query<{security:unknown}>(`SELECT jsonb_build_object('owner',proowner,'definer',prosecdef,'config',proconfig,'volatility',provolatile,'parallel',proparallel,'language',prolang) security
    FROM pg_proc WHERE oid=$1::regprocedure`,[`${port}(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)`])).rows[0].security).toEqual(original.security)
   expect((await query<{body:string}>('SELECT prosrc body FROM pg_proc WHERE oid=$1::regprocedure',[`${port}(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)`])).rows[0].body.replace(guard,'')).toBe(original.body.replace(dispatch,''))
   const annotation=await withSessionMessagePublication(authority,sources,async client=>{
    expect((await client.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({current_user:'app_user',rolsuper:false,rolbypassrls:false})
    return(await client.query(`SELECT public.${port}($1,$2,'message_annotation',$3,$4,$5,'session:message-annotation',$6,NULL,NULL,NULL) value`,
     [workspace,recovered,message.id,annotationId,{topicLabel:'Fictional historical topic',topicConfidence:0.9,replyToText:null},JSON.stringify(sources)])).rows[0].value
   })
   expect(annotation).not.toBeNull()
  }finally{await query(`DROP FUNCTION IF EXISTS public.${port}(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)`)}
  expect((await query<{body:string}>('SELECT prosrc body FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0].body).toBe(original.body)
  const parents=(await query(`SELECT s.source_kind,count(*)::int count FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
   WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND d.resource_id=$2 GROUP BY s.source_kind ORDER BY s.source_kind`,[workspace,annotationId])).rows
  expect(parents).toEqual([{source_kind:'application_field',count:historyRows+4},{source_kind:'session_message',count:1}])
  const domains=(await query(`SELECT q.type_key,(q.domain->>'throughSequence')::int through FROM scope_derivations d
   JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id AND s.source_kind='application_field'
   JOIN application_field_resources f ON f.workspace_id=s.workspace_id AND f.id=s.source_id AND f.selection='query_domain'
   JOIN application_query_domains q ON q.workspace_id=f.workspace_id AND q.id=f.resource_id
   WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND d.resource_id=$2 ORDER BY q.type_key,through`,[workspace,annotationId])).rows
  expect(domains).toEqual([{type_key:'session_message',through:historyRows},{type_key:'session_message',through:historyRows+1},{type_key:'session_message_annotation',through:historyRows}])
  retainedLegacyAnnotation=await readRetainedLegacyAnnotation();expect(retainedLegacyAnnotation).toHaveLength(1)
  await recordDeliveredTelegramMessage({channelId:conversation,providerMessageId:'legacy-topic-reply',
   text:'The fictional historical topic was received.',botId:'987658246',botUsername:'fictional_calendar_bot'})
  expect((await query('SELECT sequence_num FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',[recovered,'legacy-topic-reply'])).rows[0].sequence_num).toBe(historyRows+2)
 },90_000)

 it('retains the intervening greeting and delivered reply without inventing a generated annotation',async()=>{
  const result=await runCalendarTurn('prior-trivial-topic','trivial-topic')
  expect(result.error).toBeUndefined();expect(result.mainRequests).toHaveLength(1)
  expect(result.sent).toEqual([result.priorReply]);expect(result.googleRequests).toHaveLength(0)
  expect((await query('SELECT count(*)::int count FROM session_message_annotation_heads WHERE session_id=$1',[recovered])).rows[0].count).toBe(1)
  expect((await query('SELECT sequence_num FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',[recovered,'prior-trivial-topic'])).rows[0].sequence_num).toBe(historyRows+3)
 },90_000)

 it.each([1,2,3,4,5])('retains prior topic turn %i and its immutable annotation before the Calendar request',async(index)=>{
  const id=`prior-topic-${index}`
  const result=await runCalendarTurn(id,index===5?'prior-topic-timeout':'prior-topic')
  expect(result.error).toBeUndefined()
  expect(result.mainRequests).toHaveLength(1);expect(result.googleRequests).toHaveLength(0)
  expect(result.sent).toEqual([result.priorReply])
  expect((await query('SELECT count(*)::int count FROM session_message_annotation_heads WHERE session_id=$1',[recovered])).rows[0].count).toBe(index+1)
  expect((await query('SELECT sequence_num FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',[recovered,id])).rows[0].sequence_num).toBe(historyRows+3+index*2)
  expect((await query('SELECT count(*)::int count FROM memories WHERE workspace_id=$1 AND user_id IS NOT NULL',[workspace])).rows[0].count).toBe(privateRows)
  expect((await query("SELECT channel_message_id FROM session_messages WHERE session_id=$1 AND role='assistant' AND channel_message_id=$2",[recovered,`calendar-reply-${id}`])).rows).toEqual([{channel_message_id:`calendar-reply-${id}`}])
  if(index===5){
   expect(result.classifierDeadlines).toBeGreaterThan(0)
   const annotation=(await query(`SELECT (c.content->>'topicConfidence')::float confidence,c.content->>'topicLabel' label
    FROM session_messages m JOIN session_message_annotation_heads h ON h.workspace_id=m.workspace_id AND h.message_id=m.id
    JOIN session_context_revision_contents c ON c.workspace_id=h.workspace_id AND c.revision_id=h.scope_revision_id
    WHERE m.session_id=$1 AND m.channel_message_id=$2`,[recovered,id])).rows[0]
   expect(annotation).toMatchObject({confidence:0,label:'(uncategorized)'})
  }
 },90_000)

 it('executes the connected speaker Calendar read and delivers its actual result after a second model request',async()=>{
  expect(await readAnnotationShape()).toEqual({heads:6,frames:5})
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
  expect(await readAnnotationShape()).toEqual({heads:7,frames:6})
  expect(await readRetainedHistory()).toEqual(retainedHistory)
  expect(await readRetainedBindings()).toEqual(retainedBindings)
  expect(await readRetainedLegacyAnnotation()).toEqual(retainedLegacyAnnotation)
  const fileAuthority=await recordingAuthority()
  const stillIndexed=await runWithAgentAccess(fileAuthority.execution.security.access,()=>workspaceFilesStore.listIndexRanked(fileAuthority.execution.security.access,50))
  expect(stillIndexed[0].id).toBe(transcriptFileId)
  expect(stillIndexed.map(row=>row.id).sort()).toEqual([...indexedFileIds].sort())
  expect((await query('SELECT status,turn_lease_token FROM sessions WHERE id=$1',[recovered])).rows[0]).toEqual({status:'idle',turn_lease_token:null})
 },90_000)
 it('retains exact native query capacity after the delivered Calendar reply without changing stored state',async()=>{
  expect((await query('SELECT max(sequence_num)::int sequence FROM session_messages WHERE session_id=$1',[recovered])).rows[0].sequence).toBe(historyRows+16)
  await assertRetainedNativeQueryCapacity(await recordingAuthority())
 },90_000)
 it('withdraws a disconnected account before the emitted Calendar call reaches Google',async()=>{
  try{
   const result=await runCalendarTurn('3102','disconnect-before-tool')
   expect(result.mainRequests).toHaveLength(1);expect(result.googleRequests).toHaveLength(0)
   expect(JSON.stringify(result.sent)).not.toContain(eventMarker)
  }finally{await instances.setConnectedSystem(calendar.id,true)}
 },90_000)
 it.each([
  {label:'recording media ancestor',id:'3103-file',change:'hold-file-before-continuation'},
  {label:'historical message',id:'3103-history',change:'hold-before-continuation'},
 ] as const)('withholds the second provider request after a $label hold during the actual Calendar response',async({id,change})=>{
  try{
   const result=await runCalendarTurn(id,change)
   expect(result.mainRequests).toHaveLength(1);expect(result.googleRequests).toHaveLength(1)
   expect(JSON.stringify(result.sent)).not.toContain(eventMarker)
   expect((await query('SELECT id FROM session_messages WHERE session_id=$1 AND channel_message_id=$2',[recovered,`calendar-reply-${id}`])).rows).toEqual([])
  }finally{
   if(change==='hold-file-before-continuation')await query("DELETE FROM scope_resource_states WHERE workspace_id=$1 AND resource_kind='workspace_file' AND resource_id=$2",[workspace,mediaFileId])
  }
 },90_000)
})
