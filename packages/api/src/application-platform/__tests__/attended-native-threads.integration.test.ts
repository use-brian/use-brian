import {randomBytes,randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {bindScopeSource,scopeEvidenceFromRows} from '@use-brian/core'
import {getAppPool,getPool,queryWithRLS} from '../../db/client.js'
import {createMemory} from '../../db/memories.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {addSessionMessage,createPersonalWebSession,findOrCreateSession,readSessionMessageScopeSource} from '../../db/sessions.js'
import {createChannelIdentityBindingStore,wechatSessionChannelId} from '../../db/channel-identity-bindings.js'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {createDeliveryAudienceAuthorizer,createDeliveryAudienceEnvelopeResolver} from '../../context-scope/delivery-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] [COMP:api/delivery-authority] actual personal audience compatibility',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 const extraUsers:string[]=[]
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined;if(extraUsers.length)await getPool().query('DELETE FROM users WHERE id=ANY($1::uuid[])',[extraUsers.splice(0)])})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function nativeEvidence(f:Awaited<ReturnType<typeof persistentContextFixture>>,userId:string,ids:readonly string[]){
  const assistant=await findAssistantById(f.assistantId);if(!assistant)throw new Error('Missing actual fixture assistant')
  const execution=(await resolveExecutionContextSystem({userId,workspaceId:f.workspaceId,assistant,memberMode:'member',
   identity:{kind:'attended',principal:{kind:'workspace_member',userId,authenticationKind:'native_session'}},
   ownership:{kind:'workspace',workspaceId:f.workspaceId},lifecycle:{sessionId:randomUUID(),sessionPersisted:false,
    channelType:'web',channelId:'fictional-native-read',abortSignal:new AbortController().signal}})).executionContext
  const rows=await Promise.all(ids.map(id=>createDbMemoryStore().getById(execution.security.access,id)))
  if(rows.some(row=>!row))throw new Error('Missing admitted native source')
  return scopeEvidenceFromRows(rows.filter(row=>row!==null))
 }
 async function personalThread(f:Awaited<ReturnType<typeof persistentContextFixture>>,userId:string){
  const auth=await authSessionStore.create(userId,{deviceLabel:'Fictional native audience',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual native authentication session')
  return createPersonalWebSession({assistantId:f.assistantId,userId,workspaceId:f.workspaceId,channelType:'web',channelId:randomUUID(),appOrigin:'chat'},
   {actorUserId:userId,authSessionId:auth.id,authVersion:auth.authVersion})
 }
 it('delivers a personal thread spanning several assistants only to its current owner',async()=>{
  fixture=await persistentContextFixture();const f=fixture,actor=f.firstId,answering=randomUUID()
  await f.pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,actor])
  await f.pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance) VALUES($1,'Fictional answering assistant',$2,$3,'standard','internal')",[answering,f.workspaceId,actor])
  const first=await f.memory('Fictional personal primary source',actor)
  const second=await createMemory({assistantId:answering,userId:actor,workspaceId:f.workspaceId,summary:'Fictional personal answering source',sensitivity:'internal',createdByUserId:actor})
  const evidence=await nativeEvidence(f,actor,[first.id,second.id]),original=JSON.stringify(evidence),thread=await personalThread(f,actor)
  const input={workspaceId:f.workspaceId,assistantId:answering,userId:actor,channelType:'web',channelId:'default',sessionId:thread.id,scopeEvidence:evidence}
  expect(await createDeliveryAudienceAuthorizer()(input)).toMatchObject({allowed:true})
  expect(JSON.stringify(evidence)).toBe(original)
  const foreign=await f.memory('Fictional other personal source',f.ownerId)
  const foreignEvidence=await nativeEvidence(f,f.ownerId,[foreign.id])
  expect(await createDeliveryAudienceAuthorizer()({...input,scopeEvidence:foreignEvidence})).toMatchObject({allowed:false,diagnostic:'user_visibility'})
  const otherThread=await personalThread(f,f.ownerId)
  expect(await createDeliveryAudienceAuthorizer()({...input,sessionId:otherThread.id})).toMatchObject({allowed:false,diagnostic:'session_not_owner'})
 })
 it('finds the member personal session under the actual thread key and preserves the bare-chat refusal',async()=>{
  fixture=await persistentContextFixture();const f=fixture,actor=f.firstId,threadKey='oc_fixture:thread:om_root'
  const memory=await f.memory('Fictional threaded personal source',actor),evidence=await nativeEvidence(f,actor,[memory.id])
  await findOrCreateSession({assistantId:f.assistantId,userId:actor,workspaceId:f.workspaceId,channelType:'feishu',channelId:threadKey,
   visibility:'personal',effectiveClearance:'internal'})
  const input={workspaceId:f.workspaceId,assistantId:f.assistantId,userId:actor,channelType:'feishu',channelId:'oc_fixture',recipientType:'individual' as const,scopeEvidence:evidence}
  expect(await createDeliveryAudienceAuthorizer()({...input,sessionChannelId:threadKey})).toMatchObject({allowed:true})
  expect(await createDeliveryAudienceAuthorizer()(input)).toMatchObject({allowed:false})
 })
 it('delivers a guest DM own-message source at public clearance without manufacturing membership',async()=>{
  fixture=await persistentContextFixture();const f=fixture,guest=randomUUID();extraUsers.push(guest)
  await f.pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'channel',$1::text)",[guest])
  const session=await findOrCreateSession({assistantId:f.assistantId,userId:guest,workspaceId:f.workspaceId,channelType:'telegram',channelId:'5550100',visibility:'personal',effectiveClearance:'public'})
  const message=await addSessionMessage({sessionId:session.id,role:'user',senderUserId:guest,content:[{type:'text',text:'Fictional guest input'}],
   scope:{workspaceId:f.workspaceId,userId:guest,assistantId:null,sensitivity:'public',compartments:[],projectIds:[]}})
  expect((await queryWithRLS(guest,'SELECT id FROM session_messages WHERE id=$1',[message.id])).rows).toEqual([{id:message.id}])
  const source=await readSessionMessageScopeSource(f.workspaceId,message.id);if(!source)throw new Error('Missing actual guest source observation')
  const evidence=scopeEvidenceFromRows([bindScopeSource({id:message.id},source)])
  const input={workspaceId:f.workspaceId,assistantId:f.assistantId,userId:guest,channelType:'telegram',channelId:'5550100',recipientType:'individual' as const,scopeEvidence:evidence}
  expect(await createDeliveryAudienceAuthorizer()({...input,recipientMode:'external'})).toMatchObject({allowed:true})
  await findOrCreateSession({assistantId:f.assistantId,userId:guest,workspaceId:f.workspaceId,channelType:'api',channelId:input.channelId,visibility:'personal',effectiveClearance:'public'})
  const apiDecision=await createDeliveryAudienceAuthorizer()({...input,sessionId:session.id,channelType:'api',recipientMode:'external'})
  expect(apiDecision.allowed,JSON.stringify(apiDecision)).toBe(true)
  expect(await createDeliveryAudienceAuthorizer()({...input,sessionId:session.id,channelType:'api'})).toMatchObject({allowed:false,diagnostic:'member_not_found'})
  expect((await f.pool.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,guest])).rows).toEqual([])
 })
 it('requires the current actual WeChat binding before admitting personal source evidence',async()=>{
  fixture=await persistentContextFixture();const f=fixture,actor=f.firstId,key=randomBytes(32),identities=createChannelIdentityBindingStore(key)
  const peer=randomUUID()+'@im.wechat',bot=randomUUID()+'@im.bot'
  const paired=await identities.provisionWechatTransport({workspaceId:f.workspaceId,actorUserId:actor,mode:'self',pairingId:randomUUID(),defaultAssistantId:f.assistantId,
   credentials:{botToken:'fictional-wechat-transport',baseUrl:'https://ilink.example',ilinkBotId:bot,boundUserId:peer}})
  if(!paired.ok||!paired.binding)throw new Error('Missing actual self pairing')
  const integration=(await f.pool.query<{id:string}>('SELECT id FROM channel_integrations WHERE channel_id=$1',[paired.channelId])).rows[0]
  if(!integration)throw new Error('Missing actual transport integration')
  const memory=await f.memory('Fictional WeChat personal source',actor),evidence=await nativeEvidence(f,actor,[memory.id])
  const input={workspaceId:f.workspaceId,assistantId:f.assistantId,userId:actor,channelType:'wechat',channelId:peer,channelIntegrationId:integration.id,
   sessionChannelId:wechatSessionChannelId(paired.binding),recipientType:'individual' as const,recipientMode:'member' as const,scopeEvidence:evidence}
  expect(await createDeliveryAudienceAuthorizer()(input)).toMatchObject({allowed:true})
  expect(await createDeliveryAudienceEnvelopeResolver()(input)).toMatchObject({allowed:true,source:'member'})
  expect(await createDeliveryAudienceAuthorizer()({...input,sessionChannelId:peer,scopeEvidence:{}})).toMatchObject({allowed:false,diagnostic:'wechat_recipient_unbound'})
  expect(await identities.revokeOwnWechatBinding(actor,paired.binding.bindingId)).toBe(true)
  expect(await createDeliveryAudienceAuthorizer()(input)).toMatchObject({allowed:false,diagnostic:'wechat_recipient_unbound'})
 })
})
