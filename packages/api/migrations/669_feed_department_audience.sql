BEGIN;
-- [COMP:feed/source-authority] Explicit selected-resource audience, not ambient access.
CREATE FUNCTION feed_member_source_allows(p_workspace uuid, p_actor uuid, p_tier text, p_compartments text[], p_row_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT coalesce((SELECT CASE WHEN wk.department_read_v2 THEN
    department_row_allows(jsonb_build_object(p_workspace::text,jsonb_build_object(
      'u',p_actor,'b',sensitivity_rank(CASE WHEN m.role IN ('owner','admin') THEN 'confidential' ELSE m.clearance END),
      'd',coalesce((SELECT jsonb_object_agg(e.department_id::text,sensitivity_rank(e.clearance))
         FROM department_edges e WHERE e.workspace_id=p_workspace AND e.user_id=p_actor
         AND (e.expires_at IS NULL OR e.expires_at>clock_timestamp())), '{}'::jsonb)
    )),p_workspace,p_tier,p_compartments,p_row_user)
    ELSE (p_row_user IS NULL OR p_row_user=p_actor)
      AND sensitivity_rank(p_tier)<=sensitivity_rank(m.clearance)
      AND (effective_member_team_compartments(p_actor,p_workspace) IS NULL
           OR p_compartments <@ effective_member_team_compartments(p_actor,p_workspace)) END
    FROM workspace_members m JOIN workspaces wk ON wk.id=m.workspace_id
    WHERE m.workspace_id=p_workspace AND m.user_id=p_actor),false)
$$;
REVOKE ALL ON FUNCTION feed_member_source_allows(uuid,uuid,text,text[],uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION feed_draft_audience_allowed(draft_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM feed_post_working_copies w JOIN sessions s ON s.id=w.session_id
    WHERE (w.session_id=draft_id OR w.session_id IN(SELECT session_id FROM feed_comment_threads WHERE transcript_session_id=draft_id)) AND (
      EXISTS (SELECT 1 FROM workspace_members v WHERE v.workspace_id=s.workspace_id AND (
        NOT feed_member_source_allows(s.workspace_id,v.user_id,
          COALESCE(w.content->>'sourceSensitivity','public'),
          ARRAY(SELECT jsonb_array_elements_text(COALESCE(w.content->'sourceCompartments','[]'::jsonb))),NULL)
      )) OR EXISTS (
        SELECT 1 FROM (
          SELECT 'file' AS kind,jsonb_array_elements_text(COALESCE(w.content->'sourceFileIds','[]'::jsonb)) AS id
          UNION ALL SELECT 'memory',jsonb_array_elements_text(COALESCE(w.content->'sourceMemoryIds','[]'::jsonb))
        ) refs WHERE NOT EXISTS (
          SELECT 1 FROM (
            SELECT 'file' AS kind,id,workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,valid_to,retracted_at FROM workspace_files
            UNION ALL SELECT 'memory',id,workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,valid_to,retracted_at FROM memories
          ) src WHERE src.kind=refs.kind AND src.id=refs.id::uuid AND src.workspace_id=s.workspace_id
            AND src.valid_to IS NULL AND src.retracted_at IS NULL
            AND sensitivity_rank(src.sensitivity)<=sensitivity_rank(COALESCE(w.content->>'sourceSensitivity','public'))
            AND src.compartments <@ ARRAY(SELECT jsonb_array_elements_text(COALESCE(w.content->'sourceCompartments','[]'::jsonb)))
            AND (src.assistant_id IS NULL OR src.assistant_id=s.assistant_id)
            AND NOT EXISTS(SELECT 1 FROM unnest(src.compartments) c WHERE c LIKE 'client:%')
            AND (s.context_project_id IS NULL OR src.project_ids <@ ARRAY[s.context_project_id])
            AND NOT EXISTS(SELECT 1 FROM workspace_members v WHERE v.workspace_id=s.workspace_id AND (
              NOT feed_member_source_allows(s.workspace_id,v.user_id,src.sensitivity,src.compartments,src.user_id)
            ))
        )
      )
    )
  );
$$;
COMMIT;
