/** Legacy task DTOs over canonical admitted native snapshots. [COMP:api/application-records] */
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { bindScopeSources,boundScopeSources,TASK_STATUSES,type AccessContext,type ScopeSource,type TaskRecord,type TaskListRow,type TaskListFilters } from '@use-brian/core'
import { ApplicationPlatformError,type ApplicationRecordProjection } from '@use-brian/shared'
import { currentApplicationReadTransaction } from '../application-platform/execution-context.js'
import { currentCanonicalPublicShare } from '../application-platform/public-share-context.js'
import { canonicalNativeTaskHistoryPhysicalParent,readCanonicalNativeTaskHistoryDomain,readCanonicalNativeTaskHistoryRecord,type CanonicalGenericReadContext } from '../application-platform/field-evidence.js'
import { canonicalNativeResourceDefinitions } from '../application-platform/native-resources.js'
import { captureCanonicalNativeQueryCandidates,readCanonicalNativeQueryDefinition,runCanonicalNativeQueryFrame } from '../application-platform/native-reader.js'
import { assertExecutionResourceScope,buildAccessPredicate } from './access-predicate.js'
import { runWithAgentAccess } from './agent-access-context.js'
import { applyRLSGucs,getAppPool,rollbackAndRelease } from './client.js'
import { nativeQueryDataCeiling,readLegacyCanonicalCrmPoint } from './crm-reader.js'
import { readCurrentScopeSources } from './derived-scope-store.js'

export const LEGACY_TASK_FULL_FIELDS=['title','status','assigneeId','executorAssistantId','followUpMemberId','home','due','tags','parentId','externalRef','attributes','createdAt','updatedAt'] as const
const compactFields=LEGACY_TASK_FULL_FIELDS.filter(field=>field!=='externalRef'&&field!=='createdAt')
const scope=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
  sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).passthrough()
const metadata=z.object({id:z.string().uuid(),logicalId:z.string().uuid(),version:z.string().min(1),scope}).passthrough()
type Metadata=z.infer<typeof metadata>
const taskValues=z.object({title:z.string(),status:z.enum(TASK_STATUSES),assigneeId:z.string().uuid().nullable(),
  executorAssistantId:z.string().uuid().nullable(),followUpMemberId:z.string().uuid().nullable(),
  home:z.object({kind:z.enum(['department','project']),id:z.string().uuid()}).strict().nullable(),due:z.string().nullable(),tags:z.array(z.string()),
  parentId:z.string().uuid().nullable(),externalRef:z.record(z.unknown()).optional(),attributes:z.record(z.unknown()),createdAt:z.string().optional(),updatedAt:z.string()})
const unavailable=()=>new ApplicationPlatformError('access_unavailable','The task is unavailable.')

async function checkScopes(client:PoolClient,access:AccessContext,sources:readonly ScopeSource[]) {
  for(const source of sources)assertExecutionResourceScope(source,'read',access)
  if(!sources.length)return
  const ap=buildAccessPredicate(access,{alias:'scope',startIdx:1})
  const rows=sources.map(source=>({workspace_id:source.workspaceId,user_id:source.userId,assistant_id:source.assistantId,
    sensitivity:source.sensitivity,compartments:source.compartments,project_ids:source.projectIds}))
  if((await client.query<{admitted:boolean}>(`SELECT bool_and(${ap.sql}) AS admitted FROM jsonb_to_recordset($${ap.nextIdx}::jsonb)
    AS scope(workspace_id uuid,user_id uuid,assistant_id uuid,sensitivity text,compartments text[],project_ids uuid[])`,[...ap.params,JSON.stringify(rows)])).rows[0]?.admitted!==true)throw unavailable()
}
async function withRead<T>(access:AccessContext,transactionClient:PoolClient|undefined,operation:(client:PoolClient,context:CanonicalGenericReadContext)=>Promise<T>):Promise<T> {
  const publicShare=access.systemRead&&access.userId==='00000000-0000-0000-0000-000000000000'?currentCanonicalPublicShare(access.workspaceId):undefined
  const bound=currentApplicationReadTransaction(access)
  if(bound&&transactionClient&&bound.client!==transactionClient)throw unavailable()
  return runWithAgentAccess({...access,clearance:access.clearance??'confidential',compartments:access.compartments,
    visibilityAssistantIds:access.visibilityAssistantIds??(access.assistantKind==='primary'?null:[access.assistantId])},async()=>{
    const client=transactionClient??bound?.client??await getAppPool().connect(),own=!transactionClient&&!bound
    const context={transaction:client,workspaceId:access.workspaceId,...((bound||publicShare)?{assertLive:()=>{bound?.assertLive();publicShare?.assertLive()}}:{})}
    try {
      if(own){await client.query('BEGIN');await applyRLSGucs(client,publicShare?.actorId??access.userId);await publicShare?.apply(client)}
      if(transactionClient&&!bound&&(await client.query<{actor:string}>("SELECT current_setting('app.current_user_id',true) AS actor")).rows[0]?.actor!==(publicShare?.actorId??access.userId))throw unavailable()
      await bound?.execution.security.authority.assertCurrent();bound?.assertLive()
      const value=await runCanonicalNativeQueryFrame(context,()=>operation(client,context))
      bound?.assertLive();await bound?.execution.security.authority.assertCurrent();bound?.assertLive()
      if(own)await client.query('COMMIT')
      return value
    } catch(error) {
      if(['42501','scope_operation_denied'].includes((error as {code?:string}).code??''))throw unavailable()
      throw error
    } finally {if(own)await rollbackAndRelease(client)}
  })
}
/** Application references are logical; the legacy task DTO keeps its live physical parent ID. */
async function legacyParent(client:PoolClient,workspaceId:string,values:ApplicationRecordProjection['values']) {
  const parentId=values.parentId
  if(parentId===null||parentId===undefined)return values
  if(typeof parentId!=='string')throw unavailable()
  const raw=(await client.query<{value:unknown}>('SELECT read_native_application_task_identity($1,$2,true) AS value',[workspaceId,parentId])).rows[0]?.value
  if(raw===null||raw===undefined)throw unavailable()
  return {...values,parentId:metadata.parse(raw).id}
}
function record(meta:Metadata,raw:ApplicationRecordProjection['values'],sources:readonly ScopeSource[],history=false):TaskRecord {
  const values=taskValues.parse(raw)
  const result={id:meta.id,logicalId:meta.logicalId,workspaceId:meta.scope.workspaceId,title:values.title,status:values.status,assigneeId:values.assigneeId,
    executorAssistantId:values.executorAssistantId,followUpMemberId:values.followUpMemberId,home:values.home,due:values.due===null?null:new Date(values.due),tags:values.tags,
    parentId:values.parentId,externalRef:values.externalRef??{},attributes:values.attributes,sensitivity:meta.scope.sensitivity,compartments:meta.scope.compartments,
    projectIds:meta.scope.projectIds,createdAt:new Date(values.createdAt??values.updatedAt),updatedAt:new Date(values.updatedAt)}
  const physical:ScopeSource={resourceKind:'task',resourceId:meta.id,version:meta.version,workspaceId:meta.scope.workspaceId,userId:meta.scope.userId,
    assistantId:meta.scope.assistantId,sensitivity:meta.scope.sensitivity,compartments:meta.scope.compartments,projectIds:meta.scope.projectIds}
  // Historical physical rows are retired; their canonical history field source
  // carries current history rights without pretending the old row is live.
  return bindScopeSources(result,history?[...sources]:[physical,...sources])
}
export async function readLegacyCanonicalTask(access:AccessContext,id:string,transactionClient?:PoolClient,resolve=false):Promise<TaskRecord|null> {
  return withRead(access,transactionClient,async client=>{
    const raw=(await client.query<{value:unknown}>('SELECT read_native_application_task_identity($1,$2,$3) AS value',[access.workspaceId,id,resolve])).rows[0]?.value
    if(raw===null||raw===undefined)return null
    const meta=metadata.parse(raw),captured=await readLegacyCanonicalCrmPoint(access,'task',meta.id,LEGACY_TASK_FULL_FIELDS,client)
    if(!captured)return null
    if(captured.projection.ref.version!==meta.version)throw unavailable()
    const values=await legacyParent(client,access.workspaceId,captured.projection.values)
    await current(client,access,captured.sources)
    return record(meta,values,captured.sources)
  })
}
async function candidates(client:PoolClient,context:CanonicalGenericReadContext,access:AccessContext,fields:readonly string[],ids?:readonly string[]) {
  const prior=(await client.query<{value:string|null}>("SELECT current_setting('app.native_query_data_ceilings',true) AS value")).rows[0]?.value??''
  const stack=z.array(z.unknown()).max(15).parse(prior?JSON.parse(prior):[])
  try {
    await client.query("SELECT set_config('app.native_query_data_ceilings',$1,true)",[JSON.stringify([...stack,nativeQueryDataCeiling(access,'task',ids)])])
    const definition=await readCanonicalNativeQueryDefinition(context,'task')
    return await captureCanonicalNativeQueryCandidates(context,definition,fields)
  } finally {await client.query("SELECT set_config('app.native_query_data_ceilings',$1,true)",[prior])}
}
async function current(client:PoolClient,access:AccessContext,sources:readonly ScopeSource[]) {
  await checkScopes(client,access,sources)
  if((await readCurrentScopeSources(client,access.workspaceId,sources)).some(source=>source.state!=='current'))throw unavailable()
}
/** Canonical candidate preflight for existing dedup writers; every consumed field is admitted before SQL equality. */
export function captureLegacyCanonicalTaskCandidates(access:AccessContext,fields:readonly string[],client:PoolClient) {
 return withRead(access,client,async(transaction,context)=>{const captured=await candidates(transaction,context,access,fields)
  await current(transaction,access,boundScopeSources(captured));return captured})
}
export async function listLegacyCanonicalTasks(access:AccessContext,filters:TaskListFilters):Promise<TaskListRow[]> {
  return withRead(access,undefined,async(client,context)=>{
    const captured=await candidates(client,context,access,compactFields),sources=boundScopeSources(captured)
    // Every predicate/order field is captured before evaluation, including rows
    // excluded by a filter and rows beyond the old operator page limit.
    const parentMeta=filters.parentId?(await client.query<{value:unknown}>('SELECT read_native_application_task_identity($1,$2,false) AS value',[access.workspaceId,filters.parentId])).rows[0]?.value:undefined
    const parentFilter=parentMeta?metadata.parse(parentMeta).logicalId:null
    const parsed=captured.map(candidate=>({candidate,values:taskValues.parse(candidate.data)}))
    const selected=parsed.filter(({values:v})=>(!filters.assigneeId||v.assigneeId===filters.assigneeId)
      &&(!filters.executorAssistantId||v.executorAssistantId===filters.executorAssistantId)
      &&(!filters.followUpMemberId||v.followUpMemberId===filters.followUpMemberId)
      &&(filters.status?(Array.isArray(filters.status)?filters.status.includes(v.status):filters.status===v.status):filters.includeArchived||v.status!=='archived')
      &&(!filters.dueBefore||v.due!==null&&new Date(v.due)<filters.dueBefore)
      &&(!filters.dueAfter||v.due!==null&&new Date(v.due)>filters.dueAfter)
      &&(!filters.tag||v.tags.includes(filters.tag))&&(!filters.parentId||parentFilter!==null&&v.parentId===parentFilter))
    const rows:TaskListRow[]=[]
    for(const {candidate} of selected.sort((a,b)=>Date.parse(b.values.updatedAt)-Date.parse(a.values.updatedAt))) {
      const meta=metadata.parse((await client.query<{value:unknown}>('SELECT read_native_application_task_identity($1,$2,false) AS value',[access.workspaceId,candidate.id])).rows[0]?.value)
      if(meta.version!==candidate.record_version)throw unavailable()
      if(filters.projectId!==undefined&&(filters.projectId===null?meta.scope.projectIds.length!==0:meta.scope.projectIds.length!==1||meta.scope.projectIds[0]!==filters.projectId))continue
      const full=record(meta,await legacyParent(client,access.workspaceId,candidate.data),candidate.sources),{externalRef:_,createdAt:__,...compact}=full
      rows.push(bindScopeSources(compact,boundScopeSources(full)))
      if(rows.length>=Math.min(Math.max(filters.limit??25,1),500))break
    }
    await current(client,access,sources)
    return bindScopeSources(rows,sources)
  })
}
export async function readLegacyCanonicalTaskHistory(access:AccessContext,id:string):Promise<TaskRecord[]> {
  return withRead(access,undefined,async(client,context)=>{
    const domainSources=await readCanonicalNativeTaskHistoryDomain(context,id,LEGACY_TASK_FULL_FIELDS)
    const refs=z.array(metadata.extend({validFrom:z.string()})).max(4096).parse((await client.query<{value:unknown}>(
      'SELECT value FROM read_native_application_task_history_refs($1,$2,$3) refs(value)',[access.workspaceId,id,[...LEGACY_TASK_FULL_FIELDS]])).rows.map(row=>row.value))
    const definition=canonicalNativeResourceDefinitions().find(item=>item.typeKey==='task')!
    const sources:ScopeSource[]=[...domainSources],rows:TaskRecord[]=[]
    for(const ref of refs) {
      const projection=await readCanonicalNativeTaskHistoryRecord(context,definition,ref.id,LEGACY_TASK_FULL_FIELDS,ref.version)
      if(projection.ref.version!==ref.version)throw unavailable()
      sources.push(...boundScopeSources(projection));rows.push(record(ref,{...projection.values,parentId:canonicalNativeTaskHistoryPhysicalParent(projection)},boundScopeSources(projection),true))
    }
    await current(client,access,sources)
    return bindScopeSources(rows,sources)
  })
}
export async function listLegacyCanonicalRecordingTasks(access:AccessContext,episodeId:string) {
  return withRead(access,undefined,async(client,context)=>{
    const captured=await candidates(client,context,access,['title','status','assigneeId','sourceEpisodeId','sourceStartMs','verified','createdAt'])
    const fields=z.object({title:z.string(),status:z.enum(TASK_STATUSES),assigneeId:z.string().uuid().nullable(),sourceEpisodeId:z.string().uuid().nullable(),
      sourceStartMs:z.number().nullable(),verified:z.boolean(),createdAt:z.string()})
    const parsed=captured.map(row=>({row,values:fields.parse(row.data)})).filter(({values})=>values.sourceEpisodeId===episodeId)
    parsed.sort((a,b)=>(a.values.sourceStartMs===null?Infinity:a.values.sourceStartMs)-(b.values.sourceStartMs===null?Infinity:b.values.sourceStartMs)
      ||Date.parse(a.values.createdAt)-Date.parse(b.values.createdAt))
    const sources=boundScopeSources(captured);await current(client,access,sources)
    return bindScopeSources(parsed.map(({row,values})=>bindScopeSources({id:row.id,title:values.title,status:values.status,assigneeId:values.assigneeId,
      sourceStartMs:values.sourceStartMs,verified:values.verified},row.sources)),sources)
  })
}
