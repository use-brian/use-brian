BEGIN;
-- [COMP:api/workspace-access] Expiry remains live inside retained transactions.
-- Spec: docs/architecture/features/workspace-access.md, Read requests and grants.
CREATE OR REPLACE FUNCTION effective_member_read_compartments(p_user_id uuid,p_workspace_id uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE base text[]; result text[];
BEGIN
  IF NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=p_workspace_id AND user_id=p_user_id) THEN RETURN ARRAY[]::text[]; END IF;
  base=effective_member_team_compartments(p_user_id,p_workspace_id);
  IF base IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(array_agg(DISTINCT key ORDER BY key),ARRAY[]::text[]) INTO result FROM (
    SELECT unnest(base) AS key
    UNION
    SELECT target.compartment_key FROM workspace_access_grants grant_row
      JOIN workspace_groups target ON target.id=grant_row.target_team_id AND target.workspace_id=grant_row.workspace_id AND target.status='active'
      WHERE grant_row.workspace_id=p_workspace_id AND grant_row.revoked_at IS NULL
        AND grant_row.starts_at<=clock_timestamp() AND (grant_row.expires_at IS NULL OR grant_row.expires_at>clock_timestamp())
        AND ((grant_row.beneficiary_kind='member' AND grant_row.beneficiary_id=p_user_id)
          OR (grant_row.beneficiary_kind='team' AND EXISTS(
            SELECT 1 FROM workspace_group_members gm JOIN workspace_groups beneficiary ON beneficiary.id=gm.group_id
             WHERE gm.group_id=grant_row.beneficiary_id AND gm.user_id=p_user_id AND beneficiary.workspace_id=p_workspace_id AND beneficiary.status='active'
          )))
  ) keys;
  RETURN result;
END;
$$;
COMMIT;
