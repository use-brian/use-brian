BEGIN;

-- Office roots, children, source floors and library dependencies use the same v2
-- department predicate. Legacy workspace roles cannot bypass membership edges.
CREATE OR REPLACE FUNCTION office_labels_scope_allows(w uuid, sensitivity text, compartments text[], projects uuid[],
  visible_users uuid[], visible_assistants uuid[], mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid=nullif(current_setting('app.current_user_id',true),'')::uuid;
  bound_actor text=nullif(current_setting('app.agent_actor_id',true),'');
  grants jsonb;
  assistant_grant jsonb=nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM workspaces WHERE id=w AND department_read_v2) THEN
    grants=department_read_grants();
    IF NOT (grants ? w::text) OR NOT department_row_allows(grants,w,sensitivity,compartments,NULL::uuid)
      OR NOT agent_read_scope_allows('public','{}',projects)
      OR NOT agent_visibility_allows(w,NULL,NULL) THEN RETURN false; END IF;
    -- A legacy assistant wrapper may carry only the older execution GUCs.
    -- Absence of a v2 assistant identity must not erase that narrower ceiling.
    IF nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL
      AND nullif(current_setting('app.v2_assistant_id',true),'') IS NULL THEN
      IF NOT agent_read_scope_allows(sensitivity,compartments,projects)
        OR (mutation AND NOT agent_mutation_scope_allows(compartments)) THEN RETURN false; END IF;
    END IF;
  ELSE
    IF NOT member_operation_scope_allows(w,sensitivity,compartments,mutation)
      OR NOT agent_read_scope_allows(sensitivity,compartments,projects)
      OR NOT agent_visibility_allows(w,NULL,NULL)
      OR (mutation AND NOT agent_mutation_scope_allows(compartments)) THEN RETURN false; END IF;
  END IF;
  IF cardinality(visible_users)>0 AND (
    NOT actor=ANY(visible_users)
    OR (bound_actor IS NOT NULL AND NOT bound_actor=ANY(visible_users::text[]))
  ) THEN RETURN false; END IF;
  IF cardinality(visible_assistants)>0 AND nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL THEN
    IF assistant_grant IS NULL THEN RETURN false; END IF;
    IF assistant_grant<>'null'::jsonb THEN
      IF jsonb_typeof(assistant_grant)<>'array' THEN RETURN false; END IF;
      IF NOT EXISTS(SELECT 1 FROM unnest(visible_assistants) id WHERE assistant_grant ? id::text) THEN RETURN false; END IF;
    END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

-- A file's old labels must not outlive a restriction placed on its Office root.
-- Resources and source files are independent inputs, not generated snapshots.
CREATE FUNCTION office_canonical_file_scope_allows(file uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS (
   SELECT 1 FROM (
     SELECT artifact_id FROM office_artifact_versions WHERE snapshot_file_id=file
     UNION SELECT artifact_id FROM office_release_records WHERE released_file_id=file
     UNION SELECT artifact_id FROM office_offline_packages WHERE package_file_id=file
     UNION SELECT artifact_id FROM office_comment_threads WHERE target_snapshot_file_id=file
   ) roots JOIN office_artifacts a ON a.id=roots.artifact_id
   WHERE NOT office_anchor_file_scope_allows(a.workspace_id,'/office/anchors/'||a.id::text||'/scope',false)
 )
$$;
CREATE POLICY office_canonical_file_read ON workspace_files AS RESTRICTIVE FOR SELECT
 USING (office_canonical_file_scope_allows(id));
CREATE FUNCTION revoke_office_classification_offline() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.sensitivity IS DISTINCT FROM NEW.sensitivity OR OLD.compartments IS DISTINCT FROM NEW.compartments
   OR OLD.project_ids IS DISTINCT FROM NEW.project_ids THEN
   UPDATE office_offline_packages SET revoked_at=coalesce(revoked_at,now()),complete=false,updated_at=now() WHERE artifact_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER office_classification_offline AFTER UPDATE OF sensitivity,compartments,project_ids ON office_artifacts
 FOR EACH ROW EXECUTE FUNCTION revoke_office_classification_offline();
REVOKE ALL ON FUNCTION revoke_office_classification_offline() FROM PUBLIC;
COMMIT;
