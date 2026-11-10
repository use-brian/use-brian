import * as dbClient from '../db/client.js'
/** [COMP:api/telegram-conversation-context] Durable approved topic history,
 * actual provider requests/delivery, privacy holds and executed stop guards. */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { configureTelegramTextDeliveryObserver, createTelegramAdapter } from '@use-brian/channels'
import type { LLMProvider } from '@use-brian/core'
import { applyRLSGucs, getAppPool, getPool } from '../db/client.js'
import { getSessionMessages } from '../db/sessions.js'
import { findAssistantById } from '../db/users.js'
import { createDbCapabilityStore } from '../db/capability-store.js'
import { createDbMemoryStore } from '../db/memory-store.js'
import { createDbChannelIntegrationStore, encryptCredentials } from '../db/channel-integrations.js'
import { findTelegramConversationContext, assertTelegramConversationCurrent, recordDeliveredTelegramConversation } from '../telegram-conversation-context.js'
import { configureChannelRooms, postToChannelRoom, roomInputScope, renewChannelConversationGeneration } from '../channel-room/room.js'
import { appendChannelRoomMessage } from '../channel-room/messages.js'
import { sessionKindSql } from '../session-kind.js'
import { processChannelMessage } from '../routes/channel-pipeline.js'
import { confirmChannelRecordingOwner, admitTelegramRecording, changeChannelRecording } from '../channel-recording.js'
import { persistentContextFixture } from '../application-platform/__tests__/fixtures/persistent-context.js'

const enabled = Boolean(process.env.TELEGRAM_CONTEXT_TEST_DATABASE_URL)
const { assertLocalFixture } = await import(new URL('../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
if (enabled) await assertLocalFixture()
const run = enabled ? describe.sequential : describe.skip
run('[COMP:api/telegram-conversation-context] normal topic continuity', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  afterEach(async () => { configureTelegramTextDeliveryObserver(); vi.restoreAllMocks(); await fixture?.cleanup(); fixture=undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })
  async function setup() {
    fixture = await persistentContextFixture()
    const f=fixture, channelId=randomUUID(), integrationId=randomUUID(), botId='987650001'
    const conversationId='-1000000019:topic:7', key=Buffer.alloc(32,7)
    const binding={version:1,channelId:'-1000000019',audienceType:'group',clearance:'confidential',companyWide:true,
      compartments:[],projectIds:[],recipientUserId:null,expiresAt:null,approvedByUserId:f.ownerId,approvedAt:'2026-10-01T00:00:00Z'}
    await f.pool.query("UPDATE workspaces SET department_read_v2=true,plan='pro' WHERE id=$1",[f.workspaceId])
    await f.pool.query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Fictional topic bot')",[channelId,f.workspaceId])
    await f.pool.query('INSERT INTO channel_assistants(channel_id,assistant_id) VALUES($1,$2)',[channelId,f.assistantId])
    await f.pool.query("INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,bot_user_id,config) VALUES($1,$2,'telegram',$3,$4,$5)",
      [integrationId,channelId,encryptCredentials({bot_token:botId+':fictional',webhook_secret:'fictional'},key),botId,JSON.stringify({deliveryAudienceBindings:[binding]})])
    const input={integrationId,workspaceId:f.workspaceId,assistantId:f.assistantId,conversationId,userId:f.ownerId}
    return {f,channelId,integrationId,botId,conversationId,key,binding,input}
  }

  it('executes ordinary-owner migration and retains all canonical guards',async()=>{
    const role=(await getPool().query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(role).toEqual({rolsuper:false,rolbypassrls:false})
    for(const name of ['native_turn_helpers_current','native_turn_publication_contract','application_native_worklist_helpers_current',
      'application_native_dependency_batch_helpers_current','application_native_field_reference_helpers_current','application_memory_statement_helpers_current']) {
      expect((await getPool().query(`SELECT public.${name}() ok`)).rows[0].ok).toBe(true)
    }
  })

  it('shares one room across senders, isolates topics, and leaves historical holds intact',async()=>{
    const s=await setup()
    const held=(await s.f.pool.query(`INSERT INTO sessions(assistant_id,user_id,workspace_id,channel_type,channel_id,visibility,anchor_kind,anchor_ref)
      VALUES($1,$2,$3,'telegram',$4,'workspace','channel',$4) RETURNING id,recording_privacy_held`,
    [s.f.assistantId,s.f.ownerId,s.f.workspaceId,s.conversationId])).rows[0]
    expect(held.recording_privacy_held).toBe(true)
    const first=await findTelegramConversationContext(s.input)
    const second=await findTelegramConversationContext({...s.input,userId:s.f.secondId})
    expect(first?.id).toBe(second?.id)
    expect(first).toMatchObject({visibility:'workspace',roomCapture:false,providerConversationContext:true})
    expect(first?.id).not.toBe(held.id)
    const other=await findTelegramConversationContext({...s.input,conversationId:'-1000000019:topic:8'})
    expect(other?.id).not.toBe(first?.id)
    expect((await s.f.pool.query('SELECT recording_privacy_held FROM sessions WHERE id=$1',[held.id])).rows[0].recording_privacy_held).toBe(true)
    await expect(s.f.pool.query('UPDATE sessions SET recording_privacy_held=false WHERE id=$1',[held.id])).rejects.toThrow('recording_privacy_review_required')
    await expect(s.f.pool.query('UPDATE sessions SET provider_conversation_context=true WHERE id=$1',[held.id])).rejects.toThrow('provider_context_identity_immutable')
    expect((await s.f.pool.query('SELECT recording_owner_user_id FROM channel_integrations WHERE id=$1',[s.integrationId])).rows[0].recording_owner_user_id).toBeNull()
  })

  it('sends previous visible turns and current image to the real provider boundary after reconstruction',async()=>{
    const s=await setup(), room=await findTelegramConversationContext(s.input)
    expect(room).not.toBeNull()
    await s.f.memory('Private fixture fact must never reach the group',s.f.ownerId)
    const capture=vi.fn();configureChannelRooms({capturePost:capture})
    const assistant=(await findAssistantById(s.f.assistantId))!
    const requests:string[]=[], errors:Error[]=[], deliveries:Array<Record<string,unknown>>=[]
    let reply='Four sessions leave about one rest day between runs.',messageId=100
    vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
      const body=JSON.parse(String(init?.body)) as Record<string,unknown>;deliveries.push(body)
      return new Response(JSON.stringify({ok:true,result:{message_id:messageId++,text:reply}}),{status:200})
    })
    configureTelegramTextDeliveryObserver(recordDeliveredTelegramConversation)
    const usage={inputTokens:5,outputTokens:5}
    const provider:LLMProvider={name:'fictional-topic-context',models:['fixture'],async *stream(){
      yield {type:'message_start',model:'fixture'}
      yield {type:'text_delta',text:'{"topic_label":"Running schedule","state":"continue","confidence":0.9}'}
      yield {type:'message_end',stopReason:'end_turn',usage}
    },createSession(options){return {send(turn){return (async function*(){
      requests.push(JSON.stringify({options,turn}))
      yield {type:'message_start' as const,model:'fixture'}
      yield {type:'text_delta' as const,text:reply}
      yield {type:'message_end' as const,stopReason:'end_turn' as const,usage}
    })()}}}}
    const turn=async(text:string,userId=s.f.ownerId,image=false)=>{
      const context=await findTelegramConversationContext({...s.input,userId})
      if(!context)throw Error('Expected approved topic context')
      const adapter=createTelegramAdapter({token:s.botId+':fictional',botUsername:'fictional_bot',deliveryOrigin:{integrationId:s.integrationId,generation:context.providerContextGeneration!}})
      await processChannelMessage({userId,ownerId:s.f.ownerId,assistant,isIdentified:true,conversationContext:context,
        channelType:'telegram',channelId:s.conversationId,channelIntegrationId:s.integrationId,
        channelIntegrationStore:createDbChannelIntegrationStore(s.key),isGroupChat:true,incomingChannelMessageId:String(messageId++),
        messageText:text,userContentBlocks:[{type:'text',text},...(image?[{type:'image' as const,mimeType:'image/png',data:'RklDVElPTkFMX0lNQUdF'}]:[])],
        modelAlias:'standard',adaptiveResearchEnabled:false,abortController:new AbortController(),provider,systemPrompt:'Private fixture instructions',
        tools:new Map(),memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore(),hooks:{
          async onConfirmationRequired(){throw Error('Unexpected confirmation')},async sendError(error){errors.push(error)},
          async sendResponse(text){await assertTelegramConversationCurrent(context);return {channelMessageId:await adapter.sendMessage(s.conversationId,{text,format:'markdown'})}},
        }})
    }
    await turn('I run four times a week. How many rest days are there?')
    expect(errors).toEqual([])
    expect(requests).toHaveLength(1)
    const reopenCode=`const input=JSON.parse(await new Promise(r=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>r(s))}));
      const {findTelegramConversationContext}=await import(${JSON.stringify(new URL('../telegram-conversation-context.ts',import.meta.url).href)});
      const {getSessionMessages}=await import(${JSON.stringify(new URL('../db/sessions.ts',import.meta.url).href)});
      const {getPool,getAppPool}=await import(${JSON.stringify(new URL('../db/client.ts',import.meta.url).href)});
      const room=await findTelegramConversationContext(input);const messages=await getSessionMessages(room.id,{excludeHeld:true});
      console.log('REOPEN_RESULT '+JSON.stringify({id:room.id,roles:messages.map(m=>m.role)}));await getPool().end();await getAppPool().end();`
    const reopened=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',reopenCode],{
      cwd:new URL('../..',import.meta.url),env:process.env,input:JSON.stringify(s.input),encoding:'utf8',timeout:30_000,
    })
    expect(reopened.status,reopened.stderr).toBe(0)
    const restored=JSON.parse(reopened.stdout.split('REOPEN_RESULT ')[1].trim())
    expect(restored).toEqual({id:room!.id,roles:['user','assistant']})
    await s.f.pool.query('UPDATE channel_integrations SET identity_generation=identity_generation+1 WHERE id=$1',[s.integrationId])
    reply='Yes, that schedule makes sense.'
    await turn('Does this make sense?',s.f.secondId,true)
    expect(errors).toEqual([])
    expect(requests).toHaveLength(2)
    expect(requests[1]).toContain('I run four times a week')
    expect(requests[1]).toContain('Four sessions leave about one rest day')
    expect(requests[1]).toContain('Does this make sense?')
    expect(requests[1]).toContain('RklDVElPTkFMX0lNQUdF')
    expect(requests[1]).not.toContain('Private fixture fact')
    expect(requests[1]).not.toContain('Private fixture instructions')
    expect(deliveries).toHaveLength(2)
    expect(capture).not.toHaveBeenCalled()
    expect((await s.f.pool.query(`SELECT id FROM sessions s WHERE s.id=$1 AND ${sessionKindSql.surfacesBeyondAnchor('s')}`,[room!.id])).rows).toHaveLength(0)
    const messages=await getSessionMessages(room!.id,{excludeHeld:true})
    expect(messages.map(m=>m.role)).toEqual(['user','assistant','user','assistant'])
    expect(messages[2].senderUserId).toBe(s.f.secondId)
    expect(JSON.stringify(messages[2].content)).not.toContain('RklDVElPTkFMX0lNQUdF')
    expect((await s.f.pool.query("SELECT 1 FROM memories WHERE workspace_id=$1 AND summary<>'Private fixture fact must never reach the group'",[s.f.workspaceId])).rows).toHaveLength(0)
  },90_000)

  it('renews read authority without changing activity or the stored row version',async()=>{
    const s=await setup(),room=(await findTelegramConversationContext(s.input))!
    const before=(await s.f.pool.query('SELECT xmin::text,last_active_at FROM sessions WHERE id=$1',[room.id])).rows[0]
    await assertTelegramConversationCurrent(room)
    expect((await s.f.pool.query('SELECT xmin::text,last_active_at FROM sessions WHERE id=$1',[room.id])).rows[0]).toEqual(before)
  })

  it('rechecks context consent before the main model when it stops during an auxiliary call',async()=>{
    const s=await setup(),room=(await findTelegramConversationContext(s.input))!
    await confirmChannelRecordingOwner(s.integrationId,s.f.ownerId)
    const recording=(await admitTelegramRecording({integrationId:s.integrationId,conversationId:s.conversationId,
      assistantId:s.f.assistantId,senderUserId:s.f.ownerId,providerMessageId:'future-consent-seed',text:'Future recording mirror'}))!
    let stopped=false,mainSends=0,delivered=0
    const errors:unknown[]=[]
    const usage={inputTokens:2,outputTokens:2}
    const provider:LLMProvider={name:'fictional-context-stop',models:['fixture'],async *stream(){
      if(!stopped){await changeChannelRecording({integrationId:s.integrationId,actorId:s.f.ownerId,id:recording.policy.id,
        revision:recording.policy.revision,destination:'personal',projectId:null,enabled:false});stopped=true}
      yield {type:'message_start',model:'fixture'}
      yield {type:'text_delta',text:'{"topic_label":"Fixture","state":"continue","confidence":0.9}'}
      yield {type:'message_end',stopReason:'end_turn',usage}
    },createSession(){return {send(){return (async function*(){mainSends++;yield {type:'message_start' as const,model:'fixture'}
      yield {type:'text_delta' as const,text:'Must not reach provider'};yield {type:'message_end' as const,stopReason:'end_turn' as const,usage}
    })()}}}}
    try{await processChannelMessage({userId:s.f.ownerId,ownerId:s.f.ownerId,assistant:(await findAssistantById(s.f.assistantId))!,
      isIdentified:true,conversationContext:room,channelType:'telegram',channelId:s.conversationId,channelIntegrationId:s.integrationId,
      channelIntegrationStore:createDbChannelIntegrationStore(s.key),isGroupChat:true,incomingChannelMessageId:'stop-turn-1',
      messageText:'Review the schedule',userContentBlocks:[{type:'text',text:'Review the schedule'}],modelAlias:'standard',
      abortController:new AbortController(),provider,systemPrompt:'Fixture',tools:new Map(),memoryStore:createDbMemoryStore(),
      capabilityStore:createDbCapabilityStore(),hooks:{async onConfirmationRequired(){throw Error('Unexpected confirmation')},
        async sendError(error){errors.push(error)},async sendResponse(){delivered++}}})
    }catch(error){errors.push(error)}
    expect(stopped).toBe(true);expect(mainSends).toBe(0);expect(delivered).toBe(0);expect(errors.length).toBeGreaterThan(0)
  },60_000)

  it('normalizes the actual PostgreSQL bigint before the real store-to-context handoff',async()=>{
    const s=await setup(),store=createDbChannelIntegrationStore(s.key)
    const integration=(await store.getByChannelForWebhook(s.channelId,'telegram'))!
    expect(typeof integration.identityGeneration).toBe('number')
    const outbound=(await store.getCredentialsForAssistantSystem(s.f.assistantId,'telegram'))!
    const scoped=(await store.getCredentialsForAssistantIntegrationSystem(s.f.workspaceId,s.f.assistantId,s.integrationId,'telegram',s.conversationId))!
    expect(outbound.identityGeneration).toBe(integration.identityGeneration)
    expect(scoped.identityGeneration).toBe(integration.identityGeneration)
    const context=await findTelegramConversationContext({...s.input,expectedIdentity:{integrationId:integration.id,
      botId:integration.botUserId!,generation:integration.identityGeneration!}})
    expect(context?.providerContextGeneration).toBe(integration.identityGeneration)
  })

  it('accepts simultaneous same-generation renewal and rejects stale passive appends under the parent lock',async()=>{
    const s=await setup(),previous=(await findTelegramConversationContext(s.input))!
    await s.f.pool.query('UPDATE channel_integrations SET identity_generation=identity_generation+1 WHERE id=$1',[s.integrationId])
    const generation=previous.providerContextGeneration!+1
    const current=await Promise.all([renewChannelConversationGeneration(previous,generation),renewChannelConversationGeneration(previous,generation)])
    expect(current.map(room=>[room.id,room.providerContextGeneration])).toEqual([[previous.id,generation],[previous.id,generation]])
    await expect(postToChannelRoom({room:previous,workspaceId:s.f.workspaceId,senderUserId:s.f.ownerId,senderName:'Fictional sender',
      text:'Stale passive input',channelMessageId:'stale-passive'})).rejects.toThrow('provider_context_unavailable')
    await expect(appendChannelRoomMessage({sessionId:previous.id,role:'user',content:[{type:'text',text:'Uncorrelated input'}],
      channelMessageId:'missing-provenance',scope:roomInputScope(current[0],s.f.workspaceId)})).rejects.toThrow('provider_context_unavailable')
    expect(await getSessionMessages(previous.id)).toHaveLength(0)
  })

  it('never appends an old receipt when renewal occurs after its initial lookup',async()=>{
    const s=await setup(),previous=(await findTelegramConversationContext(s.input))!
    let announce!:()=>void,release!:()=>void
    const reached=new Promise<void>(resolve=>{announce=resolve}),resume=new Promise<void>(resolve=>{release=resolve})
    const original=dbClient.query;let paused=false
    const spy=vi.spyOn(dbClient,'query').mockImplementation((async(...args:Parameters<typeof dbClient.query>)=>{
      const result=await original(...args)
      if(!paused && String(args[0]).includes("s.provider_context_identity->>'integrationId'=$2")){
        paused=true;announce();await resume
      }
      return result
    }) as typeof dbClient.query)
    const pending=recordDeliveredTelegramConversation({channelId:s.conversationId,botId:s.botId,providerMessageId:'raced-receipt',
      text:'Old in-flight response',origin:{integrationId:s.integrationId,generation:previous.providerContextGeneration!}})
    try{
      await reached
      await s.f.pool.query('UPDATE channel_integrations SET identity_generation=identity_generation+1 WHERE id=$1',[s.integrationId])
      const current=(await findTelegramConversationContext(s.input))!
      expect(current.id).toBe(previous.id)
      release()
      await expect(pending).rejects.toThrow('provider_context_unavailable')
      expect(await getSessionMessages(previous.id)).toHaveLength(0)
    }finally{release();spy.mockRestore();await pending.catch(()=>{})}
  })

  it('renews the same bot generation without losing history and rejects stale or uncorrelated receipts',async()=>{
    const s=await setup(),room=(await findTelegramConversationContext(s.input))!
    const receipt={channelId:s.conversationId,botId:s.botId,providerMessageId:'visible-1',text:'Earlier visible reply',
      origin:{integrationId:s.integrationId,generation:room.providerContextGeneration!}}
    await recordDeliveredTelegramConversation(receipt)
    await recordDeliveredTelegramConversation({...receipt,providerMessageId:'unscoped',origin:undefined})
    await recordDeliveredTelegramConversation({...receipt,providerMessageId:'wrong-installation',origin:{...receipt.origin,integrationId:randomUUID()}})
    expect(await getSessionMessages(room.id)).toHaveLength(1)
    await s.f.pool.query('UPDATE channel_integrations SET identity_generation=identity_generation+1 WHERE id=$1',[s.integrationId])
    await expect(recordDeliveredTelegramConversation({...receipt,providerMessageId:'stale-before-renewal'})).rejects.toThrow('provider_context_unavailable')
    await expect(findTelegramConversationContext({...s.input,expectedIdentity:room.providerContextIdentity!})).rejects.toThrow('provider_context_unavailable')
    const renewed=(await findTelegramConversationContext(s.input))!
    expect(renewed.id).toBe(room.id)
    expect(renewed.providerContextGeneration).toBe(room.providerContextGeneration!+1)
    expect(renewed.providerContextIdentity).toEqual(room.providerContextIdentity)
    await expect(assertTelegramConversationCurrent(room)).rejects.toThrow('provider_context_unavailable')
    await recordDeliveredTelegramConversation({...receipt,providerMessageId:'stale-after-renewal'})
    const current={...receipt,providerMessageId:'visible-2',text:'Current visible reply',origin:{...receipt.origin,generation:renewed.providerContextGeneration!}}
    await recordDeliveredTelegramConversation(current)
    await recordDeliveredTelegramConversation(current)
    expect((await getSessionMessages(room.id)).map(m=>m.channelMessageId)).toEqual(['visible-1','visible-2'])
  })

  it('attributes the same bot destination to the exact originating workspace integration',async()=>{
    const first=await setup(),firstRoom=(await findTelegramConversationContext(first.input))!
    try {
      const second=await setup(),secondRoom=(await findTelegramConversationContext(second.input))!
      await recordDeliveredTelegramConversation({channelId:second.conversationId,botId:second.botId,providerMessageId:'exact-origin',
        text:'Visible in the originating conversation',origin:{integrationId:second.integrationId,generation:secondRoom.providerContextGeneration!}})
      expect(await getSessionMessages(firstRoom.id)).toHaveLength(0)
      expect(await getSessionMessages(secondRoom.id)).toHaveLength(1)
    } finally {await first.f.cleanup()}
  })

  it('enforces the selected workspace audience through the genuine application role',async()=>{
    const s=await setup(),room=(await findTelegramConversationContext(s.input))!
    const read=async(userId:string)=>{
      const db=await getAppPool().connect()
      try{await db.query('BEGIN');await applyRLSGucs(db,userId)
        const rows=(await db.query('SELECT id FROM sessions WHERE id=$1',[room.id])).rows
        await db.query('COMMIT');return rows
      }catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
    }
    expect(await read(s.f.secondId)).toHaveLength(1)
    expect(await read(s.f.firstId)).toHaveLength(0)
    await s.f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[s.f.workspaceId,s.f.secondId])
    expect(await read(s.f.secondId)).toHaveLength(0)
  })

  it('keeps context identity when a recorder appears, and enforces later stop and audience revocation',async()=>{
    const s=await setup(), room=(await findTelegramConversationContext(s.input))!
    await confirmChannelRecordingOwner(s.integrationId,s.f.ownerId)
    const recording=await admitTelegramRecording({integrationId:s.integrationId,conversationId:s.conversationId,assistantId:s.f.assistantId,
      senderUserId:s.f.ownerId,providerMessageId:'future-recording-1',text:'Future-only mirror'})
    expect(recording?.session.id).not.toBe(room.id)
    expect((await findTelegramConversationContext(s.input))?.id).toBe(room.id)
    await changeChannelRecording({integrationId:s.integrationId,actorId:s.f.ownerId,id:recording!.policy.id,revision:recording!.policy.revision,
      destination:'personal',projectId:null,enabled:false})
    expect(await findTelegramConversationContext(s.input)).toBeNull()
    await expect(assertTelegramConversationCurrent(room)).rejects.toThrow('provider_context_unavailable')
    await expect(recordDeliveredTelegramConversation({channelId:s.conversationId,botId:s.botId,providerMessageId:'blocked-send',text:'Must not retain',botUsername:'fictional_bot',origin:{integrationId:s.integrationId,generation:room.providerContextIdentity!.generation}})).rejects.toThrow('provider_context_unavailable')
    await s.f.pool.query("UPDATE channel_integrations SET config='{}' WHERE id=$1",[s.integrationId])
    expect(await findTelegramConversationContext(s.input)).toBeNull()
    expect((await s.f.pool.query('SELECT room_capture,provider_conversation_context FROM sessions WHERE id=$1',[room.id])).rows[0]).toEqual({room_capture:false,provider_conversation_context:true})
  })
})
