BEGIN;

-- Resolve the current durable-file boundary inside the same database operation.
-- Office library metadata must not become an alternate route around file scope.
CREATE FUNCTION office_library_file_scope_allows(file uuid,w uuid,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM workspace_files f WHERE f.id=file AND f.workspace_id=w
    AND f.valid_to IS NULL AND f.retracted_at IS NULL AND NOT f.scope_held
    AND office_labels_scope_allows(w,f.sensitivity,f.compartments,f.project_ids,
      CASE WHEN f.user_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[f.user_id] END,
      CASE WHEN f.assistant_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[f.assistant_id] END,mutation)
    AND (f.assistant_id IS NULL OR nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL)
    AND agent_visibility_allows(w,f.user_id,f.assistant_id))
$$;

CREATE FUNCTION office_resource_row_scope_allows(w uuid,sensitivity text,file uuid,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT office_labels_scope_allows(w,sensitivity,'{}','{}','{}','{}',mutation)
    AND (file IS NULL OR office_library_file_scope_allows(file,w,mutation))
$$;
CREATE FUNCTION office_resource_scope_allows(resource uuid,w uuid,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM office_resources r WHERE r.id=resource AND r.workspace_id=w
    AND office_resource_row_scope_allows(w,r.sensitivity,r.file_id,mutation))
$$;

CREATE FUNCTION office_template_row_scope_allows(template uuid,w uuid,sensitivity text,visible_users uuid[],
  draft uuid,current_version uuid,replacement uuid,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT office_labels_scope_allows(w,sensitivity,'{}','{}',visible_users,'{}',mutation)
    AND (draft IS NULL OR EXISTS(SELECT 1 FROM office_artifacts a WHERE a.id=draft AND a.workspace_id=w
      AND a.mode='template' AND office_artifact_scope_allows(a.id,w,mutation)))
    AND (current_version IS NULL OR EXISTS(SELECT 1 FROM office_template_versions v
      WHERE v.id=current_version AND v.template_id=template AND v.workspace_id=w))
    AND (replacement IS NULL OR EXISTS(SELECT 1 FROM office_templates t WHERE t.id=replacement AND t.workspace_id=w))
    AND NOT EXISTS(SELECT 1 FROM office_template_versions v WHERE v.template_id=template AND
      (v.workspace_id<>w OR NOT office_library_file_scope_allows(v.bundle_file_id,w,mutation)
        OR (v.parent_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM office_template_versions p
          WHERE p.id=v.parent_version_id AND p.template_id=template AND p.workspace_id=w))
        OR (v.source_artifact_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM office_artifact_versions a
          WHERE a.id=v.source_artifact_version_id AND a.workspace_id=w
            AND (draft IS NULL OR a.artifact_id=draft)
            AND office_artifact_scope_allows(a.artifact_id,w,mutation)
            AND office_library_file_scope_allows(a.snapshot_file_id,w,mutation)))
        OR EXISTS(SELECT 1 FROM office_template_resource_refs r WHERE r.template_version_id=v.id
          AND (r.workspace_id<>w OR NOT office_resource_scope_allows(r.resource_id,w,mutation)))))
$$;
CREATE FUNCTION office_template_scope_allows(template uuid,w uuid,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM office_templates t WHERE t.id=template AND t.workspace_id=w
    AND office_template_row_scope_allows(t.id,w,t.sensitivity,t.visibility_user_ids,
      t.draft_artifact_id,t.current_version_id,t.replacement_template_id,mutation))
$$;
CREATE FUNCTION office_template_version_scope_allows(version_id uuid,w uuid,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM office_template_versions v WHERE v.id=version_id AND v.workspace_id=w
    AND office_template_scope_allows(v.template_id,w,mutation))
$$;

CREATE OR REPLACE FUNCTION office_audit_scope_allows(artifact uuid,w uuid,metadata jsonb,mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF artifact IS NOT NULL THEN RETURN office_artifact_scope_allows(artifact,w,mutation); END IF;
  IF metadata->>'templateId' IS NULL THEN RETURN false; END IF;
  RETURN office_template_scope_allows((metadata->>'templateId')::uuid,w,mutation);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

DO $$ DECLARE tab text; read_check text; write_check text; BEGIN
  FOREACH tab IN ARRAY ARRAY['office_templates','office_template_versions','office_resources','office_template_resource_refs'] LOOP
    read_check=CASE tab
      WHEN 'office_templates' THEN 'office_template_row_scope_allows(id,workspace_id,sensitivity,visibility_user_ids,draft_artifact_id,current_version_id,replacement_template_id,false)'
      WHEN 'office_template_versions' THEN 'office_template_scope_allows(template_id,workspace_id,false) AND office_library_file_scope_allows(bundle_file_id,workspace_id,false)'
      WHEN 'office_resources' THEN 'office_resource_row_scope_allows(workspace_id,sensitivity,file_id,false)'
      ELSE 'office_template_version_scope_allows(template_version_id,workspace_id,false) AND office_resource_scope_allows(resource_id,workspace_id,false)' END;
    write_check=replace(read_check,',false)',',true)');
    EXECUTE format('CREATE POLICY office_library_read ON %I AS RESTRICTIVE FOR SELECT USING(%s)',tab,read_check);
    EXECUTE format('CREATE POLICY office_library_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK(%s)',tab,write_check);
    EXECUTE format('CREATE POLICY office_library_update ON %I AS RESTRICTIVE FOR UPDATE USING(%s) WITH CHECK(%s)',tab,write_check,write_check);
    EXECUTE format('CREATE POLICY office_library_delete ON %I AS RESTRICTIVE FOR DELETE USING(%s)',tab,write_check);
  END LOOP;
END $$;

-- Workspace/root identity is not inferred from caller membership. Even a user
-- admitted to both workspaces cannot create a cross-workspace reference.
CREATE FUNCTION guard_office_library_references() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE valid boolean=true;
BEGIN
  IF TG_TABLE_NAME='office_templates' THEN
    valid=(NEW.draft_artifact_id IS NULL OR EXISTS(SELECT 1 FROM office_artifacts a
      WHERE a.id=NEW.draft_artifact_id AND a.workspace_id=NEW.workspace_id AND a.mode='template'))
      AND (NEW.current_version_id IS NULL OR EXISTS(SELECT 1 FROM office_template_versions v
        WHERE v.id=NEW.current_version_id AND v.workspace_id=NEW.workspace_id AND v.template_id=NEW.id))
      AND (NEW.replacement_template_id IS NULL OR EXISTS(SELECT 1 FROM office_templates t
        WHERE t.id=NEW.replacement_template_id AND t.workspace_id=NEW.workspace_id));
  ELSIF TG_TABLE_NAME='office_template_versions' THEN
    valid=EXISTS(SELECT 1 FROM office_templates t WHERE t.id=NEW.template_id AND t.workspace_id=NEW.workspace_id
      AND (NEW.source_artifact_version_id IS NULL OR EXISTS(SELECT 1 FROM office_artifact_versions v
        WHERE v.id=NEW.source_artifact_version_id AND v.workspace_id=NEW.workspace_id
          AND (t.draft_artifact_id IS NULL OR v.artifact_id=t.draft_artifact_id))))
      AND EXISTS(SELECT 1 FROM workspace_files f WHERE f.id=NEW.bundle_file_id AND f.workspace_id=NEW.workspace_id)
      AND (NEW.parent_version_id IS NULL OR EXISTS(SELECT 1 FROM office_template_versions p
        WHERE p.id=NEW.parent_version_id AND p.template_id=NEW.template_id AND p.workspace_id=NEW.workspace_id));
  ELSIF TG_TABLE_NAME='office_resources' THEN
    valid=NEW.file_id IS NULL OR EXISTS(SELECT 1 FROM workspace_files f WHERE f.id=NEW.file_id AND f.workspace_id=NEW.workspace_id);
  ELSIF TG_TABLE_NAME='office_template_resource_refs' THEN
    valid=EXISTS(SELECT 1 FROM office_template_versions v WHERE v.id=NEW.template_version_id AND v.workspace_id=NEW.workspace_id)
      AND EXISTS(SELECT 1 FROM office_resources r WHERE r.id=NEW.resource_id AND r.workspace_id=NEW.workspace_id);
  END IF;
  IF NOT valid THEN RAISE EXCEPTION 'office_reference_scope_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER office_template_reference_guard BEFORE INSERT OR UPDATE ON office_templates
  FOR EACH ROW EXECUTE FUNCTION guard_office_library_references();
CREATE TRIGGER office_template_version_reference_guard BEFORE INSERT OR UPDATE ON office_template_versions
  FOR EACH ROW EXECUTE FUNCTION guard_office_library_references();
CREATE TRIGGER office_resource_reference_guard BEFORE INSERT OR UPDATE ON office_resources
  FOR EACH ROW EXECUTE FUNCTION guard_office_library_references();
CREATE TRIGGER office_template_resource_reference_guard BEFORE INSERT OR UPDATE ON office_template_resource_refs
  FOR EACH ROW EXECUTE FUNCTION guard_office_library_references();

COMMIT;
