BEGIN;

-- Pages carry their Team label through the linked Teamspace rather than a
-- row-local compartments array. Resolve that label here so every saved_views
-- command uses the same current read/mutation split as the canonical stores.
CREATE FUNCTION saved_view_operation_scope_allows(
  w uuid,
  page_sensitivity text,
  page_teamspace uuid,
  page_project uuid,
  mutation boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  teamspace_sensitivity text;
  compartment text;
  effective_sensitivity text:=page_sensitivity;
  compartments text[]:='{}';
  projects uuid[]:=CASE WHEN page_project IS NULL THEN '{}' ELSE ARRAY[page_project] END;
BEGIN
  IF page_teamspace IS NOT NULL THEN
    SELECT t.sensitivity,g.compartment_key
      INTO teamspace_sensitivity,compartment
      FROM teamspaces t
      LEFT JOIN workspace_groups g
        ON g.id=t.workspace_group_id AND g.workspace_id=t.workspace_id AND g.status='active'
     WHERE t.id=page_teamspace AND t.workspace_id=w;
    IF NOT FOUND THEN RETURN false; END IF;
    IF sensitivity_rank(teamspace_sensitivity)>sensitivity_rank(effective_sensitivity) THEN
      effective_sensitivity:=teamspace_sensitivity;
    END IF;
    IF compartment IS NOT NULL THEN compartments:=ARRAY[compartment]; END IF;
  END IF;

  RETURN member_operation_scope_allows(w,effective_sensitivity,compartments,mutation)
    AND agent_read_scope_allows(effective_sensitivity,compartments,projects)
    AND agent_visibility_allows(w,NULL,NULL)
    AND (NOT mutation OR agent_mutation_scope_allows(compartments));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

CREATE FUNCTION saved_view_principal_boundary_allows(
  w uuid,
  creator uuid,
  page_teamspace uuid,
  page_sensitivity text,
  page_project uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
DECLARE
  actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  linked_group uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w AND wm.user_id=actor) THEN
    RETURN false;
  END IF;
  IF page_teamspace IS NULL THEN RETURN creator=actor; END IF;
  SELECT t.workspace_group_id INTO linked_group FROM teamspaces t
    WHERE t.id=page_teamspace AND t.workspace_id=w;
  IF NOT FOUND THEN RETURN false; END IF;
  IF linked_group IS NOT NULL THEN
    RETURN saved_view_operation_scope_allows(w,page_sensitivity,page_teamspace,page_project,false);
  END IF;
  RETURN EXISTS(SELECT 1 FROM teamspace_members tm
    WHERE tm.teamspace_id=page_teamspace AND tm.user_id=actor)
    OR (nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL
      AND saved_view_operation_scope_allows(w,page_sensitivity,page_teamspace,page_project,false));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

CREATE FUNCTION saved_view_root_operation_scope_allows(p_page uuid, mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM saved_views sv WHERE sv.id=p_page
      AND saved_view_principal_boundary_allows(
        sv.workspace_id,sv.created_by,sv.teamspace_id,sv.clearance,sv.project_id)
      AND saved_view_operation_scope_allows(
        sv.workspace_id,sv.clearance,sv.teamspace_id,sv.project_id,mutation)
  )
$$;

-- Keep the creator-only private boundary and explicit membership for an
-- unlinked Teamspace. A linked Teamspace delegates human/agent admission to
-- the operation predicate so a current temporary read grant can see the row.
ALTER POLICY saved_views_workspace_member ON saved_views
  USING (saved_view_principal_boundary_allows(
    workspace_id,created_by,teamspace_id,clearance,project_id));

CREATE POLICY saved_view_operation_read ON saved_views AS RESTRICTIVE FOR SELECT
  USING (saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,false));
CREATE POLICY saved_view_operation_insert ON saved_views AS RESTRICTIVE FOR INSERT
  WITH CHECK (saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,true));
CREATE POLICY saved_view_operation_update ON saved_views AS RESTRICTIVE FOR UPDATE
  USING (saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,true))
  WITH CHECK (saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,true));
CREATE POLICY saved_view_operation_delete ON saved_views AS RESTRICTIVE FOR DELETE
  USING (saved_view_operation_scope_allows(workspace_id,clearance,teamspace_id,project_id,true));

-- Children must not inherit the root's read projection as write authority.
-- Doc-sync uses its owner connection only after the user/socket gate, while
-- ordinary app-role calls remain constrained here.
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['documents','page_grants','comment_threads','meeting_tag_state'] LOOP
    EXECUTE format('CREATE POLICY saved_view_child_read ON %I AS RESTRICTIVE FOR SELECT USING(saved_view_root_operation_scope_allows(page_id,false))',tab);
    EXECUTE format('CREATE POLICY saved_view_child_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK(saved_view_root_operation_scope_allows(page_id,true))',tab);
    EXECUTE format('CREATE POLICY saved_view_child_update ON %I AS RESTRICTIVE FOR UPDATE USING(saved_view_root_operation_scope_allows(page_id,true)) WITH CHECK(saved_view_root_operation_scope_allows(page_id,true))',tab);
    EXECUTE format('CREATE POLICY saved_view_child_delete ON %I AS RESTRICTIVE FOR DELETE USING(saved_view_root_operation_scope_allows(page_id,true))',tab);
  END LOOP;
END $$;

COMMIT;
