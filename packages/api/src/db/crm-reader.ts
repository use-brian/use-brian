/** Canonical legacy CRM point admission, without DTO-specific ACLs. [COMP:api/application-records] */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AccessContext,ScopeSource } from '@use-brian/core'
import { bindScopeSources,boundScopeSources,RANK,decodeCrmAmount } from '@use-brian/core'
import { ApplicationPlatformError,applicationQuerySchema,type ApplicationQuery } from '@use-brian/shared'
import { currentCanonicalPublicShare } from '../application-platform/public-share-context.js'
import { canonicalNativeResourceDefinitions } from '../application-platform/native-resources.js'
import { currentApplicationReadTransaction,getApplicationExecutionBinding } from '../application-platform/execution-context.js'
import { readCanonicalNativeRecord } from '../application-platform/field-evidence.js'
import { captureCanonicalNativeQueryCandidates,queryCanonicalNativeRecords,readCanonicalNativeQueryDefinition,runCanonicalNativeQueryFrame } from '../application-platform/native-reader.js'
import { z } from 'zod'
import { readCurrentScopeSources } from './derived-scope-store.js'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { assertExecutionResourceScope,buildAccessPredicate } from './access-predicate.js'
import { currentAgentAccess,runWithAgentAccess } from './agent-access-context.js'
import { applyRLSGucs,getAppPool,rollbackAndRelease,queryWithRLS } from './client.js'

/** Reuse the canonical v1/v2 row predicate over verified scope metadata only. */
async function assertPointScopes(client:PoolClient,access:AccessContext,sources:readonly ScopeSource[]) {
  for(const source of sources)assertExecutionResourceScope(source,'read',access)
  const predicate=buildAccessPredicate(access,{alias:'scope',startIdx:1})
  const scopes=sources.map(source=>({workspace_id:source.workspaceId,user_id:source.userId,assistant_id:source.assistantId,
    sensitivity:source.sensitivity,compartments:source.compartments,project_ids:source.projectIds}))
  const result=await client.query<{admitted:boolean}>(`SELECT bool_and(${predicate.sql}) AS admitted FROM jsonb_to_recordset($${predicate.nextIdx}::jsonb)
    AS scope(workspace_id uuid,user_id uuid,assistant_id uuid,sensitivity text,compartments text[],project_ids uuid[])`,[...predicate.params,JSON.stringify(scopes)])
  if(result.rows[0]?.admitted!==true)throw new ApplicationPlatformError('access_unavailable','The source is unavailable.')
}
export async function readLegacyCanonicalCrmPoint(access:AccessContext,type:'company'|'person'|'deal'|'task',id:string,fields:readonly string[],transactionClient?:PoolClient) {
  const publicShare=access.systemRead&&access.userId==='00000000-0000-0000-0000-000000000000'?currentCanonicalPublicShare(access.workspaceId):undefined
  const bound=currentCrmReadTransaction(access)
  if(bound&&transactionClient&&bound.client!==transactionClient)throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
  return runWithAgentAccess({...access,clearance:access.clearance??'confidential',compartments:access.compartments,
    visibilityAssistantIds:access.visibilityAssistantIds??(access.assistantKind==='primary'?null:[access.assistantId])},async()=>{
    const client=transactionClient??bound?.client??await getAppPool().connect(),own=!transactionClient&&!bound
    try {
      if(own){await client.query('BEGIN');await applyRLSGucs(client,publicShare?.actorId??access.userId);await publicShare?.apply(client)}
      if(transactionClient&&!bound&&(await client.query<{actor:string}>("SELECT current_setting('app.current_user_id',true) AS actor")).rows[0]?.actor!==(publicShare?.actorId??access.userId))throw new ApplicationPlatformError('access_unavailable','The actor is unavailable.')
      await bound?.execution?.security.authority.assertCurrent()
      bound?.assertLive()
      const definition=canonicalNativeResourceDefinitions().find(resource=>resource.typeKey===type)
      if(!definition)throw new ApplicationPlatformError('access_unavailable','The record is unavailable.')
      const context={transaction:client,workspaceId:access.workspaceId,...((bound||publicShare)?{assertLive:()=>{bound?.assertLive();publicShare?.assertLive()}}:{})}
      let identity
      try{identity=await readCanonicalNativeRecord(context,definition,id,[]);await assertPointScopes(client,access,boundScopeSources(identity))}catch(error){
        if(error instanceof ApplicationPlatformError&&error.code==='access_unavailable'||(error as {code?:string}).code==='scope_operation_denied')return null
        throw error
      }
      bound?.assertLive()
      const projection=await readCanonicalNativeRecord(context,definition,id,fields)
      bound?.assertLive()
      const sources=[...boundScopeSources(identity),...boundScopeSources(projection)]
      await assertPointScopes(client,access,sources)
      bound?.assertLive()
      if(identity.ref.version!==projection.ref.version||(await readCurrentScopeSources(client,access.workspaceId,sources)).some(source=>source.state!=='current')) {
        throw new ApplicationPlatformError('access_unavailable','The source changed.')
      }
      await bound?.execution?.security.authority.assertCurrent()
      bound?.assertLive()
      if(own)await client.query('COMMIT')
      return {projection,scope:boundScopeSources(identity)[0],sources}
    }catch(error){
      if(['42501','scope_operation_denied'].includes((error as {code?:string}).code??''))throw new ApplicationPlatformError('access_unavailable','The record is unavailable.')
      throw error
    }finally{if(own)await rollbackAndRelease(client)}
  })
}

/** A private fixed data restriction; it intersects authority and never grants it. */
export function nativeQueryDataCeiling(access:AccessContext,type:string,ids:readonly string[]|undefined) {
  const agent=currentAgentAccess(),v2=agent?.departmentRead,rank=(tier:keyof typeof RANK)=>RANK[tier]
  const projects=v2?Object.keys(v2.projects??{}).filter(id=>v2.binding===null||v2.binding.includes(id)).sort():[]
  const departmentRead=v2?{kind:'native_department_v2',tier:Math.min(rank(v2.base),v2.cap?rank(v2.cap):3),
    departments:Object.fromEntries(Object.entries(v2.departments).filter(([id])=>v2.binding===null||v2.binding.includes(id)).map(([id,tier])=>[id,Math.min(rank(tier),v2.cap?rank(v2.cap):3)])),
    contextDepartment:v2.contextDepartment,projectLabels:projects,otherLabels:null,projectIds:agent?.projectIds??null}:null
  return {workspaceId:access.workspaceId,typeKey:type,ids:ids?[...new Set(ids)].sort():null,
    tier:v2?3:rank(agent?.clearance??access.clearance??'confidential'),compartments:v2?null:agent?.compartments??null,
    projectIds:agent?.projectIds??null,departmentRead,privateUserId:agent?.sharedAudience?null:access.userId,
    assistants:agent?.visibilityAssistantIds??null}
}

type LegacyCrmQuery={type:'company'|'person'|'deal';input:ApplicationQuery;ids?:readonly string[]}
/** Canonical legacy query batches retain one host lease and transaction. */
export async function queryLegacyCanonicalCrmBatch(access:AccessContext,queries:readonly LegacyCrmQuery[]) {
  if(queries.length>100)throw new ApplicationPlatformError('invalid_value','The batch is too large.')
  const parsed=queries.map(item=>({...item,input:applicationQuerySchema.parse(item.input),ids:item.ids?z.array(z.string().uuid()).max(100).parse(item.ids):undefined}))
  const publicShare=access.systemRead&&access.userId==='00000000-0000-0000-0000-000000000000'?currentCanonicalPublicShare(access.workspaceId):undefined
  const bound=currentCrmReadTransaction(access)
  return runWithAgentAccess({...access,clearance:access.clearance??'confidential',compartments:access.compartments,
    visibilityAssistantIds:access.visibilityAssistantIds??(access.assistantKind==='primary'?null:[access.assistantId])},async()=>{
    const client=bound?.client??await getAppPool().connect(),own=!bound
    const context={transaction:client,workspaceId:access.workspaceId,...((bound||publicShare)?{assertLive:()=>{bound?.assertLive();publicShare?.assertLive()}}:{})}
    try {
      return await runCanonicalNativeQueryFrame(context,async()=>{
        let prior:string|undefined
        try {
          if(own){await client.query('BEGIN');await applyRLSGucs(client,publicShare?.actorId??access.userId);await publicShare?.apply(client)}
          await bound?.execution?.security.authority.assertCurrent();bound?.assertLive()
          prior=(await client.query<{value:string|null}>("SELECT current_setting('app.native_query_data_ceilings',true) AS value")).rows[0]?.value??''
          let rawStack:unknown
          try{rawStack=prior?JSON.parse(prior):[]}catch{throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')}
          const stack=z.array(z.unknown()).max(15).safeParse(rawStack)
          if(!stack.success)throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')
          const results=[],sources:ScopeSource[]=[]
          for(const item of parsed) {
            await client.query("SELECT set_config('app.native_query_data_ceilings',$1,true)",[JSON.stringify([...stack.data,nativeQueryDataCeiling(access,item.type,item.ids)])])
            bound?.assertLive()
            const definition=await readCanonicalNativeQueryDefinition(context,item.type)
            const result=await queryCanonicalNativeRecords(context,definition,item.input)
            bound?.assertLive();results.push(result);sources.push(...boundScopeSources(result))
            await client.query("SELECT set_config('app.native_query_data_ceilings',$1,true)",[prior])
          }
          await assertPointScopes(client,access,sources)
          if((await readCurrentScopeSources(client,access.workspaceId,sources)).some(source=>source.state!=='current'))throw new ApplicationPlatformError('access_unavailable','The source changed.')
          await bound?.execution?.security.authority.assertCurrent();bound?.assertLive()
          prior=undefined
          if(own)await client.query('COMMIT')
          return bindScopeSources(results,sources)
        }catch(error){
          if(['42501','scope_operation_denied'].includes((error as {code?:string}).code??'')){const refusal=new ApplicationPlatformError('access_unavailable','The resource is unavailable.');Object.defineProperty(refusal,'cause',{value:error});throw refusal}
          throw error
        }finally{
          if(prior!==undefined&&!own)await client.query("SELECT set_config('app.native_query_data_ceilings',$1,true)",[prior]).catch(()=>{})
        }
      })
    }finally{if(own)await rollbackAndRelease(client)}
  })
}


export type CanonicalCrmTemplate = {type:'company'|'person'|'deal'|'record';fields:readonly string[]|'all';ids?:readonly string[];history?:boolean}
const attributeKeys:Record<string,string>={externalRef:'external_ref',ownerId:'owner_id',archivedAt:'crm_archived_at',companyId:'company_id',contactId:'contact_id',
  closeDate:'close_date',pipelineId:'pipeline_id',pipelineStageId:'pipeline_stage_id',currencyCode:'currency_code',winLossReason:'win_loss_reason'}
/** Fixed representation adapter for ephemeral legacy SQL, never a second business store. */
function nativeTemplateRow(workspaceId:string,type:string,candidate:{id:string;record_version:string;data:Record<string,unknown>;sources:ScopeSource[];value_encodings?:{amount?:string}}) {
  const value=candidate.data,scope=candidate.sources[0],attributes:Record<string,unknown>={},custom:Record<string,unknown>={}
  for(const [key,item] of Object.entries(value)) {
    if(['name','aliases','createdAt','updatedAt','participants'].includes(key))continue
    if(key.startsWith('custom.')){if(item!==null)custom[key.slice(7)]=item}
    else if(item!==null){
      if(key==='amount'&&candidate.value_encodings?.amount==='invalid')throw new ApplicationPlatformError('invalid_value','The canonical amount requires review.')
      attributes[attributeKeys[key]??key]=key==='amount'&&candidate.value_encodings?.amount==='number'&&typeof item==='string'?decodeCrmAmount(Number(item),item):item
    }
  }
  if(Object.keys(custom).length)attributes.custom_fields=custom
  return {id:candidate.id,workspace_id:workspaceId,kind:type,display_name:value.name??null,aliases:value.aliases??[],
    canonical_id:type==='company'?value.domain??null:type==='person'?value.email??null:null,attributes,
    created_at:value.createdAt??null,updated_at:value.updatedAt??null,user_id:scope.userId,assistant_id:scope.assistantId,
    sensitivity:scope.sensitivity,compartments:scope.compartments,project_ids:scope.projectIds,scope_version:candidate.record_version,
    scope_held:false,valid_to:null,retracted_at:null}
}
/**
 * Every template declares its complete consumed vocabulary before evaluation.
 * SQL sees only captured native snapshots; unknown raw attributes cannot leak.
 */
export async function queryLegacyCanonicalCrmSql<T extends QueryResultRow>(access:AccessContext,templates:readonly CanonicalCrmTemplate[],
  sql:string,parameters:readonly unknown[],transactionClient?:PoolClient):Promise<QueryResult<T>> {
  const publicShare=access.systemRead&&access.userId==='00000000-0000-0000-0000-000000000000'?currentCanonicalPublicShare(access.workspaceId):undefined
  const bound=currentCrmReadTransaction(access)
  if(bound&&transactionClient&&bound.client!==transactionClient)throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
  return runWithAgentAccess({...access,clearance:access.clearance??'confidential',compartments:access.compartments,
    visibilityAssistantIds:access.visibilityAssistantIds??(access.assistantKind==='primary'?null:[access.assistantId])},async()=>{
    const client=transactionClient??bound?.client??await getAppPool().connect(),own=!transactionClient&&!bound
    const context={transaction:client,workspaceId:access.workspaceId,...((bound||publicShare)?{assertLive:()=>{bound?.assertLive();publicShare?.assertLive()}}:{})}
    let prior:string|undefined
    try {
      if(own){await client.query('BEGIN');await applyRLSGucs(client,publicShare?.actorId??access.userId);await publicShare?.apply(client)}
      if(transactionClient&&!bound&&(await client.query<{actor:string}>("SELECT current_setting('app.current_user_id',true) AS actor")).rows[0]?.actor!==(publicShare?.actorId??access.userId))throw new ApplicationPlatformError('access_unavailable','The actor is unavailable.')
      return await runCanonicalNativeQueryFrame(context,async()=>{
        await bound?.execution?.security.authority.assertCurrent();bound?.assertLive()
        prior=(await client.query<{value:string|null}>("SELECT current_setting('app.native_query_data_ceilings',true) AS value")).rows[0]?.value??''
        const stack=z.array(z.unknown()).max(15).parse(prior?JSON.parse(prior):[])
        const sources:ScopeSource[]=[],rows:Record<string,unknown>[]=[],activities:Record<string,unknown>[]=[],participants:Record<string,unknown>[]=[],pipelines:Record<string,unknown>[]=[],stages:Record<string,unknown>[]=[],customFields:Record<string,unknown>[]=[]
        for(const entry of templates) {
          const resolved=entry.type==='record'?z.enum(['company','person','deal']).nullable().parse((await client.query<{type:unknown}>('SELECT application_native_record_type($1,$2) AS type',[access.workspaceId,entry.ids?.[0]])).rows[0]?.type):entry.type
          if(resolved===null)continue
          const template={...entry,type:resolved}
          await client.query("SELECT set_config('app.native_query_data_ceilings',$1,true)",[JSON.stringify([...stack,nativeQueryDataCeiling(access,template.type,template.ids)])])
          const definition=await readCanonicalNativeQueryDefinition(context,template.type,template.fields==='all')
          const fields=template.fields==='all'?definition.fields.map(field=>field.key):template.fields
          const candidates=await captureCanonicalNativeQueryCandidates(context,definition,fields)
          if(template.fields==='all'&&candidates.some(candidate=>candidate.legacy_attributes_complete!==true))throw new ApplicationPlatformError('access_unavailable','The canonical fields are unavailable.')
          rows.push(...candidates.map(candidate=>nativeTemplateRow(access.workspaceId,template.type,candidate)))
          if(template.type==='deal'&&fields.includes('participants'))for(const candidate of candidates) {
            const entries=z.array(z.object({contactId:z.string().uuid(),role:z.string().nullable(),isPrimary:z.boolean(),createdAt:z.string().datetime()}).strict()).max(256).parse(candidate.data.participants)
            participants.push(...entries.map(entry=>({workspace_id:access.workspaceId,deal_id:candidate.id,contact_id:entry.contactId,role:entry.role,is_primary:entry.isPrimary,created_at:entry.createdAt})))
          }
          sources.push(...boundScopeSources(candidates))
          if(template.history) {
            const captures=z.array(z.object({value:z.object({row:z.record(z.unknown()).nullable(),sources:z.array(z.object({workspaceId:z.literal(access.workspaceId),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),resourceKind:z.enum(['application_field','external_source']),resourceId:z.string().uuid(),version:z.string(),sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).strict()).min(1)}).strict()})).max(4096).parse((await client.query('SELECT * FROM read_native_application_crm_history($1,$2)',[access.workspaceId,candidates.map(candidate=>candidate.id)])).rows)
            for(const capture of captures){if(capture.value.row)activities.push(capture.value.row);sources.push(...capture.value.sources)}
          }
          await client.query("SELECT set_config('app.native_query_data_ceilings',$1,true)",[prior])
        }
        if(/\b(crm_pipeline_stages|crm_pipelines|crm_field_definitions)\b/i.test(sql)) {
          const configuration=(await client.query<{value:unknown}>('SELECT read_native_application_crm_configuration($1) AS value',[access.workspaceId])).rows[0]?.value
          if(configuration===null||configuration===undefined)throw new ApplicationPlatformError('access_unavailable','The configuration is unavailable.')
          const captured=z.object({values:z.object({config:configValue}).strict(),sources:z.array(z.object({workspaceId:z.literal(access.workspaceId),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),resourceKind:z.enum(['application_field','external_source']),resourceId:z.string().uuid(),version:z.string(),sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).strict()).min(1),policyVersion:z.string()}).strict().parse(configuration)
          for(const pipeline of captured.values.config.pipelines){pipelines.push({id:pipeline.id,workspace_id:access.workspaceId,name:pipeline.name,is_default:pipeline.isDefault,position:pipeline.position,archived_at:pipeline.archivedAt});
            stages.push(...pipeline.stages.map(stage=>({id:stage.id,workspace_id:access.workspaceId,pipeline_id:stage.pipelineId,name:stage.name,legacy_key:stage.legacyKey,category:stage.category,position:stage.position,probability:stage.probability,required_fields:stage.requiredFields,archived_at:stage.archivedAt})))}
          customFields.push(...captured.values.config.fields.map(field=>({id:field.id,workspace_id:access.workspaceId,entity_kind:field.entityKind,field_key:field.fieldKey,label:field.label,field_type:field.fieldType,options:field.options,is_required:field.isRequired,position:field.position,archived_at:field.archivedAt})))
          sources.push(...captured.sources)
        }
        bound?.assertLive()
        const relation=`SELECT * FROM jsonb_populate_recordset(NULL::public.entities,$${parameters.length+1}::jsonb)`
        if(/\bcrm_activities\b/i.test(sql)&&!templates.some(template=>template.history))throw new ApplicationPlatformError('access_unavailable','The history is unavailable.')
        const ctes=`entities AS MATERIALIZED (${relation}),crm_activities AS MATERIALIZED (SELECT * FROM jsonb_populate_recordset(NULL::public.crm_activities,$${parameters.length+2}::jsonb)),crm_deal_contacts AS MATERIALIZED (SELECT * FROM jsonb_populate_recordset(NULL::public.crm_deal_contacts,$${parameters.length+3}::jsonb)),crm_pipelines AS MATERIALIZED (SELECT * FROM jsonb_populate_recordset(NULL::public.crm_pipelines,$${parameters.length+4}::jsonb)),crm_pipeline_stages AS MATERIALIZED (SELECT * FROM jsonb_populate_recordset(NULL::public.crm_pipeline_stages,$${parameters.length+5}::jsonb)),crm_field_definitions AS MATERIALIZED (SELECT * FROM jsonb_populate_recordset(NULL::public.crm_field_definitions,$${parameters.length+6}::jsonb))`
        const statement=/^\s*WITH\s/i.test(sql)?sql.replace(/^(\s*WITH\s)/i,`$1 ${ctes}, `):`WITH ${ctes} ${sql}`
        const result=await client.query<T>(statement,[...parameters,JSON.stringify(rows),JSON.stringify(activities),JSON.stringify(participants),JSON.stringify(pipelines),JSON.stringify(stages),JSON.stringify(customFields)])
        bound?.assertLive();await assertPointScopes(client,access,sources)
        if((await readCurrentScopeSources(client,access.workspaceId,sources)).some(source=>source.state!=='current'))throw new ApplicationPlatformError('access_unavailable','The source changed.')
        await bound?.execution?.security.authority.assertCurrent();bound?.assertLive()
        for(const row of result.rows)bindScopeSources(row,sources)
        bindScopeSources(result.rows,sources);bindScopeSources(result,sources)
        if(own)await client.query('COMMIT')
        return result
      })
    }catch(error) {
      if(['42501','scope_operation_denied'].includes((error as {code?:string}).code??'')){const refusal=new ApplicationPlatformError('access_unavailable','The resource is unavailable.');Object.defineProperty(refusal,'cause',{value:error});throw refusal}
      throw error
    }finally {
      if(own)await rollbackAndRelease(client)
      else if(prior!==undefined)await client.query("SELECT set_config('app.native_query_data_ceilings',$1,true)",[prior]).catch(()=>{})
    }
  })
}

/** Preserve canonical evidence across DTO adaptation. */
export function mapCanonicalCrmRows<T extends object,U extends object>(rows:T[],map:(row:T)=>U):U[] {
  return bindScopeSources(rows.map(row=>bindScopeSources(map(row),boundScopeSources(row))),boundScopeSources(rows))
}

const configStage=z.object({id:z.string().uuid(),pipelineId:z.string().uuid(),name:z.string(),legacyKey:z.string().nullable(),category:z.enum(['open','won','lost']),position:z.number().int(),probability:z.number().int().min(0).max(100),requiredFields:z.array(z.string()).nullable().transform(value=>value??[]),archivedAt:z.string().nullable()}).strict()
const configValue=z.object({pipelines:z.array(z.object({id:z.string().uuid(),name:z.string(),isDefault:z.boolean(),position:z.number().int(),archivedAt:z.string().nullable(),stages:z.array(configStage)}).strict()),
  fields:z.array(z.object({id:z.string().uuid(),entityKind:z.enum(['company','person','deal']),fieldKey:z.string(),label:z.string(),fieldType:z.enum(['text','number','date','boolean','single_select','multi_select','entity_reference']),options:z.array(z.string()),isRequired:z.boolean(),position:z.number().int(),archivedAt:z.string().nullable()}).strict())}).strict()
/** Canonical metadata capture retains the actual app/native transaction and config revision. */
export async function readLegacyCanonicalCrmConfiguration(access:AccessContext,includeArchived:boolean,bootstrap:()=>Promise<unknown>) {
  const publicShare=access.userId==='00000000-0000-0000-0000-000000000000'?currentCanonicalPublicShare(access.workspaceId):undefined
  const bound=currentCrmReadTransaction(access)
  return runWithAgentAccess({...access,clearance:access.clearance??'confidential',compartments:access.compartments,
    visibilityAssistantIds:access.visibilityAssistantIds??(access.assistantKind==='primary'?null:[access.assistantId])},async()=>{
    const client=bound?.client??await getAppPool().connect(),own=!bound
    const context={transaction:client,workspaceId:access.workspaceId,...((bound||publicShare)?{assertLive:()=>{bound?.assertLive();publicShare?.assertLive()}}:{})}
    try {
      if(own){await client.query('BEGIN');await applyRLSGucs(client,publicShare?.actorId??access.userId);await publicShare?.apply(client)}
      return await runCanonicalNativeQueryFrame(context,async()=>{
        await bound?.execution?.security.authority.assertCurrent();bound?.assertLive()
        if((await client.query<{allowed:boolean}>('SELECT application_crm_configuration_read_allowed($1) AS allowed',[access.workspaceId])).rows[0]?.allowed!==true)throw new ApplicationPlatformError('access_unavailable','The configuration is unavailable.')
        if(!bound?.execution&&!publicShare&&(await client.query<{protected:boolean}>('SELECT application_native_crm_configuration_protected($1) AS protected',[access.workspaceId])).rows[0]?.protected===false)await bootstrap()
        const captured=z.object({values:z.object({config:configValue}).strict(),sources:z.array(z.object({workspaceId:z.literal(access.workspaceId),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),resourceKind:z.enum(['application_field','external_source']),resourceId:z.string().uuid(),version:z.string(),sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).strict()).min(1),policyVersion:z.string()}).strict().parse(
          (await client.query<{value:unknown}>('SELECT read_native_application_crm_configuration($1) AS value',[access.workspaceId])).rows[0]?.value)
        const config=captured.values.config
        if(!includeArchived){config.pipelines=config.pipelines.filter(pipeline=>!pipeline.archivedAt).map(pipeline=>({...pipeline,stages:pipeline.stages.filter(stage=>!stage.archivedAt)}));config.fields=config.fields.filter(field=>!field.archivedAt)}
        if((await readCurrentScopeSources(client,access.workspaceId,captured.sources)).some(source=>source.state!=='current'))throw new ApplicationPlatformError('access_unavailable','The configuration changed.')
        await bound?.execution?.security.authority.assertCurrent();bound?.assertLive()
        if(own)await client.query('COMMIT')
        return bindScopeSources(config,captured.sources)
      })
    }finally{if(own)await rollbackAndRelease(client)}
  })
}


const nativeReadTransactions=new AsyncLocalStorage<{client:PoolClient;workspaceId:string;actorId:string;active:boolean}>()
function currentCrmReadTransaction(access:AccessContext):{client:PoolClient;assertLive:()=>void;execution?:import('@use-brian/core').ExecutionContext}|undefined {
 const application=currentApplicationReadTransaction(access),native=nativeReadTransactions.getStore()
 if(application)return application
 if(!native)return undefined
 const assertLive=()=>{if(nativeReadTransactions.getStore()!==native||!native.active||native.workspaceId!==access.workspaceId||native.actorId!==access.userId)throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')}
 assertLive();return {client:native.client,assertLive}
}
/** Composite readers retain one current actor/lease and revalidate all evidence at their boundary. */
export async function runLegacyCanonicalCrmRead<T>(access:AccessContext,operation:()=>Promise<T>):Promise<T> {
 const inherited=currentCrmReadTransaction(access)
 const finish=async(client:PoolClient)=>{const result=await operation();if(result===null||result===undefined)return result
  const sources=boundScopeSources(result as object);inherited?.assertLive()
  await assertPointScopes(client,access,sources)
  if((await readCurrentScopeSources(client,access.workspaceId,sources)).some(source=>source.state!=='current'))throw new ApplicationPlatformError('access_unavailable','The source changed.')
  await inherited?.execution?.security.authority.assertCurrent();inherited?.assertLive();return result}
 if(inherited)return finish(inherited.client)
 return runWithAgentAccess({...access,clearance:access.clearance??'confidential',compartments:access.compartments,
  visibilityAssistantIds:access.visibilityAssistantIds??(access.assistantKind==='primary'?null:[access.assistantId])},async()=>{
   const client=await getAppPool().connect(),frame={client,workspaceId:access.workspaceId,actorId:access.userId,active:true}
   const publicShare=access.systemRead&&access.userId==='00000000-0000-0000-0000-000000000000'?currentCanonicalPublicShare(access.workspaceId):undefined
   try{await client.query('BEGIN');await applyRLSGucs(client,publicShare?.actorId??access.userId);await publicShare?.apply(client)
    const result=await nativeReadTransactions.run(frame,()=>finish(client));frame.active=false;await client.query('COMMIT');return result
   }finally{frame.active=false;await rollbackAndRelease(client)}
 })
}

/** Private mailbox/preferences have no application release port. An active
 * application may never escape to a fresh native member connection here. */
export async function queryLegacyCanonicalCrmPrivateSql<T extends QueryResultRow>(access:AccessContext,sql:string,parameters:readonly unknown[]):Promise<QueryResult<T>> {
  const bound=currentCrmReadTransaction(access)
  if(bound?.execution&&getApplicationExecutionBinding(bound.execution)||currentCanonicalPublicShare(access.workspaceId))
    throw new ApplicationPlatformError('access_unavailable','The private source is unavailable.')
  if(!bound)return queryWithRLS<T>(access.userId,sql,[...parameters])
  bound.assertLive()
  try{return await bound.client.query<T>(sql,[...parameters])}finally{bound.assertLive()}
}
