/**
 * Historical migration renames whose original filenames may already be in
 * production's _migrations table. Keep these aliases permanently: recording
 * both names lets old and new releases safely skip the same migration.
 */
const migrationRenames = [
  ['393_chat_message_archive.sql', '405_chat_message_archive.sql'],
  ['394_local_chat_archive_sink.sql', '406_local_chat_archive_sink.sql'],
  ['395_chat_archive_enrichment.sql', '407_chat_archive_enrichment.sql'],
  ['396_chat_archive_owner_cascade.sql', '408_chat_archive_owner_cascade.sql'],
  ['402_chat_archive_media.sql', '409_chat_archive_media.sql'],
  ['557_association_membership_catalogue.sql', '5570_association_membership_catalogue.sql'],
  ['561_association_site_content.sql', '5610_association_site_content.sql'],
  ['563_department_scope_evidence.sql', '5630_department_scope_evidence.sql'],
  ['564_crm_intake_existing_or_new.sql', '5640_crm_intake_existing_or_new.sql'],
  ['8146_explicit_unclassified_legacy_erasure.sql', '81460_explicit_unclassified_legacy_erasure.sql'],
  ['8147_private_chat_recovery.sql', '81470_private_chat_recovery.sql'],

  // Resolve every released spelling directly to its final name: embedded
  // migration lookup intentionally does not follow transitive rename chains.
  ['8240_external_human_approvals.sql', '8242_external_human_approvals.sql'],
  ['8241_external_human_approvals.sql', '8242_external_human_approvals.sql'],
  ['8241_workspace_external_approval_sources.sql', '8243_workspace_external_approval_sources.sql'],
  ['8242_workspace_external_approval_sources.sql', '8243_workspace_external_approval_sources.sql'],
  ['8243_external_approval_web_chat_destination.sql', '8244_external_approval_web_chat_destination.sql'],
  ['8244_external_approval_conversation_members.sql', '8245_external_approval_conversation_members.sql'],
  ['8245_external_human_question_answers.sql', '8246_external_human_question_answers.sql'],
  ['8231_workspace_file_attachments.sql', '8233_workspace_file_attachments.sql'],
  ['8148_department_mode_admission.sql', '8171_department_mode_admission.sql'],
  ['8149_organization_cutover.sql', '8172_organization_cutover.sql'],
  ['8150_department_office_publication.sql', '8173_department_office_publication.sql'],
  ['8151_reviewed_legacy_knowledge_binding.sql', '8174_reviewed_legacy_knowledge_binding.sql'],
  ['752_file_ingest_bookkeeping_not_semantic.sql', '771_file_ingest_bookkeeping_not_semantic.sql'],
  ['611_member_operation_floor_per_statement.sql', '615_member_operation_floor_per_statement.sql'],
  ['537_association_order_financial_evidence.sql', '552_association_order_financial_evidence.sql'],
  ['429_workspace_custom_llm_endpoints.sql', '434_workspace_custom_llm_endpoints.sql'],
  ['394_office_artifacts.sql', '3941_office_artifacts.sql'],
  ['395_office_templates_resources.sql', '3942_office_templates_resources.sql'],
  ['396_office_collaboration.sql', '3943_office_collaboration.sql'],
  ['397_office_generation_release.sql', '3944_office_generation_release.sql'],
  ['398_retire_workspace_decks.sql', '3945_retire_workspace_decks.sql'],
  ['395_chat_message_archive.sql', '405_chat_message_archive.sql'],
  ['396_local_chat_archive_sink.sql', '406_local_chat_archive_sink.sql'],
  ['397_chat_archive_enrichment.sql', '407_chat_archive_enrichment.sql'],
  ['398_chat_archive_owner_cascade.sql', '408_chat_archive_owner_cascade.sql'],
] as const

type AppliedMigrationRename = {
  previousName: string
  currentName: string
}

export function findAppliedMigrationRenames(
  applied: ReadonlySet<string>,
): AppliedMigrationRename[] {
  return migrationRenames
    .filter(([previousName, currentName]) => applied.has(previousName) && !applied.has(currentName))
    .map(([previousName, currentName]) => ({ previousName, currentName }))
}

/** All exact prior spellings for a canonical filename, never numeric-prefix matching. */
export function previousMigrationNames(currentName: string): readonly string[] {
  return migrationRenames.filter(([, current]) => current === currentName).map(([previous]) => previous)
}
