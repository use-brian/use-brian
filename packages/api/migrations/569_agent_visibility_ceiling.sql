BEGIN;

CREATE FUNCTION agent_visibility_allows(p_workspace uuid,p_user uuid,p_assistant uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE bound_workspace text; bound_actor text; bound_assistants jsonb;
BEGIN
  bound_workspace=nullif(current_setting('app.agent_workspace_id',true),'');
  bound_actor=nullif(current_setting('app.agent_actor_id',true),'');
  bound_assistants=nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb;
  IF bound_workspace IS NOT NULL AND p_workspace IS NOT NULL AND p_workspace::text<>bound_workspace THEN RETURN false; END IF;
  IF bound_actor IS NOT NULL AND p_user IS NOT NULL AND p_user::text<>bound_actor THEN RETURN false; END IF;
  IF bound_assistants IS NOT NULL AND bound_assistants<>'null'::jsonb AND p_assistant IS NOT NULL THEN
    IF jsonb_typeof(bound_assistants)<>'array' THEN RETURN false; END IF;
    RETURN bound_assistants @> jsonb_build_array(p_assistant::text);
  END IF;
  RETURN true;
END;
$$;

DO $$ DECLARE tab text; visibility text; BEGIN
  FOREACH tab IN ARRAY ARRAY['memories','memories_shadow','entities','entity_links','tasks','workspace_files','episodes','knowledge_entries','kb_chunks'] LOOP
    visibility=CASE WHEN tab='knowledge_entries' THEN 'NULL::uuid,NULL::uuid' ELSE 'user_id,assistant_id' END;
    EXECUTE format('CREATE POLICY execution_visibility_ceiling ON %I AS RESTRICTIVE FOR ALL USING(agent_visibility_allows(workspace_id,%s)) WITH CHECK(agent_visibility_allows(workspace_id,%s))',tab,visibility,visibility);
  END LOOP;
END $$;

COMMIT;
