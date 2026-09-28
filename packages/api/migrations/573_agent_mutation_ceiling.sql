BEGIN;

CREATE FUNCTION agent_mutation_scope_allows(p_compartments text[]) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE raw_grant text; mutation_grant jsonb;
BEGIN
  raw_grant=nullif(current_setting('app.agent_mutation_compartments',true),'');
  -- Old execution wrappers used the same ceiling for reads and writes.
  IF raw_grant IS NULL THEN raw_grant=nullif(current_setting('app.agent_compartments',true),''); END IF;
  IF raw_grant IS NULL THEN RETURN true; END IF;
  mutation_grant=raw_grant::jsonb;
  IF mutation_grant='null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(mutation_grant)<>'array' THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(mutation_grant) value WHERE jsonb_typeof(value)<>'string') THEN RETURN false; END IF;
  RETURN NOT EXISTS(SELECT 1 FROM unnest(coalesce(p_compartments,'{}')) required WHERE NOT mutation_grant ? required);
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END;
$$;

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['memories','memories_shadow','entities','entity_links','tasks','workspace_files','episodes','knowledge_entries','kb_chunks'] LOOP
    EXECUTE format('CREATE POLICY execution_mutation_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK(agent_mutation_scope_allows(compartments))',tab);
    EXECUTE format('CREATE POLICY execution_mutation_update ON %I AS RESTRICTIVE FOR UPDATE USING(agent_mutation_scope_allows(compartments)) WITH CHECK(agent_mutation_scope_allows(compartments))',tab);
    EXECUTE format('CREATE POLICY execution_mutation_delete ON %I AS RESTRICTIVE FOR DELETE USING(agent_mutation_scope_allows(compartments))',tab);
  END LOOP;
END $$;

COMMIT;
