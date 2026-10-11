BEGIN;

-- A published template is a read source, not something the requester edits.
-- Ordinary row-locking SELECTs also apply UPDATE RLS and can silently omit a
-- readable source. This bounded helper acquires read-source locks only after
-- checking the exact initiating user's draft and every existing read predicate.
CREATE FUNCTION lock_office_generation_template_source(artifact uuid,job uuid,version_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  w uuid; template uuid; draft uuid; file uuid; format text;
BEGIN
  SELECT a.workspace_id,a.family INTO w,format FROM office_artifacts a
    JOIN office_generation_jobs j ON j.artifact_id=a.id AND j.workspace_id=a.workspace_id
    WHERE a.id=artifact AND j.id=job AND j.initiated_by_user_id=actor
      AND a.mode='artifact' AND a.lifecycle_state='active' AND a.head_version=0
      AND j.job_kind='create' AND j.status='needs_input' AND j.error_code='template_ambiguous'
      AND j.cancel_requested_at IS NULL AND office_generation_artifact_allows(a.id,a.workspace_id,true);
  IF w IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=w AND setup_state<>'legacy')
    OR NOT office_template_version_scope_allows(version_id,w,false) THEN RETURN false; END IF;
  SELECT t.id,t.draft_artifact_id,v.bundle_file_id INTO template,draft,file
    FROM office_templates t JOIN office_template_versions v ON v.template_id=t.id AND v.workspace_id=t.workspace_id
    WHERE v.id=version_id AND t.workspace_id=w AND t.family=format
      AND t.lifecycle_state='admitted' AND v.status='admitted' AND t.current_version_id=v.id;
  IF template IS NULL OR draft IS NULL OR file IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM office_templates WHERE id=template FOR SHARE;
  PERFORM 1 FROM office_template_versions WHERE id=version_id FOR SHARE;
  PERFORM 1 FROM office_artifacts WHERE id=draft AND workspace_id=w AND mode='template' AND lifecycle_state='active' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM workspace_files WHERE id=file AND workspace_id=w FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN office_template_version_scope_allows(version_id,w,false)
    AND EXISTS(SELECT 1 FROM office_templates t JOIN office_template_versions v ON v.template_id=t.id
      WHERE t.id=template AND t.current_version_id=version_id AND t.lifecycle_state='admitted'
        AND t.draft_artifact_id=draft AND v.id=version_id AND v.bundle_file_id=file AND v.status='admitted');
END $$;

COMMIT;
