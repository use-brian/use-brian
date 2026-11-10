import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { orderMigrationFiles } from '../migration-order.js'
import { findAppliedMigrationRenames, previousMigrationNames } from '../../src/migrations/renames.js'

describe('[COMP:api/migration-order] Migration filename compatibility', () => {
  it('preserves each released collision without skipping its same-number neighbour', () => {
    const pairs = [["557_association_membership_catalogue.sql", "5570_association_membership_catalogue.sql"], ["561_association_site_content.sql", "5610_association_site_content.sql"], ["563_department_scope_evidence.sql", "5630_department_scope_evidence.sql"], ["564_crm_intake_existing_or_new.sql", "5640_crm_intake_existing_or_new.sql"], ["8146_explicit_unclassified_legacy_erasure.sql", "81460_explicit_unclassified_legacy_erasure.sql"], ["8147_private_chat_recovery.sql", "81470_private_chat_recovery.sql"]]
    for (const [previousName, currentName] of pairs) {
      expect(findAppliedMigrationRenames(new Set([previousName]))).toEqual([{ previousName, currentName }])
      expect(findAppliedMigrationRenames(new Set([previousName, currentName]))).toEqual([])
      expect(findAppliedMigrationRenames(new Set([currentName]))).toEqual([])
    }
    const neighbours = ['557_structured_document_extractions.sql', '561_workflow_channel_questions.sql', '563_telegram_discussion_context.sql', '564_scoped_memory_summaries.sql', '8146_native_transcript_crm_event_inputs.sql', '8147_selected_department_erasure.sql']
    for(const [index,[,currentName]] of pairs.entries()) {
      expect(orderMigrationFiles([{dir:'open',files:[neighbours[index],currentName]}]).map(row=>row.file)).toEqual([currentName,neighbours[index]])
    }
    expect(findAppliedMigrationRenames(new Set(['557_structured_document_extractions.sql', '561_workflow_channel_questions.sql', '563_telegram_discussion_context.sql', '564_scoped_memory_summaries.sql', '8146_native_transcript_crm_event_inputs.sql', '8147_selected_department_erasure.sql']))).toEqual([])
  })

  it('preserves every external ledger spelling without skipping provenance or Telegram recovery', () => {
    const renames = [
      { previousName: '8240_external_human_approvals.sql', currentName: '8252_external_human_approvals.sql' },
      { previousName: '8241_external_human_approvals.sql', currentName: '8252_external_human_approvals.sql' },
      { previousName: '8241_workspace_external_approval_sources.sql', currentName: '8253_workspace_external_approval_sources.sql' },
      { previousName: '8242_workspace_external_approval_sources.sql', currentName: '8253_workspace_external_approval_sources.sql' },
      { previousName: '8243_external_approval_web_chat_destination.sql', currentName: '8254_external_approval_web_chat_destination.sql' },
      { previousName: '8244_external_approval_conversation_members.sql', currentName: '8255_external_approval_conversation_members.sql' },
      { previousName: '8245_external_human_question_answers.sql', currentName: '8256_external_human_question_answers.sql' },
      { previousName: '8242_external_human_approvals.sql', currentName: '8252_external_human_approvals.sql' },
      { previousName: '8243_workspace_external_approval_sources.sql', currentName: '8253_workspace_external_approval_sources.sql' },
      { previousName: '8244_external_approval_web_chat_destination.sql', currentName: '8254_external_approval_web_chat_destination.sql' },
      { previousName: '8245_external_approval_conversation_members.sql', currentName: '8255_external_approval_conversation_members.sql' },
      { previousName: '8246_external_human_question_answers.sql', currentName: '8256_external_human_question_answers.sql' },
    ]
    const neighbours = ['8240_channel_connection_provenance.sql', '8241_telegram_recording_history_recovery.sql', '8242_native_empty_annotation_lookup.sql', '8243_active_work_recording_native_proof.sql', '8244_native_mixed_field_dependencies.sql', '8245_native_current_field_planning.sql', '8246_native_private_memory_empty_domain.sql']
    const canonical = [...new Set(renames.map(row => row.currentName))]
    expect(findAppliedMigrationRenames(new Set(neighbours))).toEqual([])
    expect(findAppliedMigrationRenames(new Set([...neighbours, ...renames.map(row => row.previousName)]))).toEqual(renames)
    expect(findAppliedMigrationRenames(new Set([...neighbours, ...renames.flatMap(row => [row.previousName, row.currentName])]))).toEqual([])
    for (const { previousName, currentName } of renames) {
      expect(findAppliedMigrationRenames(new Set([previousName]))).toEqual([{ previousName, currentName }])
      expect(previousMigrationNames(currentName)).toContain(previousName)
      expect(findAppliedMigrationRenames(new Set([previousName, currentName]))).toEqual([])
    }
    expect(findAppliedMigrationRenames(new Set(canonical))).toEqual([])
    expect(orderMigrationFiles([{ dir: 'open', files: [...canonical].reverse().concat(neighbours) }]).map(row => row.file))
      .toEqual([...neighbours, ...canonical])

    // Check the real checkout too, so a future develop collision fails here.
    const files = readdirSync(new URL('../../migrations/', import.meta.url))
    for (const currentName of canonical) {
      expect(files.filter(file => file.startsWith(`${currentName.split('_')[0]}_`))).toEqual([currentName])
    }
  })

  it('preserves applied workspace attachments without skipping private transcript authority', () => {
    const previousName = '8231_workspace_file_attachments.sql'
    const currentName = '8233_workspace_file_attachments.sql'
    const transcriptAuthority = '8231_private_transcript_read_authority.sql'
    expect(findAppliedMigrationRenames(new Set([previousName, transcriptAuthority])))
      .toEqual([{ previousName, currentName }])
    expect(findAppliedMigrationRenames(new Set([transcriptAuthority]))).toEqual([])
    expect(findAppliedMigrationRenames(new Set([previousName, currentName, transcriptAuthority]))).toEqual([])
  })

  it('preserves staged Association financial evidence without confusing the saved-page repair', () => {
    const previousName = '537_association_order_financial_evidence.sql'
    const currentName = '552_association_order_financial_evidence.sql'
    const pageRepair = '537_saved_views_scope_guc_casts.sql'
    expect(findAppliedMigrationRenames(new Set([previousName, pageRepair])))
      .toEqual([{ previousName, currentName }])
    expect(findAppliedMigrationRenames(new Set([pageRepair]))).toEqual([])
    expect(findAppliedMigrationRenames(new Set([previousName, currentName, pageRepair]))).toEqual([])
  })

  it('preserves the applied member operation floor beside the external app records it collided with', () => {
    const previousName = '611_member_operation_floor_per_statement.sql'
    const currentName = '615_member_operation_floor_per_statement.sql'
    const externalRecords = '611_external_app_records.sql'
    expect(findAppliedMigrationRenames(new Set([previousName, externalRecords])))
      .toEqual([{ previousName, currentName }])
    expect(findAppliedMigrationRenames(new Set([externalRecords]))).toEqual([])
    expect(findAppliedMigrationRenames(new Set([previousName, currentName]))).toEqual([])
  })

  it('preserves the applied file ingest bookkeeping fix beside the session turn assistant it collided with', () => {
    const previousName = '752_file_ingest_bookkeeping_not_semantic.sql'
    const currentName = '771_file_ingest_bookkeeping_not_semantic.sql'
    const sessionTurnAssistant = '752_session_turn_assistant.sql'
    expect(findAppliedMigrationRenames(new Set([previousName, sessionTurnAssistant])))
      .toEqual([{ previousName, currentName }])
    expect(findAppliedMigrationRenames(new Set([sessionTurnAssistant]))).toEqual([])
    expect(findAppliedMigrationRenames(new Set([previousName, currentName]))).toEqual([])
  })

  it('aliases applied migrations to their collision-free names', () => {
    const aliases = findAppliedMigrationRenames(
      new Set([
        '429_workspace_custom_llm_endpoints.sql',
        '394_office_artifacts.sql',
        '395_office_templates_resources.sql',
        '3943_office_collaboration.sql',
        '395_chat_message_archive.sql',
        '396_local_chat_archive_sink.sql',
        '397_chat_archive_enrichment.sql',
        '398_chat_archive_owner_cascade.sql',
      ]),
    )

    expect(aliases).toEqual([
      {
        previousName: '429_workspace_custom_llm_endpoints.sql',
        currentName: '434_workspace_custom_llm_endpoints.sql',
      },
      {
        previousName: '394_office_artifacts.sql',
        currentName: '3941_office_artifacts.sql',
      },
      {
        previousName: '395_office_templates_resources.sql',
        currentName: '3942_office_templates_resources.sql',
      },
      {
        previousName: '395_chat_message_archive.sql',
        currentName: '405_chat_message_archive.sql',
      },
      {
        previousName: '396_local_chat_archive_sink.sql',
        currentName: '406_local_chat_archive_sink.sql',
      },
      {
        previousName: '397_chat_archive_enrichment.sql',
        currentName: '407_chat_archive_enrichment.sql',
      },
      {
        previousName: '398_chat_archive_owner_cascade.sql',
        currentName: '408_chat_archive_owner_cascade.sql',
      },
    ])
  })

  it('preserves reviewed cutover upgrades without skipping same-number chat migrations', () => {
    const renames = [
      { previousName: '8148_department_mode_admission.sql', currentName: '8171_department_mode_admission.sql' },
      { previousName: '8149_organization_cutover.sql', currentName: '8172_organization_cutover.sql' },
      { previousName: '8150_department_office_publication.sql', currentName: '8173_department_office_publication.sql' },
      { previousName: '8151_reviewed_legacy_knowledge_binding.sql', currentName: '8174_reviewed_legacy_knowledge_binding.sql' },
    ]
    const chatNames = [
      '8148_native_chat_read_frame.sql',
      '8149_existing_workspace_policy_epochs.sql',
      '8150_native_file_session_evidence.sql',
      '8151_native_file_session_title.sql',
    ]
    expect(findAppliedMigrationRenames(new Set(chatNames))).toEqual([])
    expect(findAppliedMigrationRenames(new Set([...chatNames, ...renames.map(r => r.previousName)]))).toEqual(renames)
    expect(findAppliedMigrationRenames(new Set(renames.flatMap(r => [r.previousName, r.currentName])))).toEqual([])
  })
})
