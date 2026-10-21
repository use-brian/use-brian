import {randomBytes,randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it} from 'vitest'
import {pinAccessCeiling,scopeEvidenceFromRows} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {createDbWorkflowStore,createDbWorkflowRunStore} from '../../db/workflow-store.js'
import {createDbChannelIntegrationStore} from '../../db/channel-integrations.js'
import {findOrCreateChannelForConnect} from '../../db/channels-store.js'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {validateAudienceScopeEvidence} from '../../context-scope/caller-evidence.js'
import {createDeliveryAudienceEnvelopeResolver} from '../../context-scope/delivery-authority.js'
import {createPublicationConsentStore,createWorkflowPublicationAuthorizer,createWorkflowPublicationDispatcher,publicationRevision} from '../../workflow/publication-consent.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] [COMP:workflow/publication-consent] actual source-backed publication compatibility',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function prepared(){
  fixture=await persistentContextFixture();const f=fixture,actor=f.ownerId
  const assistant=await findAssistantById(f.assistantId);if(!assistant)throw new Error('Missing actual fixture assistant')
  const execution=(await resolveExecutionContextSystem({userId:actor,workspaceId:f.workspaceId,assistant,memberMode:'member',
   identity:{kind:'attended',principal:{kind:'workspace_member',userId:actor,authenticationKind:'native_session'}},
   ownership:{kind:'workspace',workspaceId:f.workspaceId},lifecycle:{sessionId:randomUUID(),sessionPersisted:false,channelType:'web',
    channelId:'fictional-publication-context',abortSignal:new AbortController().signal}})).executionContext
  const integrations=createDbChannelIntegrationStore(randomBytes(32)),channel=await findOrCreateChannelForConnect({assistantId:f.assistantId,channelType:'telegram',displayName:'Fictional publication destination'})
  const integration=await integrations.upsert({channelId:channel,channelType:'telegram',teamId:null,teamName:null,botUserId:null,botUsername:null,actingUserId:actor,
   credentials:{bot_token:'fictional-publication-transport',webhook_secret:'fictional-publication-secret'}})
  const group='-1005550200'
  await integrations.updateConfig({id:integration.id,actingUserId:actor,config:{deliveryAudienceBindings:[{version:1,channelId:group,audienceType:'group',
   clearance:'internal',compartments:[],projectIds:[],recipientUserId:null,approvedByUserId:actor,approvedAt:new Date().toISOString(),expiresAt:null}]}})
  const workflows=createDbWorkflowStore(),runs=createDbWorkflowRunStore(),consents=createPublicationConsentStore()
  const workflow=await workflows.create({userId:actor,workspaceId:f.workspaceId,name:'Fictional prepared publication',
   authoringAuthority:{version:1,assistantId:f.assistantId,ceiling:pinAccessCeiling(execution.security.access)},
   definition:{startStepId:'prepare',steps:[{id:'prepare',type:'assistant_call',target:{assistantId:f.assistantId},prompt:'Fictional authored instruction',
    deliver:{channelType:'telegram',channelId:group,channelIntegrationId:integration.id}}]}})
  expect(await consents.approve({workflowId:workflow.id,workspaceId:f.workspaceId,stepId:'prepare',approvedByUserId:actor,workflowRevision:publicationRevision(workflow),
   channelType:'telegram',channelId:group,channelIntegrationId:integration.id,expiresAt:new Date(Date.now()+3600_000).toISOString()},'0')).toBe(true)
  const consent=(await consents.list(workflow.id,actor))[0];if(!consent)throw new Error('Missing actual publication consent')
  // Preserve the strict before-run consent rule at database/JS millisecond precision.
  await f.pool.query("SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz+interval '2 milliseconds'-clock_timestamp()))))",[consent.approvedAt])
  const run=await runs.createRun({workflowId:workflow.id,workspaceId:f.workspaceId,triggeredBy:actor,triggerKind:'manual'})
  await runs.updateRun(run.id,{status:'running',currentStepId:'prepare'})
  await runs.createStepRun({runId:run.id,stepId:'prepare',stepType:'assistant_call'})
  const memory=await f.memory('Fictional consenting owner private source',actor)
  const row=await createDbMemoryStore().getById(execution.security.access,memory.id);if(!row)throw new Error('Missing actual owner source')
  const evidence=scopeEvidenceFromRows([row]),input={workspaceId:f.workspaceId,assistantId:f.assistantId,userId:actor,channelType:'telegram',channelId:group,
   channelIntegrationId:integration.id,scopeEvidence:evidence,publication:{runId:run.id,stepId:'prepare'}}
  return{f,actor,integrations,workflow,run,consent,consents,evidence,input}
 }
 it('permits the consenting owner private source without erasing provenance or widening the group audience',async()=>{
  const f=await prepared(),original=JSON.stringify(f.evidence)
  const audience=await createDeliveryAudienceEnvelopeResolver({integrationStore:f.integrations})(f.input)
  expect(audience).toMatchObject({allowed:true,source:'binding',ceiling:{userId:''}})
  if(!audience.allowed)throw new Error('Missing actual approved audience')
  await expect(validateAudienceScopeEvidence(f.evidence,audience.ceiling)).rejects.toMatchObject({diagnostic:'user_visibility'})
  expect(await createWorkflowPublicationAuthorizer({integrationStore:f.integrations})(f.input)).toEqual({allowed:true,approvalId:f.consent.id})
  expect(JSON.stringify(f.evidence)).toBe(original)
  await f.consents.revoke(f.workflow.id,'prepare',f.actor)
  expect(await createWorkflowPublicationAuthorizer({integrationStore:f.integrations})(f.input)).toEqual({allowed:false})
  expect(JSON.stringify(f.evidence)).toBe(original)
 })
 it('rechecks actual consent and source evidence while the publication dispatch lock is held',async()=>{
  const f=await prepared();let sends=0
  const send=async()=>{
   const probe=await getPool().connect()
   try{
    await probe.query('BEGIN')
    const lock=(await probe.query<{acquired:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
     [`workflow-publication:${f.workflow.id}:${f.actor}`])).rows[0]
    expect(lock?.acquired).toBe(false)
   }finally{await probe.query('ROLLBACK');probe.release()}
   sends++;return'fictional-provider-message'
  }
  const dispatch=createWorkflowPublicationDispatcher({integrationStore:f.integrations})
  expect(await dispatch(f.input,f.consent.id,send)).toEqual({allowed:true,messageId:'fictional-provider-message'})
  expect(sends).toBe(1)
  await f.consents.revoke(f.workflow.id,'prepare',f.actor)
  expect(await dispatch(f.input,f.consent.id,send)).toEqual({allowed:false})
  expect(sends).toBe(1)
 })
})
