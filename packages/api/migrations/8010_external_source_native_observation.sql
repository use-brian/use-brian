BEGIN;
-- [COMP:api/external-source-access] Native metadata for mixed-source validation, never a payload reader.
CREATE FUNCTION read_admitted_native_scope_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; snapshot jsonb;
BEGIN
 IF actor IS NULL OR k='external_source' OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM assistants a WHERE a.workspace_id=w AND a.id=acting)
    OR assistant_placement_visible(actor,acting) IS NOT TRUE) THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';
 END IF;
 snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL THEN RETURN NULL; END IF;
 IF NOT snapshot ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds','version','held','validTo','retractedAt']
  OR jsonb_typeof(snapshot->'compartments') IS DISTINCT FROM 'array' OR jsonb_typeof(snapshot->'projectIds') IS DISTINCT FROM 'array'
  OR jsonb_typeof(snapshot->'version') IS DISTINCT FROM 'string' OR length(snapshot->>'version')=0
  OR NOT coalesce(snapshot->>'sensitivity' IN('public','internal','confidential'),false)
  OR snapshot->>'workspaceId' IS DISTINCT FROM w::text OR snapshot->>'held' IS DISTINCT FROM 'false'
  OR scope_review_state_held(k,i)
  OR agent_visibility_allows(w,(snapshot->>'userId')::uuid,(snapshot->>'assistantId')::uuid) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,snapshot) IS NOT TRUE THEN RETURN '{"held":true}'::jsonb; END IF;
 -- Native retired rows retain D1 label judgement. Live rows must also pass the
 -- canonical source-specific parent/placement reader (files, sessions, pages, etc.).
 IF snapshot->>'validTo' IS NULL AND snapshot->>'retractedAt' IS NULL
  AND read_entity_derivation_source(w,k,i) IS NULL THEN RETURN '{"held":true}'::jsonb; END IF;
 RETURN jsonb_build_object('workspaceId',snapshot->'workspaceId','userId',snapshot->'userId','assistantId',snapshot->'assistantId',
  'sensitivity',snapshot->'sensitivity','compartments',snapshot->'compartments','projectIds',snapshot->'projectIds','version',snapshot->'version',
  'held',false,'validTo',snapshot->'validTo','retractedAt',snapshot->'retractedAt','causalEntityId',snapshot->'causalEntityId');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN '{"held":true}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) FROM PUBLIC;
DO $migration$ DECLARE definition text; original text; replacement text; BEGIN
 SELECT pg_get_functiondef('read_admitted_external_source_dependencies(uuid,text[],uuid[],text[])'::regprocedure) INTO definition;
 original:=$before$root:=read_entity_derivation_source(w,kinds[n],ids[n]);
   IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' OR root->>'validTo' IS NOT NULL OR root->>'retractedAt' IS NOT NULL THEN$before$;
 replacement:=$after$root:=read_admitted_native_scope_snapshot(w,kinds[n],ids[n]);
   IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' THEN$after$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'Admitted source dependency reader changed'; END IF;
 EXECUTE replace(definition,original,replacement);
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) TO app_user;
 END IF;
END $migration$;
COMMIT;
