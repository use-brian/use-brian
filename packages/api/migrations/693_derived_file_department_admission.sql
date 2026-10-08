BEGIN;
-- [COMP:sandbox/session-source] Inherited file writes use the v2 department floor.
CREATE OR REPLACE FUNCTION create_source_derived_file(p jsonb,e jsonb) RETURNS SETOF workspace_files
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  w uuid; s jsonb; expected jsonb; output workspace_files;
  teams text[]:='{}'; projects uuid[]:='{}'; additions text[]; d uuid;
  out_teams text[]; out_projects uuid[];
BEGIN
  IF entity_derivation_envelope_valid(p) IS NOT TRUE
    OR (jsonb_typeof(e)='object' AND jsonb_typeof(e->'sources')='array'
      AND jsonb_typeof(e->'producer')='string' AND btrim(e->>'producer')<>'') IS NOT TRUE
    THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  w:=(p->>'workspaceId')::uuid;
  out_teams:=ARRAY(SELECT jsonb_array_elements_text(p->'compartments'));
  out_projects:=ARRAY(SELECT jsonb_array_elements_text(p->'projectIds')::uuid);
  PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE;
  IF actor IS NULL OR actor IS DISTINCT FROM ((p->>'createdByUserId'))::uuid
    OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
    OR coalesce(jsonb_array_length((e->'sources')),0)=0 OR coalesce((e->>'producer'),'')=''
    THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  FOR expected IN SELECT value FROM jsonb_array_elements((e->'sources')) ORDER BY (value->>'resourceKind'),(value->>'resourceId') LOOP
    IF entity_derivation_envelope_valid(expected) IS NOT TRUE
      OR (jsonb_typeof(expected->'resourceKind')='string' AND jsonb_typeof(expected->'resourceId')='string'
        AND jsonb_typeof(expected->'version')='string' AND btrim(expected->>'version')<>'') IS NOT TRUE
      THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
    s:=read_entity_derivation_source(w,(expected->>'resourceKind'),((expected->>'resourceId'))::uuid);
    IF s IS NULL OR (s->>'held') IS DISTINCT FROM 'false' OR (s->>'validTo') IS NOT NULL OR (s->>'retractedAt') IS NOT NULL
      OR ((s->>'workspaceId')) IS DISTINCT FROM ((expected->>'workspaceId'))
      OR ((s->>'version')) IS DISTINCT FROM ((expected->>'version'))
      OR ((s->>'userId')) IS DISTINCT FROM ((expected->>'userId'))
      OR ((s->>'assistantId')) IS DISTINCT FROM ((expected->>'assistantId'))
      OR ((s->>'sensitivity')) IS DISTINCT FROM ((expected->>'sensitivity'))
      OR ((s->'compartments')) IS DISTINCT FROM ((expected->'compartments'))
      OR ((s->'projectIds')) IS DISTINCT FROM ((expected->'projectIds'))
      THEN RAISE EXCEPTION 'scope_source_changed'; END IF;
    IF ((s->>'userId') IS NOT NULL AND ((s->>'userId')) IS DISTINCT FROM ((p->>'userId')))
      OR ((s->>'assistantId') IS NOT NULL AND ((s->>'assistantId')) IS DISTINCT FROM ((p->>'assistantId')))
      OR (sensitivity_rank(p->>'sensitivity')>=sensitivity_rank(s->>'sensitivity')) IS NOT TRUE
      OR ((p->'compartments') @> (s->'compartments')) IS NOT TRUE
      OR ((p->'projectIds') @> (s->'projectIds')) IS NOT TRUE
      THEN RAISE EXCEPTION 'scope_visibility_incompatible'; END IF;
    teams:=teams || ARRAY(SELECT jsonb_array_elements_text((s->'compartments')));
    projects:=projects || ARRAY(SELECT jsonb_array_elements_text((s->'projectIds'))::uuid);
  END LOOP;
  IF p->>'path' ~ '^/(office|doc)/' OR p->'metadata' ?| ARRAY['sessionId','session_id','officeSession'] OR p->>'sourceSessionId' IS NOT NULL OR (p->>'sourceEpisodeId' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(e->'sources') item WHERE item->>'resourceKind'='episode' AND item->>'resourceId'=p->>'sourceEpisodeId'))
    THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(out_projects) pid WHERE NOT EXISTS(
    SELECT 1 FROM workspace_projects pr WHERE pr.workspace_id=w AND pr.id=pid AND pr.status='active'
      AND (EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w AND wm.user_id=actor AND wm.role IN('owner','admin'))
        OR EXISTS(SELECT 1 FROM workspace_project_members pm WHERE pm.project_id=pid AND pm.user_id=actor))))
    THEN RAISE EXCEPTION 'scope_operation_denied'; END IF;
  additions:=ARRAY(SELECT unnest(out_teams) EXCEPT SELECT unnest(teams));
  IF ((p->>'userId') IS NOT NULL AND ((p->>'userId'))::uuid<>actor)
    OR (CASE WHEN EXISTS(SELECT 1 FROM workspaces WHERE id=w AND department_read_v2)
      THEN department_row_allows(department_read_grants(),w,p->>'sensitivity',out_teams,(p->>'userId')::uuid)
      ELSE member_operation_scope_allows(w,p->>'sensitivity',additions,true) END) IS NOT TRUE
    OR NOT agent_mutation_scope_allows(additions)
    OR NOT agent_read_scope_allows((p->>'sensitivity'),out_teams,out_projects)
    THEN RAISE EXCEPTION 'scope_operation_denied'; END IF;
  IF (p->>'assistantId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assistants WHERE workspace_id=w AND id=((p->>'assistantId'))::uuid)
    THEN RAISE EXCEPTION 'scope_workspace_mismatch'; END IF;
  INSERT INTO workspace_files(id,workspace_id,path,parent_path,name,title,summary,mime,size_bytes,storage_uri,tags,related_ids,metadata,
    sensitivity,user_id,assistant_id,created_by_user_id,created_by_assistant_id,source_episode_id,source,compartments,project_ids)
  VALUES(coalesce((p->>'id')::uuid,gen_random_uuid()),w,p->>'path',p->>'parentPath',p->>'name',p->>'title',p->>'summary',p->>'mime',
    (p->>'sizeBytes')::bigint,p->>'storageUri',ARRAY(SELECT jsonb_array_elements_text(p->'tags')),
    ARRAY(SELECT jsonb_array_elements_text(p->'relatedIds'))::uuid[],coalesce(p->'metadata','{}'),p->>'sensitivity',
    (p->>'userId')::uuid,(p->>'assistantId')::uuid,actor,(p->>'createdByAssistantId')::uuid,(p->>'sourceEpisodeId')::uuid,
    coalesce(p->>'source','user'),out_teams,out_projects) RETURNING * INTO output;
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
    SELECT w,'workspace_file',output.id,output.scope_version::text,(e->>'producer'),output.user_id,output.assistant_id,output.sensitivity,
      output.compartments,output.project_ids,revision FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO d;
  IF d IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
    SELECT DISTINCT w,d,(value->>'resourceKind'),((value->>'resourceId'))::uuid,(value->>'version') FROM jsonb_array_elements((e->'sources'));
  RETURN NEXT output;
END $$;

COMMIT;
