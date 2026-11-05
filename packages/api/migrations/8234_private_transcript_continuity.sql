-- [COMP:api/private-transcript] Same-session dialogue is a durable utterance source.
BEGIN;
CREATE TABLE private_transcript_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 binding jsonb NOT NULL, manifest jsonb NOT NULL, identity text NOT NULL,
 UNIQUE(session_id,identity),
 sensitivity text NOT NULL CHECK(sensitivity IN('public','internal','confidential')),
 compartments text[] NOT NULL, project_ids uuid[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX private_transcript_session ON private_transcript_observations(session_id);
ALTER TABLE private_transcript_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private_transcript_observations FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON private_transcript_observations FROM app_user;END IF;END $$;

CREATE FUNCTION private_transcript_message_fingerprint(m session_messages) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(m.id,m.session_id,m.role,m.content,m.sequence_num,m.created_at,
  m.workspace_id,m.user_id,m.assistant_id,m.sensitivity,m.compartments,m.project_ids,m.scope_version,m.scope_held,
  m.sender_user_id,m.sender_assistant_id)::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION private_transcript_message_fingerprint(session_messages) FROM PUBLIC;

CREATE FUNCTION read_private_transcript_source(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o private_transcript_observations;s sessions;item record;
BEGIN
 SELECT * INTO o FROM private_transcript_observations WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN '{"held":true}';END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=o.user_id FOR SHARE;
 IF NOT FOUND THEN RETURN '{"held":true}';END IF;
 SELECT * INTO s FROM sessions WHERE id=o.session_id FOR SHARE;
 IF NOT FOUND OR s.user_id<>o.user_id OR private_legacy_history_binding(s) IS DISTINCT FROM o.binding
  OR session_recording_read_allowed(s.id) IS NOT TRUE OR scope_review_state_held('session',s.id) IS TRUE
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=o.user_id)
  OR NOT EXISTS(SELECT 1 FROM assistants WHERE id=s.assistant_id AND workspace_id=w)
 THEN RETURN '{"held":true}';END IF;
 PERFORM id FROM private_transcript_observations WHERE id=i FOR SHARE;
 -- Revalidate the transcript itself, never the sources behind the utterances.
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(o.manifest) AS entry(message_id) WHERE NOT EXISTS(SELECT 1 FROM session_messages m WHERE m.id=entry.message_id::uuid AND m.session_id=o.session_id)) THEN RETURN '{"held":true}';END IF;
 FOR item IN SELECT m.*,entry.value expected FROM jsonb_each_text(o.manifest) entry
  JOIN session_messages m ON m.id=entry.key::uuid AND m.session_id=o.session_id ORDER BY entry.key FOR SHARE OF m
 LOOP
  IF item.id IS NULL OR item.scope_held IS TRUE OR scope_review_state_held('session_message',item.id) IS TRUE
   OR private_transcript_message_fingerprint((SELECT m FROM session_messages m WHERE m.id=item.id)) IS DISTINCT FROM item.expected
  THEN RETURN '{"held":true}';END IF;
 END LOOP;
 RETURN jsonb_build_object('workspaceId',w,'resourceKind','private_transcript','resourceId',i,'version','1',
  'userId',o.user_id,'assistantId',NULL,'sensitivity',o.sensitivity,'compartments',o.compartments,'projectIds',o.project_ids,
  'held',false,'validTo',NULL,'retractedAt',NULL);
END $$;
REVOKE ALL ON FUNCTION read_private_transcript_source(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION capture_private_transcript(w uuid,i uuid,device uuid,version integer,through_sequence integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE parent jsonb;s sessions;page jsonb;rows jsonb:='[]';selected jsonb;manifest jsonb;observed uuid;source jsonb;
 cursor_sequence integer:=0;capture_identity text;tier text;teams text[];projects uuid[];actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF through_sequence IS NULL OR through_sequence<0 THEN RAISE EXCEPTION 'invalid_private_transcript' USING ERRCODE='22023';END IF;
 parent:=private_session_display_parent(w,i,device,version);
 SELECT * INTO s FROM sessions WHERE id=i;
 IF s.channel_type<>'web' OR coalesce(s.app_origin,'chat')<>'chat' OR s.anchor_kind<>'none' OR s.mode IS NOT NULL
 THEN RETURN NULL;END IF;
 LOOP
  IF s.workspace_id IS NULL THEN page:=read_private_legacy_history(w,i,device,version,cursor_sequence,100);
  ELSE page:=read_private_session_display(w,i,device,version,cursor_sequence,100);END IF;
  SELECT coalesce(jsonb_agg(row ORDER BY (row->>'sequence')::integer),'[]') INTO selected
   FROM jsonb_array_elements(page->'rows') row WHERE (row->>'sequence')::integer<=through_sequence AND row->>'available'='true';
  rows:=rows||selected;
  cursor_sequence:=(page->>'nextSequence')::integer;
  EXIT WHEN cursor_sequence IS NULL OR cursor_sequence>=through_sequence;
 END LOOP;
 -- A legacy session keeps its identity. Its frozen unclassified cohort is
 -- joined by later ordinarily scoped turns, never by later unclassified rows.
 IF s.workspace_id IS NULL THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'sequence',m.sequence_num,'role',m.role,
   'timestamp',m.created_at,'available',true,'content',m.content) ORDER BY m.sequence_num),'[]') INTO selected
  FROM session_messages m WHERE m.session_id=i AND m.workspace_id=w AND m.user_id=actor
   AND m.sequence_num<=through_sequence AND m.role IN('user','assistant') AND m.scope_held IS FALSE
   AND m.scope_version IS NOT NULL AND m.sensitivity IN('public','internal','confidential')
   AND m.compartments IS NOT NULL AND m.project_ids IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM session_legacy_history_messages h WHERE h.message_id=m.id)
   AND scope_review_state_held('session_message',m.id) IS NOT TRUE
   AND agent_visibility_allows(w,m.user_id,m.assistant_id) IS TRUE
   AND workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,'userId',m.user_id,
    'assistantId',m.assistant_id,'sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids)) IS TRUE
   AND (jsonb_typeof(m.content)='string' OR jsonb_typeof(m.content)='array'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b
     WHERE b->>'type'='text' AND jsonb_typeof(b->'text')='string'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b
    WHERE b->>'type'='tool_result' OR m.role='assistant' AND b->>'type'='tool_use');
  rows:=rows||selected;
 END IF;
 SELECT coalesce(jsonb_agg(row ORDER BY (row->>'sequence')::integer),'[]') INTO rows FROM jsonb_array_elements(rows) row;
 SELECT coalesce(jsonb_object_agg(m.id,private_transcript_message_fingerprint(m)),'{}') INTO manifest
  FROM session_messages m JOIN jsonb_array_elements(rows) row ON m.id=(row->>'id')::uuid;
 SELECT sensitivity INTO tier FROM (
  SELECT coalesce(s.effective_clearance,'internal') sensitivity UNION ALL
  SELECT coalesce(m.sensitivity,s.effective_clearance,'internal') FROM session_messages m WHERE manifest ? m.id::text
 ) labels ORDER BY sensitivity_rank(sensitivity) DESC LIMIT 1;
 SELECT ARRAY(SELECT DISTINCT label FROM (
  SELECT unnest(s.context_compartments) label UNION ALL SELECT unnest(m.compartments) FROM session_messages m WHERE manifest ? m.id::text
 ) labels ORDER BY label) INTO teams;
 SELECT ARRAY(SELECT DISTINCT project FROM (
  SELECT s.context_project_id project WHERE s.context_project_id IS NOT NULL UNION ALL
  SELECT unnest(m.project_ids) FROM session_messages m WHERE manifest ? m.id::text
 ) labels ORDER BY project) INTO projects;
 capture_identity:=encode(sha256(convert_to(jsonb_build_array(w,i,actor,private_legacy_history_binding(s),manifest,tier,teams,projects)::text,'UTF8')),'hex');
 INSERT INTO private_transcript_observations(workspace_id,session_id,user_id,binding,manifest,sensitivity,compartments,project_ids,identity)
 VALUES(w,i,actor,private_legacy_history_binding(s),manifest,tier,teams,projects,capture_identity)
 ON CONFLICT(session_id,identity) DO NOTHING RETURNING id INTO observed;
 IF observed IS NULL THEN SELECT id INTO observed FROM private_transcript_observations WHERE session_id=i AND identity=capture_identity;END IF;
 source:=read_private_transcript_source(w,observed);
 IF source->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'private_transcript_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('rows',rows,'source',source-ARRAY['held','validTo','retractedAt']);
END $$;
REVOKE ALL ON FUNCTION capture_private_transcript(uuid,uuid,uuid,integer,integer) FROM PUBLIC;
DO $$ DECLARE definition text;BEGIN
 SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid='scope_derivation_sources'::regclass AND conname='scope_derivation_sources_source_kind_check';
 ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
 EXECUTE 'ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK (source_kind=''private_transcript'' OR '||substring(definition FROM 7)||')';
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION capture_private_transcript(uuid,uuid,uuid,integer,integer) TO app_user;END IF;
END $$;
-- Authenticate the existing kernel before changing its field catalog.
DO $transcript_contract$
DECLARE signature text; ok boolean;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'transcript_reader_dependency_changed: %',signature;END IF;
 END LOOP;
END $transcript_contract$;
DO $$ BEGIN RAISE NOTICE 'Private transcript: predecessor authenticated';END $$;
CREATE TEMP TABLE pg_temp.transcript_reader_originals ON COMMIT DROP AS
 SELECT p.oid,p.oid::regprocedure::text signature,to_jsonb(p)-'prosrc' metadata,
 p.prosrc body,p.prosrc expected_body,quote_literal(p.prosrc) quoted_body,
 encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint,
 encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') body_hash,p.prosrc initial_body
 FROM pg_proc p WHERE p.oid::regprocedure::text=ANY(ARRAY['agent_mutation_scope_allows(text[])','agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','application_current_field_snapshot(uuid,uuid)','application_empty_query_facades_current()','application_empty_query_helpers_current()','application_empty_query_worklist_current(uuid,jsonb)','application_empty_query_worklist_reset(jsonb)','application_field_digest(jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','application_field_resource_uuid(text)','application_materialize_field_envelope(uuid,jsonb,integer)','application_memory_field_keys()','application_memory_field_state(uuid,uuid,text[])','application_memory_field_state_before_successor(uuid,uuid,text[])','application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','application_memory_history_status(uuid,uuid,text)','application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','application_memory_query_context(uuid)','application_memory_query_domain_state(uuid,uuid,text[])','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','application_memory_statement_state(uuid,uuid,text[],jsonb)','application_native_catalog_port_valid(regprocedure)','application_native_context_fields_current()','application_native_covered_evidence_helpers_current()','application_native_covered_queue_current()','application_native_dependency_batch_helpers_current()','application_native_field_catalog_for(uuid,jsonb,text)','application_native_field_contract_before_catalog(uuid,jsonb,text,text)','application_native_field_contract_for(uuid,jsonb,text,text)','application_native_field_reference_helpers_current()','application_native_field_rule_allows(jsonb,text[])','application_native_file_capture_helpers_current()','application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_record_port_valid(regprocedure)','application_native_root_cover(uuid,jsonb)','application_native_same_destination(uuid,text,uuid,text,uuid)','application_native_session_query_acquisition_current()','application_native_source_edges_dispatch(uuid,text,uuid,text)','application_native_title_acquisition_helpers_current()','application_native_title_group_helpers_current()','application_native_transcript_prepare_helpers_current()','application_native_worklist_helpers_current()','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_admits_point(jsonb,jsonb)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_escape(jsonb[],integer,text[],text[],text[],integer)','application_query_scope_intersection(jsonb,jsonb)','application_query_scope_union_contains(jsonb,jsonb,integer)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_reader_envelope_visible(uuid,jsonb)','application_recorded_field_root_capture(uuid,uuid,text,integer)','application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','application_scope_lineage(uuid,text[],uuid[],text[])','application_scope_source_edges(uuid,text,uuid,text)','application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','application_session_eval_domain(uuid,text,uuid,text[],jsonb)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','application_session_eval_field(uuid,uuid,text,jsonb)','application_session_eval_point_state(uuid,text,uuid,text[],jsonb)','application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','application_session_eval_scope(uuid,text,uuid,text,jsonb)','application_session_eval_scope_current(uuid,text,uuid,text,jsonb)','application_session_field_keys(text)','application_session_query_bounds(uuid,jsonb)','application_session_query_parent(uuid,uuid)','application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)','assistant_placement_visible(uuid,uuid)','capture_native_session_projection_batch(uuid,uuid,integer,text)','capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)','crm_capture_erasure_effect()','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','external_source_snapshot(uuid,uuid)','guard_application_field_lineage()','guard_external_source_derivation()','guard_page_derivation_receipts()','guard_session_context_lineage()','guard_session_recording_privacy()','guard_workflow_derivation_receipts()','knowledge_version_source_edges(uuid,text,uuid,text)','legacy_assistant_team_compartments(uuid)','lock_native_session_context_publication(uuid,uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','native_detached_eval_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_detached_eval_field(uuid,uuid,text,jsonb,jsonb)','native_detached_eval_point_state(uuid,text,uuid,text[],jsonb,jsonb)','native_detached_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_detached_eval_scope(uuid,text,uuid,text,jsonb,jsonb)','native_detached_lineage(uuid,text[],uuid[],text[],jsonb)','native_detached_snapshot(uuid,text,uuid,text,jsonb)','native_personal_title_group_acquisition(uuid,uuid[],uuid[])','native_turn_build_query_capture(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_capture_compact_requirements(uuid,jsonb,jsonb)','native_turn_capture_event(jsonb)','native_turn_capture_parent(uuid,uuid)','native_turn_capture_requirements(uuid,jsonb)','native_turn_capture_requirements(uuid,jsonb,jsonb)','native_turn_capture_sources(uuid,jsonb)','native_turn_compact_domain(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb)','native_turn_compact_field(uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_metadata(uuid,jsonb,jsonb)','native_turn_compact_point(uuid,text,uuid,text[],jsonb,jsonb,jsonb)','native_turn_compact_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb,jsonb)','native_turn_compact_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_compact_topology(jsonb,jsonb)','native_turn_complete_publication()','native_turn_completed_field(uuid,uuid,text,jsonb,jsonb)','native_turn_completed_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_completed_scope(uuid,text,uuid,text,jsonb,jsonb)','native_turn_context()','native_turn_discover_lock_requirements(uuid,jsonb,jsonb)','native_turn_edges(uuid,jsonb)','native_turn_empty_memory_context(uuid)','native_turn_empty_memory_domain(uuid,uuid,text[],jsonb)','native_turn_empty_memory_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','native_turn_event_frame(uuid,uuid)','native_turn_field_reference(uuid,uuid,uuid,text)','native_turn_frame_immutable()','native_turn_frame_pair(uuid,uuid)','native_turn_frame_payload_shape(jsonb)','native_turn_guard_completion_debt()','native_turn_helpers_current()','native_turn_key(jsonb)','native_turn_lock_requirements(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb)','native_turn_metadata_acquire(uuid,jsonb,jsonb)','native_turn_page_event(jsonb)','native_turn_parent(uuid,uuid,jsonb)','native_turn_parent_scope(uuid,uuid)','native_turn_prepare_publication(uuid,uuid,text,jsonb,jsonb)','native_turn_principal_bounds(uuid,uuid,boolean)','native_turn_privacy_edges(uuid,jsonb)','native_turn_publication_contract()','native_turn_query_bounds(uuid)','native_turn_read_point(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_domain(uuid,text,uuid,text[],jsonb,jsonb)','native_turn_reduce_envelope(uuid,text,uuid,text,text[],jsonb,jsonb)','native_turn_reduce_field(uuid,uuid,text,jsonb,jsonb)','native_turn_reduce_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb,jsonb)','native_turn_session_bounds(uuid,jsonb)','native_turn_topology(jsonb,jsonb)','native_turn_validate_event(jsonb)','native_turn_validate_frame_pair()','native_worklist_context(uuid,jsonb)','native_worklist_current(uuid,text,uuid,jsonb)','native_worklist_current_application_sources(uuid,text,uuid,jsonb)','native_worklist_current_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_current_persistent_context(uuid,text,uuid,jsonb)','native_worklist_current_public_share(uuid,text,uuid,jsonb)','native_worklist_edges(uuid,jsonb)','native_worklist_eval_domain(uuid,text,uuid,text[],jsonb)','native_worklist_eval_envelope(uuid,text,uuid,text,text[],jsonb)','native_worklist_eval_field(uuid,uuid,text,jsonb)','native_worklist_eval_point_state(uuid,text,uuid,text[],jsonb)','native_worklist_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','native_worklist_eval_scope(uuid,text,uuid,text,jsonb)','native_worklist_frame_current(uuid,jsonb)','native_worklist_lineage(uuid,text[],uuid[],text[],jsonb)','native_worklist_page_dependencies(uuid,text,uuid,text,jsonb)','native_worklist_seed(uuid,jsonb)','native_worklist_snapshot(uuid,text,uuid,text,jsonb)','native_worklist_source(uuid,text,uuid,jsonb)','native_worklist_source_application_fields(uuid,text,uuid,jsonb)','native_worklist_source_blueprint(uuid,text,uuid,jsonb)','native_worklist_source_browser_profile(uuid,text,uuid,jsonb)','native_worklist_source_browser_session(uuid,text,uuid,jsonb)','native_worklist_source_capture(uuid,text,uuid,jsonb)','native_worklist_source_conversation(uuid,text,uuid,jsonb)','native_worklist_source_engineering_archive(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_source_parent(uuid,text,uuid,jsonb)','native_worklist_source_knowledge_versions(uuid,text,uuid,jsonb)','native_worklist_source_memory_successor(uuid,text,uuid,jsonb)','native_worklist_source_page(uuid,text,uuid,jsonb)','native_worklist_source_persistent_context(uuid,text,uuid,jsonb)','native_worklist_source_primitive_v2(uuid,text,uuid,jsonb)','native_worklist_source_recordings(uuid,text,uuid,jsonb)','native_worklist_source_workflow_run(uuid,text,uuid,jsonb)','observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])','prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','prepare_native_session_message_covered(uuid,uuid,text,jsonb,jsonb)','project_labels_allowed(jsonb,uuid,text[],boolean)','project_member_live(uuid,text,uuid)','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)','publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)','publish_native_turn_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','read_admitted_native_scope_snapshot(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','read_application_field_dependencies(uuid,text[],uuid[],text[])','read_entity_derivation_source(uuid,text,uuid)','read_entity_derivation_source_before_application_fields(uuid,text,uuid)','read_entity_derivation_source_before_blueprint(uuid,text,uuid)','read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','read_entity_derivation_source_before_browser_session(uuid,text,uuid)','read_entity_derivation_source_before_capture(uuid,text,uuid)','read_entity_derivation_source_before_conversation(uuid,text,uuid)','read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','read_entity_derivation_source_before_page(uuid,text,uuid)','read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','read_entity_derivation_source_before_recordings(uuid,text,uuid)','read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])','read_media_parent_snapshot(uuid,text,uuid)','read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','read_media_parent_snapshot_before_conversation(uuid,text,uuid)','read_media_parent_snapshot_before_page(uuid,text,uuid)','read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','read_native_application_session_history(uuid,uuid,integer)','read_native_application_session_projection(uuid,uuid,integer,text)','read_native_application_session_topics(uuid,uuid,integer)','read_native_attended_memory_evidence(uuid,text[],uuid[],text[])','read_native_context_field_currents(uuid,jsonb)','read_native_covered_memory_frame(uuid,text[],uuid[],text[],boolean)','read_native_covered_session_evidence(uuid,text[],uuid[],text[])','read_native_covered_session_frame(uuid,text[],uuid[],text[])','read_native_empty_query_evidence(uuid,text[],uuid[],text[])','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_empty_query_session_title_revision(uuid,uuid,uuid)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_field_snapshots(uuid,uuid[],text[])','read_native_file_session_title_revision(uuid,uuid,uuid)','read_native_file_worklist_evidence(uuid,text[],uuid[],text[],boolean,boolean)','read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_personal_title_group(uuid,uuid[],uuid[])','read_native_personal_title_group_evidence(uuid,uuid[],uuid[])','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_field_snapshots(uuid,uuid[],text[])','read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_session_query_evidence(uuid,uuid,integer,integer)','read_native_turn_compact_requirements(uuid,jsonb,jsonb)','read_native_turn_query_requirements(uuid,jsonb,jsonb)','read_native_turn_requirements(uuid,jsonb)','read_native_turn_scope_evidence(uuid,jsonb)','read_native_turn_session_query(uuid,uuid,integer,integer)','read_resource_page_dependencies(uuid,text,uuid,text)','read_scope_source(uuid,text,uuid)','read_scope_source_before_application_fields(uuid,text,uuid)','read_scope_source_before_browser_profile(uuid,text,uuid)','read_scope_source_before_browser_session(uuid,text,uuid)','read_scope_source_before_external(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','read_scope_source_before_page(uuid,text,uuid)','read_scope_source_before_persistent_context(uuid,text,uuid)','read_scope_source_before_routines(uuid,text,uuid)','read_scope_source_before_workflow_run(uuid,text,uuid)','read_session_context_empty_query_revision(uuid,uuid)','read_session_context_file_revision(uuid,uuid)','read_session_context_revision(uuid,uuid)','read_session_title_revision(uuid,uuid,uuid)','recording_source_read_allowed(uuid,text,uuid)','refuse_quarantined_recording_message()','scope_review_state_held(text,uuid)','scope_source_ancestors(uuid,text,uuid)','scope_source_ancestors_before_browser_profile(uuid,text,uuid)','scope_source_ancestors_before_browser_session(uuid,text,uuid)','scope_source_ancestors_before_workflow_run(uuid,text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','scope_source_table_before_media(text)','scope_source_table_before_persistent_context(text)','sensitivity_rank(text)','session_context_empty_query_revision_allowed(uuid,uuid)','session_context_file_revision_allowed(uuid,uuid)','session_context_parent_snapshot(uuid,uuid)','session_context_payload_shape(text,jsonb)','session_context_revision_allowed(uuid,uuid)','session_context_revision_native(uuid,uuid)','session_context_revision_snapshot(uuid,uuid)','session_personal_audience(sessions)','session_project_audience(sessions,boolean)','session_recording_read_allowed(uuid)','session_workspace_audience(sessions)','validate_application_field_dependencies()','validate_native_covered_field_dependency_work(uuid,uuid,bigint)','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_session_context_revision_pair()','validate_workflow_derivation_dependencies()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]);

DO $transcript_branches$
DECLARE routine_signature text; branch text; definition text; original text; successor text;
BEGIN
 FOREACH routine_signature IN ARRAY ARRAY['read_scope_source(uuid,text,uuid)','read_entity_derivation_source(uuid,text,uuid)','scope_source_ancestors(uuid,text,uuid)'] LOOP
  SELECT p.prosrc INTO STRICT original FROM pg_proc p JOIN pg_temp.transcript_reader_originals o ON o.oid=p.oid
   WHERE p.oid=to_regprocedure('public.'||routine_signature) AND p.prosrc=o.expected_body AND to_jsonb(p)-'prosrc'=o.metadata;
  IF position(E'BEGIN\n' IN original)=0 THEN RAISE EXCEPTION 'transcript_reader_shape_changed';END IF;
  branch:=CASE routine_signature
   WHEN 'read_scope_source(uuid,text,uuid)' THEN $branch$
 IF k='private_transcript' THEN RETURN read_private_transcript_source(w,i);END IF;
$branch$
   WHEN 'scope_source_ancestors(uuid,text,uuid)' THEN $branch$
 IF k='private_transcript' THEN
  RETURN QUERY SELECT id FROM private_transcript_observations WHERE workspace_id=w AND id=i;
  RETURN;
 END IF;
$branch$
   ELSE $branch$
 IF k='private_transcript' THEN
  IF nullif(current_setting('app.application_id',true),'') IS NOT NULL
   OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM private_transcript_observations o WHERE o.workspace_id=w AND o.id=i
     AND o.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid)
  THEN RETURN NULL;END IF;
  RETURN read_private_transcript_source(w,i);
 END IF;
$branch$ END;
  successor:=overlay(original placing E'BEGIN\n'||branch from position(E'BEGIN\n' IN original) for length(E'BEGIN\n'));
  definition:=pg_get_functiondef(to_regprocedure('public.'||routine_signature));
  EXECUTE replace(definition,original,successor);
  UPDATE pg_temp.transcript_reader_originals SET expected_body=successor WHERE oid=to_regprocedure('public.'||routine_signature);
 END LOOP;
END $transcript_branches$;
DO $controlled_repin$
<<controlled_repin>>
DECLARE previous record;caller record;body text;round integer;changed boolean;
BEGIN
 FOR round IN 1..64 LOOP
  RAISE NOTICE 'Private transcript: authenticated pin round %',round;
  changed:=false;
  IF EXISTS(SELECT 1 FROM pg_temp.transcript_reader_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
  THEN RAISE EXCEPTION 'transcript_reader_authenticated_code_changed';END IF;
  FOR previous IN SELECT o.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM pg_temp.transcript_reader_originals o JOIN pg_proc p ON p.oid=o.oid WHERE o.body IS DISTINCT FROM p.prosrc
  LOOP
   FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid AND
    (position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0)
   LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_temp.transcript_reader_originals o WHERE o.oid=caller.oid AND o.expected_body=caller.prosrc)
    THEN RAISE EXCEPTION 'transcript_reader_unauthenticated_pin_consumer: %',caller.oid::regprocedure;END IF;
    body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
    IF body IS DISTINCT FROM caller.prosrc THEN
     EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);
     UPDATE pg_temp.transcript_reader_originals SET expected_body=controlled_repin.body WHERE oid=caller.oid;
     changed:=true;
    END IF;
   END LOOP;
   UPDATE pg_temp.transcript_reader_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
    fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  IF NOT changed THEN EXIT;END IF;
  IF round=64 THEN RAISE EXCEPTION 'transcript_reader_pin_cycle';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.transcript_reader_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
 THEN RAISE EXCEPTION 'transcript_reader_successor_code_changed';END IF;
END $controlled_repin$;
DO $$ BEGIN RAISE NOTICE 'Private transcript: rebuilding authenticated reference rows';END $$;
DO $reference_rows$
<<reference_rows>>
DECLARE routine_row pg_proc;initial_body text;body text;member_oids oid[];
 columns_sql text;row_sql text;comparisons text;catalog_shape jsonb;rows_sql text;
 row_start integer;row_end integer;tail text;
BEGIN
 SELECT * INTO STRICT routine_row FROM pg_proc WHERE oid='application_native_field_reference_helpers_current()'::regprocedure;
 SELECT o.initial_body INTO STRICT initial_body FROM pg_temp.transcript_reader_originals o
 WHERE o.oid=reference_rows.routine_row.oid AND o.expected_body=reference_rows.routine_row.prosrc
  AND o.metadata=to_jsonb(reference_rows.routine_row)-'prosrc';
 SELECT array_agg(to_regprocedure('public.'||r.signature)::oid) INTO member_oids FROM unnest(ARRAY['agent_read_scope_allows(text,text[],uuid[])','agent_scope_grant_allows(text,text[])','agent_visibility_allows(uuid,uuid,uuid)','application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)','application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)','application_current_field_snapshot(uuid,uuid)','application_empty_query_helpers_current()','application_empty_query_worklist_current(uuid,jsonb)','application_empty_query_worklist_reset(jsonb)','application_field_digest(jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_history(uuid,jsonb,text,uuid,text,text,text[])','application_field_projection_state_before_memory_query(uuid,jsonb,text,uuid,text,text,text[])','application_field_resource_uuid(text)','application_memory_field_keys()','application_memory_field_state(uuid,uuid,text[])','application_memory_field_state_before_successor(uuid,uuid,text[])','application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)','application_memory_history_status(uuid,uuid,text)','application_memory_query_candidate_state(uuid,uuid,text[],jsonb)','application_memory_query_context(uuid)','application_memory_query_domain_state(uuid,uuid,text[])','application_memory_statement_domain(uuid,uuid,text[],jsonb)','application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)','application_memory_statement_helpers_current()','application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)','application_memory_statement_state(uuid,uuid,text[],jsonb)','application_native_catalog_port_valid(regprocedure)','application_native_dependency_batch_helpers_current()','application_native_field_catalog_for(uuid,jsonb,text)','application_native_field_contract_before_catalog(uuid,jsonb,text,text)','application_native_field_contract_for(uuid,jsonb,text,text)','application_native_field_rule_allows(jsonb,text[])','application_native_file_capture_helpers_current()','application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)','application_native_member_field_permissions(uuid,jsonb,uuid)','application_native_query_bounds(uuid)','application_native_record_port_valid(regprocedure)','application_native_same_destination(uuid,text,uuid,text,uuid)','application_native_source_edges_dispatch(uuid,text,uuid,text)','application_normalize_native_query_bounds(jsonb)','application_principal_query_bounds(uuid,uuid,boolean)','application_query_scope_cap(integer,jsonb,jsonb)','application_query_scope_intersection(jsonb,jsonb)','application_query_scope_valid(jsonb)','application_query_set_intersection(jsonb,jsonb)','application_reader_envelope_visible(uuid,jsonb)','application_recorded_field_root_capture(uuid,uuid,text,integer)','application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)','application_recorded_field_state_before_session_eval(uuid,uuid,text,integer)','application_scope_lineage(uuid,text[],uuid[],text[])','application_scope_source_edges(uuid,text,uuid,text)','application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)','application_session_eval_field(uuid,uuid,text,jsonb)','application_session_eval_scope(uuid,text,uuid,text,jsonb)','assistant_placement_visible(uuid,uuid)','capture_native_session_projection_batch(uuid,uuid,integer,text)','crm_capture_erasure_effect()','department_principal_grant_snapshot(uuid)','department_read_grants()','department_read_grants_for(uuid)','department_row_allows(jsonb,uuid,text,text[],uuid)','effective_member_read_compartments(uuid,uuid)','effective_member_team_compartments(uuid,uuid)','enqueue_native_field_dependency_work()','entity_derivation_envelope_valid(jsonb)','guard_application_field_lineage()','guard_external_source_derivation()','guard_page_derivation_receipts()','guard_session_context_lineage()','guard_session_recording_privacy()','guard_workflow_derivation_receipts()','knowledge_version_source_edges(uuid,text,uuid,text)','legacy_assistant_team_compartments(uuid)','member_operation_grants(boolean,uuid)','member_operation_row_allows(jsonb,uuid,text,text[])','member_operation_scope_allows(uuid,text,text[],boolean)','member_principal_operation_grants(uuid,boolean,uuid)','project_member_live(uuid,text,uuid)','read_admitted_native_scope_snapshot(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_knowledge_versions(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_persistent_context(uuid,text,uuid)','read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid)','read_application_field_dependencies(uuid,text[],uuid[],text[])','read_entity_derivation_source(uuid,text,uuid)','read_entity_derivation_source_before_application_fields(uuid,text,uuid)','read_entity_derivation_source_before_blueprint(uuid,text,uuid)','read_entity_derivation_source_before_browser_profile(uuid,text,uuid)','read_entity_derivation_source_before_browser_session(uuid,text,uuid)','read_entity_derivation_source_before_capture(uuid,text,uuid)','read_entity_derivation_source_before_conversation(uuid,text,uuid)','read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_source_parent(uuid,text,uuid)','read_entity_derivation_source_before_knowledge_versions(uuid,text,uuid)','read_entity_derivation_source_before_memory_successor(uuid,text,uuid)','read_entity_derivation_source_before_page(uuid,text,uuid)','read_entity_derivation_source_before_persistent_context(uuid,text,uuid)','read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)','read_entity_derivation_source_before_recordings(uuid,text,uuid)','read_entity_derivation_source_before_workflow_run(uuid,text,uuid)','read_external_source_dependencies(uuid,text[],uuid[],text[])','read_media_parent_snapshot(uuid,text,uuid)','read_media_parent_snapshot_before_blueprint(uuid,text,uuid)','read_media_parent_snapshot_before_browser_profile(uuid,text,uuid)','read_media_parent_snapshot_before_browser_session(uuid,text,uuid)','read_media_parent_snapshot_before_conversation(uuid,text,uuid)','read_media_parent_snapshot_before_page(uuid,text,uuid)','read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)','read_media_parent_snapshot_before_workflow_run(uuid,text,uuid)','read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_field_reference_snapshot(uuid,uuid,uuid,text)','read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','read_native_file_session_field_snapshots(uuid,uuid[],text[])','read_native_memory_query_cohort_sources(uuid,text[],uuid[],text[])','read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)','read_native_session_query_cohort_sources(uuid,text[],uuid[],text[])','read_resource_page_dependencies(uuid,text,uuid,text)','read_scope_source(uuid,text,uuid)','read_scope_source_before_application_fields(uuid,text,uuid)','read_scope_source_before_browser_profile(uuid,text,uuid)','read_scope_source_before_browser_session(uuid,text,uuid)','read_scope_source_before_external(uuid,text,uuid)','read_scope_source_before_knowledge_binding(uuid,text,uuid)','read_scope_source_before_page(uuid,text,uuid)','read_scope_source_before_persistent_context(uuid,text,uuid)','read_scope_source_before_routines(uuid,text,uuid)','read_scope_source_before_workflow_run(uuid,text,uuid)','recording_source_read_allowed(uuid,text,uuid)','refuse_quarantined_recording_message()','scope_review_state_held(text,uuid)','scope_source_ancestors(uuid,text,uuid)','scope_source_ancestors_before_browser_profile(uuid,text,uuid)','scope_source_ancestors_before_browser_session(uuid,text,uuid)','scope_source_ancestors_before_workflow_run(uuid,text,uuid)','scope_source_table(text)','scope_source_table_before_knowledge_versions(text)','scope_source_table_before_media(text)','scope_source_table_before_persistent_context(text)','sensitivity_rank(text)','session_recording_read_allowed(uuid)','validate_application_field_dependencies()','validate_native_field_dependency_batch(uuid,uuid,jsonb)','validate_page_derivation_dependencies()','validate_scope_resource_reference()','validate_workflow_derivation_dependencies()','workflow_evidence_envelope_visible(uuid,jsonb)']::text[]) r(signature);
 IF cardinality(member_oids)<>156 OR array_position(member_oids,NULL) IS NOT NULL OR
  (SELECT count(*) FROM pg_temp.transcript_reader_originals o JOIN pg_proc member ON member.oid=o.oid
   WHERE member.oid=ANY(member_oids) AND member.prosrc=o.expected_body AND (to_jsonb(member)-'prosrc')=o.metadata)<>156
 THEN RAISE EXCEPTION 'transcript_reader_reference_members_changed';END IF;
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
 THEN RAISE EXCEPTION 'transcript_reader_reference_template_changed';END IF;
 row_end:=length(initial_body)-position(reverse(tail) IN reverse(initial_body))-length(tail)+2;
 IF row_end<=row_start THEN RAISE EXCEPTION 'transcript_reader_reference_row_bounds_changed';END IF;
 EXECUTE 'SELECT string_agg(''(''||'||row_sql||'||'')'','','' ORDER BY p.oid) FROM pg_catalog.pg_proc p WHERE p.oid=ANY($1)' INTO rows_sql USING member_oids;
 body:=left(initial_body,row_start-1)||rows_sql||substring(initial_body FROM row_end);
 EXECUTE replace(pg_get_functiondef(reference_rows.routine_row.oid),reference_rows.routine_row.prosrc,body);
 UPDATE pg_temp.transcript_reader_originals SET expected_body=reference_rows.body WHERE oid=reference_rows.routine_row.oid;
END $reference_rows$;

DO $controlled_repin$
<<controlled_repin>>
DECLARE previous record;caller record;body text;round integer;changed boolean;
BEGIN
 FOR round IN 1..64 LOOP
  RAISE NOTICE 'Private transcript: authenticated pin round %',round;
  changed:=false;
  IF EXISTS(SELECT 1 FROM pg_temp.transcript_reader_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
   WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
  THEN RAISE EXCEPTION 'transcript_reader_authenticated_code_changed';END IF;
  FOR previous IN SELECT o.*,p.prosrc current_body,
   encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
   FROM pg_temp.transcript_reader_originals o JOIN pg_proc p ON p.oid=o.oid WHERE o.body IS DISTINCT FROM p.prosrc
  LOOP
   FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.prokind='f' AND p.oid<>previous.oid AND
    (position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0)
   LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_temp.transcript_reader_originals o WHERE o.oid=caller.oid AND o.expected_body=caller.prosrc)
    THEN RAISE EXCEPTION 'transcript_reader_unauthenticated_pin_consumer: %',caller.oid::regprocedure;END IF;
    body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
    IF body IS DISTINCT FROM caller.prosrc THEN
     EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);
     UPDATE pg_temp.transcript_reader_originals SET expected_body=controlled_repin.body WHERE oid=caller.oid;
     changed:=true;
    END IF;
   END LOOP;
   UPDATE pg_temp.transcript_reader_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
    fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
  END LOOP;
  IF NOT changed THEN EXIT;END IF;
  IF round=64 THEN RAISE EXCEPTION 'transcript_reader_pin_cycle';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_temp.transcript_reader_originals o LEFT JOIN pg_proc p ON p.oid=o.oid
  WHERE p.oid IS NULL OR p.prosrc IS DISTINCT FROM o.expected_body OR (to_jsonb(p)-'prosrc') IS DISTINCT FROM o.metadata)
 THEN RAISE EXCEPTION 'transcript_reader_successor_code_changed';END IF;
END $controlled_repin$;
UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
 FROM pg_proc p JOIN pg_temp.transcript_reader_originals o ON o.oid=p.oid AND o.expected_body=p.prosrc AND o.metadata=to_jsonb(p)-'prosrc'
 WHERE p.oid=to_regprocedure(h.signature);
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
    ||values_sql||' LEFT JOIN pg_catalog.pg_proc p ON p.oid=m.oid LEFT JOIN pg_temp.transcript_reader_originals o ON o.oid=m.oid WHERE NOT('||comparisons||') LIMIT 12) differences' INTO members;
   member_drift:=member_drift||jsonb_build_object(guard_signature,members);
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(h.signature),'[]'::jsonb) INTO members FROM native_turn_contract_helpers h
 LEFT JOIN pg_proc p ON p.oid=to_regprocedure(h.signature)
 WHERE h.fingerprint IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex');
 RAISE EXCEPTION 'transcript_reader_successor_contract_changed: %',jsonb_build_object('guards',guard_states,'flatMembers',member_drift,'readerMembers',members);
END $successor_diagnostics$;
DO $source_kind$ DECLARE definition text;before text;BEGIN
 definition:=pg_get_functiondef('record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure);
 before:=$text$'external_source','office_observation')$text$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'private_transcript_source_vocabulary_changed';END IF;
 EXECUTE replace(definition,before,$text$'external_source','office_observation','private_transcript')$text$);
END $source_kind$;
COMMIT;
