/**
 * Historical migration renames whose original filenames may already be in
 * production's _migrations table. Keep these aliases permanently: recording
 * both names lets old and new releases safely skip the same migration.
 */
const migrationRenames = [
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

export type AppliedMigrationRename = {
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
