BEGIN;

-- Scope adapter only: Office View/Comment/Edit continues to be resolved by
-- the canonical Office service. Read grants never pass the mutation floor.
CREATE FUNCTION office_labels_scope_allows(w uuid, sensitivity text, compartments text[], projects uuid[],
  visible_users uuid[], visible_assistants uuid[], mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid=nullif(current_setting('app.current_user_id',true),'')::uuid;
  bound_actor text=nullif(current_setting('app.agent_actor_id',true),'');
  assistant_grant jsonb=nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb;
BEGIN
  IF NOT member_operation_scope_allows(w,sensitivity,compartments,mutation)
    OR NOT agent_read_scope_allows(sensitivity,compartments,projects)
    OR NOT agent_visibility_allows(w,NULL,NULL)
    OR (mutation AND NOT agent_mutation_scope_allows(compartments)) THEN RETURN false; END IF;
  IF cardinality(visible_users)>0 AND (
    NOT actor=ANY(visible_users)
    OR (bound_actor IS NOT NULL AND NOT bound_actor=ANY(visible_users::text[]))
  ) THEN RETURN false; END IF;
  IF cardinality(visible_assistants)>0 AND nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL THEN
    IF assistant_grant IS NULL THEN RETURN false; END IF;
    IF assistant_grant<>'null'::jsonb THEN
      IF jsonb_typeof(assistant_grant)<>'array' THEN RETURN false; END IF;
      IF NOT EXISTS(SELECT 1 FROM unnest(visible_assistants) id WHERE assistant_grant ? id::text) THEN RETURN false; END IF;
    END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

CREATE FUNCTION office_sources_scope_allows(artifact uuid,w uuid,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT NOT EXISTS(SELECT 1 FROM office_artifact_sources s
    WHERE s.artifact_id=artifact AND s.retracted_at IS NULL AND
      (s.workspace_id<>w OR NOT office_labels_scope_allows(s.workspace_id,s.sensitivity,
        s.required_compartments,'{}',s.visibility_user_ids,s.visibility_assistant_ids,mutation)))
$$;

-- Use row values, not a lookup by id: WITH CHECK must validate replacement
-- classification/visibility rather than the previous persisted row.
CREATE FUNCTION office_root_scope_allows(artifact uuid,w uuid,sensitivity text,compartments text[],
  projects uuid[],visible_users uuid[],visible_assistants uuid[],mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT office_labels_scope_allows(w,sensitivity,compartments,projects,visible_users,visible_assistants,mutation)
    AND office_sources_scope_allows(artifact,w,mutation)
    AND NOT EXISTS(SELECT 1 FROM office_artifact_grants g WHERE g.artifact_id=artifact
      AND g.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
      AND g.role='deny' AND g.revoked_at IS NULL)
$$;

-- VOLATILE intentionally takes a fresh command snapshot: child policies must
-- observe a parent inserted by an earlier data-modifying CTE in the same command.
CREATE FUNCTION office_artifact_scope_allows(artifact uuid,w uuid,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM office_artifacts a WHERE a.id=artifact AND a.workspace_id=w
    AND office_root_scope_allows(a.id,a.workspace_id,a.sensitivity,a.compartments,a.project_ids,
      a.visibility_user_ids,a.visibility_assistant_ids,mutation))
$$;

CREATE FUNCTION office_child_scope_allows(parent uuid,w uuid,parent_kind text,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE artifact uuid;
BEGIN
  IF parent_kind='thread' THEN
    SELECT t.artifact_id INTO artifact FROM office_comment_threads t WHERE t.id=parent AND t.workspace_id=w;
  ELSIF parent_kind='job' THEN
    SELECT j.artifact_id INTO artifact FROM office_generation_jobs j WHERE j.id=parent AND j.workspace_id=w;
  ELSE RETURN false; END IF;
  RETURN artifact IS NOT NULL AND office_artifact_scope_allows(artifact,w,mutation);
END;
$$;

-- Template lifecycle audit events have no artifact_id. Resolve their typed
-- template identity instead of admitting arbitrary unbound workspace events.
CREATE FUNCTION office_audit_scope_allows(artifact uuid,w uuid,metadata jsonb,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t office_templates;
BEGIN
  IF artifact IS NOT NULL THEN RETURN office_artifact_scope_allows(artifact,w,mutation); END IF;
  IF metadata->>'templateId' IS NULL THEN RETURN false; END IF;
  SELECT * INTO t FROM office_templates WHERE id=(metadata->>'templateId')::uuid AND workspace_id=w;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN office_labels_scope_allows(w,t.sensitivity,'{}','{}',t.visibility_user_ids,'{}',mutation)
    AND (t.draft_artifact_id IS NULL OR office_artifact_scope_allows(t.draft_artifact_id,w,mutation));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

-- Replace the old ordinary-membership-only permissive policies so temporary
-- read grants can work. Every operation is additionally constrained below.
DROP POLICY office_artifacts_context_member ON office_artifacts;
CREATE POLICY office_artifacts_context_member ON office_artifacts USING (true);
DROP POLICY office_versions_context_member ON office_artifact_versions;
CREATE POLICY office_versions_context_member ON office_artifact_versions USING (true);
DROP POLICY office_sources_context_member ON office_artifact_sources;
CREATE POLICY office_sources_context_member ON office_artifact_sources USING (true);

DO $$ DECLARE tab text; read_check text; write_check text; BEGIN
  FOREACH tab IN ARRAY ARRAY['office_artifacts','office_artifact_versions','office_artifact_sources',
    'office_artifact_grants','office_audit_events','office_collab_documents','office_comment_threads',
    'office_comment_messages','office_suggestions','office_generation_jobs','office_generation_events',
    'office_generation_steering','office_claims','office_media_uses','office_release_records','office_offline_packages'] LOOP
    read_check=CASE tab
      WHEN 'office_artifacts' THEN 'office_root_scope_allows(id,workspace_id,sensitivity,compartments,project_ids,visibility_user_ids,visibility_assistant_ids,false)'
      WHEN 'office_audit_events' THEN 'office_audit_scope_allows(artifact_id,workspace_id,metadata,false)'
      WHEN 'office_comment_messages' THEN 'office_child_scope_allows(thread_id,workspace_id,''thread'',false)'
      WHEN 'office_generation_events' THEN 'office_child_scope_allows(job_id,workspace_id,''job'',false)'
      WHEN 'office_generation_steering' THEN 'office_child_scope_allows(job_id,workspace_id,''job'',false)'
      ELSE 'office_artifact_scope_allows(artifact_id,workspace_id,false)' END;
    IF tab='office_artifact_sources' THEN
      read_check=read_check||' AND office_labels_scope_allows(workspace_id,sensitivity,required_compartments,''{}'',visibility_user_ids,visibility_assistant_ids,false)';
    END IF;
    write_check=replace(read_check,',false)',',true)');
    EXECUTE format('CREATE POLICY office_scope_read ON %I AS RESTRICTIVE FOR SELECT USING(%s)',tab,read_check);
    EXECUTE format('CREATE POLICY office_scope_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK(%s)',tab,write_check);
    EXECUTE format('CREATE POLICY office_scope_update ON %I AS RESTRICTIVE FOR UPDATE USING(%s) WITH CHECK(%s)',tab,write_check,write_check);
    EXECUTE format('CREATE POLICY office_scope_delete ON %I AS RESTRICTIVE FOR DELETE USING(%s)',tab,write_check);
  END LOOP;
END $$;

-- Lifecycle cleanup must reach every owner's offline package without widening
-- their SELECT policy. The root UPDATE has already passed its authority checks;
-- an unsuccessful transition rolls back this trigger in the same transaction.
CREATE FUNCTION office_revoke_offline_on_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE office_offline_packages SET revoked_at=now(),complete=false,updated_at=now()
    WHERE artifact_id=NEW.id AND workspace_id=NEW.workspace_id AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER office_lifecycle_revoke_offline
  AFTER UPDATE OF lifecycle_state ON office_artifacts FOR EACH ROW
  WHEN (OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state
    AND NEW.lifecycle_state IN ('archived','trash','retained','purged'))
  EXECUTE FUNCTION office_revoke_offline_on_lifecycle();

COMMIT;
