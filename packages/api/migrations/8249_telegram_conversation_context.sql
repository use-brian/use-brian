-- [COMP:api/telegram-conversation-context] Admit new shared conversation rooms without releasing held recordings.
BEGIN;
-- Authenticate the existing kernel before extending its empty-domain profile.
DO $transcript_contract$
DECLARE signature text; ok boolean;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'telegram_context_dependency_changed: %',signature;END IF;
 END LOOP;
END $transcript_contract$;
CREATE TEMP TABLE pg_temp.telegram_context_originals ON COMMIT DROP AS
 SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p)-'prosrc' metadata,
 p.prosrc body,p.prosrc expected_body,quote_literal(p.prosrc) quoted_body,
 encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint,
 encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash,p.prosrc initial_body
 FROM pg_proc p WHERE p.oid::regprocedure::text=ANY(ARRAY['read_native_session_field_dependencies(uuid,text[],uuid[],text[])','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','agent_mutation_scope_allows(text[])','agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','application_current_field_snapshot(uuid,uuid)','application_empty_query_facades_current()','application_empty_query_helpers_current()','application_empty_query_worklist_current(uuid,jsonb)','application_empty_query_worklist_reset(jsonb)','application_field_digest(jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','application_field_resource_uuid(text)','application_materialize_field_envelope(uuid,jsonb,integer)','application_memory_field_keys()','application_memory_field_state(uuid,uuid,text[])','application_memory_field_state_before_successor(uuid,uuid,text[])','application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','application_memory_history_status(uuid,uuid,text)','application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','application_memory_query_context(uuid)','application_memory_query_domain_state(uuid,uuid,text[])','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','application_memory_statement_state(uuid,uuid,text[],jsonb)','application_native_catalog_port_valid(regprocedure)','application_native_context_fields_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','application_native_dependency_batch_helpers_current()','application_native_field_catalog_for(uuid,jsonb,text)','application_native_field_contract_before_catalog(uuid,jsonb,text,text)','application_native_field_contract_for(uuid,jsonb,text,text)','application_native_field_reference_helpers_current()','application_native_field_rule_allows(jsonb,text[])','application_native_file_capture_helpers_current()','application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_record_port_valid(regprocedure)','application_native_root_cover(uuid,jsonb)','application_native_same_destination(uuid,text,uuid,text,uuid)','application_native_session_query_acquisition_current()','application_native_source_edges_dispatch(uuid,text,uuid,text)','application_native_title_acquisition_helpers_current()','application_native_title_group_helpers_current()','application_native_transcript_prepare_helpers_current()','application_native_worklist_helpers_current()','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_admits_point(jsonb,jsonb)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_escape(jsonb[],integer,text[],text[],text[],integer)','application_query_scope_intersection(jsonb,jsonb)','application_query_scope_union_contains(jsonb,jsonb,integer)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_reader_envelope_visible(uuid,jsonb)','application_recorded_field_root_capture(uuid,uuid,text,integer)','application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','application_scope_lineage(uuid,text[],uuid[],text[])','application_scope_source_edges(uuid,text,uuid,text)','application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','application_session_eval_domain(uuid,text,uuid,text[],jsonb)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','application_session_eval_field(uuid,uuid,text,jsonb)','application_session_eval_point_state(uuid,text,uuid,text[],jsonb)','application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','application_session_eval_scope(uuid,text,uuid,text,jsonb)','application_session_eval_scope_current(uuid,text,uuid,text,jsonb)','application_session_field_keys(text)','application_session_query_bounds(uuid,jsonb)','application_session_query_parent(uuid,uuid)','application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)','assistant_placement_visible(uuid,uuid)','capture_native_session_projection_batch(uuid,uuid,integer,text)','capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)','crm_capture_erasure_effect()','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','external_source_snapshot(uuid,uuid)','guard_application_field_lineage()','guard_external_source_derivation()','guard_page_derivation_receipts()','guard_session_context_lineage()','guard_session_recording_privacy()','guard_workflow_derivation_receipts()','knowledge_version_source_edges(uuid,text,uuid,text)','legacy_assistant_team_compartments(uuid)','lock_native_session_context_publication(uuid,uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','native_detached_eval_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_detached_eval_field(uuid,uuid,text,jsonb,jsonb)','native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_detached_eval_scope(uuid,text,uuid,text,jsonb,jsonb)','native_detached_lineage(uuid,text[],uuid[],text[],jsonb)','native_detached_snapshot(uuid,text,uuid,text,jsonb)','native_personal_title_group_acquisition(uuid,uuid[],uuid[])','native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_context()','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_event_frame(uuid,uuid)','native_turn_field_reference(uuid,uuid,uuid,text)','native_turn_frame_immutable()','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_key(jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_page_event(jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_privacy_edges(uuid,jsonb)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','native_turn_validate_frame_pair()','native_worklist_context(uuid,jsonb)','native_worklist_current(uuid,text,uuid,jsonb)','native_worklist_current_application_sources(uuid,text,uuid,jsonb)','native_worklist_current_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_current_persistent_context(uuid,text,uuid,jsonb)','native_worklist_current_public_share(uuid,text,uuid,jsonb)','native_worklist_edges(uuid,jsonb)','native_worklist_eval_domain(uuid,text,uuid,text[],jsonb)','native_worklist_eval_envelope(uuid,text,uuid,text,text[],jsonb)','native_worklist_eval_field(uuid,uuid,text,jsonb)','native_worklist_eval_point_state(uuid,text,uuid,text[],jsonb)','native_worklist_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','native_worklist_eval_scope(uuid,text,uuid,text,jsonb)','native_worklist_frame_current(uuid,jsonb)','native_worklist_lineage(uuid,text[],uuid[],text[],jsonb)','native_worklist_page_dependencies(uuid,text,uuid,text,jsonb)','native_worklist_seed(uuid,jsonb)','native_worklist_snapshot(uuid,text,uuid,text,jsonb)','native_worklist_source(uuid,text,uuid,jsonb)','native_worklist_source_application_fields(uuid,text,uuid,jsonb)','native_worklist_source_blueprint(uuid,text,uuid,jsonb)','native_worklist_source_browser_profile(uuid,text,uuid,jsonb)','native_worklist_source_browser_session(uuid,text,uuid,jsonb)','native_worklist_source_capture(uuid,text,uuid,jsonb)','native_worklist_source_conversation(uuid,text,uuid,jsonb)','native_worklist_source_engineering_archive(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_source_parent(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_source_memory_successor(uuid,text,uuid,jsonb)','native_worklist_source_page(uuid,text,uuid,jsonb)','native_worklist_source_persistent_context(uuid,text,uuid,jsonb)','native_worklist_source_primitive_v2(uuid,text,uuid,jsonb)','native_worklist_source_recordings(uuid,text,uuid,jsonb)','native_worklist_source_workflow_run(uuid,text,uuid,jsonb)','observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','project_labels_allowed(jsonb,uuid,text[],boolean)','project_member_live(uuid,text,uuid)','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_admitted_native_scope_snapshot(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','read_application_field_dependencies(uuid,text[],uuid[],text[])','read_entity_derivation_source(uuid,text,uuid)','read_entity_derivation_source_before_application_fields(uuid,text,uuid)','read_entity_derivation_source_before_blueprint(uuid,text,uuid)','read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','read_entity_derivation_source_before_browser_session(uuid,text,uuid)','read_entity_derivation_source_before_capture(uuid,text,uuid)','read_entity_derivation_source_before_conversation(uuid,text,uuid)','read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','read_entity_derivation_source_before_page(uuid,text,uuid)','read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','read_entity_derivation_source_before_recordings(uuid,text,uuid)','read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])','read_media_parent_snapshot(uuid,text,uuid)','read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','read_media_parent_snapshot_before_conversation(uuid,text,uuid)','read_media_parent_snapshot_before_page(uuid,text,uuid)','read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)','read_native_application_session_topics(uuid,uuid,integer)','read_native_attended_memory_evidence(uuid,text[],uuid[],text[])','read_native_context_field_currents(uuid,jsonb)','read_native_covered_memory_frame(uuid,text[],uuid[],text[],boolean)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_covered_session_frame(uuid,text[],uuid[],text[])','read_native_empty_query_evidence(uuid,text[],uuid[],text[])','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_field_snapshots(uuid,uuid[],text[])','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_file_worklist_evidence(uuid,text[],uuid[],text[],boolean,boolean)','read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_personal_title_group(uuid,uuid[],uuid[])','read_native_personal_title_group_evidence(uuid,uuid[],uuid[])','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_field_snapshots(uuid,uuid[],text[])','read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_session_query_evidence(uuid,uuid,integer,integer)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_resource_page_dependencies(uuid,text,uuid,text)','read_scope_source(uuid,text,uuid)','read_scope_source_before_application_fields(uuid,text,uuid)','read_scope_source_before_browser_profile(uuid,text,uuid)','read_scope_source_before_browser_session(uuid,text,uuid)','read_scope_source_before_external(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','read_scope_source_before_page(uuid,text,uuid)','read_scope_source_before_persistent_context(uuid,text,uuid)','read_scope_source_before_routines(uuid,text,uuid)','read_scope_source_before_workflow_run(uuid,text,uuid)','read_session_context_empty_query_revision(uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_revision(uuid,uuid)','read_session_title_revision(uuid,uuid,uuid)','recording_source_read_allowed(uuid,text,uuid)','refuse_quarantined_recording_message()','scope_review_state_held(text,uuid)','scope_source_ancestors(uuid,text,uuid)','scope_source_ancestors_before_browser_profile(uuid,text,uuid)','scope_source_ancestors_before_browser_session(uuid,text,uuid)','scope_source_ancestors_before_workflow_run(uuid,text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','scope_source_table_before_media(text)','scope_source_table_before_persistent_context(text)','sensitivity_rank(text)','session_context_empty_query_revision_allowed(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_parent_snapshot(uuid,uuid)','session_context_payload_shape(text,jsonb)','session_context_revision_allowed(uuid,uuid)','session_context_revision_native(uuid,uuid)','session_context_revision_snapshot(uuid,uuid)','session_personal_audience(sessions)','session_project_audience(sessions,boolean)','session_recording_read_allowed(uuid)','session_workspace_audience(sessions)','validate_application_field_dependencies()','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_session_context_revision_pair()','validate_workflow_derivation_dependencies()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]);

ALTER TABLE sessions ADD COLUMN provider_conversation_context boolean NOT NULL DEFAULT false,
 ADD COLUMN provider_context_identity jsonb,
 ADD COLUMN provider_context_generation integer;
DROP INDEX sessions_channel_room_key;
CREATE UNIQUE INDEX sessions_channel_room_key ON sessions(workspace_id,channel_type,channel_id)
 WHERE visibility='workspace' AND anchor_kind='channel' AND recording_revision IS NULL AND NOT recording_privacy_held AND archived_at IS NULL;
DO $context_patch$
DECLARE routine pg_proc;original text;successor constant text:=$context_body$
DECLARE receipt jsonb; admitted boolean; origin jsonb; renewal boolean:=false;
BEGIN
 IF TG_OP='UPDATE' AND OLD.recording_privacy_held AND NOT NEW.recording_privacy_held THEN
  RAISE EXCEPTION 'recording_privacy_review_required' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.provider_conversation_context IS DISTINCT FROM NEW.provider_conversation_context
   OR OLD.provider_context_identity IS DISTINCT FROM NEW.provider_context_identity) THEN
  RAISE EXCEPTION 'provider_context_identity_immutable' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' THEN renewal:=OLD.provider_context_generation IS DISTINCT FROM NEW.provider_context_generation;END IF;
 IF NOT NEW.provider_conversation_context AND (NEW.provider_context_identity IS NOT NULL OR NEW.provider_context_generation IS NOT NULL) THEN
  RAISE EXCEPTION 'provider_context_identity_invalid' USING ERRCODE='42501';END IF;
 IF NEW.provider_conversation_context THEN
  IF NEW.visibility<>'workspace' OR NEW.channel_type<>'telegram' OR NEW.anchor_kind<>'channel'
   OR NEW.anchor_ref IS DISTINCT FROM NEW.channel_id OR NEW.channel_id !~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$'
   OR NEW.recording_revision IS NOT NULL OR NEW.recording_policy_id IS NOT NULL
   OR jsonb_typeof(NEW.provider_context_identity) IS DISTINCT FROM 'object'
   OR NEW.provider_context_generation IS NULL OR NEW.provider_context_generation<0 THEN
   RAISE EXCEPTION 'provider_context_identity_invalid' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' OR renewal THEN
   receipt:=nullif(current_setting('app.provider_conversation_context_admission',true),'')::jsonb;
   PERFORM set_config('app.provider_conversation_context_admission','',true);
   IF (TG_OP='INSERT' AND NEW.room_capture) OR receipt IS DISTINCT FROM jsonb_build_object('version',1,'sessionId',NEW.id,
     'workspaceId',NEW.workspace_id,'assistantId',NEW.assistant_id,'actorUserId',NEW.user_id,
     'channelId',NEW.channel_id,'identity',NEW.provider_context_identity,'generation',NEW.provider_context_generation,
     'clearance',NEW.effective_clearance,'compartments',to_jsonb(NEW.context_compartments),
     'projectId',NEW.context_project_id) THEN
    RAISE EXCEPTION 'provider_context_admission_required' USING ERRCODE='42501';
   END IF;
  END IF;
  -- Lease cleanup and retained web display remain possible after revocation.
  -- Every input, history/model read and provider send positively renews this
  -- same metadata gate through app.provider_conversation_context_check.
  IF TG_OP='INSERT' OR renewal OR current_setting('app.provider_conversation_context_check',true)=NEW.id::text THEN
   origin:=NEW.provider_context_identity;
   SELECT coalesce(bool_and(valid),false) INTO admitted FROM (
    SELECT ci.status='active' AND c.status='active' AND c.workspace_id=NEW.workspace_id
     AND ci.channel_type='telegram' AND c.channel_type='telegram'
     AND ci.bot_user_id=origin->>'botId' AND ci.identity_generation=NEW.provider_context_generation
     AND a.workspace_id=NEW.workspace_id
     AND EXISTS(SELECT 1 FROM channel_assistants ca WHERE ca.channel_id=c.id AND ca.assistant_id=NEW.assistant_id
      AND (ca.external_surface_id IN(NEW.channel_id,split_part(NEW.channel_id,':',1)) OR ca.external_surface_id IS NULL))
     AND (TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM channel_recording_policies policy
      WHERE policy.workspace_id=NEW.workspace_id AND policy.bot_id=ci.bot_user_id AND policy.conversation_id=NEW.channel_id))
     AND NOT EXISTS(SELECT 1 FROM channel_recording_policies policy
      WHERE policy.workspace_id=NEW.workspace_id AND policy.bot_id=ci.bot_user_id
       AND policy.conversation_id=NEW.channel_id AND NOT policy.enabled)
     AND (EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(ci.config->'requireMentionOverrides','[]'::jsonb)) scope
       WHERE scope->>'chatId'=split_part(NEW.channel_id,':',1)
        AND (scope->>'topicId' IS NULL OR scope->>'topicId'=split_part(NEW.channel_id,':',3)))
      OR EXISTS(SELECT 1 FROM channel_assistants ca WHERE ca.channel_id=c.id
       AND ca.external_surface_id IN(NEW.channel_id,split_part(NEW.channel_id,':',1)))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(ci.config->'deliveryAudienceBindings','[]'::jsonb)) binding
       WHERE binding->>'channelId' IN(NEW.channel_id,split_part(NEW.channel_id,':',1))))
     AND NOT(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(ci.config->'requireMentionOverrides','[]'::jsonb)) scope
       WHERE scope->>'chatId'=split_part(NEW.channel_id,':',1))
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(ci.config->'requireMentionOverrides','[]'::jsonb)) scope
       WHERE scope->>'chatId'=split_part(NEW.channel_id,':',1)
        AND (scope->>'topicId' IS NULL OR scope->>'topicId'=split_part(NEW.channel_id,':',3))))
     AND audience.allowed AS valid
    FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
    JOIN assistants a ON a.id=NEW.assistant_id
    CROSS JOIN LATERAL(
     -- Same all-bot, parent-plus-topic intersection as canonical group delivery.
     SELECT count(*)>0 AND coalesce(bool_and(coalesce(
      binding->'version'='1'::jsonb AND binding->>'audienceType'='group' AND binding->>'recipientUserId' IS NULL
      AND (binding->'companyWide' IS NULL OR jsonb_typeof(binding->'companyWide')='boolean')
      AND binding->>'clearance' IN('public','internal','confidential')
      AND sensitivity_rank(binding->>'clearance')>=sensitivity_rank(NEW.effective_clearance)
      AND(binding->>'expiresAt' IS NULL OR (binding->>'expiresAt')::timestamptz>clock_timestamp())
      AND approver.role IN('owner','admin')
      AND jsonb_typeof(binding->'compartments')='array' AND jsonb_typeof(binding->'projectIds')='array'
      AND (binding->'companyWide' IS DISTINCT FROM 'true'::jsonb OR binding->'compartments'='[]'::jsonb AND binding->'projectIds'='[]'::jsonb)
      AND ((binding->'companyWide'='true'::jsonb AND binding->'compartments'='[]'::jsonb AND binding->'projectIds'='[]'::jsonb)
       OR to_jsonb(NEW.context_compartments)<@(binding->'compartments')
        AND(NEW.context_project_id IS NULL OR binding->'projectIds' ? NEW.context_project_id::text)),false)),false) allowed
     FROM channel_integrations other_ci JOIN channels other_c ON other_c.id=other_ci.channel_id
     CROSS JOIN LATERAL jsonb_array_elements(coalesce(other_ci.config->'deliveryAudienceBindings','[]'::jsonb)) binding
     LEFT JOIN workspace_members approver ON approver.workspace_id=NEW.workspace_id AND approver.user_id=(binding->>'approvedByUserId')::uuid
     WHERE other_c.workspace_id=NEW.workspace_id AND other_c.status='active' AND other_ci.status='active' AND other_ci.channel_type='telegram'
      AND binding->>'version'='1' AND binding->>'channelId' IN(NEW.channel_id,split_part(NEW.channel_id,':',1))
    ) audience
    WHERE ci.id=(origin->>'integrationId')::uuid
   ) eligible;
   IF admitted IS NOT TRUE THEN RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501';END IF;
  END IF;
  IF TG_OP='INSERT' THEN NEW.recording_privacy_held:=false;END IF;
 ELSIF NEW.channel_type='telegram' AND NEW.anchor_kind='channel'
  AND NEW.channel_id ~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$' AND NEW.recording_revision IS NULL THEN
  NEW.recording_privacy_held:=true;
 END IF;
 RETURN NEW;
END
$context_body$;
BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='guard_session_recording_privacy()'::regprocedure;
 original:=routine.prosrc;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM '08910e4aca22a206a0c0504a9266c90221823676dcb02ff291ed8c18d8d48c02'
  OR NOT EXISTS(SELECT 1 FROM pg_temp.telegram_context_originals o WHERE o.oid=routine.oid AND o.expected_body=original AND o.metadata=to_jsonb(routine)-'prosrc')
 THEN RAISE EXCEPTION 'provider_context_predecessor_changed: guard_session_recording_privacy';END IF;
 EXECUTE replace(pg_get_functiondef(routine.oid),original,successor);
 UPDATE pg_temp.telegram_context_originals SET expected_body=successor WHERE oid=routine.oid;
END $context_patch$;
DO $context_patch$
DECLARE routine pg_proc;original text;successor constant text:=$context_body$
DECLARE context_room boolean;previous_check text;expected jsonb;identity jsonb;generation integer;
BEGIN
 SELECT provider_conversation_context,provider_context_identity,provider_context_generation INTO context_room,identity,generation FROM sessions WHERE id=NEW.session_id FOR UPDATE;
 IF context_room THEN
  expected:=nullif(current_setting('app.provider_conversation_expected',true),'')::jsonb;
  IF expected IS DISTINCT FROM jsonb_build_object('identity',identity,'generation',generation) THEN
   RAISE EXCEPTION 'provider_context_unavailable' USING ERRCODE='42501';END IF;
  previous_check:=current_setting('app.provider_conversation_context_check',true);
  PERFORM set_config('app.provider_conversation_context_check',NEW.session_id::text,true);
  UPDATE sessions SET last_active_at=last_active_at WHERE id=NEW.session_id;
  PERFORM set_config('app.provider_conversation_context_check',coalesce(previous_check,''),true);
 END IF;
 IF NOT session_recording_read_allowed(NEW.session_id) THEN
  RAISE EXCEPTION 'recording_privacy_review_required' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END
$context_body$;
BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='refuse_quarantined_recording_message()'::regprocedure;
 original:=routine.prosrc;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM '7e27fa3b7f5cbbd8cec737392052142663e3b1d124c3e244e6b151251467e296'
  OR NOT EXISTS(SELECT 1 FROM pg_temp.telegram_context_originals o WHERE o.oid=routine.oid AND o.expected_body=original AND o.metadata=to_jsonb(routine)-'prosrc')
 THEN RAISE EXCEPTION 'provider_context_predecessor_changed: refuse_quarantined_recording_message';END IF;
 EXECUTE replace(pg_get_functiondef(routine.oid),original,successor);
 UPDATE pg_temp.telegram_context_originals SET expected_body=successor WHERE oid=routine.oid;
END $context_patch$;
DO $controlled_repin$
<<controlled_repin>>
DECLARE previous record;caller record;body text;round integer;changed boolean;
BEGIN
 FOR round IN 1..64 LOOP
  RAISE NOTICE 'Recording privacy frontier: authenticated pin round %',round;
  changed:=false;
  IF EXISTS(SELECT 1 FROM pg_temp.telegram_context_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
  THEN RAISE EXCEPTION 'telegram_context_authenticated_code_changed';END IF;
  FOR previous IN SELECT o.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM pg_temp.telegram_context_originals o JOIN pg_proc p ON p.oid=o.oid WHERE o.body IS DISTINCT FROM p.prosrc
  LOOP
   FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid AND
    (position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0)
   LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_temp.telegram_context_originals o WHERE o.oid=caller.oid AND o.expected_body=caller.prosrc)
    THEN RAISE EXCEPTION 'telegram_context_unauthenticated_pin_consumer: %',caller.oid::regprocedure;END IF;
    body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
    IF body IS DISTINCT FROM caller.prosrc THEN
     EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);
     UPDATE pg_temp.telegram_context_originals SET expected_body=controlled_repin.body WHERE oid=caller.oid;
     changed:=true;
    END IF;
   END LOOP;
   UPDATE pg_temp.telegram_context_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
    fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  IF NOT changed THEN EXIT;END IF;
  IF round=64 THEN RAISE EXCEPTION 'telegram_context_pin_cycle';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.telegram_context_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
 THEN RAISE EXCEPTION 'telegram_context_successor_code_changed';END IF;
END $controlled_repin$;
DO $reference_rows$
<<reference_rows>>
DECLARE routine_row pg_proc;initial_body text;body text;member_oids oid[];
 columns_sql text;row_sql text;comparisons text;catalog_shape jsonb;rows_sql text;
 row_start integer;row_end integer;tail text;
BEGIN
 SELECT * INTO STRICT routine_row FROM pg_proc WHERE oid='application_native_field_reference_helpers_current()'::regprocedure;
 SELECT o.initial_body INTO STRICT initial_body FROM pg_temp.telegram_context_originals o
 WHERE o.oid=reference_rows.routine_row.oid AND o.expected_body=reference_rows.routine_row.prosrc
  AND o.metadata=to_jsonb(reference_rows.routine_row)-'prosrc';
 SELECT array_agg(to_regprocedure('public.'||r.signature)::oid) INTO member_oids FROM unnest(ARRAY['agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','application_current_field_snapshot(uuid,uuid)','application_empty_query_helpers_current()','application_empty_query_worklist_current(uuid,jsonb)','application_empty_query_worklist_reset(jsonb)','application_field_digest(jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','application_field_resource_uuid(text)','application_memory_field_keys()','application_memory_field_state(uuid,uuid,text[])','application_memory_field_state_before_successor(uuid,uuid,text[])','application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','application_memory_history_status(uuid,uuid,text)','application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','application_memory_query_context(uuid)','application_memory_query_domain_state(uuid,uuid,text[])','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','application_memory_statement_state(uuid,uuid,text[],jsonb)','application_native_catalog_port_valid(regprocedure)','application_native_dependency_batch_helpers_current()','application_native_field_catalog_for(uuid,jsonb,text)','application_native_field_contract_before_catalog(uuid,jsonb,text,text)','application_native_field_contract_for(uuid,jsonb,text,text)','application_native_field_rule_allows(jsonb,text[])','application_native_file_capture_helpers_current()','application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_record_port_valid(regprocedure)','application_native_same_destination(uuid,text,uuid,text,uuid)','application_native_source_edges_dispatch(uuid,text,uuid,text)','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_intersection(jsonb,jsonb)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_reader_envelope_visible(uuid,jsonb)','application_recorded_field_root_capture(uuid,uuid,text,integer)','application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','application_scope_lineage(uuid,text[],uuid[],text[])','application_scope_source_edges(uuid,text,uuid,text)','application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','application_session_eval_field(uuid,uuid,text,jsonb)','application_session_eval_scope(uuid,text,uuid,text,jsonb)','assistant_placement_visible(uuid,uuid)','capture_native_session_projection_batch(uuid,uuid,integer,text)','crm_capture_erasure_effect()','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','guard_application_field_lineage()','guard_external_source_derivation()','guard_page_derivation_receipts()','guard_session_context_lineage()','guard_session_recording_privacy()','guard_workflow_derivation_receipts()','knowledge_version_source_edges(uuid,text,uuid,text)','legacy_assistant_team_compartments(uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','project_member_live(uuid,text,uuid)','read_admitted_native_scope_snapshot(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','read_application_field_dependencies(uuid,text[],uuid[],text[])','read_entity_derivation_source(uuid,text,uuid)','read_entity_derivation_source_before_application_fields(uuid,text,uuid)','read_entity_derivation_source_before_blueprint(uuid,text,uuid)','read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','read_entity_derivation_source_before_browser_session(uuid,text,uuid)','read_entity_derivation_source_before_capture(uuid,text,uuid)','read_entity_derivation_source_before_conversation(uuid,text,uuid)','read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','read_entity_derivation_source_before_page(uuid,text,uuid)','read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','read_entity_derivation_source_before_recordings(uuid,text,uuid)','read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])','read_media_parent_snapshot(uuid,text,uuid)','read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','read_media_parent_snapshot_before_conversation(uuid,text,uuid)','read_media_parent_snapshot_before_page(uuid,text,uuid)','read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_field_snapshots(uuid,uuid[],text[])','read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','read_resource_page_dependencies(uuid,text,uuid,text)','read_scope_source(uuid,text,uuid)','read_scope_source_before_application_fields(uuid,text,uuid)','read_scope_source_before_browser_profile(uuid,text,uuid)','read_scope_source_before_browser_session(uuid,text,uuid)','read_scope_source_before_external(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','read_scope_source_before_page(uuid,text,uuid)','read_scope_source_before_persistent_context(uuid,text,uuid)','read_scope_source_before_routines(uuid,text,uuid)','read_scope_source_before_workflow_run(uuid,text,uuid)','recording_source_read_allowed(uuid,text,uuid)','refuse_quarantined_recording_message()','scope_review_state_held(text,uuid)','scope_source_ancestors(uuid,text,uuid)','scope_source_ancestors_before_browser_profile(uuid,text,uuid)','scope_source_ancestors_before_browser_session(uuid,text,uuid)','scope_source_ancestors_before_workflow_run(uuid,text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','scope_source_table_before_media(text)','scope_source_table_before_persistent_context(text)','sensitivity_rank(text)','session_recording_read_allowed(uuid)','validate_application_field_dependencies()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_workflow_derivation_dependencies()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]) r(signature);
 IF cardinality(member_oids)<>156 OR array_position(member_oids,NULL) IS NOT NULL OR
  (SELECT count(*) FROM pg_temp.telegram_context_originals o JOIN pg_proc member ON member.oid=o.oid
   WHERE member.oid=ANY(member_oids) AND member.prosrc=o.expected_body AND (to_jsonb(member)-'prosrc')=o.metadata)<>156
 THEN RAISE EXCEPTION 'telegram_context_reference_members_changed';END IF;
 SELECT string_agg(quote_ident(attname),',' ORDER BY attnum),
  string_agg(format('format(%L,%s)', '%L::'||CASE WHEN attname='proacl' THEN 'jsonb' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN 'text' ELSE format_type(atttypid,atttypmod) END,
   CASE WHEN attname='proacl' THEN 'to_jsonb(p.proacl)' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN format('p.%I::text',attname) ELSE format('p.%I',attname) END),'||'',''||' ORDER BY attnum),
  string_agg(format('%s%s IS NOT DISTINCT FROM m.%I%s',CASE WHEN attname='proacl' THEN 'to_jsonb(p.proacl)' WHEN atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN format('p.%I::text',attname) ELSE format('p.%I',attname) END,CASE WHEN attcollation<>0 OR atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN ' COLLATE "C"' ELSE '' END,attname,CASE WHEN attcollation<>0 OR atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype) THEN ' COLLATE "C"' ELSE '' END),' AND ' ORDER BY attnum),
  jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attcollation) ORDER BY attnum)
 INTO columns_sql,row_sql,comparisons,catalog_shape
 FROM pg_attribute WHERE attrelid='pg_proc'::regclass AND attnum>0 AND NOT attisdropped;

 tail:=') m('||columns_sql||') JOIN pg_catalog.pg_proc p ON p.oid=m.oid) IS NOT TRUE THEN RETURN false;END IF;';
 row_start:=position(' FROM (VALUES ' IN initial_body)+length(' FROM (VALUES ');
 IF position(tail IN initial_body)=0 OR row_start<=length(' FROM (VALUES ')
 THEN RAISE EXCEPTION 'telegram_context_reference_template_changed';END IF;
 row_end:=length(initial_body)-position(reverse(tail) IN reverse(initial_body))-length(tail)+2;
 IF row_end<=row_start THEN RAISE EXCEPTION 'telegram_context_reference_row_bounds_changed';END IF;
 EXECUTE 'SELECT string_agg(''(''||'||row_sql||'||'')'','','' ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1)' INTO rows_sql USING member_oids;
 body:=left(initial_body,row_start-1)||rows_sql||substring(initial_body FROM row_end);
 EXECUTE replace(pg_get_functiondef(reference_rows.routine_row.oid),reference_rows.routine_row.prosrc,body);
 UPDATE pg_temp.telegram_context_originals SET expected_body=reference_rows.body WHERE oid=reference_rows.routine_row.oid;
END $reference_rows$;

DO $controlled_repin$
<<controlled_repin>>
DECLARE previous record;caller record;body text;round integer;changed boolean;
BEGIN
 FOR round IN 1..64 LOOP
  RAISE NOTICE 'Recording privacy frontier: authenticated pin round %',round;
  changed:=false;
  IF EXISTS(SELECT 1 FROM pg_temp.telegram_context_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
  THEN RAISE EXCEPTION 'telegram_context_authenticated_code_changed';END IF;
  FOR previous IN SELECT o.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM pg_temp.telegram_context_originals o JOIN pg_proc p ON p.oid=o.oid WHERE o.body IS DISTINCT FROM p.prosrc
  LOOP
   FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid AND
    (position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0)
   LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_temp.telegram_context_originals o WHERE o.oid=caller.oid AND o.expected_body=caller.prosrc)
    THEN RAISE EXCEPTION 'telegram_context_unauthenticated_pin_consumer: %',caller.oid::regprocedure;END IF;
    body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
    IF body IS DISTINCT FROM caller.prosrc THEN
     EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);
     UPDATE pg_temp.telegram_context_originals SET expected_body=controlled_repin.body WHERE oid=caller.oid;
     changed:=true;
    END IF;
   END LOOP;
   UPDATE pg_temp.telegram_context_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
    fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  IF NOT changed THEN EXIT;END IF;
  IF round=64 THEN RAISE EXCEPTION 'telegram_context_pin_cycle';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.telegram_context_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
 THEN RAISE EXCEPTION 'telegram_context_successor_code_changed';END IF;
END $controlled_repin$;
UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN pg_temp.telegram_context_originals o ON o.oid=p.oid AND o.expected_body=p.prosrc AND o.metadata=to_jsonb(p)-'prosrc'
 WHERE p.oid=to_regprocedure(h.signature) AND o.initial_body IS DISTINCT FROM p.prosrc;
-- Advance only the independently authenticated display pin for the changed leaf.
UPDATE private_session_display_contract c SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN pg_temp.telegram_context_originals o ON o.oid=p.oid
 WHERE p.oid=to_regprocedure(c.signature) AND o.expected_body=p.prosrc AND o.metadata=to_jsonb(p)-'prosrc'
 AND o.initial_body IS DISTINCT FROM p.prosrc AND c.fingerprint=encode(sha256(convert_to((o.metadata||jsonb_build_object('prosrc',o.initial_body))::text,'UTF8')),'hex');
DO $successor_diagnostics$
DECLARE guard_signature text;guard_ok boolean;guard_states jsonb:='{}';member_drift jsonb:='{}';members jsonb;
 guard_body text;columns_sql text;comparisons text;column_failures text;tail text;values_start integer;values_end integer;values_sql text;
BEGIN
 FOREACH guard_signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||guard_signature INTO guard_ok;
  guard_states:=guard_states||jsonb_build_object(guard_signature,guard_ok IS TRUE);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM jsonb_each(guard_states) state WHERE state.value='false'::jsonb) THEN RETURN;END IF;
 RAISE NOTICE 'native_cohort_successor_guard_states: %',guard_states;
 SELECT string_agg(quote_ident(a.attname),',' ORDER BY a.attnum),string_agg(comparison,' AND ' ORDER BY a.attnum),
  string_agg('CASE WHEN NOT('||comparison||') THEN '||quote_literal(a.attname)||' END',',' ORDER BY a.attnum)
 INTO columns_sql,comparisons,column_failures FROM pg_attribute a CROSS JOIN LATERAL(
  SELECT format('%s%s IS NOT DISTINCT FROM m.%I%s',
   CASE WHEN a.attname='proacl' THEN 'to_jsonb(p.proacl)' WHEN a.atttypid IN('pg_node_tree'::regtype,'oidvector'::regtype,'regproc'::regtype)
    THEN format('p.%I::text',a.attname) ELSE format('p.%I',a.attname) END,
   CASE WHEN a.attcollation<>0 THEN ' COLLATE "C"' ELSE '' END,a.attname,
   CASE WHEN a.attcollation<>0 THEN ' COLLATE "C"' ELSE '' END) comparison
 ) generated WHERE a.attrelid='pg_catalog.pg_proc'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 tail:=') m('||columns_sql||') JOIN pg_catalog.pg_proc p ON p.oid=m.oid) IS NOT TRUE THEN RETURN false;END IF;';
 FOR guard_signature IN SELECT key FROM jsonb_each(guard_states) state WHERE state.value='false'::jsonb LOOP
  SELECT p.prosrc INTO guard_body FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||guard_signature);
  values_start:=position(' FROM (VALUES ' IN guard_body)+length(' FROM ');
  IF position(tail IN guard_body)>0 AND values_start>length(' FROM ') THEN
   -- The final full-column tail is outside every quoted nested helper body.
   values_end:=length(guard_body)-position(reverse(tail) IN reverse(guard_body))-length(tail)+2;
   values_sql:=substring(guard_body FROM values_start FOR values_end-values_start)||') m('||columns_sql||')';
   EXECUTE 'SELECT coalesce(jsonb_agg(row),''[]''::jsonb) FROM(SELECT jsonb_build_object(''function'',coalesce(o.signature,p.oid::regprocedure::text,m.oid::text),''columns'',array_remove(ARRAY['||column_failures||'],NULL)) row FROM '
    ||values_sql||' LEFT JOIN pg_catalog.pg_proc p ON p.oid=m.oid LEFT JOIN pg_temp.telegram_context_originals o ON o.oid=m.oid WHERE NOT('||comparisons||') LIMIT 12) differences' INTO members;
   member_drift:=member_drift||jsonb_build_object(guard_signature,members);
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(h.signature),'[]'::jsonb) INTO members FROM native_turn_contract_helpers h
 LEFT JOIN pg_proc p ON p.oid=to_regprocedure(h.signature)
 WHERE h.fingerprint IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex');
 RAISE EXCEPTION 'telegram_context_successor_contract_changed: %',jsonb_build_object('guards',guard_states,'flatMembers',member_drift,'readerMembers',members);
END $successor_diagnostics$;
COMMIT;
