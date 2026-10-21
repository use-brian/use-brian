import {randomBytes,randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {scopeEvidenceFromRows} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbChannelIntegrationStore} from '../../db/channel-integrations.js'
import {findOrCreateChannelForConnect} from '../../db/channels-store.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {createDeliveryAudienceAuthorizer,createDeliveryAudienceEnvelopeResolver} from '../../context-scope/delivery-authority.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] [COMP:api/delivery-authority] actual native audience compatibility',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it.each(['owner','admin','member'] as const)('delivers the %s their own personal context through an actual approved group',async role=>{
  fixture=await persistentContextFixture();const f=fixture,actor=f.firstId
  await f.pool.query('UPDATE workspace_members SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,actor,role])
  const channel=await findOrCreateChannelForConnect({assistantId:f.assistantId,channelType:'telegram',displayName:'Fictional native audience'})
  const integrations=createDbChannelIntegrationStore(randomBytes(32))
  const installation=await integrations.upsert({channelId:channel,channelType:'telegram',teamId:null,teamName:null,botUserId:null,botUsername:null,
   credentials:{bot_token:'fictional-telegram-transport',webhook_secret:'fictional-webhook-secret'},actingUserId:f.ownerId})
  const group='-1005550100'
  await integrations.updateConfig({actingUserId:f.ownerId,id:installation.id,config:{deliveryAudienceBindings:[{
   version:1,channelId:group,audienceType:'group',clearance:'confidential',compartments:[],projectIds:[],recipientUserId:null,
   approvedByUserId:f.ownerId,approvedAt:new Date().toISOString(),expiresAt:null,
  }]}})
  const memory=await f.memory('Fictional personal source',actor)
  const assistant=await findAssistantById(f.assistantId);if(!assistant)throw new Error('Missing actual fixture assistant')
  const execution=(await resolveExecutionContextSystem({userId:actor,workspaceId:f.workspaceId,assistant,memberMode:'member',
   identity:{kind:'attended',principal:{kind:'workspace_member',userId:actor,authenticationKind:'native_session'}},
   ownership:{kind:'workspace',workspaceId:f.workspaceId},lifecycle:{sessionId:randomUUID(),sessionPersisted:false,
    channelType:'web',channelId:'fictional-audience-source',abortSignal:new AbortController().signal}})).executionContext
  const row=await createDbMemoryStore().getById(execution.security.access,memory.id);if(!row)throw new Error('Missing admitted personal source')
  const evidence=scopeEvidenceFromRows([row]),original=JSON.stringify(evidence)
  const input={workspaceId:f.workspaceId,assistantId:f.assistantId,userId:actor,channelType:'telegram',channelId:group+':topic:15',
   channelIntegrationId:installation.id,recipientType:'group' as const,recipientMode:'member' as const,groupSpeaker:true,scopeEvidence:evidence}
  expect(await createDeliveryAudienceEnvelopeResolver({integrationStore:integrations})(input))
   .toMatchObject({allowed:true,source:'binding',ceiling:{userId:actor,clearance:role==='member'?'internal':'confidential'}})
  expect(await createDeliveryAudienceAuthorizer({integrationStore:integrations})(input)).toMatchObject({allowed:true})
  expect(JSON.stringify(evidence)).toBe(original)
  await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,actor])
  expect(await createDeliveryAudienceAuthorizer({integrationStore:integrations})(input)).toMatchObject({allowed:false})
  expect(JSON.stringify(evidence)).toBe(original)
 })
})
