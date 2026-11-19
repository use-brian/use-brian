/** Original CRM import ceiling, checked before reading a source or mutating a row.
 * [COMP:crm/production-import]
 */
import {
  CrmIntegrationGrantsSchema,
  CrmIntegrationScopeError,
  crmIntegrationResourceSelection,
  requireCrmIntegrationOperation,
  requireCrmIntegrationResources,
  type CrmIntegrationAuthority,
  type CrmIntegrationGrant,
  type CrmIntegrationOperation,
  type CrmIntegrationSelector,
} from '@use-brian/core/crm/integration-authority.js'
import {
  CrmOperationsError,
  type CrmOperationsContext,
} from '@use-brian/core/crm/operations-types.js'

const IMPORT_WRITES = [
  'crm.imports.write', 'crm.records.write', 'crm.submissions.write',
  'crm.consent.write', 'crm.entitlements.write', 'crm.participation.write',
] as const
export function importGrantSnapshot(authority: CrmIntegrationAuthority): CrmIntegrationGrant[] {
  requireCrmIntegrationOperation(authority, 'crm.imports.write')
  return authority.grants.filter((grant) => (IMPORT_WRITES as readonly string[]).includes(grant.operation))
}

export function requireImportCeiling(current: CrmIntegrationAuthority, rawStored: unknown, mode: 'read' | 'write' = 'write'): CrmIntegrationGrant[] {
  const parsed = CrmIntegrationGrantsSchema.safeParse(rawStored)
  if (!parsed.success || !parsed.data.some((grant) => grant.operation === 'crm.imports.write')
    || parsed.data.some((grant) => !(IMPORT_WRITES as readonly string[]).includes(grant.operation))) throw new CrmOperationsError('not_authorized', 'Import source authority is missing or invalid.')
  for (const required of parsed.data) {
    const operation = mode === 'read' ? required.operation.replace(/\.write$/, '.read') as CrmIntegrationOperation : required.operation
    requireCrmIntegrationOperation(current, operation)
    for (const [key, selection] of Object.entries(required.selectors)) {
      const dimension = key as CrmIntegrationSelector
      const allowed = crmIntegrationResourceSelection(current, operation, dimension)
      if (allowed === 'all') continue
      if (selection === 'all' || selection?.some((item) => !allowed.includes(item))) throw new CrmIntegrationScopeError(operation, dimension)
    }
  }
  return parsed.data
}

export function requireImportOperation(context: CrmOperationsContext, operation: 'crm.imports.read' | 'crm.imports.write'): void {
  if (context.actor.kind !== 'user' && context.actor.kind !== 'integration_key') throw new CrmOperationsError('not_authorized', 'Imports require an authenticated member or CRM integration key.')
  if (operation === 'crm.imports.write' && !context.authority.canWrite) throw new CrmOperationsError('not_authorized', 'CRM import write authority is required.')
  if (context.actor.kind === 'integration_key' && context.authority.integration?.credentialId !== context.actor.credentialId) {
    throw new CrmOperationsError('not_authorized', 'Import authority must come from the authenticated integration key.')
  }
  if (context.authority.integration) requireCrmIntegrationOperation(context.authority.integration, operation)
}

export function requireImportRowAuthority(context: CrmOperationsContext, kind: string, values: Record<string, string>, trustedIdentitySource?: string): void {
  requireImportOperation(context, 'crm.imports.write')
  const integration = context.authority.integration
  if (values.historicalSubmissionSource && !integration
    && (context.actor.kind !== 'user' || !['owner', 'admin'].includes(context.authority.role))) {
    throw new CrmOperationsError('not_authorized', 'Historical submission imports require a current workspace owner or admin.')
  }
  if (values.sourceOrderSource
    && (integration || context.actor.kind !== 'user' || !context.authority.canConfigure
      || !['owner', 'admin'].includes(context.authority.role))) {
    throw new CrmOperationsError('not_authorized', 'Source order imports require a current workspace owner or admin using a member file.')
  }
  if (values.promotionSource
    && (integration || context.actor.kind !== 'user' || !context.authority.canConfigure
      || !['owner', 'admin'].includes(context.authority.role))) {
    throw new CrmOperationsError('not_authorized', 'Promotion imports require a current workspace owner or admin using a member file.')
  }
  if (!integration) return
  if (trustedIdentitySource) throw new CrmOperationsError('not_authorized', 'Integration imports cannot acknowledge trusted identity sources.')
  const resources = (operation: CrmIntegrationOperation, selected: Parameters<typeof requireCrmIntegrationResources>[2]) => {
    requireCrmIntegrationResources(integration, 'crm.imports.write', selected)
    requireCrmIntegrationResources(integration, operation, selected)
  }
  if (kind !== 'operations') requireCrmIntegrationOperation(integration, 'crm.records.write')
  if (values.consentPurposeKey) resources('crm.consent.write', { purposeKeys: values.consentPurposeKey })
  if (values.suppressionChannel) resources('crm.consent.write', { purposeKeys: null })
  if (values.entitlementPlanId) resources('crm.entitlements.write', { planIds: values.entitlementPlanId })
  if (values.participationEventId) resources('crm.participation.write', { eventIds: values.participationEventId })
  if (values.historicalSubmissionSource) {
    // Historical source forms are not active Brian intake definitions. Only a
    // workspace-wide submissions grant may admit them; a definition allowlist
    // cannot be widened by assigning an imported form to a convenient ID.
    resources('crm.submissions.write', { definitionIds: null })
    requireCrmIntegrationResources(integration, 'crm.imports.write', { providerKeys: values.historicalSubmissionSource })
  }
  if (values.identityProvider) requireCrmIntegrationResources(integration, 'crm.imports.write', { providerKeys: values.identityProvider })
  if (values.pipelineId || values.stageId) requireCrmIntegrationOperation(integration, 'crm.records.write')
}
