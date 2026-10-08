import { assertCrmDeliveryScope, captureCrmDeliveryScope, withCrmDeliverySourceActor } from './delivery-source-authority.js'
/** Durable single-attempt CRM sends. [COMP:crm/delivery-receipts] */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  CrmOperationsUuidSchema, CrmOperationsContextSchema, SendCrmMessageCommandSchema, CrmOperationsError,
  actorAuditIdentity, crmOperationsSha256, requireCrmIntegrationOperation, requireCrmIntegrationResources,
  type CrmOperationsContext, type CrmDeliveryReceipt, type CrmDeliveryServicePort, type SendCrmMessageCommand,
} from '@use-brian/core'
import { lockNativeDeliveryPrincipal } from './delivery-native-authority.js'
import { getPool } from '../db/client.js'
import { lockCrmIntegrationCredential } from '../db/crm-integration-store.js'
import { inspectCrmMailAdmission, type CrmMailContext } from './delivery-policy.js'
import { bindCrmDeliveryHooks, type CrmMailAdmission } from './delivery-scope.js'

const projection=`delivery_id AS "deliveryId",connector_instance_id AS "connectorInstanceId",provider_key AS "providerKey",purpose_key AS "purposeKey",
  status,error_code AS "errorCode",provider_receipt AS "providerReceipt",accepted_at AS "acceptedAt",confirmed_at AS "confirmedAt",
  redacted_at AS "redactedAt",created_at AS "createdAt",updated_at AS "updatedAt"`
type Row=Omit<CrmDeliveryReceipt,'acceptedAt'|'confirmedAt'|'redactedAt'|'createdAt'|'updatedAt'> & {
  acceptedAt:Date|null;confirmedAt:Date|null;redactedAt:Date|null;createdAt:Date;updatedAt:Date;
  requestHash?:string;actorKind?:string;actorCredentialId?:string
}
const project=(row:Row):CrmDeliveryReceipt=>({
  deliveryId:row.deliveryId,connectorInstanceId:row.connectorInstanceId,providerKey:row.providerKey,purposeKey:row.purposeKey,
  status:row.status,errorCode:row.errorCode,providerReceipt:row.providerReceipt,
  acceptedAt:row.acceptedAt?.toISOString() ?? null,confirmedAt:row.confirmedAt?.toISOString() ?? null,
  redactedAt:row.redactedAt?.toISOString() ?? null,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),
})
export type PreparedCrmDelivery = {
  send(scope:CrmMailContext):Promise<unknown>
  receipt(result:unknown):Record<string,unknown>
}
export type PrepareCrmDelivery=(admission:CrmMailAdmission,command:SendCrmMessageCommand)=>Promise<PreparedCrmDelivery>
const unavailable=(reason:string)=>new CrmOperationsError('conflict','CRM delivery requires review.',{reason})

function mailScope(context:CrmOperationsContext,connectorInstanceId:string):CrmMailContext {
  if(context.actor.kind==='user') return {userId:context.actor.userId,workspaceId:context.workspaceId,connectorInstanceId}
  if(context.actor.kind==='integration_key' && context.authority.integration?.credentialId===context.actor.credentialId) {
    return {workspaceId:context.workspaceId,connectorInstanceId,integration:context.authority.integration}
  }
  if(context.authority.nativeDelivery) return {workspaceId:context.workspaceId,connectorInstanceId,native:{actor:context.actor,ceiling:context.authority.nativeDelivery}}
  throw new CrmOperationsError('not_authorized','CRM delivery requires authenticated sending authority.')
}
async function transaction<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await getPool().connect()
  try {await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
  finally{client.release()}
}
async function authorize(client:PoolClient,context:CrmOperationsContext,operation:'crm.delivery.read'|'crm.delivery.dispatch',row?:Row) {
  if(context.actor.kind==='integration_key') {
    const original=context.authority.integration
    if(!original || original.credentialId!==context.actor.credentialId) throw new CrmOperationsError('not_authorized','Authenticated integration authority is required.')
    const current=await lockCrmIntegrationCredential(client,context.workspaceId,context.actor.credentialId)
    for(const authority of [original,current]) {
      requireCrmIntegrationOperation(authority,operation)
      if(row) requireCrmIntegrationResources(authority,operation,{purposeKeys:row.purposeKey,providerKeys:row.providerKey})
    }
  } else if(context.actor.kind==='user') {
    const member=await client.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[context.workspaceId,context.actor.userId])
    if(!member.rowCount) throw new CrmOperationsError('not_authorized','Current workspace membership is required for CRM delivery.')
  } else if(context.authority.nativeDelivery) {
    await lockNativeDeliveryPrincipal(client,context.workspaceId,{actor:context.actor,ceiling:context.authority.nativeDelivery},operation==='crm.delivery.dispatch')
  } else throw new CrmOperationsError('not_authorized','This principal has no CRM delivery authority.')
  if(operation==='crm.delivery.dispatch' && !context.authority.canWrite) throw new CrmOperationsError('not_authorized','CRM delivery write authority is required.')
  if(row)await withCrmDeliverySourceActor(client,context,actor=>assertCrmDeliveryScope(client,context.workspaceId,row.deliveryId,actor))
}
async function readRow(client:PoolClient,workspaceId:string,deliveryId:string) {
  return (await client.query<Row>(`SELECT ${projection},request_hash AS "requestHash",actor_kind AS "actorKind",actor_credential_id AS "actorCredentialId"
    FROM crm_delivery_receipts WHERE workspace_id=$1 AND delivery_id=$2`,[workspaceId,deliveryId])).rows[0] ?? null
}
async function expireClaim(client:PoolClient,workspaceId:string,deliveryId:string) {
  // A live invocation holds the receipt row. Never wait on or steal its claim.
  await client.query(`WITH abandoned AS (SELECT workspace_id,delivery_id FROM crm_delivery_receipts
    WHERE workspace_id=$1 AND delivery_id=$2 AND status='dispatching' AND claim_deadline<=clock_timestamp() FOR UPDATE SKIP LOCKED)
    UPDATE crm_delivery_receipts r SET status='needs_reconciliation',error_code='delivery_claim_expired',updated_at=clock_timestamp()
    FROM abandoned a WHERE r.workspace_id=a.workspace_id AND r.delivery_id=a.delivery_id`,[workspaceId,deliveryId])
}
function sameRequest(row:Row,context:CrmOperationsContext,hash:string) {
  const actor=actorAuditIdentity(context.actor)
  if(row.requestHash!==hash || row.actorKind!==actor.actorKind || row.actorCredentialId!==actor.actorCredentialId) {
    throw new CrmOperationsError('idempotency_conflict','This delivery identity was already used for a different request or actor.')
  }
}
async function contacts(client:PoolClient,workspaceId:string,deliveryId:string,ids:string[]) {
  await client.query('DELETE FROM crm_delivery_receipt_contacts WHERE workspace_id=$1 AND delivery_id=$2',[workspaceId,deliveryId])
  for(const id of ids) await client.query(`INSERT INTO crm_delivery_receipt_contacts(workspace_id,delivery_id,contact_id) VALUES($1,$2,$3)`,[workspaceId,deliveryId,id])
}

export function createCrmDeliveryService(prepare:PrepareCrmDelivery):CrmDeliveryServicePort {
  return {
    async get(rawContext,deliveryId) {
      const context=CrmOperationsContextSchema.parse(rawContext)
      deliveryId=CrmOperationsUuidSchema.parse(deliveryId)
      return transaction(async client=>{
        await authorize(client,context,'crm.delivery.read')
        let row=await readRow(client,context.workspaceId,deliveryId)
        if(!row)return null
        await authorize(client,context,'crm.delivery.read',row)
        await expireClaim(client,context.workspaceId,deliveryId)
        row=(await readRow(client,context.workspaceId,deliveryId))!
        return project(row)
      })
    },
    async send(rawContext,rawCommand) {
      const context=CrmOperationsContextSchema.parse(rawContext), command=SendCrmMessageCommandSchema.parse(rawCommand)
      for(const attachment of command.attachments) Object.freeze(attachment)
      for(const list of [command.to,command.cc,command.bcc,command.attachments]) Object.freeze(list)
      Object.freeze(command)
      const scope=mailScope(context,command.connectorInstanceId), hash=crmOperationsSha256(command), actor=actorAuditIdentity(context.actor)
      const replay=await transaction(async client=>{
        await authorize(client,context,'crm.delivery.dispatch')
        const row=await readRow(client,context.workspaceId,command.deliveryId)
        if(!row)return null
        await authorize(client,context,'crm.delivery.dispatch',row)
        sameRequest(row,context,hash)
        await expireClaim(client,context.workspaceId,command.deliveryId)
        return project((await readRow(client,context.workspaceId,command.deliveryId))!)
      })
      if(replay)return {receipt:replay,duplicate:true}
      const claimToken=randomUUID()
      const claimed=await inspectCrmMailAdmission(scope,{
        to:command.to,cc:command.cc,bcc:command.bcc,crmPurposeKey:command.purposeKey,crmTemplateKey:command.templateKey,
      },async(admission,client)=>{
        const evidence=await captureCrmDeliveryScope(client,context,admission.contactIds,command.purposeKey)
        const inserted=await client.query<Row>(`INSERT INTO crm_delivery_receipts(workspace_id,delivery_id,request_hash,connector_instance_id,provider_key,purpose_key,
          actor_kind,actor_credential_id,acting_user_id,envelope,status,claim_token,claim_deadline,scope_snapshot,scope_sources)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'dispatching',$11,clock_timestamp()+interval '5 minutes',$12::jsonb,$13::jsonb)
          ON CONFLICT(workspace_id,delivery_id) DO NOTHING RETURNING ${projection}`,
          [context.workspaceId,command.deliveryId,hash,command.connectorInstanceId,admission.providerKey,command.purposeKey,
            actor.actorKind,actor.actorCredentialId,actor.actingUserId,JSON.stringify(command),claimToken,evidence?JSON.stringify(evidence.scope):null,evidence?JSON.stringify(evidence.sources):null])
        if(!inserted.rowCount) {
          const row=(await readRow(client,context.workspaceId,command.deliveryId))!
          await authorize(client,context,'crm.delivery.dispatch',row)
          sameRequest(row,context,hash)
          return {receipt:project(row),admission,duplicate:true}
        }
        await contacts(client,context.workspaceId,command.deliveryId,admission.contactIds)
        return {receipt:project(inserted.rows[0]!),admission,duplicate:false}
      })
      if(claimed.duplicate)return {receipt:claimed.receipt,duplicate:true}
      let invoking=false
      try {
        const prepared=await prepare(claimed.admission,command)
        const dispatchScope:CrmMailContext={...scope,...(claimed.admission.accountHash ? {expectedAccountHash:claimed.admission.accountHash} : {})}
        bindCrmDeliveryHooks(dispatchScope,{
          async beforeInvoke(client,admission) {
            const row=await client.query(`SELECT delivery_id FROM crm_delivery_receipts WHERE workspace_id=$1 AND delivery_id=$2
              AND request_hash=$3 AND claim_token=$4 AND status='dispatching' AND envelope IS NOT NULL AND redacted_at IS NULL
              AND claim_deadline>clock_timestamp() FOR UPDATE`,[context.workspaceId,command.deliveryId,hash,claimToken])
            if(!row.rowCount)throw unavailable('delivery_claim_unavailable')
            await authorize(client,context,'crm.delivery.dispatch',(await readRow(client,context.workspaceId,command.deliveryId))!)
            await contacts(client,context.workspaceId,command.deliveryId,admission.contactIds)
          },
          async afterInvoke(client,admission,result) {
            const providerReceipt=prepared.receipt(result)
            const saved=await client.query(`UPDATE crm_delivery_receipts SET status='sent',accepted_at=clock_timestamp(),provider_receipt=$5::jsonb,
              error_code=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND delivery_id=$2 AND request_hash=$3 AND claim_token=$4 AND status='dispatching'
              RETURNING delivery_id`,[context.workspaceId,command.deliveryId,hash,claimToken,JSON.stringify(providerReceipt)])
            if(!saved.rowCount)throw unavailable('delivery_receipt_unavailable')
            for(const id of admission.contactIds) await client.query(`INSERT INTO association_audit_log(workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,acting_user_id,metadata)
              VALUES($1,'crm.delivery.accepted','contact',$2,$3,$4,$5,$6::jsonb)`,[context.workspaceId,id,actor.actorKind,actor.actorCredentialId,actor.actingUserId,
                JSON.stringify({deliveryId:command.deliveryId,purposeKey:command.purposeKey,providerKey:admission.providerKey,status:'provider_accepted'})])
          },
        })
        invoking=true
        await prepared.send(dispatchScope)
        const row=await transaction(async client=>{
          const saved=await readRow(client,context.workspaceId,command.deliveryId)
          if(saved)await authorize(client,context,'crm.delivery.dispatch',saved)
          return saved
        })
        if(row?.status!=='sent')throw unavailable('delivery_transport_receipt_missing')
        return {receipt:project(row),duplicate:false}
      } catch(error) {
        const reason=error instanceof CrmOperationsError ? String(error.details?.reason ?? error.code) : undefined
        const uncertain=invoking && (!reason || reason==='provider_outcome_unknown' || reason==='delivery_transport_receipt_missing')
        const status=uncertain?'needs_reconciliation':reason==='provider_rejected'||!invoking?'failed':'blocked'
        const errorCode=uncertain?'provider_outcome_unknown':reason ?? 'delivery_transport_unavailable'
        const row=await transaction(async client=>{
          await client.query(`UPDATE crm_delivery_receipts SET status=$5,error_code=$6,updated_at=clock_timestamp()
            WHERE workspace_id=$1 AND delivery_id=$2 AND claim_token=$3 AND request_hash=$4 AND status='dispatching'`,
            [context.workspaceId,command.deliveryId,claimToken,hash,status,errorCode])
          return readRow(client,context.workspaceId,command.deliveryId)
        }).catch(()=>null)
        if(!row)throw unavailable('delivery_outcome_unavailable')
        await transaction(client=>authorize(client,context,'crm.delivery.dispatch',row))
        return {receipt:project(row),duplicate:false}
      }
    },
  }
}
