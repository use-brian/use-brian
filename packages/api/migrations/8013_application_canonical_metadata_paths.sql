-- Canonical authority metadata must never resolve caller-created temporary rows.
-- Additive hardening of the reviewed application/source helper dependency set.
-- [COMP:security/native-field-policy] [COMP:api/application-field-evidence]
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

DO $canonical_paths$
DECLARE signature text; target regprocedure;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'application_admitted_native_metadata(uuid,text,uuid)',
  'application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)',
  'application_current_field_snapshot(uuid,uuid)',
  'application_field_digest(jsonb)',
  'application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])',
  'application_field_reference_admitted(uuid,jsonb)',
  'application_field_references(uuid,jsonb,text,jsonb)',
  'application_field_resource_uuid(text)',
  'application_materialize_field_envelope(uuid,jsonb,integer)',
  'application_recorded_field_state(uuid,uuid,text,integer)',
  'application_scope_lineage(uuid,text[],uuid[],text[])',
  'application_scope_source_edges(uuid,text,uuid,text)',
  'assistant_placement_visible(uuid,uuid)',
  'audit_connector_source_profile()',
  'capture_page_event_observation(uuid,uuid,text,jsonb)',
  'external_source_authority_fingerprint(uuid,uuid)',
  'external_source_retention_allowed(uuid,uuid,text)',
  'external_source_snapshot(uuid,uuid)',
  'guard_application_field_lineage()',
  'guard_application_field_metadata()',
  'guard_external_source_derivation()',
  'guard_external_source_metadata()',
  'legacy_assistant_team_compartments(uuid)',
  'observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])',
  'page_event_principal_allows(uuid,uuid,jsonb)',
  'page_event_scope_descriptor(uuid,text,jsonb,boolean)',
  'page_scope_source_snapshot(uuid,text,uuid)',
  'project_member_live(uuid,text,uuid)',
  'read_admitted_application_field_dependencies(uuid,text[],uuid[],text[])',
  'read_admitted_application_field_snapshot(uuid,uuid,text)',
  'read_admitted_external_source_dependencies(uuid,text[],uuid[],text[])',
  'read_admitted_external_source_dependencies_before_fields(uuid,text[],uuid[],text[])',
  'read_admitted_native_scope_snapshot(uuid,text,uuid)',
  'read_admitted_page_dependencies(uuid,text,uuid,text)',
  'read_admitted_page_dependencies_before_fields(uuid,text,uuid,text)',
  'read_application_field_dependencies(uuid,text[],uuid[],text[])',
  'read_entity_derivation_source(uuid,text,uuid)',
  'read_entity_derivation_source_before_blueprint(uuid,text,uuid)',
  'read_entity_derivation_source_before_conversation(uuid,text,uuid)',
  'read_entity_derivation_source_before_engineering_archive(uuid,text,uuid)',
  'read_entity_derivation_source_before_page(uuid,text,uuid)',
  'read_entity_derivation_source_before_primitive_v2(uuid,text,uuid)',
  'read_external_source_dependencies(uuid,text[],uuid[],text[])',
  'read_media_parent_snapshot(uuid,text,uuid)',
  'read_media_parent_snapshot_before_blueprint(uuid,text,uuid)',
  'read_media_parent_snapshot_before_conversation(uuid,text,uuid)',
  'read_media_parent_snapshot_before_page(uuid,text,uuid)',
  'read_media_parent_snapshot_before_primitive_v2(uuid,text,uuid)',
  'read_page_derivation_source(uuid,text,uuid)',
  'read_page_event_authority(uuid,uuid,uuid)',
  'read_page_scope_authority(uuid,text,uuid,uuid)',
  'read_resource_page_dependencies(uuid,text,uuid,text)',
  'read_scope_source(uuid,text,uuid)',
  'read_scope_source_before_application_fields(uuid,text,uuid)',
  'read_scope_source_before_external(uuid,text,uuid)',
  'read_scope_source_before_page(uuid,text,uuid)',
  'read_scope_source_before_routines(uuid,text,uuid)',
  'read_workflow_derivation_inputs(uuid,uuid)',
  'read_workflow_derivation_inputs_before_knowledge(uuid,uuid)',
  'read_workflow_derivation_inputs_before_metadata(uuid,uuid)',
  'read_workflow_derivation_inputs_before_page(uuid,uuid)',
  'read_workflow_derivation_inputs_before_tasks(uuid,uuid)',
  'record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)',
  'routine_task_sources_visible(uuid)',
  'scope_source_ancestors(uuid,text,uuid)',
  'validate_application_field_dependencies()',
  'workflow_derivation_snapshot(uuid,uuid)',
  'workflow_evidence_envelope_visible(uuid,jsonb)',
  'workflow_history_evidence_visible(uuid)',
  'workflow_history_evidence_visible_before_knowledge(uuid)',
  'workflow_history_evidence_visible_before_metadata(uuid)',
  'workflow_history_evidence_visible_before_page(uuid)',
  'workflow_history_evidence_visible_before_tasks(uuid)',
  'workflow_page_event_boundary(saved_views)',
  'workflow_scope_evidence_visible(uuid,jsonb)',
  'workflow_scope_evidence_visible_before_page(uuid,jsonb)'
 ] LOOP
  target:=to_regprocedure('public.'||signature);
  IF target IS NULL THEN
   RAISE EXCEPTION 'canonical_metadata_helper_missing: %',signature USING ERRCODE='22023';
  END IF;
  EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,public,pg_temp',target);
 END LOOP;
END $canonical_paths$;
COMMIT;
