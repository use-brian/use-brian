BEGIN;
-- [COMP:api/application-persistence] Atomic typed native Knowledge lineage.
-- Original canonical input/ancestry, external-retention and Page guards remain.
CREATE FUNCTION record_admitted_knowledge_entry_derivation(w uuid,i uuid,v text,producer text,sources jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 output knowledge_entries;source jsonb;current jsonb;output_source jsonb;derivation uuid;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL OR current_setting('app.system_bypass',true)='true'
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.knowledge_entries'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 1000
  OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) proposed(value) WHERE proposed.value->>'resourceKind'='application_field') THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 SELECT k.* INTO output FROM knowledge_entries k WHERE k.workspace_id=w AND k.id=i AND k.scope_version::text=v
  AND k.xmin::text::bigint=(pg_current_xact_id()::text::numeric % 4294967296)::bigint FOR UPDATE;
 IF NOT FOUND OR output.created_by IS DISTINCT FROM actor OR output.scope_held OR output.source_id IS NOT NULL OR output.source_sha IS NOT NULL
  OR member_operation_scope_allows(w,output.sensitivity,output.compartments,true) IS NOT TRUE
  OR agent_mutation_scope_allows(output.compartments) IS NOT TRUE
  OR agent_read_scope_allows(output.sensitivity,output.compartments,output.project_ids) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 output_source:=read_admitted_native_scope_snapshot(w,'knowledge_entry',i);
 IF output_source IS NULL OR output_source->>'held' IS DISTINCT FROM 'false' OR output_source->>'version' IS DISTINCT FROM v
  OR (SELECT count(DISTINCT (s->>'resourceKind',s->>'resourceId')) FROM jsonb_array_elements(sources) s)<>jsonb_array_length(sources) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='external_source' THEN
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   current:=external_source_snapshot(w,(source->>'resourceId')::uuid);
  ELSE current:=read_entity_derivation_source(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM source->>'version'
   OR current->>'validTo' IS NOT NULL OR current->>'retractedAt' IS NOT NULL
   OR (current->'workspaceId',current->'userId',current->'assistantId',current->'sensitivity')
    IS DISTINCT FROM (source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
   OR NOT (current->'compartments')@>(source->'compartments') OR NOT (source->'compartments')@>(current->'compartments')
   OR NOT (current->'projectIds')@>(source->'projectIds') OR NOT (source->'projectIds')@>(current->'projectIds') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text
   OR sensitivity_rank(source->>'sensitivity')>sensitivity_rank(output.sensitivity)
   OR NOT to_jsonb(output.compartments)@>(source->'compartments') OR NOT to_jsonb(output.project_ids)@>(source->'projectIds') THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
 END LOOP;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'knowledge_entry',i,v,producer,NULL,NULL,output.sensitivity,output.compartments,output.project_ids,p.revision
  FROM workspace_access_policies p WHERE p.workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,derivation,s->>'resourceKind',(s->>'resourceId')::uuid,s->>'version' FROM jsonb_array_elements(sources) s ORDER BY s->>'resourceKind',s->>'resourceId';
 SET CONSTRAINTS page_derivation_dependencies IMMEDIATE;
 SET CONSTRAINTS page_derivation_dependencies DEFERRED;
 RETURN derivation;
END $$;
REVOKE ALL ON FUNCTION record_admitted_knowledge_entry_derivation(uuid,uuid,text,text,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION record_admitted_knowledge_entry_derivation(uuid,uuid,text,text,jsonb) TO app_user;
END IF;END $$;
COMMIT;
