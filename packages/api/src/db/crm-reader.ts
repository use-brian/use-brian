/** Canonical legacy CRM point admission, without DTO-specific ACLs. [COMP:api/application-records] */
import type { AccessContext,ScopeSource } from '@use-brian/core'
import { boundScopeSources } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { canonicalNativeResourceDefinitions } from '../application-platform/native-resources.js'
import { currentApplicationReadTransaction } from '../application-platform/execution-context.js'
import { readCanonicalNativeRecord } from '../application-platform/field-evidence.js'
import { readCurrentScopeSources } from './derived-scope-store.js'
import type { PoolClient } from 'pg'
import { assertExecutionResourceScope,buildAccessPredicate } from './access-predicate.js'
import { runWithAgentAccess } from './agent-access-context.js'
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
export async function readLegacyCanonicalCrmPoint(access:AccessContext,type:'company'|'person'|'deal',id:string,fields:readonly string[]) {
  const bound=currentApplicationReadTransaction(access)
  return runWithAgentAccess({...access,clearance:access.clearance??'confidential',compartments:access.compartments,
    visibilityAssistantIds:access.visibilityAssistantIds??(access.assistantKind==='primary'?null:[access.assistantId])},async()=>{
    const client=bound?.client??await getAppPool().connect(),own=!bound
    try {
      if(own){await client.query('BEGIN');await applyRLSGucs(client,access.userId)}
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
