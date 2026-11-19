-- [COMP:security/native-field-policy] One rule evaluation per physical mask operation.
CREATE OR REPLACE FUNCTION application_native_member_field_permissions(w uuid,policy jsonb,member_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE roles text[]; result jsonb; metadata jsonb:=policy->'metadata';
BEGIN
 IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=member_id) THEN RETURN NULL; END IF;
 SELECT coalesce(array_agg(DISTINCT a.role_key),'{}') INTO roles FROM application_native_role_assignments a
  WHERE a.workspace_id=w AND a.module_key=metadata->>'moduleKey' AND a.user_id=member_id AND a.status='active'
   AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp()) AND (policy->'roleKeys') ? a.role_key;
 -- Fields reference rules; they are not separate permission operations. Evaluate
 -- each distinct rule under these current roles, then project the original keys.
 -- All state is statement-local. The next invocation reads roles again.
 WITH fields AS MATERIALIZED(SELECT value FROM jsonb_array_elements(metadata->'fields')),
 rules AS(SELECT value->'read' rule FROM fields UNION SELECT value->'write' FROM fields),
 decisions AS MATERIALIZED(SELECT rule,application_native_field_rule_allows(rule,roles) allowed FROM rules)
 SELECT jsonb_build_object(
  'read',ARRAY(SELECT f.value->>'key' FROM fields f JOIN decisions d ON d.rule IS NOT DISTINCT FROM f.value->'read' WHERE d.allowed ORDER BY 1),
  'write',ARRAY(SELECT f.value->>'key' FROM fields f JOIN decisions d ON d.rule IS NOT DISTINCT FROM f.value->'write' WHERE d.allowed ORDER BY 1)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION application_native_member_field_permissions(uuid,jsonb,uuid) FROM PUBLIC;
