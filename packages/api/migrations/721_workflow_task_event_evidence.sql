BEGIN;
-- [COMP:api/workflow-input-evidence] Capture before asynchronous task fanout.
CREATE TABLE workflow_task_event_receipts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 task_id uuid PRIMARY KEY,
 sources jsonb NOT NULL,
 write_transaction xid8 NOT NULL DEFAULT pg_current_xact_id()
);
ALTER TABLE workflow_task_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON workflow_task_event_receipts FROM PUBLIC;
CREATE FUNCTION capture_workflow_task_event_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb;
BEGIN
 IF NEW.workspace_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  s:=read_scope_source(NEW.workspace_id,'task',NEW.id);
  INSERT INTO workflow_task_event_receipts(workspace_id,task_id,sources)
   VALUES(NEW.workspace_id,NEW.id,jsonb_build_array(s-'held'-'validTo'-'retractedAt'));
 ELSIF OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL AND OLD.superseded_by IS NULL AND NEW.superseded_by IS NOT NULL THEN
  -- BEFORE UPDATE reads the original version and protections. Only the
  -- transaction inserting the new head may attach previous-value evidence.
  s:=read_scope_source(OLD.workspace_id,'task',OLD.id);
  UPDATE workflow_task_event_receipts SET sources=sources||jsonb_build_array(s-'held'-'validTo'-'retractedAt')
   WHERE workspace_id=OLD.workspace_id AND task_id=NEW.superseded_by AND write_transaction=pg_current_xact_id();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_event_receipt_created AFTER INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION capture_workflow_task_event_receipt();
CREATE TRIGGER task_event_receipt_superseded BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION capture_workflow_task_event_receipt();
ALTER TABLE workflow_runs ADD COLUMN task_event_evidence jsonb;
CREATE FUNCTION bind_workflow_task_event_evidence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.task_event_evidence IS DISTINCT FROM OLD.task_event_evidence
   OR ((OLD.input#>>'{trigger,sourceType}'='task' OR NEW.input#>>'{trigger,sourceType}'='task')
     AND NEW.input IS DISTINCT FROM OLD.input AND NOT (NEW.privacy_erased AND NEW.input='{}'::jsonb))
   THEN RAISE EXCEPTION 'task_event_binding_immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.input#>>'{trigger,sourceType}'='task' THEN
  SELECT jsonb_build_object('sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb,'sources',sources)
   INTO receipt FROM workflow_task_event_receipts
   WHERE workspace_id=NEW.workspace_id AND task_id=(NEW.input#>>'{event,taskId}')::uuid FOR SHARE;
  IF receipt IS NULL THEN RAISE EXCEPTION 'task_event_evidence_missing'; END IF;
  IF NEW.task_event_evidence IS NOT NULL AND NEW.task_event_evidence IS DISTINCT FROM receipt THEN RAISE EXCEPTION 'task_event_binding_conflict'; END IF;
  NEW.task_event_evidence:=receipt;
 ELSIF NEW.task_event_evidence IS NOT NULL THEN RAISE EXCEPTION 'task_event_binding_conflict'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER workflow_task_event_binding BEFORE INSERT OR UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION bind_workflow_task_event_evidence();
ALTER FUNCTION workflow_history_evidence_visible(uuid) RENAME TO workflow_history_evidence_visible_before_tasks;
REVOKE ALL ON FUNCTION workflow_history_evidence_visible_before_tasks(uuid) FROM PUBLIC;
CREATE FUNCTION workflow_history_evidence_visible(target uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r record;
BEGIN
 IF workflow_history_evidence_visible_before_tasks(target) IS NOT TRUE THEN RETURN false; END IF;
 FOR r IN WITH RECURSIVE lineage(id) AS (
  SELECT id FROM workflow_runs WHERE id=target
  UNION SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
 ) SELECT wr.* FROM lineage l JOIN workflow_runs wr ON wr.id=l.id LOOP
  IF (r.input#>>'{trigger,sourceType}'='task' OR r.task_event_evidence IS NOT NULL)
   AND workflow_scope_evidence_visible(r.workspace_id,r.task_event_evidence) IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
-- Policies bind function OIDs, so replace their expressions after wrapping.
ALTER POLICY workflow_runs_accumulated_evidence ON workflow_runs USING(workflow_history_evidence_visible(id));
ALTER POLICY workflow_steps_accumulated_evidence ON workflow_step_runs USING(workflow_history_evidence_visible(run_id));
ALTER POLICY workflow_copies_accumulated_evidence ON workflow_run_copy_sources USING(workflow_history_evidence_visible(run_id) AND workflow_history_evidence_visible(source_run_id));
ALTER FUNCTION read_workflow_derivation_inputs(uuid,uuid) RENAME TO read_workflow_derivation_inputs_before_tasks;
REVOKE ALL ON FUNCTION read_workflow_derivation_inputs_before_tasks(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION read_workflow_derivation_inputs(w uuid,target uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item jsonb; r workflow_runs; e jsonb; sources jsonb; result jsonb:='[]';
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(read_workflow_derivation_inputs_before_tasks(w,target)) LOOP
  SELECT * INTO r FROM workflow_runs WHERE workspace_id=w AND id=(item->>'runId')::uuid;
  IF r.input#>>'{trigger,sourceType}'='task' OR r.task_event_evidence IS NOT NULL THEN
   IF r.task_event_evidence IS NULL THEN RAISE EXCEPTION 'task_event_evidence_missing'; END IF;
   e:=item->'evidence';
   sources:=coalesce(e->'sources','[]'::jsonb)||(r.task_event_evidence->'sources');
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
REVOKE ALL ON FUNCTION capture_workflow_task_event_receipt(),bind_workflow_task_event_evidence() FROM PUBLIC;

-- Owner-only dispatch locks precede admission; no content or grant is returned.
CREATE FUNCTION lock_task_workflow_dispatch_inputs(w uuid,actor uuid,acting uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE captured timestamptz; boundary timestamptz;
BEGIN
 PERFORM id FROM workspaces WHERE id=w FOR UPDATE;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w ORDER BY user_id FOR SHARE;
 -- Parent UPDATE locks also block new FK-bound membership/configuration rows.
 PERFORM id FROM assistants WHERE workspace_id=w ORDER BY id FOR UPDATE;
 PERFORM id FROM workspace_groups WHERE workspace_id=w ORDER BY id FOR UPDATE;
 PERFORM id FROM workspace_projects WHERE workspace_id=w ORDER BY id FOR UPDATE;
 PERFORM id FROM department_edges WHERE workspace_id=w ORDER BY id FOR SHARE;
 PERFORM id FROM workspace_access_grants WHERE workspace_id=w ORDER BY id FOR SHARE;
 PERFORM m.group_id FROM workspace_group_members m JOIN workspace_groups g ON g.id=m.group_id WHERE g.workspace_id=w ORDER BY m.group_id,m.user_id FOR SHARE OF m;
 PERFORM a.group_id FROM workspace_group_assistants a JOIN workspace_groups g ON g.id=a.group_id WHERE g.workspace_id=w ORDER BY a.group_id,a.assistant_id FOR SHARE OF a;
 PERFORM b.group_id FROM workspace_group_compartment_grants b JOIN workspace_groups g ON g.id=b.group_id WHERE g.workspace_id=w ORDER BY b.group_id FOR SHARE OF b;
 PERFORM m.project_id FROM workspace_project_members m JOIN workspace_projects p ON p.id=m.project_id WHERE p.workspace_id=w ORDER BY m.project_id,m.user_id FOR SHARE OF m;
 PERFORM a.project_id FROM assistant_project_grants a JOIN workspace_projects p ON p.id=a.project_id WHERE p.workspace_id=w ORDER BY a.project_id,a.assistant_id FOR SHARE OF a;

 captured:=clock_timestamp();
 SELECT min(expiry) INTO boundary FROM (
  SELECT expires_at AS expiry FROM department_edges WHERE workspace_id=w
   AND (user_id=actor OR assistant_id=acting) AND expires_at>captured
  UNION ALL SELECT g.expires_at FROM workspace_access_grants g WHERE g.workspace_id=w
   AND g.revoked_at IS NULL AND g.starts_at<=captured AND g.expires_at>captured
   AND ((g.beneficiary_kind='member' AND g.beneficiary_id=actor)
    OR (g.beneficiary_kind='team' AND EXISTS(SELECT 1 FROM workspace_group_members m
     JOIN workspace_groups t ON t.id=m.group_id WHERE m.user_id=actor AND m.group_id=g.beneficiary_id
      AND t.workspace_id=w AND t.status='active')))
 ) expirations;
 RETURN boundary;
END $$;
REVOKE ALL ON FUNCTION lock_task_workflow_dispatch_inputs(uuid,uuid,uuid) FROM PUBLIC;
ALTER TABLE workflow_runs ADD COLUMN task_event_valid_until timestamptz;
CREATE FUNCTION enforce_task_workflow_dispatch_boundary() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.task_event_evidence IS NOT NULL AND NEW.task_event_valid_until IS NOT NULL
  AND clock_timestamp()>=NEW.task_event_valid_until THEN
  RAISE EXCEPTION 'workflow_dispatch_expired' USING ERRCODE='42501'; END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION enforce_task_workflow_dispatch_boundary() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER task_workflow_dispatch_boundary AFTER INSERT ON workflow_runs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_task_workflow_dispatch_boundary();
COMMIT;
