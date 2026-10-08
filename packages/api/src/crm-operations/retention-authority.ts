/** Canonical candidate floors for reviewed and scheduled retention. [COMP:crm/retention] */
import type {Pool,PoolClient} from 'pg'
import {CrmOperationsError,deriveResourceScope,type CrmOperationsContext,type ResourceScope,type ScopeSource} from '@use-brian/core'
import {assertAssociationOrderAuthority,assertAssociationSourceAuthority} from '../association/source-scope.js'
import {assertCrmEventPrivacyAuthority} from './privacy-subject-authority.js'
import {getPool} from '../db/client.js'

const unavailable=()=>new CrmOperationsError('not_authorized','The retention source scope is unavailable.')
export const emptyCrmRetentionScope=(workspaceId:string):ResourceScope=>({workspaceId,userId:null,assistantId:null,sensitivity:'public',compartments:[],projectIds:[]})
export async function assertCrmRetentionScope(client:Pool|PoolClient,context:CrmOperationsContext,scope:ResourceScope|null) {
  const workspace=(await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[context.workspaceId])).rows[0]
  if(workspace?.department_read_v2===false)return
  if(!workspace||!scope||context.actor.kind!=='user')throw unavailable()
  await assertAssociationSourceAuthority(client,context.workspaceId,
    {credentialKind:'user',credentialId:context.actor.userId,actingUserId:context.actor.userId},{scope,sources:[]})
}
export async function renewCrmRetentionScope(context:CrmOperationsContext,scope:ResourceScope|null) {
  await assertCrmRetentionScope(getPool(),context,scope)
}
export async function createCrmRetentionAuthority(client:PoolClient,context:CrmOperationsContext) {
  const workspace=(await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[context.workspaceId])).rows[0]
  if(!workspace||context.actor.kind!=='user')throw unavailable()
  let floor:ResourceScope|null=workspace.department_read_v2===false?null:emptyCrmRetentionScope(context.workspaceId)
  const actor={credentialKind:'user' as const,credentialId:context.actor.userId,actingUserId:context.actor.userId}
  const add=async(scope:ResourceScope,sources:ScopeSource[]=[])=>{
    await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope,sources})
    floor=deriveResourceScope({producer:'crm.retention',sources:[...sources,
      {...scope,resourceKind:'retention-source-floor',resourceId:context.workspaceId,version:'current'},
      {...floor!,resourceKind:'retention-floor',resourceId:context.workspaceId,version:'accumulated'}]})
  }
  return {
    scope:()=>floor,
    async capture(domain:string,id:string) {
      if(!floor)return
      if(domain==='association_enquiries') {
        const evidence=await assertAssociationOrderAuthority(client,context.workspaceId,id,actor,'submission')
        if(!evidence)throw unavailable()
        await add(evidence.scope,evidence.sources)
      }else if(domain==='association_orders'||domain==='association_membership_offline_rescues') {
        const evidence=await assertAssociationOrderAuthority(client,context.workspaceId,id,actor,domain==='association_orders'?'order':'rescue')
        if(!evidence)throw unavailable()
        await add(evidence.scope,evidence.sources)
      }else if(domain==='crm_domain_event_outbox') {
        const evidence=await assertCrmEventPrivacyAuthority(client,context,id);await add(evidence.scope,evidence.sources)
      }else if(domain==='crm_import_file_cleanups') {
        const row=(await client.query<{scope:ResourceScope|null}>('SELECT scope_snapshot AS scope FROM crm_import_file_cleanups WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.workspaceId,id])).rows[0]
        if(!row?.scope)throw unavailable()
        await add(row.scope)
      }
    },
  }
}
