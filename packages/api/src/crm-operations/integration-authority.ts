/** Resolve command resources inside the canonical transaction before mutation.
 * [COMP:api/crm-integration-auth]
 */
import type { PoolClient } from 'pg'
import {
  CrmOperationsError, CrmSegmentPredicateSchema, requireCrmIntegrationResources, assertCrmOperationsAuthority,
  type CrmOperationsCommand, type CrmOperationsContext,
} from '@use-brian/core'
import { lockCrmIntegrationCredential } from '../db/crm-integration-store.js'

export async function authorizeCrmIntegrationCommand(client: PoolClient, context: CrmOperationsContext, command: CrmOperationsCommand): Promise<void> {
  const authority = context.authority.integration
  if (!authority) return
  const workspaceId = context.workspaceId
  const ceilings = [authority]
  if (context.actor.kind === 'integration_key') {
    const current = await lockCrmIntegrationCredential(client, workspaceId, context.actor.credentialId)
    assertCrmOperationsAuthority({ ...context, authority: { ...context.authority, integration: current } }, command)
    ceilings.push(current)
  }
  const required = (operation: Parameters<typeof requireCrmIntegrationResources>[1], resources: Parameters<typeof requireCrmIntegrationResources>[2]) => {
    for (const ceiling of ceilings) requireCrmIntegrationResources(ceiling, operation, resources)
  }
  const rows = async (sql: string, values: unknown[]) => (await client.query(sql, [workspaceId, ...values])).rows
  const existing = async (sql: string, id: string): Promise<Record<string, string>> => {
    const row = (await rows(sql, [id]))[0]
    if (!row) throw new CrmOperationsError('not_found', 'The requested CRM resource is unavailable in this workspace.')
    return row
  }

  switch (command.kind) {
    case 'create_record_field':
    case 'update_record_field':
    case 'set_record_field_archived':
    case 'create_pipeline':
    case 'update_pipeline':
    case 'create_pipeline_stage':
    case 'update_pipeline_stage':
      required('crm.catalog.configure', { definitionIds: null, purposeKeys: null, planIds: null, eventIds: null })
      break
    case 'save_entitlement_plan': {
      const plans = await rows('SELECT id FROM association_membership_plans WHERE workspace_id=$1 AND plan_key=$2 FOR SHARE', [command.key])
      required('crm.catalog.configure', { planIds: plans.length ? plans.map((row) => row.id) : null })
      break
    }
    case 'save_event': {
      const events = await rows('SELECT id FROM association_events WHERE workspace_id=$1 AND slug=$2 FOR SHARE', [command.slug])
      required('crm.catalog.configure', { eventIds: events.length ? events.map((row) => row.id) : null })
      break
    }
    case 'save_intake_definition': {
      const definitions = await rows('SELECT id FROM crm_intake_definitions WHERE workspace_id=$1 AND (definition_key=$2 OR id=$3::uuid) FOR SHARE', [command.definitionKey, command.definitionId ?? null])
      required('crm.catalog.configure', { definitionIds: definitions.length ? definitions.map((row) => row.id) : null })
      if (command.definition.identityPolicy === 'trusted_verified_email') {
        throw new CrmOperationsError('not_authorized', 'A member owner or admin must acknowledge trusted identity configuration.')
      }
      for (const mapping of command.definition.consentMappings) required('crm.catalog.configure', { purposeKeys: mapping.purposeKey })
      break
    }
    case 'save_consent_purpose': {
      const purposes = await rows('SELECT purpose_key FROM crm_consent_purposes WHERE workspace_id=$1 AND (purpose_key=$2 OR id=$3::uuid) FOR SHARE', [command.purposeKey, command.purposeId ?? null])
      required('crm.catalog.configure', { purposeKeys: purposes.length ? [...purposes.map((row) => row.purpose_key), command.purposeKey] : null })
      break
    }
    case 'record_submission': {
      const definitions = await rows(`SELECT d.id,v.consent_mappings FROM crm_intake_definitions d
        JOIN crm_intake_definition_versions v ON v.workspace_id=d.workspace_id AND v.definition_id=d.id AND v.version=d.current_version
        WHERE d.workspace_id=$1 AND d.definition_key=$2 FOR SHARE OF d,v`, [command.definitionKey])
      if (!definitions[0]) throw new CrmOperationsError('not_found', 'Intake definition is unavailable.')
      required('crm.submissions.write', { definitionIds: definitions[0].id })
      for (const mapping of definitions[0].consent_mappings as Array<{ purposeKey: string }>) {
        required('crm.consent.write', { purposeKeys: mapping.purposeKey })
      }
      break
    }
    case 'update_submission': {
      const submission = await existing('SELECT definition_id FROM association_enquiries WHERE workspace_id=$1 AND id=$2', command.submissionId)
      required('crm.submissions.write', { definitionIds: submission.definition_id ?? null })
      break
    }
    case 'record_consent': required('crm.consent.write', { purposeKeys: command.purposeKey }); break
    // Suppression affects an address/channel across purposes. A purpose-limited
    // credential cannot perform that wider mutation through a consent route.
    case 'record_suppression': required('crm.consent.write', { purposeKeys: null }); break
    case 'grant_entitlement':
      required('crm.entitlements.write', { planIds: command.planId })
      if (command.provider) required('association.provider_events.write', { providerKeys: command.provider })
      break
    case 'update_entitlement': {
      const grant = await existing('SELECT plan_id,provider FROM association_memberships WHERE workspace_id=$1 AND id=$2', command.entitlementId)
      required('crm.entitlements.write', { planIds: grant.plan_id })
      if (grant.provider) required('association.provider_events.write', { providerKeys: grant.provider })
      break
    }
    case 'record_participation': required('crm.participation.write', { eventIds: command.eventId }); break
    case 'update_participation': {
      const participation = await existing('SELECT event_id FROM association_registrations WHERE workspace_id=$1 AND id=$2', command.participationId)
      required('crm.participation.write', { eventIds: participation.event_id }); break
    }
    case 'save_segment': {
      // Dynamic predicates can derive protected program facts. Require the
      // corresponding read ceiling even though saving a predicate writes only
      // a shared definition. Entity-only predicates need no program grant.
      const visit = async (node: ReturnType<typeof CrmSegmentPredicateSchema.parse>): Promise<void> => {
        for (const item of node.items) {
          if (item.type === 'group') await visit(item)
          else if (item.family === 'consent') required('crm.consent.read', { purposeKeys: item.field })
          else if (item.family === 'suppression') required('crm.consent.read', { purposeKeys: null })
          else if (item.family === 'entitlement') required('crm.entitlements.read', { planIds: null })
          else if (item.family === 'participation') required('crm.participation.read', { eventIds: null })
        }
      }
      await visit(CrmSegmentPredicateSchema.parse(command.predicate))
      break
    }
    case 'archive_segment':
    case 'set_deal_pipeline_stage': break // Workspace-wide records.write already checked.
    case 'create_intake_credential':
    case 'revoke_intake_credential': throw new CrmOperationsError('not_authorized', 'Integration credentials cannot administer other credentials.')
    case 'save_reference_definition':
      required('crm.references.configure', { referenceDefinitionKeys: command.definition.definitionKey })
      break
    case 'import_business_references':
      required('crm.references.configure', { referenceDefinitionKeys: command.definitionKey })
      break
    case 'assign_business_reference':
      required('crm.references.write', { referenceDefinitionKeys: command.definitionKey })
      break
    case 'replace_business_reference':
    case 'retire_business_reference': {
      const row = await existing(`SELECT d.definition_key AS key FROM crm_business_references r JOIN crm_reference_definitions d
        ON d.workspace_id=r.workspace_id AND d.id=r.definition_id WHERE r.workspace_id=$1 AND r.id=$2`, command.referenceId)
      required('crm.references.configure', { referenceDefinitionKeys: row.key! })
      break
    }
  }
}
