BEGIN;
-- [COMP:api/workflow-input-evidence] Complete dependency receipts before publication.
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK(source_kind IN
 ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification','correction_audit','session_message','feedback_event','workspace_skill_revision','knowledge_source','recording','file_segment','transcript_segment','blueprint_record','browser_profile','browser_session','workflow_run'));

CREATE FUNCTION workflow_derivation_snapshot(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE inputs jsonb; item jsonb; envelopes jsonb:='[]'; deps jsonb:='[]'; s jsonb;
 owner_id uuid; assistant_id uuid; teams text[]:='{}'; projects uuid[]:='{}'; tier text:='public';
BEGIN
 inputs:=read_workflow_derivation_inputs(w,i);
 FOR item IN SELECT value FROM jsonb_array_elements(inputs) LOOP
  envelopes:=envelopes||jsonb_build_array(item->'evidence',
   (item->'savedContext')||'{"sensitivity":"public"}'::jsonb,
   (item->'currentContext')||'{"sensitivity":"public"}'::jsonb);
  deps:=deps||coalesce(item#>'{evidence,sources}','[]'::jsonb);
  IF item->'blueprintSource' IS DISTINCT FROM 'null'::jsonb THEN deps:=deps||jsonb_build_array(item->'blueprintSource'); END IF;
 END LOOP;
 envelopes:=envelopes||deps;
 FOR s IN SELECT value FROM jsonb_array_elements(envelopes) LOOP
  s:=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL)||s;
  IF entity_derivation_envelope_valid(s) IS NOT TRUE OR s->>'workspaceId' IS DISTINCT FROM w::text THEN
   RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  IF s->>'userId' IS NOT NULL THEN
   IF owner_id IS NOT NULL AND owner_id IS DISTINCT FROM (s->>'userId')::uuid THEN RAISE EXCEPTION 'scope_visibility_incompatible'; END IF;
   owner_id:=(s->>'userId')::uuid;
  END IF;
  IF s->>'assistantId' IS NOT NULL THEN
   IF assistant_id IS NOT NULL AND assistant_id IS DISTINCT FROM (s->>'assistantId')::uuid THEN RAISE EXCEPTION 'scope_visibility_incompatible'; END IF;
   assistant_id:=(s->>'assistantId')::uuid;
  END IF;
  IF sensitivity_rank(s->>'sensitivity')>sensitivity_rank(tier) THEN tier:=s->>'sensitivity'; END IF;
  teams:=teams||ARRAY(SELECT jsonb_array_elements_text(s->'compartments'));
  projects:=projects||ARRAY(SELECT jsonb_array_elements_text(s->'projectIds')::uuid);
 END LOOP;
 teams:=ARRAY(SELECT DISTINCT x FROM unnest(teams) x ORDER BY x);
 projects:=ARRAY(SELECT DISTINCT x FROM unnest(projects) x ORDER BY x);
 RETURN jsonb_build_object('workspaceId',w,'resourceKind','workflow_run','resourceId',i,'version',encode(sha256(convert_to(inputs::text,'UTF8')),'hex'),
  'userId',owner_id,'assistantId',assistant_id,'sensitivity',tier,'compartments',teams,'projectIds',projects,
  'held',false,'validTo',NULL,'retractedAt',NULL,'requiredSources',deps);
END $$;
REVOKE ALL ON FUNCTION workflow_derivation_snapshot(uuid,uuid) FROM PUBLIC;

ALTER FUNCTION read_scope_source(uuid,text,uuid) RENAME TO read_scope_source_before_workflow_run;
REVOKE ALL ON FUNCTION read_scope_source_before_workflow_run(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_scope_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k='workflow_run' THEN RETURN workflow_derivation_snapshot(w,i); END IF;
 RETURN read_scope_source_before_workflow_run(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

ALTER FUNCTION scope_source_ancestors(uuid,text,uuid) RENAME TO scope_source_ancestors_before_workflow_run;
REVOKE ALL ON FUNCTION scope_source_ancestors_before_workflow_run(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION scope_source_ancestors(w uuid,k text,i uuid) RETURNS TABLE(resource_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k='workflow_run' THEN
  RETURN QUERY WITH RECURSIVE consumers(id) AS (
   SELECT i UNION SELECT s.run_id FROM workflow_run_copy_sources s JOIN consumers c ON c.id=s.source_run_id WHERE s.workspace_id=w
  ) SELECT id FROM consumers;
 ELSE RETURN QUERY SELECT * FROM scope_source_ancestors_before_workflow_run(w,k,i); END IF;
END $$;
REVOKE ALL ON FUNCTION scope_source_ancestors(uuid,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION invalidate_workflow_derivation_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.derivation_source_version IS DISTINCT FROM OLD.derivation_source_version THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
   AND EXISTS(SELECT 1 FROM scope_derivation_sources s WHERE s.workspace_id=OLD.workspace_id
    AND s.source_kind='workflow_run' AND s.source_id IN(SELECT resource_id FROM scope_source_ancestors(OLD.workspace_id,'workflow_run',OLD.id))) THEN
   PERFORM hold_scope_descendants(OLD.workspace_id,'workflow_run',OLD.id);
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION invalidate_workflow_derivation_source() FROM PUBLIC;

ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_workflow_run;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_workflow_run(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; snapshot jsonb;
BEGIN
 IF k NOT IN('workflow_run','crm_event') THEN RETURN read_entity_derivation_source_before_workflow_run(w,k,i); END IF;
 IF actor IS NULL OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w)
  OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor) THEN RETURN NULL; END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM id FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND OR assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
 END IF;
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 IF k='crm_event' THEN
  snapshot:=read_scope_source(w,k,i);
  IF snapshot IS NULL OR crm_event_scope_allows(i,actor) IS NOT TRUE
   OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE
   OR read_entity_derivation_source(w,'entity',(snapshot->>'causalEntityId')::uuid) IS NULL THEN RETURN NULL; END IF;
  RETURN snapshot;
 END IF;
 snapshot:=workflow_derivation_snapshot(w,i);
 IF workflow_history_evidence_visible(i) IS NOT TRUE OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN snapshot;
EXCEPTION WHEN raise_exception OR invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;

CREATE FUNCTION validate_workflow_derivation_dependencies() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s jsonb; parent jsonb;
BEGIN
 IF NEW.source_kind<>'workflow_run' THEN RETURN NULL; END IF;
 s:=read_scope_source(NEW.workspace_id,NEW.source_kind,NEW.source_id);
 IF s->>'version' IS DISTINCT FROM NEW.source_version THEN RAISE EXCEPTION 'scope_source_changed'; END IF;
 FOR parent IN SELECT value FROM jsonb_array_elements(s->'requiredSources') LOOP
  IF NOT EXISTS(SELECT 1 FROM scope_derivation_sources p WHERE p.workspace_id=NEW.workspace_id AND p.derivation_id=NEW.derivation_id
   AND p.source_kind=parent->>'resourceKind' AND p.source_id=(parent->>'resourceId')::uuid AND p.source_version=parent->>'version')
   THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION validate_workflow_derivation_dependencies() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER workflow_derivation_dependencies AFTER INSERT OR UPDATE ON scope_derivation_sources
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_workflow_derivation_dependencies();

-- A surviving derivation cannot shed its workflow or primitive dependency.
-- Cascading deletion of the entire derivation remains ordinary cleanup.
CREATE FUNCTION guard_workflow_derivation_receipts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
  AND EXISTS(SELECT 1 FROM scope_derivations d WHERE d.id=OLD.derivation_id AND d.workspace_id=OLD.workspace_id)
  AND EXISTS(SELECT 1 FROM scope_derivation_sources s WHERE s.derivation_id=OLD.derivation_id
   AND s.workspace_id=OLD.workspace_id AND s.source_kind='workflow_run')
  THEN RAISE EXCEPTION 'workflow_derivation_receipt_immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_workflow_derivation_receipts() FROM PUBLIC;
CREATE TRIGGER workflow_derivation_receipts BEFORE UPDATE OR DELETE ON scope_derivation_sources
 FOR EACH ROW EXECUTE FUNCTION guard_workflow_derivation_receipts();

ALTER FUNCTION read_media_parent_snapshot(uuid,text,uuid) RENAME TO read_media_parent_snapshot_before_workflow_run;
REVOKE ALL ON FUNCTION read_media_parent_snapshot_before_workflow_run(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_media_parent_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k IN('workflow_run','crm_event') THEN RETURN read_entity_derivation_source(w,k,i); END IF;
 RETURN read_media_parent_snapshot_before_workflow_run(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_media_parent_snapshot(uuid,text,uuid) FROM PUBLIC;
CREATE OR REPLACE FUNCTION renew_browser_file_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE input record; snapshot jsonb;
BEGIN
 FOR input IN SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
  WHERE d.workspace_id=NEW.workspace_id AND d.resource_kind='workspace_file' AND d.resource_id=NEW.id
   AND s.source_kind IN('browser_profile','browser_session','workflow_run')
 LOOP
  snapshot:=read_entity_derivation_source(NEW.workspace_id,input.source_kind,input.source_id);
  IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false'
   OR snapshot->>'version' IS DISTINCT FROM input.source_version THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION renew_browser_file_source() FROM PUBLIC;
COMMIT;
