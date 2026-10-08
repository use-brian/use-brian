BEGIN;
-- [COMP:api/workflow-input-evidence] Page input retains original and observed protection.
CREATE FUNCTION page_event_input_evidence(w uuid,receipt uuid,page uuid,actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE authority jsonb; sources jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workflow_page_event_receipts WHERE workspace_id=w AND revision=receipt AND page_id=page) THEN RETURN NULL; END IF;
 authority:=read_page_event_authority(w,receipt,actor);
 IF authority IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(authority->'boundaries') b WHERE b->>'principalAllowed' IS DISTINCT FROM 'true') THEN RETURN NULL; END IF;
 SELECT jsonb_agg(s) INTO sources FROM jsonb_array_elements(authority->'boundaries') b
  CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(b->'savedSource',b->'currentSource')) s WHERE s IS DISTINCT FROM 'null'::jsonb;
 IF sources IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('sources',sources,
  'sensitivity',(SELECT s->>'sensitivity' FROM jsonb_array_elements(sources) s ORDER BY sensitivity_rank(s->>'sensitivity') DESC LIMIT 1),
  'compartments',(SELECT coalesce(jsonb_agg(DISTINCT label),'[]') FROM jsonb_array_elements(sources) s CROSS JOIN LATERAL jsonb_array_elements(s->'compartments') label),
  'projectIds',(SELECT coalesce(jsonb_agg(DISTINCT label),'[]') FROM jsonb_array_elements(sources) s CROSS JOIN LATERAL jsonb_array_elements(s->'projectIds') label));
END $$;
REVOKE ALL ON FUNCTION page_event_input_evidence(uuid,uuid,uuid,uuid) FROM PUBLIC;

ALTER FUNCTION workflow_scope_evidence_visible(uuid,jsonb) RENAME TO workflow_scope_evidence_visible_before_page;
REVOKE ALL ON FUNCTION workflow_scope_evidence_visible_before_page(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION workflow_scope_evidence_visible(w uuid,e jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE ordinary jsonb; s jsonb; a jsonb; required jsonb;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF e IS NULL OR jsonb_typeof(e->'sources') NOT IN ('array','null') THEN RETURN false; END IF;
 SELECT coalesce(jsonb_agg(value),'[]') INTO ordinary FROM jsonb_array_elements(coalesce(e->'sources','[]'))
  WHERE coalesce(value->>'resourceKind','') NOT IN ('page_event_changed','page_event_destination','page_live_changed','page_live_destination');
 IF workflow_scope_evidence_visible_before_page(w,jsonb_set(e,'{sources}',ordinary)) IS NOT TRUE THEN RETURN false; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(coalesce(e->'sources','[]'))
  WHERE value->>'resourceKind' IN ('page_event_changed','page_event_destination','page_live_changed','page_live_destination') LOOP
  a:=read_page_scope_authority(w,s->>'resourceKind',(s->>'resourceId')::uuid,actor);
  IF a IS NULL OR a->>'principalAllowed' IS DISTINCT FROM 'true' OR a->'source' IS DISTINCT FROM s
   OR workflow_evidence_envelope_visible(w,s) IS NOT TRUE THEN RETURN false; END IF;
  FOR required IN SELECT value FROM jsonb_array_elements(a->'requiredSources') LOOP
   IF workflow_evidence_envelope_visible(w,required) IS NOT TRUE THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR raise_exception THEN RETURN false;
END $$;

ALTER TABLE workflow_runs ADD COLUMN page_event_evidence jsonb;
CREATE FUNCTION bind_workflow_page_event_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.page_event_evidence IS DISTINCT FROM OLD.page_event_evidence
   OR ((OLD.input#>>'{trigger,sourceType}'='page' OR NEW.input#>>'{trigger,sourceType}'='page')
    AND NEW.input IS DISTINCT FROM OLD.input AND NOT(NEW.privacy_erased AND NEW.input='{}'::jsonb))
   THEN RAISE EXCEPTION 'page_event_binding_immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.input#>>'{trigger,sourceType}'='page' THEN
  receipt:=page_event_input_evidence(NEW.workspace_id,(NEW.input#>>'{event,sourceVersion}')::uuid,(NEW.input#>>'{event,pageId}')::uuid,NEW.triggered_by);
  IF receipt IS NULL THEN RAISE EXCEPTION 'page_event_evidence_missing'; END IF;
  IF NEW.page_event_evidence IS NOT NULL AND NEW.page_event_evidence IS DISTINCT FROM receipt THEN RAISE EXCEPTION 'page_event_binding_conflict'; END IF;
  NEW.page_event_evidence:=receipt;
 ELSIF NEW.page_event_evidence IS NOT NULL THEN RAISE EXCEPTION 'page_event_binding_conflict'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_page_event_binding BEFORE INSERT OR UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION bind_workflow_page_event_evidence();
ALTER FUNCTION workflow_history_evidence_visible(uuid) RENAME TO workflow_history_evidence_visible_before_page;
REVOKE ALL ON FUNCTION workflow_history_evidence_visible_before_page(uuid) FROM PUBLIC;
CREATE FUNCTION workflow_history_evidence_visible(target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;
BEGIN
 IF workflow_history_evidence_visible_before_page(target) IS NOT TRUE THEN RETURN false; END IF;
 FOR r IN WITH RECURSIVE lineage(id) AS (
  SELECT id FROM workflow_runs WHERE id=target
  UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
 ) SELECT wr.* FROM lineage l JOIN workflow_runs wr ON wr.id=l.id LOOP
  IF (r.input#>>'{trigger,sourceType}'='page' OR r.page_event_evidence IS NOT NULL)
   AND (NOT r.primitive_event_metadata_verified OR workflow_scope_evidence_visible(r.workspace_id,r.page_event_evidence) IS NOT TRUE) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
-- Policies bind function OIDs, so replace their expressions after wrapping.
ALTER POLICY workflow_runs_accumulated_evidence ON workflow_runs USING(workflow_history_evidence_visible(id));
ALTER POLICY workflow_steps_accumulated_evidence ON workflow_step_runs USING(workflow_history_evidence_visible(run_id));
ALTER POLICY workflow_copies_accumulated_evidence ON workflow_run_copy_sources USING(workflow_history_evidence_visible(run_id) AND workflow_history_evidence_visible(source_run_id));
ALTER FUNCTION read_workflow_derivation_inputs(uuid,uuid) RENAME TO read_workflow_derivation_inputs_before_page;
REVOKE ALL ON FUNCTION read_workflow_derivation_inputs_before_page(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION read_workflow_derivation_inputs(w uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; r workflow_runs; e jsonb; sources jsonb; result jsonb:='[]';
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(read_workflow_derivation_inputs_before_page(w,target)) LOOP
  SELECT * INTO r FROM workflow_runs WHERE workspace_id=w AND id=(item->>'runId')::uuid;
  IF r.input#>>'{trigger,sourceType}'='page' OR r.page_event_evidence IS NOT NULL THEN
   IF r.page_event_evidence IS NULL OR NOT r.primitive_event_metadata_verified THEN RAISE EXCEPTION 'page_event_evidence_missing'; END IF;
   e:=item->'evidence';
   sources:=coalesce(e->'sources','[]'::jsonb)||(r.page_event_evidence->'sources');
   e:=e||jsonb_build_object('sources',sources,
    'sensitivity',(SELECT value FROM (SELECT e->>'sensitivity' AS value UNION SELECT s->>'sensitivity' FROM jsonb_array_elements(sources) s) levels ORDER BY sensitivity_rank(value) DESC LIMIT 1),
    'compartments',(SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM (SELECT DISTINCT value FROM jsonb_array_elements(coalesce(e->'compartments','[]')||(SELECT coalesce(jsonb_agg(label),'[]') FROM jsonb_array_elements(sources) s CROSS JOIN LATERAL jsonb_array_elements(s->'compartments') label))) labels),
    'projectIds',(SELECT coalesce(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM (SELECT DISTINCT value FROM jsonb_array_elements(coalesce(e->'projectIds','[]')||(SELECT coalesce(jsonb_agg(label),'[]') FROM jsonb_array_elements(sources) s CROSS JOIN LATERAL jsonb_array_elements(s->'projectIds') label))) labels));
   item:=jsonb_set(item,'{evidence}',e);
  END IF;
  result:=result||jsonb_build_array(item);
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION read_workflow_derivation_inputs(uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION enforce_task_workflow_dispatch_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF (NEW.task_event_evidence IS NOT NULL OR NEW.knowledge_event_evidence IS NOT NULL OR NEW.page_event_evidence IS NOT NULL) AND NEW.task_event_valid_until IS NOT NULL
  AND clock_timestamp()>=NEW.task_event_valid_until THEN
  RAISE EXCEPTION 'workflow_dispatch_expired' USING ERRCODE='42501'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION bind_workflow_page_event_evidence() FROM PUBLIC;
COMMIT;
