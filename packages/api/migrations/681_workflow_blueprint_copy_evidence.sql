BEGIN;
-- [COMP:api/workflow-input-evidence]
-- Spec: docs/architecture/features/workflow.md, Durable blueprint copy evidence.
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK(source_kind IN
 ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification','correction_audit','session_message','feedback_event','workspace_skill_revision','knowledge_source','recording','file_segment','transcript_segment','blueprint_record'));
CREATE OR REPLACE FUNCTION read_scope_source(p_workspace uuid,p_kind text,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s workspace_knowledge_sources;
BEGIN
 IF p_kind='blueprint_record' THEN RETURN read_scope_review_source(p_workspace,p_kind,p_id); END IF;
 IF p_kind<>'knowledge_source' THEN RETURN read_scope_source_before_knowledge_binding(p_workspace,p_kind,p_id); END IF;
 SELECT * INTO s FROM workspace_knowledge_sources WHERE workspace_id=p_workspace AND id=p_id FOR SHARE;
 IF s.configured_by_user_id IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('workspaceId',p_workspace,'resourceKind',p_kind,'resourceId',p_id,'version',s.binding_version::text,
  'userId',NULL,'assistantId',NULL,'sensitivity',s.binding_sensitivity,'compartments',s.binding_compartments,
  'projectIds',s.binding_project_ids,'held',s.binding_held,'validTo',NULL,'retractedAt',NULL);
END $$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;


CREATE OR REPLACE FUNCTION scope_source_table(k text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE k WHEN 'blueprint_record' THEN 'blueprint_records'
 WHEN 'recording' THEN 'recordings' WHEN 'file_segment' THEN 'file_segments'
 WHEN 'transcript_segment' THEN 'transcript_segments' ELSE scope_source_table_before_media(k) END
$$;
REVOKE ALL ON FUNCTION scope_source_table(text) FROM PUBLIC;

-- SQL null is unknown historical provenance; JSON null proves no enrichment.
ALTER TABLE workflow_run_copy_sources ADD COLUMN blueprint_source jsonb;
CREATE FUNCTION capture_workflow_blueprint_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE record_id uuid; actor uuid;
BEGIN
 SELECT id INTO record_id FROM blueprint_records WHERE workspace_id=NEW.workspace_id
 AND source_kind IN('workflow','research') AND source_id=NEW.source_run_id::text
 ORDER BY updated_at DESC,id DESC LIMIT 1 FOR SHARE;
 NEW.blueprint_source:=CASE WHEN record_id IS NULL THEN 'null'::jsonb
 ELSE read_scope_source(NEW.workspace_id,'blueprint_record',record_id) END;
 SELECT coalesce(r.triggered_by,w.created_by) INTO actor FROM workflow_runs r
 JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
 WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id;
 IF record_id IS NOT NULL AND crm_scope_snapshot_allows(NEW.blueprint_source,NEW.workspace_id,actor,NULL,NULL) IS NOT TRUE
 THEN RAISE EXCEPTION 'workflow_source_scope_unavailable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION capture_workflow_blueprint_source() FROM PUBLIC;
CREATE TRIGGER workflow_enrichment_copy_evidence BEFORE INSERT ON workflow_run_copy_sources
 FOR EACH ROW EXECUTE FUNCTION capture_workflow_blueprint_source();

CREATE FUNCTION invalidate_blueprint_scope_descendants() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
   PERFORM hold_scope_descendants(OLD.workspace_id,'blueprint_record',OLD.id);
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION invalidate_blueprint_scope_descendants() FROM PUBLIC;
CREATE TRIGGER blueprint_scope_descendants BEFORE UPDATE OR DELETE ON blueprint_records
 FOR EACH ROW EXECUTE FUNCTION invalidate_blueprint_scope_descendants();
CREATE OR REPLACE FUNCTION workflow_run_department_allows(target uuid,actor uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH RECURSIVE lineage(id) AS (
    SELECT id FROM workflow_runs WHERE id=target
    UNION
    SELECT s.source_run_id FROM workflow_run_copy_sources s JOIN lineage l ON l.id=s.run_id
  ) SELECT EXISTS(SELECT 1 FROM workflow_runs r JOIN workspace_members m ON m.workspace_id=r.workspace_id
      WHERE r.id=target AND m.user_id=actor)
    AND NOT EXISTS(
      SELECT 1 FROM lineage l JOIN workflow_runs r ON r.id=l.id JOIN workspaces ws ON ws.id=r.workspace_id
        LEFT JOIN workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id
        LEFT JOIN workspace_groups g ON g.id=w.context_group_id AND g.workspace_id=w.workspace_id AND g.kind='team'
      WHERE ws.department_read_v2 AND (
        w.id IS NULL OR (r.context_group_id IS NOT NULL AND NOT ('team:'||r.context_group_id::text)=ANY(r.context_compartments))
        OR (w.context_group_id IS NOT NULL AND g.compartment_key IS NULL)
        OR NOT coalesce(department_row_allows(department_read_grants_for(actor),r.workspace_id,'public',r.context_compartments,NULL),false)
        OR NOT coalesce(department_row_allows(department_read_grants_for(actor),r.workspace_id,'public',
          CASE WHEN w.context_group_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[g.compartment_key] END,NULL),false)
      ))
    AND NOT EXISTS(
      SELECT 1 FROM lineage l JOIN workflow_run_copy_sources c ON c.run_id=l.id
      JOIN workspaces ws ON ws.id=c.workspace_id
      WHERE ws.department_read_v2 AND (c.blueprint_source IS NULL OR (
        c.blueprint_source<>'null'::jsonb AND (
          read_scope_review_source(c.workspace_id,'blueprint_record',(c.blueprint_source->>'resourceId')::uuid)
            IS DISTINCT FROM c.blueprint_source
          OR crm_scope_snapshot_allows(c.blueprint_source,c.workspace_id,actor,NULL,NULL) IS NOT TRUE
        ))))
$$;

COMMIT;
