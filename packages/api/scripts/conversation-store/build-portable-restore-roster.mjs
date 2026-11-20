#!/usr/bin/env node
// [COMP:api/portable-restore] Reviewed generator for the finite portable-restore roster.
//
// Usage (development only, against a fresh shipped chain owned by the
// disposable fixture; never a customer or personal database):
//   node scripts/crm/local-fixture.mjs --pg-bin <PG18> --ordinary-owner -- \
//     node packages/api/scripts/conversation-store/build-portable-restore-roster.mjs \
//       --inventory <restore-table-classification.json> [--cohort <head migration>] [--check]
// --cohort names a reviewed release cohort: the fixture chain must stop at that
// file, and the cohort roster file is written or checked instead of the head roster.
//
// The inventory is the reviewed metadata-only table classification. This tool
// joins it with the fresh shipped catalog to emit an explicit per-table,
// per-sequence and per-trigger roster. The output is committed and reviewed;
// import never reclassifies from a target catalog. Unknown objects refuse.
import {readFile,writeFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {createHash} from 'node:crypto'
import {portableLegacyConversionTables,portableOwnerPolicies,restoreStrippedFields} from './portable-restore-seals.mjs'
import {harnessTables,harnessTriggerReview} from './portable-harness-review.mjs'

import {
 crmSummaryAuthorityEpochs,crmSummaryCredentialRule,crmSummaryDerivedRules,crmSummaryOriginStamps,
 crmSummaryProjectionRule,crmSummaryStructuralValidators,crmSummaryWriterHelpers,
} from './crm-summary-portable.mjs'

const here=fileURLToPath(new URL('./',import.meta.url))
const rosterPath=here+'portable-restore-roster.json'
// Reviewed release-cohort rosters, each generated against a fresh chain stopped at
// its cohort head (the existing-brain transfer pins the 8273 roster by digest).
export const cohortRosters=Object.freeze({'8273_conversation_requirement_conversion.sql':'portable-restore-roster-8273.json'})
const pg=createRequire(here+'../../package.json')('pg')
const sha=value=>createHash('sha256').update(value).digest('hex')

// Ownership rules. Every table must match exactly one; the inventory states
// which installation tables are derived, the rest default to durable facts.
export const rosterRules=Object.freeze({
 'D1-ledger':'Migration ledger. The target ledger is produced by the shipped installer; the archived source ledger is retained as original proof and must name the same shipped release.',
 'D2-capture-targets':'Recovery-capture target registry. Rendered by the shipped installer from the target schema; archived rows must equal the target rows exactly.',
 'D3-retained-fingerprints':'Retained executable fingerprint projections. Target rows come from the shipped installer; the archived signature roster must match and archived fingerprints are original proof only.',
 'D4-canonical-registry':'Canonical executable registry. Target records are rendered and authenticated by the shipped installer and installation authenticator; archived records are original proof only, never imported or repinned.',
 'D5-display-fingerprints':'Historical display fingerprint owner. Target rows come from the shipped installer; archived rows are original proof only; signatures must match, fingerprints are never blanket repinned.',
 'D6-enrollment-maintenance':'Conversion enrollment queue. Maintenance state the shipped enrollment trigger re-derives while restored units are imported; archived keys must be a subset of the re-derived keys and the generation counter is installation-local. Re-enrolled units are reconverted idempotently.',
 'D9-envelope-scan':'Derived historical envelope scan cursor. The target restarts its bounded inventory scan after restoring durable envelopes.',
 [crmSummaryProjectionRule]:'CRM summary projection. Rebuild atomically from exact restored facts and verify current leaves against archived history.',
 [crmSummaryCredentialRule]:'CRM summary signing material. Sealed and restored through its bounded encrypted credential artifact.',
 'D8-transaction-scratch':'Transaction-local settings proof. A committed snapshot must be empty. The target never imports this table.',
 'D7-contract-witness':'Registry-guard catalog witness (8276). Installation-local catalog tuple identities for the guard fast path; never imported. The import ends with the owner-only native_turn_contract_witness_refresh(), which re-records it from the restored target catalog.',
 'F1-durable-fact':'User, workspace, conversation and operational fact. Imported exactly under canonical constraints; post-import row digests must equal the archived digests.',
 'F2-authority-epoch':'Durable authority epoch or revision state. Imported exactly; when the shipped installer seeds an initial value, the archived value replaces that seed by primary key.',
 'R1-regprocedure-slot':'Durable logical definition with named regprocedure slots. Slots are exported as schema-qualified signatures and rebound only through the authenticated target catalog; an unresolvable or unshipped signature refuses.',
})
export const sequenceRule='S1-durable-sequence: sequence positions are durable identifiers; restored exactly after import and never behind the restored maximum.'
export const triggerRules=Object.freeze({
 fires:'Structural validator or fixpoint NEW-row stamp. Fires for every imported row; the tables a structural validator reads are imported first (validatorOrder) and its effect on the row must reproduce the archived row (digest).',
 'suspended:derived-effect':'Writes another durable relation. Its output is itself archived and imported exactly; suspended by exact name inside the import transaction and re-enabled before commit.',
 'suspended:notification':'Notifies runtime listeners. The restored installation has no activated listeners; suspended by exact name and re-enabled before commit.',
 'suspended:creation-admission':'Consumes a transaction-local creation admission. Restored facts were admitted at origin and are not new creations; suspended by exact name and re-enabled before commit.',
 'suspended:creation-currency':'Creation-time currency guard. Requires a referenced source to be at its current version when a new row is written; restored historical rows were admitted at origin and their sources may have advanced since. Suspended by exact name; exact digests and post-import authentication still apply.',
 'fires:contract-bound':'Required enabled by the authenticated native contract roots (disabling it makes a root guard false), so it fires during import even though it writes or guards. Its writes must reproduce archived rows exactly or target a re-derived (D6) table.',
 'suspended:contract-window':'Contract-bound creation-time currency guard that cannot re-admit a historical row outside its origin transaction. Suspended by exact name only while its own table is imported, re-enabled before any other table or deferred validation; the native contract roots must be current again immediately afterwards.',
 'suspended:restoration-stamp':'Generic updated_at stamp on a table the restore updates by primary key (deferred cycle reference or seed replacement). Suspended so the archived timestamp is restored exactly.',
 'fires:recovery-capture':'Erasure capture. Fires but is inert: the import never enables the capture setting.',
 'suspended:origin-validator':'Validator whose check reads origin-time state: the acting user, session settings or admission receipts, the clock, the row\'s own status at creation, or the then-current state of another relation (currency, membership, policy, held or erased sources, current schema), including rows written later in the import because their deriving trigger is suspended. It would refuse a fact admitted at origin; suspended by exact name for the import transaction and re-enabled before commit, with the same enablement and digest checks. A contract-bound one is windowed instead.',
 'suspended:restoration-placeholder':'Trigger on a table restored with deferred NULL placeholders whose body reads a deferred column or the whole row. At INSERT it would judge the placeholder and on the primary-key fixup the import\'s own restoration update, never the archived row; suspended for the import transaction and re-enabled before commit.',
 'suspended:origin-stamp':'BEFORE INSERT stamp whose value comes from origin-time state rather than from the archived row: the row\'s own write history (for example the lease token a release cleared), the clock, randomness, session settings, or another relation at that moment. Re-firing it would overwrite an archived durable value or refuse a historical row, so it is suspended by exact name for the import transaction and re-enabled before commit; exact digests and post-import authentication still apply. A reviewed origin stamp that a native contract root requires refuses the roster build.',
})
// Reviewed audit of every `fires` BEFORE INSERT trigger whose function assigns a
// NEW column (docs/architecture/platform/portable-brain-restore.md, "INSERT stamp
// audit"). Every such trigger must be named in exactly one list; the builder
// refuses an unreviewed one, so a new migration cannot add a silent stamp.
// Origin stamps: the INSERT branch re-derives a column from origin-time state.
export const originStamps=Object.freeze([
 'api_keys.api_keys_issuer','api_keys.external_key_admission','application_api_credentials.application_credential_guard',
 'application_api_credentials.application_scoped_credential_version','application_credential_grants.application_credential_maximum_guard',
 'application_home_bindings.application_home_binding_guard','application_native_resource_owners.application_deployed_module_owner_guard',
 'application_oauth_bindings.application_oauth_binding_guard','application_oauth_bindings.application_scoped_oauth_binding_version',
 'association_audit_log.crm_scope_audit_guard','association_inventory_boundaries.zz_association_inventory_boundary_write',
 'association_notification_outbox.association_notification_scope_capture','blueprint_records.workflow_copy_parent_valid',
 'brain_keys.brain_keys_issuer','brain_keys.external_key_admission','brain_row_versions.crm_file_copy_parent_valid',
 'brain_verifications.brain_verification_scope','connector_grant.zzz_connector_department_home_stamp',
 'connector_instance.zzz_connector_department_home_stamp','connector_source_profiles.connector_source_profile_guard',
 'correction_audit.a_correction_scope','correction_audit.crm_file_copy_parent_valid','crm_activities.crm_scope_activity_guard',
 'crm_domain_event_outbox.crm_scope_event_guard','crm_intake_credentials.crm_intake_credential_replay_scope',
 'department_edges.department_edges_validate','entities.zzz_department_home_stamp','entity_instances.application_record_version',
 'entity_links.zzz_department_home_stamp','episodes.episodes_context_ingest_inherit','episodes.watch_capture_occurred_at',
 'episodes.zzz_department_home_stamp','file_cache.file_cache_context_scope_inherit','file_segments.file_segments_context_scope_inherit',
 'goal_crm_event_sources.goal_crm_source_guard','goals.goal_event_park_revision','memories.zzz_department_home_stamp',
 'memory_verifications.memory_verification_scope','office_artifact_sources.office_sources_root_scope_inherit',
 'pending_approvals.workflow_copy_parent_valid','pending_ingest_batches.programmatic_batch_binding_guard',
 'project_shared_members.project_shared_members_validate','recordings.recordings_context_scope_inherit',
 'saved_views.page_event_revision','scheduled_jobs.workflow_copy_parent_valid','sessions.aaab_session_project_label',
 'sessions.remember_native_session_turn_lease','tasks.zzz_department_home_stamp',
 'transcript_segments.transcript_segments_context_scope_inherit','workflow_run_copy_sources.workflow_copy_scope_evidence',
 'workflow_run_copy_sources.workflow_enrichment_copy_evidence','workflow_runs.capture_workflow_run_department',
 'workflow_runs.routine_run_context','workflow_runs.workflow_knowledge_event_binding','workflow_runs.workflow_page_event_binding',
 'workflow_runs.workflow_task_event_binding','workflows.a_routine_creation_stamp','workflows.routine_intake_configuration_guard',
 'workspace_audit_log.crm_file_copy_parent_valid','workspace_audit_log.crm_scope_audit_guard','workspace_audit_log.workflow_copy_parent_valid',
 'workspace_files.zzz_department_home_stamp',
])
// Fixpoint stamps: the INSERT branch assigns nothing (only the UPDATE branch
// does), or it is a function of the row's own columns that every write path
// maintains, so an archived row is reproduced exactly. They keep firing.
export const fixpointStamps=Object.freeze([
 'application_access_grants.application_grant_guard','application_clients.application_client_guard',
 'application_native_role_assignments.application_native_role_guard','entity_types.application_schema_contract',
 'knowledge_entries.ke_search_update','pending_approvals.pending_approval_retain_session_requirement',
 'sessions.aaaa_session_kind','task_execution_states.task_execution_states_guard_trg','tasks.application_task_logical_identity',
 'teamspace_members.teamspace_members_linked_roster_immutable','workflow_runs.crm_privacy_write_admission',
 'workflow_runs.workflow_goal_scope_guard','workflow_step_runs.crm_privacy_write_admission',
 'workspace_access_migration_items.access_migration_guard','workspace_access_migration_plans.access_migration_guard',
 'workspace_access_policies.workspace_access_mode_guard','workspace_files.wf_search_update',
])
// A PL/pgSQL body that can change the inserted row: a NEW column assignment
// (:= or =, as a statement), SELECT ... INTO NEW.column, a whole-record NEW
// assignment, or a RETURN of anything other than NEW/NULL/OLD.
// Validator audit (see the spec, "Validator audit"). Verdicts are by trigger
// function; originValidatorTriggers names single triggers of a shared function.
// Origin validators: the check reads origin-time state (the acting user, session
// settings or admission receipts, the clock, a row's status at creation, or the
// then-current state of another relation: currency, membership, policy, held or
// erased sources, current schema or field definitions, or rows the import
// writes later because their deriving trigger is suspended). Suspended.
export const originValidators=Object.freeze([
 'application_client_guard','application_grant_guard','application_guard_canonical_task_fields','application_guard_deployed_module_record',
 'application_guard_generic_field_write','application_guard_native_crm_configuration','application_guard_native_crm_participant_change',
 'application_guard_native_entity_values','application_guard_native_module_lifecycle','application_guard_native_reference_invariants',
 'application_recheck_native_task_sources','application_reviewed_credential_guard','application_reviewed_grant_guard',
 'application_task_logical_chain_valid','application_validate_generic_record','application_validate_schema_rows',
 'application_version_typed_company_patch','association_registration_inventory_guard','association_source_membership_guard',
 'crm_import_copy_parent_admission','crm_privacy_guard_workflow_write','documents_brief_guard','enforce_task_workflow_dispatch_boundary',
 'enforce_workflow_file_temporal_boundary','enforce_workflow_run_authority','enforce_workflow_task_pause_boundary','external_service_oauth_guard',
 'guard_assistant_transfer_admission','guard_channel_recording_message','guard_department_assistant_sharing','guard_department_command_review',
 'guard_engineering_archive_batch','guard_engineering_file_purpose','guard_episodic_promotion','guard_external_source_derivation',
 'guard_file_cache_source','guard_knowledge_source_binding','guard_media_publication','guard_office_generation_file_binding',
 'guard_office_workspace_parent','guard_organization_cutover_review','guard_private_session_recovery','guard_programmatic_rule_binding',
 'guard_scope_consolidation_item','guard_scope_default_consolidation','guard_scope_review_impact','guard_scope_review_item',
 'guard_scope_review_proposal','guard_superseded_recording_job','guard_watch_capture_publication','guard_workflow_copy_department',
 'guard_workflow_event_scope','guard_workflow_goal_scope','guard_workspace_access_migration','guard_workspace_access_mode',
 'guard_workspace_default_package','guard_workspace_legacy_cleanup_review','prevent_linked_teamspace_roster_mutation','renew_browser_file_source',
 'require_conversation_record_retention_current','require_media_lineage','validate_department_read_record','validate_memory_summary_slot','validate_project_shared_owner',
 'validate_workspace_group_scope_reference','validate_workspace_project_reference','workflow_copy_source_admission','workspace_mcp_oauth_guard',
])
// The crm privacy write admission only takes a shared lock, except on brain row
// versions, where it also requires the canonical subject to still exist.
export const originValidatorTriggers=Object.freeze(['brain_row_versions.crm_privacy_write_admission'])
// Structural validators: the check is a function of the row and of immutable
// identity (id, workspace, kind) of rows it references, a lock, or a deferred
// pair invariant over the complete restored set. They fire.
export const structuralValidators=Object.freeze([
 'application_generic_identity_unused','application_native_catalog_guard','application_native_configuration_guard',
 'application_native_configuration_operation_guard','application_native_contract_guard','application_native_owner_guard',
 'application_native_role_guard','application_task_logical_identity','application_validate_generic_schema','channel_assistants_workspace_match',
 'check_knowledge_binding_commit','check_organization_cutover_commit','crm_entitlement_lineage_guard','crm_lock_delivery_evidence_person',
 'crm_privacy_guard_write','derive_session_kind','enforce_page_link_alias_workspace','enforce_workflow_invocation_authority',
 'goals_parent_workspace_match','guard_assistant_placement','guard_engineering_operational_input','guard_knowledge_revision_value',
 'guard_office_library_references','guard_saved_view_shared_project','identity_bindings_scope_guard','invalidate_browser_session_scope',
 'ke_search_vector_update','lock_browser_task_mutation','lock_conversation_anchor_policy_change','lock_office_publication_authority','native_conversation_frame_requirement_guard',
 'native_conversation_publication_complete','native_turn_capture_event','native_turn_validate_frame_pair','preserve_pdf_intake_binding',
 'retain_approval_session_requirement','task_execution_states_guard','tasks_parent_workspace_match','tasks_responsibility_workspace_match',
 'validate_brain_key_context_binding','validate_campaign_entity_workspace','validate_campaign_placement_workspace','validate_connector_context_scope',
 'validate_context_scope_arrays','validate_department_owner','validate_feed_collaboration_scope','validate_knowledge_revision_pair',
 'validate_operational_context_binding','validate_programmatic_capture_binding','validate_saved_view_project','validate_session_context_revision_pair',
 'validate_session_title_pair','validate_team_compartment_binding','validate_teamspace_context_group','validate_workspace_project_entity',
 'wf_search_vector_update',
])
// Reviewed per-table reads of shared structural validators that branch on
// TG_TABLE_NAME, where the lexical superset would order tables in a cycle.
export const validatorBranchReads=Object.freeze({
 crm_privacy_guard_write:{},
 guard_office_library_references:{office_templates:['office_artifacts','office_template_versions'],office_template_versions:['office_artifact_versions','office_templates','workspace_files'],
  office_resources:['workspace_files'],office_template_resource_refs:['office_resources','office_template_versions']},
 validate_connector_context_scope:{connector_grant:['workspace_compartments','workspace_projects'],connector_instance:['workspace_compartments','workspace_projects'],
  ingest_rules:['connector_grant','connector_instance','programmatic_capture_profiles','workspace_compartments','workspace_projects']},
})
/** Body reads a deferred column (NEW.c / OLD.c) or the whole NEW/OLD record. */
export function readsRestorationPlaceholder(source,columns){
 const body=source.replace(/--[^\n]*/g,'').replace(/\bRETURN\s+(COALESCE\s*\(\s*NEW\s*,\s*OLD\s*\)|NEW|OLD|NULL)\s*;/gi,';')
 if(columns.some(column=>new RegExp('\\b(NEW|OLD)\\s*\\.\\s*"?'+column+'"?\\b').test(body)))return true
 return /\b(NEW|OLD)\b(?!\s*\.)(?!\s*:?=)/.test(body.replace(/'[^']*'/g,"''"))
}
/** Relations a body reads directly (FROM/JOIN targets), lower-case, unqualified. */
export function tablesReadBy(source){
 const body=source.replace(/--[^\n]*/g,'')
 return [...new Set([...body.matchAll(/\b(?:FROM|JOIN)\s+(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)\b"?(?!\s*\()/gi)].map(match=>match[1].toLowerCase()))]
}
export function assignsInsertedRow(source){
 const body=source.replace(/--[^\n]*/g,'')
 return /(^|;|\bTHEN\b|\bELSE\b|\bBEGIN\b|\bLOOP\b)\s*NEW\s*\.\s*"?[a-z_0-9]+"?\s*:?=(?!=)/im.test(body)
  ||/\bINTO\s+(STRICT\s+)?(("?[a-z_0-9]+"?(\s*\.\s*"?[a-z_0-9]+"?)?)\s*,\s*)*NEW\s*\./i.test(body)
  ||/(^|;|\bTHEN\b|\bELSE\b|\bBEGIN\b)\s*NEW\s*:?=/im.test(body)
  ||[...body.matchAll(/\bRETURN\s+([A-Za-z_]+)/gi)].some(match=>!['NEW','NULL','OLD','QUERY','NEXT'].includes(match[1].toUpperCase()))
}
// Reviewed creation-time currency guards (see triggerRules). Each was observed
// refusing an exact historical row during disposable two-installation proof.
const creationCurrencyGuards=['validate_scope_resource_reference','validate_application_field_dependencies','validate_page_derivation_dependencies','validate_workflow_derivation_dependencies']
// Reviewed transitive writers. A trigger function calling one of these writes
// another relation even though its own body has no write statement.
const reviewedWriterHelpers=['department_edges_reconcile','crm_projection_append','application_record_native_task_write_intent',
 'retract_admitted_native_memory','resume_private_legacy_session','capture_page_event_observation']
const recordWriterHelpers=['classify_conversation_envelope','withdraw_conversation_record_targets']
const configuredStructuralValidators=['protect_configured_task_receipt']
const authorityEpochTables=['application_policy_contract_epoch','application_policy_workspace_epochs','application_native_crm_configuration_epochs','ledger_epoch',...crmSummaryAuthorityEpochs]
const seedReplaceKeys={application_policy_contract_epoch:['singleton'],ledger_epoch:['id']}
// Reviewed deviation from the inventory: enrollment is re-derived, not imported.
const rederivedRule={native_conversation_conversion_pending:'D6-enrollment-maintenance'}
// Native contract roots whose truth depends on canonical trigger enablement.
const contractRoots=['native_turn_helpers_current()','native_retained_helpers_current()','native_turn_publication_contract()','native_conversation_conversion_contract()']
// Polymorphic source references carry no foreign key; their contract-bound
// validators read the current source row, so they import after every table.
const polymorphicLate=['scope_resource_states','scope_derivations','scope_derivation_sources']
const derivedRule={...crmSummaryDerivedRules,_migrations:'D1-ledger',crm_erasure_journal_targets:'D2-capture-targets',native_retained_contract_helpers:'D3-retained-fingerprints',
 native_turn_contract_helpers:'D4-canonical-registry',private_session_display_contract:'D5-display-fingerprints',native_turn_contract_witness:'D7-contract-witness',
 conversation_settings_transitions:'D8-transaction-scratch',native_memory_query_write_intents:'D8-transaction-scratch',
 conversation_envelope_backfill_checkpoint:'D9-envelope-scan'}
// FORCE-RLS read/write access paths, with the schema facts that prove complete
// coverage of actor partitions. Changes to these policies refuse at import.
const forceAccess={
 session_archives:{access:'actor',actorColumn:'user_id',coverage:['session_archives_user_id_fkey']},
 structured_document_fill_proposals:{access:'actor',actorColumn:'user_id',coverage:['structured_document_fill_proposals_user_id_fkey','structured_document_fill_proposals_workspace_id_user_id_fkey']},
 workspace_mcp_contexts:{access:'actor',actorColumn:'user_id',coverage:['workspace_mcp_contexts_user_id_fkey']},
 workspace_mcp_operations:{access:'actor',via:{table:'workspace_mcp_contexts',column:'context_id'},coverage:['workspace_mcp_operations_context_id_fkey']},
 workspace_mcp_runs:{access:'actor',via:{table:'workspace_mcp_contexts',column:'context_id'},coverage:['workspace_mcp_runs_context_id_fkey']},
}
const writeEffect=/\b(INSERT\s+INTO|UPDATE\s+(ONLY\s+)?[a-z_."]+(\s+(AS\s+)?[a-z_]+)?\s+SET|DELETE\s+FROM)/i

function classifyTrigger(name,functionName,source,writerHelpers){
 if(name==='crm_recovery_capture'&&functionName==='crm_capture_erasure_effect')return'fires:recovery-capture'
 if(creationCurrencyGuards.includes(functionName))return'suspended:creation-currency'
 if(writeEffect.test(source)||writerHelpers.some(helper=>new RegExp('\\b'+helper+'\\s*\\(').test(source)))return'suspended:derived-effect'
 if(/\bset_config\s*\(/i.test(source))return'suspended:creation-admission'
 if(/\bpg_notify\s*\(/i.test(source))return'suspended:notification'
 return'fires'
}

export async function buildRoster(client,inventory){
 if(inventory?.format!==1||!Array.isArray(inventory.tables))throw Error('portable_roster_inventory_malformed')
 const catalog=(await client.query(`SELECT c.relname,c.relforcerowsecurity force_rls,
   coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER(WHERE a.attgenerated<>''),'{}') generated,
   coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER(WHERE a.attidentity<>''),'{}') identity,
   coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER(WHERE a.atttypid='pg_catalog.regprocedure'::regtype),'{}') slots,
   coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER(WHERE a.atttypid='pg_catalog.xid8'::regtype
    OR (a.attname IN('transaction_id','write_transaction') AND a.atttypid IN('pg_catalog.int8'::regtype,'pg_catalog.xid8'::regtype))),'{}') transaction_bound
  FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p') GROUP BY c.relname,c.relforcerowsecurity ORDER BY c.relname COLLATE "C"`)).rows
 const inventoryByName=new Map(inventory.tables.map(row=>[row.table,row]))
 if(inventoryByName.size!==inventory.tables.length||inventory.tables.some(row=>row.schema!=='public'))throw Error('portable_roster_inventory_malformed')
 // The inventory is reviewed against one shipped chain: its ledger length must be
 // the fresh chain's, and the roster records that chain's head entry.
 const ledger=(await client.query('SELECT name FROM public._migrations ORDER BY name COLLATE "C"')).rows.map(row=>row.name)
 if(!ledger.length||inventory.ledgerCount!==ledger.length)throw Error('portable_roster_ledger_drift: inventory '+inventory.ledgerCount+', fresh chain '+ledger.length)
 const tables={}
 for(const row of catalog){
  const reviewed=inventoryByName.get(row.relname)
  if(!reviewed)throw Error('portable_roster_unknown_table: '+row.relname)
  const derived=reviewed.ownership==='installation_derived'
  if(derived!==(row.relname in derivedRule))throw Error('portable_roster_derived_mismatch: '+row.relname)
  if(JSON.stringify(reviewed.generatedColumns)!==JSON.stringify(row.generated)||JSON.stringify(reviewed.identityColumns)!==JSON.stringify(row.identity)
   ||reviewed.forceRls!==row.force_rls||JSON.stringify(reviewed.namedSlots.map(slot=>slot.column))!==JSON.stringify(row.slots))throw Error('portable_roster_inventory_drift: '+row.relname)
  const rederived=rederivedRule[row.relname]
  const entry={class:derived?'derived':rederived?'rederived':row.slots.length?'rebound':'durable',
   rule:derived?derivedRule[row.relname]:rederived??(row.slots.length?'R1-regprocedure-slot':authorityEpochTables.includes(row.relname)?'F2-authority-epoch':'F1-durable-fact')}
  if(row.slots.length)entry.slots=row.slots
  if(row.generated.length)entry.generated=row.generated
  if(row.identity.length)entry.identity=row.identity
  const seals=restoreStrippedFields[row.relname]
  if(seals){
   const present=(await client.query(`SELECT attname,format_type(atttypid,atttypmod) type,
    NOT attnotnull AND NOT atthasdef AND attgenerated='' AND attidentity='' transferable
    FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attname=ANY($2)`,
    ['public.'+row.relname,Object.keys(seals)])).rows
   if(present.length){
    if(present.length!==Object.keys(seals).length||present.some(column=>seals[column.attname]!==column.type||!column.transferable))
     throw Error('portable_roster_ephemeral_seal_shape_changed: '+row.relname)
    entry.stripOnTransfer=Object.keys(seals)
   }
  }
  const transactionBound=row.transaction_bound.filter(column=>!entry.stripOnTransfer?.includes(column))
  if(transactionBound.length)entry.transactionBound=transactionBound
  // Rows the shipped installer itself seeds into a fresh chain. Some seeds carry
  // installation-time values (now()), so the archived row replaces the seed by
  // primary key; any other pre-existing row refuses.
  if(!derived&&!row.force_rls&&(await client.query(`SELECT EXISTS(SELECT 1 FROM public."${row.relname}") seeded`)).rows[0].seeded){
   entry.seeded=true
   const primary=(await client.query(`SELECT array_agg(a.attname::text ORDER BY u.o) cols FROM pg_constraint k,unnest(k.conkey) WITH ORDINALITY u(n,o),pg_attribute a
    WHERE k.conrelid=$1::regclass AND k.contype='p' AND a.attrelid=k.conrelid AND a.attnum=u.n`,['public.'+row.relname])).rows[0].cols
   if(!primary)throw Error('portable_roster_seed_without_primary_key: '+row.relname)
   if(seedReplaceKeys[row.relname]&&JSON.stringify(seedReplaceKeys[row.relname])!==JSON.stringify(primary))throw Error('portable_roster_seed_key_changed: '+row.relname)
   entry.seedReplaceKey=primary
  }
  if(row.force_rls)entry.forceRls=forceAccess[row.relname]??{access:'system'}
  if(polymorphicLate.includes(row.relname))entry.importLate=true
  tables[row.relname]=entry
 }
 for(const name of inventoryByName.keys())if(!tables[name])throw Error('portable_roster_missing_table: '+name)
 if(tables.conversation_envelopes?.stripOnTransfer)for(const name of portableLegacyConversionTables){
  if(!tables[name])throw Error('portable_roster_missing_conversion_table: '+name)
  tables[name].excludeCompiledRecords=true
 }
 // System-path FORCE tables must actually expose the reviewed system policy.
 const policies=(await client.query(`SELECT p.tablename,p.policyname,p.cmd,p.qual,p.with_check,
  p.roles=ARRAY[pg_get_userbyid(c.relowner)]::name[] AND p.permissive='PERMISSIVE' owner_policy
  FROM pg_policies p JOIN pg_class c ON c.relnamespace='public'::regnamespace AND c.relname=p.tablename
  WHERE p.schemaname='public' AND c.relforcerowsecurity ORDER BY p.tablename COLLATE "C",p.policyname COLLATE "C"`)).rows
 const policyDigests={}
 for(const [name,entry] of Object.entries(tables))if(entry.forceRls){
  const own=policies.filter(policy=>policy.tablename===name)
  const ownerPolicy=portableOwnerPolicies[name]
  if(entry.forceRls.access==='system'&&ownerPolicy&&own.some(policy=>policy.policyname===ownerPolicy&&policy.owner_policy&&policy.cmd==='ALL'&&policy.qual==='true'&&policy.with_check==='true'))
   entry.forceRls={access:'owner',policy:ownerPolicy}
  if(entry.forceRls.access==='system'&&!own.some(policy=>policy.cmd==='ALL'&&/current_setting\('app\.system_bypass'::text, true\)/.test(policy.qual)))throw Error('portable_roster_force_rls_unreviewed: '+name)
  policyDigests[name]=sha(JSON.stringify(own.map(({policyname,cmd,qual,with_check})=>[policyname,cmd,qual,with_check])))
  entry.forceRls.policyDigest=policyDigests[name]
 }
 const crmSummary=Boolean(tables.crm_summary_receipt_keys)
 const writerHelpers=[
  ...reviewedWriterHelpers,...(tables.conversation_envelopes?recordWriterHelpers:[]),...(crmSummary?crmSummaryWriterHelpers:[]),
 ]
 const activeOriginStamps=crmSummary?[...originStamps,...crmSummaryOriginStamps]:originStamps
 const sequences=Object.fromEntries((await client.query(`SELECT s.relname,
   (SELECT c.relname||'.'||a.attname FROM pg_depend d JOIN pg_class c ON c.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    WHERE d.classid='pg_class'::regclass AND d.objid=s.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN('a','i')) owner
  FROM pg_class s WHERE s.relnamespace='public'::regnamespace AND s.relkind='S' ORDER BY s.relname COLLATE "C"`)).rows
  .map(row=>[row.relname,{rule:'S1-durable-sequence',...(row.owner?{owner:row.owner}:{})}]))
 const triggerRows=(await client.query(`SELECT c.relname,t.tgname,t.tgtype,p.oid::regprocedure::text function,p.proname,p.prosrc,t.tgconstraint<>0 constraint_trigger,t.tgdeferrable deferrable,l.lanname
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_language l ON l.oid=p.prolang
  WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace AND (t.tgtype & 4<>0 OR t.tgtype & 16<>0)
  ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C"`)).rows
 const triggers={},bodies=new Map(),stampAudit=new Set([...activeOriginStamps,...fixpointStamps])
 if(stampAudit.size!==activeOriginStamps.length+fixpointStamps.length)throw Error('portable_roster_stamp_review_overlap')
 for(const row of triggerRows){
  const entry=tables[row.relname]
  if(!entry||entry.class==='derived'||entry.class==='rederived')continue
  const inserts=(row.tgtype&4)!==0,updates=(row.tgtype&16)!==0
  // UPDATE-only triggers matter for seed replacement and deferred-reference fixup.
  if(!inserts&&!updates)continue
  const key=row.relname+'.'+row.tgname,trigger={function:row.function,tgtype:row.tgtype,class:classifyTrigger(row.tgname,row.proname,row.prosrc,writerHelpers),
   events:[inserts&&'insert',updates&&'update'].filter(Boolean)}
  if(harnessTables.includes(row.relname)){
   const review=harnessTriggerReview[key]
   const expectedType=review==='suspended:derived-effect'?21:review==='update-only'?19:review==='update-delete-only'?27:null
   if(row.tgtype!==expectedType||review==='suspended:derived-effect'&&trigger.class!==review)
    throw Error('portable_roster_harness_trigger_changed: '+key)
  }
  // INSERT stamp audit: a firing BEFORE INSERT trigger that can change the row
  // must have been reviewed as an origin stamp or a fixpoint stamp.
  const stamps=trigger.class==='fires'&&inserts&&(row.tgtype&2)!==0&&(row.lanname!=='plpgsql'||assignsInsertedRow(row.prosrc))
  if(stamps&&!stampAudit.has(key))throw Error('portable_roster_unreviewed_insert_stamp: '+key)
  if(stampAudit.has(key)&&!stamps)throw Error('portable_roster_stamp_review_stale: '+key)
  if(activeOriginStamps.includes(key))trigger.class='suspended:origin-stamp'
  triggers[key]=trigger;bodies.set(key,row)
 }
 for(const key of stampAudit)if(!triggers[key])throw Error('portable_roster_stamp_review_stale: '+key)
 if(harnessTables.some(name=>tables[name])){
  if(harnessTables.some(name=>tables[name]?.class!=='durable'))throw Error('portable_roster_harness_table_missing')
  for(const key of Object.keys(harnessTriggerReview))if(!triggers[key])throw Error('portable_roster_harness_trigger_missing: '+key)
 }
 // Cross-table cycles among non-deferrable references are broken only at
 // reviewed nullable references, inserted NULL then restored by primary key.
 const references=(await client.query(`SELECT k.conname,c.relname child,p.relname parent,k.condeferrable deferrable,
   ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n,o) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.n ORDER BY u.o) columns,
   ARRAY(SELECT NOT a.attnotnull FROM unnest(k.conkey) WITH ORDINALITY u(n,o) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.n ORDER BY u.o) nullable
  FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_class p ON p.oid=k.confrelid
  WHERE k.contype='f' AND c.relnamespace='public'::regnamespace AND k.conrelid<>k.confrelid ORDER BY k.conname COLLATE "C"`)).rows
 const deferredReferences=chooseDeferredReferences(references.filter(edge=>!edge.deferrable&&['durable','rebound'].includes(tables[edge.child]?.class)&&['durable','rebound'].includes(tables[edge.parent]?.class)))
 // History guards must never judge restoration-generated UPDATEs. A future
 // harness reference cycle requires its own reviewed restoration design.
 if(deferredReferences.some(reference=>harnessTables.includes(reference.table)))throw Error('portable_roster_harness_deferred_update_unsupported')
 // Restoration updates (deferred cycle references, seed replacement) restore
 // archived values; the generic updated_at stamp would overwrite them.
 const restoredByUpdate=new Set([...deferredReferences.map(reference=>reference.table),...Object.keys(tables).filter(name=>tables[name].seeded)])
 for(const [key,trigger] of Object.entries(triggers))if(restoredByUpdate.has(key.split('.')[0])&&trigger.events.includes('update')&&trigger.class==='fires'
  &&/^(public\.)?trigger_set_updated_at\(\)$/.test(trigger.function))trigger.class='suspended:restoration-stamp'
 // Tables restored with deferred NULL placeholders: a firing trigger that reads a
 // deferred column (or the whole row) would judge the placeholder at INSERT and
 // the import's own primary-key fixup at UPDATE, never the archived row.
 const deferredColumns=new Map()
 for(const reference of deferredReferences)deferredColumns.set(reference.table,[...(deferredColumns.get(reference.table)??[]),...reference.columns])
 for(const [key,trigger] of Object.entries(triggers)){
  const columns=deferredColumns.get(key.split('.')[0])
  if(columns&&trigger.class==='fires'&&readsRestorationPlaceholder(bodies.get(key).prosrc,columns))trigger.class='suspended:restoration-placeholder'
 }
 // Validator audit: every trigger still firing during import (INSERT, or UPDATE
 // on a table the import updates) has a reviewed verdict by function, with
 // reviewed per-trigger exceptions. Origin validators are suspended; structural
 // validators fire, and the tables their bodies read are imported first.
 const structural=[
  ...structuralValidators,...(tables.episode_extraction_items?.stripOnTransfer?configuredStructuralValidators:[]),
  ...(crmSummary?crmSummaryStructuralValidators:[]),
 ]
 const fired=Object.entries(triggers).filter(([key,trigger])=>trigger.class==='fires'&&(trigger.events.includes('insert')||restoredByUpdate.has(key.split('.')[0])))
 const verdict=key=>originValidatorTriggers.includes(key)?'origin':originValidators.includes(bodies.get(key).proname)?'origin'
  :structural.includes(bodies.get(key).proname)?'structural':null
 const unreviewed=fired.filter(([key])=>!verdict(key)).map(([key])=>key+' '+bodies.get(key).proname)
 if(unreviewed.length)throw Error('portable_roster_unreviewed_validator: '+unreviewed.join(', '))
 const usedFunctions=new Set(fired.map(([key])=>bodies.get(key).proname))
 for(const name of [...originValidators,...structural])if(!usedFunctions.has(name))throw Error('portable_roster_validator_review_stale: '+name)
 for(const key of originValidatorTriggers)if(!fired.some(([other])=>other===key))throw Error('portable_roster_validator_review_stale: '+key)
 const validatorReads={}
 for(const [key,trigger] of fired){
  if(verdict(key)==='origin'){trigger.class='suspended:origin-validator';continue}
  // Deferred constraint triggers run once against the complete restored set, and
  // UPDATE-only triggers fire only on fixups after every table is imported.
  if(bodies.get(key).deferrable||!trigger.events.includes('insert'))continue
  const table=key.split('.')[0]
  // The transfer projection passes NULL seal fields to the INSERT branch; no
  // origin transaction or destination is consulted when this guard fires.
  if(bodies.get(key).proname==='protect_configured_task_receipt'&&table==='episode_extraction_items')continue
  const branches=validatorBranchReads[bodies.get(key).proname]
  if(branches&&Object.keys(branches).length&&!branches[table])throw Error('portable_roster_validator_review_stale: '+key)
  for(const read of branches?branches[table]??[]:tablesReadBy(bodies.get(key).prosrc))if(read!==table&&['durable','rebound'].includes(tables[read]?.class))(validatorReads[table]??=new Set()).add(read)
 }
 const validatorOrder=Object.entries(validatorReads).sort(([a],[b])=>a<b?-1:1).map(([table,reads])=>({table,reads:[...reads].sort()}))
 const ordering=references.filter(edge=>!edge.deferrable&&!deferredReferences.some(item=>item.table===edge.child&&item.constraint===edge.conname)
  &&['durable','rebound'].includes(tables[edge.child]?.class)&&['durable','rebound'].includes(tables[edge.parent]?.class))
  .concat(validatorOrder.flatMap(({table,reads})=>reads.map(parent=>({child:table,parent}))))
 for(const {table,reads} of validatorOrder)if(!tables[table].importLate&&reads.some(read=>tables[read].importLate))throw Error('portable_roster_validator_reads_late_table: '+table)
 const cycles=stronglyConnected(ordering)
 if(cycles.length){const members=new Set(cycles.flat());throw Error('portable_roster_validator_order_cycle: '+JSON.stringify(cycles)+' edges '+JSON.stringify(fired.filter(([key])=>members.has(key.split('.')[0])&&verdict(key)==='structural'&&!bodies.get(key).deferrable).map(([key])=>[key,tablesReadBy(bodies.get(key).prosrc).filter(read=>members.has(read)&&read!==key.split('.')[0])]).filter(([,reads])=>reads.length)))}
 // A suspension that makes any native contract root false is not allowed.
 for(const [key,trigger] of Object.entries(triggers))if(trigger.class.startsWith('suspended')){
  const [table,name]=key.split('.')
  await client.query('BEGIN')
  try{
   await client.query(`ALTER TABLE public."${table}" DISABLE TRIGGER "${name}"`)
   const roots=(await client.query(`SELECT ${contractRoots.map((root,index)=>root+' IS TRUE r'+index).join(',')}`)).rows[0]
   if(Object.values(roots).some(value=>value!==true)){
    // Firing an origin stamp would overwrite archived values; it needs its own reviewed window.
    if(trigger.class==='suspended:origin-stamp')throw Error('portable_roster_origin_stamp_contract_bound: '+key)
    if(trigger.class==='suspended:restoration-placeholder')throw Error('portable_roster_placeholder_contract_bound: '+key)
    // A contract-bound origin validator gets the creation-currency window: off only while its own table imports.
    trigger.class=['suspended:creation-currency','suspended:origin-validator'].includes(trigger.class)?'suspended:contract-window':'fires:contract-bound'
   }
  }finally{await client.query('ROLLBACK')}
 }
 const baseline=(await client.query(`SELECT ${contractRoots.map((root,index)=>root+' IS TRUE r'+index).join(',')}`)).rows[0]
 if(Object.values(baseline).some(value=>value!==true))throw Error('portable_roster_contract_roots_not_current')
 const roster={format:1,status:'reviewed contract; fail closed on any unknown table, sequence, trigger, policy or reference',
  inventory:{sourceCompilationManifestSha256:inventory.sourceCompilationManifestSha256,trustedRuntimeArtifact:inventory.trustedRuntimeArtifact,ledgerCount:ledger.length,ledgerHead:ledger.at(-1)},
  // Only the rules this chain's tables use (a release cohort predates later rules).
  rules:Object.fromEntries(Object.entries(rosterRules).filter(([rule])=>Object.values(tables).some(entry=>entry.rule===rule))),
  sequenceRule,triggerRules,reviewedWriterHelpers:writerHelpers,creationCurrencyGuards,originStamps:[...activeOriginStamps],fixpointStamps:[...fixpointStamps],
  originValidators:[...originValidators],originValidatorTriggers:[...originValidatorTriggers],structuralValidators:[...structural],contractRoots,inventoryOverrides:rederivedRule,
  counts:summarize(tables,sequences,triggers,deferredReferences),tables,sequences,triggers,deferredReferences,validatorOrder}
 return roster
}

function summarize(tables,sequences,triggers,deferredReferences){
 const values=Object.values(tables),count=predicate=>values.filter(predicate).length
 const triggerValues=Object.values(triggers)
 return{tables:values.length,durable:count(t=>t.class==='durable'),derived:count(t=>t.class==='derived'),rebound:count(t=>t.class==='rebound'),
  rederived:count(t=>t.class==='rederived'),durableOrRebound:count(t=>t.class==='durable'||t.class==='rebound'),regprocedureSlots:values.reduce((n,t)=>n+(t.slots?.length??0),0),
  forceRls:count(t=>t.forceRls),seededTables:count(t=>t.seeded),generatedTables:count(t=>t.generated),identityTables:count(t=>t.identity),
  authorityEpochTables:count(t=>t.rule==='F2-authority-epoch'),transactionBoundTables:count(t=>t.transactionBound),
  sequences:Object.keys(sequences).length,triggers:triggerValues.length,
  suspendedTriggers:triggerValues.filter(t=>t.class.startsWith('suspended')).length,deferredReferences:deferredReferences.length}
}

// Deterministic: inside each cycle, order members by the references that cannot
// be NULL (they must be acyclic), ties by inbound reference count then name.
// Every nullable reference pointing to a later member is deferred.
export function chooseDeferredReferences(edges){
 const inbound=new Map()
 for(const edge of edges)inbound.set(edge.parent,(inbound.get(edge.parent)??0)+1)
 const compare=(a,b)=>(inbound.get(b)??0)-(inbound.get(a)??0)||(a<b?-1:a>b?1:0)
 const deferred=[]
 for(const component of stronglyConnected(edges)){
  const members=new Set(component),inside=edges.filter(edge=>members.has(edge.child)&&members.has(edge.parent))
  const required=inside.filter(edge=>!edge.nullable.some(Boolean)),order=[],placed=new Set()
  while(order.length<component.length){
   const ready=component.filter(name=>!placed.has(name)&&required.every(edge=>edge.child!==name||placed.has(edge.parent))).sort(compare)
   if(!ready.length)throw Error('portable_roster_unbreakable_reference_cycle: '+JSON.stringify(component))
   order.push(ready[0]);placed.add(ready[0])
  }
  const position=new Map(order.map((name,index)=>[name,index]))
  for(const edge of inside)if(position.get(edge.parent)>position.get(edge.child)){
   // MATCH SIMPLE skips a reference with any NULL column. Prefer nullable
   // columns that no other reference of the same table uses.
   const nullable=edge.columns.filter((_,index)=>edge.nullable[index])
   const shared=new Set(edges.filter(other=>other!==edge&&other.child===edge.child).flatMap(other=>other.columns))
   const own=nullable.filter(column=>!shared.has(column))
   deferred.push({table:edge.child,constraint:edge.conname,parent:edge.parent,columns:own.length?own:nullable})
  }
 }
 const remaining=edges.filter(edge=>!deferred.some(item=>item.constraint===edge.conname&&item.table===edge.child))
 if(stronglyConnected(remaining).length)throw Error('portable_roster_unbreakable_reference_cycle')
 return deferred.sort((a,b)=>(a.table+a.constraint).localeCompare(b.table+b.constraint))
}
export function stronglyConnected(edges){
 const graph=new Map()
 for(const edge of edges){if(!graph.has(edge.child))graph.set(edge.child,new Set());if(!graph.has(edge.parent))graph.set(edge.parent,new Set());graph.get(edge.child).add(edge.parent)}
 let index=0;const indexes=new Map(),low=new Map(),stack=[],on=new Set(),out=[]
 const visit=node=>{
  indexes.set(node,index);low.set(node,index);index++;stack.push(node);on.add(node)
  for(const next of graph.get(node)){
   if(!indexes.has(next)){visit(next);low.set(node,Math.min(low.get(node),low.get(next)))}
   else if(on.has(next))low.set(node,Math.min(low.get(node),indexes.get(next)))
  }
  if(low.get(node)===indexes.get(node)){const component=[];let member;do{member=stack.pop();on.delete(member);component.push(member)}while(member!==node);if(component.length>1)out.push(component.sort())}
 }
 for(const node of [...graph.keys()].sort())if(!indexes.has(node))visit(node)
 return out
}

/** Reviewable per-table roster for the platform spec, rendered from the committed JSON. */
export function renderRosterMarkdown(roster){
 const lines=['| Table | Class | Rule | Import notes |','| --- | --- | --- | --- |']
 for(const [name,entry] of Object.entries(roster.tables).sort(([a],[b])=>a<b?-1:a>b?1:0)){
  const notes=[entry.slots&&'slots: '+entry.slots.join(', '),entry.seeded&&'shipped seed',entry.seedReplaceKey&&'seed replaced by '+entry.seedReplaceKey.join(','),
   entry.forceRls&&'FORCE RLS ('+entry.forceRls.access+')',entry.generated&&'generated: '+entry.generated.join(', '),entry.identity&&'identity: '+entry.identity.join(', '),
   entry.transactionBound&&'transaction-bound: '+entry.transactionBound.join(', '),entry.importLate&&'imported last'].filter(Boolean).join('; ')
  lines.push(`| \`${name}\` | ${entry.class} | ${entry.rule} | ${notes} |`)
 }
 return lines.join('\n')+'\n'
}

async function main(){
 const {values}=parseArgs({options:{inventory:{type:'string'},check:{type:'boolean'},markdown:{type:'string'},cohort:{type:'string'}}})
 if(values.markdown){
  const roster=JSON.parse(await readFile(rosterPath,'utf8')),start='<!-- portable-roster:start -->',end='<!-- portable-roster:end -->'
  const doc=await readFile(values.markdown,'utf8'),from=doc.indexOf(start),to=doc.indexOf(end)
  if(from<0||to<from)throw Error('portable_roster_markdown_markers_missing')
  const next=doc.slice(0,from+start.length)+'\n'+renderRosterMarkdown(roster)+doc.slice(to)
  if(values.check){if(next!==doc)throw Error('portable_roster_markdown_stale');console.log('portable restore roster markdown is current')}
  else await writeFile(values.markdown,next)
  return
 }
 if(!values.inventory)throw Error('An explicit --inventory path is required')
 const {assertLocalFixture}=await import(new URL('../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
 await assertLocalFixture()
 const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect()
 try{
  if(values.cohort!==undefined&&!cohortRosters[values.cohort])throw Error('portable_roster_cohort_unknown: '+values.cohort)
  const target=values.cohort===undefined?rosterPath:here+cohortRosters[values.cohort]
  const roster=await buildRoster(client,JSON.parse(await readFile(values.inventory,'utf8')))
  if(values.cohort!==undefined&&roster.inventory.ledgerHead!==values.cohort)throw Error('portable_roster_cohort_head_mismatch: '+roster.inventory.ledgerHead)
  const text=JSON.stringify(roster,null,1)+'\n'
  if(values.check){if(await readFile(target,'utf8')!==text)throw Error('portable_roster_stale');console.log('portable restore roster is current: '+target.slice(here.length))}
  else{await writeFile(target,text);console.log(JSON.stringify(roster.counts))}
 }finally{await client.end()}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main().catch(error=>{console.error(error.message);process.exitCode=1})
