BEGIN;
-- [COMP:api/workflow-input-evidence] Closed metadata adapter; general source
-- registration must additionally preserve principal restrictions on outputs.
CREATE FUNCTION read_page_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 authority jsonb; s jsonb;
BEGIN
 IF k NOT IN ('page_event_changed','page_event_destination','page_live_changed','page_live_destination')
  OR actor IS NULL
  OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w)
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
 authority:=read_page_scope_authority(w,k,i,actor);
 IF authority IS NULL OR authority->>'principalAllowed' IS DISTINCT FROM 'true'
  OR authority->'source' IS NULL OR workflow_evidence_envelope_visible(w,authority->'source') IS NOT TRUE THEN RETURN NULL; END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(authority->'requiredSources') LOOP
  IF workflow_evidence_envelope_visible(w,s) IS NOT TRUE THEN RETURN NULL; END IF;
 END LOOP;
 RETURN (authority->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL,
  'requiredSources',authority->'requiredSources');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR raise_exception THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION read_page_derivation_source(uuid,text,uuid) FROM PUBLIC;
COMMIT;
