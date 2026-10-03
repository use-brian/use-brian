BEGIN;
-- A recording's kind (memo | meeting) routes the transcriber ladder and is a
-- semantic column (media_semantic_row keeps it), so setting it AFTER
-- publication bumps scope_version past the lineage publish_file_recording
-- recorded and the later segment publication refuses the recording as
-- `recording_intake_source_changed`. Kind is therefore chosen at birth, in the
-- same INSERT that records lineage. The body is 643's verbatim apart from the
-- kind column; the two-argument call keeps its 'memo' default.
DROP FUNCTION publish_file_recording(jsonb,uuid);
CREATE FUNCTION publish_file_recording(expected jsonb,requested_id uuid,requested_kind text DEFAULT 'memo') RETURNS SETOF recordings
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f workspace_files; r recordings; b recording_intake_bindings; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; key text;
BEGIN
 IF requested_kind IS NULL OR requested_kind NOT IN ('memo','meeting') THEN RAISE EXCEPTION 'recording_kind_invalid'; END IF;
 f:=media_intake_source((expected->>'workspaceId')::uuid,(expected->>'resourceId')::uuid,expected);
 IF f.mime NOT LIKE 'audio/%' AND f.mime NOT LIKE 'video/%' THEN RAISE EXCEPTION 'recording_media_required'; END IF;
 SELECT * INTO b FROM recording_intake_bindings WHERE file_id=f.id;
 IF FOUND THEN
  SELECT * INTO r FROM recordings WHERE id=b.recording_id AND workspace_id=f.workspace_id;
  IF b.file_version IS DISTINCT FROM expected->>'version' OR r.scope_held OR r.valid_to IS NOT NULL OR r.retracted_at IS NOT NULL
    OR scope_review_state_held('recording',r.id) OR NOT EXISTS(SELECT 1 FROM scope_derivations WHERE resource_kind='recording' AND resource_id=r.id AND resource_version=r.scope_version::text) THEN RAISE EXCEPTION 'recording_intake_source_changed'; END IF;
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
 INSERT INTO recordings(id,workspace_id,kind,mime,gcs_key,storage_uri,file_name,title,bytes,media_file_id,user_id,assistant_id,sensitivity,compartments,project_ids,created_by_user_id)
 VALUES(requested_id,f.workspace_id,requested_kind,f.mime,key,f.storage_uri,f.name,coalesce(f.title,f.name),f.size_bytes,f.id,f.user_id,f.assistant_id,f.sensitivity,f.compartments,f.project_ids,actor) RETURNING * INTO r;
 INSERT INTO recording_intake_bindings VALUES(r.id,f.workspace_id,f.id,expected->>'version');
 PERFORM record_media_lineage(f.workspace_id,'episode',r.id,'workspace_file',f.id,expected->>'version');
 PERFORM record_media_lineage(f.workspace_id,'recording',r.id,'workspace_file',f.id,expected->>'version');
 PERFORM record_media_lineage(f.workspace_id,'recording',r.id,'episode',r.id,(read_scope_source(f.workspace_id,'episode',r.id))->>'version');
 PERFORM set_config('app.media_intake_parent','',true);
 RETURN NEXT r;
END $$;
COMMIT;
