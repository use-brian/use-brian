/** One app-scoped source setup over existing deployment trust and source protocol. [COMP:api/source-service-binding] */
import {createHash,randomUUID} from 'node:crypto'
import type {PoolClient} from 'pg'
import {maxSensitivity,type ExecutionContext} from '@use-brian/core'
import {ApplicationPlatformError} from '@use-brian/shared'
import {SourceProtocolError} from '@use-brian/brian-app/connector'
import {getPool} from '../../../db/client.js'
import {buildConnectorAuthHeaders} from '../../../mcp/auth-headers.js'
import {validateCallerScopeEvidence} from '../../../context-scope/caller-evidence.js'
import {createConnectorRuntimeAuthority} from '../../connector-runtime-authority.js'
import {getSharedSourceDeployment} from '../../source-runtime.js'
import {createSourceAccessClient,trustedSourceReadBinding,trustedSourceOperationProof} from '../../source-access.js'
import {z} from 'zod'
export const sourceSetupInput=z.object({instanceId:z.string().uuid(),tenant:z.string().min(1).max(256),audience:z.string().url().max(2048),recordId:z.string().min(1).max(1024),effectBinding:z.literal('command_v1').optional(),fields:z.array(z.string().min(1).max(128)).min(1).max(128).refine(v=>new Set(v).size===v.length)}).strict()
function denied():never{throw new ApplicationPlatformError('access_unavailable','Source setup is unavailable.')}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function prepareApplicationSourceSetup(client:PoolClient,execution:ExecutionContext,appId:string,raw:unknown){
 const parsed=sourceSetupInput.safeParse(raw);if(!parsed.success)throw new ApplicationPlatformError('invalid_value','The source setup is invalid.')
 const deployment=getSharedSourceDeployment();if(!deployment?.keys)denied()
 const instance=await deployment.instances.getSystem(parsed.data.instanceId)
 if(!instance||instance.scope!=='workspace'||instance.workspaceId!==execution.security.access.workspaceId||!instance.url||!instance.connected)denied()
 const url=new URL(instance.url),audience=new URL(parsed.data.audience)
 if(url.pathname!=='/mcp'||url.search||url.hash||url.username||url.password||audience.protocol!=='https:'||audience.username||audience.password||audience.search||audience.hash)denied()
 if(!await deployment.keys.loadActiveKey(deployment.issuer))denied()
 const native=await createConnectorRuntimeAuthority({workspaceId:instance.workspaceId!,initiatingUserId:execution.security.access.userId,assistantId:execution.assistant.id})
 if(!native.allows({compartments:instance.compartments??[],projectIds:instance.projectIds??[]}))denied();await native.assertCurrent();await execution.security.authority.assertCurrent()
 const proposal={...parsed.data,issuer:deployment.issuer,sourceBaseUrl:url.origin,mcpUrl:url.href}
 const review=(await client.query<{id:string}>('SELECT application_prepare_source_setup($1,$2,$3) AS id',[execution.security.access.workspaceId,appId,proposal])).rows[0]
 return {reviewId:review.id,appId,instanceId:instance.id,tenant:proposal.tenant,audience:proposal.audience,fields:proposal.fields,...(proposal.effectBinding?{effectBinding:proposal.effectBinding}:{}),canApply:true}
}
export async function applyApplicationSourceSetup(client:PoolClient,execution:ExecutionContext,appId:string,reviewId:string){
 const row=(await client.query<{profileId:string;proposal:z.infer<typeof sourceSetupInput>&{issuer:string;sourceBaseUrl:string;mcpUrl:string};snapshot:string;consumed:boolean}>(`SELECT profile_id AS "profileId",proposal,snapshot,consumed FROM application_source_setup_reviews
 WHERE id=$1 AND app_id=$2 AND workspace_id=$3 AND actor_id=$4`,[reviewId,appId,execution.security.access.workspaceId,execution.security.access.userId])).rows[0]
 if(!row)denied()
 if(row.consumed)return {profileId:(await client.query<{id:string}>('SELECT application_apply_source_setup($1,$2) AS id',[reviewId,null])).rows[0].id}
 const deployment=getSharedSourceDeployment();if(!deployment?.keys||deployment.issuer!==row.proposal.issuer)denied()
 const initial=await deployment.instances.getSystem(row.proposal.instanceId),credentials=await deployment.instances.getAuthCredentialsSystem(row.proposal.instanceId)
 if(!initial||initial.scope!=='workspace'||initial.workspaceId!==execution.security.access.workspaceId||initial.url!==row.proposal.mcpUrl||!credentials)denied()
 const native=await createConnectorRuntimeAuthority({workspaceId:execution.security.access.workspaceId,initiatingUserId:execution.security.access.userId,assistantId:execution.assistant.id})
 const initialHash=hash([initial,credentials])
 const assertCurrent=async()=>{
  await execution.security.authority.assertCurrent();await native.assertCurrent()
  const fresh=await deployment.instances.getSystem(row.proposal.instanceId),auth=await deployment.instances.getAuthCredentialsSystem(row.proposal.instanceId)
  if(!fresh||hash([fresh,auth])!==initialHash||!native.allows({compartments:fresh.compartments??[],projectIds:fresh.projectIds??[]}))denied()
  const snapshot=(await client.query<{value:string|null}>('SELECT application_source_setup_snapshot($1,$2,$3) AS value',[execution.security.access.workspaceId,appId,row.proposal.instanceId])).rows[0]?.value
  if(snapshot!==row.snapshot)denied()
 }
 await assertCurrent()
 const source=createSourceAccessClient(execution,{issuer:deployment.issuer,audience:row.proposal.audience,workspaceId:execution.security.access.workspaceId,connectorInstanceId:initial.id,
  sourceBaseUrl:row.proposal.sourceBaseUrl,mcpUrl:row.proposal.mcpUrl,httpReadPath:'/http/read',tenant:row.proposal.tenant,bindingRevision:'1',
  subject:{kind:'human',id:execution.security.access.userId,executingAssistantId:execution.assistant.id}},
 {...deployment.keys,admit:async()=>{await assertCurrent();return{bindingRevision:'1',actor:{kind:'human' as const,userId:execution.security.access.userId,authenticationKind:'native_session' as const}}}},
 {headers:buildConnectorAuthHeaders(credentials)??{}})
 const capabilities=await source.capabilities();if(!capabilities.retentionModes.includes('governed')||!capabilities.fieldEvidence
  ||row.proposal.effectBinding==='command_v1'&&(capabilities.effectBinding!=='command_v1'||!capabilities.reconciliation))denied()
 const read=await source.readHttp({id:row.proposal.recordId,fields:row.proposal.fields})
 const binding=trustedSourceReadBinding(read,execution),proof=binding&&trustedSourceOperationProof(binding.proof,execution)
 if(!binding||!proof||binding.envelope.resources.length!==1)denied()
 const observations=[]
 for(const observation of binding.envelope.resources){
  if(observation.resource.id!==row.proposal.recordId||observation.retention.mode!=='governed'||observation.fields.length!==row.proposal.fields.length||observation.fields.some(field=>!row.proposal.fields.includes(field)))denied()
  const sensitivity=maxSensitivity(initial.sensitivity,observation.labels.sensitivity),compartments=[...new Set([...(initial.compartments??[]),...observation.labels.compartments])].sort(),projectIds=[...new Set([...(initial.projectIds??[]),...observation.labels.projectIds])].sort()
  await validateCallerScopeEvidence({sensitivity,compartments,projectIds},execution.security.ceiling)
  observations.push({observation,sensitivity,compartments,projectIds,version:hash([row.profileId,observation,sensitivity,compartments,projectIds])})
 }
 await proof.assertCurrent();await assertCurrent()
 const expiry=Math.min(...binding.proof.response.decisions.flatMap(d=>d.allowed?[d.receipt.expiresAt]:[]));if(!Number.isFinite(expiry))denied()
 const approval=randomUUID();await getPool().query('INSERT INTO application_source_setup_approvals(id,review_id,actor_id,snapshot,observations,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[approval,reviewId,execution.security.access.userId,row.snapshot,JSON.stringify(observations),new Date(expiry)])
 try{const profileId=(await client.query<{id:string}>('SELECT application_apply_source_setup($1,$2) AS id',[reviewId,approval])).rows[0].id;await proof.assertCurrent();await assertCurrent();return {profileId}}
 catch(error){if(error instanceof SourceProtocolError)denied();throw error}
}
