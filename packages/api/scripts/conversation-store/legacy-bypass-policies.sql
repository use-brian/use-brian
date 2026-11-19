-- [COMP:api/migration-owner-role] Closed predecessor policy inventory, 8296.
-- Hosted pending_classifications is paired with the subsequent overlay migration.
CREATE TEMP TABLE legacy_bypass_policies(relation name,policy name,forced boolean) ON COMMIT DROP;
INSERT INTO legacy_bypass_policies VALUES
 ('connector_pending_setups','connector_setup_system',true),
 ('connector_rotation_attempts','connector_rotation_attempts_system',true),
 ('connector_setup_auth_material','connector_setup_auth_material_system',true),
 ('connector_setup_identity','connector_setup_identity_system',true),
 ('connector_setup_rotation_receipts','connector_setup_rotation_system',true),
 ('connector_setup_staged_credentials','connector_setup_credentials_system',true),
 ('crm_billing_requests','crm_billing_requests_system',false),
 ('crm_business_reference_history','crm_business_reference_history_system',false),
 ('crm_business_references','crm_business_references_system',false),
 ('crm_change_request_decisions','crm_change_request_decisions_system',false),
 ('crm_change_request_revisions','crm_change_request_revisions_system',false),
 ('crm_change_requests','crm_change_requests_system',false),
 ('crm_commercial_preparations','crm_commercial_preparations_system',false),
 ('crm_commercial_profile_versions','crm_commercial_profile_versions_system',false),
 ('crm_commercial_values','crm_commercial_values_system',false),
 ('crm_customer_accounts','crm_customer_accounts_system',false),
 ('crm_cutover_runs','crm_cutover_runs_system',false),
 ('crm_engagement_catalogs','crm_engagement_catalogs_system',false),
 ('crm_engagement_extensions','crm_engagement_extensions_system',false),
 ('crm_entity_separations','crm_entity_separations_system_bypass',false),
 ('crm_erp_imports','crm_erp_imports_system',false),
 ('crm_governance_policies','crm_governance_policies_system',false),
 ('crm_identity_bindings','crm_identity_bindings_system_bypass',false),
 ('crm_invoice_allocations','crm_invoice_allocations_system',false),
 ('crm_invoice_lines','crm_invoice_lines_system',false),
 ('crm_invoices','crm_invoices_system',false),
 ('crm_issue_attempts','crm_issue_attempts_system',false),
 ('crm_legacy_id_mappings','crm_legacy_id_mappings_system',false),
 ('crm_number_partitions','crm_number_partitions_system',false),
 ('crm_number_series','crm_number_series_system',false),
 ('crm_operation_definitions','crm_operation_definitions_system',false),
 ('crm_operation_receipts','crm_operation_receipts_system',false),
 ('crm_operation_versions','crm_operation_versions_system',false),
 ('crm_preparation_versions','crm_preparation_versions_system',false),
 ('crm_projection_events','crm_projection_events_system',false),
 ('crm_projection_receipts','crm_projection_receipts_system',false),
 ('crm_provider_bindings','crm_provider_bindings_system',false),
 ('crm_reference_definitions','crm_reference_definitions_system',false),
 ('crm_seller_profiles','crm_seller_profiles_system',false),
 ('decision_applications','decision_applications_system_bypass',false),
 ('decision_derivations','decision_derivations_system_bypass',false),
 ('decision_events','decision_events_system_bypass',false),
 ('ingest_external_sink','ingest_external_sink_system',false),
 ('ingest_outbox','ingest_outbox_system',false),
 ('memory_summary_slots','memory_summary_slots_system',false),
 ('pending_ingest_batches','pending_ingest_batches_system',false),
 ('programmatic_capture_profiles','programmatic_capture_profiles_system',false),
 ('programmatic_capture_receipts','programmatic_capture_receipts_system',false),
 ('scope_derivation_sources','scope_derivation_sources_system',false),
 ('scope_derivations','scope_derivations_system',false),
 ('scope_resource_states','scope_resource_states_system',false),
 ('wa_auth_state','wa_auth_state_system',false),
 ('workspace_access_command_reviews','workspace_access_command_review_system',false),
 ('workspace_access_events','organization_system',false),
 ('workspace_access_grants','access_grants_system',false),
 ('workspace_access_inventory_checkpoints','inventory_system',false),
 ('workspace_access_inventory_snapshots','inventory_system',false),
 ('workspace_access_migration_items','workspace_access_migration_items_system',false),
 ('workspace_access_migration_plans','workspace_access_migration_plans_system',false),
 ('workspace_access_migration_resource_reviews','migration_resource_reviews_system',false),
 ('workspace_access_migration_reviews','migration_reviews_system',false),
 ('workspace_access_policies','workspace_access_policies_system',false),
 ('workspace_access_requests','access_requests_system',false),
 ('workspace_org_placements','organization_system',false),
 ('workspace_org_state','organization_system',false),
 ('workspace_org_units','organization_system',false),
 ('workspace_scope_review_items','workspace_scope_review_items_system',false),
 ('workspace_scope_reviews','workspace_scope_reviews_system',false),
 ('workspace_skill_scope_revisions','workspace_skill_scope_revision_system_write',false),
 ('workspace_team_managers','organization_system',false);
CREATE TEMP TABLE legacy_bypass_inert_policies(relation name,policy name,explicit_check boolean) ON COMMIT DROP;
INSERT INTO legacy_bypass_inert_policies VALUES
 ('crm_activities','crm_activities_system',false),
 ('crm_consent_purpose_versions','crm_consent_versions_system',true),
 ('crm_consent_purposes','crm_consent_purposes_system',true),
 ('crm_deal_contacts','crm_deal_contacts_system',false),
 ('crm_domain_event_outbox','crm_domain_event_outbox_system',true),
 ('crm_email_draft_session_anchors','crm_email_draft_session_anchors_system',false),
 ('crm_email_draft_versions','crm_email_draft_versions_system',false),
 ('crm_email_drafts','crm_email_drafts_system',false),
 ('crm_field_definitions','crm_field_definitions_system',false),
 ('crm_import_chunks','crm_import_chunks_system',true),
 ('crm_import_errors','crm_import_errors_system',true),
 ('crm_import_jobs','crm_import_jobs_system',true),
 ('crm_import_rows','crm_import_rows_system',true),
 ('crm_intake_credential_definitions','crm_intake_credential_definitions_system',true),
 ('crm_intake_credentials','crm_intake_credentials_system',true),
 ('crm_intake_definition_versions','crm_intake_definition_versions_system',true),
 ('crm_intake_definitions','crm_intake_definitions_system',true),
 ('crm_intake_idempotency','crm_intake_idempotency_system',true),
 ('crm_pipeline_stages','crm_pipeline_stages_system',false),
 ('crm_pipelines','crm_pipelines_system',false),
 ('crm_saved_views','crm_saved_views_system',false),
 ('crm_segments','crm_segments_system',true),
 ('crm_suppression_events','crm_suppression_events_system',true),
 ('realtime_thread_targets','realtime_thread_targets_system_bypass',true),
 ('task_candidates','task_candidates_system_bypass',false),
 ('task_rules','task_rules_system_bypass',false),
 ('task_tombstones','task_tombstones_system_bypass',false),
 ('workspace_brand_versions','brand_versions_system_bypass',false),
 ('workspace_brands','workspace_brands_system_bypass',false);

DO $legacy_policy_inventory$
DECLARE
 marker constant text:='app.system_bypass';
 leg constant text:=$expr$(current_setting('app.system_bypass'::text, true) = 'true'::text)$expr$;
 approval_predecessor constant text:=$expr$((kind <> 'department_access'::text) OR (current_setting('app.system_bypass'::text, true) = 'true'::text) OR can_view_department_request((NULLIF((approval_payload ->> 'requestId'::text), ''::text))::uuid, (NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid))$expr$;
 approval_successor constant text:=$expr$(kind <> 'department_access'::text) OR
  public.can_view_department_request(NULLIF(approval_payload->>'requestId','')::uuid,
   NULLIF(current_setting('app.current_user_id',true),'')::uuid)$expr$;
 expected_count integer;
 current_policy pg_policy;
 relation pg_class;
 target record;
 owner_name name;
 deployment_owner constant oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);
 forced_before oid[];
BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
  RAISE EXCEPTION 'legacy_bypass_unreviewed_ddl_trigger';
 END IF;
 SELECT array_agg(oid ORDER BY oid) INTO forced_before FROM pg_class WHERE relforcerowsecurity;
 SELECT count(*) INTO expected_count FROM pg_temp.legacy_bypass_policies;
 IF expected_count<>70 OR (SELECT count(*) FROM pg_temp.legacy_bypass_policies WHERE forced)<>6 THEN
  RAISE EXCEPTION 'legacy_bypass_source_policy_inventory_changed';
 END IF;
 -- Require exactly the checked predecessor policy set. Hosted entries have their own owner and migration.
 IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid<>coalesce(to_regclass('public.pending_classifications')::oid,0::oid)
      AND strpos(concat(pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)),marker)>0)<>expected_count+1
 THEN RAISE EXCEPTION 'legacy_bypass_policy_inventory_changed';END IF;
 FOR target IN SELECT * FROM pg_temp.legacy_bypass_policies LOOP
  SELECT * INTO relation FROM pg_class WHERE oid=to_regclass(format('public.%I',target.relation));
  SELECT * INTO current_policy FROM pg_policy WHERE polrelid=relation.oid AND polname=target.policy;
  IF relation.oid IS NULL OR NOT relation.relrowsecurity OR relation.relforcerowsecurity IS DISTINCT FROM target.forced
   OR current_policy.oid IS NULL OR current_policy.polcmd<>'*' OR NOT current_policy.polpermissive
   OR current_policy.polroles<>ARRAY[0::oid]
   OR pg_get_expr(current_policy.polqual,relation.oid) IS DISTINCT FROM leg
   OR pg_get_expr(current_policy.polwithcheck,relation.oid) IS DISTINCT FROM leg
  THEN RAISE EXCEPTION 'legacy_bypass_policy_predecessor_changed: %.%',target.relation,target.policy;END IF;
  IF target.forced AND (relation.relowner IS DISTINCT FROM deployment_owner OR pg_has_role('app_user',relation.relowner,'MEMBER')) THEN
   RAISE EXCEPTION 'legacy_bypass_connector_owner_unsafe: %',target.relation;
  END IF;
 END LOOP;
 FOR target IN SELECT * FROM pg_temp.legacy_bypass_inert_policies LOOP
  SELECT * INTO relation FROM pg_class WHERE oid=to_regclass(format('public.%I',target.relation));
  SELECT * INTO current_policy FROM pg_policy WHERE polrelid=relation.oid AND polname=target.policy;
  IF relation.oid IS NULL OR NOT relation.relrowsecurity OR relation.relforcerowsecurity
   OR current_policy.oid IS NULL OR current_policy.polcmd<>'*' OR NOT current_policy.polpermissive
   OR current_policy.polroles<>ARRAY[0::oid]
   OR pg_get_expr(current_policy.polqual,relation.oid) IS DISTINCT FROM 'false'
   OR pg_get_expr(current_policy.polwithcheck,relation.oid) IS DISTINCT FROM (CASE WHEN target.explicit_check THEN 'false' END)
  THEN RAISE EXCEPTION 'legacy_bypass_inert_predecessor_changed: %.%',target.relation,target.policy;END IF;
 END LOOP;
 SELECT * INTO current_policy FROM pg_policy WHERE polrelid='public.pending_approvals'::regclass AND polname='department_approval_privacy';
 IF current_policy.oid IS NULL OR current_policy.polcmd<>'r' OR current_policy.polpermissive OR current_policy.polroles<>ARRAY[0::oid]
  OR pg_get_expr(current_policy.polqual,current_policy.polrelid) IS DISTINCT FROM approval_predecessor OR current_policy.polwithcheck IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=current_policy.polrelid AND relrowsecurity AND NOT relforcerowsecurity)
 THEN RAISE EXCEPTION 'legacy_bypass_pending_approval_predecessor_changed';END IF;

 FOR target IN SELECT * FROM pg_temp.legacy_bypass_policies LOOP
  IF target.forced THEN
   SELECT pg_get_userbyid(relowner) INTO STRICT owner_name FROM pg_class WHERE oid=to_regclass(format('public.%I',target.relation));
   EXECUTE format('ALTER POLICY %I ON public.%I TO %I USING (true) WITH CHECK (true)',target.policy,target.relation,owner_name);
  ELSE
   EXECUTE format('DROP POLICY %I ON public.%I',target.policy,target.relation);
  END IF;
 END LOOP;
 FOR target IN SELECT * FROM pg_temp.legacy_bypass_inert_policies LOOP
  EXECUTE format('DROP POLICY %I ON public.%I',target.policy,target.relation);
 END LOOP;
 EXECUTE format('ALTER POLICY department_approval_privacy ON public.pending_approvals USING (%s)',approval_successor);
 IF (SELECT array_agg(oid ORDER BY oid) FROM pg_class WHERE relforcerowsecurity) IS DISTINCT FROM forced_before THEN
  RAISE EXCEPTION 'legacy_bypass_force_flags_changed';
 END IF;
END $legacy_policy_inventory$;
