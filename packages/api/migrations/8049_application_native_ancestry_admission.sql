BEGIN;
-- [COMP:api/application-field-evidence] Reuse the R1 field reader internally so
-- one bounded lineage walk can check recorded fields without recursive wrappers.
ALTER FUNCTION application_recorded_field_state(uuid,uuid,text,integer) RENAME TO application_recorded_field_state_before_record_ancestry;
REVOKE ALL ON FUNCTION application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer) FROM PUBLIC;
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)'::regprocedure) INTO definition;
 IF position('admitted := application_recorded_field_state(' IN definition)=0
  AND position('admitted:=application_recorded_field_state(' IN definition)=0 THEN RAISE EXCEPTION 'Recorded field recursion changed';END IF;
 EXECUTE replace(replace(definition,'admitted := application_recorded_field_state(','admitted := application_recorded_field_state_before_record_ancestry('),
  'admitted:=application_recorded_field_state(','admitted:=application_recorded_field_state_before_record_ancestry(');
END $migration$;

-- This metadata-only restriction never admits the root row, selected fields or
-- command. Those checks remain in their canonical ports. Native field anchors
-- are not raw whole-record inputs: only explicit raw entity edges consume every
-- current protected field. UNION in application_scope_lineage bounds high-water
-- cycles, and missing field/external observations never gain native D1 permission.
CREATE FUNCTION application_canonical_ancestry_allowed(w uuid,k text,i uuid,v text,writing boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb;node jsonb;dependency record;current jsonb;policy jsonb;mask jsonb;type_key text;
 resource application_field_resources;observation application_field_observations;envelope jsonb;expanded jsonb;current_roots jsonb;root jsonb;cursor_index integer:=0;
 app_mode boolean:=nullif(current_setting('app.application_id',true),'') IS NOT NULL;
BEGIN
 SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') INTO nodes FROM application_scope_lineage(w,ARRAY[k],ARRAY[i],ARRAY[v]) l;
 WHILE cursor_index<jsonb_array_length(nodes) LOOP
  node:=nodes->cursor_index;cursor_index:=cursor_index+1;
  IF node->>'kind'='application_field' THEN
   SELECT * INTO resource FROM application_field_resources r WHERE r.workspace_id=w AND r.id=(node->>'id')::uuid;
   IF NOT FOUND THEN RETURN false;END IF;
   SELECT * INTO observation FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=resource.id AND o.version=node->>'version';
   IF NOT FOUND THEN RETURN false;END IF;
   current:=application_recorded_field_state_before_record_ancestry(w,resource.id,node->>'version',0);
   IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' THEN RETURN false;END IF;
   IF NOT app_mode AND (workflow_evidence_envelope_visible(w,observation.source_scope) IS NOT TRUE
    OR workflow_evidence_envelope_visible(w,current) IS NOT TRUE) THEN RETURN false;END IF;
   -- Current target identities may differ from the immutable original targets.
   -- Read their metadata through the same selected-field canonical computation,
   -- then union their physical source lineage into this bounded worklist.
   envelope:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,
    resource.selection,resource.selected_version,resource.fields);
   IF envelope IS NULL THEN RETURN false;END IF;
   WITH RECURSIVE envelopes(value) AS (
    SELECT envelope UNION ALL SELECT child.value FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'children') child(value)
   ), roots AS (
    SELECT jsonb_build_object('kind',e.value#>>'{state,sourceKind}','id',e.value#>>'{state,sourceId}','version',e.value#>>'{state,sourceVersion}') AS value
     FROM envelopes e WHERE scope_source_table(e.value#>>'{state,sourceKind}') IS NOT NULL
    UNION SELECT jsonb_build_object('kind','external_source','id',source->>'resourceId','version',source->>'version')
     FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'sources') source WHERE source->>'resourceKind'='external_source'
   ) SELECT coalesce(jsonb_agg(value),'[]') INTO current_roots FROM roots;
   FOR root IN SELECT value FROM jsonb_array_elements(current_roots) LOOP
    SELECT coalesce(jsonb_agg(to_jsonb(l)),'[]') INTO expanded FROM application_scope_lineage(w,ARRAY[root->>'kind'],ARRAY[(root->>'id')::uuid],ARRAY[root->>'version']) l;
    SELECT coalesce(jsonb_agg(value),'[]') INTO expanded FROM jsonb_array_elements(expanded) value WHERE NOT nodes @> jsonb_build_array(value);
    nodes:=nodes||expanded;
    IF jsonb_array_length(nodes)>4096 THEN RETURN false;END IF;
   END LOOP;
  ELSIF node->>'kind'='external_source' THEN
   current:=external_source_snapshot(w,(node->>'id')::uuid);
   IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM node->>'version'
    OR writing AND external_source_retention_allowed(w,(node->>'id')::uuid,node->>'version') IS NOT TRUE THEN RETURN false;END IF;
  -- The root's own canonical reader/writer owns row authority and refusal
  -- semantics. Field observations still recheck every native anchor.
  ELSIF scope_source_table(node->>'kind') IS NOT NULL AND NOT app_mode AND (node->>'kind'<>k OR (node->>'id')::uuid<>i) THEN
   current:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
   IF node->>'kind'='crm_event' AND current IS NULL OR current IS NOT NULL AND current->>'held' IS DISTINCT FROM 'false' THEN RETURN false;END IF;
  END IF;
 END LOOP;
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  -- Application source profiles keep their existing hold until their canonical
  -- native-source port is available. Never impersonate a member to lift it.
  IF app_mode OR workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN RETURN false;END IF;
 END LOOP;
 FOR dependency IN SELECT DISTINCT s.source_id FROM scope_derivation_sources s JOIN scope_derivations d
  ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid
  WHERE d.workspace_id=w AND s.source_kind='entity' LOOP
  SELECT e.kind INTO type_key FROM entities e WHERE e.workspace_id=w AND e.id=dependency.source_id;
  IF NOT FOUND OR type_key NOT IN('company','person','deal') THEN CONTINUE;END IF;
  policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id::text);
  IF policy->>'registered' IS DISTINCT FROM 'false' THEN
   mask:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id);
   IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
    OR mask->>'held' IS DISTINCT FROM 'false' OR NOT coalesce(policy#>'{metadata,fieldKeys}'<@(mask->'readFields'),false) THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean) FROM PUBLIC;

CREATE FUNCTION application_recorded_field_state(w uuid,i uuid,v text,depth integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admitted jsonb;
BEGIN
 admitted:=application_recorded_field_state_before_record_ancestry(w,i,v,depth);
 IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RETURN admitted;END IF;
 IF application_canonical_ancestry_allowed(w,'application_field',i,v) IS NOT TRUE THEN RETURN '{"held":true}'::jsonb;END IF;
 RETURN admitted;
END $$;
REVOKE ALL ON FUNCTION application_recorded_field_state(uuid,uuid,text,integer) FROM PUBLIC;
CREATE OR REPLACE FUNCTION read_admitted_application_field_snapshot(w uuid,i uuid,v text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT application_recorded_field_state(w,i,v,0)
$$;
REVOKE ALL ON FUNCTION read_admitted_application_field_snapshot(uuid,uuid,text) FROM PUBLIC;

-- A freshly computed envelope may contain new relationship targets which are
-- not materialized observations yet. Inspect physical source metadata only.
CREATE FUNCTION application_field_envelope_ancestry_allowed(w uuid,envelope jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE root record;
BEGIN
 IF envelope IS NULL THEN RETURN false;END IF;
 FOR root IN WITH RECURSIVE envelopes(value) AS (
  SELECT envelope UNION ALL SELECT child.value FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'children') child(value)
 ) SELECT DISTINCT e.value#>>'{state,sourceKind}' AS kind,e.value#>>'{state,sourceId}' AS id,e.value#>>'{state,sourceVersion}' AS version
  FROM envelopes e WHERE scope_source_table(e.value#>>'{state,sourceKind}') IS NOT NULL LOOP
  IF application_canonical_ancestry_allowed(w,root.kind,root.id::uuid,root.version) IS NOT TRUE THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION application_field_envelope_ancestry_allowed(uuid,jsonb) FROM PUBLIC;

DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure) INTO definition;
 before:='envelope:=application_compute_field_envelope(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Field capture computation changed';END IF;
 definition:=replace(definition,before,$source$IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type IN('company','person','deal') THEN
  IF application_canonical_ancestry_allowed(w,'entity',p_id,p_record_version) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 ELSIF p_origin->>'kind'='generic' THEN
  IF application_canonical_ancestry_allowed(w,'entity_instance',p_id,p_record_version) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END IF;
 $source$||before);
 before:='PERFORM application_materialize_field_envelope(w,envelope);';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Field capture materialization changed';END IF;
 EXECUTE replace(definition,before,$source$IF application_field_envelope_ancestry_allowed(w,envelope) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 $source$||before);
END $migration$;

DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('public.read_native_application_record(uuid,text,uuid,text[])'::regprocedure) INTO definition;
 before:='state:=application_field_projection_state(w,origin,p_type,p_id,''read'',NULL,fields);';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native record reader changed';END IF;
 EXECUTE replace(definition,before,$source$IF p_type IN('company','person','deal') THEN
  state:=read_scope_source(w,'entity',p_id);
  IF state IS NULL OR application_canonical_ancestry_allowed(w,'entity',p_id,state->>'version') IS NOT TRUE THEN RETURN NULL;END IF;
 END IF;
 $source$||before);
 SELECT pg_get_functiondef('public.application_native_query_refs(uuid,text,jsonb,jsonb,jsonb)'::regprocedure) INTO definition;
 before:='state:=application_field_projection_state(w,origin,p_type,row_value.id,''query'',NULL,''{}'');';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native query candidates changed';END IF;
 EXECUTE replace(definition,before,$source$IF application_canonical_ancestry_allowed(w,'entity',row_value.id,scope->>'version') IS NOT TRUE THEN RETURN NULL;END IF;
 $source$||before);
 SELECT pg_get_functiondef('public.application_company_patch_state(uuid,text[])'::regprocedure) INTO definition;
 before:=$source$IF EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=r.workspace_id AND d.resource_kind='entity' AND d.resource_id=r.id)
  OR EXISTS(SELECT 1 FROM read_external_source_dependencies(r.workspace_id,ARRAY['entity'],ARRAY[r.id],ARRAY[r.scope_version::text])) THEN RETURN NULL;END IF;$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical company admission changed';END IF;
 EXECUTE replace(definition,before,$source$IF application_canonical_ancestry_allowed(r.workspace_id,'entity',r.id,r.scope_version::text,true) IS NOT TRUE THEN RETURN NULL;END IF;$source$);
END $migration$;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer),application_recorded_field_state(uuid,uuid,text,integer),application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean),application_field_envelope_ancestry_allowed(uuid,jsonb) FROM app_user;
 GRANT EXECUTE ON FUNCTION read_admitted_application_field_snapshot(uuid,uuid,text) TO app_user;
END IF;END $$;
COMMIT;
