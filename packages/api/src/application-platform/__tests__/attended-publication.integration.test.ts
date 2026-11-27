import {randomBytes,randomUUID} from 'node:crypto'
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import {pinAccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {ContextScopeAccumulator,scopeEvidenceFromRows} from '@use-brian/agent-runtime/security/context-scope.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {createDbWorkflowStore,createDbWorkflowRunStore} from '../../db/workflow-store.js'
import {createDbChannelIntegrationStore} from '../../db/channel-integrations.js'
import {findOrCreateChannelForConnect} from '../../db/channels-store.js'
import {readPersistentSessionContextAncestors} from '../../db/session-context-ancestry.js'
import {addSessionMessage,findOrCreateSession} from '../../db/sessions.js'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {turnOutputWrite} from '../../context-scope/resolve-turn-scope.js'
import {validateAudienceScopeEvidence} from '../../context-scope/caller-evidence.js'
import {createDeliveryAudienceEnvelopeResolver} from '../../context-scope/delivery-authority.js'
import {createWorkflowChannelDelivery} from '../../workflow/channel-delivery.js'
import {createPublicationConsentStore,createWorkflowPublicationAuthorizer,createWorkflowPublicationDispatcher,publicationRevision} from '../../workflow/publication-consent.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] [COMP:workflow/publication-consent] actual source-backed publication compatibility',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>|undefined
 afterEach(async()=>{vi.unstubAllGlobals();await fixture?.cleanup();fixture=undefined})
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 async function prepared({clearance='internal',seedPrivateMemory=true,departmentReadV2=false}: {
  clearance?:'internal'|'confidential';seedPrivateMemory?:boolean;departmentReadV2?:boolean
 }={}){
  fixture=await persistentContextFixture();const f=fixture,actor=f.ownerId
  if(departmentReadV2)await f.pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
  const assistant=await findAssistantById(f.assistantId);if(!assistant)throw new Error('Missing actual fixture assistant')
  const execution=(await resolveExecutionContextSystem({userId:actor,workspaceId:f.workspaceId,assistant,memberMode:'member',
   identity:{kind:'attended',principal:{kind:'workspace_member',userId:actor,authenticationKind:'native_session'}},
   ownership:{kind:'workspace',workspaceId:f.workspaceId},lifecycle:{sessionId:randomUUID(),sessionPersisted:false,channelType:'web',
    channelId:'fictional-publication-context',abortSignal:new AbortController().signal}})).executionContext
  const integrations=createDbChannelIntegrationStore(randomBytes(32)),channel=await findOrCreateChannelForConnect({assistantId:f.assistantId,channelType:'telegram',displayName:'Fictional publication destination'})
  const integration=await integrations.upsert({channelId:channel,channelType:'telegram',teamId:null,teamName:null,botUserId:null,botUsername:null,actingUserId:actor,
   credentials:{bot_token:'fictional-publication-transport',webhook_secret:'fictional-publication-secret'}})
  const group='-1005550200'
  const setAudienceClearance=(clearance:'internal'|'confidential')=>integrations.updateConfig({
   id:integration.id,actingUserId:actor,config:{deliveryAudienceBindings:[{version:1,channelId:group,audienceType:'group',
    clearance,compartments:[],projectIds:[],recipientUserId:null,approvedByUserId:actor,approvedAt:new Date().toISOString(),expiresAt:null}]}})
  await setAudienceClearance(clearance)
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
  const memory=seedPrivateMemory?await f.memory('Fictional consenting owner private source',actor):undefined
  const row=memory?await createDbMemoryStore().getById(execution.security.access,memory.id):undefined
  if(memory&&!row)throw new Error('Missing actual owner source')
  const evidence=scopeEvidenceFromRows(row?[row]:[]),input={workspaceId:f.workspaceId,assistantId:f.assistantId,userId:actor,channelType:'telegram' as const,channelId:group,
   channelIntegrationId:integration.id,scopeEvidence:evidence,publication:{runId:run.id,stepId:'prepare'}}
  return{f,actor,assistant,execution,integrations,workflow,run,consent,consents,evidence,input,setAudienceClearance}
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
 async function preparedTurn(){
  const {f,actor,assistant,execution,integrations,workflow,run,consent,consents,evidence,input,setAudienceClearance}=await prepared({
   clearance:'confidential',seedPrivateMemory:false,departmentReadV2:true})
  const session=await findOrCreateSession({assistantId:assistant.id,userId:actor,workspaceId:f.workspaceId,
   channelType:'assistant-call',channelId:`workflow-run:${workflow.id}:${Date.now()}`,contextCompartments:[],contextGroupId:null,contextProjectId:null})
  const delegated=(await resolveExecutionContextSystem({userId:actor,workspaceId:f.workspaceId,assistant,session,sessionAuthority:session,
   identity:{kind:'delegated',actorUserId:actor,delegationId:run.id,parentCeiling:execution.security.ceiling},
   ownership:{kind:'workspace',workspaceId:f.workspaceId},lifecycle:{sessionId:session.id,channelId:session.channelId,
    channelType:'assistant-call',abortSignal:new AbortController().signal}})).executionContext
  const accumulator=new ContextScopeAccumulator(evidence)
  const authority={execution:delegated,accumulator}
  const memories=createDbMemoryStore()
  const ranked=await memories.getIndexRanked(delegated.security.access,1,authority)
  const workspace=await memories.getWorkspaceIndex(delegated.security.access,undefined,authority)
  const memorySources=[...boundScopeSources(ranked.rows),...boundScopeSources(workspace)]
  const domains=await f.pool.query(`SELECT q.domain->'includeRetained' AS "includeRetained",
   jsonb_array_length(q.domain->'candidates') AS "candidateCount"
   FROM application_field_resources r JOIN application_query_domains q
    ON q.workspace_id=r.workspace_id AND q.id=r.resource_id
   WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND r.type_key='memory' AND r.selection='query_domain'`,
  [f.workspaceId,memorySources.map(source=>source.resourceId)])
  expect(domains.rows).toEqual([{includeRetained:true,candidateCount:0},{includeRetained:true,candidateCount:0}])
  expect(memorySources.every(source=>source.sensitivity==='public')).toBe(true)
  accumulator.note({sources:memorySources})
  const message=await addSessionMessage({sessionId:session.id,role:'user',content:[{type:'text',text:'Fictional outage alert request'}],
   authority,
   ...turnOutputWrite({producer:'turn:delegated-input',accumulator,envelope:{...f.envelope,userId:actor}})})
  const messageSources=boundScopeSources(message)
  const revisionSources=await readPersistentSessionContextAncestors(f.workspaceId,messageSources)
  expect(messageSources).toContainEqual(expect.objectContaining({resourceKind:'session_message',resourceId:message.id}))
  expect(revisionSources).toEqual([expect.objectContaining({resourceKind:'session_context_revision',sensitivity:'confidential'})])
  accumulator.note({sources:[...messageSources,...revisionSources]})
  const publication={...input,scopeEvidence:accumulator.evidence,text:'TEST outage alert'}
  return{f,actor,execution,integrations,workflow,consent,consents,session,publication,setAudienceClearance}
 }
 it('publishes a prepared Telegram alert with actual delegated turn evidence',async()=>{
  const {actor,execution,integrations,workflow,consent,consents,publication,setAudienceClearance}=await preparedTurn()
  const original=structuredClone(publication.scopeEvidence)
  await expect(validateAudienceScopeEvidence(original,execution.security.ceiling)).rejects.toMatchObject({diagnostic:'source_unverifiable'})
  const authorize=createWorkflowPublicationAuthorizer({integrationStore:integrations})
  expect(await authorize(publication)).toEqual({allowed:true,approvalId:consent.id})

  const provider=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>{
   expect(String(url)).toMatch(/\/sendMessage$/)
   expect(JSON.parse(String(init?.body))).toMatchObject({chat_id:publication.channelId,text:publication.text})
   return Response.json({ok:true,result:{message_id:42}})
  })
  vi.stubGlobal('fetch',provider)
  const deliver=createWorkflowChannelDelivery({integrationStore:integrations})
  expect(await deliver(publication)).toMatchObject({status:'delivered',channelId:publication.channelId,messageId:'42',publicationApprovalId:consent.id})
  expect(publication.scopeEvidence).toEqual(original)
  const refused={status:'skipped',reason:'delivery_audience_unverified'}
  expect(await deliver({...publication,channelId:'-1005550201'})).toMatchObject(refused)
  const unverifiable={...publication.scopeEvidence,sources:publication.scopeEvidence.sources?.map(source=>
   source.resourceKind==='session_context_revision'?{...source,resourceId:randomUUID()}:source)}
  expect(await deliver({...publication,scopeEvidence:unverifiable})).toMatchObject(refused)
  await setAudienceClearance('internal')
  expect(await deliver(publication)).toMatchObject(refused)
  await setAudienceClearance('confidential')
  expect(await authorize(publication)).toEqual({allowed:true,approvalId:consent.id})
  await consents.revoke(workflow.id,'prepare',actor)
  expect(await deliver(publication)).toMatchObject(refused)
  expect(provider).toHaveBeenCalledTimes(1)
 })
 it('refuses delivery when the original assistant-call session is held',async()=>{
  const {f,integrations,consent,session,publication}=await preparedTurn()
  const authorize=createWorkflowPublicationAuthorizer({integrationStore:integrations})
  expect(await authorize(publication)).toEqual({allowed:true,approvalId:consent.id})
  await f.pool.query('UPDATE sessions SET recording_privacy_held=true WHERE id=$1',[session.id])
  const provider=vi.fn()
  vi.stubGlobal('fetch',provider)
  expect(await createWorkflowChannelDelivery({integrationStore:integrations})(publication))
   .toMatchObject({status:'skipped',reason:'delivery_audience_unverified'})
  expect(provider).not.toHaveBeenCalled()
 })
})
