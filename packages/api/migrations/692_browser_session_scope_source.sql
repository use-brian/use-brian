BEGIN;
-- [COMP:sandbox/session-source] Eligible originating owner web sessions only.
ALTER TABLE sessions ADD COLUMN browser_source_version bigint NOT NULL DEFAULT 1;
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK(source_kind IN
 ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification','correction_audit','session_message','feedback_event','workspace_skill_revision','knowledge_source','recording','file_segment','transcript_segment','blueprint_record','browser_profile','browser_session'));

ALTER FUNCTION scope_source_ancestors(uuid,text,uuid) RENAME TO scope_source_ancestors_before_browser_session;
REVOKE ALL ON FUNCTION scope_source_ancestors_before_browser_session(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION scope_source_ancestors(w uuid,k text,i uuid) RETURNS TABLE(resource_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF k='browser_session' THEN RETURN QUERY SELECT id FROM sessions WHERE workspace_id=w AND id=i;
 ELSE RETURN QUERY SELECT * FROM scope_source_ancestors_before_browser_session(w,k,i);
 END IF;
END $$;
REVOKE ALL ON FUNCTION scope_source_ancestors(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION browser_session_scope_fields(s jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_array(s->'workspace_id',s->'assistant_id',s->'user_id',s->'channel_type',s->'visibility',s->'mode',
  s->'context_group_id',s->'context_project_id',s->'context_locked_at',s->'context_binding_origin',s->'effective_clearance',s->'context_compartments')
$$;
CREATE FUNCTION advance_browser_session_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 NEW.browser_source_version:=OLD.browser_source_version+CASE WHEN browser_session_scope_fields(to_jsonb(NEW))
  IS DISTINCT FROM browser_session_scope_fields(to_jsonb(OLD)) THEN 1 ELSE 0 END;
 RETURN NEW;
END $$;
CREATE FUNCTION invalidate_browser_session_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.browser_source_version IS DISTINCT FROM OLD.browser_source_version THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
   PERFORM hold_scope_descendants(OLD.workspace_id,'browser_session',OLD.id);
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER browser_session_scope_version BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION advance_browser_session_scope();
CREATE TRIGGER browser_session_scope_descendants AFTER UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION invalidate_browser_session_scope();
CREATE TRIGGER browser_session_deleted_descendants BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION invalidate_browser_session_scope();
REVOKE ALL ON FUNCTION browser_session_scope_fields(jsonb),advance_browser_session_scope(),invalidate_browser_session_scope() FROM PUBLIC;

ALTER FUNCTION read_scope_source(uuid,text,uuid) RENAME TO read_scope_source_before_browser_session;
REVOKE ALL ON FUNCTION read_scope_source_before_browser_session(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_scope_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s sessions; held boolean;
BEGIN
 IF k<>'browser_session' THEN RETURN read_scope_source_before_browser_session(w,k,i); END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 SELECT * INTO s FROM sessions WHERE workspace_id=w AND id=i FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM id FROM assistants WHERE workspace_id=w AND id=s.assistant_id FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 held:=s.channel_type IS DISTINCT FROM 'web' OR s.visibility IS DISTINCT FROM 'owner' OR s.mode IS NOT NULL
  OR s.context_locked_at IS NULL OR s.context_binding_origin='held' OR s.context_compartments IS NULL
  OR (s.context_group_id IS NOT NULL AND NOT ('team:'||s.context_group_id::text)=ANY(s.context_compartments))
  OR EXISTS(SELECT 1 FROM unnest(s.context_compartments) label WHERE label IS NULL OR NOT EXISTS(
   SELECT 1 FROM workspace_groups g WHERE g.workspace_id=w AND g.kind='team' AND g.compartment_key=label))
  OR (s.context_project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workspace_projects p
   WHERE p.workspace_id=w AND p.id=s.context_project_id));
 RETURN jsonb_build_object('workspaceId',w,'resourceKind',k,'resourceId',i,'version',s.browser_source_version::text,
  'userId',s.user_id,'assistantId',NULL,'sensitivity',coalesce(s.effective_clearance,'public'),
  'compartments',to_jsonb(s.context_compartments),'projectIds',CASE WHEN s.context_project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(s.context_project_id) END,
  'held',held,'validTo',NULL,'retractedAt',NULL);
END $$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_browser_session;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_browser_session(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 v2 boolean; snapshot jsonb; s sessions; teams text[]; projects uuid[];
BEGIN
 IF k='browser_profile' THEN
  snapshot:=read_entity_derivation_source_before_browser_session(w,k,i);
  IF acting IS NOT NULL AND assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
  RETURN snapshot;
 END IF;
 IF k<>'browser_session' THEN RETURN read_entity_derivation_source_before_browser_session(w,k,i); END IF;
 IF actor IS NULL OR (nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL
   AND current_setting('app.agent_workspace_id',true)::uuid<>w)
  OR (nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL
   AND current_setting('app.agent_actor_id',true)::uuid<>actor) THEN RETURN NULL; END IF;
 SELECT department_read_v2 INTO v2 FROM workspaces WHERE id=w FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM user_id FROM workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF acting IS NOT NULL THEN
  PERFORM id FROM assistants WHERE workspace_id=w AND id=acting FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
 END IF;
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 IF acting IS NOT NULL AND assistant_placement_visible(actor,acting) IS NOT TRUE THEN RETURN NULL; END IF;
 snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false' OR (snapshot->>'userId')::uuid IS DISTINCT FROM actor THEN RETURN NULL; END IF;
 SELECT * INTO s FROM sessions WHERE workspace_id=w AND id=i FOR SHARE;
 -- Workspace membership above supplies resolveAssistantAccess's membership
 -- leg; retain its additional canonical placement predicate too.
 IF assistant_placement_visible(actor,s.assistant_id) IS NOT TRUE THEN RETURN NULL; END IF;
 teams:=ARRAY(SELECT jsonb_array_elements_text(snapshot->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(snapshot->'projectIds')::uuid);
 IF v2 THEN
  IF department_row_allows(department_read_grants(),w,snapshot->>'sensitivity',teams,actor) IS NOT TRUE THEN RETURN NULL; END IF;
 ELSIF member_operation_scope_allows(w,snapshot->>'sensitivity',teams,false) IS NOT TRUE THEN RETURN NULL;
 END IF;
 IF agent_read_scope_allows(snapshot->>'sensitivity',teams,projects) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN snapshot;
END $$;

ALTER FUNCTION read_media_parent_snapshot(uuid,text,uuid) RENAME TO read_media_parent_snapshot_before_browser_session;
REVOKE ALL ON FUNCTION read_media_parent_snapshot_before_browser_session(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_media_parent_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF k='browser_session' THEN RETURN read_entity_derivation_source(w,k,i); END IF;
 RETURN read_media_parent_snapshot_before_browser_session(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_media_parent_snapshot(uuid,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION renew_browser_file_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE input record; snapshot jsonb;
BEGIN
 FOR input IN SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
  WHERE d.workspace_id=NEW.workspace_id AND d.resource_kind='workspace_file' AND d.resource_id=NEW.id
   AND s.source_kind IN('browser_profile','browser_session')
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
