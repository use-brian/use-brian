/** Canonical candidate floors for reviewed and scheduled retention. [COMP:crm/retention] */
import type {Pool,PoolClient} from 'pg'
import {CrmOperationsError,deriveResourceScope,type CrmOperationsContext,type ResourceScope,type ScopeSource} from '@use-brian/core'
import {assertAssociationOrderAuthority,assertAssociationSourceAuthority} from '../association/source-scope.js'
import {assertCrmEventPrivacyAuthority} from './privacy-subject-authority.js'
import {assertCrmDeliveryScope} from './delivery-source-authority.js'
import {getPool} from '../db/client.js'

const unavailable=()=>new CrmOperationsError('not_authorized','The retention source scope is unavailable.')
type Binding={binding?:string[];cap?:ResourceScope['sensitivity']}
/** A key's durable department binding as a floor; no binding is General. */
const bindingScope=(workspaceId:string,binding:Binding|null):ResourceScope=>({workspaceId,userId:null,assistantId:null,
  sensitivity:binding?.cap ?? 'public',compartments:[...(binding?.binding ?? [])].map(id=>`team:${id}`).sort(),projectIds:[]})
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
      }else if(domain==='crm_delivery_receipts') {
        // Unclassified historical receipts are only ever retained (the selector marks them so):
        // no floor is fabricated for them and nothing about them is modified.
        const legacy=(await client.query<{legacy:boolean}>('SELECT scope_snapshot IS NULL AS legacy FROM crm_delivery_receipts WHERE workspace_id=$1 AND delivery_id=$2',[context.workspaceId,id])).rows[0]
        if(!legacy)throw unavailable()
        if(legacy.legacy)return
        const evidence=await assertCrmDeliveryScope(client,context.workspaceId,id,actor)
        if(evidence)await add(evidence.scope,evidence.sources)
      }else if(domain==='crm_import_jobs') {
        // The raw source decides: the staged file's labels, else the issuing key's binding.
        const row=(await client.query<{file:ResourceScope|null;binding:Binding|null;found:boolean}>(`SELECT true AS found,
            (SELECT jsonb_build_object('workspaceId',f.workspace_id,'userId',f.user_id,'assistantId',f.assistant_id,'sensitivity',f.sensitivity,
              'compartments',to_jsonb(f.compartments),'projectIds',to_jsonb(f.project_ids::text[])) FROM workspace_files f
              WHERE f.workspace_id=j.workspace_id AND f.id=j.staged_file_id) AS file,
            (SELECT c.department_binding FROM crm_integration_credentials c WHERE c.workspace_id=j.workspace_id AND c.id=j.integration_credential_id) AS binding
          FROM crm_import_jobs j WHERE j.workspace_id=$1 AND j.id=$2 FOR SHARE OF j`,[context.workspaceId,id])).rows[0]
        if(!row?.found)throw unavailable()
        await add(row.file ?? bindingScope(context.workspaceId,row.binding))
      }else if(domain==='crm_import_sources') {
        const row=(await client.query<{binding:Binding|null}>(`SELECT (SELECT c.department_binding FROM crm_integration_credentials c
            WHERE c.workspace_id=s.workspace_id AND c.id=s.credential_id) AS binding
          FROM crm_import_sources s WHERE s.workspace_id=$1 AND s.id=$2 FOR SHARE OF s`,[context.workspaceId,id])).rows[0]
        if(!row)throw unavailable()
        await add(bindingScope(context.workspaceId,row.binding))
      }else if(domain==='crm_intake_idempotency') {
        const row=(await client.query<{submission:string|null;binding:Binding|null}>(`SELECT
            (SELECT q.id FROM association_enquiries q WHERE q.workspace_id=i.workspace_id AND q.id=i.submission_id) AS submission,
            (SELECT c.department_binding FROM crm_intake_credentials c WHERE c.workspace_id=i.workspace_id AND c.id=i.credential_id) AS binding
          FROM crm_intake_idempotency i WHERE i.workspace_id=$1 AND i.id=$2 FOR SHARE OF i`,[context.workspaceId,id])).rows[0]
        if(!row)throw unavailable()
        if(row.submission) {
          const evidence=await assertAssociationOrderAuthority(client,context.workspaceId,row.submission,actor,'submission')
          if(!evidence)throw unavailable()
          await add(evidence.scope,evidence.sources)
        }else await add(bindingScope(context.workspaceId,row.binding))
      }else if(domain==='crm_address_suppression_tombstones'||domain==='association_audit_log') {
        // Keyed address hashes and retained-only audit horizons: no personal content, General floor.
        await add(emptyCrmRetentionScope(context.workspaceId))
      }else throw unavailable()
    },
  }
}
