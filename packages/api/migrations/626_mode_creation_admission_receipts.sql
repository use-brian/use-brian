-- Version-one creation admission protocol for the implemented canonical stores.
-- This is a mixed-version backstop, not a substitute for resource RLS/authority.
-- Legacy workspaces retain their existing semantics. More writer families must
-- be integrated/certified before any production mode activation is enabled.
BEGIN;
CREATE FUNCTION public.require_workspace_creation_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy public.workspace_access_policies; receipt jsonb; body jsonb; actor uuid;
  actual_compartments jsonb; actual_projects jsonb; expected_projects jsonb;
BEGIN
  PERFORM 1 FROM public.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
  SELECT * INTO policy FROM public.workspace_access_policies WHERE workspace_id=NEW.workspace_id;
  IF NOT FOUND OR policy.setup_state='legacy' THEN RETURN NEW; END IF;
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
DO $$ DECLARE row record; BEGIN
  FOR row IN SELECT * FROM (VALUES
    ('tasks','task'),('memories','memory'),('episodes','episode'),('workspace_files','workspace_file'),
    ('entities','entity'),('entity_links','entity_link'),('knowledge_entries','knowledge_entry')
  ) AS writers(table_name,kind) LOOP
    -- Run after inherited-scope BEFORE triggers, against the actual persisted envelope.
    EXECUTE format('CREATE TRIGGER zzzz_workspace_creation_admission BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.require_workspace_creation_admission(%L)',row.table_name,row.kind);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.require_workspace_creation_admission() FROM PUBLIC;
COMMIT;
