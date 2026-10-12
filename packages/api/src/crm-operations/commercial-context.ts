/**
 * Canonical commercial context commands: seller profiles, customer accounts,
 * accepted commercial profile versions and bounded operation versions.
 * Called only from `CrmOperationsService.execute` inside its transaction.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Commercial context
 *
 * [COMP:crm/commercial-context]
 */

import {
  crmOperationsSha256,
  maxSensitivity,
  requireCrmIntegrationResources,
  unionScopeRequirements,
  type CrmCommercialContextCommand,
  type CrmOperationsContext,
  type EntityRecord,
  type Sensitivity,
} from '@use-brian/core'
import type { CrmOperationsTransaction } from '../db/crm-operations-store.js'
import { readCrmReference } from '../db/crm.js'
import {
  acceptOperationVersion,
  acceptProfile,
  bumpOperationDefinition,
  insertAccount,
  insertOperationDefinition,
  insertOperationVersion,
  insertSeller,
  lockAccount,
  lockCurrentProfile,
  lockOperationDefinition,
  lockSellerById,
  lockSellerByKey,
  profileOwnerKey,
  readAccountById,
  readOperationVersion,
  readSellerById,
  sellerKeyTaken,
  updateAccount,
  updateSeller,
  type CrmScopeEnvelope,
} from '../db/crm-commercial-context-store.js'
import { actorColumns, commercialAudit, commercialResult, refuse, unavailable, withOperationReceipt, type CommercialResult } from './commercial-transaction.js'

type Command<K extends CrmCommercialContextCommand['kind']> = Extract<CrmCommercialContextCommand, { kind: K }>
const RANK: Record<Sensitivity, number> = { public: 0, internal: 1, confidential: 2 }

function grant(context: CrmOperationsContext, operation: 'crm.commercial.write' | 'crm.commercial.configure', resources: { sellerKeys?: string; operationKeys?: string }) {
  if (context.authority.integration) requireCrmIntegrationResources(context.authority.integration, operation, resources)
}

type ParentRecord = CrmScopeEnvelope & { id: string; companyId: string | null }

/** Read a parent record in the actor's current scope; a hidden parent is indistinguishable from a missing one. */
async function readParent(tx: CrmOperationsTransaction, id: string, kind: 'company' | 'person' | 'deal'): Promise<ParentRecord> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  const record: EntityRecord | null = await readCrmReference(access.userId, context.workspaceId, id, kind === 'deal' ? ['deal'] : kind, access, client).catch(() => null)
  if (!record) unavailable()
  return { id: record.id, sensitivity: record.sensitivity, compartments: record.compartments ?? [], projectIds: record.projectIds ?? [],
    companyId: typeof record.attributes.company_id === 'string' ? record.attributes.company_id : null }
}

/**
 * The child is at least as restricted as every source it is built from and
 * may be stricter. A department choice is admitted only for a member actor in
 * that active department.
 */
async function envelope(tx: CrmOperationsTransaction, parents: Array<Pick<CrmScopeEnvelope, 'sensitivity' | 'compartments' | 'projectIds'>>,
  classification: { sensitivity?: Sensitivity; departmentId?: string | null } | undefined, current?: CrmScopeEnvelope): Promise<CrmScopeEnvelope> {
  const { client, context } = tx.commercial()
  let sensitivity: Sensitivity = current?.sensitivity ?? 'internal'
  let compartments = current?.compartments ?? []
  let projectIds = current?.projectIds ?? []
  for (const parent of parents) {
    sensitivity = maxSensitivity(sensitivity, parent.sensitivity)
    compartments = unionScopeRequirements(compartments, parent.compartments) ?? []
    projectIds = unionScopeRequirements(projectIds, parent.projectIds) ?? []
  }
  if (classification?.sensitivity) {
    if (RANK[classification.sensitivity] < RANK[sensitivity]) {
      refuse('invalid_input', 'A commercial record cannot be classified more broadly than its sources.', { reason: 'classification_broader_than_source', minimum: sensitivity })
    }
    sensitivity = classification.sensitivity
  }
  if (classification?.departmentId) {
    if (context.actor.kind !== 'user') refuse('not_authorized', 'A department destination is chosen by a member in CRM.')
    const department = await client.query(`SELECT 1 FROM workspace_groups g
      WHERE g.workspace_id=$1 AND g.id=$2 AND g.status='active' AND g.compartment_key IS NOT NULL
        AND (EXISTS(SELECT 1 FROM department_edges d WHERE d.workspace_id=g.workspace_id AND d.department_id=g.id AND d.user_id=$3
               AND (d.expires_at IS NULL OR d.expires_at>clock_timestamp()))
          OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=g.workspace_id AND m.user_id=$3 AND m.role IN('owner','admin')))`,
    [context.workspaceId, classification.departmentId, context.actor.userId])
    if (!department.rowCount) unavailable()
    compartments = unionScopeRequirements(compartments, [`team:${classification.departmentId}`]) ?? []
  }
  return { sensitivity, compartments: [...new Set(compartments)].sort(), projectIds: [...new Set(projectIds)].sort() }
}

async function saveSeller(tx: CrmOperationsTransaction, command: Command<'save_seller_profile'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  grant(context, 'crm.commercial.configure', { sellerKeys: command.seller.sellerKey })
  const access = await tx.commercial().actorAccess()
  const company = command.seller.companyId ? await readParent(tx, command.seller.companyId, 'company') : null
  const actor = actorColumns(context)
  if (!command.sellerId) {
    if (await sellerKeyTaken(client, context.workspaceId, command.seller.sellerKey)) {
      refuse('conflict', 'A seller with this key already exists. Update it with its id and version.', { reason: 'seller_key_taken' })
    }
    const scope = await envelope(tx, company ? [company] : [], command.classification)
    const id = await insertSeller(client, context.workspaceId, command.seller, scope, actor)
    await commercialAudit(tx, context, { action: 'crm.seller_profile.created', subjectKind: 'seller_profile', subjectId: id, details: { sellerKey: command.seller.sellerKey } })
    return commercialResult(command.kind, { seller: await readSellerById(client, context.workspaceId, id) }, { created: true })
  }
  const current = await lockSellerById(client, context.workspaceId, command.sellerId, access)
  if (!current) unavailable()
  if (current.version !== command.expectedVersion) refuse('conflict', 'The seller changed. Reread it first.', { reason: 'stale_version', currentVersion: current.version })
  if (current.sellerKey !== command.seller.sellerKey) refuse('invalid_input', 'A seller key is stable and cannot be renamed.')
  const scope = await envelope(tx, company ? [company] : [], command.classification, current)
  await updateSeller(client, context.workspaceId, current.id, command.seller, scope, actor)
  await commercialAudit(tx, context, { action: 'crm.seller_profile.updated', subjectKind: 'seller_profile', subjectId: current.id, details: { sellerKey: current.sellerKey } })
  return commercialResult(command.kind, { seller: await readSellerById(client, context.workspaceId, current.id) })
}

async function saveAccount(tx: CrmOperationsTransaction, command: Command<'save_customer_account'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  grant(context, 'crm.commercial.write', { sellerKeys: command.account.sellerKey })
  const access = await tx.commercial().actorAccess()
  const actor = actorColumns(context)
  const contact = command.account.billingContactId ? await readParent(tx, command.account.billingContactId, 'person') : null
  if (!command.accountId) {
    const seller = await lockSellerByKey(client, context.workspaceId, command.account.sellerKey, access)
    if (!seller || seller.status !== 'active') unavailable()
    const company = await readParent(tx, command.account.companyId, 'company')
    const scope = await envelope(tx, [seller, company, ...(contact ? [contact] : [])], command.classification)
    const id = await insertAccount(client, context.workspaceId, { ...command.account, sellerId: seller.id }, scope, actor)
    await commercialAudit(tx, context, { action: 'crm.customer_account.created', subjectKind: 'customer_account', subjectId: id, details: { sellerKey: seller.sellerKey } })
    return commercialResult(command.kind, { account: await readAccountById(client, context.workspaceId, id) }, { created: true })
  }
  const current = await lockAccount(client, context.workspaceId, command.accountId, access)
  if (!current) unavailable()
  if (current.version !== command.expectedVersion) refuse('conflict', 'The account changed. Reread it first.', { reason: 'stale_version', currentVersion: current.version })
  if (current.companyId !== command.account.companyId || current.sellerKey !== command.account.sellerKey) {
    refuse('invalid_input', 'An account stays bound to its company and seller. Create a separate account for a different relationship.', { reason: 'account_binding_immutable' })
  }
  const scope = await envelope(tx, contact ? [contact] : [], command.classification, current)
  await updateAccount(client, context.workspaceId, current.id, command.account, scope, actor)
  await commercialAudit(tx, context, { action: 'crm.customer_account.updated', subjectKind: 'customer_account', subjectId: current.id, details: { version: current.version + 1 } })
  return commercialResult(command.kind, { account: await readAccountById(client, context.workspaceId, current.id) })
}

async function acceptCommercialProfile(tx: CrmOperationsTransaction, command: Command<'accept_commercial_profile'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  const access = await tx.commercial().actorAccess()
  let ownerKey: string, sellerId: string | null = null, accountId: string | null = null, agreementKey: string | null = null
  let parents: CrmScopeEnvelope[] = []
  const dealIds: string[] = []
  if (command.owner.kind === 'seller') {
    grant(context, 'crm.commercial.configure', { sellerKeys: command.owner.sellerKey })
    const seller = await lockSellerByKey(client, context.workspaceId, command.owner.sellerKey, access, 'update')
    if (!seller) unavailable()
    sellerId = seller.id; ownerKey = profileOwnerKey({ kind: 'seller', sellerId: seller.id }); parents = [seller]
  } else {
    const account = await lockAccount(client, context.workspaceId, command.owner.accountId, access)
    if (!account) unavailable()
    grant(context, 'crm.commercial.configure', { sellerKeys: account.sellerKey })
    accountId = account.id; parents = [account]
    if (command.owner.kind === 'agreement') {
      agreementKey = command.owner.agreementKey
      for (const dealId of [...new Set(command.owner.dealIds)].sort()) {
        const deal = await readParent(tx, dealId, 'deal')
        if (deal.companyId !== account.companyId) refuse('invalid_input', 'An agreement can only cover deals of the account company.', { reason: 'deal_outside_account' })
        parents.push(deal)
        dealIds.push(dealId)
      }
      ownerKey = profileOwnerKey({ kind: 'agreement', accountId: account.id, agreementKey })
    } else {
      ownerKey = profileOwnerKey({ kind: 'account', accountId: account.id })
    }
  }
  const current = await lockCurrentProfile(client, context.workspaceId, ownerKey)
  const currentVersion = current?.version ?? 0
  if (currentVersion !== command.expectedCurrentVersion) {
    refuse('conflict', 'The accepted profile changed. Reread it and apply your change to the current version.', { reason: 'stale_version', currentVersion })
  }
  const scope = await envelope(tx, parents, command.classification, current ?? undefined)
  const saved = await acceptProfile(client, context.workspaceId, {
    ownerKind: command.owner.kind, sellerId, accountId, agreementKey, ownerKey, dealIds, version: currentVersion + 1,
    fields: command.fields, effectiveFrom: command.effectiveFrom, effectiveTo: command.effectiveTo, evidence: command.evidence,
    envelope: scope, operationId: command.operationId, actor: actorColumns(context), previousId: current?.id ?? null,
  })
  await commercialAudit(tx, context, { action: 'crm.commercial_profile.accepted', subjectKind: 'commercial_profile', subjectId: saved.id,
    details: { ownerKind: saved.ownerKind, version: saved.version } })
  return commercialResult(command.kind, { profile: saved }, { created: true })
}

async function saveOperationDefinition(tx: CrmOperationsTransaction, command: Command<'save_operation_definition'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  grant(context, 'crm.commercial.configure', { operationKeys: command.operationKey })
  const actor = actorColumns(context)
  if (command.version.referenceDefinitionKey) {
    const reference = await client.query('SELECT 1 FROM crm_reference_definitions WHERE workspace_id=$1 AND definition_key=$2', [context.workspaceId, command.version.referenceDefinitionKey])
    if (!reference.rowCount) refuse('catalog_key_invalid', 'The reference definition is not configured.', { definitionKey: command.version.referenceDefinitionKey })
  }
  if (command.version.templateBinding) {
    const template = await client.query(`SELECT 1 FROM office_templates WHERE workspace_id=$1 AND id=$2 AND family='spreadsheet'`, [context.workspaceId, command.version.templateBinding.templateId])
    if (!template.rowCount) refuse('catalog_key_invalid', 'The Office template is not an admitted spreadsheet template in this workspace.', { reason: 'template_unavailable' })
  }
  let definition = await lockOperationDefinition(client, context.workspaceId, command.operationKey)
  if (!definition) {
    if (command.expectedVersion !== 0) refuse('not_found', 'The operation was not found.')
    definition = await insertOperationDefinition(client, context.workspaceId, { operationKey: command.operationKey, operationKind: command.operationKind, label: command.label }, actor)
  } else {
    if (definition.version !== command.expectedVersion) refuse('conflict', 'The operation changed. Reread it first.', { reason: 'stale_version', currentVersion: definition.version })
    if (definition.operationKind !== command.operationKind) refuse('invalid_input', 'An operation kind is stable.')
    await bumpOperationDefinition(client, context.workspaceId, definition.id, { label: command.label }, actor)
  }
  const version = await insertOperationVersion(client, context.workspaceId, definition.id, {
    ...command.version, configHash: crmOperationsSha256({ operationKind: command.operationKind, ...command.version }),
    operationId: command.operationId, actor,
  })
  await commercialAudit(tx, context, { action: 'crm.operation_version.proposed', subjectKind: 'operation_definition', subjectId: definition.id,
    details: { operationKey: command.operationKey, versionNumber: version.versionNumber } })
  return commercialResult(command.kind, { operationKey: command.operationKey, definitionId: definition.id, version }, { created: true })
}

async function acceptVersion(tx: CrmOperationsTransaction, command: Command<'accept_operation_version'>): Promise<CommercialResult> {
  const { client, context } = tx.commercial()
  if (context.actor.kind !== 'user' || !['owner', 'admin'].includes(context.authority.role)) {
    refuse('not_authorized', 'An operation version is accepted by a workspace owner or admin, never by an assistant or integration.')
  }
  const definition = await lockOperationDefinition(client, context.workspaceId, command.operationKey)
  if (!definition) refuse('not_found', 'The operation was not found.')
  if (definition.version !== command.expectedVersion) refuse('conflict', 'The operation changed. Reread it first.', { reason: 'stale_version', currentVersion: definition.version })
  const version = await readOperationVersion(client, context.workspaceId, command.versionId, true)
  if (!version || version.definitionId !== definition.id) refuse('not_found', 'The operation version was not found.')
  if (version.state !== 'proposed') refuse('invalid_transition', 'Only a proposed version can be accepted.', { state: version.state })
  const actor = actorColumns(context)
  await acceptOperationVersion(client, context.workspaceId, definition.id, version.id, actor)
  await bumpOperationDefinition(client, context.workspaceId, definition.id, { currentVersionId: version.id }, actor)
  await commercialAudit(tx, context, { action: 'crm.operation_version.accepted', subjectKind: 'operation_definition', subjectId: definition.id,
    details: { operationKey: command.operationKey, versionNumber: version.versionNumber, configHash: version.configHash } })
  return commercialResult(command.kind, { operationKey: command.operationKey, version: await readOperationVersion(client, context.workspaceId, version.id) })
}

export async function executeCrmCommercialContextCommand(tx: CrmOperationsTransaction, command: CrmCommercialContextCommand): Promise<CommercialResult> {
  return withOperationReceipt(tx, command, async () => {
    switch (command.kind) {
      case 'save_seller_profile': return saveSeller(tx, command)
      case 'save_customer_account': return saveAccount(tx, command)
      case 'accept_commercial_profile': return acceptCommercialProfile(tx, command)
      case 'save_operation_definition': return saveOperationDefinition(tx, command)
      case 'accept_operation_version': return acceptVersion(tx, command)
    }
  })
}

