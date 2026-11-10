-- [COMP:api/page-thread-audience] Exact Page audience and retained transcript ancestry.
-- Forward-only successor: no content, historical source or permission data changes.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $transcript_contract$
DECLARE signature text; ok boolean;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'page_thread_dependency_changed: %',signature;END IF;
 END LOOP;
END $transcript_contract$;
CREATE TEMP TABLE pg_temp.page_thread_originals ON COMMIT DROP AS
 SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p)-'prosrc' metadata,
 p.prosrc body,p.prosrc expected_body,quote_literal(p.prosrc) quoted_body,
 encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint,
 encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash,p.prosrc initial_body
 FROM pg_proc p WHERE p.oid::regprocedure::text=ANY(ARRAY['read_native_session_field_dependencies(uuid,text[],uuid[],text[])','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','agent_mutation_scope_allows(text[])','agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','application_current_field_snapshot(uuid,uuid)','application_empty_query_facades_current()','application_empty_query_helpers_current()','application_empty_query_worklist_current(uuid,jsonb)','application_empty_query_worklist_reset(jsonb)','application_field_digest(jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','application_field_resource_uuid(text)','application_materialize_field_envelope(uuid,jsonb,integer)','application_memory_field_keys()','application_memory_field_state(uuid,uuid,text[])','application_memory_field_state_before_successor(uuid,uuid,text[])','application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','application_memory_history_status(uuid,uuid,text)','application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','application_memory_query_context(uuid)','application_memory_query_domain_state(uuid,uuid,text[])','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','application_memory_statement_state(uuid,uuid,text[],jsonb)','application_native_catalog_port_valid(regprocedure)','application_native_context_fields_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','application_native_dependency_batch_helpers_current()','application_native_field_catalog_for(uuid,jsonb,text)','application_native_field_contract_before_catalog(uuid,jsonb,text,text)','application_native_field_contract_for(uuid,jsonb,text,text)','application_native_field_reference_helpers_current()','application_native_field_rule_allows(jsonb,text[])','application_native_file_capture_helpers_current()','application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_record_port_valid(regprocedure)','application_native_root_cover(uuid,jsonb)','application_native_same_destination(uuid,text,uuid,text,uuid)','application_native_session_query_acquisition_current()','application_native_source_edges_dispatch(uuid,text,uuid,text)','application_native_title_acquisition_helpers_current()','application_native_title_group_helpers_current()','application_native_transcript_prepare_helpers_current()','application_native_worklist_helpers_current()','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_admits_point(jsonb,jsonb)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_escape(jsonb[],integer,text[],text[],text[],integer)','application_query_scope_intersection(jsonb,jsonb)','application_query_scope_union_contains(jsonb,jsonb,integer)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_reader_envelope_visible(uuid,jsonb)','application_recorded_field_root_capture(uuid,uuid,text,integer)','application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','application_scope_lineage(uuid,text[],uuid[],text[])','application_scope_source_edges(uuid,text,uuid,text)','application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','application_session_eval_domain(uuid,text,uuid,text[],jsonb)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','application_session_eval_field(uuid,uuid,text,jsonb)','application_session_eval_point_state(uuid,text,uuid,text[],jsonb)','application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','application_session_eval_scope(uuid,text,uuid,text,jsonb)','application_session_eval_scope_current(uuid,text,uuid,text,jsonb)','application_session_field_keys(text)','application_session_query_bounds(uuid,jsonb)','application_session_query_parent(uuid,uuid)','application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)','assistant_placement_visible(uuid,uuid)','capture_native_session_projection_batch(uuid,uuid,integer,text)','capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)','crm_capture_erasure_effect()','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','external_source_snapshot(uuid,uuid)','guard_application_field_lineage()','guard_external_source_derivation()','guard_page_derivation_receipts()','guard_session_context_lineage()','guard_session_recording_privacy()','guard_workflow_derivation_receipts()','knowledge_version_source_edges(uuid,text,uuid,text)','legacy_assistant_team_compartments(uuid)','lock_native_session_context_publication(uuid,uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','native_detached_eval_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_detached_eval_field(uuid,uuid,text,jsonb,jsonb)','native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_detached_eval_scope(uuid,text,uuid,text,jsonb,jsonb)','native_detached_lineage(uuid,text[],uuid[],text[],jsonb)','native_detached_snapshot(uuid,text,uuid,text,jsonb)','native_personal_title_group_acquisition(uuid,uuid[],uuid[])','native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_context()','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_event_frame(uuid,uuid)','native_turn_field_reference(uuid,uuid,uuid,text)','native_turn_frame_immutable()','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_key(jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_page_event(jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_privacy_edges(uuid,jsonb)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','native_turn_validate_frame_pair()','native_worklist_context(uuid,jsonb)','native_worklist_current(uuid,text,uuid,jsonb)','native_worklist_current_application_sources(uuid,text,uuid,jsonb)','native_worklist_current_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_current_persistent_context(uuid,text,uuid,jsonb)','native_worklist_current_public_share(uuid,text,uuid,jsonb)','native_worklist_edges(uuid,jsonb)','native_worklist_eval_domain(uuid,text,uuid,text[],jsonb)','native_worklist_eval_envelope(uuid,text,uuid,text,text[],jsonb)','native_worklist_eval_field(uuid,uuid,text,jsonb)','native_worklist_eval_point_state(uuid,text,uuid,text[],jsonb)','native_worklist_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','native_worklist_eval_scope(uuid,text,uuid,text,jsonb)','native_worklist_frame_current(uuid,jsonb)','native_worklist_lineage(uuid,text[],uuid[],text[],jsonb)','native_worklist_page_dependencies(uuid,text,uuid,text,jsonb)','native_worklist_seed(uuid,jsonb)','native_worklist_snapshot(uuid,text,uuid,text,jsonb)','native_worklist_source(uuid,text,uuid,jsonb)','native_worklist_source_application_fields(uuid,text,uuid,jsonb)','native_worklist_source_blueprint(uuid,text,uuid,jsonb)','native_worklist_source_browser_profile(uuid,text,uuid,jsonb)','native_worklist_source_browser_session(uuid,text,uuid,jsonb)','native_worklist_source_capture(uuid,text,uuid,jsonb)','native_worklist_source_conversation(uuid,text,uuid,jsonb)','native_worklist_source_engineering_archive(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_source_parent(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_source_memory_successor(uuid,text,uuid,jsonb)','native_worklist_source_page(uuid,text,uuid,jsonb)','native_worklist_source_persistent_context(uuid,text,uuid,jsonb)','native_worklist_source_primitive_v2(uuid,text,uuid,jsonb)','native_worklist_source_recordings(uuid,text,uuid,jsonb)','native_worklist_source_workflow_run(uuid,text,uuid,jsonb)','observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','project_labels_allowed(jsonb,uuid,text[],boolean)','project_member_live(uuid,text,uuid)','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_admitted_native_scope_snapshot(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','read_application_field_dependencies(uuid,text[],uuid[],text[])','read_entity_derivation_source(uuid,text,uuid)','read_entity_derivation_source_before_application_fields(uuid,text,uuid)','read_entity_derivation_source_before_blueprint(uuid,text,uuid)','read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','read_entity_derivation_source_before_browser_session(uuid,text,uuid)','read_entity_derivation_source_before_capture(uuid,text,uuid)','read_entity_derivation_source_before_conversation(uuid,text,uuid)','read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','read_entity_derivation_source_before_page(uuid,text,uuid)','read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','read_entity_derivation_source_before_recordings(uuid,text,uuid)','read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])','read_media_parent_snapshot(uuid,text,uuid)','read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','read_media_parent_snapshot_before_conversation(uuid,text,uuid)','read_media_parent_snapshot_before_page(uuid,text,uuid)','read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)','read_native_application_session_topics(uuid,uuid,integer)','read_native_attended_memory_evidence(uuid,text[],uuid[],text[])','read_native_context_field_currents(uuid,jsonb)','read_native_covered_memory_frame(uuid,text[],uuid[],text[],boolean)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_covered_session_frame(uuid,text[],uuid[],text[])','read_native_empty_query_evidence(uuid,text[],uuid[],text[])','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_field_snapshots(uuid,uuid[],text[])','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_file_worklist_evidence(uuid,text[],uuid[],text[],boolean,boolean)','read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_personal_title_group(uuid,uuid[],uuid[])','read_native_personal_title_group_evidence(uuid,uuid[],uuid[])','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_field_snapshots(uuid,uuid[],text[])','read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_session_query_evidence(uuid,uuid,integer,integer)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_resource_page_dependencies(uuid,text,uuid,text)','read_scope_source(uuid,text,uuid)','read_scope_source_before_application_fields(uuid,text,uuid)','read_scope_source_before_browser_profile(uuid,text,uuid)','read_scope_source_before_browser_session(uuid,text,uuid)','read_scope_source_before_external(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','read_scope_source_before_page(uuid,text,uuid)','read_scope_source_before_persistent_context(uuid,text,uuid)','read_scope_source_before_routines(uuid,text,uuid)','read_scope_source_before_workflow_run(uuid,text,uuid)','read_session_context_empty_query_revision(uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_revision(uuid,uuid)','read_session_title_revision(uuid,uuid,uuid)','recording_source_read_allowed(uuid,text,uuid)','refuse_quarantined_recording_message()','scope_review_state_held(text,uuid)','scope_source_ancestors(uuid,text,uuid)','scope_source_ancestors_before_browser_profile(uuid,text,uuid)','scope_source_ancestors_before_browser_session(uuid,text,uuid)','scope_source_ancestors_before_workflow_run(uuid,text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','scope_source_table_before_media(text)','scope_source_table_before_persistent_context(text)','sensitivity_rank(text)','session_context_empty_query_revision_allowed(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_parent_snapshot(uuid,uuid)','session_context_payload_shape(text,jsonb)','session_context_revision_allowed(uuid,uuid)','session_context_revision_native(uuid,uuid)','session_context_revision_snapshot(uuid,uuid)','session_personal_audience(sessions)','session_project_audience(sessions,boolean)','session_recording_read_allowed(uuid)','session_workspace_audience(sessions)','validate_application_field_dependencies()','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_session_context_revision_pair()','validate_workflow_derivation_dependencies()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]);

DO $page_thread_patch$
DECLARE routine pg_proc;successor constant text:=$page_thread_body$
DECLARE source jsonb; admitted jsonb; parent jsonb; output scope_derivations;
BEGIN
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_page_event(jsonb)'::regprocedure)='61ece67a93c1c995cf10e23256cf47489a845e0a8b9347c6ab4ed298c6cdcd4f'
 THEN
  IF native_turn_page_event(to_jsonb(NEW)) THEN RETURN NULL;END IF;
 END IF;
 SELECT * INTO output FROM scope_derivations WHERE workspace_id=NEW.workspace_id AND id=NEW.derivation_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(read_resource_page_dependencies(NEW.workspace_id,NEW.source_kind,NEW.source_id,NEW.source_version)) LOOP
  IF output.resource_kind='session_message' THEN
   IF NOT EXISTS(SELECT 1 FROM session_messages m JOIN sessions session ON session.id=m.session_id
    JOIN comment_threads ct ON ct.session_id=session.id AND ct.workspace_id=output.workspace_id
    JOIN workflow_page_event_receipts receipt ON receipt.workspace_id=output.workspace_id AND receipt.page_id=ct.page_id
    LEFT JOIN workflow_page_event_observations observation ON observation.workspace_id=output.workspace_id
     AND observation.id=(source->>'resourceId')::uuid
    WHERE m.workspace_id=output.workspace_id AND m.id=output.resource_id
     AND session.visibility='workspace' AND session.anchor_kind='doc_thread'
     AND receipt.revision=CASE WHEN source->>'resourceKind' LIKE 'page_live_%' THEN observation.receipt_id ELSE (source->>'resourceId')::uuid END)
   THEN RAISE EXCEPTION 'page_derivation_output_not_integrated';END IF;
  ELSIF output.resource_kind NOT IN('workspace_file','file_segment','session_context_revision') THEN RAISE EXCEPTION 'page_derivation_output_not_integrated';END IF;
  admitted:=read_page_derivation_source(NEW.workspace_id,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM source->>'version' THEN RAISE EXCEPTION 'scope_source_changed'; END IF;
  FOR parent IN SELECT value FROM jsonb_array_elements(jsonb_build_array(source)||(admitted->'requiredSources')) LOOP
   IF NOT EXISTS(SELECT 1 FROM scope_derivation_sources p WHERE p.workspace_id=NEW.workspace_id AND p.derivation_id=NEW.derivation_id
    AND p.source_kind=parent->>'resourceKind' AND p.source_id=(parent->>'resourceId')::uuid AND p.source_version=parent->>'version') THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
   IF (parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM output.user_id::text AND output.resource_kind<>'session_message')
    OR (parent->>'assistantId' IS NOT NULL AND parent->>'assistantId' IS DISTINCT FROM output.assistant_id::text)
    OR sensitivity_rank(parent->>'sensitivity')>sensitivity_rank(output.sensitivity)
    OR NOT(to_jsonb(output.compartments) @> (parent->'compartments'))
    OR NOT(to_jsonb(output.project_ids) @> (parent->'projectIds')) THEN RAISE EXCEPTION 'scope_visibility_incompatible'; END IF;
  END LOOP;
 END LOOP;
 RETURN NULL;
END $page_thread_body$;
BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='validate_page_derivation_dependencies()'::regprocedure;
 IF encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM 'c364c21dfd906d3d4a75f6ab3b5e5d65d27601c05bc4dde6bf0b3454302e8f3a'
  OR NOT EXISTS(SELECT 1 FROM pg_temp.page_thread_originals original WHERE original.oid=routine.oid
   AND original.expected_body=routine.prosrc AND original.metadata=to_jsonb(routine)-'prosrc')
 THEN RAISE EXCEPTION 'page_thread_predecessor_changed: validate_page_derivation_dependencies()';END IF;
 IF encode(sha256(convert_to(successor,'UTF8')),'hex') IS DISTINCT FROM 'b60a63c0c220b5a62abd7287f1e59d4e48727713f24c47f21f7e7dfbaef561fb'
 THEN RAISE EXCEPTION 'page_thread_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(routine.oid),routine.prosrc,successor);
 UPDATE pg_temp.page_thread_originals SET expected_body=successor WHERE oid=routine.oid;
END $page_thread_patch$;

DO $page_thread_patch$
DECLARE routine pg_proc;successor constant text:=$page_thread_body$
 SELECT s.visibility='workspace' AND s.workspace_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=s.workspace_id
   AND wm.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
   AND sensitivity_rank(s.effective_clearance)<=sensitivity_rank(wm.clearance)
   AND (effective_member_team_compartments(wm.user_id,wm.workspace_id) IS NULL
    OR s.context_compartments <@ effective_member_team_compartments(wm.user_id,wm.workspace_id)))
 AND (s.anchor_kind<>'doc_thread' OR EXISTS(
  SELECT 1 FROM comment_threads ct JOIN saved_views p ON p.id=ct.page_id AND p.workspace_id=ct.workspace_id
  WHERE ct.session_id=s.id AND ct.workspace_id=s.workspace_id))
$page_thread_body$;
BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='session_workspace_audience(sessions)'::regprocedure;
 IF encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM '0a4a6d805cfcb3170651e0f16f4c8a6918d0f6ea58038c70ade693c3f199a52a'
  OR NOT EXISTS(SELECT 1 FROM pg_temp.page_thread_originals original WHERE original.oid=routine.oid
   AND original.expected_body=routine.prosrc AND original.metadata=to_jsonb(routine)-'prosrc')
 THEN RAISE EXCEPTION 'page_thread_predecessor_changed: session_workspace_audience(sessions)';END IF;
 IF encode(sha256(convert_to(successor,'UTF8')),'hex') IS DISTINCT FROM 'cb66c20a2dc12389723ebbe0ac22049e39b516769ed9ebfbd267190e4ac4a5c4'
 THEN RAISE EXCEPTION 'page_thread_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(routine.oid),routine.prosrc,successor);
 UPDATE pg_temp.page_thread_originals SET expected_body=successor WHERE oid=routine.oid;
END $page_thread_patch$;

DO $page_thread_patch$
DECLARE routine pg_proc;successor constant text:=$page_thread_body$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;node jsonb;current_source jsonb;
 expanded jsonb:=sources;retained jsonb:='[]';dependency record;root_kinds text[];root_ids uuid[];root_versions text[];
 floor_tier text;teams text[];projects uuid[];memo jsonb:='{}';evaluated jsonb;stored session_messages;derivation uuid;source_scope jsonb;
BEGIN
 parent:=lock_native_session_context_publication(w,s);
 IF jsonb_typeof(payload) IS DISTINCT FROM 'object' OR NOT payload ?& ARRAY['role','content','channelMessageId','senderUserId','senderAssistantId','attachments']
  OR payload-ARRAY['role','content','channelMessageId','senderUserId','senderAssistantId','attachments']<>'{}'
  OR payload->>'role' NOT IN('user','assistant') OR jsonb_typeof(payload->'role') IS DISTINCT FROM 'string'
  OR jsonb_typeof(payload->'attachments') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'attachments')>100
  OR jsonb_typeof(payload->'channelMessageId') NOT IN('null','string')
  OR jsonb_typeof(payload->'senderUserId') NOT IN('null','string') OR jsonb_typeof(payload->'senderAssistantId') NOT IN('null','string')
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR entity_derivation_envelope_valid(target) IS NOT TRUE OR target->>'workspaceId' IS DISTINCT FROM w::text
  OR target->>'assistantId' IS NOT NULL OR target->>'userId' IS NOT NULL AND target->>'userId' IS DISTINCT FROM actor::text
  OR parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM target->>'userId'
  OR payload->>'senderUserId' IS NOT NULL AND payload->>'senderUserId' IS DISTINCT FROM actor::text
  OR payload->>'senderAssistantId' IS NOT NULL AND (payload->>'role'<>'assistant'
   OR payload->>'senderAssistantId' IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(sources) LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR jsonb_typeof(node->'resourceKind') IS DISTINCT FROM 'string' OR jsonb_typeof(node->'resourceId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(node->'version') IS DISTINCT FROM 'string' OR length(btrim(node->>'version')) NOT BETWEEN 1 AND 256
   OR node->>'resourceKind' NOT IN('application_field','external_source','crm_event','private_transcript','page_event_changed','page_event_destination','page_live_changed','page_live_destination') AND scope_source_table(node->>'resourceKind') IS NULL THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 -- Discover immutable obligations before D1 can drop their native carrier.
 -- This metadata confers no authority; every collected source is admitted below.
 SELECT array_agg(value->>'resourceKind'),array_agg((value->>'resourceId')::uuid),array_agg(value->>'version')
  INTO root_kinds,root_ids,root_versions FROM jsonb_array_elements(sources);
 FOR dependency IN
  SELECT node_version,source FROM read_application_field_dependencies(w,root_kinds,root_ids,root_versions)
  UNION ALL SELECT node_version,source FROM read_external_source_dependencies(w,root_kinds,root_ids,root_versions)
  UNION ALL SELECT n.version,read_scope_source(w,n.kind,n.id) FROM application_scope_lineage(w,root_kinds,root_ids,root_versions) n WHERE n.kind='session_context_revision'
 LOOP
  node:=dependency.source;
  IF node IS NULL OR node->>'held'='true' OR node->>'version' IS DISTINCT FROM dependency.node_version
   OR entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  node:=jsonb_build_object('workspaceId',node->'workspaceId','userId',node->'userId','assistantId',node->'assistantId',
   'sensitivity',node->'sensitivity','compartments',node->'compartments','projectIds',node->'projectIds',
   'resourceKind',node->'resourceKind','resourceId',node->'resourceId','version',node->'version');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) original WHERE (original->>'resourceKind',original->>'resourceId')=(node->>'resourceKind',node->>'resourceId')
   AND (original->>'version' IS DISTINCT FROM node->>'version' OR (original-ARRAY['held','validTo','retractedAt','causalEntityId']) IS DISTINCT FROM node)) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) original WHERE (original->>'resourceKind',original->>'resourceId')=(node->>'resourceKind',node->>'resourceId')) THEN
   expanded:=expanded||jsonb_build_array(node);END IF;
  IF jsonb_array_length(expanded)>4096 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 IF (SELECT count(DISTINCT (candidate.value->>'resourceKind',candidate.value->>'resourceId')) FROM jsonb_array_elements(expanded) candidate(value))<>jsonb_array_length(expanded) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 floor_tier:=CASE WHEN sensitivity_rank(target->>'sensitivity')>sensitivity_rank(parent->>'sensitivity') THEN target->>'sensitivity' ELSE parent->>'sensitivity' END;
 teams:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text((parent->'compartments')||(target->'compartments')) value ORDER BY value);
 projects:=ARRAY(SELECT DISTINCT value::uuid FROM jsonb_array_elements_text((parent->'projectIds')||(target->'projectIds')) value ORDER BY value::uuid);
 FOR node IN SELECT value FROM jsonb_array_elements(expanded) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR node->>'userId' IS NOT NULL AND node->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF node->>'resourceKind'='application_field' THEN
   evaluated:=application_session_eval_field(w,(node->>'resourceId')::uuid,node->>'version',memo);memo:=coalesce(evaluated->'memo',memo);current_source:=evaluated->'value';
  ELSIF node->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(node->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(node->>'resourceId')::uuid,node->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE current_source:=read_admitted_native_scope_snapshot(w,node->>'resourceKind',(node->>'resourceId')::uuid);END IF;
  -- Original immutable obligations never use native D1 disappearance semantics.
  IF node->>'resourceKind' IN('application_field','external_source','session_context_revision','crm_event','private_transcript')
   AND (current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' OR current_source->>'version' IS DISTINCT FROM node->>'version'
    OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
    OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
      IS DISTINCT FROM (node->'workspaceId',node->'userId',node->'assistantId',node->'sensitivity')
    OR NOT (current_source->'compartments')@>(node->'compartments') OR NOT (node->'compartments')@>(current_source->'compartments')
    OR NOT (current_source->'projectIds')@>(node->'projectIds') OR NOT (node->'projectIds')@>(current_source->'projectIds')) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF current_source IS NOT NULL AND current_source->>'held' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF node->>'resourceKind'='crm_event' AND (current_source IS NULL OR current_source->>'version' IS DISTINCT FROM node->>'version'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) e WHERE e->>'resourceKind'='entity' AND e->>'resourceId'=current_source->>'causalEntityId')) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF sensitivity_rank(node->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=node->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(node->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(node->'projectIds')::uuid)) value ORDER BY value);
  IF current_source IS NOT NULL AND current_source->>'validTo' IS NULL AND current_source->>'retractedAt' IS NULL THEN
   IF sensitivity_rank(current_source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=current_source->>'sensitivity';END IF;
   teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(current_source->'compartments'))) value ORDER BY value);
   projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(current_source->'projectIds')::uuid)) value ORDER BY value);
   IF current_source->>'version'=node->>'version' AND (current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS NOT DISTINCT FROM (node->'userId',node->'assistantId',node->'sensitivity') AND current_source->'compartments'=node->'compartments'
    AND current_source->'projectIds'=node->'projectIds' THEN retained:=retained||jsonb_build_array(node);END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) obligation(value)
  WHERE obligation.value->>'resourceKind' IN('application_field','external_source','session_context_revision','crm_event','private_transcript')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained) kept(value) WHERE
   (kept.value->>'resourceKind',kept.value->>'resourceId',kept.value->>'version')=
   (obligation.value->>'resourceKind',obligation.value->>'resourceId',obligation.value->>'version'))) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(payload->'attachments') LOOP
  IF jsonb_typeof(node) IS DISTINCT FROM 'object' OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained) input WHERE input->>'resourceKind'='workspace_file' AND input->>'resourceId'=node->>'fileId') THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 source_scope:=jsonb_build_object('workspaceId',w,'userId',target->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects);
 INSERT INTO session_messages(session_id,role,content,sequence_num,channel_message_id,sender_user_id,sender_assistant_id,attachments,
  workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
  SELECT s,payload->>'role',payload->'content',coalesce(max(sequence_num),0)+1,payload->>'channelMessageId',
   (payload->>'senderUserId')::uuid,(payload->>'senderAssistantId')::uuid,payload->'attachments',w,(target->>'userId')::uuid,NULL,floor_tier,teams,projects,1,false
  FROM session_messages WHERE session_id=s RETURNING * INTO stored;
 IF jsonb_array_length(retained)>0 THEN
  INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
   SELECT w,'session_message',stored.id,'1',producer,(target->>'userId')::uuid,NULL,floor_tier,teams,projects,revision FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
   SELECT w,derivation,value->>'resourceKind',(value->>'resourceId')::uuid,value->>'version' FROM jsonb_array_elements(retained) ORDER BY value->>'resourceKind',value->>'resourceId';
 END IF;
 RETURN jsonb_build_object('message',jsonb_build_object('id',stored.id,'sessionId',s,'role',stored.role,'content',stored.content,
  'sequenceNum',stored.sequence_num,'createdAt',stored.created_at,'replyToText',NULL,'topicLabel',NULL,'topicConfidence',NULL,
  'channelMessageId',stored.channel_message_id,'senderUserId',stored.sender_user_id,'senderAssistantId',stored.sender_assistant_id,'attachments',stored.attachments),
  'source',source_scope||jsonb_build_object('resourceKind','session_message','resourceId',stored.id,'version','1'));
END $page_thread_body$;
BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM 'c0a1d9ab2def5e80dd9940cf146b29cc54ba5300b13bda49b0a8432a9b6181c5'
  OR NOT EXISTS(SELECT 1 FROM pg_temp.page_thread_originals original WHERE original.oid=routine.oid
   AND original.expected_body=routine.prosrc AND original.metadata=to_jsonb(routine)-'prosrc')
 THEN RAISE EXCEPTION 'page_thread_predecessor_changed: publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)';END IF;
 IF encode(sha256(convert_to(successor,'UTF8')),'hex') IS DISTINCT FROM '90d99f2ba0d20fc32e3ebdeff91d871c43471089e51d74728abc05d3e8cbb30a'
 THEN RAISE EXCEPTION 'page_thread_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(routine.oid),routine.prosrc,successor);
 UPDATE pg_temp.page_thread_originals SET expected_body=successor WHERE oid=routine.oid;
END $page_thread_patch$;

DO $page_thread_patch$
DECLARE routine pg_proc;successor constant text:=$page_thread_body$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;node jsonb;current_source jsonb;
 expanded jsonb:=sources;retained jsonb:='[]';dependency record;root_kinds text[];root_ids uuid[];root_versions text[];
 floor_tier text;teams text[];projects uuid[];memo jsonb:='{}';evaluated jsonb;stored session_messages;derivation uuid;source_scope jsonb;projection jsonb;label jsonb;
 covered_preparation jsonb;
BEGIN
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_transcript_prepare_helpers_current()'::regprocedure)='2fc7c5a9c0b2c3f51159c21f6e4bfc9722edfc61f9d8d90cec22aa6ad4c85467' THEN
  IF application_native_transcript_prepare_helpers_current() IS TRUE THEN
   covered_preparation:=prepare_native_session_message_covered(w,s,producer,sources,target);
   IF covered_preparation IS NOT NULL AND (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_transcript_prepare_helpers_current()'::regprocedure)='2fc7c5a9c0b2c3f51159c21f6e4bfc9722edfc61f9d8d90cec22aa6ad4c85467' THEN
    IF application_native_transcript_prepare_helpers_current() IS TRUE THEN RETURN covered_preparation;END IF;
   END IF;
  END IF;
 END IF;
 -- Unsupported or drifted optional work falls through to the inline original.

 parent:=lock_native_session_context_publication(w,s);
 IF jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR entity_derivation_envelope_valid(target) IS NOT TRUE OR target->>'workspaceId' IS DISTINCT FROM w::text
  OR target->>'assistantId' IS NOT NULL OR target->>'userId' IS NOT NULL AND target->>'userId' IS DISTINCT FROM actor::text
  OR parent->>'userId' IS NOT NULL AND parent->>'userId' IS DISTINCT FROM target->>'userId'
 THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR node IN SELECT value FROM jsonb_array_elements(sources) LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR jsonb_typeof(node->'resourceKind') IS DISTINCT FROM 'string' OR jsonb_typeof(node->'resourceId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(node->'version') IS DISTINCT FROM 'string' OR length(btrim(node->>'version')) NOT BETWEEN 1 AND 256
   OR node->>'resourceKind' NOT IN('application_field','external_source','crm_event','private_transcript','page_event_changed','page_event_destination','page_live_changed','page_live_destination') AND scope_source_table(node->>'resourceKind') IS NULL THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 -- Discover immutable obligations before D1 can drop their native carrier.
 -- This metadata confers no authority; every collected source is admitted below.
 SELECT array_agg(value->>'resourceKind'),array_agg((value->>'resourceId')::uuid),array_agg(value->>'version')
  INTO root_kinds,root_ids,root_versions FROM jsonb_array_elements(sources);
 FOR dependency IN
  SELECT fields.node_version,fields.source FROM jsonb_array_elements(sources) original(value)
  CROSS JOIN LATERAL (
   SELECT d.node_version,d.source FROM read_native_session_field_dependencies(w,ARRAY[original.value->>'resourceKind'],
    ARRAY[(original.value->>'resourceId')::uuid],ARRAY[original.value->>'version']) d
   WHERE original.value->>'resourceKind'='application_field' AND EXISTS(SELECT 1 FROM public.application_field_resources f
     WHERE f.workspace_id=w AND f.id=(original.value->>'resourceId')::uuid
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
   UNION ALL SELECT d.node_version,d.source FROM read_application_field_dependencies(w,ARRAY[original.value->>'resourceKind'],
    ARRAY[(original.value->>'resourceId')::uuid],ARRAY[original.value->>'version']) d
   WHERE NOT (original.value->>'resourceKind'='application_field' AND EXISTS(SELECT 1 FROM public.application_field_resources f
     WHERE f.workspace_id=w AND f.id=(original.value->>'resourceId')::uuid
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
  ) fields
  UNION ALL SELECT node_version,source FROM read_external_source_dependencies(w,root_kinds,root_ids,root_versions)
  UNION ALL SELECT n.version,read_scope_source(w,n.kind,n.id) FROM application_scope_lineage(w,root_kinds,root_ids,root_versions) n WHERE n.kind='session_context_revision'
 LOOP
  node:=dependency.source;
  IF node IS NULL OR node->>'held'='true' OR node->>'version' IS DISTINCT FROM dependency.node_version
   OR entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  node:=jsonb_build_object('workspaceId',node->'workspaceId','userId',node->'userId','assistantId',node->'assistantId',
   'sensitivity',node->'sensitivity','compartments',node->'compartments','projectIds',node->'projectIds',
   'resourceKind',node->'resourceKind','resourceId',node->'resourceId','version',node->'version');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) original WHERE (original->>'resourceKind',original->>'resourceId')=(node->>'resourceKind',node->>'resourceId')
   AND (original->>'version' IS DISTINCT FROM node->>'version' OR (original-ARRAY['held','validTo','retractedAt','causalEntityId']) IS DISTINCT FROM node)) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) original WHERE (original->>'resourceKind',original->>'resourceId')=(node->>'resourceKind',node->>'resourceId')) THEN
   expanded:=expanded||jsonb_build_array(node);END IF;
  IF jsonb_array_length(expanded)>4096 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 END LOOP;
 IF (SELECT count(DISTINCT (candidate.value->>'resourceKind',candidate.value->>'resourceId')) FROM jsonb_array_elements(expanded) candidate(value))<>jsonb_array_length(expanded) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 floor_tier:=CASE WHEN sensitivity_rank(target->>'sensitivity')>sensitivity_rank(parent->>'sensitivity') THEN target->>'sensitivity' ELSE parent->>'sensitivity' END;
 teams:=ARRAY(SELECT DISTINCT value FROM jsonb_array_elements_text((parent->'compartments')||(target->'compartments')) value ORDER BY value);
 projects:=ARRAY(SELECT DISTINCT value::uuid FROM jsonb_array_elements_text((parent->'projectIds')||(target->'projectIds')) value ORDER BY value::uuid);
 FOR node IN SELECT value FROM jsonb_array_elements(expanded) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(node) IS NOT TRUE OR node->>'workspaceId' IS DISTINCT FROM w::text
   OR node->>'userId' IS NOT NULL AND node->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF node->>'resourceKind'='application_field' THEN
   evaluated:=application_session_eval_field(w,(node->>'resourceId')::uuid,node->>'version',memo);memo:=coalesce(evaluated->'memo',memo);current_source:=evaluated->'value';
  ELSIF node->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(node->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(node->>'resourceId')::uuid,node->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE current_source:=read_admitted_native_scope_snapshot(w,node->>'resourceKind',(node->>'resourceId')::uuid);END IF;
  -- Original immutable obligations never use native D1 disappearance semantics.
  IF node->>'resourceKind' IN('application_field','external_source','session_context_revision','crm_event','private_transcript')
   AND (current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' OR current_source->>'version' IS DISTINCT FROM node->>'version'
    OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
    OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
      IS DISTINCT FROM (node->'workspaceId',node->'userId',node->'assistantId',node->'sensitivity')
    OR NOT (current_source->'compartments')@>(node->'compartments') OR NOT (node->'compartments')@>(current_source->'compartments')
    OR NOT (current_source->'projectIds')@>(node->'projectIds') OR NOT (node->'projectIds')@>(current_source->'projectIds')) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF current_source IS NOT NULL AND current_source->>'held' IS DISTINCT FROM 'false' THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF node->>'resourceKind'='crm_event' AND (current_source IS NULL OR current_source->>'version' IS DISTINCT FROM node->>'version'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) e WHERE e->>'resourceKind'='entity' AND e->>'resourceId'=current_source->>'causalEntityId')) THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF node->>'resourceKind'='application_field'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(sources) original WHERE
    (original->>'resourceKind',original->>'resourceId',original->>'version')=(node->>'resourceKind',node->>'resourceId',node->>'version'))
   AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=(node->>'resourceId')::uuid
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
   projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[(node->>'resourceId')::uuid],ARRAY[node->>'version']);
   IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
    OR projection->'root' IS DISTINCT FROM (node-ARRAY['held','validTo','retractedAt'])
    OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
    IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE
     OR label->>'userId' IS NOT NULL AND label->>'userId' IS DISTINCT FROM target->>'userId'
      AND (target->>'userId' IS NOT NULL OR label->>'userId' IS DISTINCT FROM actor::text) THEN
     RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
    IF sensitivity_rank(label->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=label->>'sensitivity';END IF;
    teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(label->'compartments'))) item ORDER BY item);
    projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(label->'projectIds')::uuid)) item ORDER BY item);
   END LOOP;
   -- Metadata is not admission. Repeat the exact current H read after discovery.
   current_source:=read_admitted_application_field_snapshot(w,(node->>'resourceId')::uuid,node->>'version');
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
    OR (current_source-ARRAY['held','validTo','retractedAt']) IS DISTINCT FROM (node-ARRAY['held','validTo','retractedAt']) THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  END IF;
  IF sensitivity_rank(node->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=node->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(node->'compartments'))) value ORDER BY value);
  projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(node->'projectIds')::uuid)) value ORDER BY value);
  IF current_source IS NOT NULL AND current_source->>'validTo' IS NULL AND current_source->>'retractedAt' IS NULL THEN
   IF sensitivity_rank(current_source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=current_source->>'sensitivity';END IF;
   teams:=ARRAY(SELECT DISTINCT value FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(current_source->'compartments'))) value ORDER BY value);
   projects:=ARRAY(SELECT DISTINCT value FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(current_source->'projectIds')::uuid)) value ORDER BY value);
   IF current_source->>'version'=node->>'version' AND (current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS NOT DISTINCT FROM (node->'userId',node->'assistantId',node->'sensitivity') AND current_source->'compartments'=node->'compartments'
    AND current_source->'projectIds'=node->'projectIds' THEN retained:=retained||jsonb_build_array(node);END IF;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(expanded) obligation(value)
  WHERE obligation.value->>'resourceKind' IN('application_field','external_source','session_context_revision','crm_event','private_transcript')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(retained) kept(value) WHERE
   (kept.value->>'resourceKind',kept.value->>'resourceId',kept.value->>'version')=
   (obligation.value->>'resourceKind',obligation.value->>'resourceId',obligation.value->>'version'))) THEN
  RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 source_scope:=jsonb_build_object('workspaceId',w,'userId',target->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects);
 RETURN jsonb_build_object('scope',source_scope,'retained',retained);
END $page_thread_body$;
BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)'::regprocedure;
 IF encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM '79334fe976edd0cf5d99ec245769205dadd424b7a2f268d7a1d1b89c4b6098d5'
  OR NOT EXISTS(SELECT 1 FROM pg_temp.page_thread_originals original WHERE original.oid=routine.oid
   AND original.expected_body=routine.prosrc AND original.metadata=to_jsonb(routine)-'prosrc')
 THEN RAISE EXCEPTION 'page_thread_predecessor_changed: prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)';END IF;
 IF encode(sha256(convert_to(successor,'UTF8')),'hex') IS DISTINCT FROM '80ef637a811a4842350aa8bc567c45ca18939aa6a7a898bfdb35763043c70889'
 THEN RAISE EXCEPTION 'page_thread_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(routine.oid),routine.prosrc,successor);
 UPDATE pg_temp.page_thread_originals SET expected_body=successor WHERE oid=routine.oid;
END $page_thread_patch$;

DO $page_thread_patch$
DECLARE routine pg_proc;successor constant text:=$page_thread_body$
BEGIN
 IF k IN('page_event_changed','page_event_destination','page_live_changed','page_live_destination') THEN
  RETURN read_page_derivation_source(w,k,i)||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
 END IF;
 IF k='private_transcript' THEN RETURN read_entity_derivation_source(w,k,i);END IF;
 -- Recording privacy admission precedes body selection.
 IF NOT recording_source_read_allowed(w,k,i) THEN RETURN NULL;END IF;
 IF k='knowledge_entry_revision' THEN
  IF knowledge_revision_scope_allowed(w,i) IS NOT TRUE THEN RETURN NULL;END IF;
  RETURN read_scope_source(w,k,i);
 END IF;
 RETURN read_admitted_native_scope_snapshot_before_knowledge_versions(w,k,i);
END $page_thread_body$;
BEGIN
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid='read_admitted_native_scope_snapshot(uuid,text,uuid)'::regprocedure;
 IF encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM '97c1bdcbd5ce7459e7cc1119757bf6e5b0531dff9fdee02dce2c4980b94eda05'
  OR NOT EXISTS(SELECT 1 FROM pg_temp.page_thread_originals original WHERE original.oid=routine.oid
   AND original.expected_body=routine.prosrc AND original.metadata=to_jsonb(routine)-'prosrc')
 THEN RAISE EXCEPTION 'page_thread_predecessor_changed: read_admitted_native_scope_snapshot(uuid,text,uuid)';END IF;
 IF encode(sha256(convert_to(successor,'UTF8')),'hex') IS DISTINCT FROM '9bb8cbfb739df75d85cfd47d5c6662a1c23808c729c599b6f0479f2b0ebb1a0e'
 THEN RAISE EXCEPTION 'page_thread_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(routine.oid),routine.prosrc,successor);
 UPDATE pg_temp.page_thread_originals SET expected_body=successor WHERE oid=routine.oid;
END $page_thread_patch$;
DO $controlled_repin$
<<controlled_repin>>
DECLARE previous record;caller record;body text;round integer;changed boolean;
BEGIN
 FOR round IN 1..64 LOOP
  RAISE NOTICE 'Page thread source authority: authenticated pin round %',round;
  changed:=false;
  IF EXISTS(SELECT 1 FROM pg_temp.page_thread_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
  THEN RAISE EXCEPTION 'page_thread_authenticated_code_changed';END IF;
  FOR previous IN SELECT o.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM pg_temp.page_thread_originals o JOIN pg_proc p ON p.oid=o.oid WHERE o.body IS DISTINCT FROM p.prosrc
  LOOP
   FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid AND
    (position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0)
   LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_temp.page_thread_originals o WHERE o.oid=caller.oid AND o.expected_body=caller.prosrc)
    THEN RAISE EXCEPTION 'page_thread_unauthenticated_pin_consumer: %',caller.oid::regprocedure;END IF;
    body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
    IF body IS DISTINCT FROM caller.prosrc THEN
     EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);
     UPDATE pg_temp.page_thread_originals SET expected_body=controlled_repin.body WHERE oid=caller.oid;
     changed:=true;
    END IF;
   END LOOP;
   UPDATE pg_temp.page_thread_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
    fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  IF NOT changed THEN EXIT;END IF;
  IF round=64 THEN RAISE EXCEPTION 'page_thread_pin_cycle';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.page_thread_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
 THEN RAISE EXCEPTION 'page_thread_successor_code_changed';END IF;
END $controlled_repin$;
DO $reference_rows$
<<reference_rows>>
DECLARE routine_row pg_proc;initial_body text;body text;member_oids oid[];
 columns_sql text;row_sql text;comparisons text;catalog_shape jsonb;rows_sql text;
 row_start integer;row_end integer;tail text;
BEGIN
 SELECT * INTO STRICT routine_row FROM pg_proc WHERE oid='application_native_field_reference_helpers_current()'::regprocedure;
 SELECT o.initial_body INTO STRICT initial_body FROM pg_temp.page_thread_originals o
 WHERE o.oid=reference_rows.routine_row.oid AND o.expected_body=reference_rows.routine_row.prosrc
  AND o.metadata=to_jsonb(reference_rows.routine_row)-'prosrc';
 SELECT array_agg(to_regprocedure('public.'||r.signature)::oid) INTO member_oids FROM unnest(ARRAY['agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','application_current_field_snapshot(uuid,uuid)','application_empty_query_helpers_current()','application_empty_query_worklist_current(uuid,jsonb)','application_empty_query_worklist_reset(jsonb)','application_field_digest(jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','application_field_resource_uuid(text)','application_memory_field_keys()','application_memory_field_state(uuid,uuid,text[])','application_memory_field_state_before_successor(uuid,uuid,text[])','application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','application_memory_history_status(uuid,uuid,text)','application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','application_memory_query_context(uuid)','application_memory_query_domain_state(uuid,uuid,text[])','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','application_memory_statement_state(uuid,uuid,text[],jsonb)','application_native_catalog_port_valid(regprocedure)','application_native_dependency_batch_helpers_current()','application_native_field_catalog_for(uuid,jsonb,text)','application_native_field_contract_before_catalog(uuid,jsonb,text,text)','application_native_field_contract_for(uuid,jsonb,text,text)','application_native_field_rule_allows(jsonb,text[])','application_native_file_capture_helpers_current()','application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_record_port_valid(regprocedure)','application_native_same_destination(uuid,text,uuid,text,uuid)','application_native_source_edges_dispatch(uuid,text,uuid,text)','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_intersection(jsonb,jsonb)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_reader_envelope_visible(uuid,jsonb)','application_recorded_field_root_capture(uuid,uuid,text,integer)','application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','application_scope_lineage(uuid,text[],uuid[],text[])','application_scope_source_edges(uuid,text,uuid,text)','application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','application_session_eval_field(uuid,uuid,text,jsonb)','application_session_eval_scope(uuid,text,uuid,text,jsonb)','assistant_placement_visible(uuid,uuid)','capture_native_session_projection_batch(uuid,uuid,integer,text)','crm_capture_erasure_effect()','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','guard_application_field_lineage()','guard_external_source_derivation()','guard_page_derivation_receipts()','guard_session_context_lineage()','guard_session_recording_privacy()','guard_workflow_derivation_receipts()','knowledge_version_source_edges(uuid,text,uuid,text)','legacy_assistant_team_compartments(uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','project_member_live(uuid,text,uuid)','read_admitted_native_scope_snapshot(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','read_application_field_dependencies(uuid,text[],uuid[],text[])','read_entity_derivation_source(uuid,text,uuid)','read_entity_derivation_source_before_application_fields(uuid,text,uuid)','read_entity_derivation_source_before_blueprint(uuid,text,uuid)','read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','read_entity_derivation_source_before_browser_session(uuid,text,uuid)','read_entity_derivation_source_before_capture(uuid,text,uuid)','read_entity_derivation_source_before_conversation(uuid,text,uuid)','read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','read_entity_derivation_source_before_page(uuid,text,uuid)','read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','read_entity_derivation_source_before_recordings(uuid,text,uuid)','read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])','read_media_parent_snapshot(uuid,text,uuid)','read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','read_media_parent_snapshot_before_conversation(uuid,text,uuid)','read_media_parent_snapshot_before_page(uuid,text,uuid)','read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_field_snapshots(uuid,uuid[],text[])','read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','read_resource_page_dependencies(uuid,text,uuid,text)','read_scope_source(uuid,text,uuid)','read_scope_source_before_application_fields(uuid,text,uuid)','read_scope_source_before_browser_profile(uuid,text,uuid)','read_scope_source_before_browser_session(uuid,text,uuid)','read_scope_source_before_external(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','read_scope_source_before_page(uuid,text,uuid)','read_scope_source_before_persistent_context(uuid,text,uuid)','read_scope_source_before_routines(uuid,text,uuid)','read_scope_source_before_workflow_run(uuid,text,uuid)','recording_source_read_allowed(uuid,text,uuid)','refuse_quarantined_recording_message()','scope_review_state_held(text,uuid)','scope_source_ancestors(uuid,text,uuid)','scope_source_ancestors_before_browser_profile(uuid,text,uuid)','scope_source_ancestors_before_browser_session(uuid,text,uuid)','scope_source_ancestors_before_workflow_run(uuid,text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','scope_source_table_before_media(text)','scope_source_table_before_persistent_context(text)','sensitivity_rank(text)','session_recording_read_allowed(uuid)','validate_application_field_dependencies()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_workflow_derivation_dependencies()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]) r(signature);
 IF cardinality(member_oids)<>156 OR array_position(member_oids,NULL) IS NOT NULL OR
  (SELECT count(*) FROM pg_temp.page_thread_originals o JOIN pg_proc member ON member.oid=o.oid
   WHERE member.oid=ANY(member_oids) AND member.prosrc=o.expected_body AND (to_jsonb(member)-'prosrc')=o.metadata)<>156
 THEN RAISE EXCEPTION 'page_thread_reference_members_changed';END IF;
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
 THEN RAISE EXCEPTION 'page_thread_reference_template_changed';END IF;
 row_end:=length(initial_body)-position(reverse(tail) IN reverse(initial_body))-length(tail)+2;
 IF row_end<=row_start THEN RAISE EXCEPTION 'page_thread_reference_row_bounds_changed';END IF;
 EXECUTE 'SELECT string_agg(''(''||'||row_sql||'||'')'','','' ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1)' INTO rows_sql USING member_oids;
 body:=left(initial_body,row_start-1)||rows_sql||substring(initial_body FROM row_end);
 EXECUTE replace(pg_get_functiondef(reference_rows.routine_row.oid),reference_rows.routine_row.prosrc,body);
 UPDATE pg_temp.page_thread_originals SET expected_body=reference_rows.body WHERE oid=reference_rows.routine_row.oid;
END $reference_rows$;

DO $controlled_repin$
<<controlled_repin>>
DECLARE previous record;caller record;body text;round integer;changed boolean;
BEGIN
 FOR round IN 1..64 LOOP
  RAISE NOTICE 'Page thread source authority: authenticated pin round %',round;
  changed:=false;
  IF EXISTS(SELECT 1 FROM pg_temp.page_thread_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
  THEN RAISE EXCEPTION 'page_thread_authenticated_code_changed';END IF;
  FOR previous IN SELECT o.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM pg_temp.page_thread_originals o JOIN pg_proc p ON p.oid=o.oid WHERE o.body IS DISTINCT FROM p.prosrc
  LOOP
   FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid AND
    (position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0)
   LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_temp.page_thread_originals o WHERE o.oid=caller.oid AND o.expected_body=caller.prosrc)
    THEN RAISE EXCEPTION 'page_thread_unauthenticated_pin_consumer: %',caller.oid::regprocedure;END IF;
    body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
    IF body IS DISTINCT FROM caller.prosrc THEN
     EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);
     UPDATE pg_temp.page_thread_originals SET expected_body=controlled_repin.body WHERE oid=caller.oid;
     changed:=true;
    END IF;
   END LOOP;
   UPDATE pg_temp.page_thread_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
    fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  IF NOT changed THEN EXIT;END IF;
  IF round=64 THEN RAISE EXCEPTION 'page_thread_pin_cycle';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.page_thread_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
 THEN RAISE EXCEPTION 'page_thread_successor_code_changed';END IF;
END $controlled_repin$;
UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN pg_temp.page_thread_originals o ON o.oid=p.oid AND o.expected_body=p.prosrc AND o.metadata=to_jsonb(p)-'prosrc'
 WHERE p.oid=to_regprocedure(h.signature) AND o.initial_body IS DISTINCT FROM p.prosrc;
-- Advance only the independently authenticated display pin for the changed leaf.
UPDATE private_session_display_contract c SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN pg_temp.page_thread_originals o ON o.oid=p.oid
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
    ||values_sql||' LEFT JOIN pg_catalog.pg_proc p ON p.oid=m.oid LEFT JOIN pg_temp.page_thread_originals o ON o.oid=m.oid WHERE NOT('||comparisons||') LIMIT 12) differences' INTO members;
   member_drift:=member_drift||jsonb_build_object(guard_signature,members);
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(h.signature),'[]'::jsonb) INTO members FROM native_turn_contract_helpers h
 LEFT JOIN pg_proc p ON p.oid=to_regprocedure(h.signature)
 WHERE h.fingerprint IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex');
 RAISE EXCEPTION 'page_thread_successor_contract_changed: %',jsonb_build_object('guards',guard_states,'flatMembers',member_drift,'readerMembers',members);
END $successor_diagnostics$;
COMMIT;
