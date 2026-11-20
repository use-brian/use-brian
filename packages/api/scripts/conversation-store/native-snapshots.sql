-- [COMP:api/native-turn-frame] Native rows have one current-snapshot owner.
-- Private graph helpers: complete all-version privacy must precede these reads.
CREATE OR REPLACE FUNCTION public.conversation_message_snapshot(w uuid, i uuid, archive_denied jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 k constant text:='session_message';snapshot jsonb; parent sessions; member_role text; projects uuid[]; v2 boolean;
BEGIN
 IF jsonb_typeof(archive_denied) IS DISTINCT FROM 'object' OR archive_denied ? ('session_message:'||i) THEN RETURN NULL;END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
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
 SELECT jsonb_build_object('workspaceId',m.workspace_id,'userId',m.user_id,'assistantId',m.assistant_id,
  'sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids,'resourceKind',k,'resourceId',i,
  'version',m.scope_version::text,'held',m.scope_held,'validTo',NULL,'retractedAt',NULL)
 INTO snapshot FROM session_messages m WHERE m.workspace_id=w AND m.id=i AND m.scope_version IS NOT NULL FOR SHARE;
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false'
  OR snapshot->>'validTo' IS NOT NULL OR snapshot->>'retractedAt' IS NOT NULL
  OR scope_review_state_held(k,i)
  OR agent_visibility_allows(w,(snapshot->>'userId')::uuid,(snapshot->>'assistantId')::uuid) IS NOT TRUE
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
 RETURN snapshot;
END $function$;

REVOKE ALL ON FUNCTION conversation_message_snapshot(uuid,uuid,jsonb) FROM PUBLIC,app_user;

CREATE OR REPLACE FUNCTION public.conversation_revision_snapshot(w uuid, i uuid, archive_denied jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE revision session_context_scope_revisions;root jsonb;parent jsonb;source jsonb;admitted jsonb;required jsonb:='[]';
BEGIN
 -- The owning graph already admitted complete all-version privacy.
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 SELECT * INTO revision FROM session_context_scope_revisions r
  WHERE r.workspace_id=w AND r.id=i FOR SHARE;
 IF NOT FOUND THEN RETURN '{"held":true}'::jsonb; END IF;
 IF revision.parent_kind='turn_frame' AND native_turn_frame_pair(w,i) IS NOT TRUE THEN RETURN '{"held":true}'::jsonb;END IF;
 IF revision.scope_held OR scope_review_state_held('session_context_revision',i)
  OR NOT EXISTS(SELECT 1 FROM session_context_revision_contents c WHERE c.workspace_id=w AND c.revision_id=i)
  OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.workspace_id=w AND s.id=revision.session_id)
  OR revision.parent_kind='message_annotation' AND NOT EXISTS(SELECT 1 FROM session_messages m
    WHERE m.id=revision.parent_id AND m.session_id=revision.session_id AND m.workspace_id=w)
  OR revision.parent_kind IN('compact_summary','session_title') AND revision.parent_id<>revision.session_id
  OR revision.parent_kind='session_state' AND NOT EXISTS(SELECT 1 FROM session_state s
    WHERE s.id=revision.parent_id AND s.session_id=revision.session_id)
  OR revision.parent_kind='episodic_memory' AND NOT EXISTS(SELECT 1 FROM episodic_memories e
    WHERE e.id=revision.parent_id AND e.session_id=revision.session_id)
 THEN RETURN '{"held":true}'::jsonb; END IF;
 root:=jsonb_build_object('workspaceId',w,'resourceKind','session_context_revision','resourceId',i,
  'userId',revision.user_id,'assistantId',revision.assistant_id,'sensitivity',revision.sensitivity,
  'compartments',revision.compartments,'projectIds',revision.project_ids,'version',revision.scope_version::text,
  'held',false,'validTo',NULL,'retractedAt',NULL);
 parent:=session_context_parent_snapshot(w,revision.session_id);
 IF revision.parent_kind='message_annotation' AND conversation_message_snapshot(w,revision.parent_id,archive_denied)->>'held' IS DISTINCT FROM 'false'
  OR parent IS NULL OR workflow_evidence_envelope_visible(w,parent) IS NOT TRUE
  OR agent_visibility_allows(w,revision.user_id,revision.assistant_id) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,root) IS NOT TRUE THEN RETURN NULL;END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(read_resource_page_dependencies(w,'session_context_revision',i,'1')) LOOP
  admitted:=read_page_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM source->>'version' THEN RETURN NULL;END IF;
  required:=required||jsonb_build_array(source)||coalesce(admitted->'requiredSources','[]');
 END LOOP;
 RETURN root||jsonb_build_object('requiredSources',(SELECT coalesce(jsonb_agg(DISTINCT value),'[]') FROM jsonb_array_elements(required)));
END $function$;

REVOKE ALL ON FUNCTION conversation_revision_snapshot(uuid,uuid,jsonb) FROM PUBLIC,app_user;
