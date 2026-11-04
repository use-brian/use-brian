-- [COMP:recordings/recovery] Fresh derivation, never a hold release.
BEGIN;
-- A tombstone reference deliberately has no FK: deleting a recovered recording
-- must neither block erasure nor make the old failed recording current again.
ALTER TABLE recording_intake_bindings ADD COLUMN superseded_by uuid;
ALTER TABLE recording_intake_bindings DROP CONSTRAINT recording_intake_bindings_file_id_key;
CREATE UNIQUE INDEX recording_intake_current_file ON recording_intake_bindings(file_id)
 WHERE superseded_by IS NULL;

CREATE OR REPLACE FUNCTION publish_file_recording(expected jsonb,requested_id uuid,requested_kind text) RETURNS SETOF recordings
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f workspace_files; r recordings; b recording_intake_bindings; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; key text;
BEGIN
 IF requested_kind IS NOT NULL AND requested_kind NOT IN ('memo','meeting') THEN RAISE EXCEPTION 'recording_kind_invalid'; END IF;
 f:=media_intake_source((expected->>'workspaceId')::uuid,(expected->>'resourceId')::uuid,expected);
 IF f.mime NOT LIKE 'audio/%' AND f.mime NOT LIKE 'video/%' THEN RAISE EXCEPTION 'recording_media_required'; END IF;
 SELECT * INTO b FROM recording_intake_bindings WHERE file_id=f.id AND superseded_by IS NULL;
 IF FOUND THEN
  SELECT * INTO r FROM recordings WHERE id=b.recording_id AND workspace_id=f.workspace_id;
  IF b.file_version IS DISTINCT FROM expected->>'version' OR r.scope_held OR r.valid_to IS NOT NULL OR r.retracted_at IS NOT NULL
    OR scope_review_state_held('recording',r.id) OR NOT EXISTS(SELECT 1 FROM scope_derivations WHERE resource_kind='recording' AND resource_id=r.id AND resource_version=r.scope_version::text) THEN RAISE EXCEPTION 'recording_intake_source_changed'; END IF;
  IF requested_kind IS NOT NULL AND requested_kind IS DISTINCT FROM r.kind THEN RAISE EXCEPTION 'recording_kind_conflict'; END IF;
  RETURN NEXT r; RETURN;
 END IF;
 -- Only canonical storage locations, never a caller-supplied gcsKey/source_ref.
 IF f.storage_uri !~ '^(gs|s3|az|file)://' THEN RAISE EXCEPTION 'recording_storage_binding_required'; END IF;
 IF f.storage_uri ~ '^file:///' THEN
  key:=substring(f.storage_uri FROM '/([^/]+/[^/]+)$');
 ELSE key:=regexp_replace(f.storage_uri,'^[a-z]+://[^/]+/',''); END IF;
 IF key IS NULL OR key='' OR key=f.storage_uri THEN RAISE EXCEPTION 'recording_storage_binding_required'; END IF;
 PERFORM set_config('app.media_intake_parent',expected::text,true);
 INSERT INTO episodes(id,workspace_id,source_kind,source_ref,occurred_at,user_id,assistant_id,sensitivity,compartments,project_ids,created_by_user_id)
 VALUES(requested_id,f.workspace_id,'recording',jsonb_build_object('fileId',f.id,'gcsKey',key,'storageUri',f.storage_uri,'mime',f.mime,'fileName',f.name),now(),f.user_id,f.assistant_id,f.sensitivity,f.compartments,f.project_ids,actor);
 INSERT INTO recordings(id,workspace_id,mime,gcs_key,storage_uri,file_name,title,bytes,media_file_id,user_id,assistant_id,sensitivity,compartments,project_ids,created_by_user_id,kind)
 VALUES(requested_id,f.workspace_id,f.mime,key,f.storage_uri,f.name,coalesce(f.title,f.name),f.size_bytes,f.id,f.user_id,f.assistant_id,f.sensitivity,f.compartments,f.project_ids,actor,coalesce(requested_kind,'memo')) RETURNING * INTO r;
 INSERT INTO recording_intake_bindings(recording_id,workspace_id,file_id,file_version) VALUES(r.id,f.workspace_id,f.id,expected->>'version');
 PERFORM record_media_lineage(f.workspace_id,'episode',r.id,'workspace_file',f.id,expected->>'version');
 PERFORM record_media_lineage(f.workspace_id,'recording',r.id,'workspace_file',f.id,expected->>'version');
 PERFORM record_media_lineage(f.workspace_id,'recording',r.id,'episode',r.id,(read_scope_source(f.workspace_id,'episode',r.id))->>'version');
 PERFORM set_config('app.media_intake_parent','',true);
 RETURN NEXT r;
END $$;


-- Exposes a locator only after validating the current source and the old
-- audience. Held content, old metadata and storage pointers never leave here.
CREATE FUNCTION read_recording_recovery_source(w uuid,i uuid)
RETURNS TABLE(file_id uuid,replacement_id uuid,kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b recording_intake_bindings; r recordings; e episodes; f workspace_files; s jsonb;
BEGIN
 PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE;
 SELECT * INTO b FROM recording_intake_bindings WHERE recording_id=i AND workspace_id=w;
 IF NOT FOUND THEN RAISE EXCEPTION 'recording_recovery_unavailable'; END IF;
 s:=read_entity_derivation_source(w,'workspace_file',b.file_id);
 IF s IS NULL THEN RAISE EXCEPTION 'recording_recovery_unavailable'; END IF;
 f:=media_intake_source(w,b.file_id,s||jsonb_build_object('resourceKind','workspace_file'));
 SELECT * INTO r FROM recordings WHERE id=i AND workspace_id=w;
 SELECT * INTO e FROM episodes WHERE id=i AND workspace_id=w;
 IF r.id IS NULL OR e.id IS NULL OR e.source_kind<>'recording' OR r.status<>'failed' OR NOT r.scope_held
  OR r.valid_to IS NOT NULL OR r.retracted_at IS NOT NULL
  OR b.file_version IS DISTINCT FROM f.scope_version::text
  OR ROW(r.user_id,r.assistant_id,r.sensitivity,r.compartments,r.project_ids)
     IS DISTINCT FROM ROW(f.user_id,f.assistant_id,f.sensitivity,f.compartments,f.project_ids)
  OR ROW(e.user_id,e.assistant_id,e.sensitivity,e.compartments,e.project_ids)
     IS DISTINCT FROM ROW(f.user_id,f.assistant_id,f.sensitivity,f.compartments,f.project_ids)
  OR scope_review_state_held('recording',i) OR scope_review_state_held('episode',i)
  OR r.transcript_file_id IS NOT NULL
  OR EXISTS(SELECT 1 FROM transcript_segments WHERE recording_id=i)
  OR EXISTS(SELECT 1 FROM recording_jobs WHERE recording_id=i AND status IN ('pending','processing','done'))
 THEN RAISE EXCEPTION 'recording_recovery_unavailable'; END IF;
 RETURN QUERY SELECT b.file_id,b.superseded_by,r.kind;
END $$;
REVOKE ALL ON FUNCTION read_recording_recovery_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_recording_recovery_source(uuid,uuid) TO app_user;

CREATE FUNCTION recover_file_recording(expected jsonb,old_id uuid,new_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source record; f workspace_files; fresh recordings; replacement_scope jsonb;
BEGIN
 SELECT * INTO source FROM read_recording_recovery_source((expected->>'workspaceId')::uuid,old_id);
 IF source.file_id IS DISTINCT FROM (expected->>'resourceId')::uuid THEN RAISE EXCEPTION 'recording_recovery_unavailable'; END IF;
 f:=media_intake_source((expected->>'workspaceId')::uuid,source.file_id,expected);
 IF source.replacement_id IS NOT NULL THEN
  -- Re-admit the replacement, even for a repeated preparation request.
  replacement_scope:=read_entity_derivation_source(f.workspace_id,'recording',source.replacement_id);
  IF replacement_scope IS NULL OR replacement_scope->>'held' IS DISTINCT FROM 'false'
   OR replacement_scope->>'validTo' IS NOT NULL OR replacement_scope->>'retractedAt' IS NOT NULL
   OR scope_review_state_held('recording',source.replacement_id)
   THEN RAISE EXCEPTION 'recording_recovery_unavailable'; END IF;
  RETURN source.replacement_id;
 END IF;
 UPDATE recording_intake_bindings SET superseded_by=new_id WHERE recording_id=old_id;
 SELECT * INTO fresh FROM publish_file_recording(expected,new_id,source.kind);
 IF fresh.id IS DISTINCT FROM new_id THEN RAISE EXCEPTION 'recording_recovery_unavailable'; END IF;
 RETURN fresh.id;
END $$;
REVOKE ALL ON FUNCTION recover_file_recording(jsonb,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recover_file_recording(jsonb,uuid,uuid) TO app_user;

-- Queue admission uses the same workspace lock as recovery. An enqueue that
-- wins first blocks recovery; a recovery that wins first blocks stale enqueue.
CREATE FUNCTION guard_superseded_recording_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM workspaces WHERE id=NEW.workspace_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM recording_intake_bindings WHERE recording_id=NEW.recording_id AND (workspace_id<>NEW.workspace_id OR superseded_by IS NOT NULL))
 THEN RAISE EXCEPTION 'recording_superseded'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_superseded_recording_job() FROM PUBLIC;
CREATE TRIGGER recording_job_current_binding BEFORE INSERT ON recording_jobs
 FOR EACH ROW EXECUTE FUNCTION guard_superseded_recording_job();
COMMIT;
