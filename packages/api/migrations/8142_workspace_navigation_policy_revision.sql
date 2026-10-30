-- [COMP:api/application-persistence] Personal navigation does not change authority.
BEGIN;

CREATE OR REPLACE FUNCTION advance_workspace_access_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target_workspace uuid; row_json jsonb;
BEGIN
  IF TG_TABLE_NAME='workspace_members' AND TG_OP='UPDATE' THEN
    -- Keep all present and future authority columns revision-sensitive. Only
    -- these personal picker fields can change without taking the workspace lock.
    IF (to_jsonb(OLD)-ARRAY['picker_pinned_at','picker_hidden_at','picker_last_opened_at'])
       IS NOT DISTINCT FROM
       (to_jsonb(NEW)-ARRAY['picker_pinned_at','picker_hidden_at','picker_last_opened_at']) THEN
      RETURN NEW;
    END IF;
  END IF;
  row_json=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME IN ('workspace_group_members','workspace_group_compartment_grants','workspace_group_assistants') THEN
    SELECT workspace_id INTO target_workspace FROM workspace_groups WHERE id=(row_json->>'group_id')::uuid;
  ELSE target_workspace=(row_json->>'workspace_id')::uuid;
  END IF;
  IF target_workspace IS NOT NULL AND EXISTS(SELECT 1 FROM workspaces WHERE id=target_workspace) THEN
    PERFORM 1 FROM workspaces WHERE id=target_workspace FOR UPDATE;
    INSERT INTO workspace_access_policies(workspace_id) VALUES(target_workspace)
      ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_access_policies.revision+1;
    PERFORM pg_notify('brain_events',json_build_object('workspaceId',target_workspace,'primitive','workspace_config','action','update')::text);
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

COMMIT;
