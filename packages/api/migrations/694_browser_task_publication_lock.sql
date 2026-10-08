BEGIN;
-- [COMP:sandbox/task-publication]
-- Serialize history changes and replacement with publication, without making
-- mutable task history a durable source that would invalidate earlier files.
CREATE FUNCTION browser_task_publication_lock_key(w uuid, s uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT SET search_path=public AS $$
  SELECT hashtextextended('browser-task-publication:' || w::text || ':' || s::text, 0)
$$;
REVOKE ALL ON FUNCTION browser_task_publication_lock_key(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION lock_browser_task_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE w uuid; s uuid;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.task_id,NEW.workspace_id,NEW.session_id,NEW.user_id,NEW.sandbox_id)
      IS DISTINCT FROM (OLD.task_id,OLD.workspace_id,OLD.session_id,OLD.user_id,OLD.sandbox_id) THEN
    RAISE EXCEPTION 'browser_task_identity_immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN w:=OLD.workspace_id; s:=OLD.session_id;
  ELSE w:=NEW.workspace_id; s:=NEW.session_id; END IF;
  PERFORM pg_advisory_xact_lock(browser_task_publication_lock_key(w,s));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION lock_browser_task_mutation() FROM PUBLIC;
CREATE TRIGGER sandbox_task_publication_lock BEFORE INSERT OR UPDATE OR DELETE ON sandbox_tasks
FOR EACH ROW EXECUTE FUNCTION lock_browser_task_mutation();

CREATE FUNCTION admit_browser_task_publication(w uuid, s uuid, t uuid, expected jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE current_task sandbox_tasks%ROWTYPE; snapshot jsonb; actor uuid;
BEGIN
  actor := nullif(current_setting('app.current_user_id',true),'')::uuid;
  IF actor IS NULL OR expected->>'userId' IS DISTINCT FROM actor::text
      OR expected->>'workspaceId' IS DISTINCT FROM w::text
      OR expected->>'sessionId' IS DISTINCT FROM s::text
      OR expected->>'taskId' IS DISTINCT FROM t::text
      OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN
    RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(browser_task_publication_lock_key(w,s));
  SELECT * INTO current_task FROM sandbox_tasks
    WHERE workspace_id=w AND session_id=s AND status IN ('running','paused')
    ORDER BY created_at DESC,task_id DESC LIMIT 1;
  IF NOT FOUND OR current_task.task_id<>t OR current_task.user_id<>actor THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';
  END IF;
  snapshot:=jsonb_build_object('taskId',current_task.task_id,'sessionId',current_task.session_id,
    'workspaceId',current_task.workspace_id,'userId',current_task.user_id,'profileId',current_task.profile_id,
    'profileAuthority',current_task.profile_authority,'executionAuthority',current_task.execution_authority,
    'sourceAuthority',current_task.source_authority,'inputScope',current_task.input_scope);
  IF snapshot IS DISTINCT FROM expected OR current_task.input_scope IS NULL THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';
  END IF;
END $$;
COMMIT;
