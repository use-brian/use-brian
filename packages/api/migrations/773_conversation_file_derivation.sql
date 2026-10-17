BEGIN;

-- [COMP:api/conversation-file-derivation] Chat inputs are canonical file evidence.
-- Splice below 730's page enrichment, leaving its dependency expansion and
-- 761's engineering-archive exclusion on the public facade intact.
ALTER FUNCTION read_entity_derivation_source_before_page(uuid,text,uuid)
  RENAME TO read_entity_derivation_source_before_conversation;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_conversation(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION read_entity_derivation_source_before_page(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 snapshot jsonb; parent sessions; member_role text; projects uuid[]; v2 boolean; forbidden_ancestry boolean;
BEGIN
 IF k<>'session_message' THEN RETURN read_entity_derivation_source_before_conversation(w,k,i); END IF;
 IF actor IS NULL
  OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w)
  OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor) THEN RETURN NULL; END IF;
 SELECT department_read_v2 INTO v2 FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT role INTO member_role FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM id FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND OR assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
 END IF;
 -- Lock the parent before the exact message snapshot. Its audience and bound
 -- context remain authority. A historical message missing that floor cannot
 -- certify a new file without canonical reclassification of the source.
 SELECT s.* INTO parent FROM sessions s
  JOIN session_messages m ON m.session_id=s.id
  JOIN assistants a ON a.id=s.assistant_id AND a.workspace_id=w
  WHERE m.id=i AND m.workspace_id=w AND (s.workspace_id IS NULL OR s.workspace_id=w)
  FOR SHARE OF s;
 IF NOT FOUND OR (parent.visibility='personal' AND parent.user_id IS DISTINCT FROM actor)
  OR (parent.visibility='workspace' AND parent.workspace_id IS DISTINCT FROM w) THEN RETURN NULL; END IF;
 IF parent.context_group_id IS NOT NULL THEN
  PERFORM id FROM workspace_groups WHERE id=parent.context_group_id AND workspace_id=w AND kind='team' AND status='active' FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 IF workflow_evidence_envelope_visible(w,jsonb_build_object(
   'workspaceId',w,'userId',CASE WHEN parent.visibility='personal' THEN parent.user_id ELSE NULL END,
   'assistantId',NULL,'sensitivity',coalesce(parent.effective_clearance,'public'),
   'compartments',to_jsonb(coalesce(parent.context_compartments,'{}'::text[])),
   'projectIds',CASE WHEN parent.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(parent.context_project_id) END)) IS NOT TRUE THEN RETURN NULL; END IF;
 snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false'
  OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
  OR scope_review_state_held(k,i)
  OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE THEN RETURN NULL; END IF;
 -- Keep exact source snapshots: reject an incomplete parent floor rather
 -- than silently rewriting the source version/envelope or widening a file.
 IF (parent.visibility='personal' AND snapshot->>'userId' IS DISTINCT FROM parent.user_id::text)
  OR NOT(snapshot->'compartments' @> to_jsonb(coalesce(parent.context_compartments,'{}'::text[])))
  OR (parent.context_project_id IS NOT NULL
    AND NOT(snapshot->'projectIds' @> jsonb_build_array(parent.context_project_id)
      OR snapshot->'compartments' @> jsonb_build_array('project:'||parent.context_project_id::text))) THEN RETURN NULL; END IF;
 projects:=ARRAY(SELECT jsonb_array_elements_text(snapshot->'projectIds')::uuid);
 IF parent.context_project_id IS NOT NULL THEN projects:=array_append(projects,parent.context_project_id); END IF;
 PERFORM id FROM workspace_projects WHERE workspace_id=w AND id=ANY(projects) ORDER BY id FOR SHARE;
 IF EXISTS(SELECT 1 FROM unnest(projects) p WHERE NOT EXISTS(
   SELECT 1 FROM workspace_projects pr WHERE pr.workspace_id=w AND pr.id=p AND pr.status='active'
    AND (v2 OR member_role IN('owner','admin') OR EXISTS(SELECT 1 FROM workspace_project_members pm WHERE pm.project_id=p AND pm.user_id=actor)))) THEN RETURN NULL; END IF;
 -- A transcript may retain an archive for audit, but cannot turn that
 -- archive into operational file input. Walk causal derivation receipts,
 -- including a segment's canonical file, rather than supersession ancestry.
 WITH RECURSIVE ancestry(kind,id) AS (
  SELECT k,i
  UNION
  SELECT next.kind,next.id FROM ancestry a CROSS JOIN LATERAL (
   SELECT s.source_kind AS kind,s.source_id AS id
    FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
    WHERE d.workspace_id=w AND d.resource_kind=a.kind AND d.resource_id=a.id
   UNION
   SELECT 'workspace_file',f.file_id FROM file_segments f
    WHERE a.kind='file_segment' AND f.workspace_id=w AND f.id=a.id
  ) next
 ) SELECT count(*)>4096 OR coalesce(bool_or(f.purpose='engineering_archive'),false)
   INTO forbidden_ancestry FROM (SELECT * FROM ancestry LIMIT 4097) a
   LEFT JOIN workspace_files f ON a.kind='workspace_file' AND f.workspace_id=w AND f.id=a.id;
 IF forbidden_ancestry THEN RETURN NULL; END IF;
 RETURN snapshot;
END $$;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_page(uuid,text,uuid) FROM PUBLIC;

-- Descendant-file RLS traverses media snapshots too. Route conversation nodes
-- through the same admitted facade; every existing kind keeps its old path.
ALTER FUNCTION read_media_parent_snapshot(uuid,text,uuid) RENAME TO read_media_parent_snapshot_before_conversation;
REVOKE ALL ON FUNCTION read_media_parent_snapshot_before_conversation(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_media_parent_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF k='session_message' THEN RETURN read_entity_derivation_source(w,k,i); END IF;
 RETURN read_media_parent_snapshot_before_conversation(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_media_parent_snapshot(uuid,text,uuid) FROM PUBLIC;

COMMIT;
