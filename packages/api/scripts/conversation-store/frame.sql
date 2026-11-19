-- [COMP:api/native-turn-frame] Canonical conversation publication.
CREATE OR REPLACE FUNCTION public.native_turn_frame_pair(w uuid, i uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE f native_turn_frames;r session_context_scope_revisions;d scope_derivations;parent sessions;p jsonb;edges jsonb;declared jsonb;
BEGIN
 SELECT * INTO f FROM native_turn_frames WHERE workspace_id=w AND id=i;
 SELECT * INTO r FROM session_context_scope_revisions WHERE workspace_id=w AND id=i;
 SELECT id,visibility,user_id INTO parent.id,parent.visibility,parent.user_id FROM sessions WHERE workspace_id=w AND id=r.session_id;
 SELECT content INTO p FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=i;
 IF f.id IS NULL OR r.id IS NULL OR parent.id IS NULL OR r.scope_held OR scope_review_state_held('session_context_revision',i)
  OR parent.visibility='personal' AND r.user_id IS DISTINCT FROM parent.user_id
  OR f.format=1 AND parent.visibility<>'personal' AND r.user_id IS NOT NULL
  OR r.assistant_id IS NOT NULL OR f.format NOT IN(1,2) OR (f.format=1) IS DISTINCT FROM (p->>'kind'='native_turn_frame_v1') OR r.parent_kind IS DISTINCT FROM 'turn_frame'
  OR r.parent_id IS DISTINCT FROM i OR r.session_id IS DISTINCT FROM f.session_id OR r.scope_version<>1
  OR native_turn_frame_payload_shape(p) IS NOT TRUE OR r.payload_sha256<>encode(sha256(convert_to(p::text,'UTF8')),'hex')
  OR f.manifest_digest<>r.payload_sha256 OR EXISTS(SELECT 1 FROM jsonb_array_elements((p->'originalSources')||(p->'declaredSources')) n
   WHERE n->>'workspaceId' IS DISTINCT FROM w::text OR n->>'resourceKind'='session_context_revision' AND n->>'resourceId'=i::text)
 THEN RETURN false;END IF;
 SELECT * INTO d FROM scope_derivations WHERE workspace_id=w AND resource_kind='session_context_revision' AND resource_id=i AND resource_version='1';
 IF d.id IS NULL OR (d.user_id,d.assistant_id,d.sensitivity,d.compartments,d.project_ids)
  IS DISTINCT FROM (r.user_id,r.assistant_id,r.sensitivity,r.compartments,r.project_ids) THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_array(source_kind,source_id,source_version) ORDER BY source_kind,source_id,source_version),'[]') INTO edges
 FROM scope_derivation_sources WHERE workspace_id=w AND derivation_id=d.id;
 SELECT coalesce(jsonb_agg(jsonb_build_array(n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version') ORDER BY n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version'),'[]')
 INTO declared FROM jsonb_array_elements(p->'declaredSources') n;
 IF edges IS DISTINCT FROM declared OR EXISTS(SELECT 1 FROM jsonb_array_elements((p->'originalSources')||(p->'declaredSources')) n
  WHERE n->>'userId' IS NOT NULL AND n->>'userId' IS DISTINCT FROM r.user_id::text
   OR sensitivity_rank(n->>'sensitivity')>sensitivity_rank(r.sensitivity)
   OR NOT to_jsonb(r.compartments) @> (n->'compartments') OR NOT to_jsonb(r.project_ids) @> (n->'projectIds')) THEN RETURN false;END IF;
 RETURN true;
END $function$;
