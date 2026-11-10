-- [COMP:api/native-chat-read-cost] Complete current native proof for active Work-recording epochs.
BEGIN;
-- Authenticate the existing kernel before changing its field catalog.
DO $transcript_contract$
DECLARE signature text; ok boolean;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'work_recording_proof_dependency_changed: %',signature;END IF;
 END LOOP;
END $transcript_contract$;
CREATE TEMP TABLE pg_temp.work_recording_proof_originals ON COMMIT DROP AS
 SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p)-'prosrc' metadata,
 p.prosrc body,p.prosrc expected_body,quote_literal(p.prosrc) quoted_body,
 encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint,
 encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash,p.prosrc initial_body
 FROM pg_proc p WHERE p.oid::regprocedure::text=ANY(ARRAY['publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','agent_mutation_scope_allows(text[])','agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','application_current_field_snapshot(uuid,uuid)','application_empty_query_facades_current()','application_empty_query_helpers_current()','application_empty_query_worklist_current(uuid,jsonb)','application_empty_query_worklist_reset(jsonb)','application_field_digest(jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','application_field_resource_uuid(text)','application_materialize_field_envelope(uuid,jsonb,integer)','application_memory_field_keys()','application_memory_field_state(uuid,uuid,text[])','application_memory_field_state_before_successor(uuid,uuid,text[])','application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','application_memory_history_status(uuid,uuid,text)','application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','application_memory_query_context(uuid)','application_memory_query_domain_state(uuid,uuid,text[])','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','application_memory_statement_state(uuid,uuid,text[],jsonb)','application_native_catalog_port_valid(regprocedure)','application_native_context_fields_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','application_native_dependency_batch_helpers_current()','application_native_field_catalog_for(uuid,jsonb,text)','application_native_field_contract_before_catalog(uuid,jsonb,text,text)','application_native_field_contract_for(uuid,jsonb,text,text)','application_native_field_reference_helpers_current()','application_native_field_rule_allows(jsonb,text[])','application_native_file_capture_helpers_current()','application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_record_port_valid(regprocedure)','application_native_root_cover(uuid,jsonb)','application_native_same_destination(uuid,text,uuid,text,uuid)','application_native_session_query_acquisition_current()','application_native_source_edges_dispatch(uuid,text,uuid,text)','application_native_title_acquisition_helpers_current()','application_native_title_group_helpers_current()','application_native_transcript_prepare_helpers_current()','application_native_worklist_helpers_current()','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_admits_point(jsonb,jsonb)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_escape(jsonb[],integer,text[],text[],text[],integer)','application_query_scope_intersection(jsonb,jsonb)','application_query_scope_union_contains(jsonb,jsonb,integer)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_reader_envelope_visible(uuid,jsonb)','application_recorded_field_root_capture(uuid,uuid,text,integer)','application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','application_scope_lineage(uuid,text[],uuid[],text[])','application_scope_source_edges(uuid,text,uuid,text)','application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','application_session_eval_domain(uuid,text,uuid,text[],jsonb)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','application_session_eval_field(uuid,uuid,text,jsonb)','application_session_eval_point_state(uuid,text,uuid,text[],jsonb)','application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','application_session_eval_scope(uuid,text,uuid,text,jsonb)','application_session_eval_scope_current(uuid,text,uuid,text,jsonb)','application_session_field_keys(text)','application_session_query_bounds(uuid,jsonb)','application_session_query_parent(uuid,uuid)','application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)','assistant_placement_visible(uuid,uuid)','capture_native_session_projection_batch(uuid,uuid,integer,text)','capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)','crm_capture_erasure_effect()','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','external_source_snapshot(uuid,uuid)','guard_application_field_lineage()','guard_external_source_derivation()','guard_page_derivation_receipts()','guard_session_context_lineage()','guard_session_recording_privacy()','guard_workflow_derivation_receipts()','knowledge_version_source_edges(uuid,text,uuid,text)','legacy_assistant_team_compartments(uuid)','lock_native_session_context_publication(uuid,uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','native_detached_eval_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_detached_eval_field(uuid,uuid,text,jsonb,jsonb)','native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_detached_eval_scope(uuid,text,uuid,text,jsonb,jsonb)','native_detached_lineage(uuid,text[],uuid[],text[],jsonb)','native_detached_snapshot(uuid,text,uuid,text,jsonb)','native_personal_title_group_acquisition(uuid,uuid[],uuid[])','native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_context()','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_event_frame(uuid,uuid)','native_turn_field_reference(uuid,uuid,uuid,text)','native_turn_frame_immutable()','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_key(jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_page_event(jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_privacy_edges(uuid,jsonb)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','native_turn_validate_frame_pair()','native_worklist_context(uuid,jsonb)','native_worklist_current(uuid,text,uuid,jsonb)','native_worklist_current_application_sources(uuid,text,uuid,jsonb)','native_worklist_current_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_current_persistent_context(uuid,text,uuid,jsonb)','native_worklist_current_public_share(uuid,text,uuid,jsonb)','native_worklist_edges(uuid,jsonb)','native_worklist_eval_domain(uuid,text,uuid,text[],jsonb)','native_worklist_eval_envelope(uuid,text,uuid,text,text[],jsonb)','native_worklist_eval_field(uuid,uuid,text,jsonb)','native_worklist_eval_point_state(uuid,text,uuid,text[],jsonb)','native_worklist_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','native_worklist_eval_scope(uuid,text,uuid,text,jsonb)','native_worklist_frame_current(uuid,jsonb)','native_worklist_lineage(uuid,text[],uuid[],text[],jsonb)','native_worklist_page_dependencies(uuid,text,uuid,text,jsonb)','native_worklist_seed(uuid,jsonb)','native_worklist_snapshot(uuid,text,uuid,text,jsonb)','native_worklist_source(uuid,text,uuid,jsonb)','native_worklist_source_application_fields(uuid,text,uuid,jsonb)','native_worklist_source_blueprint(uuid,text,uuid,jsonb)','native_worklist_source_browser_profile(uuid,text,uuid,jsonb)','native_worklist_source_browser_session(uuid,text,uuid,jsonb)','native_worklist_source_capture(uuid,text,uuid,jsonb)','native_worklist_source_conversation(uuid,text,uuid,jsonb)','native_worklist_source_engineering_archive(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_source_parent(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_source_memory_successor(uuid,text,uuid,jsonb)','native_worklist_source_page(uuid,text,uuid,jsonb)','native_worklist_source_persistent_context(uuid,text,uuid,jsonb)','native_worklist_source_primitive_v2(uuid,text,uuid,jsonb)','native_worklist_source_recordings(uuid,text,uuid,jsonb)','native_worklist_source_workflow_run(uuid,text,uuid,jsonb)','observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','project_labels_allowed(jsonb,uuid,text[],boolean)','project_member_live(uuid,text,uuid)','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_admitted_native_scope_snapshot(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','read_application_field_dependencies(uuid,text[],uuid[],text[])','read_entity_derivation_source(uuid,text,uuid)','read_entity_derivation_source_before_application_fields(uuid,text,uuid)','read_entity_derivation_source_before_blueprint(uuid,text,uuid)','read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','read_entity_derivation_source_before_browser_session(uuid,text,uuid)','read_entity_derivation_source_before_capture(uuid,text,uuid)','read_entity_derivation_source_before_conversation(uuid,text,uuid)','read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','read_entity_derivation_source_before_page(uuid,text,uuid)','read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','read_entity_derivation_source_before_recordings(uuid,text,uuid)','read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])','read_media_parent_snapshot(uuid,text,uuid)','read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','read_media_parent_snapshot_before_conversation(uuid,text,uuid)','read_media_parent_snapshot_before_page(uuid,text,uuid)','read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)','read_native_application_session_topics(uuid,uuid,integer)','read_native_attended_memory_evidence(uuid,text[],uuid[],text[])','read_native_context_field_currents(uuid,jsonb)','read_native_covered_memory_frame(uuid,text[],uuid[],text[],boolean)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_covered_session_frame(uuid,text[],uuid[],text[])','read_native_empty_query_evidence(uuid,text[],uuid[],text[])','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_field_snapshots(uuid,uuid[],text[])','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_file_worklist_evidence(uuid,text[],uuid[],text[],boolean,boolean)','read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_personal_title_group(uuid,uuid[],uuid[])','read_native_personal_title_group_evidence(uuid,uuid[],uuid[])','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_field_snapshots(uuid,uuid[],text[])','read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_session_query_evidence(uuid,uuid,integer,integer)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_resource_page_dependencies(uuid,text,uuid,text)','read_scope_source(uuid,text,uuid)','read_scope_source_before_application_fields(uuid,text,uuid)','read_scope_source_before_browser_profile(uuid,text,uuid)','read_scope_source_before_browser_session(uuid,text,uuid)','read_scope_source_before_external(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','read_scope_source_before_page(uuid,text,uuid)','read_scope_source_before_persistent_context(uuid,text,uuid)','read_scope_source_before_routines(uuid,text,uuid)','read_scope_source_before_workflow_run(uuid,text,uuid)','read_session_context_empty_query_revision(uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_revision(uuid,uuid)','read_session_title_revision(uuid,uuid,uuid)','recording_source_read_allowed(uuid,text,uuid)','refuse_quarantined_recording_message()','scope_review_state_held(text,uuid)','scope_source_ancestors(uuid,text,uuid)','scope_source_ancestors_before_browser_profile(uuid,text,uuid)','scope_source_ancestors_before_browser_session(uuid,text,uuid)','scope_source_ancestors_before_workflow_run(uuid,text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','scope_source_table_before_media(text)','scope_source_table_before_persistent_context(text)','sensitivity_rank(text)','session_context_empty_query_revision_allowed(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_parent_snapshot(uuid,uuid)','session_context_payload_shape(text,jsonb)','session_context_revision_allowed(uuid,uuid)','session_context_revision_native(uuid,uuid)','session_context_revision_snapshot(uuid,uuid)','session_personal_audience(sessions)','session_project_audience(sessions,boolean)','session_recording_read_allowed(uuid)','session_workspace_audience(sessions)','validate_application_field_dependencies()','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_session_context_revision_pair()','validate_workflow_derivation_dependencies()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]);

DO $active_work_proof$
DECLARE item record;target regprocedure;original text;definition text;successor text;
 certificate constant text:=$certificate$ -- This is optimization eligibility metadata, not actor or source admission.
 -- Every recording parent in the complete privacy closure must be an exact
 -- active Work epoch. Held, Personal and unreviewed legacy parents still fall back.
 WITH parent_ids AS(SELECT DISTINCT (p->>'sessionId')::uuid id FROM jsonb_array_elements(privacy_parents) p
  WHERE p->>'sessionId' IS NOT NULL), certificates AS(
 SELECT s.id,jsonb_build_object('eligible',coalesce(
  s.workspace_id=w AND NOT s.recording_privacy_held AND s.visibility='workspace'
  AND s.channel_type='telegram' AND s.anchor_kind='channel' AND s.anchor_ref=s.channel_id
  AND s.recording_revision IS NOT NULL AND s.recording_policy_id=policy.id
  AND policy.workspace_id=w AND policy.session_id=s.id AND policy.revision=s.recording_revision
  AND policy.enabled AND policy.destination='workspace' AND policy.project_id IS NOT DISTINCT FROM s.context_project_id
  AND policy.conversation_id=s.channel_id AND policy.owner_user_id=s.user_id
  AND ci.id=policy.integration_id AND ci.status='active' AND ci.channel_type='telegram'
  AND ci.bot_user_id=policy.bot_id AND ci.recording_owner_user_id=policy.owner_user_id
  AND c.id=ci.channel_id AND c.workspace_id=w AND c.status='active' AND c.channel_type='telegram'
  AND owner_member.user_id=policy.owner_user_id AND a.id=s.assistant_id AND a.workspace_id=w
  AND routing.assistant_id=s.assistant_id AND audience.allowed
  AND (SELECT count(*) FROM channel_assistants same_route WHERE same_route.channel_id=c.id
   AND same_route.external_surface_id IS NOT DISTINCT FROM routing.external_surface_id)=1
  AND (policy.project_id IS NULL OR project.id=policy.project_id AND project.workspace_id=w
   AND project.status='active' AND project_scope.status='active'
   AND workspace.department_read_v2 AND workspace.project_shared_spaces
   AND project_member_live(policy.project_id,'user',policy.owner_user_id)
   AND project_member_live(policy.project_id,'assistant',s.assistant_id)),false),
  'policy',to_jsonb(policy),
  'integration',jsonb_build_object('id',ci.id,'channelId',ci.channel_id,'channelType',ci.channel_type,
   'status',ci.status,'botId',ci.bot_user_id,'recorderId',ci.recording_owner_user_id),
  'channel',jsonb_build_object('id',c.id,'workspaceId',c.workspace_id,'channelType',c.channel_type,
   'status',c.status,'clearance',c.clearance,'capabilities',c.enabled_capabilities),
  'owner',jsonb_build_object('userId',owner_member.user_id,'role',owner_member.role,
   'clearance',owner_member.clearance,'compartments',owner_member.compartments),
  'assistant',jsonb_build_object('id',a.id,'workspaceId',a.workspace_id,'clearance',a.clearance,
   'compartments',a.compartments,'departmentId',a.placement_department_id),
  'routing',jsonb_build_object('id',routing.id,'channelId',routing.channel_id,
   'assistantId',routing.assistant_id,'surfaceId',routing.external_surface_id),
  'audiences',audience.bindings,
  'project',jsonb_build_object('id',project.id,'workspaceId',project.workspace_id,'status',project.status,
   'sharedStatus',project_scope.status,'enabled',workspace.project_shared_spaces AND workspace.department_read_v2,
   'recorderMember',CASE WHEN policy.project_id IS NOT NULL THEN project_member_live(policy.project_id,'user',policy.owner_user_id) ELSE NULL END,
   'assistantMember',CASE WHEN policy.project_id IS NOT NULL THEN project_member_live(policy.project_id,'assistant',s.assistant_id) ELSE NULL END)) certificate
 FROM parent_ids ids JOIN sessions s ON s.id=ids.id
 LEFT JOIN channel_recording_policies policy ON policy.id=s.recording_policy_id
 LEFT JOIN channel_integrations ci ON ci.id=policy.integration_id
 LEFT JOIN channels c ON c.id=ci.channel_id
 LEFT JOIN workspace_members owner_member ON owner_member.workspace_id=w AND owner_member.user_id=policy.owner_user_id
 LEFT JOIN assistants a ON a.id=s.assistant_id
 LEFT JOIN workspaces workspace ON workspace.id=w
 LEFT JOIN workspace_projects project ON project.id=policy.project_id
 LEFT JOIN project_shared_scopes project_scope ON project_scope.project_id=policy.project_id
 LEFT JOIN LATERAL(SELECT ca.id,ca.channel_id,ca.assistant_id,ca.external_surface_id FROM channel_assistants ca
  WHERE ca.channel_id=c.id AND(ca.external_surface_id IN(s.channel_id,split_part(s.channel_id,':',1)) OR ca.external_surface_id IS NULL)
  ORDER BY CASE WHEN ca.external_surface_id=s.channel_id THEN 1 WHEN ca.external_surface_id=split_part(s.channel_id,':',1) THEN 2 ELSE 3 END LIMIT 1) routing ON true
 LEFT JOIN LATERAL(
  -- Match the canonical provider-group audience: every active bot's exact
  -- topic AND parent approval participates, with the same company-wide rule.
  SELECT count(*)>0 AND coalesce(bool_and(coalesce(
   binding->'version'='1'::jsonb AND binding->>'audienceType'='group' AND binding->>'recipientUserId' IS NULL
   AND (binding->'companyWide' IS NULL OR jsonb_typeof(binding->'companyWide')='boolean')
   AND binding->>'clearance' IN('public','internal','confidential')
   AND sensitivity_rank(binding->>'clearance')>=sensitivity_rank(s.effective_clearance)
   AND(binding->>'expiresAt' IS NULL OR (binding->>'expiresAt')::timestamptz>clock_timestamp())
   AND approver.role IN('owner','admin')
   AND jsonb_typeof(binding->'compartments')='array' AND jsonb_typeof(binding->'projectIds')='array'
   AND (binding->'companyWide' IS DISTINCT FROM 'true'::jsonb OR binding->'compartments'='[]'::jsonb AND binding->'projectIds'='[]'::jsonb)
   AND ((binding->'companyWide'='true'::jsonb AND binding->'compartments'='[]'::jsonb AND binding->'projectIds'='[]'::jsonb)
    OR to_jsonb(s.context_compartments)<@(binding->'compartments')
     AND(s.context_project_id IS NULL OR binding->'projectIds' ? s.context_project_id::text)),false)),false) allowed,
   coalesce(jsonb_agg(jsonb_build_object('integrationId',other_ci.id,'channelId',other_c.id,
    'binding',binding,'approver',jsonb_build_object('userId',approver.user_id,'role',approver.role))
    ORDER BY other_ci.id,binding::text),'[]'::jsonb) bindings
  FROM channel_integrations other_ci JOIN channels other_c ON other_c.id=other_ci.channel_id
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(other_ci.config->'deliveryAudienceBindings','[]'::jsonb)) binding
  LEFT JOIN workspace_members approver ON approver.workspace_id=w AND approver.user_id=(binding->>'approvedByUserId')::uuid
  WHERE other_c.workspace_id=w AND other_c.status='active' AND other_ci.status='active' AND other_ci.channel_type='telegram'
   AND binding->>'version'='1' AND binding->>'channelId' IN(s.channel_id,split_part(s.channel_id,':',1))
 ) audience ON true
 WHERE s.recording_revision IS NOT NULL OR s.channel_type='telegram' AND s.anchor_kind='channel'
  AND s.channel_id ~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$'
 ) SELECT coalesce(jsonb_object_agg(id::text,certificate),'{}'::jsonb) INTO recording_epochs FROM certificates;
 SELECT coalesce(jsonb_agg(p||jsonb_build_object('recordingEpoch',recording_epochs->(p->>'sessionId'))
  ORDER BY (p->'node')::text,p->>'sessionId'),'[]'::jsonb) INTO privacy_parents FROM jsonb_array_elements(privacy_parents) p;
$certificate$;
 added_locks constant text:=$locks$ -- Added recording locks are all NOWAIT. A contended authority row returns
 -- to the original reader before payload/capture writes; the exception block
 -- rolls back this function's partial lock set instead of creating an inverse wait.
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id IN(
  SELECT (p#>>'{recordingEpoch,owner,userId}')::uuid FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
  UNION SELECT (audience#>>'{approver,userId}')::uuid FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{recordingEpoch,audiences}','[]'::jsonb)) audience
 ) ORDER BY user_id FOR SHARE NOWAIT;
 -- A channel key lock also fences a new route inserted through its FK.
 PERFORM id FROM channels WHERE workspace_id=w AND id IN(
  SELECT (p#>>'{recordingEpoch,channel,id}')::uuid FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
  UNION SELECT (audience->>'channelId')::uuid FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{recordingEpoch,audiences}','[]'::jsonb)) audience
 ) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM channel_integrations WHERE id IN(
  SELECT (p#>>'{recordingEpoch,integration,id}')::uuid FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
  UNION SELECT (audience->>'integrationId')::uuid FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{recordingEpoch,audiences}','[]'::jsonb)) audience
 ) ORDER BY id FOR SHARE NOWAIT;
 PERFORM id FROM channel_assistants WHERE channel_id IN(
  SELECT (p#>>'{recordingEpoch,channel,id}')::uuid FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
 ) ORDER BY id FOR SHARE NOWAIT;
 PERFORM id FROM channel_recording_policies WHERE workspace_id=w AND id IN(
  SELECT (p#>>'{recordingEpoch,policy,id}')::uuid FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
 ) ORDER BY id FOR SHARE NOWAIT;
$locks$;
 declaration_before constant text:='privacy_edges jsonb:=''[]'';privacy_parents jsonb;';
 parent_tail constant text:=' INTO privacy_parents FROM p LEFT JOIN sessions s ON s.id=p.session_id;';
 rejection_before constant text:='p->>''recordingRevision'' IS NOT NULL OR p->>''legacyRecording''=''true''';
 rejection_after constant text:='((p->>''recordingRevision'' IS NOT NULL OR p->>''legacyRecording''=''true'') AND p#>>''{recordingEpoch,eligible}'' IS DISTINCT FROM ''true'')';
 parent_before constant text:='''recordingHeld'',s.recording_privacy_held) ORDER BY i.id)';
 parent_after constant text:='''recordingHeld'',s.recording_privacy_held,''recordingEpoch'',recording_epochs->(s.id::text)) ORDER BY i.id)';
 lock_before constant text:=' PERFORM id FROM sessions WHERE workspace_id=w AND id IN';
 expiry_before constant text:=' UNION ALL SELECT expires_at FROM office_artifacts WHERE expires_at>transaction_timestamp()) transitions;';
 expiry_after constant text:=$expiry$ UNION ALL SELECT expires_at FROM office_artifacts WHERE expires_at>transaction_timestamp()
 UNION ALL SELECT (audience#>>'{binding,expiresAt}')::timestamptz FROM jsonb_array_elements(meta#>'{witness,sessionParents}') p
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{recordingEpoch,audiences}','[]'::jsonb)) audience
 WHERE audience#>>'{binding,expiresAt}' IS NOT NULL) transitions;$expiry$;
BEGIN
 FOR item IN SELECT * FROM(VALUES
 ('public.native_turn_metadata_acquire(uuid,jsonb,jsonb)','799eaa22a4a254e65b48224d184b6d627c42d9672f7451e6c29d39d3d3113961','metadata'),
 ('public.native_turn_compact_metadata(uuid,jsonb,jsonb)','1b50b3bc8bc5584c719268764a8f8e6070861983fc8260f997e7555f0f8f1d1a','metadata'),
 ('public.native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','1eb9ac0e438287ea2b0d9af4d60a4ecf8e5e34f3f94df4d8bd0ca89fcca2a7f0','metadata'),
 ('public.native_turn_lock_requirements(uuid,jsonb)','903185c4c4b49b58dc7ae434d916dfc104b3bc0991e0d2234d76c61064e8497a','locks'),
 ('public.native_turn_capture_requirements(uuid,jsonb,jsonb)','b7916ef15344ab800444eaa75795b684c6b44850f4b349b38686b3069f1e2e93','expiry'),
 ('public.native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','47aca697cf751c027a0caa201095e4556f61b39175b731b50289ba9397f2bcf3','expiry')
 ) expected(signature,body_hash,kind) LOOP
  target:=item.signature::regprocedure;
  SELECT p.prosrc,pg_get_functiondef(p.oid) INTO original,definition FROM pg_proc p JOIN pg_temp.work_recording_proof_originals o ON o.oid=p.oid
   WHERE p.oid=target AND o.expected_body=p.prosrc AND o.metadata=to_jsonb(p)-'prosrc';
  IF original IS NULL OR encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM item.body_hash
  THEN RAISE EXCEPTION 'active_work_proof_predecessor_changed: %',item.signature;END IF;
  IF item.kind='metadata' THEN
   IF (length(original)-length(replace(original,declaration_before,'')))/length(declaration_before)<>1
    OR (length(original)-length(replace(original,parent_tail,'')))/length(parent_tail)<>1
    OR (length(original)-length(replace(original,rejection_before,'')))/length(rejection_before)<>1
    OR (length(original)-length(replace(original,parent_before,'')))/length(parent_before)<>1
   THEN RAISE EXCEPTION 'active_work_proof_metadata_shape_changed: %',item.signature;END IF;
   successor:=replace(original,declaration_before,declaration_before||'recording_epochs jsonb;');
   successor:=replace(successor,parent_tail,parent_tail||E'\n'||certificate);
   successor:=replace(successor,rejection_before,rejection_after);
   successor:=replace(successor,parent_before,parent_after);
  ELSIF item.kind='locks' THEN
   IF (length(original)-length(replace(original,lock_before,'')))/length(lock_before)<>1
   THEN RAISE EXCEPTION 'active_work_proof_lock_shape_changed';END IF;
   successor:=replace(original,lock_before,added_locks||lock_before);
  ELSE
   IF (length(original)-length(replace(original,expiry_before,'')))/length(expiry_before)<>1
   THEN RAISE EXCEPTION 'active_work_proof_expiry_shape_changed: %',item.signature;END IF;
   successor:=replace(original,expiry_before,expiry_after);
  END IF;
  EXECUTE replace(definition,original,successor);
  UPDATE pg_temp.work_recording_proof_originals SET expected_body=successor WHERE oid=target;
 END LOOP;
END $active_work_proof$;
DO $controlled_repin$
<<controlled_repin>>
DECLARE previous record;caller record;body text;round integer;changed boolean;
BEGIN
 FOR round IN 1..64 LOOP
  RAISE NOTICE 'Active Work-recording proof: authenticated pin round %',round;
  changed:=false;
  IF EXISTS(SELECT 1 FROM pg_temp.work_recording_proof_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
  THEN RAISE EXCEPTION 'work_recording_proof_authenticated_code_changed';END IF;
  FOR previous IN SELECT o.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM pg_temp.work_recording_proof_originals o JOIN pg_proc p ON p.oid=o.oid WHERE o.body IS DISTINCT FROM p.prosrc
  LOOP
   FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid AND
    (position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0)
   LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_temp.work_recording_proof_originals o WHERE o.oid=caller.oid AND o.expected_body=caller.prosrc)
    THEN RAISE EXCEPTION 'work_recording_proof_unauthenticated_pin_consumer: %',caller.oid::regprocedure;END IF;
    body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
    IF body IS DISTINCT FROM caller.prosrc THEN
     EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);
     UPDATE pg_temp.work_recording_proof_originals SET expected_body=controlled_repin.body WHERE oid=caller.oid;
     changed:=true;
    END IF;
   END LOOP;
   UPDATE pg_temp.work_recording_proof_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
    fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  IF NOT changed THEN EXIT;END IF;
  IF round=64 THEN RAISE EXCEPTION 'work_recording_proof_pin_cycle';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.work_recording_proof_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
 THEN RAISE EXCEPTION 'work_recording_proof_successor_code_changed';END IF;
END $controlled_repin$;
DO $reference_rows$
<<reference_rows>>
DECLARE routine_row pg_proc;initial_body text;body text;member_oids oid[];
 columns_sql text;row_sql text;comparisons text;catalog_shape jsonb;rows_sql text;
 row_start integer;row_end integer;tail text;
BEGIN
 SELECT * INTO STRICT routine_row FROM pg_proc WHERE oid='application_native_field_reference_helpers_current()'::regprocedure;
 SELECT o.initial_body INTO STRICT initial_body FROM pg_temp.work_recording_proof_originals o
 WHERE o.oid=reference_rows.routine_row.oid AND o.expected_body=reference_rows.routine_row.prosrc
  AND o.metadata=to_jsonb(reference_rows.routine_row)-'prosrc';
 SELECT array_agg(to_regprocedure('public.'||r.signature)::oid) INTO member_oids FROM unnest(ARRAY['agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','application_current_field_snapshot(uuid,uuid)','application_empty_query_helpers_current()','application_empty_query_worklist_current(uuid,jsonb)','application_empty_query_worklist_reset(jsonb)','application_field_digest(jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','application_field_resource_uuid(text)','application_memory_field_keys()','application_memory_field_state(uuid,uuid,text[])','application_memory_field_state_before_successor(uuid,uuid,text[])','application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','application_memory_history_status(uuid,uuid,text)','application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','application_memory_query_context(uuid)','application_memory_query_domain_state(uuid,uuid,text[])','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','application_memory_statement_state(uuid,uuid,text[],jsonb)','application_native_catalog_port_valid(regprocedure)','application_native_dependency_batch_helpers_current()','application_native_field_catalog_for(uuid,jsonb,text)','application_native_field_contract_before_catalog(uuid,jsonb,text,text)','application_native_field_contract_for(uuid,jsonb,text,text)','application_native_field_rule_allows(jsonb,text[])','application_native_file_capture_helpers_current()','application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_record_port_valid(regprocedure)','application_native_same_destination(uuid,text,uuid,text,uuid)','application_native_source_edges_dispatch(uuid,text,uuid,text)','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_intersection(jsonb,jsonb)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_reader_envelope_visible(uuid,jsonb)','application_recorded_field_root_capture(uuid,uuid,text,integer)','application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','application_scope_lineage(uuid,text[],uuid[],text[])','application_scope_source_edges(uuid,text,uuid,text)','application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','application_session_eval_field(uuid,uuid,text,jsonb)','application_session_eval_scope(uuid,text,uuid,text,jsonb)','assistant_placement_visible(uuid,uuid)','capture_native_session_projection_batch(uuid,uuid,integer,text)','crm_capture_erasure_effect()','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','guard_application_field_lineage()','guard_external_source_derivation()','guard_page_derivation_receipts()','guard_session_context_lineage()','guard_session_recording_privacy()','guard_workflow_derivation_receipts()','knowledge_version_source_edges(uuid,text,uuid,text)','legacy_assistant_team_compartments(uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','project_member_live(uuid,text,uuid)','read_admitted_native_scope_snapshot(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','read_application_field_dependencies(uuid,text[],uuid[],text[])','read_entity_derivation_source(uuid,text,uuid)','read_entity_derivation_source_before_application_fields(uuid,text,uuid)','read_entity_derivation_source_before_blueprint(uuid,text,uuid)','read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','read_entity_derivation_source_before_browser_session(uuid,text,uuid)','read_entity_derivation_source_before_capture(uuid,text,uuid)','read_entity_derivation_source_before_conversation(uuid,text,uuid)','read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','read_entity_derivation_source_before_page(uuid,text,uuid)','read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','read_entity_derivation_source_before_recordings(uuid,text,uuid)','read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])','read_media_parent_snapshot(uuid,text,uuid)','read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','read_media_parent_snapshot_before_conversation(uuid,text,uuid)','read_media_parent_snapshot_before_page(uuid,text,uuid)','read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_field_snapshots(uuid,uuid[],text[])','read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','read_resource_page_dependencies(uuid,text,uuid,text)','read_scope_source(uuid,text,uuid)','read_scope_source_before_application_fields(uuid,text,uuid)','read_scope_source_before_browser_profile(uuid,text,uuid)','read_scope_source_before_browser_session(uuid,text,uuid)','read_scope_source_before_external(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','read_scope_source_before_page(uuid,text,uuid)','read_scope_source_before_persistent_context(uuid,text,uuid)','read_scope_source_before_routines(uuid,text,uuid)','read_scope_source_before_workflow_run(uuid,text,uuid)','recording_source_read_allowed(uuid,text,uuid)','refuse_quarantined_recording_message()','scope_review_state_held(text,uuid)','scope_source_ancestors(uuid,text,uuid)','scope_source_ancestors_before_browser_profile(uuid,text,uuid)','scope_source_ancestors_before_browser_session(uuid,text,uuid)','scope_source_ancestors_before_workflow_run(uuid,text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','scope_source_table_before_media(text)','scope_source_table_before_persistent_context(text)','sensitivity_rank(text)','session_recording_read_allowed(uuid)','validate_application_field_dependencies()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_workflow_derivation_dependencies()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]) r(signature);
 IF cardinality(member_oids)<>156 OR array_position(member_oids,NULL) IS NOT NULL OR
  (SELECT count(*) FROM pg_temp.work_recording_proof_originals o JOIN pg_proc member ON member.oid=o.oid
   WHERE member.oid=ANY(member_oids) AND member.prosrc=o.expected_body AND (to_jsonb(member)-'prosrc')=o.metadata)<>156
 THEN RAISE EXCEPTION 'work_recording_proof_reference_members_changed';END IF;
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
 THEN RAISE EXCEPTION 'work_recording_proof_reference_template_changed';END IF;
 row_end:=length(initial_body)-position(reverse(tail) IN reverse(initial_body))-length(tail)+2;
 IF row_end<=row_start THEN RAISE EXCEPTION 'work_recording_proof_reference_row_bounds_changed';END IF;
 EXECUTE 'SELECT string_agg(''(''||'||row_sql||'||'')'','','' ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1)' INTO rows_sql USING member_oids;
 body:=left(initial_body,row_start-1)||rows_sql||substring(initial_body FROM row_end);
 EXECUTE replace(pg_get_functiondef(reference_rows.routine_row.oid),reference_rows.routine_row.prosrc,body);
 UPDATE pg_temp.work_recording_proof_originals SET expected_body=reference_rows.body WHERE oid=reference_rows.routine_row.oid;
END $reference_rows$;

DO $controlled_repin$
<<controlled_repin>>
DECLARE previous record;caller record;body text;round integer;changed boolean;
BEGIN
 FOR round IN 1..64 LOOP
  RAISE NOTICE 'Active Work-recording proof: authenticated pin round %',round;
  changed:=false;
  IF EXISTS(SELECT 1 FROM pg_temp.work_recording_proof_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
  THEN RAISE EXCEPTION 'work_recording_proof_authenticated_code_changed';END IF;
  FOR previous IN SELECT o.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM pg_temp.work_recording_proof_originals o JOIN pg_proc p ON p.oid=o.oid WHERE o.body IS DISTINCT FROM p.prosrc
  LOOP
   FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid AND
    (position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0)
   LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_temp.work_recording_proof_originals o WHERE o.oid=caller.oid AND o.expected_body=caller.prosrc)
    THEN RAISE EXCEPTION 'work_recording_proof_unauthenticated_pin_consumer: %',caller.oid::regprocedure;END IF;
    body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
    IF body IS DISTINCT FROM caller.prosrc THEN
     EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);
     UPDATE pg_temp.work_recording_proof_originals SET expected_body=controlled_repin.body WHERE oid=caller.oid;
     changed:=true;
    END IF;
   END LOOP;
   UPDATE pg_temp.work_recording_proof_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
    fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  IF NOT changed THEN EXIT;END IF;
  IF round=64 THEN RAISE EXCEPTION 'work_recording_proof_pin_cycle';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.work_recording_proof_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
 THEN RAISE EXCEPTION 'work_recording_proof_successor_code_changed';END IF;
END $controlled_repin$;
UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN pg_temp.work_recording_proof_originals o ON o.oid=p.oid AND o.expected_body=p.prosrc AND o.metadata=to_jsonb(p)-'prosrc'
 WHERE p.oid=to_regprocedure(h.signature) AND o.initial_body IS DISTINCT FROM p.prosrc;
-- Advance only the independently authenticated display pin for the changed leaf.
UPDATE private_session_display_contract c SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN pg_temp.work_recording_proof_originals o ON o.oid=p.oid
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
    ||values_sql||' LEFT JOIN pg_catalog.pg_proc p ON p.oid=m.oid LEFT JOIN pg_temp.work_recording_proof_originals o ON o.oid=m.oid WHERE NOT('||comparisons||') LIMIT 12) differences' INTO members;
   member_drift:=member_drift||jsonb_build_object(guard_signature,members);
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(h.signature),'[]'::jsonb) INTO members FROM native_turn_contract_helpers h
 LEFT JOIN pg_proc p ON p.oid=to_regprocedure(h.signature)
 WHERE h.fingerprint IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex');
 RAISE EXCEPTION 'work_recording_proof_successor_contract_changed: %',jsonb_build_object('guards',guard_states,'flatMembers',member_drift,'readerMembers',members);
END $successor_diagnostics$;
COMMIT;
