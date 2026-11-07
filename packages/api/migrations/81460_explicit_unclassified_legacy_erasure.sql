-- Explicit owner erasure consent for selected unclassified legacy resources.
-- [COMP:api/workspace-legacy-cleanup]
BEGIN;
CREATE OR REPLACE FUNCTION guard_workspace_legacy_cleanup_review() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ref jsonb; source jsonb; tab text; present boolean; consent boolean; explicit_selection boolean;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
   RAISE EXCEPTION 'legacy_cleanup_review_immutable';END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' AND (NEW.status<>'preview' OR NEW.receipt IS NOT NULL) THEN
  RAISE EXCEPTION 'legacy_cleanup_review_immutable';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['status','receipt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','receipt'])
   OR OLD.status<>'preview' THEN RAISE EXCEPTION 'legacy_cleanup_review_immutable';END IF;
 END IF;
 IF jsonb_typeof(NEW.evidence->'erasures') IS DISTINCT FROM 'array'
  OR jsonb_array_length(NEW.evidence->'erasures')>500 THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
 IF (SELECT count(*)<>count(DISTINCT (value->>'kind')||':'||(value->>'id'))
  FROM jsonb_array_elements(NEW.evidence->'erasures')) THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
 IF NEW.evidence ? 'eraseUnclassifiedLegacy' AND jsonb_typeof(NEW.evidence->'eraseUnclassifiedLegacy') IS DISTINCT FROM 'boolean'
  THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
 IF jsonb_typeof(coalesce(NEW.evidence->'unclassified','[]'::jsonb)) IS DISTINCT FROM 'array'
  OR jsonb_array_length(coalesce(NEW.evidence->'unclassified','[]'::jsonb))>500
  THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
 IF (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(coalesce(NEW.evidence->'unclassified','[]'::jsonb)))
  THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
 FOR ref IN SELECT value FROM jsonb_array_elements(coalesce(NEW.evidence->'unclassified','[]'::jsonb)) LOOP
  IF NEW.evidence->'eraseUnclassifiedLegacy' IS DISTINCT FROM 'true'::jsonb
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.evidence->'erasures') erased WHERE erased=ref)
   THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
  IF TG_OP='INSERT' THEN
   source:=read_scope_review_source(NEW.workspace_id,ref->>'kind',(ref->>'id')::uuid);
   IF source IS NULL OR source->'compartments' IS DISTINCT FROM 'null'::jsonb
    THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
  END IF;
 END LOOP;
 FOR ref IN SELECT value FROM jsonb_array_elements(NEW.evidence->'erasures') LOOP
  tab:=scope_review_source_table(ref->>'kind');
  IF tab IS NULL OR NOT coalesce(jsonb_typeof(ref)='object' AND ref ?& ARRAY['kind','id','version']
   AND jsonb_typeof(ref->'kind')='string' AND jsonb_typeof(ref->'id')='string'
   AND ref->>'id'~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND jsonb_typeof(ref->'version')='string' AND length(ref->>'version')>0
   AND ref-ARRAY['kind','id','version']='{}'::jsonb,false) THEN
   RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
  IF TG_OP='INSERT' THEN
   source:=read_scope_review_source(NEW.workspace_id,ref->>'kind',(ref->>'id')::uuid);
   consent:=NEW.evidence->'eraseUnclassifiedLegacy'='true'::jsonb
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(NEW.evidence->'unclassified','[]'::jsonb)) unknown_ref WHERE unknown_ref=ref);
   explicit_selection:=EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.selection) selected
    WHERE selected->>'kind'=ref->>'kind' AND selected->>'id'=ref->>'id');
   IF ref->>'kind'='session_message' THEN
    SELECT EXISTS(SELECT 1 FROM session_messages m JOIN sessions s ON s.id=m.session_id
     WHERE m.id=(ref->>'id')::uuid AND s.workspace_id=NEW.workspace_id
      AND coalesce(m.workspace_id,s.workspace_id)=NEW.workspace_id
      AND s.context_group_id IS NULL AND s.context_project_id IS NULL AND s.status<>'running'
      AND (explicit_selection OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.selection) selected
       WHERE selected->>'kind'='session' AND selected->>'id'=s.id::text))) INTO explicit_selection;
   END IF;
   IF source IS NULL OR source->>'version' IS DISTINCT FROM ref->>'version'
    OR NOT coalesce(CASE WHEN jsonb_typeof(source->'compartments')='array'
      THEN jsonb_array_length(source->'compartments')=0
      ELSE source->'compartments'='null'::jsonb AND consent AND explicit_selection END,false)
    THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
  ELSIF NEW.status='applied' THEN
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1)',tab) INTO present USING (ref->>'id')::uuid;
   IF present THEN RAISE EXCEPTION 'legacy_cleanup_reference_invalid';END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_workspace_legacy_cleanup_review() FROM PUBLIC;
COMMIT;
