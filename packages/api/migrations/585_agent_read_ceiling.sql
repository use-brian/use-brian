BEGIN;

-- Apply the same execution projection even when an app-role query forgets
-- the TypeScript predicate. Do not replace existing member or write policies.
CREATE FUNCTION agent_scope_grant_allows(setting_name text,required text[]) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE raw_grant text; grant_value jsonb;
BEGIN
  raw_grant=nullif(current_setting(setting_name,true),'');
  IF raw_grant IS NULL THEN RETURN true; END IF;
  grant_value=raw_grant::jsonb;
  IF grant_value='null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(grant_value)<>'array' THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(grant_value) value WHERE jsonb_typeof(value)<>'string') THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM unnest(coalesce(required,'{}')) value WHERE NOT grant_value ? value);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

CREATE FUNCTION agent_read_scope_allows(row_sensitivity text,row_teams text[],row_projects uuid[]) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE clearance text;
BEGIN
  clearance=nullif(current_setting('app.agent_clearance',true),'');
  IF clearance IS NOT NULL AND (sensitivity_rank(clearance) IS NULL OR sensitivity_rank(row_sensitivity) IS NULL
    OR sensitivity_rank(row_sensitivity)>sensitivity_rank(clearance)) THEN RETURN false; END IF;
  RETURN agent_scope_grant_allows('app.agent_compartments',row_teams)
    AND agent_scope_grant_allows('app.agent_project_ids',row_projects::text[]);
END;
$$;

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['memories','memories_shadow','entities','entity_links','tasks','workspace_files','episodes','knowledge_entries','kb_chunks'] LOOP
    EXECUTE format('CREATE POLICY execution_read_ceiling ON %I AS RESTRICTIVE FOR SELECT USING(agent_read_scope_allows(sensitivity,compartments,project_ids))',tab);
    EXECUTE format('CREATE POLICY execution_read_update_source ON %I AS RESTRICTIVE FOR UPDATE USING(agent_read_scope_allows(sensitivity,compartments,project_ids)) WITH CHECK(agent_scope_grant_allows(''app.agent_project_ids'',project_ids::text[]))',tab);
    EXECUTE format('CREATE POLICY execution_read_delete_source ON %I AS RESTRICTIVE FOR DELETE USING(agent_read_scope_allows(sensitivity,compartments,project_ids))',tab);
    EXECUTE format('CREATE POLICY execution_project_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK(agent_scope_grant_allows(''app.agent_project_ids'',project_ids::text[]))',tab);
  END LOOP;
END $$;

COMMIT;
