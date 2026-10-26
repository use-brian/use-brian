BEGIN;
-- [COMP:api/application-field-evidence] Metadata-only application source admission.
-- No user impersonation or raw payload is used to discharge the original floor.
CREATE FUNCTION application_native_source_scope_allowed(w uuid,k text,i uuid,source jsonb,required_fields text[] DEFAULT '{}',p_action text DEFAULT 'read') RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb;type_key text;author uuid;decision jsonb;context jsonb;
BEGIN
 context:=application_current_maxima();
 IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text OR source IS NULL
  OR entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
  OR p_action NOT IN('read','patch') OR required_fields IS NULL OR cardinality(required_fields)>256 OR array_position(required_fields,NULL) IS NOT NULL
  OR agent_visibility_allows(w,(source->>'userId')::uuid,(source->>'assistantId')::uuid) IS NOT TRUE THEN RETURN false;END IF;
 IF k='entity' THEN
  SELECT e.kind,e.created_by_user_id INTO type_key,author FROM entities e WHERE e.workspace_id=w AND e.id=i;
  IF NOT FOUND OR type_key NOT IN('company','person','deal') THEN RETURN false;END IF;
  origin:='{"kind":"native","moduleKey":"native"}';
 ELSIF k='task' THEN
  SELECT t.created_by_user_id INTO author FROM tasks t WHERE t.workspace_id=w AND t.id=i;
  IF NOT FOUND THEN RETURN false;END IF;type_key:='task';origin:='{"kind":"native","moduleKey":"native"}';
 ELSIF k='workspace_file' THEN
  SELECT f.created_by_user_id INTO author FROM workspace_files f WHERE f.workspace_id=w AND f.id=i;
  IF NOT FOUND THEN RETURN false;END IF;type_key:='file';origin:='{"kind":"native","moduleKey":"native"}';
 ELSIF k='entity_instance' THEN
  SELECT jsonb_build_object('kind','generic','entityTypeId',e.entity_type_id),'record.'||e.entity_type_id,e.created_by
   INTO origin,type_key,author FROM entity_instances e WHERE e.workspace_id=w AND e.id=i;
  IF NOT FOUND THEN RETURN false;END IF;
 ELSE RETURN false;END IF;
 decision:=application_resource_fields(w,origin,type_key,i::text,author,source->>'sensitivity',
  ARRAY(SELECT jsonb_array_elements_text(source->'compartments')),ARRAY(SELECT jsonb_array_elements_text(source->'projectIds'))::uuid[],
  (source->>'userId')::uuid,p_action);
 RETURN decision IS NOT NULL AND coalesce(to_jsonb(required_fields)<@(decision->'read'),false);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_source_scope_allowed(uuid,text,uuid,jsonb,text[],text) FROM PUBLIC;

-- Key completeness is metadata. It never releases a raw attributes object or
-- treats an undeclared historical slot as a newly authorized canonical field.
CREATE FUNCTION application_native_crm_attributes_complete(w uuid,i uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_kind text;unknown_key boolean;
BEGIN
 SELECT e.kind INTO v_kind FROM entities e WHERE e.workspace_id=w AND e.id=i AND e.kind IN('company','person','deal');
 IF NOT FOUND THEN RETURN false;END IF;
 SELECT jsonb_typeof(e.attributes) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(e.attributes) key WHERE NOT key=ANY(
  ARRAY['tags','external_ref','owner_id','crm_archived_at','custom_fields']||CASE v_kind WHEN 'company' THEN ARRAY['domain']
   WHEN 'person' THEN ARRAY['self','email','phone','company_id']
   WHEN 'deal' THEN ARRAY['stage','amount','company_id','contact_id','close_date','pipeline_id','pipeline_stage_id','currency_code','source','win_loss_reason','probability'] END))
  OR e.attributes ? 'custom_fields' AND (jsonb_typeof(e.attributes->'custom_fields') NOT IN('object','null') OR EXISTS(
   SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(e.attributes->'custom_fields')='object' THEN e.attributes->'custom_fields' ELSE '{}'::jsonb END) key
   WHERE NOT ('custom.'||key)=ANY(application_native_field_keys(v_kind)) AND NOT EXISTS(SELECT 1 FROM crm_field_definitions f
    WHERE f.workspace_id=w AND f.entity_kind=v_kind AND f.field_key=key AND f.archived_at IS NULL)))
 INTO unknown_key FROM entities e WHERE e.workspace_id=w AND e.id=i;
 RETURN NOT unknown_key;
EXCEPTION WHEN invalid_parameter_value THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_crm_attributes_complete(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_native_source_fields(w uuid,k text,i uuid) RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fields text[];type_key text;policy jsonb;
BEGIN
 IF k='entity' THEN
  SELECT e.kind INTO type_key FROM entities e WHERE e.workspace_id=w AND e.id=i;
  IF NOT FOUND OR type_key NOT IN('company','person','deal') THEN RETURN NULL;END IF;
  IF application_native_crm_attributes_complete(w,i) IS NOT TRUE THEN RETURN NULL;END IF;
  policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,i::text);
  IF policy->>'registered'='true' AND policy->>'held'='false' THEN
   RETURN ARRAY(SELECT jsonb_array_elements_text(policy#>'{metadata,fieldKeys}'));
  ELSIF policy->>'registered' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
  SELECT ARRAY(SELECT DISTINCT field FROM (SELECT unnest(application_native_field_keys(type_key)) AS field
   UNION SELECT 'custom.'||f.field_key FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=type_key AND f.archived_at IS NULL) keys ORDER BY field) INTO fields;
 ELSIF k='entity_instance' THEN
  SELECT ARRAY(SELECT p->>'name' FROM jsonb_array_elements(t.properties) p) INTO fields FROM entity_instances e JOIN entity_types t
   ON t.workspace_id=e.workspace_id AND t.id=e.entity_type_id WHERE e.workspace_id=w AND e.id=i;
 ELSIF k='task' THEN fields:=application_native_field_keys('task');
 ELSIF k='workspace_file' THEN fields:=ARRAY['name','mimeType','sizeBytes','storageRef'];
 END IF;
 RETURN fields;
END $$;
REVOKE ALL ON FUNCTION application_native_source_fields(uuid,text,uuid) FROM PUBLIC;

ALTER FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) RENAME TO read_admitted_native_scope_snapshot_before_application_sources;
REVOKE ALL ON FUNCTION read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_admitted_native_scope_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE snapshot jsonb;fields text[];
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN RETURN read_admitted_native_scope_snapshot_before_application_sources(w,k,i);END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entities'::regclass WHERE r.rolname=session_user
  AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN '{"held":true}';END IF;
 snapshot:=read_scope_source(w,k,i);fields:=application_native_source_fields(w,k,i);
 IF snapshot IS NULL THEN RETURN NULL;END IF;
 IF fields IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false' OR scope_review_state_held(k,i)
  OR application_native_source_scope_allowed(w,k,i,snapshot,fields) IS NOT TRUE THEN RETURN '{"held":true}';END IF;
 RETURN snapshot;
END $$;
REVOKE ALL ON FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) FROM PUBLIC;

-- Physical predecessors are metadata versions of one stable task destination.
-- Explicit derivation sources are still rechecked separately with read authority.
CREATE FUNCTION application_native_same_destination(w uuid,k text,i uuid,other_kind text,other_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT k=other_kind AND (i=other_id OR k='task' AND EXISTS(SELECT 1 FROM tasks a JOIN tasks b ON b.workspace_id=a.workspace_id AND b.logical_id=a.logical_id
  WHERE a.workspace_id=w AND a.id=i AND b.id=other_id))
$$;
REVOKE ALL ON FUNCTION application_native_same_destination(uuid,text,uuid,text,uuid) FROM PUBLIC;

DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure) INTO definition;
 -- Selected field anchors have already passed their real read/query/history
 -- action and deployed alias. They are not independent raw whole-row inputs.
 before:='current_roots jsonb;root jsonb;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical field ancestry variables changed';END IF;
 definition:=replace(definition,before,'current_roots jsonb;field_anchors jsonb:=''[]'';root jsonb;');
 before:=$source$WHERE scope_source_table(e.value#>>'{state,sourceKind}') IS NOT NULL$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical selected ancestry roots changed';END IF;
 definition:=replace(definition,before,before||$source$ OR e.value#>>'{state,sourceKind}'='entity_instance'$source$);
 before:='FOR root IN SELECT value FROM jsonb_array_elements(current_roots) LOOP';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical selected ancestry expansion changed';END IF;
 definition:=replace(definition,before,'field_anchors:=field_anchors||current_roots; '||before);

 before:=$source$IF app_mode OR workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN RETURN false;END IF;$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical ancestry original envelope changed';END IF;
 definition:=replace(definition,before,$source$IF (CASE WHEN app_mode THEN application_native_source_scope_allowed(w,dependency.resource_kind,dependency.resource_id,
   jsonb_build_object('workspaceId',w,'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids),'{}',CASE WHEN writing AND application_native_same_destination(w,k,i,dependency.resource_kind,dependency.resource_id) THEN 'patch' ELSE 'read' END) ELSE workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) END) IS NOT TRUE THEN RETURN false;END IF;$source$);
 before:=$source$policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id::text);$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical raw ancestry field admission changed';END IF;
 definition:=replace(definition,before,$source$IF app_mode THEN
   current:=read_scope_source(w,'entity',dependency.source_id);
   IF application_native_source_scope_allowed(w,'entity',dependency.source_id,current,application_native_source_fields(w,'entity',dependency.source_id)) IS NOT TRUE THEN RETURN false;END IF;
   CONTINUE;
  END IF;
  $source$||before);
 before:=$source$ELSIF scope_source_table(node->>'kind') IS NOT NULL AND NOT app_mode AND (node->>'kind'<>k OR (node->>'id')::uuid<>i) THEN$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical native source worklist changed';END IF;
 definition:=replace(definition,before,replace(before,$check$(node->>'kind'<>k OR (node->>'id')::uuid<>i)$check$,$check$application_native_same_destination(w,k,i,node->>'kind',(node->>'id')::uuid) IS NOT TRUE$check$));
 -- Lineage enumeration is unordered. Complete selected-field validation before
 -- checking physical nodes, so no selected root depends on traversal order.
 before:='FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical original ancestry worklist changed';END IF;
 definition:=replace(definition,before,$source$IF app_mode THEN
  FOR node IN SELECT value FROM jsonb_array_elements(nodes) LOOP
   IF (scope_source_table(node->>'kind') IS NOT NULL OR node->>'kind'='entity_instance')
    AND application_native_same_destination(w,k,i,node->>'kind',(node->>'id')::uuid) IS NOT TRUE
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(field_anchors) anchor WHERE anchor->>'kind'=node->>'kind' AND anchor->>'id'=node->>'id' AND anchor->>'version'=node->>'version') THEN
    current:=read_scope_source(w,node->>'kind',(node->>'id')::uuid);
    IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR application_native_source_scope_allowed(w,node->>'kind',(node->>'id')::uuid,current) IS NOT TRUE THEN RETURN false;END IF;
   END IF;
  END LOOP;
 END IF;
 $source$||before);
 before:=$source$FOR dependency IN SELECT DISTINCT s.source_id FROM scope_derivation_sources s$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical raw native source worklist changed';END IF;
 definition:=replace(definition,before,$source$IF app_mode THEN
  FOR dependency IN SELECT DISTINCT s.source_kind,s.source_id FROM scope_derivation_sources s JOIN scope_derivations d
   ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id JOIN jsonb_array_elements(nodes) ancestor(value)
   ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid
   WHERE d.workspace_id=w AND (scope_source_table(s.source_kind) IS NOT NULL OR s.source_kind='entity_instance') LOOP
    current:=read_scope_source(w,dependency.source_kind,dependency.source_id);
    IF application_native_source_scope_allowed(w,dependency.source_kind,dependency.source_id,current,
      application_native_source_fields(w,dependency.source_kind,dependency.source_id)) IS NOT TRUE THEN RETURN false;END IF;
  END LOOP;
 END IF;
 $source$||before);
 EXECUTE definition;
 -- Ordinary application native projections use this complete source worklist.
 SELECT pg_get_functiondef('public.application_native_projection(text,uuid,text,text[])'::regprocedure) INTO definition;
 before:=$source$IF EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind=kind AND d.resource_id=record_id) THEN RETURN NULL; END IF;$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native projection source admission changed';END IF;
 EXECUTE replace(definition,before,$source$IF kind IN('entity','task','workspace_file') AND application_canonical_ancestry_allowed(w,kind,record_id,
   (read_scope_source(w,kind,record_id))->>'version') IS NOT TRUE THEN RETURN NULL;END IF;$source$);
END $migration$;
CREATE OR REPLACE FUNCTION read_admitted_external_source_dependencies(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(node_version text,source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;n integer;root jsonb;dependency record;current jsonb;
BEGIN
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN
  RETURN QUERY SELECT d.node_version,d.source FROM read_admitted_external_source_dependencies_before_fields(w,kinds,ids,versions) d;RETURN;
 END IF;
 context:=application_current_maxima();
 IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text OR kinds IS NULL OR ids IS NULL OR versions IS NULL
  OR cardinality(ids) NOT BETWEEN 1 AND 100 OR cardinality(kinds) IS DISTINCT FROM cardinality(ids) OR cardinality(ids) IS DISTINCT FROM cardinality(versions)
  OR array_position(kinds,NULL) IS NOT NULL OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 FOR n IN 1..cardinality(ids) LOOP
  IF kinds[n]='application_field' THEN root:=read_admitted_application_field_snapshot(w,ids[n],versions[n]);
  ELSE
   root:=read_admitted_native_scope_snapshot(w,kinds[n],ids[n]);
   IF root IS NOT NULL AND application_canonical_ancestry_allowed(w,kinds[n],ids[n],versions[n]) IS NOT TRUE THEN root:=NULL;END IF;
  END IF;
  IF root IS NULL OR root->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END LOOP;
 FOR dependency IN SELECT * FROM read_external_source_dependencies(w,kinds,ids,versions) LOOP
  IF dependency.source IS NULL OR dependency.source->>'workspaceId' IS DISTINCT FROM w::text
   OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
  current:=external_source_snapshot(w,(dependency.source->>'resourceId')::uuid);
  IF current IS NULL OR current->>'held' IS DISTINCT FROM 'false' OR current->>'version' IS DISTINCT FROM dependency.node_version THEN
   RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
  node_version:=dependency.node_version;source:=dependency.source;RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_admitted_external_source_dependencies(uuid,text[],uuid[],text[]) FROM PUBLIC;

CREATE FUNCTION application_native_query_template_catalog(w uuid,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;keys text[];custom_fields jsonb;
BEGIN
 context:=application_native_query_context(w,p_type);IF context IS NULL THEN RETURN NULL;END IF;
 SELECT ARRAY(SELECT DISTINCT field FROM (SELECT unnest(application_native_field_keys(p_type)) AS field UNION SELECT 'custom.'||f.field_key
  FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL) fields ORDER BY field) INTO keys;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'entityKind',f.entity_kind,'fieldKey',f.field_key,'label',f.label,'fieldType',f.field_type,
  'options',f.options,'isRequired',f.is_required,'position',f.position) ORDER BY f.position,f.id),'[]') INTO custom_fields
  FROM crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL;
 RETURN jsonb_build_object('typeKey',p_type,'fields',keys,'customFields',custom_fields);
END $$;
REVOKE ALL ON FUNCTION application_native_query_template_catalog(uuid,text) FROM PUBLIC;
CREATE FUNCTION application_native_record_type(w uuid,i uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE type_key text;state jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entities'::regclass WHERE r.rolname=session_user
  AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 SELECT e.kind INTO type_key FROM entities e WHERE e.workspace_id=w AND e.id=i AND e.kind IN('company','person','deal');
 IF NOT FOUND THEN RETURN NULL;END IF;
 state:=application_field_projection_state(w,'{"kind":"native","moduleKey":"native"}',type_key,i,'identity',NULL,'{}');
 IF state IS NULL THEN RETURN NULL;END IF;RETURN type_key;
END $$;
REVOKE ALL ON FUNCTION application_native_record_type(uuid,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION application_native_source_scope_allowed(uuid,text,uuid,jsonb,text[],text),application_native_source_fields(uuid,text,uuid),read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid) FROM app_user;
 GRANT EXECUTE ON FUNCTION application_native_record_type(uuid,uuid),application_native_query_template_catalog(uuid,text),read_admitted_native_scope_snapshot(uuid,text,uuid),read_admitted_external_source_dependencies(uuid,text[],uuid[],text[]) TO app_user;
END IF;END $$;
-- Reference metadata follows the same current ancestry port as a selected read.
-- It never reads business payloads or invents a live historical source.
CREATE OR REPLACE FUNCTION application_reference_scope(w uuid,origin jsonb,type_key text,p_resource_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE author uuid;source jsonb;kind text;physical uuid:=p_resource_id;
BEGIN
 IF origin->>'kind'='generic' THEN
  SELECT r.created_by,jsonb_build_object('workspaceId',r.workspace_id,'userId',NULL,'assistantId',NULL,
   'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids,
   'version',r.record_version::text,'held',scope_review_state_held('entity_instance',p_resource_id),'validTo',NULL,'retractedAt',NULL)
   INTO author,source FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=(origin->>'entityTypeId')::uuid AND r.id=p_resource_id;
  IF NOT FOUND OR scope_review_state_held('entity_instance',p_resource_id) THEN RETURN NULL;END IF;kind:='entity_instance';
 ELSE
  IF origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR type_key NOT IN('company','person','deal','task','file','workspace_member') THEN RETURN NULL;END IF;
  IF type_key='workspace_member' THEN
   IF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=p_resource_id) THEN RETURN NULL;END IF;
   RETURN jsonb_build_object('ownerId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb,'userId',NULL,'assistantId',NULL);
  END IF;
  kind:=CASE type_key WHEN 'task' THEN 'task' WHEN 'file' THEN 'workspace_file' ELSE 'entity' END;
  IF type_key='task' THEN physical:=application_task_live_id(w,p_resource_id);IF physical IS NULL THEN RETURN NULL;END IF;
   SELECT t.created_by_user_id INTO author FROM tasks t WHERE t.workspace_id=w AND t.id=physical;
  ELSIF type_key='file' THEN SELECT f.created_by_user_id INTO author FROM workspace_files f WHERE f.workspace_id=w AND f.id=physical;
  ELSE SELECT e.created_by_user_id INTO author FROM entities e WHERE e.workspace_id=w AND e.id=physical AND e.kind=type_key;END IF;
  IF NOT FOUND THEN RETURN NULL;END IF;
 END IF;
 IF kind<>'entity_instance' THEN source:=read_scope_source(w,kind,physical);END IF;
 IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL
  OR scope_review_state_held(kind,physical) OR agent_visibility_allows(w,(source->>'userId')::uuid,(source->>'assistantId')::uuid) IS NOT TRUE
  OR application_canonical_ancestry_allowed(w,kind,physical,source->>'version') IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN source||jsonb_build_object('ownerId',author);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_reference_scope(uuid,jsonb,text,uuid) FROM PUBLIC;

-- Fixed native relation registry. Resolvers are deployed code, never runtime SQL.
CREATE FUNCTION application_native_relation_target(resolver_key text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE resolver_key
  WHEN 'relation.'||encode(sha256(convert_to('companyId','UTF8')),'hex') THEN '{"field":"company_id","typeKey":"company"}'::jsonb
  WHEN 'relation.'||encode(sha256(convert_to('contactId','UTF8')),'hex') THEN '{"field":"contact_id","typeKey":"person"}'::jsonb
  WHEN 'relation.'||encode(sha256(convert_to('parentId','UTF8')),'hex') THEN '{"field":"parent_id","typeKey":"task"}'::jsonb END
$$;
REVOKE ALL ON FUNCTION application_native_relation_target(text) FROM PUBLIC;
ALTER FUNCTION application_query_catalog_selector_valid(uuid,jsonb,jsonb) RENAME TO application_query_catalog_selector_valid_before_native_relations;
REVOKE ALL ON FUNCTION application_query_catalog_selector_valid_before_native_relations(uuid,jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION application_query_catalog_selector_valid(w uuid,p_origin jsonb,selector jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND selector->>'kind'='relationship' THEN
  RETURN jsonb_typeof(selector)='object' AND selector-ARRAY['kind','resolverKey','anchorId']='{}'::jsonb
   AND selector ?& ARRAY['kind','resolverKey','anchorId'] AND jsonb_typeof(selector->'resolverKey')='string'
   AND jsonb_typeof(selector->'anchorId')='string' AND selector->>'anchorId' ~ '^[0-9a-fA-F-]{36}$'
   AND application_native_relation_target(selector->>'resolverKey') IS NOT NULL;
 END IF;
 RETURN application_query_catalog_selector_valid_before_native_relations(w,p_origin,selector);
END $$;
REVOKE ALL ON FUNCTION application_query_catalog_selector_valid(uuid,jsonb,jsonb) FROM PUBLIC;

ALTER FUNCTION application_query_anchor_reference(uuid,jsonb,text,text) RENAME TO application_query_anchor_reference_before_native_relations;
REVOKE ALL ON FUNCTION application_query_anchor_reference_before_native_relations(uuid,jsonb,text,text) FROM PUBLIC;
CREATE FUNCTION application_query_anchor_reference(w uuid,p_origin jsonb,resolver_key text,anchor_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;reference jsonb;context jsonb;layer jsonb;maximum jsonb;scope jsonb;decision jsonb;admitted boolean;
BEGIN
 IF p_origin<>'{"kind":"native","moduleKey":"native"}'::jsonb THEN RETURN application_query_anchor_reference_before_native_relations(w,p_origin,resolver_key,anchor_id);END IF;
 target:=application_native_relation_target(resolver_key);IF target IS NULL THEN RETURN NULL;END IF;PERFORM anchor_id::uuid;
 reference:=jsonb_build_object('origin',p_origin,'typeKey',target->>'typeKey','id',anchor_id::uuid,'fields','[]'::jsonb);
 IF application_field_reference_admitted(w,reference) IS NOT TRUE THEN RETURN NULL;END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN RETURN reference;END IF;
 context:=application_current_maxima();IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN NULL;END IF;
 scope:=application_reference_scope(w,p_origin,target->>'typeKey',anchor_id::uuid);IF scope IS NULL THEN RETURN NULL;END IF;
 FOR layer IN SELECT value FROM jsonb_array_elements(context->'layers') LOOP
  admitted:=false;
  FOR maximum IN SELECT value FROM jsonb_array_elements(layer->'maxima') LOOP
   IF maximum#>'{grants,0,origin}' IS DISTINCT FROM p_origin OR maximum#>>'{grants,0,typeKey}' IS DISTINCT FROM target->>'typeKey'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(maximum->'grants') issued LEFT JOIN application_access_grants current_grant ON current_grant.id=(issued->>'id')::uuid
      WHERE issued#>>'{selector,kind}'='relationship' OR current_grant.selector->>'kind'='relationship') THEN CONTINUE;END IF;
   decision:=application_path_fields(maximum,layer->'principal',w,p_origin,target->>'typeKey',anchor_id,(scope->>'ownerId')::uuid,scope->>'sensitivity',
    ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),ARRAY(SELECT jsonb_array_elements_text(scope->'projectIds'))::uuid[],(scope->>'userId')::uuid,'read');
   IF decision IS NOT NULL THEN admitted:=true;EXIT;END IF;
  END LOOP;
  IF NOT admitted THEN RETURN NULL;END IF;
 END LOOP;
 RETURN reference;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_query_anchor_reference(uuid,jsonb,text,text) FROM PUBLIC;
ALTER FUNCTION application_relationship_matches(uuid,jsonb,text,text,text,jsonb) RENAME TO application_relationship_matches_before_native_relations;
REVOKE ALL ON FUNCTION application_relationship_matches_before_native_relations(uuid,jsonb,text,text,text,jsonb) FROM PUBLIC;
CREATE FUNCTION application_relationship_matches(w uuid,origin jsonb,record_id text,resolver_key text,anchor_id text,prospective_data jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;kind text;value text;reference jsonb;
BEGIN
 IF origin<>'{"kind":"native","moduleKey":"native"}'::jsonb THEN RETURN application_relationship_matches_before_native_relations(w,origin,record_id,resolver_key,anchor_id,prospective_data);END IF;
 IF prospective_data IS NOT NULL THEN RETURN false;END IF;
 target:=application_native_relation_target(resolver_key);IF target IS NULL THEN RETURN false;END IF;
 IF target->>'field'='parent_id' THEN
  SELECT t.parent_id::text INTO value FROM tasks t WHERE t.workspace_id=w AND t.id=record_id::uuid AND t.valid_to IS NULL AND t.retracted_at IS NULL;
  IF NOT FOUND OR value IS NULL OR application_task_live_id(w,value::uuid) IS DISTINCT FROM application_task_live_id(w,anchor_id::uuid) THEN RETURN false;END IF;
  RETURN application_query_anchor_reference(w,origin,resolver_key,anchor_id) IS NOT NULL;
 END IF;
 SELECT e.kind,e.attributes->>(target->>'field') INTO kind,value FROM entities e WHERE e.workspace_id=w AND e.id=record_id::uuid AND e.valid_to IS NULL AND e.retracted_at IS NULL;
 IF NOT FOUND OR (target->>'field'='company_id' AND kind NOT IN('person','deal')) OR (target->>'field'='contact_id' AND kind<>'deal') OR value IS DISTINCT FROM anchor_id THEN RETURN false;END IF;
 reference:=application_query_anchor_reference(w,origin,resolver_key,anchor_id);RETURN reference IS NOT NULL;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_relationship_matches(uuid,jsonb,text,text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION application_native_query_relationship_fields_allowed(context jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE clause jsonb;relationship jsonb;target jsonb;key text;
BEGIN
 IF context IS NULL THEN RETURN false;END IF;
 FOR clause IN SELECT value FROM jsonb_array_elements(context#>'{formula,clauses}') LOOP
  FOR relationship IN SELECT value FROM jsonb_array_elements(clause#>'{selector,relationships}') LOOP
   target:=application_native_relation_target(relationship->>'resolverKey');
   key:=CASE target->>'field' WHEN 'company_id' THEN 'companyId' WHEN 'contact_id' THEN 'contactId' WHEN 'parent_id' THEN 'parentId' END;
   IF key IS NULL OR NOT coalesce(clause->'read' ? key,false) THEN RETURN false;END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION application_native_query_relationship_fields_allowed(jsonb) FROM PUBLIC;
ALTER FUNCTION application_native_query_context(uuid,text) RENAME TO application_native_query_context_before_relations;
REVOKE ALL ON FUNCTION application_native_query_context_before_relations(uuid,text) FROM PUBLIC;
CREATE FUNCTION application_native_query_context(w uuid,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;
BEGIN
 context:=application_native_query_context_before_relations(w,p_type);
 IF application_native_query_relationship_fields_allowed(context) IS NOT TRUE THEN RETURN NULL;END IF;RETURN context;
END $$;
REVOKE ALL ON FUNCTION application_native_query_context(uuid,text) FROM PUBLIC;

-- Empty and nonempty domains retain anchor identities and recheck them per reader.
ALTER FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) RENAME TO application_query_domain_state_before_native_relations;
REVOKE ALL ON FUNCTION application_query_domain_state_before_native_relations(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION application_query_domain_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb;frozen application_query_domains;relationship jsonb;reference jsonb;references_json jsonb:='[]';
BEGIN
 state:=application_query_domain_state_before_native_relations(w,p_origin,p_type,p_id,p_fields);
 IF state IS NULL OR p_origin<>'{"kind":"native","moduleKey":"native"}'::jsonb THEN RETURN state;END IF;
 IF application_native_query_relationship_fields_allowed(application_native_query_context_before_data_ceiling(w,p_type)) IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=p_id;
 FOR relationship IN SELECT DISTINCT relation FROM jsonb_array_elements((frozen.domain#>'{formula,clauses}')||(frozen.domain#>'{privateFormula,clauses}')) clause,
  LATERAL jsonb_array_elements(clause#>'{selector,relationships}') relation LOOP
  reference:=application_query_anchor_reference(w,p_origin,relationship->>'resolverKey',relationship->>'anchorId');IF reference IS NULL THEN RETURN NULL;END IF;
  references_json:=references_json||jsonb_build_array(reference);
 END LOOP;
 RETURN state||jsonb_build_object('references',references_json);
END $$;
REVOKE ALL ON FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;

-- Activities keep their original audience and current parent field/history floor.
CREATE FUNCTION application_crm_activity_field_state(w uuid,i uuid,selected_version text,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE activity crm_activities;parent record;source jsonb;parent_state jsonb;keys text[];decision jsonb;values_json jsonb;version text;
BEGIN
 IF fields IS NULL OR cardinality(fields)>7 OR NOT fields<@ARRAY['activityType','direction','occurredAt','subject','summary','sourceKind','metadata']
  OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT field) FROM unnest(fields) field)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entities'::regclass WHERE r.rolname=session_user
   AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 SELECT a.id,a.workspace_id,a.entity_id,a.user_id,a.assistant_id,a.sensitivity,a.compartments,a.project_ids,a.scope_held,a.scope_origin,a.source_scope_version,md5(to_jsonb(a)::text)
  INTO activity.id,activity.workspace_id,activity.entity_id,activity.user_id,activity.assistant_id,activity.sensitivity,activity.compartments,activity.project_ids,
   activity.scope_held,activity.scope_origin,activity.source_scope_version,version FROM crm_activities a WHERE a.workspace_id=w AND a.id=i;
 IF NOT FOUND OR activity.scope_held OR activity.scope_origin<>'captured' AND EXISTS(SELECT 1 FROM workspace_access_policies p WHERE p.workspace_id=w AND p.classification_mode='strict') THEN RETURN NULL;END IF;
 IF selected_version IS DISTINCT FROM version THEN RETURN NULL;END IF;
 SELECT e.id,e.kind,e.scope_version,e.created_by_user_id INTO parent FROM entities e WHERE e.workspace_id=w AND e.id=activity.entity_id AND e.kind IN('company','person','deal') AND e.valid_to IS NULL AND e.retracted_at IS NULL;
 IF NOT FOUND THEN RETURN NULL;END IF;
 keys:=application_native_source_fields(w,'entity',parent.id);IF keys IS NULL THEN RETURN NULL;END IF;
 parent_state:=application_field_projection_state(w,'{"kind":"native","moduleKey":"native"}',parent.kind,parent.id,'read',NULL,keys);
 IF parent_state IS NULL OR application_canonical_ancestry_allowed(w,'entity',parent.id,parent.scope_version::text) IS NOT TRUE THEN RETURN NULL;END IF;
 source:=jsonb_build_object('workspaceId',w,'userId',activity.user_id,'assistantId',activity.assistant_id,'sensitivity',activity.sensitivity,
  'compartments',activity.compartments,'projectIds',activity.project_ids,'version',version,'held',false,'validTo',NULL,'retractedAt',NULL);
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}',parent.kind,parent.id::text,parent.created_by_user_id,activity.sensitivity,
   activity.compartments,activity.project_ids,activity.user_id,'history');
  IF decision IS NULL OR NOT coalesce(to_jsonb(keys)<@(decision->'read'),false) THEN RETURN NULL;END IF;
 ELSIF nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN
  IF application_public_scope_allowed(w,source) IS NOT TRUE THEN RETURN NULL;END IF;
 ELSE
  IF crm_activity_scope_allows(activity,false) IS NOT TRUE OR workflow_evidence_envelope_visible(w,source) IS NOT TRUE THEN RETURN NULL;END IF;
 END IF;
 IF cardinality(fields)>0 THEN
 SELECT a.activity_type,a.direction,a.occurred_at,a.subject,a.summary,a.source_kind,a.metadata
  INTO activity.activity_type,activity.direction,activity.occurred_at,activity.subject,activity.summary,activity.source_kind,activity.metadata
  FROM crm_activities a WHERE a.workspace_id=w AND a.id=i AND md5(to_jsonb(a)::text)=version;
 IF NOT FOUND THEN RETURN NULL;END IF;
 END IF;
 values_json:=jsonb_build_object('activityType',activity.activity_type,'direction',activity.direction,'occurredAt',
  to_char(activity.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'subject',activity.subject,'summary',activity.summary,'sourceKind',activity.source_kind,'metadata',activity.metadata);
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO values_json FROM jsonb_each(values_json) WHERE key=ANY(fields);
 RETURN jsonb_build_object('values',values_json,'source',source,'recordVersion',version,'sourceKind','crm_activity','sourceId',i,'sourceVersion',version,
  'ownerId',NULL,'fieldIdentity',application_field_digest(jsonb_build_object('kind','crm_activity_v1','fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','crm_activity_v1','parentPolicy',parent_state->'policyVersion')),
  'references',jsonb_build_array(jsonb_build_object('origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',parent.kind,'id',parent.id,'fields',keys)));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_crm_activity_field_state(uuid,uuid,text,text[]) FROM PUBLIC;
ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_crm_history;
REVOKE ALL ON FUNCTION application_field_projection_state_before_crm_history(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='crm_activity' THEN
  IF p_selection<>'history' THEN RETURN NULL;END IF;
  RETURN application_crm_activity_field_state(w,p_id,p_selected_version,p_fields);
 END IF;
 RETURN application_field_projection_state_before_crm_history(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION read_native_application_crm_history(w uuid,parent_ids uuid[]) RETURNS TABLE(value jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE activity record;captured jsonb;source jsonb;version text;count_value integer:=0;
 fields text[]:=ARRAY['activityType','direction','occurredAt','subject','summary','sourceKind','metadata'];
BEGIN
 IF parent_ids IS NULL OR cardinality(parent_ids)>4096 OR array_position(parent_ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 FOR activity IN SELECT a.id,a.entity_id,a.scope_origin,a.scope_held,a.source_scope_version,md5(to_jsonb(a)::text) AS version FROM crm_activities a WHERE a.workspace_id=w AND a.entity_id=ANY(parent_ids) ORDER BY a.id LOOP
  count_value:=count_value+1;IF count_value>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  version:=activity.version;
  captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','crm_activity',activity.id,version,'history',version,fields);
  IF captured IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  source:=captured->'sources'->0;
  value:=jsonb_build_object('row',jsonb_build_object('id',activity.id,'workspace_id',w,'entity_id',activity.entity_id,
    'activity_type',captured#>'{values,activityType}','direction',captured#>'{values,direction}','occurred_at',captured#>'{values,occurredAt}',
    'subject',captured#>'{values,subject}','summary',captured#>'{values,summary}','source_kind',captured#>'{values,sourceKind}','metadata',captured#>'{values,metadata}',
    'user_id',source->'userId','assistant_id',source->'assistantId','sensitivity',source->'sensitivity','compartments',source->'compartments','project_ids',source->'projectIds',
    'scope_origin',activity.scope_origin,'scope_held',activity.scope_held,'source_scope_version',activity.source_scope_version),
    'sources',captured->'sources');RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_application_crm_history(uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_native_application_crm_history(uuid,uuid[]) TO app_user;END IF;END $$;

-- Task collections reuse the same immutable native query domain and field ports.
DO $migration$
DECLARE definition text;signature text;before text;
BEGIN
 FOR signature IN SELECT unnest(ARRAY['application_native_query_field_metadata(uuid,text,text[])',
  'application_generic_query_catalog_policy(uuid,jsonb,text)','application_native_query_context_before_data_ceiling(uuid,text)',
  'application_native_query_template_catalog(uuid,text)','application_native_query_context_before_relations(uuid,text)']) LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
  definition:=replace(definition,'p_type NOT IN(''company'',''person'',''deal'')','p_type NOT IN(''company'',''person'',''deal'',''task'')');
  definition:=replace(definition,'ceiling->>''typeKey'' NOT IN(''company'',''person'',''deal'')','ceiling->>''typeKey'' NOT IN(''company'',''person'',''deal'',''task'')');
  EXECUTE definition;
 END LOOP;
 SELECT pg_get_functiondef('application_native_query_refs(uuid,text,jsonb,jsonb,jsonb)'::regprocedure) INTO definition;
 definition:=replace(definition,'p_type NOT IN(''company'',''person'',''deal'')','p_type NOT IN(''company'',''person'',''deal'',''task'')');
 before:='SELECT e.id,e.created_by_user_id FROM entities e WHERE e.workspace_id=w AND e.kind=p_type ORDER BY e.id';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native query source metadata changed';END IF;
 definition:=replace(definition,before,$source$SELECT e.id,e.created_by_user_id,e.id AS logical_id FROM entities e WHERE e.workspace_id=w AND e.kind=p_type AND p_type<>'task'
  UNION ALL SELECT t.id,t.created_by_user_id,t.logical_id FROM tasks t WHERE t.workspace_id=w AND p_type='task' ORDER BY id$source$);
 definition:=replace(definition,'clause#>''{selector,ids}'' ? row_value.id::text','clause#>''{selector,ids}'' ? row_value.logical_id::text');
 definition:=replace(definition,'read_scope_source(w,''entity'',row_value.id)','read_scope_source(w,CASE p_type WHEN ''task'' THEN ''task'' ELSE ''entity'' END,row_value.id)');
 definition:=replace(definition,'application_canonical_ancestry_allowed(w,''entity'',row_value.id','application_canonical_ancestry_allowed(w,CASE p_type WHEN ''task'' THEN ''task'' ELSE ''entity'' END,row_value.id');
 EXECUTE definition;
END $migration$;

-- A dedicated historical dictionary keeps the actual retired source metadata.
-- Only a real retired task with a current live logical successor may pass the
-- retirement check; held/retracted source and current dictionary checks remain.
DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('application_native_field_contract_before_catalog(uuid,jsonb,text,text)'::regprocedure) INTO definition;
 definition:=replace(definition,'application_native_field_contract_before_catalog(', 'application_task_historical_contract_before_catalog(');
 definition:=replace(definition,'DECLARE canonical_origin','<<historical_contract>> DECLARE canonical_origin');
 before:='OR source->>''validTo'' IS NOT NULL';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Historical task dictionary source check changed';END IF;
 definition:=replace(definition,before,$source$OR source->>'validTo' IS NOT NULL AND NOT (
  canonical_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND canonical_type='task' AND EXISTS(
   SELECT 1 FROM tasks old JOIN tasks live ON live.workspace_id=old.workspace_id AND live.logical_id=old.logical_id
    WHERE old.workspace_id=w AND old.id=p_id::uuid AND old.valid_to IS NOT NULL AND NOT old.scope_held AND old.retracted_at IS NULL
     AND live.valid_to IS NULL AND live.retracted_at IS NULL AND NOT live.scope_held
     AND historical_contract.source=read_scope_source(w,'task',old.id)))$source$);
 EXECUTE definition;
 SELECT pg_get_functiondef('application_native_field_contract_for(uuid,jsonb,text,text)'::regprocedure) INTO definition;
 definition:=replace(definition,'application_native_field_contract_for(', 'application_task_historical_contract_for(');
 definition:=replace(definition,'application_native_field_contract_before_catalog(', 'application_task_historical_contract_before_catalog(');
 EXECUTE definition;
END $migration$;
REVOKE ALL ON FUNCTION application_task_historical_contract_before_catalog(uuid,jsonb,text,text),application_task_historical_contract_for(uuid,jsonb,text,text) FROM PUBLIC;

-- Storage encoding is metadata of an already-admitted selected amount. It
-- preserves legacy number/string DTO shape without parsing an exact decimal early.
ALTER FUNCTION read_native_application_query_candidates(uuid,text,text[],uuid,text) RENAME TO read_native_application_query_candidates_before_selected_encoding;
REVOKE ALL ON FUNCTION read_native_application_query_candidates_before_selected_encoding(uuid,text,text[],uuid,text) FROM PUBLIC;
CREATE FUNCTION read_native_application_query_candidates(w uuid,p_type text,p_fields text[],source_id uuid,source_version text)
RETURNS TABLE(id uuid,data jsonb,record_version text,sources jsonb,policy_version text,value_encodings jsonb,logical_id uuid,legacy_attributes_complete boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE captured record;encoding text;
BEGIN
 FOR captured IN SELECT * FROM read_native_application_query_candidates_before_selected_encoding(w,p_type,p_fields,source_id,source_version) LOOP
  value_encodings:='{}';
  IF p_type='deal' AND 'amount'=ANY(p_fields) THEN
   SELECT coalesce(jsonb_typeof(e.attributes->'amount'),'null') INTO encoding FROM entities e
    WHERE e.workspace_id=w AND e.id=captured.id AND e.kind='deal' AND e.scope_version::text=captured.record_version;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
   value_encodings:=jsonb_build_object('amount',CASE WHEN encoding IN('number','string','null') THEN encoding ELSE 'invalid' END);
  END IF;
  legacy_attributes_complete:=CASE WHEN p_type IN('company','person','deal') THEN application_native_crm_attributes_complete(w,captured.id) ELSE NULL END;
  logical_id:=NULL;
  IF p_type='task' THEN SELECT t.logical_id INTO logical_id FROM tasks t WHERE t.workspace_id=w AND t.id=captured.id AND t.scope_version::text=captured.record_version;
   IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;END IF;
  id:=captured.id;data:=captured.data;record_version:=captured.record_version;sources:=captured.sources;policy_version:=captured.policy_version;RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_application_query_candidates(uuid,text,text[],uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_native_application_query_candidates(uuid,text,text[],uuid,text) TO app_user;END IF;END $$;

-- Physical historical task rows are admitted against both their own envelope and
-- the current canonical logical task. Retirement alone is never a fresh grant.
CREATE FUNCTION application_task_history_field_state(w uuid,i uuid,selected_version text,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE historic record;live record;current_state jsonb;original_scope jsonb;decision jsonb;policy jsonb;values_json jsonb;keys text[];image_id uuid;permissions jsonb;context jsonb;layer jsonb;maximum jsonb;issued jsonb;grant_row application_access_grants;member_id uuid;path_allowed boolean;layer_allowed boolean;
BEGIN
 IF fields IS NULL OR cardinality(fields)>128 OR NOT fields<@application_native_field_keys('task') OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT field) FROM unnest(fields) field)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass WHERE r.rolname=session_user
   AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 SELECT t.id,t.logical_id,t.scope_version,t.retracted_at,t.created_by_user_id,t.sensitivity,t.compartments,t.project_ids,t.user_id,t.assistant_id,t.scope_held INTO historic FROM tasks t WHERE t.workspace_id=w AND t.id=i;
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF historic.scope_version::text IS DISTINCT FROM selected_version THEN
  SELECT v.id INTO image_id FROM brain_row_versions v WHERE v.workspace_id=w AND v.primitive='task' AND v.row_id=i
   AND v.before_image->>'scope_version'=selected_version ORDER BY v.version_no DESC LIMIT 1;
  IF image_id IS NULL THEN RETURN NULL;END IF;
  SELECT (v.before_image->>'id')::uuid AS id,coalesce((v.before_image->>'logical_id')::uuid,historic.logical_id) AS logical_id,
   (v.before_image->>'scope_version')::bigint AS scope_version,(v.before_image->>'retracted_at')::timestamptz AS retracted_at,
   (v.before_image->>'created_by_user_id')::uuid AS created_by_user_id,v.before_image->>'sensitivity' AS sensitivity,
   ARRAY(SELECT jsonb_array_elements_text(v.before_image->'compartments')) AS compartments,
   ARRAY(SELECT jsonb_array_elements_text(v.before_image->'project_ids'))::uuid[] AS project_ids,(v.before_image->>'user_id')::uuid AS user_id,
   (v.before_image->>'assistant_id')::uuid AS assistant_id,coalesce((v.before_image->>'scope_held')::boolean,false) AS scope_held
   INTO historic FROM brain_row_versions v WHERE v.id=image_id AND v.workspace_id=w;
 END IF;
 IF historic.retracted_at IS NOT NULL OR scope_review_state_held('task',historic.id) THEN RETURN NULL;END IF;
 SELECT t.id,t.logical_id,t.scope_version,t.created_by_user_id,t.sensitivity,t.compartments,t.project_ids,t.user_id INTO live FROM tasks t WHERE t.workspace_id=w AND t.logical_id=historic.logical_id AND t.valid_to IS NULL AND t.retracted_at IS NULL;
 IF NOT FOUND THEN RETURN NULL;END IF;
 current_state:=application_field_projection_state(w,'{"kind":"native","moduleKey":"native"}','task',live.id,'read',NULL,fields);
 IF current_state IS NULL OR application_canonical_ancestry_allowed(w,'task',live.id,live.scope_version::text) IS NOT TRUE
  OR application_canonical_ancestry_allowed(w,'task',historic.id,historic.scope_version::text) IS NOT TRUE THEN RETURN NULL;END IF;
 original_scope:=CASE WHEN image_id IS NULL THEN read_scope_source(w,'task',historic.id) ELSE jsonb_build_object('workspaceId',w,'userId',historic.user_id,'assistantId',historic.assistant_id,
  'sensitivity',historic.sensitivity,'compartments',historic.compartments,'projectIds',historic.project_ids,'version',historic.scope_version::text,'held',historic.scope_held,'validTo',NULL,'retractedAt',historic.retracted_at) END;
 IF original_scope IS NULL OR original_scope->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}','task',live.id::text,historic.created_by_user_id,historic.sensitivity,
   historic.compartments,historic.project_ids,historic.user_id,'history');
  IF decision IS NULL OR NOT coalesce(to_jsonb(fields)<@(decision->'read'),false) THEN RETURN NULL;END IF;
  decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}','task',live.id::text,live.created_by_user_id,live.sensitivity,
   live.compartments,live.project_ids,live.user_id,'history');
  IF decision IS NULL OR NOT coalesce(to_jsonb(fields)<@(decision->'read'),false) THEN RETURN NULL;END IF;
 ELSE
  IF workflow_evidence_envelope_visible(w,original_scope) IS NOT TRUE THEN RETURN NULL;END IF;
 END IF;
 policy:=application_task_historical_contract_for(w,'{"kind":"native","moduleKey":"native"}','task',historic.id::text);
 IF policy->>'registered' IS DISTINCT FROM 'false' THEN
  IF policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
  IF nullif(current_setting('app.application_id',true),'') IS NULL THEN
   permissions:=application_native_member_field_permissions(w,policy,nullif(current_setting('app.current_user_id',true),'')::uuid);
   IF permissions IS NULL OR NOT coalesce(to_jsonb(fields)<@(permissions->'read'),false) THEN RETURN NULL;END IF;
  ELSE
   context:=application_current_maxima();IF context IS NULL THEN RETURN NULL;END IF;
   FOR layer IN SELECT value FROM jsonb_array_elements(context->'layers') LOOP
    -- OAuth layer principals intentionally omit kind. The genuine current
    -- grant path below validates the subject and supplies each actual profile,
    -- issuer and member floor; a missing transport hint is never a profile.
    layer_allowed:=false;
    FOR maximum IN SELECT value FROM jsonb_array_elements(layer->'maxima') LOOP
     decision:=application_path_fields(maximum,layer->'principal',w,'{"kind":"native","moduleKey":"native"}','task',live.logical_id::text,historic.created_by_user_id,
      historic.sensitivity,historic.compartments,historic.project_ids,historic.user_id,'history');
     IF decision IS NULL OR NOT coalesce(to_jsonb(fields)<@(decision->'read'),false) THEN CONTINUE;END IF;
     path_allowed:=true;
     FOR issued IN SELECT value FROM jsonb_array_elements(maximum->'grants') LOOP
      SELECT * INTO grant_row FROM application_access_grants g WHERE g.id=(issued->>'id')::uuid AND g.workspace_id=w;
      IF NOT FOUND THEN path_allowed:=false;EXIT;END IF;
      permissions:=application_native_member_field_permissions(w,policy,grant_row.issued_by_user_id);
      IF permissions IS NULL OR NOT coalesce(to_jsonb(fields)<@(permissions->'read'),false) THEN path_allowed:=false;EXIT;END IF;
      permissions:=CASE WHEN grant_row.principal_kind='member' THEN application_native_member_field_permissions(w,policy,grant_row.principal_user_id)
       ELSE application_native_nonmember_field_permissions(policy,grant_row.principal_kind) END;
      IF permissions IS NULL OR NOT coalesce(to_jsonb(fields)<@(permissions->'read'),false) THEN path_allowed:=false;EXIT;END IF;
      IF grant_row.principal_kind<>'member' AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=grant_row.principal_user_id) THEN
       permissions:=application_native_member_field_permissions(w,policy,grant_row.principal_user_id);
       IF permissions IS NULL OR NOT coalesce(to_jsonb(fields)<@(permissions->'read'),false) THEN path_allowed:=false;EXIT;END IF;
      END IF;
     END LOOP;
     IF path_allowed THEN layer_allowed:=true;EXIT;END IF;
    END LOOP;
    IF NOT layer_allowed THEN RETURN NULL;END IF;
   END LOOP;
  END IF;
 END IF;
 IF image_id IS NULL THEN SELECT application_native_task_values(to_jsonb(t)) INTO values_json FROM tasks t WHERE t.workspace_id=w AND t.id=historic.id;
 ELSE SELECT application_native_task_values(v.before_image) INTO values_json FROM brain_row_versions v WHERE v.workspace_id=w AND v.id=image_id;END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO values_json FROM jsonb_each(values_json) WHERE key=ANY(fields);
 RETURN jsonb_build_object('values',values_json,'source',original_scope,'recordVersion',historic.scope_version::text,'sourceKind','task','sourceId',historic.id,
  'sourceVersion',historic.scope_version::text,'ownerId',historic.created_by_user_id,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','task_physical_history_v1','fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','task_physical_history_v1','currentPolicy',current_state->'policyVersion','originalPolicy',policy->'policyVersion')),
  'references',jsonb_build_array(jsonb_build_object('origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey','task','id',live.id,'fields',fields))
   ||application_field_references(w,'{"kind":"native","moduleKey":"native"}','task',values_json));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_task_history_field_state(uuid,uuid,text,text[]) FROM PUBLIC;
ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_task_history;
REVOKE ALL ON FUNCTION application_field_projection_state_before_task_history(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='task_history' THEN
  IF p_selection<>'history' THEN RETURN NULL;END IF;RETURN application_task_history_field_state(w,p_id,p_selected_version,p_fields);
 END IF;
 RETURN application_field_projection_state_before_task_history(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION read_native_application_task_history(w uuid,physical_id uuid,fields text[],selected_version text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE task_row record;captured jsonb;physical_parent uuid;
BEGIN
 SELECT t.id,t.logical_id,t.scope_version INTO task_row FROM tasks t WHERE t.workspace_id=w AND t.id=physical_id;
 IF NOT FOUND THEN RETURN NULL;END IF;selected_version:=coalesce(selected_version,task_row.scope_version::text);
 IF application_task_history_field_state(w,physical_id,selected_version,fields) IS NULL THEN RETURN NULL;END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','task_history',physical_id,
  selected_version,'history',selected_version,fields);
 IF 'parentId'=ANY(fields) THEN
  IF selected_version=task_row.scope_version::text THEN SELECT t.parent_id INTO physical_parent FROM tasks t WHERE t.workspace_id=w AND t.id=physical_id;
  ELSE SELECT (v.before_image->>'parent_id')::uuid INTO physical_parent FROM brain_row_versions v WHERE v.workspace_id=w AND v.primitive='task' AND v.row_id=physical_id
   AND v.before_image->>'scope_version'=selected_version ORDER BY v.version_no DESC LIMIT 1;END IF;
  captured:=captured||jsonb_build_object('physicalParentId',physical_parent);
 END IF;
 RETURN captured||jsonb_build_object('id',physical_id,'logicalId',task_row.logical_id,'recordVersion',selected_version);
END $$;
REVOKE ALL ON FUNCTION read_native_application_task_history(uuid,uuid,text[],text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_native_application_task_history(uuid,uuid,text[],text) TO app_user;END IF;END $$;

ALTER FUNCTION application_native_field_keys(text) RENAME TO application_native_field_keys_before_participants;
REVOKE ALL ON FUNCTION application_native_field_keys_before_participants(text) FROM PUBLIC;
CREATE FUNCTION application_native_field_keys(p_type text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT application_native_field_keys_before_participants(p_type)||CASE p_type WHEN 'deal' THEN ARRAY['participants'] ELSE '{}'::text[] END
$$;
REVOKE ALL ON FUNCTION application_native_field_keys(text) FROM PUBLIC;
ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_participants;
REVOKE ALL ON FUNCTION application_field_projection_state_before_participants(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb;policy jsonb;decision jsonb;parent entities;participants jsonb;participant jsonb;reference jsonb;references_json jsonb;
BEGIN
 IF p_origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR p_type<>'deal' OR p_selection='query_domain' OR NOT 'participants'=ANY(p_fields) THEN
  RETURN application_field_projection_state_before_participants(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
 END IF;
 IF p_selection='history' OR p_selected_version IS NOT NULL THEN RETURN NULL;END IF;
 policy:=application_current_native_field_policy(w,p_origin,p_type,p_id);
 IF policy->>'registered' IS DISTINCT FROM 'false' AND (policy->>'held' IS DISTINCT FROM 'false' OR NOT coalesce(to_jsonb(p_fields)<@(policy->'readFields'),false)) THEN RETURN NULL;END IF;
 state:=application_field_projection_state_before_participants(w,p_origin,p_type,p_id,p_selection,p_selected_version,array_remove(p_fields,'participants'));
 IF state IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO parent FROM entities e WHERE e.workspace_id=w AND e.id=p_id AND e.kind='deal';IF NOT FOUND THEN RETURN NULL;END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  decision:=application_resource_fields(w,p_origin,'deal',p_id::text,parent.created_by_user_id,parent.sensitivity,parent.compartments,parent.project_ids,parent.user_id,
   CASE p_selection WHEN 'identity' THEN 'read' ELSE p_selection END);
  IF decision IS NULL OR NOT coalesce(decision->'read' ? 'participants',false) THEN RETURN NULL;END IF;
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('contactId',dc.contact_id,'role',dc.role,'isPrimary',dc.is_primary,
  'createdAt',to_char(dc.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY dc.is_primary DESC,dc.created_at,dc.contact_id),'[]') INTO participants
  FROM crm_deal_contacts dc WHERE dc.workspace_id=w AND dc.deal_id=p_id;
 IF jsonb_array_length(participants)>256 THEN RETURN NULL;END IF;references_json:=state->'references';
 FOR participant IN SELECT value FROM jsonb_array_elements(participants) LOOP
  reference:=jsonb_build_object('origin',p_origin,'typeKey','person','id',participant->>'contactId','fields','[]'::jsonb);
  IF application_field_reference_admitted(w,reference) IS NOT TRUE THEN RETURN NULL;END IF;
  references_json:=references_json||jsonb_build_array(reference);
 END LOOP;
 RETURN state||jsonb_build_object('values',(state->'values')||jsonb_build_object('participants',participants),'references',references_json,
  'fieldIdentity',application_field_digest(jsonb_build_object('base',state->'fieldIdentity','participants','native-participants-v1')),
  'policyVersion',application_field_digest(jsonb_build_object('base',state->'policyVersion','participants','native-participants-v1')));
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;

CREATE FUNCTION read_native_application_task_identity(w uuid,p_id uuid,resolve boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE physical uuid:=p_id;row_value record;state jsonb;
BEGIN
 IF resolve THEN physical:=application_task_live_id(w,p_id);IF physical IS NULL THEN RETURN NULL;END IF;END IF;
 SELECT t.id,t.logical_id,t.scope_version INTO row_value FROM tasks t WHERE t.workspace_id=w AND t.id=physical AND t.valid_to IS NULL AND t.retracted_at IS NULL;
 IF NOT FOUND THEN RETURN NULL;END IF;
 state:=application_field_projection_state(w,'{"kind":"native","moduleKey":"native"}','task',physical,'read',NULL,'{}');
 IF state IS NULL OR application_canonical_ancestry_allowed(w,'task',physical,row_value.scope_version::text) IS NOT TRUE THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',physical,'logicalId',row_value.logical_id,'version',row_value.scope_version::text,'scope',state->'source');
END $$;
REVOKE ALL ON FUNCTION read_native_application_task_identity(uuid,uuid,boolean) FROM PUBLIC;
CREATE FUNCTION read_native_application_task_history_refs(w uuid,p_id uuid,fields text[]) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE logical uuid;row_value record;state jsonb;
BEGIN
 IF application_task_history_domain_scan(w,p_id,fields) IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 SELECT t.logical_id INTO logical FROM tasks t WHERE t.workspace_id=w AND t.id=p_id;
 IF NOT FOUND THEN RETURN;END IF;
 FOR row_value IN SELECT DISTINCT rows.id,rows.logical_id,rows.scope_version,rows.valid_from FROM (
  SELECT t.id,t.logical_id,t.scope_version,t.valid_from FROM tasks t WHERE t.workspace_id=w AND t.logical_id=logical
  UNION ALL SELECT t.id,t.logical_id,(v.before_image->>'scope_version')::bigint,coalesce((v.before_image->>'valid_from')::timestamptz,v.valid_from)
   FROM brain_row_versions v JOIN tasks t ON t.workspace_id=v.workspace_id AND t.id=v.row_id WHERE v.workspace_id=w AND v.primitive='task' AND t.logical_id=logical
   AND v.before_image->>'scope_version' IS NOT NULL) rows ORDER BY rows.valid_from,rows.id,rows.scope_version LOOP
  state:=application_task_history_field_state(w,row_value.id,row_value.scope_version::text,fields);IF state IS NULL THEN CONTINUE;END IF;
  RETURN NEXT jsonb_build_object('id',row_value.id,'logicalId',row_value.logical_id,'version',row_value.scope_version::text,'validFrom',row_value.valid_from,'scope',state->'source');
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_application_task_history_refs(uuid,uuid,text[]) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_native_application_task_identity(uuid,uuid,boolean),read_native_application_task_history_refs(uuid,uuid,text[]) TO app_user;
END IF;END $$;

CREATE FUNCTION application_crm_configuration_read_allowed(w uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;owner record;catalog jsonb;admitted jsonb;context jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.crm_pipelines'::regclass WHERE r.rolname=session_user
  AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN false;END IF;
 IF nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN
  RETURN application_public_share_allowed(w) AND NOT EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w
   AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type IN('company','person','deal'));
 END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  context:=application_current_maxima();IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN false;END IF;
  admitted:=application_current_query_catalog(w,'{"kind":"native","moduleKey":"native"}','deal');
  IF admitted IS NULL THEN admitted:=application_current_query_catalog(w,'{"kind":"native","moduleKey":"native"}','company');END IF;
  IF admitted IS NULL THEN admitted:=application_current_query_catalog(w,'{"kind":"native","moduleKey":"native"}','person');END IF;
  IF admitted IS NULL THEN RETURN false;END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor) OR application_native_query_bounds(w) IS NULL THEN RETURN false;END IF;
 END IF;
 FOR owner IN SELECT * FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}' AND o.resource_type IN('company','person','deal') LOOP
  catalog:=application_native_field_catalog_for(w,owner.origin,owner.resource_type);
  IF catalog->>'registered' IS DISTINCT FROM 'true' OR catalog->>'held' IS DISTINCT FROM 'false' THEN RETURN false;END IF;
  IF nullif(current_setting('app.application_id',true),'') IS NULL AND read_native_application_field_catalog(w,owner.origin,owner.resource_type) IS NULL THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_crm_configuration_read_allowed(uuid) FROM PUBLIC;
CREATE FUNCTION application_crm_configuration_field_state(w uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE config jsonb;revision text;source jsonb;
BEGIN
 IF fields IS NULL OR NOT fields<@ARRAY['config'] OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)>1
  OR application_crm_configuration_read_allowed(w) IS NOT TRUE THEN RETURN NULL;END IF;
 revision:=application_native_crm_configuration_revision(w);IF revision IS NULL THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('pipelines',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'isDefault',p.is_default,'position',p.position,
  'archivedAt',p.archived_at,'stages',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'pipelineId',s.pipeline_id,'name',s.name,'legacyKey',s.legacy_key,
   'category',s.category,'position',s.position,'probability',s.probability,'requiredFields',s.required_fields,'archivedAt',s.archived_at)
   ORDER BY s.archived_at NULLS FIRST,s.position,s.created_at),'[]') FROM crm_pipeline_stages s WHERE s.workspace_id=w AND s.pipeline_id=p.id)) ORDER BY p.archived_at NULLS FIRST,p.position,p.created_at),'[]') FROM crm_pipelines p WHERE p.workspace_id=w),
  'fields',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'entityKind',f.entity_kind,'fieldKey',f.field_key,'label',f.label,'fieldType',f.field_type,
   'options',f.options,'isRequired',f.is_required,'position',f.position,'archivedAt',f.archived_at) ORDER BY f.archived_at NULLS FIRST,f.entity_kind,f.position,f.created_at),'[]') FROM crm_field_definitions f WHERE f.workspace_id=w)) INTO config;
 source:=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb,
  'version',revision,'held',false,'validTo',NULL,'retractedAt',NULL);
 RETURN jsonb_build_object('values',CASE WHEN 'config'=ANY(fields) THEN jsonb_build_object('config',config) ELSE '{}'::jsonb END,'source',source,
  'recordVersion',revision,'sourceKind','crm_configuration','sourceId',w,'sourceVersion',revision,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','crm-configuration-v1','fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','crm-configuration-v1','revision',revision)),'references','[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION application_crm_configuration_field_state(uuid,text[]) FROM PUBLIC;
ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_crm_configuration;
REVOKE ALL ON FUNCTION application_field_projection_state_before_crm_configuration(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='crm_configuration' THEN
  IF p_id<>w OR p_selection NOT IN('read','identity') OR p_selected_version IS NOT NULL THEN RETURN NULL;END IF;
  RETURN application_crm_configuration_field_state(w,p_fields);
 END IF;
 RETURN application_field_projection_state_before_crm_configuration(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION read_native_application_crm_configuration(w uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb;
BEGIN
 state:=application_crm_configuration_field_state(w,ARRAY['config']);IF state IS NULL THEN RETURN NULL;END IF;
 RETURN observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','crm_configuration',w,state->>'recordVersion','read',NULL,ARRAY['config']);
END $$;
REVOKE ALL ON FUNCTION read_native_application_crm_configuration(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION application_crm_configuration_read_allowed(uuid),read_native_application_crm_configuration(uuid) TO app_user;END IF;END $$;

CREATE FUNCTION application_public_share_allowed(w uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE root uuid:=nullif(current_setting('app.public_share_root',true),'')::uuid;mode text:=current_setting('app.public_share_mode',true);page saved_views;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF root IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entities'::regclass WHERE r.rolname=session_user
   AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN false;END IF;
 SELECT p.* INTO page FROM saved_views p WHERE p.id=root AND p.workspace_id=w AND p.shared_project_id IS NULL;
 IF NOT FOUND THEN RETURN false;END IF;
 IF mode='preview' THEN RETURN EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor
  AND (page.created_by=actor OR m.role IN('owner','admin')));END IF;
 IF actor IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid OR page.clearance<>'public'
  OR NOT EXISTS(SELECT 1 FROM workspaces wk WHERE wk.id=w AND wk.external_sharing_enabled) THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM page_grants g WHERE g.page_id=root AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
  AND ((mode='link' AND g.principal_type='link' AND g.principal_ref=current_setting('app.public_share_token_hash',true)) OR mode='published' AND g.principal_type='published'));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_public_share_allowed(uuid) FROM PUBLIC;
CREATE FUNCTION application_public_scope_allowed(w uuid,source jsonb) RETURNS boolean
LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(application_public_share_allowed(w) AND entity_derivation_envelope_valid(source) AND source->>'workspaceId'=w::text
  AND source->>'sensitivity'='public' AND source->'compartments'='[]'::jsonb AND source->'projectIds'='[]'::jsonb
  AND source->>'userId' IS NULL,false)
$$;
REVOKE ALL ON FUNCTION application_public_scope_allowed(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION application_reader_envelope_visible(w uuid,source jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN application_public_scope_allowed(w,source);END IF;
 RETURN workflow_evidence_envelope_visible(w,source);
END $$;
REVOKE ALL ON FUNCTION application_reader_envelope_visible(uuid,jsonb) FROM PUBLIC;
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure) INTO definition;
 IF position('workflow_evidence_envelope_visible(w,' IN definition)=0 THEN RAISE EXCEPTION 'Canonical source envelope reader changed';END IF;
 EXECUTE replace(definition,'workflow_evidence_envelope_visible(w,','application_reader_envelope_visible(w,');
END $migration$;
ALTER FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) RENAME TO read_admitted_native_scope_snapshot_before_public_share;
REVOKE ALL ON FUNCTION read_admitted_native_scope_snapshot_before_public_share(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION read_admitted_native_scope_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;type_key text;canonical_origin jsonb;
BEGIN
 IF nullif(current_setting('app.public_share_root',true),'') IS NULL THEN RETURN read_admitted_native_scope_snapshot_before_public_share(w,k,i);END IF;
 IF application_public_share_allowed(w) IS NOT TRUE THEN RETURN '{"held":true}';END IF;
 IF k='entity' THEN SELECT e.kind INTO type_key FROM entities e WHERE e.workspace_id=w AND e.id=i AND e.kind IN('company','person','deal');canonical_origin:='{"kind":"native","moduleKey":"native"}';
 ELSIF k='task' THEN type_key:='task';canonical_origin:='{"kind":"native","moduleKey":"native"}';
 ELSIF k='entity_instance' THEN SELECT 'record.'||e.entity_type_id,jsonb_build_object('kind','generic','entityTypeId',e.entity_type_id) INTO type_key,canonical_origin FROM entity_instances e WHERE e.workspace_id=w AND e.id=i;
 ELSE RETURN '{"held":true}';END IF;
 IF type_key IS NULL OR EXISTS(SELECT 1 FROM application_native_resource_owners o WHERE o.workspace_id=w AND o.origin=canonical_origin AND o.resource_type=type_key) THEN RETURN '{"held":true}';END IF;
 source:=read_scope_source(w,k,i);
 IF source IS NULL THEN RETURN NULL;END IF;
 IF source->>'held' IS DISTINCT FROM 'false' OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL OR application_public_scope_allowed(w,source) IS NOT TRUE THEN RETURN '{"held":true}';END IF;
 RETURN source;
END $$;
REVOKE ALL ON FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) FROM PUBLIC;
ALTER FUNCTION application_native_query_context_before_data_ceiling(uuid,text) RENAME TO application_native_query_context_before_public_share;
REVOKE ALL ON FUNCTION application_native_query_context_before_public_share(uuid,text) FROM PUBLIC;
CREATE FUNCTION application_native_query_context_before_data_ceiling(w uuid,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy jsonb;formula jsonb;
BEGIN
 IF nullif(current_setting('app.public_share_root',true),'') IS NULL THEN RETURN application_native_query_context_before_public_share(w,p_type);END IF;
 IF application_public_share_allowed(w) IS NOT TRUE OR p_type NOT IN('company','person','deal','task') THEN RETURN NULL;END IF;
 policy:=application_generic_query_catalog_policy(w,'{"kind":"native","moduleKey":"native"}',p_type);
 IF policy->>'nativeDefault' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 formula:=jsonb_build_object('kind','application_query','version',1,'clauses',jsonb_build_array(jsonb_build_object('scope',jsonb_build_object('kind','native_legacy','tier',1,'compartments','[]'::jsonb,'projectIds','[]'::jsonb),
  'read',policy#>'{metadata,fieldKeys}','selector',jsonb_build_object('ids','null'::jsonb,'ownerId',NULL,'relationships','[]'::jsonb,'empty',false))));
 RETURN jsonb_build_object('policy',policy,'read',policy#>'{metadata,fieldKeys}','formula',formula,'privateFormula',jsonb_build_object('kind','application_query','version',1,'clauses','[]'::jsonb),
  'visibility',jsonb_build_object('userId',NULL,'assistants','null'::jsonb));
END $$;
REVOKE ALL ON FUNCTION application_native_query_context_before_data_ceiling(uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_admitted_native_scope_snapshot(uuid,text,uuid) TO app_user;
END IF;END $$;

-- History domain metadata records the original structural query footprint, not
-- a former reader or an allow decision. Every reader proves it again currently.
CREATE FUNCTION application_crm_history_domain_scan(w uuid,parents jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent jsonb;context jsonb;state jsonb;activity record;source jsonb;formula jsonb;clause jsonb;matched boolean;
 candidates jsonb:='[]';policies jsonb:='[]';references_json jsonb:='[]';fields text[];count_value integer:=0;
BEGIN
 IF jsonb_typeof(parents) IS DISTINCT FROM 'array' OR jsonb_array_length(parents)>4096 THEN RETURN NULL;END IF;
 FOR parent IN SELECT value FROM jsonb_array_elements(parents) LOOP
  IF parent-ARRAY['id','typeKey','fields','formula','privateFormula','visibility']<>'{}' OR NOT parent ?& ARRAY['id','typeKey','fields','formula','privateFormula','visibility'] THEN RETURN NULL;END IF;
  fields:=ARRAY(SELECT jsonb_array_elements_text(parent->'fields'));
  context:=application_native_query_context_before_data_ceiling(w,parent->>'typeKey');
  IF context IS NULL OR application_query_domain_contains(context->'formula',parent->'formula',fields) IS NOT TRUE
   OR application_query_domain_contains(context->'privateFormula',parent->'privateFormula',fields) IS NOT TRUE
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(parent#>'{privateFormula,clauses}') c WHERE c#>>'{selector,empty}' IS DISTINCT FROM 'true')
    AND context#>>'{visibility,userId}' IS DISTINCT FROM parent#>>'{visibility,userId}'
   OR application_query_set_intersection(context#>'{visibility,assistants}',parent#>'{visibility,assistants}') IS DISTINCT FROM parent#>'{visibility,assistants}' THEN RETURN NULL;END IF;
  state:=application_field_projection_state(w,'{"kind":"native","moduleKey":"native"}',parent->>'typeKey',(parent->>'id')::uuid,'read',NULL,fields);
  IF state IS NULL OR application_canonical_ancestry_allowed(w,'entity',(parent->>'id')::uuid,state->>'recordVersion') IS NOT TRUE THEN RETURN NULL;END IF;
  policies:=policies||jsonb_build_array(jsonb_build_object('id',parent->'id','policy',state->'policyVersion','catalog',context#>'{policy,fingerprint}'));
  references_json:=references_json||jsonb_build_array(jsonb_build_object('origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey',parent->'typeKey','id',parent->'id','fields','[]'::jsonb));
  FOR activity IN SELECT a.id,a.user_id,a.assistant_id,a.sensitivity,a.compartments,a.project_ids,md5(to_jsonb(a)::text) AS version FROM crm_activities a
   WHERE a.workspace_id=w AND a.entity_id=(parent->>'id')::uuid ORDER BY a.id LOOP
   count_value:=count_value+1;IF count_value>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
   IF activity.assistant_id IS NOT NULL AND parent#>'{visibility,assistants}'<>'null' AND NOT parent#>'{visibility,assistants}' ? activity.assistant_id::text THEN CONTINUE;END IF;
   IF activity.user_id IS NULL THEN formula:=parent->'formula';
   ELSIF activity.user_id::text=parent#>>'{visibility,userId}' THEN formula:=parent->'privateFormula';ELSE CONTINUE;END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',activity.user_id,'assistantId',activity.assistant_id,'sensitivity',activity.sensitivity,'compartments',activity.compartments,'projectIds',activity.project_ids);
   matched:=false;
   FOR clause IN SELECT value FROM jsonb_array_elements(formula->'clauses') LOOP
    IF clause#>>'{selector,empty}' IS DISTINCT FROM 'true' AND application_query_scope_admits_point(clause->'scope',source) THEN matched:=true;EXIT;END IF;
   END LOOP;
   IF NOT matched OR application_crm_activity_field_state(w,activity.id,activity.version,'{}') IS NULL THEN CONTINUE;END IF;
   candidates:=candidates||jsonb_build_array(jsonb_build_object('id',activity.id,'version',activity.version));
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('candidates',candidates,'policies',policies,'references',references_json);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_crm_history_domain_scan(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION application_crm_history_domain_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains;current_state jsonb;
BEGIN
 IF fields IS DISTINCT FROM '{}'::text[] THEN RETURN NULL;END IF;
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=i AND d.origin='{"kind":"native","moduleKey":"native"}' AND d.type_key='crm_history_domain';
 IF NOT FOUND OR frozen.domain->>'kind'<>'crm_history_domain_v1' OR frozen.domain-ARRAY['kind','parents','candidates']<>'{}' THEN RETURN NULL;END IF;
 current_state:=application_crm_history_domain_scan(w,frozen.domain->'parents');
 IF current_state IS NULL OR current_state->'candidates' IS DISTINCT FROM frozen.domain->'candidates' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb),
  'recordVersion','1','sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','crm_history_domain_v1','identity',frozen.identity)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','crm_history_domain_v1','identity',frozen.identity,'policies',current_state->'policies')),'references',current_state->'references');
END $$;
REVOKE ALL ON FUNCTION application_crm_history_domain_state(uuid,uuid,text[]) FROM PUBLIC;
CREATE OR REPLACE FUNCTION read_native_application_crm_history(w uuid,parent_ids uuid[]) RETURNS TABLE(value jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent_id uuid;type_key text;context jsonb;fields text[];parents jsonb:='[]';scanned jsonb;domain jsonb;identity_value text;domain_id uuid;frozen application_query_domains;
 captured jsonb;activity record;candidate jsonb;source jsonb;history_fields text[]:=ARRAY['activityType','direction','occurredAt','subject','summary','sourceKind','metadata'];
BEGIN
 IF parent_ids IS NULL OR cardinality(parent_ids)>4096 OR array_position(parent_ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 FOR parent_id IN SELECT DISTINCT id FROM unnest(parent_ids) id ORDER BY id LOOP
  type_key:=application_native_record_type(w,parent_id);IF type_key IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  fields:=application_native_source_fields(w,'entity',parent_id);context:=application_native_query_context(w,type_key);
  IF fields IS NULL OR context IS NULL OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  parents:=parents||jsonb_build_array(jsonb_build_object('id',parent_id,'typeKey',type_key,'fields',fields,'formula',context->'formula','privateFormula',context->'privateFormula','visibility',context->'visibility'));
 END LOOP;
 scanned:=application_crm_history_domain_scan(w,parents);IF scanned IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 domain:=jsonb_build_object('kind','crm_history_domain_v1','parents',parents,'candidates',scanned->'candidates');
 identity_value:=application_field_digest(jsonb_build_object('kind','crm_history_domain_v1','workspaceId',w,'domain',domain));domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity) VALUES(domain_id,w,'{"kind":"native","moduleKey":"native"}','crm_history_domain','1',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=domain_id;
 IF NOT FOUND OR frozen.domain IS DISTINCT FROM domain OR frozen.identity IS DISTINCT FROM identity_value THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','crm_history_domain',domain_id,'1','query_domain',NULL,'{}');
 IF captured IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 value:=jsonb_build_object('row',NULL,'sources',captured->'sources');RETURN NEXT;
 FOR candidate IN SELECT item FROM jsonb_array_elements(scanned->'candidates') item LOOP
  captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','crm_activity',(candidate->>'id')::uuid,candidate->>'version','history',candidate->>'version',history_fields);
  IF captured IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  SELECT a.entity_id,a.scope_origin,a.scope_held,a.source_scope_version INTO activity FROM crm_activities a WHERE a.workspace_id=w AND a.id=(candidate->>'id')::uuid;
  source:=captured->'sources'->0;
  value:=jsonb_build_object('row',jsonb_build_object('id',candidate->'id','workspace_id',w,'entity_id',activity.entity_id,
   'activity_type',captured#>'{values,activityType}','direction',captured#>'{values,direction}','occurred_at',captured#>'{values,occurredAt}',
   'subject',captured#>'{values,subject}','summary',captured#>'{values,summary}','source_kind',captured#>'{values,sourceKind}','metadata',captured#>'{values,metadata}',
   'user_id',source->'userId','assistant_id',source->'assistantId','sensitivity',source->'sensitivity','compartments',source->'compartments','project_ids',source->'projectIds',
   'scope_origin',activity.scope_origin,'scope_held',activity.scope_held,'source_scope_version',activity.source_scope_version),'sources',captured->'sources');RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_application_crm_history(uuid,uuid[]) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_native_application_crm_history(uuid,uuid[]) TO app_user;END IF;END $$;

-- Exact task history collection evidence is independent of query authority.
-- Only metadata is retained in the existing immutable observation registry.
CREATE FUNCTION application_task_history_domain_scan(w uuid,p_id uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE logical uuid;live record;row_value record;state jsonb;context jsonb;candidates jsonb:='[]';policies jsonb:='[]';references_json jsonb:='[]';count_value integer:=0;
BEGIN
 IF fields IS NULL OR cardinality(fields)>128 OR NOT fields<@application_native_field_keys('task') OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT field) FROM unnest(fields) field) THEN RETURN NULL;END IF;
 SELECT t.logical_id INTO logical FROM tasks t WHERE t.workspace_id=w AND t.id=p_id;
 IF NOT FOUND THEN
  -- An absent app source cannot manufacture row/history field authority.
  IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN RETURN NULL;END IF;
  context:=application_native_query_context(w,'task');
  IF context IS NULL OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('logicalId',p_id,'known',false,'candidates',candidates,'references',references_json,
   'policies',jsonb_build_array(jsonb_build_object('catalog',context#>'{policy,fingerprint}','formula',context->'formula','privateFormula',context->'privateFormula','visibility',context->'visibility')));
 END IF;
 SELECT t.id,t.scope_version INTO live FROM tasks t WHERE t.workspace_id=w AND t.logical_id=logical AND t.valid_to IS NULL AND t.retracted_at IS NULL;
 IF NOT FOUND THEN RETURN NULL;END IF;
 -- The live full history footprint must be admitted before an empty/excluded
 -- collection can claim absence. Per-version original floors remain separate.
 state:=application_task_history_field_state(w,live.id,live.scope_version::text,fields);
 IF state IS NULL THEN RETURN NULL;END IF;
 references_json:=jsonb_build_array(jsonb_build_object('origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey','task','id',live.id,'fields','[]'::jsonb));
 FOR row_value IN SELECT DISTINCT rows.id,rows.scope_version,rows.valid_from FROM (
  SELECT t.id,t.scope_version,t.valid_from FROM tasks t WHERE t.workspace_id=w AND t.logical_id=logical
  UNION ALL SELECT t.id,(v.before_image->>'scope_version')::bigint,coalesce((v.before_image->>'valid_from')::timestamptz,v.valid_from)
   FROM brain_row_versions v JOIN tasks t ON t.workspace_id=v.workspace_id AND t.id=v.row_id WHERE v.workspace_id=w AND v.primitive='task' AND t.logical_id=logical
    AND v.before_image->>'scope_version' IS NOT NULL) rows ORDER BY rows.valid_from,rows.id,rows.scope_version LOOP
  count_value:=count_value+1;IF count_value>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  state:=application_task_history_field_state(w,row_value.id,row_value.scope_version::text,fields);IF state IS NULL THEN CONTINUE;END IF;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('id',row_value.id,'version',row_value.scope_version::text));
  policies:=policies||jsonb_build_array(jsonb_build_object('id',row_value.id,'version',row_value.scope_version::text,'policy',state->'policyVersion'));
 END LOOP;
 RETURN jsonb_build_object('logicalId',logical,'known',true,'candidates',candidates,'policies',policies,'references',references_json);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_task_history_domain_scan(uuid,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION application_task_history_domain_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains;current_state jsonb;selected_fields text[];
BEGIN
 IF fields IS DISTINCT FROM '{}'::text[] THEN RETURN NULL;END IF;
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=i AND d.origin='{"kind":"native","moduleKey":"native"}' AND d.type_key='task_history_domain';
 IF NOT FOUND OR frozen.domain->>'kind'<>'task_history_domain_v1' OR frozen.domain-ARRAY['kind','logicalId','fields','known','candidates']<>'{}' THEN RETURN NULL;END IF;
 selected_fields:=ARRAY(SELECT jsonb_array_elements_text(frozen.domain->'fields'));
 current_state:=application_task_history_domain_scan(w,(frozen.domain->>'logicalId')::uuid,selected_fields);
 IF current_state IS NULL OR current_state->'logicalId' IS DISTINCT FROM frozen.domain->'logicalId' OR current_state->'known' IS DISTINCT FROM frozen.domain->'known'
  OR current_state->'candidates' IS DISTINCT FROM frozen.domain->'candidates' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb),
  'recordVersion','1','sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','task_history_domain_v1','identity',frozen.identity)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','task_history_domain_v1','identity',frozen.identity,'policies',current_state->'policies')),'references',current_state->'references');
END $$;
REVOKE ALL ON FUNCTION application_task_history_domain_state(uuid,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION observe_native_application_task_history_domain(w uuid,p_id uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scanned jsonb;domain jsonb;identity_value text;domain_id uuid;frozen application_query_domains;captured jsonb;
BEGIN
 scanned:=application_task_history_domain_scan(w,p_id,fields);IF scanned IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 domain:=jsonb_build_object('kind','task_history_domain_v1','logicalId',scanned->'logicalId','fields',ARRAY(SELECT field FROM unnest(fields) field ORDER BY field),'known',scanned->'known','candidates',scanned->'candidates');
 identity_value:=application_field_digest(jsonb_build_object('kind','task_history_domain_v1','workspaceId',w,'domain',domain));domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity) VALUES(domain_id,w,'{"kind":"native","moduleKey":"native"}','task_history_domain','1',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=domain_id;
 IF NOT FOUND OR frozen.domain IS DISTINCT FROM domain OR frozen.identity IS DISTINCT FROM identity_value THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','task_history_domain',domain_id,'1','query_domain',NULL,'{}');
 IF captured IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;RETURN captured;
END $$;
REVOKE ALL ON FUNCTION observe_native_application_task_history_domain(uuid,uuid,text[]) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION observe_native_application_task_history_domain(uuid,uuid,text[]) TO app_user;END IF;END $$;

-- Current task references use stable logical IDs while source/CAS captures
-- retain the actual physical source row. Historical selections stay separate.
ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_task_references;
REVOKE ALL ON FUNCTION application_field_projection_state_before_task_references(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE physical uuid:=p_id;
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='task_history_domain' THEN
  IF p_selection<>'query_domain' OR p_selected_version IS NOT NULL THEN RETURN NULL;END IF;RETURN application_task_history_domain_state(w,p_id,p_fields);
 END IF;
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='crm_history_domain' THEN
  IF p_selection<>'query_domain' OR p_selected_version IS NOT NULL THEN RETURN NULL;END IF;RETURN application_crm_history_domain_state(w,p_id,p_fields);
 END IF;
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='task' AND p_selection IN('read','query','identity') AND p_selected_version IS NULL THEN
  physical:=application_task_live_id(w,p_id);IF physical IS NULL THEN RETURN NULL;END IF;
 END IF;
 RETURN application_field_projection_state_before_task_references(w,p_origin,p_type,physical,p_selection,p_selected_version,p_fields);
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;


-- [COMP:crm/production-import] Preserve immutable source SELECT policy during copy admission.
DO $migration$
DECLARE definition text;before text;
BEGIN
 IF (SELECT prosecdef FROM pg_proc WHERE oid='public.crm_import_copy_parent_admission()'::regprocedure) THEN
  RAISE EXCEPTION 'Import source parent admission must remain invoker-only';
 END IF;
 SELECT pg_get_functiondef('public.crm_import_copy_parent_admission()'::regprocedure) INTO definition;
 before:='WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id AND NOT privacy_erased FOR KEY SHARE;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Import source parent lookup changed';END IF;
 -- Shared workspace privacy admission is already held by this trigger;
 -- canonical retirement holds its exclusive counterpart. Immutable source
 -- bytes have no UPDATE policy, so row locking would hide admitted metadata.
 EXECUTE replace(definition,before,'WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id AND NOT privacy_erased;');
END $migration$;
-- [COMP:crm/association-inventory] The boundary is an exact derived projection.
-- Existing owner/background callers retain only their existing invoker role;
-- actual nonowner writes additionally require the current native administrator.
CREATE FUNCTION public.association_inventory_boundary_write_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 current_boundary public.association_inventory_boundaries%ROWTYPE;
 actual_capacity integer;actual_used integer;actual_sold_out boolean;actual_revision integer;
BEGIN
 IF TG_OP NOT IN('INSERT','UPDATE') THEN RAISE EXCEPTION 'inventory_boundary_unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.workspace_id,NEW.event_id,NEW.ticket_id,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.event_id,OLD.ticket_id,OLD.created_at) THEN
  RAISE EXCEPTION 'inventory_boundary_identity_immutable' USING ERRCODE='23514';
 END IF;
 -- No former issuer, workspace owner or session-role substitute is introduced.
 -- Missing actor inputs cannot pass the actual nonowner table policies.
 IF actor IS NOT NULL THEN
  PERFORM m.user_id FROM public.workspace_members m
   WHERE m.workspace_id=NEW.workspace_id AND m.user_id=actor AND m.role IN('owner','admin') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inventory_boundary_unavailable' USING ERRCODE='42501';END IF;
 END IF;
 -- Raw UPDATE already owns its boundary tuple before a BEFORE trigger runs.
 -- Fail fast rather than waiting in the inverse of the canonical event order.
 SELECT e.capacity INTO actual_capacity FROM public.association_events e
  WHERE e.workspace_id=NEW.workspace_id AND e.id=NEW.event_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'inventory_boundary_unavailable' USING ERRCODE='42501';END IF;
 IF NEW.ticket_id IS NOT NULL THEN
  SELECT t.capacity INTO actual_capacity FROM public.association_ticket_types t
   WHERE t.workspace_id=NEW.workspace_id AND t.event_id=NEW.event_id AND t.id=NEW.ticket_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'inventory_boundary_unavailable' USING ERRCODE='42501';END IF;
 END IF;
 SELECT b.* INTO current_boundary FROM public.association_inventory_boundaries b
  WHERE b.workspace_id=NEW.workspace_id AND b.event_id=NEW.event_id
   AND b.ticket_id IS NOT DISTINCT FROM NEW.ticket_id FOR UPDATE;
 IF TG_OP='UPDATE' AND (NOT FOUND OR OLD IS DISTINCT FROM current_boundary) THEN
  RAISE EXCEPTION 'inventory_boundary_changed' USING ERRCODE='23514';
 END IF;
 -- BEFORE INSERT also runs on the ON CONFLICT update path. Its baseline must
 -- therefore be the existing locked boundary, rather than a fresh revision zero.
 IF current_boundary.id IS NULL AND actual_capacity IS NULL THEN
  RAISE EXCEPTION 'inventory_boundary_unavailable' USING ERRCODE='23514';
 END IF;
 SELECT count(*)::integer INTO actual_used FROM public.association_registrations r
  WHERE r.workspace_id=NEW.workspace_id AND r.event_id=NEW.event_id
   AND (NEW.ticket_id IS NULL OR r.ticket_id=NEW.ticket_id) AND NOT r.historical_import
   AND (r.status IN('confirmed','checked_in','registered','attended')
    OR r.status='reserved' AND r.reservation_expires_at>statement_timestamp());
 actual_sold_out:=actual_capacity IS NOT NULL AND actual_used>=actual_capacity;
 actual_revision:=coalesce(current_boundary.revision,0)
  +CASE WHEN actual_sold_out IS DISTINCT FROM coalesce(current_boundary.sold_out,false) THEN 1 ELSE 0 END;
 IF ROW(NEW.capacity,NEW.used,NEW.sold_out,NEW.revision)
  IS DISTINCT FROM ROW(actual_capacity,actual_used,actual_sold_out,actual_revision) THEN
  RAISE EXCEPTION 'inventory_boundary_facts_mismatch' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN NEW.created_at:=clock_timestamp();END IF;
 NEW.updated_at:=clock_timestamp();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.association_inventory_boundary_write_guard() FROM PUBLIC;
CREATE TRIGGER zz_association_inventory_boundary_write BEFORE INSERT OR UPDATE ON public.association_inventory_boundaries
 FOR EACH ROW EXECUTE FUNCTION public.association_inventory_boundary_write_guard();
CREATE POLICY association_inventory_boundaries_admin_insert ON public.association_inventory_boundaries FOR INSERT
 WITH CHECK(EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=association_inventory_boundaries.workspace_id
  AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND m.role IN('owner','admin')));
CREATE POLICY association_inventory_boundaries_admin_update ON public.association_inventory_boundaries FOR UPDATE
 USING(EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=association_inventory_boundaries.workspace_id
  AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND m.role IN('owner','admin')))
 WITH CHECK(EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=association_inventory_boundaries.workspace_id
  AND m.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND m.role IN('owner','admin')));
-- There is no nonowner DELETE policy. Exact parent-removal FK cleanup remains
-- governed by its existing lifecycle/privacy path; no business delete is added.


-- [COMP:api/application-field-evidence] Reuse only the canonical wrapper's
-- freshly computed exact root state within this SQL statement, never an allow cache.
DO $migration$
DECLARE definition text;before text;
BEGIN
 -- Preserve every recorded-field admission check while returning its already
 -- computed envelope privately to the same-statement canonical wrapper.
 SELECT pg_get_functiondef('public.application_recorded_field_state_before_record_ancestry(uuid,uuid,text,integer)'::regprocedure) INTO definition;
 before:='CREATE OR REPLACE FUNCTION public.application_recorded_field_state_before_record_ancestry(';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical recorded root capture signature changed';END IF;
 definition:=replace(definition,before,'CREATE OR REPLACE FUNCTION public.application_recorded_field_root_capture(');
 before:=$source$RETURN current->'source'||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical recorded root capture result changed';END IF;
 definition:=replace(definition,before,$source$RETURN jsonb_build_object('state',current->'source'||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL),'envelope',current);$source$);
 EXECUTE definition;
 REVOKE ALL ON FUNCTION public.application_recorded_field_root_capture(uuid,uuid,text,integer) FROM PUBLIC;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION public.application_recorded_field_root_capture(uuid,uuid,text,integer) FROM app_user;
 END IF;
 SELECT pg_get_functiondef('public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)'::regprocedure) INTO definition;
 before:='CREATE OR REPLACE FUNCTION public.application_canonical_ancestry_allowed(w uuid, k text, i uuid, v text, writing boolean DEFAULT false)';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical ancestry evaluator signature changed';END IF;
 definition:=replace(definition,before,'CREATE OR REPLACE FUNCTION public.application_canonical_ancestry_from_admitted_root(w uuid, k text, i uuid, v text, writing boolean DEFAULT false, trusted_root jsonb DEFAULT NULL)');
 before:=$source$current:=application_recorded_field_state_before_record_ancestry(w,resource.id,node->>'version',0);$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical ancestry root state changed';END IF;
 definition:=replace(definition,before,$source$IF trusted_root IS NOT NULL AND k='application_field'
    AND node->>'kind'=k AND node->>'id'=i::text AND node->>'version'=v
    AND trusted_root->>'kind'=node->>'kind' AND trusted_root->>'id'=node->>'id' AND trusted_root->>'version'=node->>'version' THEN
    current:=trusted_root->'state';
    IF current IS NULL OR current->>'workspaceId' IS DISTINCT FROM w::text
     OR current->>'resourceKind' IS DISTINCT FROM 'application_field' OR current->>'resourceId' IS DISTINCT FROM resource.id::text
     OR current->>'held' IS DISTINCT FROM 'false' OR jsonb_typeof(current->'version') IS DISTINCT FROM 'string'
     OR length(current->>'version')=0 THEN RETURN false;END IF;
   ELSE
    current:=application_recorded_field_state_before_record_ancestry(w,resource.id,node->>'version',0);
   END IF;$source$);
 before:=$source$envelope:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,
    resource.selection,resource.selected_version,resource.fields);$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical ancestry root envelope changed';END IF;
 definition:=replace(definition,before,$source$IF trusted_root IS NOT NULL AND k='application_field'
    AND node->>'kind'=k AND node->>'id'=i::text AND node->>'version'=v
    AND trusted_root->>'kind'=node->>'kind' AND trusted_root->>'id'=node->>'id' AND trusted_root->>'version'=node->>'version' THEN
    envelope:=trusted_root->'envelope';
    IF envelope IS NULL OR jsonb_typeof(envelope) IS DISTINCT FROM 'object'
     OR envelope->>'resourceId' IS DISTINCT FROM resource.id::text OR envelope->>'identity' IS DISTINCT FROM resource.identity
     OR envelope->'origin' IS DISTINCT FROM resource.origin OR envelope->>'typeKey' IS DISTINCT FROM resource.type_key
     OR envelope->>'id' IS DISTINCT FROM resource.resource_id::text OR envelope->>'selection' IS DISTINCT FROM resource.selection
     OR envelope->>'selectedVersion' IS DISTINCT FROM resource.selected_version OR envelope->'fields' IS DISTINCT FROM to_jsonb(resource.fields)
     OR envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
     OR (envelope->'source'||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL)) IS DISTINCT FROM current THEN RETURN false;END IF;
   ELSE
    envelope:=application_compute_field_envelope(w,resource.origin,resource.type_key,resource.resource_id,
     resource.selection,resource.selected_version,resource.fields);
   END IF;$source$);
 EXECUTE definition;
 REVOKE ALL ON FUNCTION public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb) FROM PUBLIC;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION public.application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb) FROM app_user;
 END IF;
 -- Only this private canonical wrapper can construct the trusted root binding.
 -- Its current-state call and all original refusal semantics remain unchanged.
 SELECT pg_get_functiondef('public.application_recorded_field_state(uuid,uuid,text,integer)'::regprocedure) INTO definition;
 before:='DECLARE admitted jsonb;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical field snapshot variables changed';END IF;
 definition:=replace(definition,before,'DECLARE admitted jsonb;captured jsonb;');
 before:=$source$admitted:=application_recorded_field_state_before_record_ancestry(w,i,v,depth);$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical field snapshot admission changed';END IF;
 definition:=replace(definition,before,$source$captured:=application_recorded_field_root_capture(w,i,v,depth);
 admitted:=CASE WHEN captured ? 'envelope' THEN captured->'state' ELSE captured END;$source$);
 before:=$source$application_canonical_ancestry_allowed(w,'application_field',i,v)$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical field snapshot ancestry wrapper changed';END IF;
 EXECUTE replace(definition,before,$source$application_canonical_ancestry_from_admitted_root(w,'application_field',i,v,false,
  jsonb_build_object('kind','application_field','id',i,'version',v,'state',admitted,'envelope',captured->'envelope'))$source$);
END $migration$;

-- [COMP:api/application-records] Candidate capture already admits selected
-- state and exact version through the canonical observer. Avoid only the
-- consecutive preliminary evaluation; all domain and postcapture checks remain.
DO $migration$
DECLARE definition text;before text;after text;
BEGIN
 SELECT pg_get_functiondef('public.read_native_application_query_candidates_before_selected_encodi(uuid,text,text[],uuid,text)'::regprocedure) INTO definition;
 before:=$source$  state:=application_field_projection_state(w,origin,p_type,(candidate->>'id')::uuid,'query',NULL,p_fields);
  IF state IS NULL OR state->>'recordVersion' IS DISTINCT FROM candidate->>'version' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  captured:=observe_application_field_projection(w,origin,p_type,(candidate->>'id')::uuid,state->>'recordVersion','query',NULL,p_fields);
  IF captured IS NULL OR captured->'values' IS DISTINCT FROM state->'values' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  id:=(candidate->>'id')::uuid;data:=captured->'values';record_version:=state->>'recordVersion';sources:=captured->'sources';policy_version:=captured->>'policyVersion';RETURN NEXT;$source$;
 after:=$source$  captured:=observe_application_field_projection(w,origin,p_type,(candidate->>'id')::uuid,candidate->>'version','query',NULL,p_fields);
  IF captured IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  id:=(candidate->>'id')::uuid;data:=captured->'values';record_version:=candidate->>'version';sources:=captured->'sources';policy_version:=captured->>'policyVersion';RETURN NEXT;$source$;
 IF length(definition)-length(replace(definition,before,''))<>length(before) THEN
  RAISE EXCEPTION 'Canonical native candidate capture changed';
 END IF;
 EXECUTE replace(definition,before,after);
END $migration$;

-- [COMP:api/application-field-evidence] A fresh metadata-only native leaf
-- avoids recursive transport, never current row, field or source admission.
DO $migration$
DECLARE definition text;before text;after text;kernel record;routine record;
 kernel_values text:='';semantic_hash text;
BEGIN
 FOR kernel IN SELECT * FROM (VALUES
  ('public.application_scope_source_edges(uuid,text,uuid,text)','20d8c359a6b77c9c96aed3be9e31719e60868fb55e34aaedc2714494e6a8e974'),
  ('public.scope_source_ancestors(uuid,text,uuid)','d8e33fb3a66e4318ed159e288c797b6d55759481e1339d4e53c372cb6907e0e8'),
  ('public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)','36bdb461a66fb00b81a5f0f6672b48dcc150858328b035b1ba1da0c3ed3715c8'),
  ('public.scope_source_ancestors_before_browser_session(uuid,text,uuid)','c5a684292738319265321ce21b76ea01ba775eb216af66ae992c190d39eedc5c'),
  ('public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)','497af5b78abd438a9332b52ba0e1eb6115997adfc447f239727d5948d626463a'),
  ('public.scope_source_table(text)','77ae7215cf985148bc013cd5afd14cac03776580e347bf548c67b6d1ca7f40da'),
  ('public.scope_source_table_before_media(text)','93ff1be795bfbee59a38c43da3425018072c18007fe39e99ecd4d7e8731eba15')
 ) reviewed(signature,body_sha256) LOOP
  SELECT p.* INTO routine FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure(kernel.signature);
  IF NOT FOUND OR encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex') IS DISTINCT FROM kernel.body_sha256 THEN
   RAISE EXCEPTION 'Canonical entity lineage kernel changed: %',kernel.signature;
  END IF;
  semantic_hash:=public.application_field_digest(jsonb_build_object('name',routine.proname,'namespace',routine.pronamespace,'body',routine.prosrc,'config',routine.proconfig,'language',routine.prolang,'securityDefiner',routine.prosecdef,'volatility',routine.provolatile,'strict',routine.proisstrict,'parallel',routine.proparallel));
  kernel_values:=kernel_values||CASE WHEN kernel_values='' THEN '' ELSE ',' END||format('(%s::oid,%L::text)',routine.oid,semantic_hash);
 END LOOP;
 SELECT pg_get_functiondef('public.application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure) INTO definition;
 before:=$source$ WITH RECURSIVE lineage(kind,id,version) AS ($source$;
 IF length(definition)-length(replace(definition,before,''))<>length(before)
  OR position('R2 canonical entity leaf transport' IN definition)>0 THEN
  RAISE EXCEPTION 'Canonical entity lineage entry changed';
 END IF;
 after:=format($source$ -- R2 canonical entity leaf transport, after the original complete input validation.
 IF w IS NOT NULL AND cardinality(ids)=1
  AND array_ndims(kinds)=1 AND array_lower(kinds,1)=1
  AND array_ndims(ids)=1 AND array_lower(ids,1)=1
  AND array_ndims(versions)=1 AND array_lower(versions,1)=1
  AND kinds[1]='entity'
  AND NOT EXISTS(SELECT 1 FROM public.scope_derivations d
   WHERE d.workspace_id=w AND d.resource_kind='entity' AND d.resource_id=ids[1])
  AND NOT EXISTS(SELECT 1 FROM public.entities e
   WHERE e.workspace_id=w AND e.superseded_by=ids[1])
  AND (SELECT count(*)=7 AND coalesce(bool_and(public.application_field_digest(jsonb_build_object('name',r.proname,'namespace',r.pronamespace,'body',r.prosrc,'config',r.proconfig,'language',r.prolang,'securityDefiner',r.prosecdef,'volatility',r.provolatile,'strict',r.proisstrict,'parallel',r.proparallel))=pin.fingerprint),false)
   FROM (VALUES %s) pin(function_oid,fingerprint)
   JOIN pg_catalog.pg_proc r ON r.oid=pin.function_oid) THEN
  RETURN QUERY SELECT kinds[1],ids[1],versions[1];
  RETURN;
 END IF;
$source$,kernel_values)||before;
 EXECUTE replace(definition,before,after);
END $migration$;
COMMIT;
