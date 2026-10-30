-- Explicit removal evidence for retained transcript derivations.
-- [COMP:api/workspace-scope-review]
BEGIN;

CREATE OR REPLACE FUNCTION read_scope_review_impact_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE version_value text; held_value boolean; current_source jsonb; receipts jsonb;
BEGIN
 IF k='session_context_revision' THEN
  SELECT scope_version::text,scope_held INTO version_value,held_value
   FROM public.session_context_scope_revisions WHERE workspace_id=w AND id=i FOR SHARE;
 ELSIF k='knowledge_entry_revision' THEN
  SELECT scope_version::text,scope_held INTO version_value,held_value
   FROM public.knowledge_entry_scope_revisions WHERE workspace_id=w AND id=i FOR SHARE;
 ELSE
  current_source:=public.read_scope_review_source(w,k,i);
  IF current_source IS NOT NULL OR k<>'session_message' THEN RETURN current_source; END IF;
  -- Absence is global: an existing but unreadable/foreign message is never
  -- removal evidence. Canonical publishers serialize on the workspace lock.
  PERFORM id FROM public.session_messages WHERE id=i FOR SHARE;
  IF FOUND THEN RETURN NULL; END IF;
  SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) INTO receipts FROM (
   SELECT * FROM public.scope_derivations WHERE workspace_id=w
    AND resource_kind='session_message' AND resource_id=i ORDER BY id LIMIT 501 FOR SHARE
  ) d;
  IF receipts IS NULL OR jsonb_array_length(receipts)>500 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('version','removed:'||encode(sha256(convert_to(receipts::text,'UTF8')),'hex'),
   'held',true,'removed',true);
 END IF;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('version',version_value,'held',held_value OR EXISTS(
  SELECT 1 FROM public.scope_resource_states s WHERE s.workspace_id=w
   AND s.resource_kind=k AND s.resource_id=i AND s.review_state='held'));
END $$;
REVOKE ALL ON FUNCTION read_scope_review_impact_source(uuid,text,uuid) FROM PUBLIC;

-- Preserve all existing immutable-shape, duplicate, version and hold checks.
CREATE OR REPLACE FUNCTION guard_scope_review_impact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item jsonb; current_source jsonb; item_kind text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.impact_snapshot IS DISTINCT FROM OLD.impact_snapshot THEN
   RAISE EXCEPTION 'scope_review_proposal_immutable';
  END IF;
 ELSIF NEW.impact_snapshot IS NOT NULL THEN
  IF jsonb_array_length(NEW.impact_snapshot->'descendants')>500
   OR (SELECT count(*)<>count(DISTINCT coalesce(value->>'resourceKind','memory')||':'||(value->>'resourceId'))
    FROM jsonb_array_elements(NEW.impact_snapshot->'descendants')) THEN
   RAISE EXCEPTION 'scope_review_reference_invalid';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.impact_snapshot->'descendants') LOOP
   item_kind=coalesce(item->>'resourceKind','memory');
   IF NOT coalesce(jsonb_typeof(item)='object' AND item ?& ARRAY['resourceId','version','held']
    AND jsonb_typeof(item->'held')='boolean' AND jsonb_typeof(item->'version')='string'
    AND (NOT item ? 'removed' OR item->'removed'='true'::jsonb)
    AND item-(CASE WHEN item ? 'resourceKind' THEN ARRAY['resourceKind','resourceId','version','held','removed']
     ELSE ARRAY['resourceId','version','held','removed'] END)='{}'::jsonb,false) THEN
    RAISE EXCEPTION 'scope_review_reference_invalid';
   END IF;
   current_source=public.read_scope_review_impact_source(NEW.workspace_id,item_kind,(item->>'resourceId')::uuid);
   IF current_source IS NULL OR current_source->>'version' IS DISTINCT FROM item->>'version'
    OR (current_source->>'held')::boolean IS DISTINCT FROM (item->>'held')::boolean
    OR coalesce(current_source->'removed','false'::jsonb) IS DISTINCT FROM coalesce(item->'removed','false'::jsonb) THEN
    RAISE EXCEPTION 'scope_review_reference_invalid';
   END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;

COMMIT;
