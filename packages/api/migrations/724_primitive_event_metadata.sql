BEGIN;
-- [COMP:api/workflow-input-evidence] Content-bearing event fields bind to the write.
ALTER TABLE workflow_task_event_receipts ADD COLUMN metadata jsonb;
ALTER TABLE workflow_knowledge_event_receipts ADD COLUMN metadata jsonb;
CREATE FUNCTION workflow_task_event_metadata(r tasks) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('taskId',r.id,'title',r.title,'status',r.status,'tags',r.tags,
  'assigneeId',r.assignee_id,'due',r.due,'parentId',r.parent_id,'actorId',r.created_by_user_id,
  'externalRefDigest',encode(sha256(convert_to(coalesce(r.external_ref,'{}')::text,'UTF8')),'hex'),
  'attributesDigest',encode(sha256(convert_to(coalesce(r.attributes,'{}')::text,'UTF8')),'hex'))
$$;
CREATE OR REPLACE FUNCTION capture_workflow_task_event_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb;
BEGIN
 IF NEW.workspace_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  s:=read_scope_source(NEW.workspace_id,'task',NEW.id);
  INSERT INTO workflow_task_event_receipts(workspace_id,task_id,sources,metadata)
   VALUES(NEW.workspace_id,NEW.id,jsonb_build_array(s-'held'-'validTo'-'retractedAt'),
    jsonb_build_object('current',workflow_task_event_metadata(NEW),'previous',NULL));
 ELSIF OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL AND OLD.superseded_by IS NULL AND NEW.superseded_by IS NOT NULL THEN
  s:=read_scope_source(OLD.workspace_id,'task',OLD.id);
  UPDATE workflow_task_event_receipts SET sources=sources||jsonb_build_array(s-'held'-'validTo'-'retractedAt'),
   metadata=jsonb_set(metadata,'{previous}',workflow_task_event_metadata(OLD))
   WHERE workspace_id=OLD.workspace_id AND task_id=NEW.superseded_by AND write_transaction=pg_current_xact_id();
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION capture_workflow_knowledge_event_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb; r knowledge_entries; action text; actor uuid; metadata jsonb;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD; action:='deleted';
 ELSE r:=NEW; action:=CASE WHEN TG_OP='INSERT' THEN 'created' ELSE 'updated' END;
  actor:=coalesce(nullif(current_setting('app.knowledge_event_actor',true),'')::uuid,r.created_by); END IF;
 s:=read_scope_source(r.workspace_id,'knowledge_entry',r.id);
 metadata:=jsonb_build_object('entryId',r.id,'sourceVersion',r.scope_version::text,'path',r.path,
  'title',r.title,'tags',r.tags,'sensitivity',r.sensitivity,'sourceId',r.source_id,
  'observations',jsonb_build_array(jsonb_build_object('action',action,'actorId',actor)));
 INSERT INTO workflow_knowledge_event_receipts(workspace_id,entry_id,source_version,source,held,metadata)
 VALUES(r.workspace_id,r.id,r.scope_version::text,s-'held'-'validTo'-'retractedAt',coalesce((s->>'held')::boolean,true),metadata)
 ON CONFLICT(entry_id,source_version) DO UPDATE SET metadata=jsonb_set(
  coalesce(workflow_knowledge_event_receipts.metadata,EXCLUDED.metadata),'{observations}',
  coalesce(workflow_knowledge_event_receipts.metadata->'observations','[]'::jsonb)||EXCLUDED.metadata->'observations');
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION workflow_task_event_metadata(tasks) FROM PUBLIC;
-- This stamp is supplied only by the admitted host insert, never from input JSON.
ALTER TABLE workflow_runs ADD COLUMN primitive_event_metadata_verified boolean NOT NULL DEFAULT false;
CREATE FUNCTION keep_primitive_event_metadata_verification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.primitive_event_metadata_verified IS DISTINCT FROM OLD.primitive_event_metadata_verified THEN
  RAISE EXCEPTION 'primitive_event_metadata_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER primitive_event_metadata_verification BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION keep_primitive_event_metadata_verification();
REVOKE ALL ON FUNCTION keep_primitive_event_metadata_verification() FROM PUBLIC;
ALTER FUNCTION workflow_history_evidence_visible(uuid) RENAME TO workflow_history_evidence_visible_before_metadata;
REVOKE ALL ON FUNCTION workflow_history_evidence_visible_before_metadata(uuid) FROM PUBLIC;
CREATE FUNCTION workflow_history_evidence_visible(target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(WITH RECURSIVE lineage(id) AS (
  SELECT id FROM workflow_runs WHERE id=target
  UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
 ) SELECT 1 FROM lineage l JOIN workflow_runs r ON r.id=l.id WHERE
  (r.input#>>'{trigger,sourceType}' IN('task','knowledge') OR r.task_event_evidence IS NOT NULL OR r.knowledge_event_evidence IS NOT NULL)
  AND NOT r.primitive_event_metadata_verified) THEN RETURN false; END IF;
 RETURN workflow_history_evidence_visible_before_metadata(target);
END $$;
ALTER POLICY workflow_runs_accumulated_evidence ON workflow_runs USING(workflow_history_evidence_visible(id));
ALTER POLICY workflow_steps_accumulated_evidence ON workflow_step_runs USING(workflow_history_evidence_visible(run_id));
ALTER POLICY workflow_copies_accumulated_evidence ON workflow_run_copy_sources USING(workflow_history_evidence_visible(run_id) AND workflow_history_evidence_visible(source_run_id));
ALTER FUNCTION read_workflow_derivation_inputs(uuid,uuid) RENAME TO read_workflow_derivation_inputs_before_metadata;
REVOKE ALL ON FUNCTION read_workflow_derivation_inputs_before_metadata(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION read_workflow_derivation_inputs(w uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
 result:=read_workflow_derivation_inputs_before_metadata(w,target);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(result) x JOIN workflow_runs r ON r.id=(x->>'runId')::uuid
  WHERE (r.input#>>'{trigger,sourceType}' IN('task','knowledge') OR r.task_event_evidence IS NOT NULL OR r.knowledge_event_evidence IS NOT NULL)
  AND NOT r.primitive_event_metadata_verified) THEN RAISE EXCEPTION 'primitive_event_metadata_missing'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION read_workflow_derivation_inputs(uuid,uuid) FROM PUBLIC;
COMMIT;
