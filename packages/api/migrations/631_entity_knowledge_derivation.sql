BEGIN;

ALTER TABLE scope_derivations DROP CONSTRAINT scope_derivations_resource_kind_check;
ALTER TABLE scope_derivations ADD CONSTRAINT scope_derivations_resource_kind_check
  CHECK(resource_kind IN ('memory','session_message','feedback_event','workspace_skill_revision','entity','entity_link','knowledge_entry'));

-- Closed metadata adapter: no content, no owner fallback, no visibility bypass.
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb; actor uuid := nullif(current_setting('app.current_user_id',true),'')::uuid;
  teams text[]; projects uuid[]; visible jsonb;
BEGIN
  IF actor IS NULL OR k NOT IN ('entity','entity_link','episode','memory','knowledge_entry','kb_chunk','task','workspace_file')
    OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
    OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL
      AND current_setting('app.agent_workspace_id',true)::uuid<>w) THEN RETURN NULL; END IF;
  s:=read_scope_source(w,k,i);
  IF s IS NULL OR ((s->>'userId') IS NOT NULL AND ((s->>'userId'))::uuid<>actor) THEN RETURN NULL; END IF;
  teams:=ARRAY(SELECT jsonb_array_elements_text((s->'compartments')));
  projects:=ARRAY(SELECT jsonb_array_elements_text((s->'projectIds'))::uuid);
  visible:=nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb;
  IF visible IS NOT NULL AND visible<>'null'::jsonb AND (s->>'assistantId') IS NOT NULL
    AND NOT visible ? ((s->>'assistantId')) THEN RETURN NULL; END IF;
  IF NOT member_operation_scope_allows(w,(s->>'sensitivity'),teams,false)
    OR NOT agent_read_scope_allows((s->>'sensitivity'),teams,projects) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM unnest(projects) pid WHERE NOT EXISTS(
    SELECT 1 FROM workspace_projects pr WHERE pr.workspace_id=w AND pr.id=pid AND pr.status='active'
      AND (EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w AND wm.user_id=actor AND wm.role IN('owner','admin'))
        OR EXISTS(SELECT 1 FROM workspace_project_members pm WHERE pm.project_id=pid AND pm.user_id=actor)))) THEN RETURN NULL; END IF;
  RETURN s;
END $$;

-- Validate before casting or expanding arrays: omitted axes are not General.
CREATE FUNCTION entity_derivation_envelope_valid(s jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE uuid_pattern text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  IF (jsonb_typeof(s)='object'
    AND s ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
    AND jsonb_typeof(s->'workspaceId')='string' AND (s->>'workspaceId') ~ uuid_pattern
    AND (s->'userId'='null'::jsonb OR (jsonb_typeof(s->'userId')='string' AND (s->>'userId') ~ uuid_pattern))
    AND (s->'assistantId'='null'::jsonb OR (jsonb_typeof(s->'assistantId')='string' AND (s->>'assistantId') ~ uuid_pattern))
    AND jsonb_typeof(s->'sensitivity')='string' AND s->>'sensitivity' IN ('public','internal','confidential')
    AND jsonb_typeof(s->'compartments')='array' AND jsonb_typeof(s->'projectIds')='array') IS NOT TRUE
    THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'compartments') item
    WHERE (jsonb_typeof(item)='string' AND btrim(item #>> '{}')<>'') IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(s->'projectIds') item
    WHERE (jsonb_typeof(item)='string' AND (item #>> '{}') ~ uuid_pattern) IS NOT TRUE)
    THEN RETURN false; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION entity_derivation_envelope_valid(jsonb) FROM PUBLIC;

-- The only INSERT exemption is a new entity with exact locked readable inputs.
-- All additions still require mutation authority. Existing rows cannot be edited.
CREATE FUNCTION create_source_derived_entity(p jsonb,e jsonb) RETURNS SETOF entities
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  w uuid; s jsonb; expected jsonb; output entities;
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
  IF p->>'sourceSessionId' IS NOT NULL OR (p->>'sourceEpisodeId' IS NOT NULL AND NOT EXISTS(
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
  INSERT INTO entities(kind,display_name,canonical_id,aliases,attributes,sensitivity,workspace_id,user_id,assistant_id,
    created_by_user_id,created_by_assistant_id,source_episode_id,source,compartments,project_ids,source_session_id)
  VALUES((p->>'kind'),(p->>'displayName'),(p->>'canonicalId'),ARRAY(SELECT jsonb_array_elements_text((p->'aliases'))),
    coalesce((p->'attributes'),'{}'),(p->>'sensitivity'),w,((p->>'userId'))::uuid,((p->>'assistantId'))::uuid,
    actor,((p->>'createdByAssistantId'))::uuid,((p->>'sourceEpisodeId'))::uuid,(p->>'source'),out_teams,out_projects,NULL)
  RETURNING * INTO output;
  INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
    SELECT w,'entity',output.id,output.scope_version::text,(e->>'producer'),output.user_id,output.assistant_id,output.sensitivity,
      output.compartments,output.project_ids,revision FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO d;
  IF d IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;
  INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
    SELECT DISTINCT w,d,(value->>'resourceKind'),((value->>'resourceId'))::uuid,(value->>'version') FROM jsonb_array_elements((e->'sources'));
  RETURN NEXT output;
END $$;

CREATE OR REPLACE FUNCTION hold_scope_descendants(target_workspace uuid,target_kind text,target_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE memory_ids uuid[]; message_ids uuid[]; feedback_ids uuid[]; skill_revision_ids uuid[]; policy_revision bigint; entity_ids uuid[];
BEGIN
  SELECT array_agg(resource_id) INTO memory_ids
    FROM scope_descendant_memories(target_workspace,target_kind,target_id);
  WITH RECURSIVE descendants(kind,id) AS (
    SELECT d.resource_kind,d.resource_id FROM scope_derivation_sources s
      JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
      WHERE s.workspace_id=target_workspace AND s.source_kind=target_kind
        AND s.source_id IN(SELECT resource_id FROM scope_source_ancestors(target_workspace,target_kind,target_id))
    UNION
    SELECT d.resource_kind,d.resource_id FROM descendants p
      JOIN scope_derivation_sources s ON s.source_kind=p.kind AND s.source_id=p.id AND s.workspace_id=target_workspace
      JOIN scope_derivations d ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id
  ) SELECT array_agg(DISTINCT id) FILTER(WHERE kind='session_message'),
           array_agg(DISTINCT id) FILTER(WHERE kind='feedback_event'),
           array_agg(DISTINCT id) FILTER(WHERE kind='workspace_skill_revision')
      INTO message_ids,feedback_ids,skill_revision_ids FROM descendants;
  SELECT array_agg(resource_id) INTO entity_ids FROM scope_descendant_resources(target_workspace,target_kind,target_id) WHERE resource_kind='entity';
  INSERT INTO workspace_access_policies(workspace_id,revision) VALUES(target_workspace,2)
    ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_access_policies.revision+1,updated_at=now()
    RETURNING revision INTO policy_revision;
  IF message_ids IS NOT NULL THEN
    UPDATE session_messages SET scope_held=true
      WHERE workspace_id=target_workspace AND id=ANY(message_ids) AND NOT scope_held;
  END IF;
  IF feedback_ids IS NOT NULL THEN
    UPDATE analytics_events SET scope_held=true
      WHERE workspace_id=target_workspace AND id=ANY(feedback_ids) AND NOT scope_held;
  END IF;
  IF skill_revision_ids IS NOT NULL THEN
    UPDATE workspace_skill_scope_revisions SET scope_held=true
      WHERE workspace_id=target_workspace AND id=ANY(skill_revision_ids) AND NOT scope_held;
    INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
      SELECT workspace_id,'workspace_skill_revision',id,scope_version::text,'held',policy_revision,'source_changed'
        FROM workspace_skill_scope_revisions WHERE workspace_id=target_workspace AND id=ANY(skill_revision_ids)
      ON CONFLICT(workspace_id,resource_kind,resource_id,resource_version) DO UPDATE
        SET review_state='held',classification_revision=EXCLUDED.classification_revision,
            holding_reason='source_changed',updated_at=now();
  END IF;
  UPDATE entities SET scope_held=true WHERE workspace_id=target_workspace AND id=ANY(entity_ids) AND NOT scope_held;
  IF memory_ids IS NULL THEN RETURN; END IF;
  UPDATE memories SET scope_held=true
    WHERE workspace_id=target_workspace AND id=ANY(memory_ids) AND NOT scope_held;
  INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
    SELECT workspace_id,'memory',id,scope_version::text,'held',policy_revision,'source_changed'
      FROM memories WHERE workspace_id=target_workspace AND id=ANY(memory_ids)
    ON CONFLICT(workspace_id,resource_kind,resource_id,resource_version) DO UPDATE
      SET review_state='held',classification_revision=EXCLUDED.classification_revision,
          holding_reason='source_changed',updated_at=now();
END;
$$;

-- Share the predecessor's complete maintenance exclusions between versioning
-- and invalidation. Holding remains an authorization change, not maintenance.
CREATE FUNCTION entity_scope_semantic_row(r jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT r-ARRAY['scope_version','updated_at','embedding','embedding_model_id','content_hash',
    'embedding_failed_at','embedding_failure_reason','embedding_updated_at','search_vector',
    'recall_count','useful_recall_count','last_recalled_at','query_hashes','recall_days',
    'centrality','centrality_computed_at','last_checkpoint_at','extraction_locked']
$$;
REVOKE ALL ON FUNCTION entity_scope_semantic_row(jsonb) FROM PUBLIC;

-- Entity output holding is an AFTER operation, and a hold-only update must not
-- recursively invalidate siblings while the outer graph update is in progress.
CREATE FUNCTION advance_derived_entity_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF entity_scope_semantic_row(to_jsonb(NEW)) IS DISTINCT FROM entity_scope_semantic_row(to_jsonb(OLD))
    THEN NEW.scope_version:=OLD.scope_version+1;
  ELSE NEW.scope_version:=OLD.scope_version; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION invalidate_derived_entity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
      PERFORM hold_scope_descendants(OLD.workspace_id,'entity',OLD.id);
    END IF;
    RETURN OLD;
  ELSIF (entity_scope_semantic_row(to_jsonb(NEW))-'scope_held')
    IS DISTINCT FROM (entity_scope_semantic_row(to_jsonb(OLD))-'scope_held')
    OR (NOT OLD.scope_held AND NEW.scope_held AND pg_trigger_depth()=1) THEN
    PERFORM hold_scope_descendants(OLD.workspace_id,'entity',OLD.id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER canonical_scope_version ON entities;
CREATE TRIGGER canonical_scope_version BEFORE UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION advance_derived_entity_version();
CREATE TRIGGER invalidate_derived_entity AFTER UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION invalidate_derived_entity();
-- The ancestor walker needs the canonical root to still exist. Holding after
-- DELETE loses that root and can leave derived memories readable.
CREATE TRIGGER invalidate_deleted_entity BEFORE DELETE ON entities FOR EACH ROW EXECUTE FUNCTION invalidate_derived_entity();
REVOKE ALL ON FUNCTION advance_derived_entity_version(),invalidate_derived_entity() FROM PUBLIC;

COMMIT;
