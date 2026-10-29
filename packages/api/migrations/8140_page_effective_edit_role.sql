-- Spec: docs/architecture/features/doc.md, authenticated Page mutation authority.
-- [COMP:api/saved-views-store] Current Page role, independent of read/scope admission.
BEGIN;

CREATE FUNCTION public.saved_view_effective_role(p_page uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE
  actor uuid;
  effective_role text;
BEGIN
  actor := nullif(pg_catalog.current_setting('app.current_user_id',true),'')::uuid;
  -- Missing/hidden pages are indistinguishable, including to direct callers.
  -- The existing read predicate retains private, Team, Project and agent gates.
  IF actor IS NULL OR public.saved_view_root_operation_scope_allows(p_page,false) IS NOT TRUE THEN
    RETURN NULL;
  END IF;

  SELECT pg.role INTO effective_role
    FROM public.page_grants pg
   WHERE pg.page_id=p_page
     AND pg.revoked_at IS NULL
     AND (pg.expires_at IS NULL OR pg.expires_at>pg_catalog.now())
     AND (
       (pg.principal_type='user' AND pg.principal_ref=actor::text)
       OR (pg.principal_type='group' AND pg.principal_ref IN (
         SELECT gm.group_id::text
           FROM public.workspace_group_members gm
           JOIN public.workspace_groups g ON g.id=gm.group_id
           JOIN public.workspace_members wm ON wm.workspace_id=g.workspace_id AND wm.user_id=actor
          WHERE gm.user_id=actor
            -- Reproduce the group membership/directory RLS used by doc-sync's
            -- former invoker query. Do not widen hidden Department principals
            -- or invent a new equality between the page and group workspace.
            AND public.can_view_department_directory(g.workspace_id,g.id)
       ))
       OR pg.principal_type='workspace'
     )
   ORDER BY CASE pg.principal_type WHEN 'user' THEN 0 WHEN 'group' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END
   -- Existing equal-priority group ties remain unspecified.
   LIMIT 1;

  IF NOT FOUND THEN RETURN 'edit'; END IF;
  RETURN CASE WHEN effective_role IN ('view','comment','edit','full') THEN effective_role ELSE 'view' END;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END;
$$;

CREATE FUNCTION public.saved_view_edit_operation_scope_allows(p_page uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
BEGIN
  IF public.saved_view_effective_role(p_page) IN ('edit','full') THEN
    RETURN public.saved_view_root_operation_scope_allows(p_page,true) IS TRUE;
  END IF;
  RETURN false;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.saved_view_effective_role(uuid),public.saved_view_edit_operation_scope_allows(uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
    GRANT EXECUTE ON FUNCTION public.saved_view_effective_role(uuid),public.saved_view_edit_operation_scope_allows(uuid) TO app_user;
  END IF;
END $$;

-- Add role floors only at Page mutation boundaries. In particular, comments
-- and sharing keep their existing child authority, and new saved_views INSERT
-- does not ask a STABLE resolver to find a not-yet-visible row.
CREATE POLICY saved_view_edit_role_update ON public.saved_views AS RESTRICTIVE FOR UPDATE
  USING(public.saved_view_edit_operation_scope_allows(id))
  WITH CHECK(public.saved_view_edit_operation_scope_allows(id));
CREATE POLICY saved_view_edit_role_delete ON public.saved_views AS RESTRICTIVE FOR DELETE
  USING(public.saved_view_edit_operation_scope_allows(id));
CREATE POLICY document_edit_role_insert ON public.documents AS RESTRICTIVE FOR INSERT
  WITH CHECK(public.saved_view_edit_operation_scope_allows(page_id));
CREATE POLICY document_edit_role_update ON public.documents AS RESTRICTIVE FOR UPDATE
  USING(public.saved_view_edit_operation_scope_allows(page_id))
  WITH CHECK(public.saved_view_edit_operation_scope_allows(page_id));
CREATE POLICY document_edit_role_delete ON public.documents AS RESTRICTIVE FOR DELETE
  USING(public.saved_view_edit_operation_scope_allows(page_id));
COMMIT;
