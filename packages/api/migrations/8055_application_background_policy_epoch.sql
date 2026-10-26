-- Same-transaction policy metadata for an exact native workflow source.
-- No business payload, authority grant, or arbitrary-identity epoch facade.
-- [COMP:api/application-lifecycle]
BEGIN;
CREATE FUNCTION read_workflow_policy_epoch(w uuid,run uuid,expected_actor uuid,acting uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid;
BEGIN
 actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 IF actor IS NULL OR actor IS DISTINCT FROM expected_actor
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class table_owner ON table_owner.oid='public.workflow_runs'::regclass
    WHERE role.rolname=session_user AND (role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,table_owner.relowner,'USAGE')))
  OR NOT EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  OR NOT EXISTS(SELECT 1 FROM workflow_runs execution JOIN workflows definition
    ON definition.id=execution.workflow_id AND definition.workspace_id=execution.workspace_id
    JOIN assistants assistant ON assistant.id=acting AND assistant.workspace_id=execution.workspace_id
    WHERE execution.workspace_id=w AND execution.id=run
     AND coalesce(execution.triggered_by,definition.created_by)=actor
     AND execution.execution_authority->>'assistantId'=acting::text
     AND execution.execution_authority#>>'{ceiling,workspaceId}'=w::text
     AND execution.execution_authority#>>'{ceiling,userId}'=actor::text) THEN RETURN NULL;
 END IF;
 RETURN public.read_application_policy_epoch(w,actor,acting);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION read_workflow_policy_epoch(uuid,uuid,uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_workflow_policy_epoch(uuid,uuid,uuid,uuid) TO app_user;
END IF;END $$;
COMMIT;
