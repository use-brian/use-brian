BEGIN;
-- Historical uploads cannot borrow a new default at late completion.
ALTER TABLE workspace_file_uploads ADD COLUMN admission_binding jsonb;
CREATE FUNCTION guard_file_upload_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF ROW(NEW.workspace_id,NEW.acting_user_id,NEW.file_id,NEW.path,NEW.name,NEW.mime,NEW.size_bytes,NEW.storage_uri,NEW.admission_binding)
   IS DISTINCT FROM ROW(OLD.workspace_id,OLD.acting_user_id,OLD.file_id,OLD.path,OLD.name,OLD.mime,OLD.size_bytes,OLD.storage_uri,OLD.admission_binding)
 THEN RAISE EXCEPTION 'file_upload_binding_immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER file_upload_binding_immutable BEFORE UPDATE ON workspace_file_uploads FOR EACH ROW EXECUTE FUNCTION guard_file_upload_binding();
-- Session-owned bytes always remain behind the live canonical private parent,
-- including after changes to scope/expiry/holding. An artifact ID in a path is
-- not enough: publication records a verified binding in its transaction.
CREATE TABLE workspace_file_session_bindings (
 file_id uuid PRIMARY KEY REFERENCES workspace_files(id) ON DELETE CASCADE,
 -- Retain a denying tombstone when the parent is deleted; never remove the
 -- authorization boundary while the file still exists. Workspace erasure may
 -- independently cascade both rows in either FK-trigger order.
 artifact_id uuid REFERENCES office_artifacts(id) ON DELETE SET NULL,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_user_id uuid NOT NULL REFERENCES users(id), snapshot text NOT NULL, bound_scope jsonb NOT NULL
);
ALTER TABLE workspace_file_session_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_session_binding_owner_read ON workspace_file_session_bindings FOR SELECT USING(owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
CREATE POLICY file_session_binding_owner_insert ON workspace_file_session_bindings FOR INSERT WITH CHECK(owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid);
CREATE FUNCTION file_session_binding_allows(file uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM workspace_file_session_bindings WHERE file_id=file)
 OR EXISTS(SELECT 1 FROM workspace_file_session_bindings b JOIN office_artifacts a ON a.id=b.artifact_id AND a.workspace_id=b.workspace_id
 WHERE b.file_id=file AND b.owner_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
   AND a.owner_user_id=b.owner_user_id AND a.mode='session' AND a.lifecycle_state='active' AND a.expires_at>now()
   AND NOT scope_review_state_held('office_artifact',a.id) AND office_artifact_scope_allows(a.id,a.workspace_id,false)
   AND sensitivity_rank(b.bound_scope->>'sensitivity')>=sensitivity_rank(a.sensitivity)
   AND b.bound_scope->'compartments' @> to_jsonb(a.compartments)
   AND b.bound_scope->'projectIds' @> to_jsonb(a.project_ids))
$$;
CREATE POLICY file_session_binding_read ON workspace_files AS RESTRICTIVE FOR SELECT USING(file_session_binding_allows(id));
REVOKE ALL ON FUNCTION guard_file_upload_binding() FROM PUBLIC;
COMMIT;
