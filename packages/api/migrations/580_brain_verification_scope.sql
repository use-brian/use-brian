BEGIN;

ALTER TABLE brain_verifications ADD COLUMN source_scope jsonb;
ALTER TABLE memory_verifications ADD COLUMN source_scope jsonb;

CREATE FUNCTION capture_verification_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE kind text; source_id uuid; captured jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.source_scope IS DISTINCT FROM OLD.source_scope
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR (TG_TABLE_NAME='brain_verifications' AND
        (to_jsonb(NEW)->'target_kind',to_jsonb(NEW)->'target_id') IS DISTINCT FROM
        (to_jsonb(OLD)->'target_kind',to_jsonb(OLD)->'target_id'))
      OR (TG_TABLE_NAME='memory_verifications' AND to_jsonb(NEW)->'memory_id' IS DISTINCT FROM to_jsonb(OLD)->'memory_id') THEN
      RAISE EXCEPTION 'verification_scope_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.source_scope IS NOT NULL THEN RAISE EXCEPTION 'verification_scope_server_owned'; END IF;
  IF TG_TABLE_NAME='memory_verifications' THEN
    kind='memory'; source_id=(to_jsonb(NEW)->>'memory_id')::uuid;
  ELSE
    kind=to_jsonb(NEW)->>'target_kind'; source_id=(to_jsonb(NEW)->>'target_id')::uuid;
    IF kind IN('contact','company','deal') THEN kind='entity'; END IF;
  END IF;
  captured=read_scope_source(NEW.workspace_id,kind,source_id);
  IF captured IS NULL OR captured->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text THEN
    RAISE EXCEPTION 'verification_source_unavailable';
  END IF;
  NEW.source_scope=captured;
  RETURN NEW;
END;
$$;
CREATE TRIGGER brain_verification_scope BEFORE INSERT OR UPDATE ON brain_verifications
FOR EACH ROW EXECUTE FUNCTION capture_verification_scope();
CREATE TRIGGER memory_verification_scope BEFORE INSERT OR UPDATE ON memory_verifications
FOR EACH ROW EXECUTE FUNCTION capture_verification_scope();

-- SECURITY INVOKER: the current source must itself survive its RLS policies.
-- The retained snapshot prevents later source declassification widening audit.
CREATE FUNCTION verification_scope_allows(p_workspace uuid,p_scope jsonb,p_mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE tab text; allowed boolean; comps text[]; projects uuid[]; actor uuid;
BEGIN
  IF p_scope IS NULL OR p_scope->>'workspaceId' IS DISTINCT FROM p_workspace::text THEN RETURN false; END IF;
  actor=nullif(current_setting('app.current_user_id',true),'')::uuid;
  IF actor IS NULL OR (p_scope->>'userId' IS NOT NULL AND p_scope->>'userId'<>actor::text) THEN RETURN false; END IF;
  comps=ARRAY(SELECT jsonb_array_elements_text(p_scope->'compartments'));
  projects=ARRAY(SELECT jsonb_array_elements_text(p_scope->'projectIds'))::uuid[];
  IF NOT context_scope_allows_current_principal(p_workspace,p_scope->>'sensitivity',comps,projects)
    OR NOT agent_visibility_allows(p_workspace,(p_scope->>'userId')::uuid,(p_scope->>'assistantId')::uuid)
    OR (p_mutation AND NOT agent_mutation_scope_allows(comps)) THEN RETURN false; END IF;
  tab=CASE p_scope->>'resourceKind' WHEN 'memory' THEN 'memories' WHEN 'entity' THEN 'entities'
    WHEN 'entity_link' THEN 'entity_links' WHEN 'task' THEN 'tasks' WHEN 'workspace_file' THEN 'workspace_files' END;
  IF tab IS NULL THEN RETURN false; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE workspace_id=$1 AND id=$2 AND NOT scope_held
    AND (user_id IS NULL OR user_id=$3)
    AND context_scope_allows_current_principal(workspace_id,sensitivity,compartments,project_ids)
    AND (NOT $4 OR agent_mutation_scope_allows(compartments)))',tab)
    INTO allowed USING p_workspace,(p_scope->>'resourceId')::uuid,actor,p_mutation;
  RETURN allowed;
END;
$$;

CREATE POLICY brain_verification_source_read ON brain_verifications FOR SELECT
USING(verification_scope_allows(workspace_id,source_scope));
CREATE POLICY brain_verification_actor_insert ON brain_verifications FOR INSERT
WITH CHECK(verified_by=current_setting('app.current_user_id',true)::uuid
  AND verification_scope_allows(workspace_id,source_scope,true));
CREATE POLICY memory_verification_source_read ON memory_verifications FOR SELECT
USING(verification_scope_allows(workspace_id,source_scope));
CREATE POLICY memory_verification_actor_insert ON memory_verifications FOR INSERT
WITH CHECK(verified_by=current_setting('app.current_user_id',true)::uuid
  AND verification_scope_allows(workspace_id,source_scope,true));

CREATE POLICY decision_verification_source_read ON decision_events AS RESTRICTIVE FOR SELECT USING(
  CASE source_kind
    WHEN 'brain_verification' THEN EXISTS(SELECT 1 FROM brain_verifications v WHERE v.id::text=source_id AND v.workspace_id=decision_events.workspace_id)
    WHEN 'memory_verification' THEN EXISTS(SELECT 1 FROM memory_verifications v WHERE v.id::text=source_id AND v.workspace_id=decision_events.workspace_id)
    ELSE true END
);

COMMIT;
