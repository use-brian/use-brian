BEGIN;
-- [COMP:api/workflow-input-evidence] Versioned knowledge metadata survives deletion.
CREATE TABLE workflow_knowledge_event_receipts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 entry_id uuid NOT NULL,
 source_version text NOT NULL,
 source jsonb NOT NULL,
 held boolean NOT NULL,
 PRIMARY KEY(entry_id,source_version)
);
ALTER TABLE workflow_knowledge_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workflow_knowledge_event_receipts FROM PUBLIC;
CREATE FUNCTION capture_workflow_knowledge_event_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb;
BEGIN
 IF TG_OP='DELETE' THEN s:=read_scope_source(OLD.workspace_id,'knowledge_entry',OLD.id);
 ELSE s:=read_scope_source(NEW.workspace_id,'knowledge_entry',NEW.id); END IF;
 INSERT INTO workflow_knowledge_event_receipts(workspace_id,entry_id,source_version,source,held)
 VALUES((s->>'workspaceId')::uuid,(s->>'resourceId')::uuid,s->>'version',s-'held'-'validTo'-'retractedAt',coalesce((s->>'held')::boolean,true))
 ON CONFLICT(entry_id,source_version) DO NOTHING;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER knowledge_event_receipt_written AFTER INSERT OR UPDATE ON knowledge_entries FOR EACH ROW EXECUTE FUNCTION capture_workflow_knowledge_event_receipt();
CREATE TRIGGER knowledge_event_receipt_deleted BEFORE DELETE ON knowledge_entries FOR EACH ROW EXECUTE FUNCTION capture_workflow_knowledge_event_receipt();
ALTER TABLE workflow_runs ADD COLUMN knowledge_event_evidence jsonb;
CREATE FUNCTION bind_workflow_knowledge_event_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.knowledge_event_evidence IS DISTINCT FROM OLD.knowledge_event_evidence
   OR ((OLD.input#>>'{trigger,sourceType}'='knowledge' OR NEW.input#>>'{trigger,sourceType}'='knowledge')
    AND NEW.input IS DISTINCT FROM OLD.input AND NOT(NEW.privacy_erased AND NEW.input='{}'::jsonb))
   THEN RAISE EXCEPTION 'knowledge_event_binding_immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.input#>>'{trigger,sourceType}'='knowledge' THEN
  SELECT jsonb_build_object('sensitivity',source->>'sensitivity','compartments',source->'compartments','projectIds',source->'projectIds','sources',jsonb_build_array(source))
   INTO receipt FROM workflow_knowledge_event_receipts WHERE workspace_id=NEW.workspace_id
    AND entry_id=(NEW.input#>>'{event,entryId}')::uuid AND source_version=NEW.input#>>'{event,sourceVersion}' AND NOT held FOR SHARE;
  IF receipt IS NULL THEN RAISE EXCEPTION 'knowledge_event_evidence_missing'; END IF;
  IF NEW.knowledge_event_evidence IS NOT NULL AND NEW.knowledge_event_evidence IS DISTINCT FROM receipt THEN RAISE EXCEPTION 'knowledge_event_binding_conflict'; END IF;
  NEW.knowledge_event_evidence:=receipt;
 ELSIF NEW.knowledge_event_evidence IS NOT NULL THEN RAISE EXCEPTION 'knowledge_event_binding_conflict'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_knowledge_event_binding BEFORE INSERT OR UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION bind_workflow_knowledge_event_evidence();
ALTER FUNCTION workflow_history_evidence_visible(uuid) RENAME TO workflow_history_evidence_visible_before_knowledge;
REVOKE ALL ON FUNCTION workflow_history_evidence_visible_before_knowledge(uuid) FROM PUBLIC;
CREATE FUNCTION workflow_history_evidence_visible(target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;
BEGIN
 IF workflow_history_evidence_visible_before_knowledge(target) IS NOT TRUE THEN RETURN false; END IF;
 FOR r IN WITH RECURSIVE lineage(id) AS (
  SELECT id FROM workflow_runs WHERE id=target
  UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
 ) SELECT wr.* FROM lineage l JOIN workflow_runs wr ON wr.id=l.id LOOP
  IF (r.input#>>'{trigger,sourceType}'='knowledge' OR r.knowledge_event_evidence IS NOT NULL)
   AND workflow_scope_evidence_visible(r.workspace_id,r.knowledge_event_evidence) IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
-- Policies bind function OIDs, so replace their expressions after wrapping.
ALTER POLICY workflow_runs_accumulated_evidence ON workflow_runs USING(workflow_history_evidence_visible(id));
ALTER POLICY workflow_steps_accumulated_evidence ON workflow_step_runs USING(workflow_history_evidence_visible(run_id));
ALTER POLICY workflow_copies_accumulated_evidence ON workflow_run_copy_sources USING(workflow_history_evidence_visible(run_id) AND workflow_history_evidence_visible(source_run_id));
ALTER FUNCTION read_workflow_derivation_inputs(uuid,uuid) RENAME TO read_workflow_derivation_inputs_before_knowledge;
REVOKE ALL ON FUNCTION read_workflow_derivation_inputs_before_knowledge(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION read_workflow_derivation_inputs(w uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; r workflow_runs; e jsonb; sources jsonb; result jsonb:='[]';
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(read_workflow_derivation_inputs_before_knowledge(w,target)) LOOP
  SELECT * INTO r FROM workflow_runs WHERE workspace_id=w AND id=(item->>'runId')::uuid;
  IF r.input#>>'{trigger,sourceType}'='knowledge' OR r.knowledge_event_evidence IS NOT NULL THEN
   IF r.knowledge_event_evidence IS NULL THEN RAISE EXCEPTION 'knowledge_event_evidence_missing'; END IF;
   e:=item->'evidence';
   sources:=coalesce(e->'sources','[]'::jsonb)||(r.knowledge_event_evidence->'sources');
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
 IF (NEW.task_event_evidence IS NOT NULL OR NEW.knowledge_event_evidence IS NOT NULL) AND NEW.task_event_valid_until IS NOT NULL
  AND clock_timestamp()>=NEW.task_event_valid_until THEN
  RAISE EXCEPTION 'workflow_dispatch_expired' USING ERRCODE='42501'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION capture_workflow_knowledge_event_receipt(),bind_workflow_knowledge_event_evidence() FROM PUBLIC;
COMMIT;
