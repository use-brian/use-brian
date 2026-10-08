/** Shared managed-mailbox policy and final recipient admission. [COMP:crm/delivery-policy] */
import {acquireCrmPrivacyWriterAdmission} from './privacy-admission.js'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { CrmOperationsError, evaluateCrmSendability, type CrmOperationsCommand, type CrmOperationsContext, CrmIntegrationAuthoritySchema, CrmOperationsActorSchema, CrmNativeDeliveryAuthoritySchema, requireCrmIntegrationOperation, requireCrmIntegrationResources, type CrmIntegrationAuthority } from '@use-brian/core'
import { getPool, query } from '../db/client.js'
import { lockCrmIntegrationCredential } from '../db/crm-integration-store.js'
import { crmDeliveryHooks, crmMailboxAccountHash, type CrmMailAdmission } from './delivery-scope.js'
import { lockNativeDeliveryPrincipal, lockNativeDeliveryMailbox, withNativeDeliverySourceAuthority, type NativeDeliveryPrincipal } from './delivery-native-authority.js'
import { beginAssociationCreation, assertAssociationConsentAuthority } from '../association/source-scope.js'
import { readCrmAddressSuppressions } from './suppression-tombstones.js'

type MemberMailContext = { userId: string; workspaceId?: string; connectorInstanceId?: string; expectedAccountHash?: string }
export type CrmMailContext = MemberMailContext | {
  workspaceId: string; connectorInstanceId: string; integration: CrmIntegrationAuthority; expectedAccountHash?: string
} | {workspaceId:string;connectorInstanceId:string;native:NativeDeliveryPrincipal;expectedAccountHash?:string}
export type CrmMailIntent = { crmPurposeKey?: string; crmTemplateKey?: string }
type Provider = 'gmail' | 'imap' | 'agentmail'
// This is the closed set of mail transports wired below, not all built-ins.
function isMailTransport(provider: string): provider is Provider {
  switch (provider) {
    case 'gmail':
    case 'imap':
    case 'agentmail': return true
    default: return false
  }
}
type Envelope = CrmMailIntent & { to: string | string[]; cc?: string[]; bcc?: string[]; scheduled?: boolean;
  unsupportedManagedPath?: 'provider_draft' | 'implicit_reply' }
type Policy = { id: string; connectorInstanceId: string; providerKey: string; version: number; managed: boolean;
  purposeKeys: string[]; templatePurposes: Record<string,string>; createdAt: Date; updatedAt: Date }
const projection = `id,connector_instance_id AS "connectorInstanceId",provider_key AS "providerKey",version,managed,
  purpose_keys AS "purposeKeys",template_purposes AS "templatePurposes",created_at AS "createdAt",updated_at AS "updatedAt"`
const scopeSchema = z.union([
  z.object({workspaceId:z.string().uuid(),connectorInstanceId:z.string().uuid(),native:z.object({actor:CrmOperationsActorSchema,ceiling:CrmNativeDeliveryAuthoritySchema}).strict(),expectedAccountHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict(),
  z.object({ userId:z.string().uuid(),workspaceId:z.string().uuid().optional(),connectorInstanceId:z.string().uuid().optional(),expectedAccountHash:z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ workspaceId:z.string().uuid(),connectorInstanceId:z.string().uuid(),integration:CrmIntegrationAuthoritySchema,expectedAccountHash:z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
])
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const intentSchema = z.object({ crmPurposeKey: key,crmTemplateKey: key.optional() }).strict()
const denied = (reason: string, details: Record<string,unknown> = {}) => new CrmOperationsError('conflict','Managed email delivery requires review.',{ reason,...details })

async function member(client: PoolClient, scope: MemberMailContext, admin = false) {
  const workspaceId = scope.workspaceId ?? (await client.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE owner_user_id=$1 AND id=(SELECT default_workspace_id FROM users WHERE id=$1)`,[scope.userId])).rows[0]?.id
  if (!workspaceId) throw denied('delivery_workspace_unavailable')
  const row = (await client.query<{ role: string }>(`SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`,[workspaceId,scope.userId])).rows[0]
  if (!row || (admin && !['owner','admin'].includes(row.role))) throw new CrmOperationsError('not_authorized','Current workspace membership is required for this mailbox operation.')
  return workspaceId
}
async function connector(client: PoolClient, workspaceId: string, scope: CrmMailContext, provider?: Provider) {
  const userId = 'userId' in scope ? scope.userId : null
  const rows = await client.query<{ credentials: Buffer|null; connectedEmail: string|null; id: string; scope: string; userId: string | null; workspaceId: string | null; provider: Provider; connected: boolean; health: string }>(
    `SELECT credentials,connected_email AS "connectedEmail",id,scope,user_id AS "userId",workspace_id AS "workspaceId",provider,connected,health_status AS health FROM connector_instance
     WHERE ($1::uuid IS NOT NULL AND id=$1) OR ($1::uuid IS NULL AND scope='user' AND user_id=$2 AND provider=$3)
     ORDER BY created_at,id LIMIT 1 FOR SHARE`,[scope.connectorInstanceId ?? null,userId,provider ?? null])
  const row = rows.rows[0]
  if (!row || !isMailTransport(row.provider) || (provider && row.provider!==provider)
    || !row.connected || row.health==='auth_failed') throw denied('delivery_connector_unavailable')
  if (row.scope==='workspace' && row.workspaceId!==workspaceId) throw new CrmOperationsError('not_authorized','The mailbox is unavailable in this workspace.')
  if (!('native' in scope) && row.workspaceId!==workspaceId && row.userId!==userId) {
    const grant = await client.query(`SELECT id FROM connector_grant WHERE connector_instance_id=$1 AND target_type='workspace' AND target_id=$2 FOR SHARE`,[row.id,workspaceId])
    if (!grant.rowCount) throw new CrmOperationsError('not_authorized','The mailbox is unavailable in this workspace.')
  }
  const accountHash = crmMailboxAccountHash(row)
  if(scope.expectedAccountHash && scope.expectedAccountHash!==accountHash) throw denied('delivery_account_changed')
  return {...row,accountHash}
}
const lockKey = (workspaceId: string, instanceId: string) => `crm-mailbox:${workspaceId}:${instanceId}`

export async function saveCrmManagedMailboxPolicy(client: PoolClient, context: CrmOperationsContext,
  command: Extract<CrmOperationsCommand,{kind:'save_managed_mailbox_policy'}>) {
  if (context.actor.kind!=='user') throw new CrmOperationsError('not_authorized','A current owner or admin must approve mailbox management.')
  const scope = { userId: context.actor.userId,workspaceId: context.workspaceId,connectorInstanceId: command.connectorInstanceId }
  await member(client,scope,true)
  await connector(client,context.workspaceId,scope)
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey(context.workspaceId,command.connectorInstanceId)])
  const existing = (await client.query<Policy>(`SELECT ${projection} FROM crm_managed_mailbox_policies WHERE workspace_id=$1 AND connector_instance_id=$2 FOR UPDATE`,[context.workspaceId,command.connectorInstanceId])).rows[0]
  if ((existing?.version ?? 0)!==command.expectedVersion) throw denied('stale_mailbox_policy_version')
  if (existing && existing.providerKey!==command.providerKey) throw denied('mailbox_provider_key_immutable')
  const purposes = await client.query(`SELECT purpose_key FROM crm_consent_purposes WHERE workspace_id=$1 AND purpose_key=ANY($2::text[]) AND archived_at IS NULL ORDER BY purpose_key FOR SHARE`,[context.workspaceId,command.purposeKeys])
  if (purposes.rowCount!==command.purposeKeys.length) throw denied('mailbox_purpose_unavailable')
  const purposeKeys = [...command.purposeKeys].sort(), templatePurposes = Object.fromEntries(Object.entries(command.templatePurposes).sort(([a],[b])=>a.localeCompare(b)))
  if (existing && existing.managed===command.managed && JSON.stringify([...existing.purposeKeys].sort())===JSON.stringify(purposeKeys)
    && JSON.stringify(Object.fromEntries(Object.entries(existing.templatePurposes).sort(([a],[b])=>a.localeCompare(b))))===JSON.stringify(templatePurposes)) return { record: existing,changed: false }
  const values = [context.workspaceId,command.connectorInstanceId,command.providerKey,command.expectedVersion+1,command.managed,purposeKeys,JSON.stringify(templatePurposes),context.actor.userId]
  const saved = await client.query<Policy>(`INSERT INTO crm_managed_mailbox_policies(workspace_id,connector_instance_id,provider_key,version,managed,purpose_keys,template_purposes,approved_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(workspace_id,connector_instance_id) DO UPDATE SET
      version=EXCLUDED.version,managed=EXCLUDED.managed,purpose_keys=EXCLUDED.purpose_keys,template_purposes=EXCLUDED.template_purposes,
      approved_by_user_id=EXCLUDED.approved_by_user_id,updated_at=clock_timestamp() RETURNING ${projection}`,values)
  return { record: saved.rows[0]!,changed: true }
}

export async function readCrmManagedMailboxPolicy(workspaceId: string, instanceId: string) {
  return (await query<Policy>(`SELECT ${projection} FROM crm_managed_mailbox_policies WHERE workspace_id=$1 AND connector_instance_id=$2`,[workspaceId,instanceId])).rows[0] ?? null
}

function recipients(envelope: Envelope) {
  const raw = [...(Array.isArray(envelope.to) ? envelope.to : [envelope.to]),...(envelope.cc ?? []),...(envelope.bcc ?? [])]
  if (!raw.length || raw.length>1000) throw denied('delivery_recipient_count_invalid')
  return raw.map((address,index) => {
    if (typeof address!=='string' || /[\r\n]/.test(address) || !z.string().email().max(320).safeParse(address.trim()).success) throw denied('delivery_recipient_invalid',{ recipientIndex: index })
    return address.trim().toLowerCase()
  })
}

/** Invocation is inside the final admission transaction, after approvals. */
type AdmittedAction<T> = (admission: CrmMailAdmission, client: PoolClient) => Promise<T>
export function withCrmMailAdmission<T>(scope: CrmMailContext | undefined, provider: Provider | undefined, envelope: Envelope, invoke: AdmittedAction<T>): Promise<T> {
  return runCrmMailAdmission(scope,provider,envelope,invoke,true)
}
/** Commit a receipt claim under admission locks before any external operation. */
export function inspectCrmMailAdmission<T>(scope: CrmMailContext, envelope: Envelope, inspect: AdmittedAction<T>): Promise<T> {
  return runCrmMailAdmission(scope,undefined,envelope,inspect,false)
}
async function runCrmMailAdmission<T>(rawScope: CrmMailContext | undefined, provider: Provider | undefined, envelope: Envelope, invoke: AdmittedAction<T>, providerInvocation: boolean): Promise<T> {
  const scope = scopeSchema.safeParse(rawScope)
  if (!scope.success) throw denied('delivery_context_required')
  const client = await getPool().connect()
  let invoking = false, accepted = false
  try {
    await client.query('BEGIN')
    const candidateWorkspace=scope.data.workspaceId ?? ('userId' in scope.data ? (await client.query<{id:string}>('SELECT id FROM workspaces WHERE owner_user_id=$1 AND id=(SELECT default_workspace_id FROM users WHERE id=$1)',[scope.data.userId])).rows[0]?.id : undefined)
    if(!candidateWorkspace)throw denied('delivery_workspace_unavailable')
    await beginAssociationCreation(client,candidateWorkspace)
    const integration = 'integration' in scope.data ? scope.data.integration : undefined
    const current = integration ? await lockCrmIntegrationCredential(client,scope.data.workspaceId!,integration.credentialId) : undefined
    if(integration && current) for(const authority of [integration,current]) requireCrmIntegrationOperation(authority,'crm.delivery.dispatch')
    const workspaceId = 'userId' in scope.data ? await member(client,scope.data) : scope.data.workspaceId
    const native = 'native' in scope.data ? scope.data.native : undefined
    if(native) await lockNativeDeliveryPrincipal(client,workspaceId,native,true)
    await acquireCrmPrivacyWriterAdmission(client,workspaceId)
    if(native) await lockNativeDeliveryMailbox(client,workspaceId,native,scope.data.connectorInstanceId!)
    const instance = await connector(client,workspaceId,scope.data,provider)
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[lockKey(workspaceId,instance.id)])
    const policy = (await client.query<Policy>(`SELECT ${projection} FROM crm_managed_mailbox_policies WHERE workspace_id=$1 AND connector_instance_id=$2 FOR SHARE`,[workspaceId,instance.id])).rows[0]
    if(integration && current) {
      for(const authority of [integration,current]) requireCrmIntegrationResources(authority,'crm.delivery.dispatch',{
        purposeKeys:envelope.crmPurposeKey ?? null,providerKeys:policy?.providerKey ?? null,
      })
      const grant=await client.query(`SELECT id FROM crm_mailbox_integration_grants WHERE workspace_id=$1 AND credential_id=$2 AND connector_instance_id=$3 AND enabled FOR SHARE`,[workspaceId,integration.credentialId,instance.id])
      if(!grant.rowCount) throw new CrmOperationsError('not_authorized','The integration has no current send grant for this mailbox.')
    }
    const contactIds = new Set<string>()
    if (policy?.managed || envelope.crmPurposeKey || envelope.crmTemplateKey) {
      if (!policy?.managed) throw denied('mailbox_management_unconfigured')
      if (envelope.scheduled) throw denied('managed_provider_scheduling_unavailable')
      if (envelope.unsupportedManagedPath) throw denied('managed_recipient_snapshot_required', { path: envelope.unsupportedManagedPath })
      const intent = intentSchema.safeParse({ crmPurposeKey: envelope.crmPurposeKey,...(envelope.crmTemplateKey ? { crmTemplateKey: envelope.crmTemplateKey } : {}) })
      if (!intent.success) throw denied('delivery_purpose_required',{ purposeKeys: policy.purposeKeys })
      const { crmPurposeKey,crmTemplateKey } = intent.data
      if (!policy.purposeKeys.includes(crmPurposeKey)) throw denied('delivery_purpose_not_allowed', { purposeKeys: policy.purposeKeys })
      if (crmTemplateKey && policy.templatePurposes[crmTemplateKey]!==crmPurposeKey) throw denied('delivery_template_purpose_mismatch', {
        templateKeys: Object.entries(policy.templatePurposes).filter(([,purpose]) => purpose===crmPurposeKey).map(([template]) => template),
      })
      const addresses = recipients(envelope)
      const purpose = (await client.query<{ archived: boolean; requiresConsent: boolean; applicableChannels: ('email')[] }>(`SELECT archived_at IS NOT NULL AS archived,requires_consent AS "requiresConsent",applicable_channels AS "applicableChannels"
        FROM crm_consent_purposes WHERE workspace_id=$1 AND purpose_key=$2 FOR SHARE`,[workspaceId,crmPurposeKey])).rows[0]
      if (!purpose) throw denied('delivery_purpose_unavailable')
      const people = (await client.query<{ id: string; email: string }>(`SELECT id,lower(btrim(COALESCE(NULLIF(attributes->>'email',''),canonical_id))) AS email
        FROM entities WHERE workspace_id=$1 AND kind='person' AND valid_to IS NULL AND retracted_at IS NULL
          AND lower(btrim(COALESCE(NULLIF(attributes->>'email',''),canonical_id)))=ANY($2::text[]) ORDER BY id FOR SHARE`,[workspaceId,addresses])).rows
      for (const [index,address] of addresses.entries()) {
        const matches = people.filter((person)=>person.email===address)
        // Check retained evidence even without a person, so erasure remains a
        // known restriction rather than becoming an ordinary unknown identity.
        const retained = await readCrmAddressSuppressions(client,workspaceId,'email',address,crmPurposeKey)
        if (retained.length) throw denied('delivery_recipient_blocked',{ recipientIndex: index,reasonCodes: ['address_suppression'] })
        if (matches.length!==1) throw denied(matches.length ? 'delivery_identity_ambiguous' : 'delivery_identity_unresolved',{ recipientIndex: index })
        const contactId = matches[0]!.id
        contactIds.add(contactId)
        // Public unsubscribe takes the matching exclusive lock. Whichever
        // operation wins decides whether this handoff is admitted; a scanner
        // GET takes no lock because it never mutates consent.
        await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[
          `crm-consent:${workspaceId}:${contactId}:${crmPurposeKey}`,
        ])
        const admitEvidence=()=>native ? withNativeDeliverySourceAuthority(client,workspaceId,native,actor=>
          assertAssociationConsentAuthority(client,workspaceId,contactId,actor,{purposeKeys:[crmPurposeKey],channel:'email'}))
          : assertAssociationConsentAuthority(client,workspaceId,contactId,
            integration ? {credentialKind:'integration_key',credentialId:integration.credentialId,integration}
              : {credentialKind:'user',credentialId:('userId' in scope.data?scope.data.userId:''),actingUserId:('userId' in scope.data?scope.data.userId:'')},
            {purposeKeys:[crmPurposeKey],channel:'email'})
        const evidenceScope=await admitEvidence()
        const stamp = `to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`
        const consent = await client.query<{ id: string; action:'granted'|'withdrawn'; occurredAt:string; createdAt:string }>(`SELECT id,action,${stamp} FROM association_consent_events
          WHERE workspace_id=$1 AND contact_id=$2 AND purpose=$3 ORDER BY occurred_at DESC,created_at DESC,id DESC LIMIT 1`,[workspaceId,contactId,crmPurposeKey])
        const suppression = await client.query<{ id:string; channel:'all'|'email'; action:'suppressed'|'released'; occurredAt:string; createdAt:string }>(`SELECT DISTINCT ON(channel) id,channel,action,${stamp} FROM crm_suppression_events
          WHERE workspace_id=$1 AND contact_id=$2 AND channel IN('all','email') ORDER BY channel,occurred_at DESC,created_at DESC,id DESC`,[workspaceId,contactId])
        const verdict = evaluateCrmSendability({ channel:'email',hasContactMethod:true,purpose,consentEvents:consent.rows,suppressionEvents:suppression.rows })
        if(evidenceScope!==await admitEvidence())throw new CrmOperationsError('not_authorized','Recipient evidence access changed.')
        if (verdict.verdict!=='allowed') throw denied('delivery_recipient_not_allowed',{ recipientIndex:index,verdict:verdict.verdict,reasonCodes:verdict.reasons })
      }
    }
    const admission:CrmMailAdmission = {workspaceId,connectorInstanceId:instance.id,provider:instance.provider,
      providerKey:policy?.providerKey ?? null,contactIds:[...contactIds],accountHash:instance.accountHash}
    const hooks=providerInvocation ? crmDeliveryHooks(rawScope) : undefined
    await hooks?.beforeInvoke(client,admission)
    if (integration) {
      const active = await client.query(`SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS active
        FROM crm_integration_credentials WHERE workspace_id=$1 AND id=$2`,[workspaceId,integration.credentialId])
      if(!active.rows[0]?.active) throw new CrmOperationsError('credential_revoked','The CRM integration credential is no longer active.')
    }
    if(native) await lockNativeDeliveryPrincipal(client,workspaceId,native,true)
    invoking = providerInvocation
    const result = await invoke(admission,client)
    accepted = providerInvocation
    await hooks?.afterInvoke(client,admission,result)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{})
    if (invoking) {
      const status = error && typeof error==='object' && 'status' in error && typeof error.status==='number' ? error.status : undefined
      const rejected = !accepted && status!==undefined && status>=400 && status<500 && ![408,429].includes(status)
      const fixed = denied(rejected ? 'provider_rejected' : 'provider_outcome_unknown',status ? { status } : {})
      if (status) Object.assign(fixed,{ status })
      throw fixed
    }
    throw error
  }
  finally { client.release() }
}

export async function saveCrmMailboxIntegrationGrant(client:PoolClient,context:CrmOperationsContext,
  command:Extract<CrmOperationsCommand,{kind:'save_mailbox_integration_grant'}>) {
  if(context.actor.kind!=='user') throw new CrmOperationsError('not_authorized','A current owner or admin must approve mailbox integration access.')
  const scope={userId:context.actor.userId,workspaceId:context.workspaceId,connectorInstanceId:command.connectorInstanceId}
  await member(client,scope,true)
  if(command.enabled) {
    await lockCrmIntegrationCredential(client,context.workspaceId,command.credentialId)
    await connector(client,context.workspaceId,scope)
  } else {
    // Revocation remains possible after a credential expires or a mailbox disconnects.
    const credential=await client.query('SELECT id FROM crm_integration_credentials WHERE workspace_id=$1 AND id=$2 FOR SHARE',[context.workspaceId,command.credentialId])
    if(!credential.rowCount) throw new CrmOperationsError('not_found','The integration credential is unavailable.')
  }
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[lockKey(context.workspaceId,command.connectorInstanceId)])
  if(command.enabled) {
    const managed=await client.query('SELECT id FROM crm_managed_mailbox_policies WHERE workspace_id=$1 AND connector_instance_id=$2 AND managed FOR SHARE',[context.workspaceId,command.connectorInstanceId])
    if(!managed.rowCount) throw denied('mailbox_management_unconfigured')
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`crm-mailbox-grant:${context.workspaceId}:${command.credentialId}:${command.connectorInstanceId}`])
  const cols=`id,credential_id AS "credentialId",connector_instance_id AS "connectorInstanceId",version,enabled`
  const existing=(await client.query(`SELECT ${cols} FROM crm_mailbox_integration_grants WHERE workspace_id=$1 AND credential_id=$2 AND connector_instance_id=$3 FOR UPDATE`,[context.workspaceId,command.credentialId,command.connectorInstanceId])).rows[0]
  if(!command.enabled && !existing) throw new CrmOperationsError('not_found','The mailbox integration grant is unavailable.')
  if((existing?.version ?? 0)!==command.expectedVersion) throw denied('stale_mailbox_grant_version')
  if(existing && existing.enabled===command.enabled) return {record:existing,changed:false}
  const record=(await client.query(`INSERT INTO crm_mailbox_integration_grants(workspace_id,credential_id,connector_instance_id,version,enabled,approved_by_user_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,credential_id,connector_instance_id) DO UPDATE SET
      version=EXCLUDED.version,enabled=EXCLUDED.enabled,approved_by_user_id=EXCLUDED.approved_by_user_id,updated_at=clock_timestamp()
    RETURNING ${cols}`,[context.workspaceId,command.credentialId,command.connectorInstanceId,command.expectedVersion+1,command.enabled,context.actor.userId])).rows[0]
  return {record,changed:true}
}

export async function readCrmMailboxIntegrationGrant(workspaceId:string,instanceId:string,credentialId:string) {
  return (await query(`SELECT id,credential_id AS "credentialId",connector_instance_id AS "connectorInstanceId",version,enabled
    FROM crm_mailbox_integration_grants WHERE workspace_id=$1 AND connector_instance_id=$2 AND credential_id=$3`,[workspaceId,instanceId,credentialId])).rows[0] ?? null
}
