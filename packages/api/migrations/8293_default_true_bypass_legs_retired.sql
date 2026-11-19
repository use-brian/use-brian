-- [COMP:api/db-client] Drop the default-true app.system_bypass legs from the 33 reviewed policies.
-- Decision 11, step two. After 8285 these 33 permissive TO PUBLIC policies sit on unforced
-- tables, so the owner bypasses them by ownership and only app_user evaluates them. Their
-- COALESCE(current_setting('app.system_bypass',true),'true')='true' leg read an unset setting
-- as true, so a pooled app connection admitted every identity until its first committed
-- transaction-local elevation and none afterwards. The caller fixes of step one (membership
-- predicates in the realtime thread target, brand, skill runtime source and CRM email draft
-- stores; role-asserted owner-side setters) landed first.
--
-- Each named policy is authenticated by its exact deparsed USING and WITH CHECK, command,
-- permissiveness and TO PUBLIC role, and its table must have RLS enabled and not forced.
-- The 29 bypass-only policies become USING (false) [WITH CHECK (false)]: they admit nothing
-- and no longer read connection state; the schema-wide retirement of the setting (M7) drops
-- them. The four bypass-or-member policies keep exactly their member leg. Where WITH CHECK
-- was absent it stays absent. No FORCE ROW LEVEL SECURITY flag, function, trigger or grant
-- changes. None of the 33 tables or policies is an installation registry member.
BEGIN;
DO $retire$
DECLARE
 bypass constant text:=$e$(COALESCE(current_setting('app.system_bypass'::text, true), 'true'::text) = 'true'::text)$e$;
 default_true constant text:='COALESCE(current_setting(''app.system_bypass''';
 targets constant text[]:=ARRAY[
  ARRAY['crm_activities','crm_activities_system','*',NULL,'false'],
  ARRAY['crm_consent_purpose_versions','crm_consent_versions_system','*',NULL,'true'],
  ARRAY['crm_consent_purposes','crm_consent_purposes_system','*',NULL,'true'],
  ARRAY['crm_deal_contacts','crm_deal_contacts_system','*',NULL,'false'],
  ARRAY['crm_domain_event_outbox','crm_domain_event_outbox_system','*',NULL,'true'],
  ARRAY['crm_email_draft_session_anchors','crm_email_draft_session_anchors_system','*',NULL,'false'],
  ARRAY['crm_email_draft_versions','crm_email_draft_versions_system','*',NULL,'false'],
  ARRAY['crm_email_drafts','crm_email_drafts_system','*',NULL,'false'],
  ARRAY['crm_field_definitions','crm_field_definitions_system','*',NULL,'false'],
  ARRAY['crm_import_chunks','crm_import_chunks_system','*',NULL,'true'],
  ARRAY['crm_import_errors','crm_import_errors_system','*',NULL,'true'],
  ARRAY['crm_import_jobs','crm_import_jobs_system','*',NULL,'true'],
  ARRAY['crm_import_rows','crm_import_rows_system','*',NULL,'true'],
  ARRAY['crm_intake_credential_definitions','crm_intake_credential_definitions_system','*',NULL,'true'],
  ARRAY['crm_intake_credentials','crm_intake_credentials_system','*',NULL,'true'],
  ARRAY['crm_intake_definition_versions','crm_intake_definition_versions_system','*',NULL,'true'],
  ARRAY['crm_intake_definitions','crm_intake_definitions_system','*',NULL,'true'],
  ARRAY['crm_intake_idempotency','crm_intake_idempotency_system','*',NULL,'true'],
  ARRAY['crm_pipeline_stages','crm_pipeline_stages_system','*',NULL,'false'],
  ARRAY['crm_pipelines','crm_pipelines_system','*',NULL,'false'],
  ARRAY['crm_saved_views','crm_saved_views_system','*',NULL,'false'],
  ARRAY['crm_segments','crm_segments_system','*',NULL,'true'],
  ARRAY['crm_suppression_events','crm_suppression_events_system','*',NULL,'true'],
  ARRAY['home_dock_layouts','home_dock_layouts_member','*',$m$(workspace_id IN ( SELECT workspace_members.workspace_id
   FROM workspace_members
  WHERE (workspace_members.user_id = (current_setting('app.current_user_id'::text, true))::uuid)))$m$,'false'],
  ARRAY['page_link_aliases','page_link_aliases_member','*',$m$(namespace_workspace_id IN ( SELECT wm.workspace_id
   FROM workspace_members wm
  WHERE (wm.user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid)))$m$,'true'],
  ARRAY['realtime_thread_targets','realtime_thread_targets_system_bypass','*',NULL,'true'],
  ARRAY['task_candidates','task_candidates_system_bypass','*',NULL,'false'],
  ARRAY['task_rules','task_rules_system_bypass','*',NULL,'false'],
  ARRAY['task_tombstones','task_tombstones_system_bypass','*',NULL,'false'],
  ARRAY['workspace_brand_versions','brand_versions_system_bypass','*',NULL,'false'],
  ARRAY['workspace_brands','workspace_brands_system_bypass','*',NULL,'false'],
  ARRAY['workspace_link_aliases','workspace_link_aliases_member','*',$m$(workspace_id IN ( SELECT wm.workspace_id
   FROM workspace_members wm
  WHERE (wm.user_id = (NULLIF(current_setting('app.current_user_id'::text, true), ''::text))::uuid)))$m$,'true'],
  ARRAY['workspace_skill_scope_revisions','workspace_skill_scope_revision_member_read','r',$m$(workspace_id IN ( SELECT wm.workspace_id
   FROM workspace_members wm
  WHERE (wm.user_id = (current_setting('app.current_user_id'::text, true))::uuid)))$m$,'false']];
 t text[]; found_policy pg_policy; rel pg_class; expected_using text; expected_check text; next_expr text;
 forced_before oid[]; forced_after oid[];
BEGIN
 IF array_length(targets,1)<>33 THEN RAISE EXCEPTION 'bypass_policy_target_count'; END IF;
 -- The schema holds exactly the reviewed default-true policies and no other.
 IF (SELECT count(*) FROM pg_policy p WHERE position(default_true IN coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''))>0)<>33
  OR EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
   WHERE position(default_true IN coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''))>0
    AND NOT EXISTS(SELECT 1 FROM generate_subscripts(targets,1) i
     WHERE targets[i][1]=c.relname AND targets[i][2]=p.polname AND c.relnamespace='public'::regnamespace))
 THEN RAISE EXCEPTION 'bypass_policy_inventory_changed'; END IF;
 SELECT coalesce(array_agg(oid ORDER BY oid),'{}') INTO forced_before FROM pg_class WHERE relforcerowsecurity;

 FOREACH t SLICE 1 IN ARRAY targets LOOP
  SELECT * INTO rel FROM pg_class WHERE oid=to_regclass('public.'||quote_ident(t[1]));
  IF rel.oid IS NULL OR NOT rel.relrowsecurity THEN RAISE EXCEPTION 'bypass_policy_predecessor_changed: %',t[1]; END IF;
  IF rel.relforcerowsecurity THEN RAISE EXCEPTION 'bypass_policy_table_forced: %',t[1]; END IF;
  SELECT * INTO found_policy FROM pg_policy WHERE polrelid=rel.oid AND polname=t[2];
  expected_using:=CASE WHEN t[4] IS NULL THEN bypass ELSE '('||bypass||' OR '||t[4]||')' END;
  expected_check:=CASE WHEN t[5]::boolean THEN expected_using END;
  IF found_policy.oid IS NULL OR found_policy.polcmd::text<>t[3] OR NOT found_policy.polpermissive
   OR found_policy.polroles<>ARRAY[0::oid]
   OR pg_get_expr(found_policy.polqual,found_policy.polrelid) IS DISTINCT FROM expected_using
   OR pg_get_expr(found_policy.polwithcheck,found_policy.polrelid) IS DISTINCT FROM expected_check
  THEN RAISE EXCEPTION 'bypass_policy_predecessor_changed: %',t[1]; END IF;
 END LOOP;

 FOREACH t SLICE 1 IN ARRAY targets LOOP
  next_expr:=coalesce(t[4],'false');
  EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)%s',t[2],t[1],next_expr,
   CASE WHEN t[5]::boolean THEN format(' WITH CHECK (%s)',next_expr) ELSE '' END);
 END LOOP;

 -- Postconditions: same command, kind and role; only the member leg (or false) remains;
 -- none of the 33 reads app.system_bypass; no default-true policy remains anywhere; no
 -- table's FORCE ROW LEVEL SECURITY flag changed.
 FOREACH t SLICE 1 IN ARRAY targets LOOP
  SELECT p.* INTO found_policy FROM pg_policy p WHERE p.polrelid=to_regclass('public.'||quote_ident(t[1])) AND p.polname=t[2];
  expected_using:=coalesce(t[4],'false');
  expected_check:=CASE WHEN t[5]::boolean THEN expected_using END;
  IF found_policy.oid IS NULL OR found_policy.polcmd::text<>t[3] OR NOT found_policy.polpermissive
   OR found_policy.polroles<>ARRAY[0::oid]
   OR pg_get_expr(found_policy.polqual,found_policy.polrelid) IS DISTINCT FROM expected_using
   OR pg_get_expr(found_policy.polwithcheck,found_policy.polrelid) IS DISTINCT FROM expected_check
   OR position('app.system_bypass' IN coalesce(pg_get_expr(found_policy.polqual,found_policy.polrelid),'')
    ||coalesce(pg_get_expr(found_policy.polwithcheck,found_policy.polrelid),''))>0
  THEN RAISE EXCEPTION 'bypass_policy_successor_changed: %',t[1]; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_policy p WHERE position(default_true IN coalesce(pg_get_expr(p.polqual,p.polrelid),'')||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),''))>0)
 THEN RAISE EXCEPTION 'bypass_policy_default_true_remains'; END IF;
 SELECT coalesce(array_agg(oid ORDER BY oid),'{}') INTO forced_after FROM pg_class WHERE relforcerowsecurity;
 IF forced_after IS DISTINCT FROM forced_before THEN RAISE EXCEPTION 'bypass_policy_force_flags_changed'; END IF;
END $retire$;
COMMIT;
