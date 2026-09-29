BEGIN;

-- Keep immutable draft anchors behind their Office root even when a caller
-- reaches them through generic file-by-ID reads. Ordinary files are unchanged.
CREATE FUNCTION office_anchor_file_scope_allows(w uuid, file_path text, mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE artifact uuid; actor uuid=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
  IF file_path NOT LIKE '/office/anchors/%' THEN RETURN true; END IF;
  IF file_path !~ '^/office/anchors/[0-9a-f-]{36}/[^/]+$' THEN RETURN false; END IF;
  artifact=split_part(file_path,'/',4)::uuid;
  RETURN EXISTS (
    SELECT 1 FROM office_artifacts a
    JOIN workspace_members wm ON wm.workspace_id=a.workspace_id AND wm.user_id=actor
    LEFT JOIN office_artifact_grants g ON g.artifact_id=a.id AND g.user_id=actor AND g.revoked_at IS NULL
    WHERE a.id=artifact AND a.workspace_id=w AND a.mode IN ('artifact','template')
      AND a.lifecycle_state<>'purged'
      AND (a.lifecycle_state<>'retained' OR wm.role IN ('owner','admin'))
      AND office_artifact_scope_allows(a.id,w,mutation)
      AND COALESCE(g.role,CASE WHEN actor IN (a.creator_user_id,a.owner_user_id) THEN 'edit' ELSE a.default_workspace_role END)
        =ANY(CASE WHEN mutation THEN ARRAY['comment','edit'] ELSE ARRAY['view','comment','edit'] END)
      AND (NOT mutation OR a.lifecycle_state='active')
  );
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

CREATE POLICY office_anchor_read ON workspace_files AS RESTRICTIVE FOR SELECT
  USING (office_anchor_file_scope_allows(workspace_id,path,false));
CREATE POLICY office_anchor_insert ON workspace_files AS RESTRICTIVE FOR INSERT
  WITH CHECK (office_anchor_file_scope_allows(workspace_id,path,true));
CREATE POLICY office_anchor_update ON workspace_files AS RESTRICTIVE FOR UPDATE
  USING (office_anchor_file_scope_allows(workspace_id,path,true)
    AND (path NOT LIKE '/office/anchors/%' OR NOT EXISTS (
      SELECT 1 FROM office_artifact_versions v WHERE v.snapshot_file_id=workspace_files.id)))
  WITH CHECK (office_anchor_file_scope_allows(workspace_id,path,true));
CREATE POLICY office_anchor_delete ON workspace_files AS RESTRICTIVE FOR DELETE
  USING (office_anchor_file_scope_allows(workspace_id,path,true)
    AND (path NOT LIKE '/office/anchors/%' OR NOT EXISTS (
      SELECT 1 FROM office_artifact_versions v WHERE v.snapshot_file_id=workspace_files.id)));

COMMIT;
