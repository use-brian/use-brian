BEGIN;
-- [COMP:api/workflow-input-evidence] Additional ancestry gate, never a grant.
CREATE FUNCTION derived_page_scope_visible(w uuid,k text,i uuid,v text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source jsonb; admitted jsonb;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN RETURN false; END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(read_resource_page_dependencies(w,k,i,v)) LOOP
  admitted:=read_page_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);
  IF admitted IS NULL OR admitted->>'version' IS DISTINCT FROM source->>'version' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR raise_exception THEN RETURN false;
END $$;
CREATE POLICY workspace_files_page_ancestry ON workspace_files AS RESTRICTIVE FOR ALL
 USING(derived_page_scope_visible(workspace_id,'workspace_file',id,scope_version::text))
 WITH CHECK(derived_page_scope_visible(workspace_id,'workspace_file',id,scope_version::text));
CREATE POLICY file_segments_page_parent ON file_segments AS RESTRICTIVE FOR ALL
 USING(EXISTS(SELECT 1 FROM workspace_files f WHERE f.workspace_id=file_segments.workspace_id AND f.id=file_segments.file_id))
 WITH CHECK(EXISTS(SELECT 1 FROM workspace_files f WHERE f.workspace_id=file_segments.workspace_id AND f.id=file_segments.file_id));
COMMIT;
