BEGIN;
-- [COMP:sandbox/profile-source]
-- Browser profiles are not universal scoped rows. Never route them through
-- scope_source_table, whose callers expect different visibility columns.
ALTER TABLE browser_profiles ADD COLUMN scope_version bigint NOT NULL DEFAULT 1;
ALTER TABLE scope_derivation_sources DROP CONSTRAINT scope_derivation_sources_source_kind_check;
ALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_source_kind_check CHECK(source_kind IN
 ('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','crm_event','memory_verification','brain_verification','correction_audit','session_message','feedback_event','workspace_skill_revision','knowledge_source','recording','file_segment','transcript_segment','blueprint_record','browser_profile'));

ALTER FUNCTION scope_source_ancestors(uuid,text,uuid) RENAME TO scope_source_ancestors_before_browser_profile;
REVOKE ALL ON FUNCTION scope_source_ancestors_before_browser_profile(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION scope_source_ancestors(w uuid,k text,i uuid) RETURNS TABLE(resource_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF k='browser_profile' THEN
  RETURN QUERY SELECT id FROM browser_profiles WHERE workspace_id=w AND id=i;
 ELSE RETURN QUERY SELECT * FROM scope_source_ancestors_before_browser_profile(w,k,i);
 END IF;
END $$;
REVOKE ALL ON FUNCTION scope_source_ancestors(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION browser_profile_scope_fields(p jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_array(p->'workspace_id',p->'owner_user_id',p->'scope',p->'clearance',p->'department_id',p->'enabled_assistant_ids')
$$;
CREATE FUNCTION advance_browser_profile_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 NEW.scope_version:=OLD.scope_version+CASE WHEN browser_profile_scope_fields(to_jsonb(NEW))
   IS DISTINCT FROM browser_profile_scope_fields(to_jsonb(OLD)) THEN 1 ELSE 0 END;
 RETURN NEW;
END $$;
CREATE FUNCTION invalidate_browser_profile_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.scope_version IS DISTINCT FROM OLD.scope_version THEN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id) THEN
   PERFORM hold_scope_descendants(OLD.workspace_id,'browser_profile',OLD.id);
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER browser_profile_scope_version BEFORE UPDATE ON browser_profiles
 FOR EACH ROW EXECUTE FUNCTION advance_browser_profile_scope();
CREATE TRIGGER browser_profile_scope_descendants AFTER UPDATE ON browser_profiles
 FOR EACH ROW EXECUTE FUNCTION invalidate_browser_profile_scope();
CREATE TRIGGER browser_profile_deleted_descendants BEFORE DELETE ON browser_profiles
 FOR EACH ROW EXECUTE FUNCTION invalidate_browser_profile_scope();
REVOKE ALL ON FUNCTION browser_profile_scope_fields(jsonb),advance_browser_profile_scope(),invalidate_browser_profile_scope() FROM PUBLIC;

ALTER FUNCTION read_scope_source(uuid,text,uuid) RENAME TO read_scope_source_before_browser_profile;
REVOKE ALL ON FUNCTION read_scope_source_before_browser_profile(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_scope_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p browser_profiles; dept workspace_groups; held boolean:=false;
BEGIN
 IF k<>'browser_profile' THEN RETURN read_scope_source_before_browser_profile(w,k,i); END IF;
 PERFORM id FROM workspaces WHERE id=w FOR SHARE;
 SELECT * INTO p FROM browser_profiles WHERE workspace_id=w AND id=i FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF p.department_id IS NOT NULL THEN
  SELECT * INTO dept FROM workspace_groups WHERE workspace_id=w AND id=p.department_id FOR SHARE;
  held:=NOT FOUND OR dept.kind<>'team' OR dept.status<>'active' OR dept.compartment_key IS DISTINCT FROM 'team:'||p.department_id::text;
 ELSIF p.scope='workspace' THEN held:=true;
 END IF;
 RETURN jsonb_build_object('workspaceId',w,'resourceKind',k,'resourceId',i,'version',p.scope_version::text,
  'userId',CASE WHEN p.scope='owner' THEN p.owner_user_id ELSE NULL END,'assistantId',NULL,
  'sensitivity',p.clearance,'compartments',CASE WHEN p.department_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array('team:'||p.department_id::text) END,
  'projectIds','[]'::jsonb,'held',held,'validTo',NULL,'retractedAt',NULL);
END $$;
REVOKE ALL ON FUNCTION read_scope_source(uuid,text,uuid) FROM PUBLIC;

ALTER FUNCTION read_entity_derivation_source(uuid,text,uuid) RENAME TO read_entity_derivation_source_before_browser_profile;
REVOKE ALL ON FUNCTION read_entity_derivation_source_before_browser_profile(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;
 v2 boolean; s jsonb; teams text[]; p browser_profiles;
BEGIN
 IF k<>'browser_profile' THEN RETURN read_entity_derivation_source_before_browser_profile(w,k,i); END IF;
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
 -- Lock the authority inputs before the canonical snapshot. Classification
 -- writers also start with the workspace lock, and the file writer holds it
 -- exclusively through commit.
 PERFORM id FROM workspace_groups WHERE workspace_id=w AND kind='team' ORDER BY id FOR SHARE;
 PERFORM id FROM department_edges WHERE workspace_id=w AND (user_id=actor OR assistant_id=acting) ORDER BY id FOR SHARE;
 s:=read_scope_source(w,k,i);
 IF s IS NULL OR s->>'held' IS DISTINCT FROM 'false'
  OR ((s->>'userId') IS NOT NULL AND (s->>'userId')::uuid<>actor) THEN RETURN NULL; END IF;
 SELECT * INTO p FROM browser_profiles WHERE workspace_id=w AND id=i FOR SHARE;
 IF acting IS NOT NULL AND NOT acting=ANY(p.enabled_assistant_ids) THEN RETURN NULL; END IF;
 teams:=ARRAY(SELECT jsonb_array_elements_text(s->'compartments'));
 IF v2 THEN
  IF department_row_allows(department_read_grants(),w,s->>'sensitivity',teams,(s->>'userId')::uuid) IS NOT TRUE THEN RETURN NULL; END IF;
 ELSIF member_operation_scope_allows(w,s->>'sensitivity',teams,false) IS NOT TRUE THEN RETURN NULL;
 END IF;
 IF agent_read_scope_allows(s->>'sensitivity',teams,'{}'::uuid[]) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN s;
END $$;

-- Files already walk their live source ancestry on every read. Teach that
-- walker this source without weakening any existing media/session reader.
ALTER FUNCTION read_media_parent_snapshot(uuid,text,uuid) RENAME TO read_media_parent_snapshot_before_browser_profile;
REVOKE ALL ON FUNCTION read_media_parent_snapshot_before_browser_profile(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_media_parent_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF k='browser_profile' THEN RETURN read_entity_derivation_source(w,k,i); END IF;
 RETURN read_media_parent_snapshot_before_browser_profile(w,k,i);
END $$;
REVOKE ALL ON FUNCTION read_media_parent_snapshot(uuid,text,uuid) FROM PUBLIC;

-- A supporting edge may expire while the transaction is open even though
-- its row is locked. Recheck after lineage is recorded, immediately at commit.
CREATE FUNCTION renew_browser_file_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE input record; snapshot jsonb;
BEGIN
 FOR input IN SELECT s.source_id,s.source_version FROM scope_derivations d
  JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
  WHERE d.workspace_id=NEW.workspace_id AND d.resource_kind='workspace_file' AND d.resource_id=NEW.id
   AND s.source_kind='browser_profile'
 LOOP
  snapshot:=read_entity_derivation_source(NEW.workspace_id,'browser_profile',input.source_id);
  IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false'
   OR snapshot->>'version' IS DISTINCT FROM input.source_version THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER browser_file_source_current AFTER INSERT ON workspace_files
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION renew_browser_file_source();
REVOKE ALL ON FUNCTION renew_browser_file_source() FROM PUBLIC;
COMMIT;
