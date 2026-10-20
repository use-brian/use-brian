/** Canonical legacy CRM point admission, without DTO-specific ACLs. [COMP:api/application-records] */
import type { AccessContext,ScopeSource } from '@use-brian/core'
import { bindScopeSources,boundScopeSources,RANK } from '@use-brian/core'
import { ApplicationPlatformError,applicationQuerySchema,type ApplicationQuery } from '@use-brian/shared'
import { canonicalNativeResourceDefinitions } from '../application-platform/native-resources.js'
import { currentApplicationReadTransaction } from '../application-platform/execution-context.js'
import { readCanonicalNativeRecord } from '../application-platform/field-evidence.js'
import { queryCanonicalNativeRecords,readCanonicalNativeQueryDefinition,runCanonicalNativeQueryFrame } from '../application-platform/native-reader.js'
import { z } from 'zod'
import { readCurrentScopeSources } from './derived-scope-store.js'
import type { PoolClient } from 'pg'
import { assertExecutionResourceScope,buildAccessPredicate } from './access-predicate.js'
import { currentAgentAccess,runWithAgentAccess } from './agent-access-context.js'
import { applyRLSGucs,getAppPool,rollbackAndRelease } from './client.js'

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
export async function readLegacyCanonicalCrmPoint(access:AccessContext,type:'company'|'person'|'deal',id:string,fields:readonly string[],transactionClient?:PoolClient) {
  const bound=currentApplicationReadTransaction(access)
  if(bound&&transactionClient&&bound.client!==transactionClient)throw new ApplicationPlatformError('access_unavailable','The transaction is unavailable.')
  return runWithAgentAccess({...access,clearance:access.clearance??'confidential',compartments:access.compartments,
    visibilityAssistantIds:access.visibilityAssistantIds??(access.assistantKind==='primary'?null:[access.assistantId])},async()=>{
    const client=transactionClient??bound?.client??await getAppPool().connect(),own=!transactionClient&&!bound
    try {
      if(own){await client.query('BEGIN');await applyRLSGucs(client,access.userId)}
      if(transactionClient&&!bound&&(await client.query<{actor:string}>("SELECT current_setting('app.current_user_id',true) AS actor")).rows[0]?.actor!==access.userId)throw new ApplicationPlatformError('access_unavailable','The actor is unavailable.')
      await bound?.execution.security.authority.assertCurrent()
      bound?.assertLive()
      const definition=canonicalNativeResourceDefinitions().find(resource=>resource.typeKey===type)
      if(!definition)throw new ApplicationPlatformError('access_unavailable','The record is unavailable.')
      const context={transaction:client,workspaceId:access.workspaceId}
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
      await bound?.execution.security.authority.assertCurrent()
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
function nativeQueryDataCeiling(access:AccessContext,type:string,ids:readonly string[]|undefined) {
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
  const bound=currentApplicationReadTransaction(access)
  return runWithAgentAccess({...access,clearance:access.clearance??'confidential',compartments:access.compartments,
    visibilityAssistantIds:access.visibilityAssistantIds??(access.assistantKind==='primary'?null:[access.assistantId])},async()=>{
    const client=bound?.client??await getAppPool().connect(),own=!bound
    const context={transaction:client,workspaceId:access.workspaceId,...(bound?{assertLive:bound.assertLive}:{})}
    try {
      return await runCanonicalNativeQueryFrame(context,async()=>{
        let prior:string|undefined
        try {
          if(own){await client.query('BEGIN');await applyRLSGucs(client,access.userId)}
          await bound?.execution.security.authority.assertCurrent();bound?.assertLive()
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
          await bound?.execution.security.authority.assertCurrent();bound?.assertLive()
          prior=undefined
          if(own)await client.query('COMMIT')
          return bindScopeSources(results,sources)
        }catch(error){
          if(['42501','scope_operation_denied'].includes((error as {code?:string}).code??''))throw new ApplicationPlatformError('access_unavailable','The resource is unavailable.')
          throw error
        }finally{
          if(prior!==undefined&&!own)await client.query("SELECT set_config('app.native_query_data_ceilings',$1,true)",[prior]).catch(()=>{})
        }
      })
    }finally{if(own)await rollbackAndRelease(client)}
  })
}
