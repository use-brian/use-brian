BEGIN;
ALTER TABLE scope_derivations DROP CONSTRAINT scope_derivations_resource_kind_check;
ALTER TABLE scope_derivations ADD CONSTRAINT scope_derivations_resource_kind_check
 CHECK(resource_kind IN ('memory','session_message','feedback_event','workspace_skill_revision','entity','entity_link','knowledge_entry','workspace_file'));
CREATE FUNCTION create_source_derived_file(p jsonb,e jsonb) RETURNS SETOF workspace_files
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
    OR NOT member_operation_scope_allows(w,(p->>'sensitivity'),additions,true)
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

ALTER FUNCTION hold_scope_descendants(uuid,text,uuid) RENAME TO hold_scope_descendants_before_files;
CREATE FUNCTION hold_scope_descendants(w uuid,k text,i uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM hold_scope_descendants_before_files(w,k,i);
 UPDATE workspace_files SET scope_held=true WHERE workspace_id=w AND NOT scope_held
   AND id IN (
     WITH RECURSIVE descendants(kind,id) AS (
       SELECT d.resource_kind,d.resource_id FROM scope_derivation_sources s
         JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
         WHERE s.workspace_id=w AND s.source_kind=k AND s.source_id=i
       UNION
       SELECT d.resource_kind,d.resource_id FROM descendants p
         JOIN scope_derivation_sources s ON s.workspace_id=w AND s.source_kind=p.kind AND s.source_id=p.id
         JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
     ) SELECT id FROM descendants WHERE kind='workspace_file'
     UNION SELECT resource_id FROM scope_descendant_resources(w,k,i) WHERE resource_kind='workspace_file'
   );
END $$;
REVOKE ALL ON FUNCTION hold_scope_descendants(uuid,text,uuid) FROM PUBLIC;
-- Use 630's complete semantic projection so maintenance cannot advance a file
-- version or invalidate its descendants. Only version advancement runs BEFORE
-- UPDATE: invalidating there can re-update B during a bulk hold of A and B.
CREATE FUNCTION advance_derived_file_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF entity_scope_semantic_row(to_jsonb(NEW)) IS DISTINCT FROM entity_scope_semantic_row(to_jsonb(OLD))
    THEN NEW.scope_version:=OLD.scope_version+1;
  ELSE NEW.scope_version:=OLD.scope_version; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION invalidate_derived_file() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,'workspace_file',OLD.id);
    END IF;
    RETURN OLD;
  ELSIF (entity_scope_semantic_row(to_jsonb(NEW))-'scope_held')
    IS DISTINCT FROM (entity_scope_semantic_row(to_jsonb(OLD))-'scope_held')
    OR (NOT OLD.scope_held AND NEW.scope_held AND pg_trigger_depth()=1) THEN
    -- The graph walker already holds every descendant. Suppress only nested
    -- hold-only writes, never semantic edits or an explicit top-level hold.
    PERFORM hold_scope_descendants(OLD.workspace_id,'workspace_file',OLD.id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER canonical_scope_version ON workspace_files;
CREATE TRIGGER canonical_scope_version BEFORE UPDATE ON workspace_files
  FOR EACH ROW EXECUTE FUNCTION advance_derived_file_version();
CREATE TRIGGER invalidate_derived_file AFTER UPDATE ON workspace_files
  FOR EACH ROW EXECUTE FUNCTION invalidate_derived_file();
-- Keep the canonical root available to the ancestor walker during deletion.
CREATE TRIGGER invalidate_deleted_file BEFORE DELETE ON workspace_files
  FOR EACH ROW EXECUTE FUNCTION invalidate_derived_file();
REVOKE ALL ON FUNCTION advance_derived_file_version(),invalidate_derived_file() FROM PUBLIC;
COMMIT;
