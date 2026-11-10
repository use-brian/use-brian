-- [COMP:api/native-chat-read-cost] Plan current native field metadata through complete independent proofs.
BEGIN;
-- Authenticate the existing kernel before changing its field catalog.
DO $transcript_contract$
DECLARE signature text; ok boolean;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'native_field_planning_dependency_changed: %',signature;END IF;
 END LOOP;
END $transcript_contract$;
CREATE TEMP TABLE pg_temp.native_field_planning_originals ON COMMIT DROP AS
 SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p)-'prosrc' metadata,
 p.prosrc body,p.prosrc expected_body,quote_literal(p.prosrc) quoted_body,
 encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint,
 encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash,p.prosrc initial_body
 FROM pg_proc p WHERE p.oid::regprocedure::text=ANY(ARRAY['read_native_session_field_dependencies(uuid,text[],uuid[],text[])','publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)','agent_mutation_scope_allows(text[])','agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','application_current_field_snapshot(uuid,uuid)','application_empty_query_facades_current()','application_empty_query_helpers_current()','application_empty_query_worklist_current(uuid,jsonb)','application_empty_query_worklist_reset(jsonb)','application_field_digest(jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','application_field_resource_uuid(text)','application_materialize_field_envelope(uuid,jsonb,integer)','application_memory_field_keys()','application_memory_field_state(uuid,uuid,text[])','application_memory_field_state_before_successor(uuid,uuid,text[])','application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','application_memory_history_status(uuid,uuid,text)','application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','application_memory_query_context(uuid)','application_memory_query_domain_state(uuid,uuid,text[])','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','application_memory_statement_state(uuid,uuid,text[],jsonb)','application_native_catalog_port_valid(regprocedure)','application_native_context_fields_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','application_native_dependency_batch_helpers_current()','application_native_field_catalog_for(uuid,jsonb,text)','application_native_field_contract_before_catalog(uuid,jsonb,text,text)','application_native_field_contract_for(uuid,jsonb,text,text)','application_native_field_reference_helpers_current()','application_native_field_rule_allows(jsonb,text[])','application_native_file_capture_helpers_current()','application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_record_port_valid(regprocedure)','application_native_root_cover(uuid,jsonb)','application_native_same_destination(uuid,text,uuid,text,uuid)','application_native_session_query_acquisition_current()','application_native_source_edges_dispatch(uuid,text,uuid,text)','application_native_title_acquisition_helpers_current()','application_native_title_group_helpers_current()','application_native_transcript_prepare_helpers_current()','application_native_worklist_helpers_current()','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_admits_point(jsonb,jsonb)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_escape(jsonb[],integer,text[],text[],text[],integer)','application_query_scope_intersection(jsonb,jsonb)','application_query_scope_union_contains(jsonb,jsonb,integer)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_reader_envelope_visible(uuid,jsonb)','application_recorded_field_root_capture(uuid,uuid,text,integer)','application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','application_scope_lineage(uuid,text[],uuid[],text[])','application_scope_source_edges(uuid,text,uuid,text)','application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','application_session_eval_domain(uuid,text,uuid,text[],jsonb)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','application_session_eval_field(uuid,uuid,text,jsonb)','application_session_eval_point_state(uuid,text,uuid,text[],jsonb)','application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','application_session_eval_scope(uuid,text,uuid,text,jsonb)','application_session_eval_scope_current(uuid,text,uuid,text,jsonb)','application_session_field_keys(text)','application_session_query_bounds(uuid,jsonb)','application_session_query_parent(uuid,uuid)','application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)','assistant_placement_visible(uuid,uuid)','capture_native_session_projection_batch(uuid,uuid,integer,text)','capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)','crm_capture_erasure_effect()','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','external_source_snapshot(uuid,uuid)','guard_application_field_lineage()','guard_external_source_derivation()','guard_page_derivation_receipts()','guard_session_context_lineage()','guard_session_recording_privacy()','guard_workflow_derivation_receipts()','knowledge_version_source_edges(uuid,text,uuid,text)','legacy_assistant_team_compartments(uuid)','lock_native_session_context_publication(uuid,uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','native_detached_eval_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_detached_eval_field(uuid,uuid,text,jsonb,jsonb)','native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_detached_eval_scope(uuid,text,uuid,text,jsonb,jsonb)','native_detached_lineage(uuid,text[],uuid[],text[],jsonb)','native_detached_snapshot(uuid,text,uuid,text,jsonb)','native_personal_title_group_acquisition(uuid,uuid[],uuid[])','native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_context()','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_event_frame(uuid,uuid)','native_turn_field_reference(uuid,uuid,uuid,text)','native_turn_frame_immutable()','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_key(jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_page_event(jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_privacy_edges(uuid,jsonb)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','native_turn_validate_frame_pair()','native_worklist_context(uuid,jsonb)','native_worklist_current(uuid,text,uuid,jsonb)','native_worklist_current_application_sources(uuid,text,uuid,jsonb)','native_worklist_current_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_current_persistent_context(uuid,text,uuid,jsonb)','native_worklist_current_public_share(uuid,text,uuid,jsonb)','native_worklist_edges(uuid,jsonb)','native_worklist_eval_domain(uuid,text,uuid,text[],jsonb)','native_worklist_eval_envelope(uuid,text,uuid,text,text[],jsonb)','native_worklist_eval_field(uuid,uuid,text,jsonb)','native_worklist_eval_point_state(uuid,text,uuid,text[],jsonb)','native_worklist_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','native_worklist_eval_scope(uuid,text,uuid,text,jsonb)','native_worklist_frame_current(uuid,jsonb)','native_worklist_lineage(uuid,text[],uuid[],text[],jsonb)','native_worklist_page_dependencies(uuid,text,uuid,text,jsonb)','native_worklist_seed(uuid,jsonb)','native_worklist_snapshot(uuid,text,uuid,text,jsonb)','native_worklist_source(uuid,text,uuid,jsonb)','native_worklist_source_application_fields(uuid,text,uuid,jsonb)','native_worklist_source_blueprint(uuid,text,uuid,jsonb)','native_worklist_source_browser_profile(uuid,text,uuid,jsonb)','native_worklist_source_browser_session(uuid,text,uuid,jsonb)','native_worklist_source_capture(uuid,text,uuid,jsonb)','native_worklist_source_conversation(uuid,text,uuid,jsonb)','native_worklist_source_engineering_archive(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_source_parent(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_source_memory_successor(uuid,text,uuid,jsonb)','native_worklist_source_page(uuid,text,uuid,jsonb)','native_worklist_source_persistent_context(uuid,text,uuid,jsonb)','native_worklist_source_primitive_v2(uuid,text,uuid,jsonb)','native_worklist_source_recordings(uuid,text,uuid,jsonb)','native_worklist_source_workflow_run(uuid,text,uuid,jsonb)','observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','project_labels_allowed(jsonb,uuid,text[],boolean)','project_member_live(uuid,text,uuid)','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_admitted_native_scope_snapshot(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','read_application_field_dependencies(uuid,text[],uuid[],text[])','read_entity_derivation_source(uuid,text,uuid)','read_entity_derivation_source_before_application_fields(uuid,text,uuid)','read_entity_derivation_source_before_blueprint(uuid,text,uuid)','read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','read_entity_derivation_source_before_browser_session(uuid,text,uuid)','read_entity_derivation_source_before_capture(uuid,text,uuid)','read_entity_derivation_source_before_conversation(uuid,text,uuid)','read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','read_entity_derivation_source_before_page(uuid,text,uuid)','read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','read_entity_derivation_source_before_recordings(uuid,text,uuid)','read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])','read_media_parent_snapshot(uuid,text,uuid)','read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','read_media_parent_snapshot_before_conversation(uuid,text,uuid)','read_media_parent_snapshot_before_page(uuid,text,uuid)','read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)','read_native_application_session_topics(uuid,uuid,integer)','read_native_attended_memory_evidence(uuid,text[],uuid[],text[])','read_native_context_field_currents(uuid,jsonb)','read_native_covered_memory_frame(uuid,text[],uuid[],text[],boolean)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_covered_session_frame(uuid,text[],uuid[],text[])','read_native_empty_query_evidence(uuid,text[],uuid[],text[])','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_field_snapshots(uuid,uuid[],text[])','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_file_worklist_evidence(uuid,text[],uuid[],text[],boolean,boolean)','read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_personal_title_group(uuid,uuid[],uuid[])','read_native_personal_title_group_evidence(uuid,uuid[],uuid[])','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_field_snapshots(uuid,uuid[],text[])','read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_session_query_evidence(uuid,uuid,integer,integer)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_resource_page_dependencies(uuid,text,uuid,text)','read_scope_source(uuid,text,uuid)','read_scope_source_before_application_fields(uuid,text,uuid)','read_scope_source_before_browser_profile(uuid,text,uuid)','read_scope_source_before_browser_session(uuid,text,uuid)','read_scope_source_before_external(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','read_scope_source_before_page(uuid,text,uuid)','read_scope_source_before_persistent_context(uuid,text,uuid)','read_scope_source_before_routines(uuid,text,uuid)','read_scope_source_before_workflow_run(uuid,text,uuid)','read_session_context_empty_query_revision(uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_revision(uuid,uuid)','read_session_title_revision(uuid,uuid,uuid)','recording_source_read_allowed(uuid,text,uuid)','refuse_quarantined_recording_message()','scope_review_state_held(text,uuid)','scope_source_ancestors(uuid,text,uuid)','scope_source_ancestors_before_browser_profile(uuid,text,uuid)','scope_source_ancestors_before_browser_session(uuid,text,uuid)','scope_source_ancestors_before_workflow_run(uuid,text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','scope_source_table_before_media(text)','scope_source_table_before_persistent_context(text)','sensitivity_rank(text)','session_context_empty_query_revision_allowed(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_parent_snapshot(uuid,uuid)','session_context_payload_shape(text,jsonb)','session_context_revision_allowed(uuid,uuid)','session_context_revision_native(uuid,uuid)','session_context_revision_snapshot(uuid,uuid)','session_personal_audience(sessions)','session_project_audience(sessions,boolean)','session_recording_read_allowed(uuid)','session_workspace_audience(sessions)','validate_application_field_dependencies()','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_session_context_revision_pair()','validate_workflow_derivation_dependencies()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]);

DO $native_field_planning$
DECLARE dependency_target regprocedure:='public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure;
 snapshot_target regprocedure:='public.read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure;
 routine pg_proc;original text;successor text;
 dependency_before constant text:=$dependency_before$ -- Mixed native ancestry discovery is query planning only. Each unchanged
 -- canonical reader must admit its entire original cohort. No allow packet,
 -- current-source receipt, source descriptor or root may be supplied by callers.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 2 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND actor IS NOT NULL AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
   AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))
  AND native_turn_helpers_current() IS TRUE AND application_memory_statement_helpers_current() IS TRUE
  AND (SELECT count(*)=count(DISTINCT (root.kind,root.id,root.version)) FROM unnest(kinds,ids,versions) root(kind,id,version)) THEN
  SELECT array_agg(root.kind ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.id ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.version ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.kind ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   array_agg(root.id ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   array_agg(root.version ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   bool_and(CASE WHEN root.kind='application_field' THEN f.id IS NOT NULL
    AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.selected_version IS NULL
    AND (f.type_key='memory' AND f.selection='query_domain' OR f.type_key IN('session_message','session_message_annotation')
     AND f.selection IN('read','query','identity','query_domain'))
    ELSE root.kind IN('session_message','session_context_revision') END)
  INTO planning_memory_kinds,planning_memory_ids,planning_memory_versions,planning_native_kinds,planning_native_ids,planning_native_versions,planning_eligible
  FROM unnest(kinds,ids,versions) WITH ORDINALITY root(kind,id,version,ord)
  LEFT JOIN application_field_resources f ON root.kind='application_field' AND f.workspace_id=w AND f.id=root.id;
  IF planning_eligible IS TRUE AND cardinality(planning_memory_ids)>0 AND cardinality(planning_native_ids)>0 THEN
   planning_context:=native_turn_context();planning_memory_context:=application_memory_query_context(w);
   SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO planning_lineage
    FROM application_scope_lineage(w,kinds,ids,versions) n;
   -- A Memory cohort with transcript/external ancestry is not this planning profile.
   IF planning_memory_context IS NOT NULL AND jsonb_array_length(planning_lineage)<=4096
    AND NOT EXISTS(SELECT 1 FROM application_scope_lineage(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions) n
     LEFT JOIN application_field_resources f ON n.kind='application_field' AND f.workspace_id=w AND f.id=n.id
     WHERE n.kind NOT IN('application_field','application_query_domain','memory') OR n.kind='application_field'
      AND (f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key<>'memory')) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source) ORDER BY d.node_version,d.source::text),'[]')
     INTO planning_rows FROM read_application_field_dependencies(w,kinds,ids,versions) d;
    SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source) ORDER BY d.node_version,d.source::text),'[]')
     INTO planning_memory_rows FROM read_application_field_dependencies(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions) d;
    SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source) ORDER BY d.node_version,d.source::text),'[]')
     INTO planning_native_rows FROM read_application_field_dependencies(w,planning_native_kinds,planning_native_ids,planning_native_versions) d;
    planning_memory_proof:=read_native_attended_memory_evidence(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions);
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind',root.kind,'id',root.id,'version',root.version) ORDER BY root.ord),'[]')
     INTO planning_native_roots FROM unnest(planning_native_kinds,planning_native_ids,planning_native_versions) WITH ORDINALITY root(kind,id,version,ord);
    planning_native_proof:=read_native_turn_scope_evidence(w,planning_native_roots);
    IF planning_memory_proof->>'admitted'='true' AND planning_native_proof->>'admitted'='true'
     AND jsonb_typeof(planning_memory_proof->'immutable')='array' AND jsonb_typeof(planning_native_proof->'immutable')='array'
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements((planning_memory_proof->'immutable')||(planning_native_proof->'immutable')) descriptor
      GROUP BY descriptor->>'resourceKind',descriptor->>'resourceId',descriptor->>'version' HAVING count(DISTINCT descriptor)>1) THEN
     -- Each cohort's exact immutable field metadata must come from that cohort's
     -- complete proof; a descriptor from the other proof supplies no admission.
     planning_eligible:=NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(planning_memory_rows) entry CROSS JOIN LATERAL(SELECT entry->'source' source,entry->>'version' node_version) d
       WHERE d.source IS NULL OR d.source->>'resourceKind' IS DISTINCT FROM 'application_field'
        OR d.source->>'version' IS DISTINCT FROM d.node_version OR d.source->>'workspaceId' IS DISTINCT FROM w::text
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(planning_memory_proof->'immutable') actual WHERE actual=d.source)
      UNION ALL
      SELECT 1 FROM jsonb_array_elements(planning_native_rows) entry CROSS JOIN LATERAL(SELECT entry->'source' source,entry->>'version' node_version) d
       WHERE d.source IS NULL OR d.source->>'resourceKind' IS DISTINCT FROM 'application_field'
        OR d.source->>'version' IS DISTINCT FROM d.node_version OR d.source->>'workspaceId' IS DISTINCT FROM w::text
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(planning_native_proof->'immutable') actual WHERE actual=d.source));
     IF planning_eligible IS TRUE AND planning_rows IS NOT DISTINCT FROM (
       SELECT coalesce(jsonb_agg(value ORDER BY value->>'version',(value->'source')::text),'[]')
       FROM(SELECT DISTINCT value FROM jsonb_array_elements(planning_memory_rows||planning_native_rows)) combined)
      AND native_turn_context() IS NOT DISTINCT FROM planning_context
      AND application_memory_query_context(w) IS NOT DISTINCT FROM planning_memory_context
      AND native_turn_helpers_current() IS TRUE AND application_memory_statement_helpers_current() IS TRUE
      AND planning_lineage IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]')
       FROM application_scope_lineage(w,kinds,ids,versions) n)
      AND planning_rows IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source)
       ORDER BY d.node_version,d.source::text),'[]') FROM read_application_field_dependencies(w,kinds,ids,versions) d) THEN
      RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(planning_rows);
      RETURN;
     END IF;
    END IF;
   END IF;
  END IF;
 END IF;
 -- Unsupported planning retains every original root and the original evaluator.
$dependency_before$;
 dependency_after constant text:=$dependency_after$ -- Attempt this additional metadata plan only when the existing globally
 -- empty Memory profile is ineligible. Empty workspaces keep8244's path below.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND array_ndims(kinds)=1 AND array_lower(kinds,1)=1
  AND array_ndims(ids)=1 AND array_lower(ids,1)=1 AND array_ndims(versions)=1 AND array_lower(versions,1)=1
  AND actor IS NOT NULL AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
   AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))
  AND (EXISTS(SELECT 1 FROM memories WHERE workspace_id=w)
   OR EXISTS(SELECT 1 FROM application_native_resource_owners WHERE workspace_id=w
    AND origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource_type='memory'))
  AND native_turn_helpers_current() IS TRUE AND application_memory_statement_helpers_current() IS TRUE
  AND (SELECT count(*)=count(DISTINCT (root.kind,root.id,root.version)) FROM unnest(kinds,ids,versions) root(kind,id,version))
  AND NOT EXISTS(SELECT 1 FROM unnest(kinds,ids,versions) root(kind,id,version)
   LEFT JOIN application_field_resources f ON root.kind='application_field' AND f.workspace_id=w AND f.id=root.id
   WHERE CASE WHEN root.kind='application_field' THEN f.id IS NOT NULL AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb
    AND f.type_key IN('session_message','session_message_annotation') AND f.selected_version IS NULL
    AND f.selection IN('read','query','identity','query_domain') ELSE root.kind IN('session_message','session_context_revision') END IS NOT TRUE) THEN
  planning_context:=native_turn_context();
  SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO planning_lineage
   FROM application_scope_lineage(w,kinds,ids,versions) n;
  SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source) ORDER BY d.node_version,d.source::text),'[]')
   INTO planning_rows FROM read_application_field_dependencies(w,kinds,ids,versions) d;
  SELECT jsonb_agg(jsonb_build_object('kind',root.kind,'id',root.id,'version',root.version) ORDER BY root.ord)
   INTO planning_native_roots FROM unnest(kinds,ids,versions) WITH ORDINALITY root(kind,id,version,ord);
  planning_native_proof:=read_native_turn_scope_evidence(w,planning_native_roots);
  IF planning_native_proof->>'admitted'='true' AND jsonb_typeof(planning_native_proof->'immutable')='array'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(planning_native_proof->'immutable') descriptor
    GROUP BY descriptor->>'resourceKind',descriptor->>'resourceId',descriptor->>'version' HAVING count(DISTINCT descriptor)>1)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(planning_rows) entry
    WHERE entry->'source' IS NULL OR entry->'source'='null'::jsonb
     OR entry#>>'{source,resourceKind}' IS DISTINCT FROM 'application_field'
     OR entry#>>'{source,version}' IS DISTINCT FROM entry->>'version' OR entry#>>'{source,workspaceId}' IS DISTINCT FROM w::text
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(planning_native_proof->'immutable') actual WHERE actual=entry->'source'))
   AND native_turn_context() IS NOT DISTINCT FROM planning_context
   AND native_turn_helpers_current() IS TRUE AND application_memory_statement_helpers_current() IS TRUE
   AND planning_lineage IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]')
    FROM application_scope_lineage(w,kinds,ids,versions) n)
   AND planning_rows IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source)
    ORDER BY d.node_version,d.source::text),'[]') FROM read_application_field_dependencies(w,kinds,ids,versions) d) THEN
   RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(planning_rows);
   RETURN;
  END IF;
 END IF;

 -- Mixed native ancestry discovery is query planning only. Each unchanged
 -- canonical reader must admit its entire original cohort. No allow packet,
 -- current-source receipt, source descriptor or root may be supplied by callers.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 2 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND actor IS NOT NULL AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
   AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))
  AND native_turn_helpers_current() IS TRUE AND application_memory_statement_helpers_current() IS TRUE
  AND (SELECT count(*)=count(DISTINCT (root.kind,root.id,root.version)) FROM unnest(kinds,ids,versions) root(kind,id,version)) THEN
  SELECT array_agg(root.kind ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.id ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.version ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.kind ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   array_agg(root.id ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   array_agg(root.version ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   bool_and(CASE WHEN root.kind='application_field' THEN f.id IS NOT NULL
    AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.selected_version IS NULL
    AND (f.type_key='memory' AND f.selection='query_domain' OR f.type_key IN('session_message','session_message_annotation')
     AND f.selection IN('read','query','identity','query_domain'))
    ELSE root.kind IN('session_message','session_context_revision') END)
  INTO planning_memory_kinds,planning_memory_ids,planning_memory_versions,planning_native_kinds,planning_native_ids,planning_native_versions,planning_eligible
  FROM unnest(kinds,ids,versions) WITH ORDINALITY root(kind,id,version,ord)
  LEFT JOIN application_field_resources f ON root.kind='application_field' AND f.workspace_id=w AND f.id=root.id;
  IF planning_eligible IS TRUE AND cardinality(planning_memory_ids)>0 AND cardinality(planning_native_ids)>0 THEN
   planning_context:=native_turn_context();planning_memory_context:=application_memory_query_context(w);
   SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO planning_lineage
    FROM application_scope_lineage(w,kinds,ids,versions) n;
   -- A Memory cohort with transcript/external ancestry is not this planning profile.
   IF planning_memory_context IS NOT NULL AND jsonb_array_length(planning_lineage)<=4096
    AND NOT EXISTS(SELECT 1 FROM application_scope_lineage(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions) n
     LEFT JOIN application_field_resources f ON n.kind='application_field' AND f.workspace_id=w AND f.id=n.id
     WHERE n.kind NOT IN('application_field','application_query_domain','memory') OR n.kind='application_field'
      AND (f.id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key<>'memory')) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source) ORDER BY d.node_version,d.source::text),'[]')
     INTO planning_rows FROM read_application_field_dependencies(w,kinds,ids,versions) d;
    SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source) ORDER BY d.node_version,d.source::text),'[]')
     INTO planning_memory_rows FROM read_application_field_dependencies(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions) d;
    SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source) ORDER BY d.node_version,d.source::text),'[]')
     INTO planning_native_rows FROM read_application_field_dependencies(w,planning_native_kinds,planning_native_ids,planning_native_versions) d;
    planning_memory_proof:=read_native_attended_memory_evidence(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions);
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind',root.kind,'id',root.id,'version',root.version) ORDER BY root.ord),'[]')
     INTO planning_native_roots FROM unnest(planning_native_kinds,planning_native_ids,planning_native_versions) WITH ORDINALITY root(kind,id,version,ord);
    planning_native_proof:=read_native_turn_scope_evidence(w,planning_native_roots);
    IF planning_memory_proof->>'admitted'='true' AND planning_native_proof->>'admitted'='true'
     AND jsonb_typeof(planning_memory_proof->'immutable')='array' AND jsonb_typeof(planning_native_proof->'immutable')='array'
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements((planning_memory_proof->'immutable')||(planning_native_proof->'immutable')) descriptor
      GROUP BY descriptor->>'resourceKind',descriptor->>'resourceId',descriptor->>'version' HAVING count(DISTINCT descriptor)>1) THEN
     -- Each cohort's exact immutable field metadata must come from that cohort's
     -- complete proof; a descriptor from the other proof supplies no admission.
     planning_eligible:=NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(planning_memory_rows) entry CROSS JOIN LATERAL(SELECT entry->'source' source,entry->>'version' node_version) d
       WHERE d.source IS NULL OR d.source->>'resourceKind' IS DISTINCT FROM 'application_field'
        OR d.source->>'version' IS DISTINCT FROM d.node_version OR d.source->>'workspaceId' IS DISTINCT FROM w::text
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(planning_memory_proof->'immutable') actual WHERE actual=d.source)
      UNION ALL
      SELECT 1 FROM jsonb_array_elements(planning_native_rows) entry CROSS JOIN LATERAL(SELECT entry->'source' source,entry->>'version' node_version) d
       WHERE d.source IS NULL OR d.source->>'resourceKind' IS DISTINCT FROM 'application_field'
        OR d.source->>'version' IS DISTINCT FROM d.node_version OR d.source->>'workspaceId' IS DISTINCT FROM w::text
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(planning_native_proof->'immutable') actual WHERE actual=d.source));
     IF planning_eligible IS TRUE AND planning_rows IS NOT DISTINCT FROM (
       SELECT coalesce(jsonb_agg(value ORDER BY value->>'version',(value->'source')::text),'[]')
       FROM(SELECT DISTINCT value FROM jsonb_array_elements(planning_memory_rows||planning_native_rows)) combined)
      AND native_turn_context() IS NOT DISTINCT FROM planning_context
      AND application_memory_query_context(w) IS NOT DISTINCT FROM planning_memory_context
      AND native_turn_helpers_current() IS TRUE AND application_memory_statement_helpers_current() IS TRUE
      AND planning_lineage IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]')
       FROM application_scope_lineage(w,kinds,ids,versions) n)
      AND planning_rows IS NOT DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('version',d.node_version,'source',d.source)
       ORDER BY d.node_version,d.source::text),'[]') FROM read_application_field_dependencies(w,kinds,ids,versions) d) THEN
      RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(planning_rows);
      RETURN;
     END IF;
    END IF;
   END IF;
  END IF;
 END IF;
 -- Unsupported planning retains every original root and the original evaluator.
$dependency_after$;
 snapshot_declaration_before constant text:=$snapshot_declaration_before$DECLARE position integer;$snapshot_declaration_before$;
 snapshot_declaration_after constant text:=$snapshot_declaration_after$DECLARE planning_memory_kinds text[];planning_memory_ids uuid[];planning_memory_versions text[];
 planning_native_kinds text[];planning_native_ids uuid[];planning_native_versions text[];planning_eligible boolean;
 planning_context jsonb;planning_memory_context jsonb;planning_lineage jsonb;planning_rows jsonb;planning_memory_rows jsonb;planning_native_rows jsonb;
 planning_memory_proof jsonb;planning_native_proof jsonb;planning_native_roots jsonb;
 planning_kinds text[];planning_native_metadata jsonb;planning_native_metadata_after jsonb;
 planning_memory_proof_after jsonb;planning_memory_lineage_after jsonb;planning_snapshot_rows jsonb;
 position integer;$snapshot_declaration_after$;
 snapshot_anchor constant text:=$snapshot_anchor$ -- This is a NEW complete proof after capture materialization.$snapshot_anchor$;
 snapshot_branch constant text:=$snapshot_branch$ planning_kinds:=ARRAY(SELECT 'application_field'::text FROM unnest(ids));
 -- Current field metadata planning only; an absent Memory cohort supplies no admission packet. Each unchanged
 -- canonical reader must admit its entire original cohort. No allow packet,
 -- current-source receipt, source descriptor or root may be supplied by callers.
 IF planning_kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 4096
  AND cardinality(planning_kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(planning_kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND array_ndims(planning_kinds)=1 AND array_lower(planning_kinds,1)=1
  AND array_ndims(ids)=1 AND array_lower(ids,1)=1 AND array_ndims(versions)=1 AND array_lower(versions,1)=1
  AND actor IS NOT NULL AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
   AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))
  AND (EXISTS(SELECT 1 FROM memories WHERE workspace_id=w)
   OR EXISTS(SELECT 1 FROM application_native_resource_owners WHERE workspace_id=w
    AND origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource_type='memory'))
  AND native_turn_helpers_current() IS TRUE AND application_memory_statement_helpers_current() IS TRUE
  AND (SELECT count(*)=count(DISTINCT (root.kind,root.id,root.version)) FROM unnest(planning_kinds,ids,versions) root(kind,id,version)) THEN
  SELECT array_agg(root.kind ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.id ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.version ORDER BY root.ord) FILTER(WHERE f.type_key='memory'),
   array_agg(root.kind ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   array_agg(root.id ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   array_agg(root.version ORDER BY root.ord) FILTER(WHERE f.type_key IS DISTINCT FROM 'memory'),
   bool_and(CASE WHEN root.kind='application_field' THEN f.id IS NOT NULL
    AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND f.selected_version IS NULL
    AND (f.type_key='memory' AND f.selection='query_domain' OR f.type_key IN('session_message','session_message_annotation')
     AND f.selection IN('read','query','identity','query_domain'))
    ELSE root.kind IN('session_message','session_context_revision') END)
  INTO planning_memory_kinds,planning_memory_ids,planning_memory_versions,planning_native_kinds,planning_native_ids,planning_native_versions,planning_eligible
  FROM unnest(planning_kinds,ids,versions) WITH ORDINALITY root(kind,id,version,ord)
  LEFT JOIN application_field_resources f ON root.kind='application_field' AND f.workspace_id=w AND f.id=root.id;
  IF planning_eligible IS TRUE AND coalesce(cardinality(planning_memory_ids),0)<=100 AND cardinality(planning_native_ids)>0 THEN
   planning_context:=native_turn_context();
   planning_memory_context:=CASE WHEN cardinality(planning_memory_ids)>0 THEN application_memory_query_context(w) END;
   IF cardinality(planning_memory_ids)>0 THEN
    WITH RECURSIVE memory_nodes(kind,id,version) AS(
     SELECT * FROM unnest(planning_memory_kinds,planning_memory_ids,planning_memory_versions)
     UNION SELECT edge.kind,edge.id,edge.version FROM memory_nodes node
      CROSS JOIN LATERAL application_scope_source_edges(w,node.kind,node.id,node.version) edge
    ), bounded AS MATERIALIZED(SELECT * FROM memory_nodes LIMIT 4097)
    SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO planning_lineage FROM bounded n;
   END IF;
   -- A Memory cohort with transcript/external ancestry is not this planning profile.
   IF (coalesce(cardinality(planning_memory_ids),0)=0 OR planning_memory_context#>>'{policy,nativeDefault}'='true') AND (coalesce(cardinality(planning_memory_ids),0)=0 OR jsonb_array_length(planning_lineage)<=4096)
    AND (coalesce(cardinality(planning_memory_ids),0)=0 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(planning_lineage) n
     LEFT JOIN application_field_resources f ON n->>'kind'='application_field' AND f.workspace_id=w AND f.id=(n->>'id')::uuid
     LEFT JOIN application_field_observations o ON n->>'kind'='application_field' AND o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version'
     WHERE n->>'kind' IS NULL OR n->>'id' IS NULL OR n->>'version' IS NULL
      OR n->>'kind' NOT IN('application_field','application_query_domain','memory') OR n->>'kind'='application_field'
       AND (f.id IS NULL OR o.resource_id IS NULL OR f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key<>'memory'))) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('kind',root.kind,'id',root.id,'version',root.version) ORDER BY root.ord),'[]')
     INTO planning_native_roots FROM unnest(planning_native_kinds,planning_native_ids,planning_native_versions) WITH ORDINALITY root(kind,id,version,ord);
    planning_native_metadata:=native_turn_metadata_acquire(w,planning_native_roots,'[]');
    SELECT coalesce(jsonb_agg(jsonb_build_object('ord',root.ord,'memory',f.type_key='memory',
     'source',o.source_scope||jsonb_build_object('resourceKind','application_field','resourceId',o.resource_id,'version',o.version)) ORDER BY root.ord),'[]')
     INTO planning_snapshot_rows FROM unnest(ids,versions) WITH ORDINALITY root(id,version,ord)
     LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=root.id
     LEFT JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=root.id AND o.version=root.version;
    IF cardinality(planning_memory_ids)>0 THEN
     planning_memory_proof:=read_native_attended_memory_evidence(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions);
    END IF;
    IF planning_native_metadata->>'eligibleMetadata'='true' THEN
     planning_native_proof:=read_native_turn_compact_requirements(w,planning_native_roots,'[]');
    END IF;
    -- A second complete Memory proof sees fresh candidates, field masks and
    -- source/policy ancestry after the other cohort. No private business row
    -- or caller-supplied grant is used as a metadata witness.
    IF cardinality(planning_memory_ids)>0 THEN
    WITH RECURSIVE memory_nodes(kind,id,version) AS(
     SELECT * FROM unnest(planning_memory_kinds,planning_memory_ids,planning_memory_versions)
     UNION SELECT edge.kind,edge.id,edge.version FROM memory_nodes node
      CROSS JOIN LATERAL application_scope_source_edges(w,node.kind,node.id,node.version) edge
    ), bounded AS MATERIALIZED(SELECT * FROM memory_nodes LIMIT 4097)
    SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO planning_memory_lineage_after FROM bounded n;
     IF planning_memory_lineage_after IS NOT DISTINCT FROM planning_lineage THEN
      planning_memory_proof_after:=read_native_attended_memory_evidence(w,planning_memory_kinds,planning_memory_ids,planning_memory_versions);
     END IF;
    END IF;
    planning_native_metadata_after:=native_turn_metadata_acquire(w,planning_native_roots,'[]');
    IF cardinality(planning_memory_ids)>0 THEN
    WITH RECURSIVE memory_nodes(kind,id,version) AS(
     SELECT * FROM unnest(planning_memory_kinds,planning_memory_ids,planning_memory_versions)
     UNION SELECT edge.kind,edge.id,edge.version FROM memory_nodes node
      CROSS JOIN LATERAL application_scope_source_edges(w,node.kind,node.id,node.version) edge
    ), bounded AS MATERIALIZED(SELECT * FROM memory_nodes LIMIT 4097)
    SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO planning_memory_lineage_after FROM bounded n;
    END IF;
    IF planning_native_proof->>'admitted'='true' AND planning_native_proof->>'available'='true'
     AND planning_native_metadata_after->>'eligibleMetadata'='true'
     AND planning_native_metadata->'witness' IS NOT DISTINCT FROM planning_native_metadata_after->'witness'
     AND planning_memory_proof IS NOT DISTINCT FROM planning_memory_proof_after
     AND jsonb_typeof(planning_native_proof->'current')='array'
     AND (coalesce(cardinality(planning_memory_ids),0)=0 OR jsonb_typeof(planning_memory_proof->'current')='array')
     AND (coalesce(cardinality(planning_memory_ids),0)=0 OR planning_memory_proof->>'admitted'='true' AND jsonb_typeof(planning_memory_proof->'immutable')='array')
     AND jsonb_typeof(planning_native_proof->'immutable')='array'
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(planning_memory_proof->'immutable','[]')||(planning_native_proof->'immutable')) descriptor
      GROUP BY descriptor->>'resourceKind',descriptor->>'resourceId',descriptor->>'version' HAVING count(DISTINCT descriptor)>1) THEN
     -- Every original field must be unchanged in its own complete canonical
     -- proof. A changed, held, gone, missing or conflicting root uses the old
     -- per-field evaluator, preserving all D1 current-state classifications.
     IF EXISTS(SELECT 1 FROM jsonb_array_elements(planning_snapshot_rows) entry
      WHERE entry->'source' IS NULL OR entry->'source'='null'::jsonb
       OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN entry->>'memory'='true' THEN planning_memory_proof->'immutable' ELSE planning_native_proof->'immutable' END) actual WHERE actual=entry->'source')
       OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN entry->>'memory'='true' THEN planning_memory_proof->'current' ELSE planning_native_proof->'current' END) actual WHERE actual=entry->'source'))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(planning_memory_proof->'current','[]')||(planning_native_proof->'current')) descriptor
       GROUP BY descriptor->>'resourceKind',descriptor->>'resourceId' HAVING count(DISTINCT descriptor)>1) THEN
      planning_native_proof:=NULL;
     END IF;
     IF planning_eligible IS TRUE AND planning_native_proof IS NOT NULL
      AND native_turn_context() IS NOT DISTINCT FROM planning_context
      AND (coalesce(cardinality(planning_memory_ids),0)=0 OR application_memory_query_context(w) IS NOT DISTINCT FROM planning_memory_context)
      AND native_turn_helpers_current() IS TRUE AND application_memory_statement_helpers_current() IS TRUE
      AND (coalesce(cardinality(planning_memory_ids),0)=0 OR planning_lineage IS NOT DISTINCT FROM planning_memory_lineage_after) THEN
      -- Both canonical field evaluators produce these lifecycle values only
      -- for a successfully admitted current field. Exact immutable=current
      -- equality above excludes retirement/reclassification/version changes.
      IF clock_timestamp()<(planning_native_proof->>'validUntil')::timestamptz THEN
       RETURN QUERY SELECT (value->>'ord')::integer,(value->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL)
        FROM jsonb_array_elements(planning_snapshot_rows) ORDER BY (value->>'ord')::integer;
       RETURN;
      END IF;
     END IF;
    END IF;
   END IF;
  END IF;
 END IF;
 -- Unsupported planning retains every original root and the original evaluator.
$snapshot_branch$;
BEGIN
 -- The dependency facade is not a frozen-roster member. Authenticate its
 -- independently reviewed8244 bytes/properties before admitting it to this
 -- transaction-local evolution set; no runtime guard membership is added.
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid=dependency_target;
 original:=routine.prosrc;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM 'ea0ae981b22d36f0569711b02414516c6914cb1ef3bddbd2da120d9e9985df22'
  OR routine.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.session_messages'::regclass)
  OR routine.pronamespace<>'public'::regnamespace OR routine.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR routine.proargdefaults IS NOT NULL
  OR to_jsonb(routine)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proargdefaults'] IS DISTINCT FROM $dependency_metadata${"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"pronargdefaults":0}$dependency_metadata$::jsonb
  OR NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a
   WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='app_user') AND a.grantor=routine.proowner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a
   WHERE a.grantee NOT IN(routine.proowner,(SELECT oid FROM pg_roles WHERE rolname='app_user'))
    OR a.grantor<>routine.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  OR (length(original)-length(replace(original,dependency_before,'')))/length(dependency_before)<>1
 THEN RAISE EXCEPTION 'native_field_planning_dependency_predecessor_changed';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.prokind='f' AND p.oid<>dependency_target AND (
  position(quote_literal(original) IN p.prosrc)>0
  OR position(encode(sha256(convert_to(to_jsonb(routine)::text,'UTF8')),'hex') IN p.prosrc)>0
  OR position(encode(sha256(convert_to(original,'UTF8')),'hex') IN p.prosrc)>0))
 THEN RAISE EXCEPTION 'native_field_planning_dependency_pin_consumer_changed';END IF;
 successor:=replace(original,dependency_before,dependency_after);
 IF encode(sha256(convert_to(successor,'UTF8')),'hex') IS DISTINCT FROM '2f7b7fbf728e1b675e06b4ffe56ae2ebb159e28e8f59612b0c035de658a1b166'
 THEN RAISE EXCEPTION 'native_field_planning_dependency_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(dependency_target),original,successor);
 UPDATE pg_temp.native_field_planning_originals SET expected_body=successor WHERE oid=dependency_target;
 -- The existing closed contracts independently authenticate the snapshot
 -- routine and all six literal consumers. Only its reviewed leaf changes.
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid=snapshot_target;
 original:=routine.prosrc;
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM 'a3ead9fc09f142f7450eabd41b573a07d66ce39adf43aeca1d87786c091634ee'
  OR NOT EXISTS(SELECT 1 FROM pg_temp.native_field_planning_originals o WHERE o.oid=snapshot_target AND o.expected_body=original AND o.metadata=to_jsonb(routine)-'prosrc')
  OR (length(original)-length(replace(original,snapshot_declaration_before,'')))/length(snapshot_declaration_before)<>1
  OR (length(original)-length(replace(original,snapshot_anchor,'')))/length(snapshot_anchor)<>1
 THEN RAISE EXCEPTION 'native_field_planning_snapshot_predecessor_changed';END IF;
 successor:=replace(replace(original,snapshot_declaration_before,snapshot_declaration_after),snapshot_anchor,snapshot_branch||chr(10)||snapshot_anchor);
 IF encode(sha256(convert_to(successor,'UTF8')),'hex') IS DISTINCT FROM '50cb4616c970bb1a2960cf9e285a0991c0338f77a13c15e1887ddc2c9309500c'
 THEN RAISE EXCEPTION 'native_field_planning_snapshot_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(snapshot_target),original,successor);
 UPDATE pg_temp.native_field_planning_originals SET expected_body=successor WHERE oid=snapshot_target;
END $native_field_planning$;
DO $controlled_repin$
<<controlled_repin>>
DECLARE previous record;caller record;body text;round integer;changed boolean;
BEGIN
 FOR round IN 1..64 LOOP
  RAISE NOTICE 'Active Work-recording proof: authenticated pin round %',round;
  changed:=false;
  IF EXISTS(SELECT 1 FROM pg_temp.native_field_planning_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
  THEN RAISE EXCEPTION 'native_field_planning_authenticated_code_changed';END IF;
  FOR previous IN SELECT o.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM pg_temp.native_field_planning_originals o JOIN pg_proc p ON p.oid=o.oid WHERE o.body IS DISTINCT FROM p.prosrc
  LOOP
   FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid AND
    (position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0)
   LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_temp.native_field_planning_originals o WHERE o.oid=caller.oid AND o.expected_body=caller.prosrc)
    THEN RAISE EXCEPTION 'native_field_planning_unauthenticated_pin_consumer: %',caller.oid::regprocedure;END IF;
    body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
    IF body IS DISTINCT FROM caller.prosrc THEN
     EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);
     UPDATE pg_temp.native_field_planning_originals SET expected_body=controlled_repin.body WHERE oid=caller.oid;
     changed:=true;
    END IF;
   END LOOP;
   UPDATE pg_temp.native_field_planning_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
    fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  IF NOT changed THEN EXIT;END IF;
  IF round=64 THEN RAISE EXCEPTION 'native_field_planning_pin_cycle';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.native_field_planning_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
 THEN RAISE EXCEPTION 'native_field_planning_successor_code_changed';END IF;
END $controlled_repin$;
DO $reference_rows$
<<reference_rows>>
DECLARE routine_row pg_proc;initial_body text;body text;member_oids oid[];
 columns_sql text;row_sql text;comparisons text;catalog_shape jsonb;rows_sql text;
 row_start integer;row_end integer;tail text;
BEGIN
 SELECT * INTO STRICT routine_row FROM pg_proc WHERE oid='application_native_field_reference_helpers_current()'::regprocedure;
 SELECT o.initial_body INTO STRICT initial_body FROM pg_temp.native_field_planning_originals o
 WHERE o.oid=reference_rows.routine_row.oid AND o.expected_body=reference_rows.routine_row.prosrc
  AND o.metadata=to_jsonb(reference_rows.routine_row)-'prosrc';
 SELECT array_agg(to_regprocedure('public.'||r.signature)::oid) INTO member_oids FROM unnest(ARRAY['agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','application_current_field_snapshot(uuid,uuid)','application_empty_query_helpers_current()','application_empty_query_worklist_current(uuid,jsonb)','application_empty_query_worklist_reset(jsonb)','application_field_digest(jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','application_field_resource_uuid(text)','application_memory_field_keys()','application_memory_field_state(uuid,uuid,text[])','application_memory_field_state_before_successor(uuid,uuid,text[])','application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','application_memory_history_status(uuid,uuid,text)','application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','application_memory_query_context(uuid)','application_memory_query_domain_state(uuid,uuid,text[])','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','application_memory_statement_state(uuid,uuid,text[],jsonb)','application_native_catalog_port_valid(regprocedure)','application_native_dependency_batch_helpers_current()','application_native_field_catalog_for(uuid,jsonb,text)','application_native_field_contract_before_catalog(uuid,jsonb,text,text)','application_native_field_contract_for(uuid,jsonb,text,text)','application_native_field_rule_allows(jsonb,text[])','application_native_file_capture_helpers_current()','application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_record_port_valid(regprocedure)','application_native_same_destination(uuid,text,uuid,text,uuid)','application_native_source_edges_dispatch(uuid,text,uuid,text)','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_intersection(jsonb,jsonb)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_reader_envelope_visible(uuid,jsonb)','application_recorded_field_root_capture(uuid,uuid,text,integer)','application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','application_scope_lineage(uuid,text[],uuid[],text[])','application_scope_source_edges(uuid,text,uuid,text)','application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','application_session_eval_field(uuid,uuid,text,jsonb)','application_session_eval_scope(uuid,text,uuid,text,jsonb)','assistant_placement_visible(uuid,uuid)','capture_native_session_projection_batch(uuid,uuid,integer,text)','crm_capture_erasure_effect()','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','guard_application_field_lineage()','guard_external_source_derivation()','guard_page_derivation_receipts()','guard_session_context_lineage()','guard_session_recording_privacy()','guard_workflow_derivation_receipts()','knowledge_version_source_edges(uuid,text,uuid,text)','legacy_assistant_team_compartments(uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','project_member_live(uuid,text,uuid)','read_admitted_native_scope_snapshot(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','read_application_field_dependencies(uuid,text[],uuid[],text[])','read_entity_derivation_source(uuid,text,uuid)','read_entity_derivation_source_before_application_fields(uuid,text,uuid)','read_entity_derivation_source_before_blueprint(uuid,text,uuid)','read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','read_entity_derivation_source_before_browser_session(uuid,text,uuid)','read_entity_derivation_source_before_capture(uuid,text,uuid)','read_entity_derivation_source_before_conversation(uuid,text,uuid)','read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','read_entity_derivation_source_before_page(uuid,text,uuid)','read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','read_entity_derivation_source_before_recordings(uuid,text,uuid)','read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])','read_media_parent_snapshot(uuid,text,uuid)','read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','read_media_parent_snapshot_before_conversation(uuid,text,uuid)','read_media_parent_snapshot_before_page(uuid,text,uuid)','read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_field_snapshots(uuid,uuid[],text[])','read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','read_resource_page_dependencies(uuid,text,uuid,text)','read_scope_source(uuid,text,uuid)','read_scope_source_before_application_fields(uuid,text,uuid)','read_scope_source_before_browser_profile(uuid,text,uuid)','read_scope_source_before_browser_session(uuid,text,uuid)','read_scope_source_before_external(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','read_scope_source_before_page(uuid,text,uuid)','read_scope_source_before_persistent_context(uuid,text,uuid)','read_scope_source_before_routines(uuid,text,uuid)','read_scope_source_before_workflow_run(uuid,text,uuid)','recording_source_read_allowed(uuid,text,uuid)','refuse_quarantined_recording_message()','scope_review_state_held(text,uuid)','scope_source_ancestors(uuid,text,uuid)','scope_source_ancestors_before_browser_profile(uuid,text,uuid)','scope_source_ancestors_before_browser_session(uuid,text,uuid)','scope_source_ancestors_before_workflow_run(uuid,text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','scope_source_table_before_media(text)','scope_source_table_before_persistent_context(text)','sensitivity_rank(text)','session_recording_read_allowed(uuid)','validate_application_field_dependencies()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_workflow_derivation_dependencies()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]) r(signature);
 IF cardinality(member_oids)<>156 OR array_position(member_oids,NULL) IS NOT NULL OR
  (SELECT count(*) FROM pg_temp.native_field_planning_originals o JOIN pg_proc member ON member.oid=o.oid
   WHERE member.oid=ANY(member_oids) AND member.prosrc=o.expected_body AND (to_jsonb(member)-'prosrc')=o.metadata)<>156
 THEN RAISE EXCEPTION 'native_field_planning_reference_members_changed';END IF;
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
 THEN RAISE EXCEPTION 'native_field_planning_reference_template_changed';END IF;
 row_end:=length(initial_body)-position(reverse(tail) IN reverse(initial_body))-length(tail)+2;
 IF row_end<=row_start THEN RAISE EXCEPTION 'native_field_planning_reference_row_bounds_changed';END IF;
 EXECUTE 'SELECT string_agg(''(''||'||row_sql||'||'')'','','' ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1)' INTO rows_sql USING member_oids;
 body:=left(initial_body,row_start-1)||rows_sql||substring(initial_body FROM row_end);
 EXECUTE replace(pg_get_functiondef(reference_rows.routine_row.oid),reference_rows.routine_row.prosrc,body);
 UPDATE pg_temp.native_field_planning_originals SET expected_body=reference_rows.body WHERE oid=reference_rows.routine_row.oid;
END $reference_rows$;

DO $controlled_repin$
<<controlled_repin>>
DECLARE previous record;caller record;body text;round integer;changed boolean;
BEGIN
 FOR round IN 1..64 LOOP
  RAISE NOTICE 'Active Work-recording proof: authenticated pin round %',round;
  changed:=false;
  IF EXISTS(SELECT 1 FROM pg_temp.native_field_planning_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
  THEN RAISE EXCEPTION 'native_field_planning_authenticated_code_changed';END IF;
  FOR previous IN SELECT o.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM pg_temp.native_field_planning_originals o JOIN pg_proc p ON p.oid=o.oid WHERE o.body IS DISTINCT FROM p.prosrc
  LOOP
   FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid AND
    (position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0)
   LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_temp.native_field_planning_originals o WHERE o.oid=caller.oid AND o.expected_body=caller.prosrc)
    THEN RAISE EXCEPTION 'native_field_planning_unauthenticated_pin_consumer: %',caller.oid::regprocedure;END IF;
    body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
    IF body IS DISTINCT FROM caller.prosrc THEN
     EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);
     UPDATE pg_temp.native_field_planning_originals SET expected_body=controlled_repin.body WHERE oid=caller.oid;
     changed:=true;
    END IF;
   END LOOP;
   UPDATE pg_temp.native_field_planning_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
    fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  IF NOT changed THEN EXIT;END IF;
  IF round=64 THEN RAISE EXCEPTION 'native_field_planning_pin_cycle';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.native_field_planning_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
 THEN RAISE EXCEPTION 'native_field_planning_successor_code_changed';END IF;
END $controlled_repin$;
UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN pg_temp.native_field_planning_originals o ON o.oid=p.oid AND o.expected_body=p.prosrc AND o.metadata=to_jsonb(p)-'prosrc'
 WHERE p.oid=to_regprocedure(h.signature) AND o.initial_body IS DISTINCT FROM p.prosrc;
-- Advance only the independently authenticated display pin for the changed leaf.
UPDATE private_session_display_contract c SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN pg_temp.native_field_planning_originals o ON o.oid=p.oid
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
    ||values_sql||' LEFT JOIN pg_catalog.pg_proc p ON p.oid=m.oid LEFT JOIN pg_temp.native_field_planning_originals o ON o.oid=m.oid WHERE NOT('||comparisons||') LIMIT 12) differences' INTO members;
   member_drift:=member_drift||jsonb_build_object(guard_signature,members);
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(h.signature),'[]'::jsonb) INTO members FROM native_turn_contract_helpers h
 LEFT JOIN pg_proc p ON p.oid=to_regprocedure(h.signature)
 WHERE h.fingerprint IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex');
 RAISE EXCEPTION 'native_field_planning_successor_contract_changed: %',jsonb_build_object('guards',guard_states,'flatMembers',member_drift,'readerMembers',members);
END $successor_diagnostics$;
COMMIT;
