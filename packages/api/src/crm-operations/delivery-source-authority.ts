/** Saved recipient/evidence floors for durable receipts. [COMP:crm/delivery-receipts] */
import { actorAuditIdentity, CrmOperationsError, deriveResourceScope, DerivedScopeError,
  type AssociationActor, type CrmOperationsContext, type ResourceScope, type ScopeSource } from '@use-brian/core'
import type { PoolClient } from 'pg'
import { assertAssociationOrderAuthority, assertAssociationSourceAuthority, loadAssociationOrderScope } from '../association/source-scope.js'
import { withNativeDeliverySourceAuthority } from './delivery-native-authority.js'

type Evidence={scope:ResourceScope;sources:ScopeSource[]}
const denied=()=>new CrmOperationsError('not_authorized','Delivery evidence is not available to this actor.')

export async function withCrmDeliverySourceActor<T>(client:PoolClient,context:CrmOperationsContext,run:(actor:AssociationActor)=>Promise<T>):Promise<T> {
  if(context.authority.nativeDelivery)return withNativeDeliverySourceAuthority(client,context.workspaceId,
    {actor:context.actor,ceiling:context.authority.nativeDelivery},run)
  const identity=actorAuditIdentity(context.actor)
  if(context.actor.kind!=='user' && context.actor.kind!=='integration_key')throw denied()
  return run({credentialKind:context.actor.kind,credentialId:identity.actorCredentialId,
    ...(identity.actingUserId?{actingUserId:identity.actingUserId}:{}),
    ...(context.authority.integration?{integration:context.authority.integration}:{})})
}

export async function captureCrmDeliveryScope(client:PoolClient,context:CrmOperationsContext,contactIds:string[],purposeKey:string):Promise<Evidence|null> {
  const workspace=(await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[context.workspaceId])).rows[0]
  if(workspace?.department_read_v2===false)return null
  if(!workspace)throw denied()
  return withCrmDeliverySourceActor(client,context,async actor=>{
    const current=await loadAssociationOrderScope(client,context.workspaceId,contactIds)
    const sources=[...current.sources]
    const events=await client.query<{id:string;kind:'consent'|'suppression'}>(`SELECT id,'consent'::text AS kind FROM association_consent_events
      WHERE workspace_id=$1 AND contact_id=ANY($2::uuid[]) AND purpose=$3
      UNION ALL SELECT id,'suppression'::text AS kind FROM crm_suppression_events
      WHERE workspace_id=$1 AND contact_id=ANY($2::uuid[]) AND channel IN('all','email') ORDER BY kind,id`,[context.workspaceId,contactIds,purposeKey])
    for(const event of events.rows) {
      const evidence=await assertAssociationOrderAuthority(client,context.workspaceId,event.id,actor,event.kind)
      if(!evidence)throw denied()
      sources.push({...evidence.scope,resourceKind:event.kind,resourceId:event.id,version:event.id})
    }
    const scope=deriveResourceScope({producer:'crm.delivery',sources},current.scope)
    await assertAssociationSourceAuthority(client,context.workspaceId,actor,{scope,sources})
    return {scope,sources}
  })
}

export async function assertCrmDeliveryScope(client:PoolClient,workspaceId:string,deliveryId:string,actor:AssociationActor):Promise<Evidence|null> {
  const workspace=(await client.query('SELECT department_read_v2 FROM workspaces WHERE id=$1',[workspaceId])).rows[0]
  if(workspace?.department_read_v2===false)return null
  if(!workspace)throw denied()
  const row=(await client.query<{scope:ResourceScope|null;sources:ScopeSource[]|null;redacted:boolean}>(`SELECT scope_snapshot AS scope,scope_sources AS sources,
    redacted_at IS NOT NULL AS redacted FROM crm_delivery_receipts WHERE workspace_id=$1 AND delivery_id=$2`,[workspaceId,deliveryId])).rows[0]
  if(!row?.scope || !Array.isArray(row.sources) || (!row.redacted && !row.sources.length))throw denied()
  try {
    const floor=deriveResourceScope({producer:'crm.delivery-receipt',sources:[
      {...row.scope,resourceKind:'delivery',resourceId:deliveryId,version:'saved'},...row.sources]})
    await assertAssociationSourceAuthority(client,workspaceId,actor,{scope:floor,sources:row.sources})
    const live:ScopeSource[]=[]
    if(!row.redacted)for(const source of row.sources) {
      if(source.workspaceId!==workspaceId)throw denied()
      if(source.resourceKind==='entity') {
        const evidence=await loadAssociationOrderScope(client,workspaceId,[source.resourceId])
        await assertAssociationSourceAuthority(client,workspaceId,actor,evidence)
        live.push(...evidence.sources)
      } else if(source.resourceKind==='consent'||source.resourceKind==='suppression') {
        const evidence=await assertAssociationOrderAuthority(client,workspaceId,source.resourceId,actor,source.resourceKind)
        if(!evidence)throw denied()
        live.push(...evidence.sources,{...evidence.scope,resourceKind:source.resourceKind,resourceId:source.resourceId,version:source.version})
      } else throw denied()
    }
    return {scope:deriveResourceScope({producer:'crm.delivery-current',sources:[...live,{...floor,resourceKind:'delivery',resourceId:deliveryId,version:'saved'}]}),sources:[...row.sources,...live]}
  } catch(error) {
    if(error instanceof DerivedScopeError)throw denied()
    throw error
  }
}
