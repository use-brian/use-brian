-- Schema-level field facts do not depend on a convenient business record.
-- Query-domain/consumer integration is incomplete; qualification stays closed.
-- [COMP:security/native-field-policy] [COMP:api/application-field-evidence]
BEGIN;

ALTER TABLE application_native_field_contracts ADD COLUMN catalog_reader regprocedure;

CREATE FUNCTION application_native_record_port_valid(reader regprocedure) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p.proowner=c.relowner AND p.prosecdef AND p.prokind='f' AND NOT p.proretset
  AND p.prorettype='jsonb'::regtype AND p.proargtypes='2950 3802 25 25'::oidvector
  AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE')
  AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='app_user' AND has_function_privilege(r.oid,p.oid,'EXECUTE')),false)
 FROM pg_proc p CROSS JOIN pg_class c WHERE p.oid=reader AND c.oid='public.application_native_field_contracts'::regclass
$$;
REVOKE ALL ON FUNCTION application_native_record_port_valid(regprocedure) FROM PUBLIC;
CREATE OR REPLACE FUNCTION application_native_contract_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF application_native_record_port_valid(NEW.metadata_reader) IS NOT TRUE
  OR (SELECT count(*)<>count(DISTINCT role) FROM unnest(NEW.role_keys) role)
  OR EXISTS(SELECT 1 FROM unnest(NEW.role_keys) role WHERE role !~ '^[a-z][a-z0-9_.-]{0,127}$') THEN
  RAISE EXCEPTION 'invalid_native_field_contract' USING ERRCODE='22023'; END IF;
 IF TG_OP='UPDATE' AND NEW.module_key<>OLD.module_key THEN
  RAISE EXCEPTION 'immutable_native_field_owner' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_native_contract_guard() FROM PUBLIC;

CREATE FUNCTION application_native_catalog_port_valid(reader regprocedure) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p.proowner=c.relowner AND p.prosecdef AND p.prokind='f' AND NOT p.proretset
  AND p.prorettype='jsonb'::regtype AND p.proargtypes='2950 3802 25'::oidvector
  AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE')
  AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='app_user' AND has_function_privilege(r.oid,p.oid,'EXECUTE')),false)
 FROM pg_proc p CROSS JOIN pg_class c WHERE p.oid=reader AND c.oid='public.application_native_field_contracts'::regclass
$$;
REVOKE ALL ON FUNCTION application_native_catalog_port_valid(regprocedure) FROM PUBLIC;

CREATE FUNCTION application_native_catalog_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.catalog_reader IS NOT NULL AND NEW.catalog_reader IS NULL THEN
  RAISE EXCEPTION 'immutable_native_field_catalog' USING ERRCODE='22023'; END IF;
 IF NEW.catalog_reader IS NOT NULL AND application_native_catalog_port_valid(NEW.catalog_reader) IS NOT TRUE THEN
  RAISE EXCEPTION 'invalid_native_field_catalog' USING ERRCODE='22023'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_native_catalog_guard() FROM PUBLIC;
CREATE TRIGGER application_native_catalog_guard BEFORE INSERT OR UPDATE ON application_native_field_contracts
 FOR EACH ROW EXECUTE FUNCTION application_native_catalog_guard();

CREATE FUNCTION application_native_field_dictionary_valid(keys jsonb,fields jsonb,roles text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field jsonb; profile jsonb;
BEGIN
 IF jsonb_typeof(keys) IS DISTINCT FROM 'array' OR jsonb_typeof(fields) IS DISTINCT FROM 'array'
  OR jsonb_array_length(keys)>128 OR jsonb_array_length(keys)<>jsonb_array_length(fields)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(keys) item WHERE jsonb_typeof(item)<>'string'
   OR length(item#>>'{}') NOT BETWEEN 1 AND 128 OR item#>>'{}'=ANY(ARRAY['__proto__','prototype','constructor']))
  OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(keys))
  OR (SELECT count(*)<>count(DISTINCT value->>'key') FROM jsonb_array_elements(fields)) THEN RETURN false; END IF;
 FOR field IN SELECT value FROM jsonb_array_elements(fields) LOOP
  IF jsonb_typeof(field) IS DISTINCT FROM 'object' OR NOT field ?& ARRAY['key','read','write','releaseReadTo','releaseWriteTo']
   OR field-ARRAY['key','read','write','releaseReadTo','releaseWriteTo']<>'{}'::jsonb
   OR jsonb_typeof(field->'key') IS DISTINCT FROM 'string' OR NOT keys ? (field->>'key')
   OR application_native_field_rule_valid(field->'read',roles) IS NOT TRUE
   OR application_native_field_rule_valid(field->'write',roles) IS NOT TRUE THEN RETURN false; END IF;
  FOR profile IN SELECT value FROM jsonb_array_elements(jsonb_build_array(field->'releaseReadTo',field->'releaseWriteTo')) LOOP
   IF jsonb_typeof(profile) IS DISTINCT FROM 'array' OR jsonb_array_length(profile)>2
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(profile) item WHERE item NOT IN('"external_user"'::jsonb,'"service"'::jsonb))
    OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(profile)) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_field_dictionary_valid(jsonb,jsonb,text[]) FROM PUBLIC;

-- Private canonical schema facts, not row authority or a payload/source receipt.
CREATE FUNCTION application_native_field_catalog_for(w uuid,p_origin jsonb,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE canonical_origin jsonb:=p_origin; canonical_type text:=p_type; contract application_native_field_contracts;
 namespace text; procedure_name text; metadata jsonb; scope jsonb; canonical entity_types; keys jsonb;
BEGIN
 IF p_origin->>'kind'='generic' THEN
  IF p_origin-ARRAY['kind','entityTypeId']<>'{}'::jsonb THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
  canonical_origin:=jsonb_build_object('kind','generic','entityTypeId',((p_origin->>'entityTypeId')::uuid)::text);
  canonical_type:='record.'||(canonical_origin->>'entityTypeId');
 END IF;
 SELECT c.* INTO contract FROM application_native_resource_owners o JOIN application_native_field_contracts c USING(module_key)
  WHERE o.workspace_id=w AND o.origin=canonical_origin AND o.resource_type=canonical_type;
 IF NOT FOUND THEN RETURN '{"registered":false}'::jsonb; END IF;
 IF application_native_record_port_valid(contract.metadata_reader) IS NOT TRUE
  OR contract.catalog_reader IS NULL OR application_native_catalog_port_valid(contract.catalog_reader) IS NOT TRUE THEN
  RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 SELECT n.nspname,p.proname INTO namespace,procedure_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=contract.catalog_reader;
 EXECUTE format('SELECT %I.%I($1,$2,$3)',namespace,procedure_name) INTO metadata USING w,canonical_origin,canonical_type;
 IF jsonb_typeof(metadata) IS DISTINCT FROM 'object'
  OR NOT metadata ?& ARRAY['moduleKey','origin','typeKey','schemaVersion','policyVersion','fieldKeys','fields','scope']
  OR metadata-ARRAY['moduleKey','origin','typeKey','schemaVersion','policyVersion','fieldKeys','fields','scope']<>'{}'::jsonb
  OR metadata->>'moduleKey' IS DISTINCT FROM contract.module_key OR metadata->'origin' IS DISTINCT FROM canonical_origin
  OR metadata->>'typeKey' IS DISTINCT FROM canonical_type
  OR jsonb_typeof(metadata->'schemaVersion') IS DISTINCT FROM 'string' OR length(metadata->>'schemaVersion') NOT BETWEEN 1 AND 128
  OR jsonb_typeof(metadata->'policyVersion') IS DISTINCT FROM 'string' OR length(metadata->>'policyVersion') NOT BETWEEN 1 AND 128
  OR application_native_field_dictionary_valid(metadata->'fieldKeys',metadata->'fields',contract.role_keys) IS NOT TRUE THEN
  RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 scope:=metadata->'scope';
 IF jsonb_typeof(scope) IS DISTINCT FROM 'object'
  OR NOT scope ?& ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']
  OR scope-ARRAY['workspaceId','userId','assistantId','sensitivity','compartments','projectIds']<>'{}'::jsonb
  OR scope->>'workspaceId' IS DISTINCT FROM w::text OR entity_derivation_envelope_valid(scope) IS NOT TRUE THEN
  RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 IF canonical_origin->>'kind'='generic' THEN
  SELECT * INTO canonical FROM entity_types t WHERE t.workspace_id=w AND t.id=(canonical_origin->>'entityTypeId')::uuid;
  IF NOT FOUND OR metadata->>'schemaVersion' IS DISTINCT FROM canonical.schema_version::text THEN
   RETURN '{"registered":true,"held":true}'::jsonb; END IF;
  SELECT coalesce(jsonb_agg(p->'name' ORDER BY p->>'name'),'[]') INTO keys FROM jsonb_array_elements(canonical.properties) p;
  IF NOT keys<@(metadata->'fieldKeys') OR NOT (metadata->'fieldKeys')<@keys THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 END IF;
 RETURN jsonb_build_object('registered',true,'held',false,'metadata',metadata,'roleKeys',contract.role_keys,
  'fingerprint',application_field_digest(jsonb_build_object('contract',contract.contract_version,'roles',contract.role_keys,
   'schema',metadata->'schemaVersion','policy',metadata->'policyVersion','fields',metadata->'fields','scope',scope)));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow
 OR undefined_function OR undefined_table OR insufficient_privilege THEN RETURN '{"registered":true,"held":true}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION application_native_field_catalog_for(uuid,jsonb,text) FROM PUBLIC;

-- A record policy can only add constraints to its deployed schema floor.
CREATE FUNCTION application_native_intersect_field_catalog(record_fields jsonb,catalog_fields jsonb,roles text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE keys jsonb; row_field jsonb; catalog_field jsonb; combined jsonb; rule_key text; rule_value jsonb; output jsonb:='[]';
BEGIN
 IF jsonb_typeof(record_fields) IS DISTINCT FROM 'array' OR jsonb_typeof(catalog_fields) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(f->'key' ORDER BY f->>'key'),'[]') INTO keys FROM jsonb_array_elements(record_fields) f;
 IF application_native_field_dictionary_valid(keys,record_fields,roles) IS NOT TRUE
  OR application_native_field_dictionary_valid(keys,catalog_fields,roles) IS NOT TRUE THEN RETURN NULL; END IF;
 FOR row_field IN SELECT value FROM jsonb_array_elements(record_fields) ORDER BY value->>'key' LOOP
  SELECT value INTO catalog_field FROM jsonb_array_elements(catalog_fields) WHERE value->>'key'=row_field->>'key';
  combined:=jsonb_build_object('key',row_field->'key');
  FOREACH rule_key IN ARRAY ARRAY['read','write'] LOOP
   SELECT coalesce(jsonb_agg(DISTINCT normalized ORDER BY normalized),'[]') INTO rule_value
    FROM (SELECT coalesce((SELECT jsonb_agg(role ORDER BY role) FROM jsonb_array_elements(clause) role),'[]') AS normalized
     FROM jsonb_array_elements((row_field->rule_key)||(catalog_field->rule_key)) clause) rules;
   IF application_native_field_rule_valid(rule_value,roles) IS NOT TRUE THEN RETURN NULL; END IF;
   combined:=combined||jsonb_build_object(rule_key,rule_value);
  END LOOP;
  FOREACH rule_key IN ARRAY ARRAY['releaseReadTo','releaseWriteTo'] LOOP
   SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO rule_value FROM (
    SELECT value FROM jsonb_array_elements(row_field->rule_key)
    INTERSECT SELECT value FROM jsonb_array_elements(catalog_field->rule_key)) allowed;
   combined:=combined||jsonb_build_object(rule_key,rule_value);
  END LOOP;
  output:=output||jsonb_build_array(combined);
 END LOOP;
 RETURN output;
EXCEPTION WHEN invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_intersect_field_catalog(jsonb,jsonb,text[]) FROM PUBLIC;

ALTER FUNCTION application_native_field_contract_for(uuid,jsonb,text,text) RENAME TO application_native_field_contract_before_catalog;
REVOKE ALL ON FUNCTION application_native_field_contract_before_catalog(uuid,jsonb,text,text) FROM PUBLIC;
CREATE FUNCTION application_native_field_contract_for(w uuid,p_origin jsonb,p_type text,p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE policy jsonb; catalog jsonb; metadata jsonb; fields jsonb; reader regprocedure; record_reader regprocedure;
 canonical_origin jsonb:=p_origin; canonical_type text:=p_type;
BEGIN
 IF p_origin->>'kind'='generic' THEN
  canonical_origin:=jsonb_build_object('kind','generic','entityTypeId',((p_origin->>'entityTypeId')::uuid)::text);
  canonical_type:='record.'||(canonical_origin->>'entityTypeId');
 END IF;
 SELECT c.metadata_reader INTO record_reader FROM application_native_resource_owners o JOIN application_native_field_contracts c USING(module_key)
  WHERE o.workspace_id=w AND o.origin=canonical_origin AND o.resource_type=canonical_type;
 IF FOUND AND application_native_record_port_valid(record_reader) IS NOT TRUE THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 policy:=application_native_field_contract_before_catalog(w,p_origin,p_type,p_id);
 IF policy IS NULL OR policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' THEN RETURN policy; END IF;
 SELECT c.catalog_reader INTO reader FROM application_native_field_contracts c WHERE c.module_key=policy#>>'{metadata,moduleKey}';
 IF NOT FOUND THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 -- Legacy per-record-only contracts retain their existing restriction but
 -- cannot supply query/catalog authority. A configured reader cannot be removed.
 IF reader IS NULL THEN RETURN policy; END IF;
 metadata:=policy->'metadata';
 catalog:=application_native_field_catalog_for(w,metadata->'origin',metadata->>'typeKey');
 IF catalog->>'registered' IS DISTINCT FROM 'true' OR catalog->>'held' IS DISTINCT FROM 'false'
  OR metadata->>'schemaVersion' IS DISTINCT FROM catalog#>>'{metadata,schemaVersion}' THEN
  RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 fields:=application_native_intersect_field_catalog(metadata->'fields',catalog#>'{metadata,fields}',
  ARRAY(SELECT jsonb_array_elements_text(policy->'roleKeys')));
 IF fields IS NULL THEN RETURN '{"registered":true,"held":true}'::jsonb; END IF;
 -- Catalog scope protects metadata/domain queries. Preserve the actual row
 -- source scope here; the compiled field floor never manufactures a source.
 RETURN policy||jsonb_build_object('metadata',metadata||jsonb_build_object('fields',fields),
  'fingerprint',application_field_digest(jsonb_build_object('recordPolicy',policy->'fingerprint',
   'catalogSchema',catalog#>'{metadata,schemaVersion}','catalogPolicy',catalog#>'{metadata,policyVersion}',
   'roles',catalog->'roleKeys','fields',fields)));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN '{"registered":true,"held":true}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION application_native_field_contract_for(uuid,jsonb,text,text) FROM PUBLIC;

-- Metadata masks are restrictions within current native admission. No row is
-- selected, no application identity is guessed, and this cannot permit a write.
CREATE FUNCTION read_native_application_field_catalog(w uuid,p_origin jsonb,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; policy jsonb; metadata jsonb; scope jsonb; permissions jsonb;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.application_native_field_contracts'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM assistants a WHERE a.workspace_id=w AND a.id=acting)
   OR assistant_placement_visible(actor,acting) IS NOT TRUE) THEN RETURN NULL; END IF;
 policy:=application_native_field_catalog_for(w,p_origin,p_type);
 IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
 metadata:=policy->'metadata';scope:=metadata->'scope';
 IF agent_visibility_allows(w,(scope->>'userId')::uuid,(scope->>'assistantId')::uuid) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,scope) IS NOT TRUE THEN RETURN NULL; END IF;
 permissions:=application_native_member_field_permissions(w,policy,actor);
 IF permissions IS NULL THEN RETURN NULL; END IF;
 IF member_operation_row_allows(member_principal_operation_grants(actor,true,w),w,scope->>'sensitivity',
  ARRAY(SELECT jsonb_array_elements_text(scope->'compartments'))) IS NOT TRUE
  OR agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(scope->'compartments'))) IS NOT TRUE THEN
  permissions:=jsonb_set(permissions,'{write}','[]'::jsonb); END IF;
 RETURN jsonb_build_object('moduleKey',metadata->'moduleKey','schemaVersion',metadata->'schemaVersion',
  'policyVersion',policy->'fingerprint','readFields',permissions->'read','writeFields',permissions->'write');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION read_native_application_field_catalog(uuid,jsonb,text) FROM PUBLIC;
-- Native system cells use canonical managed columns, under the same selected
-- field mask. They are neither caller data nor readable absence.
ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_query_fields;
REVOKE ALL ON FUNCTION application_field_projection_state_before_query_fields(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb; row_value entity_instances; property jsonb; cell jsonb; value jsonb; reference_list jsonb; reference jsonb;
BEGIN
 IF p_selection='query_domain' THEN
  IF p_selected_version IS NOT NULL THEN RETURN NULL; END IF;
  RETURN application_query_domain_state(w,p_origin,p_type,p_id,p_fields);
 END IF;
 state:=application_field_projection_state_before_query_fields(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
 IF state IS NULL THEN RETURN NULL; END IF;
 IF p_origin->>'kind'='generic' AND p_selection IN('read','query') AND nullif(current_setting('app.application_id',true),'') IS NULL THEN
  SELECT * INTO row_value FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=(p_origin->>'entityTypeId')::uuid AND r.id=p_id;
  IF NOT FOUND OR row_value.record_version::text IS DISTINCT FROM state->>'recordVersion' THEN RETURN NULL; END IF;
  FOR property IN SELECT p FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p
   WHERE t.workspace_id=w AND t.id=row_value.entity_type_id AND p->>'name'=ANY(p_fields)
    AND p#>>'{config,kind}' IN('created_time','last_edited_time','created_by','last_edited_by') LOOP
   value:=CASE property#>>'{config,kind}' WHEN 'created_time' THEN to_jsonb(row_value.created_at)
    WHEN 'last_edited_time' THEN to_jsonb(row_value.last_edited_at) WHEN 'created_by' THEN to_jsonb(row_value.created_by)
    ELSE to_jsonb(row_value.last_edited_by) END;
   cell:=jsonb_build_object('kind',property#>>'{config,kind}','value',value);
   state:=jsonb_set(state,'{values}',(state->'values')||jsonb_build_object(property->>'name',cell));
  END LOOP;
  reference_list:=application_field_references(w,p_origin,p_type,state->'values');
  FOR reference IN SELECT item FROM jsonb_array_elements(reference_list) item LOOP
   IF application_field_reference_admitted(w,reference) IS NOT TRUE THEN RETURN NULL; END IF;
  END LOOP;
  state:=jsonb_set(state,'{references}',reference_list);
 END IF;
 RETURN state;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;

-- Immutable native query bounds are metadata, never a former actor credential.
CREATE TABLE application_query_domains (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 origin jsonb NOT NULL,type_key text NOT NULL,schema_version text NOT NULL,
 domain jsonb NOT NULL CHECK(jsonb_typeof(domain)='object'),identity text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(identity ~ '^[a-f0-9]{64}$' AND id=application_field_resource_uuid(identity))
);
ALTER TABLE application_query_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_query_domains FROM PUBLIC;
CREATE TRIGGER application_query_domain_immutable BEFORE UPDATE OR DELETE ON application_query_domains
 FOR EACH ROW EXECUTE FUNCTION guard_application_field_metadata();
ALTER TABLE application_field_resources DROP CONSTRAINT application_field_resources_selection_check;
ALTER TABLE application_field_resources ADD CONSTRAINT application_field_resources_selection_check
 CHECK(selection IN('read','query','history','identity','query_domain'));

CREATE FUNCTION application_native_query_bounds(w uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; member jsonb;
 teams jsonb; ceiling jsonb; projects jsonb; rank int; cap int;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspaces wk WHERE wk.id=w AND NOT wk.department_read_v2)
  OR agent_visibility_allows(w,NULL,NULL) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.application_query_domains'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL; END IF;
 member:=member_principal_operation_grants(actor,false,w)->w::text;
 IF member IS NULL OR member->'v2' IS NOT NULL AND member->'v2'<>'null'::jsonb THEN RETURN NULL; END IF;
 rank:=(member->>'r')::int;
 IF nullif(current_setting('app.agent_clearance',true),'') IS NOT NULL THEN
  cap:=sensitivity_rank(current_setting('app.agent_clearance',true));
  IF cap IS NULL THEN RETURN NULL; END IF;
  rank:=least(rank,cap);
 END IF;
 teams:=member->'c';ceiling:=coalesce(nullif(current_setting('app.agent_compartments',true),'')::jsonb,'null'::jsonb);
 projects:=coalesce(nullif(current_setting('app.agent_project_ids',true),'')::jsonb,'null'::jsonb);
 IF rank IS NULL OR rank NOT BETWEEN 1 AND 3 OR teams IS NULL
  OR jsonb_typeof(teams) NOT IN('array','null') OR jsonb_typeof(ceiling) NOT IN('array','null')
  OR jsonb_typeof(projects) NOT IN('array','null') THEN RETURN NULL; END IF;
 IF teams='null'::jsonb THEN teams:=ceiling;
 ELSIF ceiling<>'null'::jsonb THEN
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO teams FROM (
   SELECT value FROM jsonb_array_elements(teams) INTERSECT SELECT value FROM jsonb_array_elements(ceiling)) shared;
 END IF;
 IF teams<>'null'::jsonb AND (jsonb_array_length(teams)>256
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(teams) item WHERE jsonb_typeof(item)<>'string'))
  OR projects<>'null'::jsonb AND (jsonb_array_length(projects)>256
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(projects) item WHERE jsonb_typeof(item)<>'string')) THEN RETURN NULL; END IF;
 IF teams<>'null'::jsonb THEN SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO teams FROM (SELECT DISTINCT value FROM jsonb_array_elements(teams)) sorted; END IF;
 IF projects<>'null'::jsonb THEN
  PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(projects);
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO projects FROM (SELECT DISTINCT value FROM jsonb_array_elements(projects)) sorted;
 END IF;
 RETURN jsonb_build_object('kind','native_legacy','tier',rank,'compartments',teams,'projectIds',projects);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_query_bounds(uuid) FROM PUBLIC;

CREATE FUNCTION application_query_bounds_contain(current_bounds jsonb,original jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(current_bounds->>'kind'='native_legacy' AND original->>'kind'='native_legacy'
  AND (current_bounds->>'tier')::int>=(original->>'tier')::int
  AND (current_bounds->'compartments'='null'::jsonb OR original->'compartments'<>'null'::jsonb
   AND original->'compartments'<@(current_bounds->'compartments'))
  AND (current_bounds->'projectIds'='null'::jsonb OR original->'projectIds'<>'null'::jsonb
   AND original->'projectIds'<@(current_bounds->'projectIds')),false)
$$;
REVOKE ALL ON FUNCTION application_query_bounds_contain(jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION application_query_domain_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains; catalog jsonb; mask jsonb; current_bounds jsonb; properties jsonb;
BEGIN
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=p_id AND d.origin=p_origin AND d.type_key=p_type;
 IF NOT FOUND OR p_fields IS NULL OR array_position(p_fields,NULL) IS NOT NULL
  OR cardinality(p_fields)>256 OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_fields) field) THEN RETURN NULL; END IF;
 current_bounds:=application_native_query_bounds(w);
 IF application_query_bounds_contain(current_bounds,frozen.domain) IS NOT TRUE THEN RETURN NULL; END IF;
 catalog:=application_native_field_catalog_for(w,p_origin,p_type);
 IF catalog->>'registered' IS DISTINCT FROM 'true' OR catalog->>'held' IS DISTINCT FROM 'false'
  OR catalog#>>'{metadata,schemaVersion}' IS DISTINCT FROM frozen.schema_version THEN RETURN NULL; END IF;
 mask:=read_native_application_field_catalog(w,p_origin,p_type);
 IF mask IS NULL OR NOT to_jsonb(p_fields)<@(mask->'readFields') THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(p ORDER BY p->>'name'),'[]') INTO properties FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p
  WHERE t.workspace_id=w AND t.id=(p_origin->>'entityTypeId')::uuid AND p->>'name'=ANY(p_fields);
 IF jsonb_array_length(properties)<>cardinality(p_fields) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',catalog#>'{metadata,scope}','recordVersion',frozen.schema_version,
  'sourceKind','application_query_domain','sourceId',p_id,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('domain',frozen.identity,'properties',properties)),
  'policyVersion',application_field_digest(jsonb_build_object('domain',frozen.identity,'catalog',catalog->'fingerprint','properties',properties)),
  'references','[]'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_query_domain_state(uuid,jsonb,text,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION observe_generic_native_query_domain(w uuid,p_type uuid,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',p_type); type_key text:='record.'||p_type;
 bounds jsonb; catalog jsonb; identity_value text; domain_id uuid; envelope jsonb; frozen application_query_domains;
BEGIN
 -- Unsupported domain families remain held by the zero-candidate port below.
 bounds:=application_native_query_bounds(w);
 IF bounds IS NULL THEN RETURN NULL; END IF;
 catalog:=application_native_field_catalog_for(w,origin,type_key);
 IF catalog->>'registered'='false' THEN RETURN NULL; END IF;
 IF catalog->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 identity_value:=application_field_digest(jsonb_build_object('kind','native_query_domain','workspaceId',w,'origin',origin,
  'schemaVersion',catalog#>'{metadata,schemaVersion}','bounds',bounds));
 domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
  VALUES(domain_id,w,origin,type_key,catalog#>>'{metadata,schemaVersion}',bounds,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains d WHERE d.workspace_id=w AND d.id=domain_id;
 IF NOT FOUND OR (frozen.origin,frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity)
  IS DISTINCT FROM (origin,type_key,catalog#>>'{metadata,schemaVersion}',bounds,identity_value) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023'; END IF;
 envelope:=application_compute_field_envelope(w,origin,type_key,domain_id,'query_domain',NULL,p_fields);
 IF envelope IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
 PERFORM application_materialize_field_envelope(w,envelope);
 RETURN jsonb_build_object('values','{}'::jsonb,'sources',jsonb_build_array(envelope->'source')||coalesce(envelope->'sources','[]'::jsonb),
  'policyVersion',envelope#>'{state,policyVersion}');
END $$;
REVOKE ALL ON FUNCTION observe_generic_native_query_domain(uuid,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION read_generic_application_projection(w uuid,p_type uuid,p_alias text,p_id uuid,p_selection text,
 p_fields text[] DEFAULT NULL,p_required_fields text[] DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; source jsonb; context jsonb;
 policy jsonb; selected text[]; record_version text; captured jsonb; projected record; canonical entity_instances;
 origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',p_type);
BEGIN
 IF p_selection IS NULL OR p_selection NOT IN('read','query') OR p_required_fields IS NULL
  OR cardinality(p_required_fields)>256 OR array_position(p_required_fields,NULL) IS NOT NULL
  OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_required_fields) field)
  OR p_fields IS NOT NULL AND (cardinality(p_fields)>256 OR array_position(p_fields,NULL) IS NOT NULL
   OR (SELECT count(*)<>count(DISTINCT field) FROM unnest(p_fields) field)) THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 IF actor IS NULL OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entity_instances'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NULL THEN
  IF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  source:=read_admitted_native_scope_snapshot(w,'entity_instance',p_id);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  SELECT r.record_version::text INTO record_version FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=p_type AND r.id=p_id;
  IF record_version IS NULL OR record_version IS DISTINCT FROM source->>'version' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  policy:=application_current_native_field_policy(w,origin,p_alias,p_id);
  IF policy->>'registered'='true' THEN
   IF policy->>'held' IS DISTINCT FROM 'false' OR policy->>'recordVersion' IS DISTINCT FROM record_version THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
   selected:=ARRAY(SELECT jsonb_array_elements_text(policy->'readFields'));
  ELSE
   SELECT ARRAY(SELECT p->>'name' FROM jsonb_array_elements(t.properties) p ORDER BY p->>'name') INTO selected
    FROM entity_types t WHERE t.workspace_id=w AND t.id=p_type;
  END IF;
 ELSE
  context:=application_current_maxima();
  IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  SELECT p.data,p.record_version::text,p.source INTO projected FROM application_generic_projection(p_type,p_alias,p_selection,p_id) p;
  IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO canonical FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=p_type AND r.id=p_id;
  IF NOT FOUND OR canonical.record_version::text IS DISTINCT FROM projected.record_version THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
  record_version:=projected.record_version;
  policy:=application_resource_fields(w,origin,p_alias,p_id::text,canonical.created_by,canonical.sensitivity,canonical.compartments,canonical.project_ids,NULL,p_selection);
  IF policy IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  -- Do not classify a withheld relation/system cell as an observed absence.
  SELECT ARRAY(SELECT p->>'name' FROM jsonb_array_elements(t.properties) p
    WHERE (policy->'read') ? (p->>'name') AND (projected.data ? (p->>'name')
     OR NOT canonical.data ? (p->>'name') AND p#>>'{config,kind}' NOT IN('created_time','last_edited_time','created_by','last_edited_by')) ORDER BY p->>'name')
   INTO selected FROM entity_types t WHERE t.workspace_id=w AND t.id=p_type;
 END IF;
 IF selected IS NULL OR NOT to_jsonb(p_required_fields)<@to_jsonb(selected)
  OR p_fields IS NOT NULL AND NOT to_jsonb(p_fields)<@to_jsonb(selected) THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 IF p_fields IS NOT NULL THEN selected:=ARRAY(SELECT field FROM unnest(selected) field WHERE field=ANY(p_fields) ORDER BY field); END IF;
 IF NOT to_jsonb(p_required_fields)<@to_jsonb(selected) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 captured:=observe_application_field_projection(w,origin,p_alias,p_id,record_version,p_selection,NULL,selected);
 RETURN captured||jsonb_build_object('id',p_id,'recordVersion',record_version,
  'absentFields',ARRAY(SELECT field FROM unnest(selected) field WHERE NOT (captured->'values') ? field ORDER BY field));
END $$;
REVOKE ALL ON FUNCTION read_generic_application_projection(uuid,uuid,text,uuid,text,text[],text[]) FROM PUBLIC;
CREATE OR REPLACE FUNCTION read_generic_application_record(w uuid,p_type uuid,p_alias text,p_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT read_generic_application_projection(w,p_type,p_alias,p_id,'read',NULL,'{}')
$$;
REVOKE ALL ON FUNCTION read_generic_application_record(uuid,uuid,text,uuid) FROM PUBLIC;

-- Field masking and required-field refusal happen before caller SQL predicates.
CREATE FUNCTION read_generic_application_query_candidates(w uuid,p_type uuid,p_alias text,p_required_fields text[] DEFAULT '{}',p_catalog_fields text[] DEFAULT '{}')
RETURNS TABLE(id uuid,workspace_id uuid,entity_type_id uuid,data jsonb,record_version bigint,
 created_at timestamptz,last_edited_at timestamptz,created_by uuid,last_edited_by uuid,
 source jsonb,absent_fields text[],policy_version text,read_fields text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; context jsonb; catalog jsonb; decision jsonb;
 native_policy jsonb; captured jsonb; row_value record; property jsonb; origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',p_type);
 candidate_count int:=0;
BEGIN
 IF actor IS NULL OR p_required_fields IS NULL OR cardinality(p_required_fields)>256 OR array_position(p_required_fields,NULL) IS NOT NULL
  OR p_catalog_fields IS NULL OR cardinality(p_catalog_fields)>256 OR array_position(p_catalog_fields,NULL) IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.entity_instances'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 context:=application_current_maxima();
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor) THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 catalog:=application_native_field_catalog_for(w,origin,p_alias);
 IF catalog->>'registered'='true' THEN
  IF catalog->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  IF context IS NULL THEN
   decision:=read_native_application_field_catalog(w,origin,p_alias);
   IF decision IS NULL OR NOT to_jsonb(p_catalog_fields)<@(decision->'readFields') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
  END IF;
 END IF;
 FOR row_value IN SELECT r.* FROM entity_instances r WHERE r.workspace_id=w AND r.entity_type_id=p_type ORDER BY r.id LOOP
  IF scope_review_state_held('entity_instance',row_value.id) THEN CONTINUE; END IF;
  IF context IS NULL THEN
   IF read_admitted_native_scope_snapshot(w,'entity_instance',row_value.id) IS NULL THEN CONTINUE; END IF;
   native_policy:=application_native_field_contract_for(w,origin,p_alias,row_value.id::text);
   IF native_policy->>'registered'='true' THEN
    IF native_policy->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
    IF agent_visibility_allows(w,(native_policy#>>'{metadata,source,userId}')::uuid,(native_policy#>>'{metadata,source,assistantId}')::uuid) IS NOT TRUE
     OR workflow_evidence_envelope_visible(w,native_policy#>'{metadata,source}') IS NOT TRUE THEN CONTINUE; END IF;
   END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM application_generic_projection(p_type,p_alias,'query',row_value.id)) THEN CONTINUE; END IF;
   IF catalog->>'registered'='true' THEN
    decision:=application_resource_fields(w,origin,p_alias,row_value.id::text,row_value.created_by,catalog#>>'{metadata,scope,sensitivity}',
     ARRAY(SELECT jsonb_array_elements_text(catalog#>'{metadata,scope,compartments}')),
     ARRAY(SELECT jsonb_array_elements_text(catalog#>'{metadata,scope,projectIds}'))::uuid[],
     (catalog#>>'{metadata,scope,userId}')::uuid,'query');
    IF decision IS NULL OR NOT to_jsonb(p_catalog_fields)<@(decision->'read') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
   END IF;
  END IF;
  candidate_count:=candidate_count+1;
  IF candidate_count>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501'; END IF;
  captured:=read_generic_application_projection(w,p_type,p_alias,row_value.id,'query',NULL,p_required_fields);
  id:=row_value.id;workspace_id:=w;entity_type_id:=p_type;data:=captured->'values';record_version:=(captured->>'recordVersion')::bigint;
  source:=captured#>'{sources,0}';absent_fields:=ARRAY(SELECT jsonb_array_elements_text(captured->'absentFields'));policy_version:=captured->>'policyVersion';
  read_fields:=ARRAY(SELECT field FROM (SELECT jsonb_object_keys(data) AS field UNION SELECT unnest(absent_fields)) fields ORDER BY field);
  created_at:=NULL;last_edited_at:=NULL;created_by:=NULL;last_edited_by:=NULL;
  FOR property IN SELECT p FROM entity_types t,LATERAL jsonb_array_elements(t.properties) p WHERE t.workspace_id=w AND t.id=p_type AND data ? (p->>'name') LOOP
   CASE property#>>'{config,kind}'
    WHEN 'created_time' THEN created_at:=row_value.created_at;
    WHEN 'last_edited_time' THEN last_edited_at:=row_value.last_edited_at;
    WHEN 'created_by' THEN created_by:=row_value.created_by;
    WHEN 'last_edited_by' THEN last_edited_by:=row_value.last_edited_by;
    ELSE NULL;
   END CASE;
  END LOOP;
  RETURN NEXT;
 END LOOP;
 -- A row-free domain needs its separate immutable catalog/domain observation.
 -- Until that consumer is wired, never manufacture empty General evidence.
 IF candidate_count=0 AND observe_generic_native_query_domain(w,p_type,p_catalog_fields) IS NULL THEN
  RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION read_generic_application_query_candidates(uuid,uuid,text,text[],text[]) FROM PUBLIC;

-- A projection assertion only: its inputs cannot confer row or field authority.
CREATE FUNCTION require_application_query_fields(readable text[],required text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF readable IS NULL OR required IS NULL OR array_position(required,NULL) IS NOT NULL OR NOT required<@readable THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION require_application_query_fields(text[],text[]) FROM PUBLIC;

-- Actual native viewers recheck retained field/domain ancestry before payload
-- evaluation, including counts and search. An owner connection grants nothing.
CREATE FUNCTION application_memory_field_ancestry_allows(w uuid,i uuid,v text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE dependency record; snapshot jsonb;
BEGIN
 IF w IS NULL THEN RETURN true; END IF;
 IF NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=i) THEN RETURN true; END IF;
 FOR dependency IN SELECT * FROM read_application_field_dependencies(w,ARRAY['memory'],ARRAY[i],ARRAY[v]) LOOP
  IF dependency.source IS NULL THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.memories'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN false; END IF;
  snapshot:=read_admitted_application_field_snapshot(w,(dependency.source->>'resourceId')::uuid,dependency.node_version);
  IF snapshot IS NULL OR snapshot->>'held' IS DISTINCT FROM 'false' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value OR invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_memory_field_ancestry_allows(uuid,uuid,text) FROM PUBLIC;
CREATE POLICY application_memory_field_ancestry_floor ON memories AS RESTRICTIVE FOR SELECT
 USING(application_memory_field_ancestry_allows(workspace_id,id,scope_version::text));

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION application_native_record_port_valid(regprocedure),application_native_contract_guard(),
   application_native_catalog_port_valid(regprocedure),application_native_catalog_guard(),
   application_native_field_dictionary_valid(jsonb,jsonb,text[]),application_native_field_catalog_for(uuid,jsonb,text),
   application_native_intersect_field_catalog(jsonb,jsonb,text[]),application_native_field_contract_before_catalog(uuid,jsonb,text,text),
   application_native_field_contract_for(uuid,jsonb,text,text),application_native_query_bounds(uuid),
   application_query_bounds_contain(jsonb,jsonb),application_query_domain_state(uuid,jsonb,text,uuid,text[]) FROM app_user;
  GRANT EXECUTE ON FUNCTION application_memory_field_ancestry_allows(uuid,uuid,text),observe_generic_native_query_domain(uuid,uuid,text[]),read_native_application_field_catalog(uuid,jsonb,text),
   read_generic_application_projection(uuid,uuid,text,uuid,text,text[],text[]),
   require_application_query_fields(text[],text[]),read_generic_application_record(uuid,uuid,text,uuid),read_generic_application_query_candidates(uuid,uuid,text,text[],text[]) TO app_user;
 END IF;
END $$;
COMMIT;
