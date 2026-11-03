-- Setup completion must not activate the superseded admission model in v2.
-- All department row policies, source/parent guards, holding, provenance and
-- immutable execution/snapshot constraints remain installed and enabled.
BEGIN;
CREATE FUNCTION public.classic_mode_admission_required(w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.workspace_access_policies p
 JOIN public.workspaces workspace ON workspace.id=p.workspace_id
 WHERE p.workspace_id=w AND p.setup_state<>'legacy' AND NOT workspace.department_read_v2)
$$;
CREATE OR REPLACE FUNCTION public.require_workspace_creation_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy public.workspace_access_policies; receipt jsonb; body jsonb; actor uuid;
  actual_compartments jsonb; actual_projects jsonb; expected_projects jsonb;
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  SELECT * INTO policy FROM public.workspace_access_policies WHERE workspace_id=NEW.workspace_id;
  IF NOT FOUND OR NOT public.classic_mode_admission_required(NEW.workspace_id) THEN RETURN NEW; END IF;
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

-- Retain the entire current guarded implementation, including later fixes,
-- changing only its permission-model selector. Assert the known selector is
-- present so an unexpected schema never silently installs a partial patch.
DO $migration$
DECLARE signature text; definition text; updated text;
BEGIN
  FOR signature IN SELECT unnest(ARRAY[
    'public.require_session_creation_admission()',
    'public.guard_connector_setup_publication()',
    'public.lock_office_generation_template_source(uuid,uuid,uuid)'
  ]) LOOP
    definition:=pg_get_functiondef(signature::regprocedure);
    IF signature='public.require_session_creation_admission()' THEN
      updated:=replace(definition,'AND setup_state<>''legacy''' ,'AND public.classic_mode_admission_required(workspace_id)');
    ELSIF signature='public.guard_connector_setup_publication()' THEN
      updated:=replace(definition,'p.setup_state=''ready''' ,'public.classic_mode_admission_required(p.workspace_id)');
    ELSE
      updated:=replace(definition,'workspace_id=w AND setup_state<>''legacy''' ,'workspace_id=w AND public.classic_mode_admission_required(workspace_id)');
    END IF;
    IF updated=definition THEN RAISE EXCEPTION 'mode_selector_schema_changed: %',signature; END IF;
    EXECUTE updated;
  END LOOP;
END
$migration$;
COMMIT;
