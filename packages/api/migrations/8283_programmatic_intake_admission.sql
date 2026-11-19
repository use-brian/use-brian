-- [COMP:api/programmatic-capture] Restore the 642 programmatic branches that 8171 dropped.
-- 8171 rewrote require_workspace_creation_admission() from the 626 body to add the
-- classic_mode_admission_required selector, which removed the programmatic batch
-- episode and candidate branches. This installs the 642 body with only that selector.
BEGIN;
DO $authenticate$
DECLARE f pg_proc;
BEGIN
 SELECT * INTO f FROM pg_proc WHERE oid='public.require_workspace_creation_admission()'::regprocedure;
 IF encode(sha256(convert_to(f.prosrc,'UTF8')),'hex')<>'f71b6ece3fd8c367ef7a4fc73f848e5a5f2c48a3760e903a39b31b8196260332'
  OR NOT f.prosecdef OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  OR f.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR f.prorettype<>'trigger'::regtype
  OR f.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass)
 THEN RAISE EXCEPTION 'programmatic_intake_admission_predecessor_changed'; END IF;
END $authenticate$;
CREATE OR REPLACE FUNCTION public.require_workspace_creation_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy public.workspace_access_policies; receipt jsonb; body jsonb; actor uuid;
  actual_compartments jsonb; actual_projects jsonb; expected_projects jsonb;
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  SELECT * INTO policy FROM public.workspace_access_policies WHERE workspace_id=NEW.workspace_id;
  body:=to_jsonb(NEW);
  IF TG_ARGV[0]='episode' AND body->>'programmatic_batch_id' IS NOT NULL THEN
    IF body->>'programmatic_batch_id' IS DISTINCT FROM nullif(current_setting('app.programmatic_publication_batch',true),'')
    OR NOT EXISTS(SELECT 1 FROM public.pending_ingest_batches b
      JOIN public.ingest_rules r ON r.id=b.rule_id
      JOIN public.programmatic_capture_profiles p ON p.id=r.capture_profile_id
      WHERE b.id=(body->>'programmatic_batch_id')::uuid AND b.workspace_id=NEW.workspace_id
      AND b.source='programmatic' AND b.processed_at IS NULL AND NOT b.scope_held
      AND p.intake_binding IS NOT NULL AND body->>'user_id' IS NULL
      AND body->>'assistant_id'=b.assistant_id::text
      AND body->>'created_by_user_id'=p.intake_binding->>'actor'
      AND body->>'created_by_assistant_id'=b.assistant_id::text
      AND body->>'sensitivity'=b.episode_sensitivity
      AND body->'compartments'=to_jsonb(b.compartments) AND body->'project_ids'=to_jsonb(b.project_ids)
      AND body->'source_ref'->>'batch_id'=b.id::text
      AND body->'source_ref'->>'profile_id'=p.id::text AND body->'source_ref'->>'rule_id'=r.id::text
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.events) ev
        WHERE public.programmatic_intake_current(b.workspace_id,b.assistant_id,b.rule_id,ev) IS NOT TRUE))
      THEN RAISE EXCEPTION 'capture_binding_unavailable' USING ERRCODE='42501'; END IF;
    PERFORM set_config('app.programmatic_publication_batch','',true);
    RETURN NEW;
  END IF;
  IF nullif(current_setting('app.programmatic_candidate',true),'') IS NOT NULL THEN
    receipt:=current_setting('app.programmatic_candidate')::jsonb;
    actual_compartments:=programmatic_candidate_source();
    PERFORM set_config('app.programmatic_candidate','',true);
    IF TG_ARGV[0] IS DISTINCT FROM receipt->>'kind'
    OR body->>'source_episode_id' IS DISTINCT FROM receipt->'source'->>'resourceId'
    OR body->>'created_by_user_id' IS DISTINCT FROM receipt->>'actor'
    OR body->>'created_by_assistant_id' IS DISTINCT FROM actual_compartments->>'assistantId'
    OR body->>'source'<>'extracted' OR body->>'source_session_id' IS NOT NULL
    OR body->>'workspace_id' IS DISTINCT FROM actual_compartments->>'workspaceId'
    OR body->>'user_id' IS DISTINCT FROM actual_compartments->>'userId'
    OR body->>'assistant_id' IS DISTINCT FROM actual_compartments->>'assistantId'
    OR body->>'sensitivity' IS DISTINCT FROM actual_compartments->>'sensitivity'
    OR body->'compartments' IS DISTINCT FROM actual_compartments->'compartments'
    OR body->'project_ids' IS DISTINCT FROM actual_compartments->'projectIds'
    THEN RAISE EXCEPTION 'capture_candidate_scope_mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF policy.workspace_id IS NULL OR NOT public.classic_mode_admission_required(NEW.workspace_id) THEN RETURN NEW; END IF;
  BEGIN
    receipt:=nullif(current_setting('app.creation_admission',true),'')::jsonb;
    actor:=(receipt->>'actor')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501';
  END;
  -- Consume exactly once; a batch/secondary insert needs its own admission.
  PERFORM set_config('app.creation_admission','',true);
  body:=to_jsonb(NEW);
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO actual_compartments
    FROM (SELECT DISTINCT value FROM jsonb_array_elements(body->'compartments')) keys;
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO actual_projects
    FROM (SELECT DISTINCT lower(value) AS value FROM jsonb_array_elements_text(body->'project_ids')) ids;
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) INTO expected_projects
    FROM (SELECT DISTINCT lower(value) AS value FROM jsonb_array_elements_text(receipt->'envelope'->'projectIds')) ids;
  IF receipt IS NULL OR receipt->>'protocol' IS DISTINCT FROM '1'
    OR receipt->>'kind' IS DISTINCT FROM TG_ARGV[0]
    OR receipt->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
    OR receipt->>'policyRevision' IS DISTINCT FROM policy.revision::text
    OR actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=actor)
    -- Authorship can legitimately survive supersession by another authorized
    -- actor. Compare the executing RLS identity, not historical created_by.
    OR (nullif(current_setting('app.current_user_id',true),'') IS NOT NULL
      AND nullif(current_setting('app.current_user_id',true),'')::uuid IS DISTINCT FROM actor)
    OR receipt->'rowVisibility'->>'userId' IS DISTINCT FROM body->>'user_id'
    OR receipt->'rowVisibility'->>'assistantId' IS DISTINCT FROM body->>'assistant_id'
    OR receipt->'envelope'->>'visibility' IS DISTINCT FROM (CASE WHEN body->>'user_id' IS NULL THEN 'workspace' ELSE 'private' END)
    OR receipt->'envelope'->>'sensitivity' IS DISTINCT FROM body->>'sensitivity'
    OR receipt->'envelope'->'compartments' IS DISTINCT FROM actual_compartments
    OR expected_projects IS DISTINCT FROM actual_projects
  THEN RAISE EXCEPTION 'workspace_creation_admission_required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
DO $verify$
BEGIN
 IF (SELECT count(*) FROM pg_trigger WHERE tgfoid='public.require_workspace_creation_admission()'::regprocedure AND tgname='zzzz_workspace_creation_admission')<>7
 THEN RAISE EXCEPTION 'programmatic_intake_admission_triggers_changed'; END IF;
END $verify$;
COMMIT;
