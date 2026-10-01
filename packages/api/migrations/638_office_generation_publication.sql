BEGIN;
CREATE FUNCTION office_generation_artifact_allows(artifact uuid,w uuid,mutation boolean) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM office_artifacts a
 JOIN workspace_members wm ON wm.workspace_id=a.workspace_id AND wm.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
 LEFT JOIN office_artifact_grants g ON g.artifact_id=a.id AND g.user_id=wm.user_id AND g.revoked_at IS NULL
 WHERE a.id=artifact AND a.workspace_id=w AND a.mode='artifact' AND a.lifecycle_state='active'
 AND NOT scope_review_state_held('office_artifact',a.id) AND office_artifact_scope_allows(a.id,w,mutation)
 AND coalesce(g.role,CASE WHEN wm.user_id IN(a.creator_user_id,a.owner_user_id) THEN 'edit' ELSE a.default_workspace_role END)
 =ANY(CASE WHEN mutation THEN ARRAY['edit'] ELSE ARRAY['view','comment','edit'] END))
$$;
-- A retained binding makes generic file reads obey the live Office ACL, including
-- deletion (NULL parent is a denying tombstone). No owner shortcut.
CREATE TABLE office_generation_file_bindings (
 file_id uuid PRIMARY KEY REFERENCES workspace_files(id) ON DELETE CASCADE,
 artifact_id uuid REFERENCES office_artifacts(id) ON DELETE SET NULL,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 job_id uuid REFERENCES office_generation_jobs(id) ON DELETE SET NULL,
 snapshot_hash text NOT NULL
);
ALTER TABLE office_generation_file_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY office_output_binding_read ON office_generation_file_bindings FOR SELECT USING (
 office_generation_artifact_allows(artifact_id,workspace_id,false));
CREATE POLICY office_output_binding_insert ON office_generation_file_bindings FOR INSERT WITH CHECK (
 office_generation_artifact_allows(artifact_id,workspace_id,true) AND EXISTS (
 SELECT 1 FROM office_generation_jobs j WHERE j.id=job_id AND j.artifact_id=office_generation_file_bindings.artifact_id
 AND j.workspace_id=office_generation_file_bindings.workspace_id AND j.initiated_by_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid
 AND j.status='running' AND j.cancel_requested_at IS NULL AND j.lease_expires_at>clock_timestamp()));
-- An FK proves existence, not visibility or mutation authority. Validate the
-- actual file under the caller's RLS before installing a restrictive binding.
-- Invoker rights are intentional: a known foreign/private UUID is not evidence.
CREATE FUNCTION guard_office_generation_file_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 j office_generation_jobs; a office_artifacts; f workspace_files; parent text; filename text;
BEGIN
 PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id FOR UPDATE;
 SELECT * INTO j FROM office_generation_jobs WHERE id=NEW.job_id AND workspace_id=NEW.workspace_id FOR UPDATE;
 IF NOT FOUND OR actor IS NULL OR j.initiated_by_user_id IS DISTINCT FROM actor
   OR j.artifact_id IS DISTINCT FROM NEW.artifact_id OR j.status IS DISTINCT FROM 'running'
   OR j.job_kind IS DISTINCT FROM 'create' OR j.base_artifact_version IS DISTINCT FROM 0
   OR j.cancel_requested_at IS NOT NULL OR j.lease_expires_at IS NULL OR j.lease_expires_at<=clock_timestamp()
   OR j.authority_projection->'creationBinding'->>'protocol' IS DISTINCT FROM 'office_prompt_only_v1'
 THEN RAISE EXCEPTION 'office_output_binding_denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM office_artifacts WHERE id=NEW.artifact_id AND workspace_id=NEW.workspace_id FOR UPDATE;
 IF NOT FOUND OR a.head_version<>0 OR office_generation_artifact_allows(a.id,a.workspace_id,true) IS NOT TRUE
 THEN RAISE EXCEPTION 'office_output_binding_denied' USING ERRCODE='42501'; END IF;
 -- FOR UPDATE applies the file's SELECT/UPDATE RLS and holds its identity/scope
 -- stable until the file, binding, version and completion transaction commits.
 SELECT * INTO f FROM workspace_files WHERE id=NEW.file_id AND workspace_id=NEW.workspace_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'office_output_binding_denied' USING ERRCODE='42501'; END IF;
 parent:='/office/artifacts/'||a.id::text||'/versions';
 filename:='1-'||NEW.snapshot_hash||'.json';
 IF NEW.snapshot_hash !~ '^[0-9a-f]{64}$'
   OR f.path IS DISTINCT FROM parent||'/'||filename OR f.parent_path IS DISTINCT FROM parent OR f.name IS DISTINCT FROM filename
   OR f.metadata->>'officeGenerationJobId' IS DISTINCT FROM j.id::text
   OR f.metadata->>'contentSha256' IS DISTINCT FROM NEW.snapshot_hash OR f.metadata->>'noIndex' IS DISTINCT FROM 'true'
   OR f.mime IS DISTINCT FROM 'application/json' OR f.size_bytes<=0
   OR f.user_id IS NOT NULL OR f.assistant_id IS NOT NULL OR f.source_episode_id IS NOT NULL
   OR f.created_by_user_id IS DISTINCT FROM actor OR f.created_by_assistant_id IS NOT NULL
   OR f.sensitivity IS DISTINCT FROM a.sensitivity OR f.compartments IS DISTINCT FROM a.compartments OR f.project_ids IS DISTINCT FROM a.project_ids
   OR f.scope_held OR f.valid_to IS NOT NULL OR f.retracted_at IS NOT NULL
   OR member_operation_scope_allows(f.workspace_id,f.sensitivity,f.compartments,true) IS NOT TRUE
   OR agent_mutation_scope_allows(f.compartments) IS NOT TRUE
 THEN RAISE EXCEPTION 'office_output_binding_denied' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER office_output_binding_guard BEFORE INSERT ON office_generation_file_bindings
 FOR EACH ROW EXECUTE FUNCTION guard_office_generation_file_binding();
REVOKE ALL ON FUNCTION guard_office_generation_file_binding() FROM PUBLIC;
CREATE FUNCTION office_output_file_allows(f uuid, mutation boolean) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM office_generation_file_bindings WHERE file_id=f)
 OR (NOT mutation AND EXISTS(SELECT 1 FROM office_generation_file_bindings b JOIN office_artifacts a ON a.id=b.artifact_id AND a.workspace_id=b.workspace_id
 WHERE b.file_id=f AND a.lifecycle_state='active' AND NOT scope_review_state_held('office_artifact',a.id)
 AND office_generation_artifact_allows(a.id,a.workspace_id,false)))
$$;
CREATE POLICY office_output_read ON workspace_files AS RESTRICTIVE FOR SELECT USING(office_output_file_allows(id,false));
-- Published snapshots are immutable; generic file edit/delete cannot change a
-- version's bytes behind its hash. Office retention is a separate lifecycle.
CREATE POLICY office_output_update ON workspace_files AS RESTRICTIVE FOR UPDATE USING(office_output_file_allows(id,true));
CREATE POLICY office_output_delete ON workspace_files AS RESTRICTIVE FOR DELETE USING(office_output_file_allows(id,true));
-- Serialize ACL and source changes with publication's workspace-first lock,
-- including insertion when no grant/source row existed at the initial check.
CREATE FUNCTION lock_office_publication_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM workspaces WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END FOR UPDATE;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER office_publication_acl_lock BEFORE INSERT OR UPDATE OR DELETE ON office_artifact_grants
 FOR EACH ROW EXECUTE FUNCTION lock_office_publication_authority();
CREATE TRIGGER office_publication_sources_lock BEFORE INSERT OR UPDATE OR DELETE ON office_artifact_sources
 FOR EACH ROW EXECUTE FUNCTION lock_office_publication_authority();
REVOKE ALL ON FUNCTION lock_office_publication_authority() FROM PUBLIC;
-- Resume only jobs stopped by the previous deliberately missing adapter.
UPDATE office_generation_jobs j SET status='queued',stage='queued',error_code=NULL,error_detail=NULL,
 lease_token=NULL,lease_expires_at=NULL,next_attempt_at=now(),updated_at=now()
 WHERE status='needs_input' AND error_code='office_prompt_only_execution_adapter_required'
 AND authority_projection->'creationBinding'->>'protocol'='office_prompt_only_v1'
 AND cancel_requested_at IS NULL AND EXISTS(SELECT 1 FROM office_artifacts a WHERE a.id=j.artifact_id AND a.head_version=0);
COMMIT;
