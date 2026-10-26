/** Server-owned references to existing app/source authority, never a second ACL. [COMP:api/source-service-binding] */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { canRead, scopeGrantContains, decideApplicationAuthority, type ExecutionContext, type ScopeSource } from '@use-brian/core'
import { SourceProtocolError, type SourceAuthorizationRequest, type SourceSubject } from '@use-brian/brian-app/connector'
import { getPool } from '../db/client.js'
import { eff, type AccessSnapshot } from '../context-scope/reference-predicate.js'
import { authenticateBoundApplicationCredential } from './credentials.js'
import { getApplicationExecutionBinding, resolveApplicationExecutionContext } from './execution-context.js'

export type SourceServiceBindingRow = { id:string;workspaceId:string;profileId:string;appId:string;credentialId:string;serviceUserId:string;
  assistantId:string;workflowId:string|null;configuredByUserId:string;authorityFingerprint:string;definitionFingerprint:string|null;
  status:'pending'|'active'|'revoked';revision:string;expiresAt:Date }
const select=`SELECT id,workspace_id AS "workspaceId",profile_id AS "profileId",app_id AS "appId",credential_id AS "credentialId",
 service_user_id AS "serviceUserId",assistant_id AS "assistantId",workflow_id AS "workflowId",configured_by_user_id AS "configuredByUserId",
 authority_fingerprint AS "authorityFingerprint",definition_fingerprint AS "definitionFingerprint",status,revision::text,expires_at AS "expiresAt"
 FROM source_service_bindings`
export type SourceServiceCredentialReference = Readonly<{bindingId:string}>
type Loaded = {row:SourceServiceBindingRow;assertCurrent:()=>Promise<void>}
const references=new WeakMap<SourceServiceCredentialReference,Loaded>()
const executions=new WeakMap<ExecutionContext,Loaded>()
function denied():never {throw new SourceProtocolError('source_access_denied')}
const key=(row:SourceServiceBindingRow)=>JSON.stringify(row)
async function read(id:string):Promise<SourceServiceBindingRow|undefined>{return (await getPool().query<SourceServiceBindingRow>(select+' WHERE id=$1',[id])).rows[0]}
async function current(row:SourceServiceBindingRow,pending:boolean){
  if(row.status!==(pending?'pending':'active')||row.expiresAt.getTime()<=Date.now())denied()
  const fresh=await read(row.id)
  if(!fresh||key(fresh)!==key(row))denied()
  const actual=(await getPool().query<{fingerprint:string|null;definition:string|null}>(`SELECT source_service_authority_fingerprint($1,$2,$3,$4,$5,$6) AS fingerprint,
    (SELECT encode(sha256(convert_to(definition::text,'UTF8')),'hex') FROM workflows WHERE id=$7 AND workspace_id=$1) AS definition`,
  [row.workspaceId,row.profileId,row.appId,row.credentialId,row.serviceUserId,row.assistantId,row.workflowId])).rows[0]
  if(!actual?.fingerprint||actual.fingerprint!==row.authorityFingerprint||actual.definition!==row.definitionFingerprint)denied()
}
async function loadReference(id:string,pending=false){
  const row=await read(id);if(!row)denied()
  let invalid=false
  const assertCurrent=async()=>{if(invalid)denied();try{await current(row,pending)}catch(error){invalid=true;throw error}}
  await assertCurrent()
  const reference=Object.freeze({bindingId:row.id});references.set(reference,{row,assertCurrent});return reference
}
/** The credentials module accepts only this exact private token, not its JSON descriptor. */
export function getSourceServiceCredentialReference(reference:SourceServiceCredentialReference){
 const proof=references.get(reference);return proof?{row:structuredClone(proof.row),assertCurrent:proof.assertCurrent}:undefined
}
export function getSourceServiceExecutionBinding(execution:ExecutionContext){
 const proof=executions.get(execution);return proof?{row:structuredClone(proof.row),assertCurrent:proof.assertCurrent}:undefined
}
export async function resolveSourceServiceExecution(bindingId:string,options:{runId?:string;pendingReview?:boolean}={}){
 const reference=await loadReference(bindingId,options.pendingReview===true),binding=references.get(reference)!
 const credential=await authenticateBoundApplicationCredential(reference)
 if(!credential)denied()
 const execution=await resolveApplicationExecutionContext({credential},{sessionId:options.runId??randomUUID(),channelType:options.runId?'workflow':'source-service'})
 const app=getApplicationExecutionBinding(execution)
 if(!app||app.state.principal.kind!=='service'||app.state.principal.userId!==binding.row.serviceUserId||app.state.appId!==binding.row.appId
  ||execution.assistant.id!==binding.row.assistantId)denied()
 executions.set(execution,binding);await binding.assertCurrent();return execution
}

/** Native governance transaction creates an inert review. Configuring a reference grants no new rights. */
export async function prepareSourceServiceBinding(client:PoolClient,actorId:string,workspaceId:string,input:{profileId:string;appId:string;credentialId:string;workflowId?:string;expiresAt:string}){
 const actor=(await client.query<{allowed:boolean;actor:string}>(`SELECT application_governance_allows($1) AS allowed,
  nullif(current_setting('app.current_user_id',true),'') AS actor`,[workspaceId])).rows[0]
 if(!actor?.allowed||actor.actor!==actorId)denied()
 const row=(await client.query<{id:string}>('SELECT prepare_source_service_binding($1,$2,$3,$4,$5,$6) AS id',
 [workspaceId,input.profileId,input.appId,input.credentialId,input.workflowId??null,input.expiresAt])).rows[0]
 return {reviewId:row.id,canActivate:false as const}
}
/** Runtime application ceiling; source permission is always a separate fresh decision. */
export async function assertSourceServiceRequest(execution:ExecutionContext,request:SourceAuthorizationRequest){
 const binding=getSourceServiceExecutionBinding(execution),app=getApplicationExecutionBinding(execution)
 if(!binding||!app)denied();await binding.assertCurrent();await execution.security.authority.assertCurrent()
 const profile=(await getPool().query<{instance:string;tenant:string}>('SELECT connector_instance_id AS instance,tenant FROM connector_source_profiles WHERE id=$1 AND workspace_id=$2',
  [binding.row.profileId,binding.row.workspaceId])).rows[0];if(!profile)denied()
 for(const recipient of request.recipients)if(recipient.subject.kind!=='service'||recipient.subject.id!==binding.row.serviceUserId||recipient.subject.executingAssistantId!==binding.row.assistantId)denied()
 for(const item of request.items){
  // Reads/context use the read ceiling; derivation, retention and delivery need their distinct named-command ceilings.
  // Source mutations additionally require the deployed command ceiling and are not enabled by this read caller.
  const action=item.action==='read'||item.action==='context'?'read':`command:source.${item.action}`
  const decision=decideApplicationAuthority(app.state.layers,{ref:{workspaceId:binding.row.workspaceId,
   origin:{kind:'external',connectorInstanceId:profile.instance,sourceTenant:profile.tenant},typeKey:item.resource.type,id:item.resource.id,version:item.resource.contentVersion},
   scope:{workspaceId:binding.row.workspaceId,userId:null,assistantId:null,sensitivity:'public',compartments:[],projectIds:[]},ownerUserId:null,relationships:new Set()},action,item.fields,item.action==='mutate'?item.fields:[])
  if(!decision.allowed||item.fields.some(field=>!(item.action==='mutate'?decision.writeFields:decision.readFields).includes(field)))denied()
 }
 await binding.assertCurrent()
}
export function sourceServiceSubject(execution:ExecutionContext):SourceSubject|undefined{
 const binding=getSourceServiceExecutionBinding(execution);return binding?{kind:'service',id:binding.row.serviceUserId,executingAssistantId:binding.row.assistantId}:undefined
}

/** Capture only existing external release paths, never arbitrary source catalog guesses. */
export async function sourceServiceReviewRequest(execution:ExecutionContext):Promise<SourceAuthorizationRequest>{
 const binding=getSourceServiceExecutionBinding(execution),app=getApplicationExecutionBinding(execution);if(!binding||!app)denied()
 const profile=(await getPool().query<{instance:string;tenant:string}>('SELECT connector_instance_id AS instance,tenant FROM connector_source_profiles WHERE id=$1',[binding.row.profileId])).rows[0]
 if(!profile)denied()
 const ids=[...new Set(app.state.layers.flat(2).flatMap(path=>path.current).filter(g=>g.origin.kind==='external'
  &&g.origin.connectorInstanceId===profile.instance&&g.origin.sourceTenant===profile.tenant&&g.selector.kind==='ids').flatMap(g=>g.selector.kind==='ids'?g.selector.ids:[]))]
 if(!ids.length||ids.length>100)denied()
 const observations=(await getPool().query<{observation:import('@use-brian/brian-app/connector').SourceObservation}>(`SELECT DISTINCT ON(r.id) o.observation
  FROM external_source_resources r JOIN external_source_observations o ON o.resource_id=r.id AND o.workspace_id=r.workspace_id
  WHERE r.profile_id=$1 AND r.state='active' AND r.opaque_id=ANY($2::text[]) ORDER BY r.id,o.created_at DESC,o.id`,[binding.row.profileId,ids])).rows
 if(observations.length!==ids.length)denied()
 return {version:'ub.source.v1',operationId:randomUUID(),items:observations.map(({observation:o})=>({itemId:randomUUID(),resource:o.resource,fields:o.fields,action:'context',retentionMode:'governed'})),
  recipients:[{recipientId:randomUUID(),subject:sourceServiceSubject(execution)!}]}
}

/** Reuse the assistant reference predicate independently of the service's application release. */
export async function assertSourceServiceScope(execution:ExecutionContext,scope:Pick<ScopeSource,'sensitivity'|'compartments'|'projectIds'>){
 const binding=getSourceServiceExecutionBinding(execution);if(!binding)denied();await binding.assertCurrent()
 const ceiling=execution.security.ceiling
 if(!canRead(ceiling.clearance,scope.sensitivity)||!scopeGrantContains(ceiling.compartments,scope.compartments)||!scopeGrantContains(ceiling.projectIds,scope.projectIds))denied()
 const id=binding.row.assistantId,w=binding.row.workspaceId
 const assistant=(await getPool().query<{clearance:'public'|'internal'|'confidential';v2:boolean;legacy:string[]|null}>(`SELECT a.clearance,w.department_read_v2 AS v2,legacy_assistant_team_compartments(a.id) AS legacy
 FROM assistants a JOIN workspaces w ON w.id=a.workspace_id WHERE a.id=$1 AND a.workspace_id=$2`,[id,w])).rows[0]
 if(!assistant||!canRead(assistant.clearance,scope.sensitivity))denied()
 if(assistant.v2){
  const edges=(await getPool().query<{departmentId:string;clearance:'public'|'internal'|'confidential';expiresAt:Date|null}>('SELECT department_id AS "departmentId",clearance,expires_at AS "expiresAt" FROM department_edges WHERE workspace_id=$1 AND assistant_id=$2',[w,id])).rows
  const snapshot:AccessSnapshot={workspaceId:w,base:{['assistant:'+id]:assistant.clearance},edges:edges.map(e=>({...e,principal:{kind:'assistant',id}}))}
  for(const label of scope.compartments){const tier=label.startsWith('team:')?eff(snapshot,{principal:{kind:'assistant',id},assistant:null,credential:null},label.slice(5),new Date()):null;if(!tier||!canRead(tier,scope.sensitivity))denied()}
 }else if(!scopeGrantContains(assistant.legacy,scope.compartments))denied()
 for(const project of scope.projectIds){if((await getPool().query<{allowed:boolean}>("SELECT project_member_live($1,'assistant',$2) AS allowed",[project,id])).rows[0]?.allowed!==true)denied()}
 await binding.assertCurrent()
}

export type SourceServiceReleaseIntent=Readonly<{operationId:string}>
const releaseIntents=new WeakMap<SourceServiceReleaseIntent,{execution:ExecutionContext;digest:string;assertCurrent:()=>Promise<void>}>()
async function releaseIntent(client:PoolClient,actorId:string,workspaceId:string,execution:ExecutionContext,request:SourceAuthorizationRequest){
 const assertCurrent=async()=>{
  const row=(await client.query<{allowed:boolean;actor:string}>(`SELECT application_governance_allows($1) AS allowed,nullif(current_setting('app.current_user_id',true),'') AS actor`,[workspaceId])).rows[0]
  if(!row?.allowed||row.actor!==actorId)denied()
  const binding=getSourceServiceExecutionBinding(execution);if(!binding||binding.row.workspaceId!==workspaceId)denied();await binding.assertCurrent();await execution.security.authority.assertCurrent()
 }
 await assertCurrent()
 const intent=Object.freeze({operationId:request.operationId});releaseIntents.set(intent,{execution,digest:JSON.stringify(request),assertCurrent});return intent
}
/** Host-only prospective release, never an alternate read or mutation path. */
export function getSourceServiceReleaseIntent(intent:SourceServiceReleaseIntent,execution:ExecutionContext,request:SourceAuthorizationRequest){
 const proof=releaseIntents.get(intent);return proof?.execution===execution&&proof.digest===JSON.stringify(request)?{assertCurrent:proof.assertCurrent}:undefined
}
async function serviceRuntime(execution:ExecutionContext){
 const {getSharedRetainedSourceAuthority,getSharedSourceInstances}=await import('./source-runtime.js')
 const {buildConnectorAuthHeaders}=await import('../mcp/auth-headers.js')
 const binding=getSourceServiceExecutionBinding(execution),wiring=getSharedRetainedSourceAuthority(),instances=getSharedSourceInstances()
 if(!binding||!wiring||!instances)denied()
 const profile=(await getPool().query<{instance:string}>('SELECT connector_instance_id AS instance FROM connector_source_profiles WHERE id=$1',[binding.row.profileId])).rows[0]
 const credentials=profile?.instance&&await instances.getAuthCredentialsSystem(profile.instance);if(!credentials)denied()
 const {ContextScopeAccumulator}=await import('@use-brian/core')
 const runtime=await wiring.factory({workspaceId:binding.row.workspaceId,instanceId:profile.instance,execution,accumulator:new ContextScopeAccumulator(),headers:buildConnectorAuthHeaders(credentials)??{}})
 if(!runtime?.authorizeRelease)denied();return runtime
}
/** Fresh source check at activation; the existing SQL qualification barrier still decides availability. */
export async function activateSourceServiceBinding(client:PoolClient,actorId:string,workspaceId:string,reviewId:string){
 const execution=await resolveSourceServiceExecution(reviewId,{pendingReview:true}),binding=getSourceServiceExecutionBinding(execution)!
 const request=await sourceServiceReviewRequest(execution);await assertSourceServiceRequest(execution,request)
 const intent=await releaseIntent(client,actorId,workspaceId,execution,request),runtime=await serviceRuntime(execution)
 const proof=await runtime.authorizeRelease!(request,intent);await binding.assertCurrent()
 const expiry=Math.min(...proof.response.decisions.flatMap(d=>d.allowed?[d.receipt.expiresAt]:[]))
 const id=randomUUID();await getPool().query('INSERT INTO source_service_binding_approvals(id,binding_id,actor_id,fingerprint,expires_at) VALUES($1,$2,$3,$4,$5)',
 [id,reviewId,actorId,binding.row.authorityFingerprint,new Date(expiry)])
 return {bindingId:(await client.query<{id:string}>('SELECT activate_source_service_binding($1,$2) AS id',[reviewId,id])).rows[0].id}
}

/** A prospective external app release is independently source-approved for the named service. */
export async function prepareExternalSourceGrantRelease(client:PoolClient,actorId:string,workspaceId:string,appId:string,proposal:import('@use-brian/shared').ApplicationGrantInput){
 if(proposal.origin.kind!=='external'||proposal.principal.kind!=='service'||proposal.selector.kind!=='ids')denied()
 const selected=(await getPool().query<{id:string;status:'pending'|'active'}>(`SELECT b.id,b.status FROM source_service_bindings b JOIN connector_source_profiles p ON p.id=b.profile_id
 WHERE b.workspace_id=$1 AND b.app_id=$2 AND b.service_user_id=$3 AND p.connector_instance_id=$4 AND p.tenant=$5 AND b.status<>'revoked'
 ORDER BY b.created_at DESC LIMIT 1`,[workspaceId,appId,proposal.principal.userId,proposal.origin.connectorInstanceId,proposal.origin.sourceTenant])).rows[0]
 if(!selected)denied()
 const execution=await resolveSourceServiceExecution(selected.id,{pendingReview:selected.status==='pending'}),binding=getSourceServiceExecutionBinding(execution)!
 const rows=(await getPool().query<{observation:import('@use-brian/brian-app/connector').SourceObservation}>(`SELECT DISTINCT ON(r.id) o.observation FROM external_source_resources r
 JOIN external_source_observations o ON o.resource_id=r.id AND o.workspace_id=r.workspace_id WHERE r.profile_id=$1 AND r.state='active' AND r.resource_type=$2 AND r.opaque_id=ANY($3::text[])
 ORDER BY r.id,o.created_at DESC,o.id`,[binding.row.profileId,proposal.typeKey,proposal.selector.ids])).rows
 if(rows.length!==proposal.selector.ids.length)denied()
 const actions=[...new Set(proposal.actions.map(a=>a.startsWith('command:source.')?a.slice(15):['read','query','history','schema'].includes(a)?'context':'mutate'))]
 if(actions.some(a=>!['read','context','derive','retain','deliver','export','mutate'].includes(a))||rows.length*actions.length>100)denied()
 const request:SourceAuthorizationRequest={version:'ub.source.v1',operationId:randomUUID(),items:rows.flatMap(({observation:o})=>actions.map(action=>({itemId:randomUUID(),resource:o.resource,
  fields:action==='mutate'?proposal.writeFields:proposal.readFields,action:action as import('@use-brian/brian-app/connector').SourceAction,retentionMode:'governed' as const}))),
  recipients:[{recipientId:randomUUID(),subject:sourceServiceSubject(execution)!}]}
 const intent=await releaseIntent(client,actorId,workspaceId,execution,request),runtime=await serviceRuntime(execution)
 const proof=await runtime.authorizeRelease!(request,intent)
 for(const {observation:o} of rows){
  await assertSourceServiceScope(execution,o.labels)
  if(!canRead(proposal.clearance,o.labels.sensitivity)||!scopeGrantContains(proposal.compartments,o.labels.compartments)||!scopeGrantContains(proposal.projectIds,o.labels.projectIds))denied()
 }
 const expiry=Math.min(...proof.response.decisions.flatMap(d=>d.allowed?[d.receipt.expiresAt]:[]));if(!Number.isFinite(expiry))denied()
 const snapshot={bindingId:binding.row.id,bindingRevision:binding.row.revision,authorityFingerprint:binding.row.authorityFingerprint,profileId:binding.row.profileId,
  resources:rows.map(({observation:o})=>({resource:o.resource,labels:o.labels})).sort((a,b)=>a.resource.id.localeCompare(b.resource.id)),fields:[...new Set([...proposal.readFields,...proposal.writeFields])].sort()}
 const id=randomUUID();await getPool().query(`INSERT INTO source_service_release_reviews(id,workspace_id,app_id,binding_id,actor_id,proposal,snapshot,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,workspaceId,appId,binding.row.id,actorId,proposal,snapshot,new Date(expiry)])
 await client.query("SELECT set_config('app.source_service_release_review_id',$1,true)",[id])
 await getSourceServiceReleaseIntent(intent,execution,request)!.assertCurrent();return id
}
