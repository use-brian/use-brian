BEGIN;
-- [COMP:api/workflow-input-evidence] Enrichment is a real upstream file dependency.
CREATE FUNCTION blueprint_record_readable(i uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM blueprint_records r WHERE r.id=i
  AND NOT scope_review_state_held('blueprint_record',r.id)
  AND workflow_evidence_envelope_visible(r.workspace_id,jsonb_build_object('workspaceId',r.workspace_id,
   'userId',NULL,'assistantId',NULL,'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids)))
$$;
DROP POLICY blueprint_records_context_member ON blueprint_records;
CREATE POLICY blueprint_records_context_read ON blueprint_records FOR SELECT USING(blueprint_record_readable(id));
CREATE POLICY blueprint_records_context_insert ON blueprint_records FOR INSERT WITH CHECK(context_scope_allows_current_principal(workspace_id,sensitivity,compartments,project_ids));
CREATE POLICY blueprint_records_context_update ON blueprint_records FOR UPDATE USING(context_scope_allows_current_principal(workspace_id,sensitivity,compartments,project_ids))
 WITH CHECK(context_scope_allows_current_principal(workspace_id,sensitivity,compartments,project_ids));
CREATE POLICY blueprint_records_context_delete ON blueprint_records FOR DELETE USING(context_scope_allows_current_principal(workspace_id,sensitivity,compartments,project_ids));

ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_blueprint;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_blueprint(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; snapshot jsonb;
BEGIN
 IF k<>'blueprint_record' THEN RETURN read_entity_derivation_source_before_blueprint(w,k,i); END IF;
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
 snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false'
  OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN snapshot;
END $$;

ALTER FUNCTION read_media_parent_snapshot(uuid,text,uuid) RENAME TO read_media_parent_snapshot_before_blueprint;
REVOKE ALL ON FUNCTION read_media_parent_snapshot_before_blueprint(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_media_parent_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k='blueprint_record' THEN RETURN read_entity_derivation_source(w,k,i); END IF;
 RETURN read_media_parent_snapshot_before_blueprint(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_media_parent_snapshot(uuid,text,uuid) FROM PUBLIC;
COMMIT;
