BEGIN;

-- Mandatory current-human floor, independent of a retained agent projection.
-- Owner/admin keeps the existing v1 broad-authority role semantics.
CREATE FUNCTION member_operation_scope_allows(w uuid,sensitivity text,compartments text[],mutation boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid=nullif(current_setting('app.current_user_id',true),'')::uuid;
  member_role text; clearance text; reach text[];
BEGIN
  SELECT m.role,CASE WHEN m.role IN('owner','admin') THEN 'confidential' ELSE m.clearance END
    INTO member_role,clearance FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor;
  IF member_role IS NULL OR sensitivity_rank(clearance) IS NULL OR sensitivity_rank(sensitivity) IS NULL
    OR sensitivity_rank(sensitivity)>sensitivity_rank(clearance) THEN RETURN false; END IF;
  reach=CASE WHEN mutation THEN effective_member_team_compartments(actor,w) ELSE effective_member_read_compartments(actor,w) END;
  RETURN reach IS NULL OR coalesce(compartments,'{}') <@ reach;
END;
$$;

DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['memories','memories_shadow','entities','entity_links','tasks','workspace_files','episodes','knowledge_entries','kb_chunks'] LOOP
    EXECUTE format('CREATE POLICY member_operation_read ON %I AS RESTRICTIVE FOR SELECT USING(member_operation_scope_allows(workspace_id,sensitivity,compartments,false))',tab);
    EXECUTE format('CREATE POLICY member_operation_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK(member_operation_scope_allows(workspace_id,sensitivity,compartments,true))',tab);
    EXECUTE format('CREATE POLICY member_operation_update ON %I AS RESTRICTIVE FOR UPDATE USING(member_operation_scope_allows(workspace_id,sensitivity,compartments,true)) WITH CHECK(member_operation_scope_allows(workspace_id,sensitivity,compartments,true))',tab);
    EXECUTE format('CREATE POLICY member_operation_delete ON %I AS RESTRICTIVE FOR DELETE USING(member_operation_scope_allows(workspace_id,sensitivity,compartments,true))',tab);
  END LOOP;
END $$;
COMMIT;
