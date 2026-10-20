BEGIN;
-- [COMP:api/application-governance] Private deployed ports, current canonical admission.
CREATE TABLE application_native_configuration_operations (
 module_key text NOT NULL REFERENCES application_native_field_contracts(module_key),
 operation_key text NOT NULL CHECK(operation_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
 input_fields jsonb NOT NULL,
 required_role_keys text[] NOT NULL CHECK(cardinality(required_role_keys) BETWEEN 1 AND 64 AND array_position(required_role_keys,NULL) IS NULL),
 apply_handler regprocedure NOT NULL,
 PRIMARY KEY(module_key,operation_key)
);
ALTER TABLE application_native_configuration_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_native_configuration_operations FROM PUBLIC;
CREATE FUNCTION application_native_configuration_handler_valid(handler regprocedure) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(p.proowner=c.relowner AND p.prosecdef AND p.prokind='f' AND NOT p.proretset
  AND p.prorettype='text'::regtype AND p.proargtypes='2950 3802'::oidvector
  AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE')
  AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='app_user' AND has_function_privilege(r.oid,p.oid,'EXECUTE')),false)
 FROM pg_proc p CROSS JOIN pg_class c WHERE p.oid=handler AND c.oid='public.application_native_field_contracts'::regclass
$$;
REVOKE ALL ON FUNCTION application_native_configuration_handler_valid(regprocedure) FROM PUBLIC;
CREATE FUNCTION application_native_configuration_fields_valid(fields jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field jsonb;
BEGIN
 IF jsonb_typeof(fields) IS DISTINCT FROM 'array' OR jsonb_array_length(fields)>16
  OR (SELECT count(*)<>count(DISTINCT value->>'key') FROM jsonb_array_elements(fields)) THEN RETURN false;END IF;
 FOR field IN SELECT value FROM jsonb_array_elements(fields) LOOP
  IF jsonb_typeof(field) IS DISTINCT FROM 'object' OR field-ARRAY['key','kind','required','maxLength','values']<>'{}'
   OR NOT field ?& ARRAY['key','kind','required'] OR jsonb_typeof(field->'key') IS DISTINCT FROM 'string'
   OR field->>'key' !~ '^[a-z][a-zA-Z0-9_]{0,63}$' OR field->>'key' IN('constructor','prototype','__proto__')
   OR jsonb_typeof(field->'kind') IS DISTINCT FROM 'string' OR field->>'kind' NOT IN('text','boolean','integer','enum') OR jsonb_typeof(field->'required') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  IF field->>'kind'='text' THEN
   IF field ? 'values' OR NOT field ? 'maxLength' OR jsonb_typeof(field->'maxLength') IS DISTINCT FROM 'number'
    OR (field->>'maxLength')::numeric<>trunc((field->>'maxLength')::numeric) OR (field->>'maxLength')::numeric NOT BETWEEN 1 AND 2048 THEN RETURN false;END IF;
  ELSIF field->>'kind'='enum' THEN
   IF field ? 'maxLength' OR jsonb_typeof(field->'values') IS DISTINCT FROM 'array' OR jsonb_array_length(field->'values') NOT BETWEEN 1 AND 64
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(field->'values') item WHERE jsonb_typeof(item)<>'string' OR length(item#>>'{}') NOT BETWEEN 1 AND 128)
    OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(field->'values')) THEN RETURN false;END IF;
  ELSIF field ?| ARRAY['maxLength','values'] THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_configuration_fields_valid(jsonb) FROM PUBLIC;
CREATE FUNCTION application_native_configuration_operation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF public.application_native_configuration_handler_valid(NEW.apply_handler) IS NOT TRUE
  OR public.application_native_configuration_fields_valid(NEW.input_fields) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.application_native_field_contracts c WHERE c.module_key=NEW.module_key AND NEW.required_role_keys<@c.role_keys)
  OR (SELECT count(*)<>count(DISTINCT key) FROM unnest(NEW.required_role_keys) key) THEN
  RAISE EXCEPTION 'invalid_native_configuration_operation' USING ERRCODE='22023';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_native_configuration_operation_guard() FROM PUBLIC;
CREATE TRIGGER application_native_configuration_operation_guard BEFORE INSERT OR UPDATE ON application_native_configuration_operations
 FOR EACH ROW EXECUTE FUNCTION application_native_configuration_operation_guard();
CREATE FUNCTION application_native_configuration_operation_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE public.application_policy_contract_epoch SET revision=nextval('public.application_policy_revision_seq');RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_configuration_operation_epoch() FROM PUBLIC;
CREATE TRIGGER application_native_configuration_operation_epoch AFTER INSERT OR UPDATE OR DELETE ON application_native_configuration_operations
 FOR EACH ROW EXECUTE FUNCTION application_native_configuration_operation_epoch();

ALTER FUNCTION application_native_configuration_verified(uuid,text) RENAME TO application_native_configuration_verified_before_operations;
REVOKE ALL ON FUNCTION application_native_configuration_verified_before_operations(uuid,text) FROM PUBLIC;
CREATE FUNCTION application_native_configuration_verified(w uuid,module text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.application_native_configuration_operations o WHERE o.module_key=module)
  AND NOT EXISTS(SELECT 1 FROM public.application_native_field_contracts c WHERE c.module_key=module AND c.configuration_required AND c.configuration_reader IS NOT NULL) THEN RETURN false;END IF;
 RETURN public.application_native_configuration_verified_before_operations(w,module);
END $$;
REVOKE ALL ON FUNCTION application_native_configuration_verified(uuid,text) FROM PUBLIC;

-- Only identity and scope columns are enumerated. Existing canonical ports perform
-- current field/reference projection privately after row and complete field checks.
CREATE FUNCTION application_native_resource_governance_allows(w uuid,p_type text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE origin jsonb:='{"kind":"native","moduleKey":"native"}'; keys text[]; policy jsonb; catalog jsonb; source record; scope jsonb; k text;
BEGIN
 IF p_type NOT IN('company','person','deal','task','file','workspace_member') OR public.application_governance_allows(w) IS NOT TRUE THEN RETURN false;END IF;
 keys:=ARRAY(SELECT DISTINCT key FROM (SELECT unnest(public.application_native_field_keys(p_type)) AS key UNION ALL
  SELECT 'custom.'||f.field_key FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL) fields ORDER BY key);
 policy:=public.application_native_field_catalog_for(w,origin,p_type);catalog:=public.read_native_application_field_catalog(w,origin,p_type);
 IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
  OR NOT coalesce(to_jsonb(keys)<@(policy#>'{metadata,fieldKeys}') AND (policy#>'{metadata,fieldKeys}')<@to_jsonb(keys)
   AND to_jsonb(keys)<@(catalog->'readFields') AND to_jsonb(keys)<@(catalog->'writeFields'),false) THEN RETURN false;END IF;
 k:=CASE p_type WHEN 'task' THEN 'task' WHEN 'file' THEN 'workspace_file' WHEN 'workspace_member' THEN 'workspace_member' ELSE 'entity' END;
 FOR source IN SELECT e.id FROM public.entities e WHERE e.workspace_id=w AND e.kind=p_type AND e.valid_to IS NULL AND e.retracted_at IS NULL AND p_type IN('company','person','deal')
  UNION ALL SELECT t.id FROM public.tasks t WHERE t.workspace_id=w AND t.valid_to IS NULL AND t.retracted_at IS NULL AND p_type='task'
  UNION ALL SELECT f.id FROM public.workspace_files f WHERE f.workspace_id=w AND f.valid_to IS NULL AND f.retracted_at IS NULL AND p_type='file'
  UNION ALL SELECT m.user_id FROM public.workspace_members m WHERE m.workspace_id=w AND p_type='workspace_member' LOOP
  IF p_type IN('company','person','deal') THEN PERFORM 1 FROM public.entities e WHERE e.id=source.id AND e.workspace_id=w FOR SHARE;
  ELSIF p_type='task' THEN PERFORM 1 FROM public.tasks t WHERE t.id=source.id AND t.workspace_id=w FOR SHARE;
  ELSIF p_type='file' THEN PERFORM 1 FROM public.workspace_files f WHERE f.id=source.id AND f.workspace_id=w FOR SHARE;
  ELSE PERFORM 1 FROM public.workspace_members m WHERE m.user_id=source.id AND m.workspace_id=w FOR SHARE;END IF;
  scope:=public.read_admitted_native_scope_snapshot(w,k,source.id);
  IF scope IS NULL OR scope->>'held' IS DISTINCT FROM 'false' OR scope->>'validTo' IS NOT NULL OR scope->>'retractedAt' IS NOT NULL
   OR public.member_operation_scope_allows(w,scope->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),true) IS NOT TRUE
   OR public.agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(scope->'compartments'))) IS NOT TRUE THEN RETURN false;END IF;
  policy:=public.application_current_native_field_policy(w,origin,p_type,source.id);
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR NOT coalesce(to_jsonb(keys)<@(policy->'readFields') AND to_jsonb(keys)<@(policy->'writeFields'),false)
   OR public.application_field_projection_state(w,origin,p_type,source.id,'read',NULL,keys) IS NULL THEN RETURN false;END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_resource_governance_allows(uuid,text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION application_native_module_governance_allows(w uuid,module text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE owned public.application_native_resource_owners; actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR public.application_governance_allows(w) IS NOT TRUE
  OR public.application_native_configuration_verified(w,module) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.user_id=actor AND a.status='active'
    AND (a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp())) IS DISTINCT FROM
      (a.starts_at<=clock_timestamp() AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.application_native_field_contracts'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN false; END IF;
 -- Hold current native membership and explicit role rows for the operation.
 PERFORM 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=actor AND m.role IN('owner','admin') FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND a.user_id=actor
  AND a.status='active' AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp()) FOR SHARE;
 FOR owned IN SELECT o.* FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=module
   ORDER BY o.resource_type,o.origin::text FOR SHARE LOOP
  IF owned.origin->>'kind'='generic' THEN
   IF public.application_native_schema_governance_allows(w,(owned.origin->>'entityTypeId')::uuid) IS NOT TRUE THEN RETURN false;END IF;
  ELSE
   IF owned.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR module<>'native'
    OR public.application_native_resource_governance_allows(w,owned.resource_type) IS NOT TRUE THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_module_governance_allows(uuid,text) FROM PUBLIC;


CREATE FUNCTION application_native_configuration_revision(w uuid,module text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE reader regprocedure; namespace text; procedure_name text; revision text;
BEGIN
 SELECT c.configuration_reader INTO reader FROM public.application_native_field_contracts c WHERE c.module_key=module AND c.configuration_required;
 IF reader IS NULL OR public.application_native_configuration_port_valid(reader) IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT n.nspname,p.proname INTO namespace,procedure_name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=reader;
 EXECUTE format('SELECT %I.%I($1)',namespace,procedure_name) INTO revision USING w;
 IF length(revision) NOT BETWEEN 1 AND 256 OR revision !~ '^[A-Za-z0-9_.:-]+$' THEN RETURN NULL;END IF;RETURN revision;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_configuration_revision(uuid,text) FROM PUBLIC;
CREATE FUNCTION application_native_configuration_input_allows(fields jsonb,input jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field jsonb;value jsonb;
BEGIN
 IF public.application_native_configuration_fields_valid(fields) IS NOT TRUE OR jsonb_typeof(input) IS DISTINCT FROM 'object'
  OR octet_length(input::text)>16384 OR EXISTS(SELECT 1 FROM jsonb_object_keys(input) key WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) f WHERE f->>'key'=key)) THEN RETURN false;END IF;
 FOR field IN SELECT item FROM jsonb_array_elements(fields) item LOOP
  value:=input->(field->>'key');IF value IS NULL THEN IF (field->>'required')::boolean THEN RETURN false;END IF;CONTINUE;END IF;
  CASE field->>'kind'
  WHEN 'text' THEN IF jsonb_typeof(value)<>'string' OR length(value#>>'{}')>(field->>'maxLength')::int THEN RETURN false;END IF;
  WHEN 'boolean' THEN IF jsonb_typeof(value)<>'boolean' THEN RETURN false;END IF;
  WHEN 'integer' THEN IF jsonb_typeof(value)<>'number' OR (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric) OR (value#>>'{}')::numeric NOT BETWEEN -2147483648 AND 2147483647 THEN RETURN false;END IF;
  WHEN 'enum' THEN IF jsonb_typeof(value)<>'string' OR NOT (field->'values') @> jsonb_build_array(value) THEN RETURN false;END IF;
  ELSE RETURN false;END CASE;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_configuration_input_allows(jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION application_run_native_configuration(w uuid,module text,operation text,input jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE config public.application_native_configuration_operations;namespace text;procedure_name text;before_revision text;after_revision text;reported text;
BEGIN
 SELECT * INTO config FROM public.application_native_configuration_operations c WHERE c.module_key=module AND c.operation_key=operation FOR SHARE;
 before_revision:=public.application_native_configuration_revision(w,module);
 IF NOT FOUND OR before_revision IS NULL OR public.application_native_configuration_handler_valid(config.apply_handler) IS NOT TRUE
  OR public.application_native_configuration_input_allows(config.input_fields,input) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM unnest(config.required_role_keys) key WHERE NOT EXISTS(SELECT 1 FROM public.application_native_role_assignments a
   WHERE a.workspace_id=w AND a.module_key=module AND a.user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND a.role_key=key
    AND a.status='active' AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp()))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 SELECT n.nspname,p.proname INTO namespace,procedure_name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=config.apply_handler;
 EXECUTE format('SELECT %I.%I($1,$2)',namespace,procedure_name) INTO reported USING w,input;
 after_revision:=public.application_native_configuration_revision(w,module);
 IF after_revision IS NULL OR after_revision IS NOT DISTINCT FROM before_revision OR reported IS DISTINCT FROM after_revision
  OR public.application_native_module_governance_allows(w,module) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable: configuration revision incomplete' USING ERRCODE='42501';END IF;
 RETURN after_revision;
END $$;
REVOKE ALL ON FUNCTION application_run_native_configuration(uuid,text,text,jsonb) FROM PUBLIC;
CREATE FUNCTION application_native_configuration_proposal_allows(w uuid,module text,operation text,input jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed boolean:=false;
BEGIN
 BEGIN
  PERFORM public.application_run_native_configuration(w,module,operation,input);
  RAISE EXCEPTION 'validated configuration' USING ERRCODE='P0802';
 EXCEPTION WHEN SQLSTATE 'P0802' THEN allowed:=true;END;
 RETURN allowed;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_configuration_proposal_allows(uuid,text,text,jsonb) FROM PUBLIC;
CREATE FUNCTION application_native_canonical_owner_binding_allows(w uuid,module text,p_type text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed boolean:=false;canonical_origin jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF module<>'native' OR p_type NOT IN('company','person','deal','task','file','workspace_member') OR EXISTS(
  SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.origin=canonical_origin AND o.resource_type=p_type) THEN RETURN false;END IF;
 BEGIN
  INSERT INTO public.application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES(w,canonical_origin,p_type,module);
  IF public.application_native_resource_governance_allows(w,p_type) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  RAISE EXCEPTION 'validated restrictive native owner' USING ERRCODE='P0801';
 EXCEPTION WHEN SQLSTATE 'P0801' THEN allowed:=true;END;RETURN allowed;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_canonical_owner_binding_allows(uuid,text,text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION application_native_governance_revision(w uuid,acting uuid,module text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; epoch jsonb;
BEGIN
 IF public.application_native_module_governance_allows(w,module) IS NOT TRUE OR acting IS NULL
  OR public.assistant_placement_visible(actor,acting) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM public.assistants a WHERE a.id=acting AND a.workspace_id=w)
  OR nullif(current_setting('app.v2_assistant_id',true),'') IS NOT NULL AND current_setting('app.v2_assistant_id',true)::uuid<>acting THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 epoch:=public.read_application_policy_epoch(w,actor,acting);
 IF epoch IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.application_native_configuration_operations c WHERE c.module_key=module) THEN RETURN public.application_field_digest(epoch);END IF;
 RETURN public.application_field_digest(jsonb_build_object('epoch',epoch,'configurationRevision',public.application_native_configuration_revision(w,module),'configurationOperations',(SELECT coalesce(jsonb_agg(jsonb_build_object('key',c.operation_key,'fields',c.input_fields,'requiredRoleKeys',c.required_role_keys,'handler',public.application_policy_port_fingerprint(c.apply_handler)) ORDER BY c.operation_key),'[]') FROM public.application_native_configuration_operations c WHERE c.module_key=module)));
END $$;
REVOKE ALL ON FUNCTION application_native_governance_revision(uuid,uuid,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION application_native_governance_proposal_allows(w uuid,module text,proposal jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; begins timestamptz; ends timestamptz; target public.application_native_role_assignments;
BEGIN
 IF jsonb_typeof(proposal) IS DISTINCT FROM 'object' OR public.application_native_module_governance_allows(w,module) IS NOT TRUE THEN RETURN false; END IF;
 CASE proposal->>'kind'
 WHEN 'assign_role' THEN
  IF proposal-ARRAY['kind','userId','roleKey','startsAt','expiresAt']<>'{}'::jsonb
   OR NOT proposal ?& ARRAY['kind','userId','roleKey','startsAt','expiresAt']
   OR jsonb_typeof(proposal->'userId') IS DISTINCT FROM 'string' OR jsonb_typeof(proposal->'roleKey') IS DISTINCT FROM 'string'
   OR jsonb_typeof(proposal->'startsAt') IS DISTINCT FROM 'string'
   OR jsonb_typeof(proposal->'expiresAt') NOT IN('string','null')
   OR NOT EXISTS(SELECT 1 FROM public.application_native_field_contracts c WHERE c.module_key=module AND proposal->>'roleKey'=ANY(c.role_keys)) THEN RETURN false; END IF;
  begins:=(proposal->>'startsAt')::timestamptz;ends:=(proposal->>'expiresAt')::timestamptz;
  IF NOT isfinite(begins) OR ends IS NOT NULL AND (NOT isfinite(ends) OR ends<=begins OR ends<=statement_timestamp()) THEN RETURN false; END IF;
  PERFORM 1 FROM public.workspace_members m WHERE m.workspace_id=w AND m.user_id=(proposal->>'userId')::uuid FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Delegation cannot manufacture a role or extend its current issuer horizon.
  RETURN EXISTS(SELECT 1 FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND a.user_id=actor
   AND a.role_key=proposal->>'roleKey' AND a.status='active' AND a.starts_at<=statement_timestamp()
   AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp() AND ends IS NOT NULL AND ends<=a.expires_at));
 WHEN 'revoke_role' THEN
  IF proposal-ARRAY['kind','assignmentId','expectedVersion']<>'{}'::jsonb
   OR NOT proposal ?& ARRAY['kind','assignmentId','expectedVersion'] OR jsonb_typeof(proposal->'assignmentId') IS DISTINCT FROM 'string'
   OR jsonb_typeof(proposal->'expectedVersion') IS DISTINCT FROM 'string' OR proposal->>'expectedVersion' !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
  SELECT * INTO target FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND a.id=(proposal->>'assignmentId')::uuid FOR SHARE;
  RETURN FOUND AND target.status='active' AND target.version::text=proposal->>'expectedVersion';
 WHEN 'bind_owner' THEN
  IF proposal-ARRAY['kind','entityTypeId']<>'{}'::jsonb OR NOT proposal ?& ARRAY['kind','entityTypeId']
    OR jsonb_typeof(proposal->'entityTypeId') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  RETURN public.application_native_owner_binding_allows(w,module,(proposal->>'entityTypeId')::uuid);
 WHEN 'bind_native_owner' THEN
  IF proposal-ARRAY['kind','typeKey']<>'{}' OR NOT proposal ?& ARRAY['kind','typeKey'] OR jsonb_typeof(proposal->'typeKey') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  RETURN public.application_native_canonical_owner_binding_allows(w,module,proposal->>'typeKey');
 WHEN 'configure_crm' THEN
  IF module<>'native' OR proposal-ARRAY['kind','command']<>'{}' OR NOT proposal ?& ARRAY['kind','command'] THEN RETURN false;END IF;
  RETURN public.application_native_crm_configuration_proposal_allows(w,proposal->'command');
 WHEN 'configure' THEN
  IF proposal-ARRAY['kind','operationKey','input']<>'{}' OR NOT proposal ?& ARRAY['kind','operationKey','input'] OR jsonb_typeof(proposal->'operationKey') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  RETURN public.application_native_configuration_proposal_allows(w,module,proposal->>'operationKey',proposal->'input');
 ELSE RETURN false;
 END CASE;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR datetime_field_overflow OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_governance_proposal_allows(uuid,text,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION read_native_application_governance_catalog(w uuid,acting uuid,module text,after_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision text; roles text[]; assignments jsonb; cursor_id uuid; configuration jsonb; configuration_revision text;
BEGIN
 revision:=public.application_native_governance_revision(w,acting,module);
 SELECT c.role_keys INTO roles FROM public.application_native_field_contracts c WHERE c.module_key=module;
 IF roles IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(metadata ORDER BY id),'[]'::jsonb) INTO assignments FROM (
  SELECT a.id,jsonb_build_object('id',a.id,'userId',a.user_id,'roleKey',a.role_key,'status',a.status,'startsAt',a.starts_at,
    'expiresAt',a.expires_at,'version',a.version::text,'issuedByUserId',a.issued_by_user_id) AS metadata
   FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND (after_id IS NULL OR a.id>after_id)
   ORDER BY a.id LIMIT 100) page;
 cursor_id:=(assignments->-1->>'id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.application_native_role_assignments a WHERE a.workspace_id=w AND a.module_key=module AND a.id>cursor_id) THEN cursor_id:=NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('operationKey',c.operation_key,'inputFields',c.input_fields,'requiredRoleKeys',c.required_role_keys) ORDER BY c.operation_key),'[]') INTO configuration
  FROM public.application_native_configuration_operations c WHERE c.module_key=module;
 IF jsonb_array_length(configuration)>32 OR EXISTS(SELECT 1 FROM public.application_native_configuration_operations c WHERE c.module_key=module AND (public.application_native_configuration_handler_valid(c.apply_handler) IS NOT TRUE OR public.application_native_configuration_fields_valid(c.input_fields) IS NOT TRUE)) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF configuration<>'[]' THEN configuration_revision:=public.application_native_configuration_revision(w,module);IF configuration_revision IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;END IF;
 RETURN jsonb_build_object('moduleKey',module,'revision',revision,'roleKeys',roles,'operations',to_jsonb(ARRAY['assign_role','revoke_role','bind_owner'])||CASE WHEN module='native' THEN '["bind_native_owner","configure_crm"]'::jsonb ELSE '[]'::jsonb END||CASE WHEN configuration<>'[]' THEN '["configure"]'::jsonb ELSE '[]'::jsonb END,
  'nativeResourceTypes',CASE WHEN module='native' THEN to_jsonb(ARRAY['company','person','deal','task','file','workspace_member']) ELSE '[]'::jsonb END,
  'ownedNativeResourceTypes',(SELECT coalesce(jsonb_agg(o.resource_type ORDER BY o.resource_type),'[]') FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=module AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb),
  'configurationOperations',configuration,'configurationRevision',configuration_revision,
  'roleAssignments',assignments,'nextCursor',cursor_id);
END $$;
REVOKE ALL ON FUNCTION read_native_application_governance_catalog(uuid,uuid,text,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION application_apply_native_governance_review(w uuid,acting uuid,review_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE review public.application_native_governance_reviews; revision text; resource_id uuid; target_version text; operation_outcome jsonb; configuration_revision text; crm_outcome jsonb;
BEGIN
 SELECT * INTO review FROM public.application_native_governance_reviews r WHERE r.id=review_id AND r.workspace_id=w
  AND r.actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid AND r.assistant_id=acting FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('application-native-governance:'||w::text||':'||review.module_key,0));
 revision:=public.application_native_governance_revision(w,acting,review.module_key);
 IF revision IS DISTINCT FROM coalesce(review.applied_revision,review.reviewed_revision) THEN
  RAISE EXCEPTION 'record_version_conflict: reviewed authority changed' USING ERRCODE='40001'; END IF;
 IF review.outcome IS NOT NULL THEN RETURN review.outcome; END IF;
 IF review.expires_at<=clock_timestamp() OR public.application_native_governance_proposal_allows(w,review.module_key,review.proposal) IS NOT TRUE THEN
  RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 CASE review.proposal->>'kind'
 WHEN 'assign_role' THEN
  INSERT INTO public.application_native_role_assignments(workspace_id,module_key,user_id,role_key,starts_at,expires_at,issued_by_user_id)
   VALUES(w,review.module_key,(review.proposal->>'userId')::uuid,review.proposal->>'roleKey',(review.proposal->>'startsAt')::timestamptz,
    (review.proposal->>'expiresAt')::timestamptz,review.actor_user_id) RETURNING id,version::text INTO resource_id,target_version;
 WHEN 'revoke_role' THEN
  UPDATE public.application_native_role_assignments a SET status='revoked' WHERE a.workspace_id=w AND a.module_key=review.module_key
   AND a.id=(review.proposal->>'assignmentId')::uuid AND a.version::text=review.proposal->>'expectedVersion' AND a.status='active'
   RETURNING id,version::text INTO resource_id,target_version;
  IF resource_id IS NULL THEN RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001'; END IF;
 WHEN 'bind_owner' THEN
  resource_id:=(review.proposal->>'entityTypeId')::uuid;
  INSERT INTO public.application_native_resource_owners(workspace_id,origin,resource_type,module_key)
   VALUES(w,jsonb_build_object('kind','generic','entityTypeId',resource_id),'record.'||resource_id,review.module_key);
  target_version:='1';
 WHEN 'bind_native_owner' THEN
  resource_id:=w;target_version:='1';
  INSERT INTO public.application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES(w,'{"kind":"native","moduleKey":"native"}'::jsonb,review.proposal->>'typeKey',review.module_key);
 WHEN 'configure_crm' THEN
  crm_outcome:=public.application_run_native_crm_configuration(w,review.proposal->'command');resource_id:=(crm_outcome->>'resourceId')::uuid;
  SELECT e.revision::text INTO target_version FROM public.application_policy_workspace_epochs e WHERE e.workspace_id=w;
 WHEN 'configure' THEN
  resource_id:=w;configuration_revision:=public.application_run_native_configuration(w,review.module_key,review.proposal->>'operationKey',review.proposal->'input');target_version:='1';
 ELSE RAISE EXCEPTION 'invalid_value' USING ERRCODE='22023';
 END CASE;
 -- A self-revocation returns only the explicit operation's content-free
 -- outcome. Lost field governance is never reused for a subsequent read/replay.
 IF review.proposal->>'kind'='revoke_role' AND EXISTS(SELECT 1 FROM public.application_native_role_assignments a
  WHERE a.id=resource_id AND a.user_id=review.actor_user_id) THEN
  revision:=public.application_field_digest(public.read_application_policy_epoch(w,review.actor_user_id,acting));
  IF revision IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501'; END IF;
 ELSE
  revision:=public.application_native_governance_revision(w,acting,review.module_key);
 END IF;
 operation_outcome:=jsonb_build_object('id',review.id,'moduleKey',review.module_key,'kind',review.proposal->>'kind','resourceId',resource_id,'version',target_version,'applied',true);
 IF review.proposal->>'kind'='bind_native_owner' THEN operation_outcome:=operation_outcome||jsonb_build_object('typeKey',review.proposal->>'typeKey');END IF;
 IF crm_outcome IS NOT NULL THEN operation_outcome:=operation_outcome||jsonb_build_object('subjectKind',crm_outcome->>'subjectKind','created',(crm_outcome->>'created')::boolean,'changed',(crm_outcome->>'changed')::boolean);END IF;
 IF configuration_revision IS NOT NULL THEN operation_outcome:=operation_outcome||jsonb_build_object('configurationRevision',configuration_revision);END IF;
 UPDATE public.application_native_governance_reviews r SET applied_revision=revision,outcome=operation_outcome WHERE r.id=review.id;
 INSERT INTO public.application_native_governance_events(review_id,workspace_id,module_key,actor_user_id,operation_kind,resource_id)
  VALUES(review.id,w,review.module_key,review.actor_user_id,review.proposal->>'kind',resource_id);
 RETURN operation_outcome;
END $$;
REVOKE ALL ON FUNCTION application_apply_native_governance_review(uuid,uuid,uuid) FROM PUBLIC;
CREATE TABLE application_native_crm_configuration_epochs (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 revision bigint NOT NULL CHECK(revision>0)
);
ALTER TABLE application_native_crm_configuration_epochs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_native_crm_configuration_epochs FROM PUBLIC;
CREATE FUNCTION application_native_crm_configuration_revision(w uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT revision::text FROM public.application_native_crm_configuration_epochs WHERE workspace_id=w),'0')
$$;
REVOKE ALL ON FUNCTION application_native_crm_configuration_revision(uuid) FROM PUBLIC;
CREATE FUNCTION application_native_crm_configuration_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
BEGIN
 IF EXISTS(SELECT 1 FROM public.workspaces WHERE id=w) THEN
  INSERT INTO public.application_native_crm_configuration_epochs(workspace_id,revision) VALUES(w,nextval('public.application_policy_revision_seq'))
   ON CONFLICT(workspace_id) DO UPDATE SET revision=nextval('public.application_policy_revision_seq');
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_crm_configuration_changed() FROM PUBLIC;
-- Canonical protected CRM configuration uses the same saved native reviews.
CREATE TABLE application_native_configuration_execution (
 transaction_id bigint NOT NULL,backend_pid integer NOT NULL,workspace_id uuid NOT NULL,
 actor_user_id uuid NOT NULL,PRIMARY KEY(transaction_id,backend_pid,workspace_id)
);
ALTER TABLE application_native_configuration_execution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_native_configuration_execution FROM PUBLIC;
CREATE FUNCTION application_native_crm_configuration_protected(w uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=w
  AND o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type IN('company','person','deal'))
$$;
REVOKE ALL ON FUNCTION application_native_crm_configuration_protected(uuid) FROM PUBLIC;
CREATE FUNCTION application_guard_native_crm_configuration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
BEGIN
 IF TG_OP='UPDATE' AND NEW.workspace_id<>OLD.workspace_id THEN RAISE EXCEPTION 'immutable configuration workspace' USING ERRCODE='22023';END IF;
 IF public.application_native_crm_configuration_protected(w) AND EXISTS(SELECT 1 FROM public.workspaces WHERE id=w)
  AND NOT EXISTS(SELECT 1 FROM public.application_native_configuration_execution e WHERE e.transaction_id=txid_current()
   AND e.backend_pid=pg_backend_pid() AND e.workspace_id=w AND e.actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid) THEN
  RAISE EXCEPTION 'access_unavailable: protected configuration requires a current typed review' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION application_guard_native_crm_configuration() FROM PUBLIC;
DO $$ DECLARE relation text;BEGIN
 FOREACH relation IN ARRAY ARRAY['crm_pipelines','crm_pipeline_stages','crm_field_definitions'] LOOP
  EXECUTE format('CREATE TRIGGER application_native_configuration_authority BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.application_guard_native_crm_configuration()',relation);
  EXECUTE format('CREATE TRIGGER application_native_configuration_epoch AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.application_policy_epoch_changed()',relation);
  EXECUTE format('CREATE TRIGGER application_native_crm_configuration_revision AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.application_native_crm_configuration_changed()',relation);
 END LOOP;
END $$;
CREATE FUNCTION application_native_crm_configuration_command_valid(command jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed text[];required text[];key text;value jsonb;
BEGIN
 IF jsonb_typeof(command) IS DISTINCT FROM 'object' OR octet_length(command::text)>65536 THEN RETURN false;END IF;
 CASE command->>'kind'
 WHEN 'create_record_field' THEN allowed:=ARRAY['kind','entityKind','fieldKey','label','fieldType','options','isRequired'];required:=ARRAY['kind','entityKind','fieldKey','label','fieldType'];
 WHEN 'update_record_field' THEN allowed:=ARRAY['kind','fieldId','label','options','isRequired'];required:=ARRAY['kind','fieldId'];
 WHEN 'set_record_field_archived' THEN allowed:=ARRAY['kind','fieldId','archived'];required:=allowed;
 WHEN 'create_pipeline' THEN allowed:=ARRAY['kind','name','isDefault'];required:=ARRAY['kind','name'];
 WHEN 'update_pipeline' THEN allowed:=ARRAY['kind','pipelineId','name','isDefault','archived'];required:=ARRAY['kind','pipelineId'];
 WHEN 'create_pipeline_stage' THEN allowed:=ARRAY['kind','pipelineId','name','category','probability','requiredFields'];required:=ARRAY['kind','pipelineId','name','category','probability'];
 WHEN 'update_pipeline_stage' THEN allowed:=ARRAY['kind','stageId','name','category','probability','requiredFields','archived'];required:=ARRAY['kind','stageId'];
 WHEN 'reorder_pipelines' THEN allowed:=ARRAY['kind','orderedIds'];required:=allowed;
 WHEN 'reorder_pipeline_stages' THEN allowed:=ARRAY['kind','pipelineId','orderedIds'];required:=allowed;
 WHEN 'reorder_record_fields' THEN allowed:=ARRAY['kind','entityKind','orderedIds'];required:=allowed;
 ELSE RETURN false;END CASE;
 IF command-allowed<>'{}' OR NOT command ?& required THEN RETURN false;END IF;
 FOR key,value IN SELECT * FROM jsonb_each(command) LOOP
  IF key IN('name','label') AND (jsonb_typeof(value)<>'string' OR length(value#>>'{}') NOT BETWEEN 1 AND 100 OR btrim(value#>>'{}')<>value#>>'{}') THEN RETURN false;END IF;
  IF key IN('fieldId','pipelineId','stageId') THEN IF jsonb_typeof(value)<>'string' OR (value#>>'{}')::uuid IS NULL THEN RETURN false;END IF;END IF;
  IF key='fieldKey' AND (jsonb_typeof(value)<>'string' OR value#>>'{}' !~ '^[a-z][a-z0-9_]{0,62}$') THEN RETURN false;END IF;
  IF key='entityKind' AND (jsonb_typeof(value)<>'string' OR value#>>'{}' NOT IN('company','person','deal')) THEN RETURN false;END IF;
  IF key='fieldType' AND (jsonb_typeof(value)<>'string' OR value#>>'{}' NOT IN('text','number','date','boolean','single_select','multi_select','entity_reference')) THEN RETURN false;END IF;
  IF key IN('isRequired','isDefault','archived') AND jsonb_typeof(value)<>'boolean' THEN RETURN false;END IF;
  IF key='category' AND (jsonb_typeof(value)<>'string' OR value#>>'{}' NOT IN('open','won','lost')) THEN RETURN false;END IF;
  IF key='probability' AND (jsonb_typeof(value)<>'number' OR (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric) OR (value#>>'{}')::numeric NOT BETWEEN 0 AND 100) THEN RETURN false;END IF;
  IF key IN('options','requiredFields','orderedIds') THEN
   IF jsonb_typeof(value)<>'array' OR jsonb_array_length(value)>200 OR EXISTS(SELECT 1 FROM jsonb_array_elements(value) item WHERE jsonb_typeof(item)<>'string' OR length(item#>>'{}') NOT BETWEEN 1 AND CASE WHEN key='options' THEN 200 ELSE 100 END)
    OR (SELECT count(*)<>count(DISTINCT item) FROM jsonb_array_elements(value) item) THEN RETURN false;END IF;
   IF key='orderedIds' THEN PERFORM (item#>>'{}')::uuid FROM jsonb_array_elements(value) item;END IF;
  END IF;
 END LOOP;
 IF command->>'kind'='create_record_field' AND command->>'fieldType' IN('single_select','multi_select','entity_reference') AND jsonb_array_length(coalesce(command->'options','[]'))=0 THEN RETURN false;END IF;
 IF command->>'fieldType'='entity_reference' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(command->'options') item WHERE item NOT IN('company','person','deal')) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_crm_configuration_command_valid(jsonb) FROM PUBLIC;
CREATE FUNCTION application_native_crm_configuration_item(w uuid,kind text,item_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE item jsonb;
BEGIN
 IF kind='record_field' THEN SELECT jsonb_build_object('id',f.id,'entityKind',f.entity_kind,'fieldKey',f.field_key,'label',f.label,'fieldType',f.field_type,'options',f.options,'isRequired',f.is_required,'position',f.position,'archivedAt',f.archived_at) INTO item FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.id=item_id;
 ELSIF kind='pipeline' THEN SELECT jsonb_build_object('id',p.id,'name',p.name,'isDefault',p.is_default,'position',p.position,'archivedAt',p.archived_at,'stages','[]'::jsonb) INTO item FROM public.crm_pipelines p WHERE p.workspace_id=w AND p.id=item_id;
 ELSIF kind='pipeline_stage' THEN SELECT jsonb_build_object('id',s.id,'pipelineId',s.pipeline_id,'name',s.name,'legacyKey',s.legacy_key,'category',s.category,'position',s.position,'probability',s.probability,'requiredFields',s.required_fields,'archivedAt',s.archived_at) INTO item FROM public.crm_pipeline_stages s WHERE s.workspace_id=w AND s.id=item_id;
 ELSE item:=jsonb_build_object('id',w);END IF;RETURN item;
END $$;
REVOKE ALL ON FUNCTION application_native_crm_configuration_item(uuid,text,uuid) FROM PUBLIC;
CREATE FUNCTION application_native_crm_configuration_fingerprint(w uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT public.application_field_digest(jsonb_build_object('pipelines',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') FROM public.crm_pipelines p WHERE p.workspace_id=w),
  'stages',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') FROM public.crm_pipeline_stages s WHERE s.workspace_id=w),
  'fields',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id),'[]') FROM public.crm_field_definitions f WHERE f.workspace_id=w)))
$$;
REVOKE ALL ON FUNCTION application_native_crm_configuration_fingerprint(uuid) FROM PUBLIC;
CREATE FUNCTION application_native_crm_configuration_governance_allows(w uuid,command jsonb DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p_type text;source record;scope jsonb;keys text[];affected text[];entity_kind text;
BEGIN
 IF public.application_native_module_governance_allows(w,'native') IS NOT TRUE THEN RETURN false;END IF;
 IF command IS NULL THEN affected:=ARRAY['company','person','deal'];
 ELSIF command->>'kind' IN('create_record_field','reorder_record_fields') THEN affected:=ARRAY[command->>'entityKind'];
 ELSIF command->>'kind' IN('update_record_field','set_record_field_archived') THEN
  SELECT f.entity_kind INTO entity_kind FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.id=(command->>'fieldId')::uuid;
  IF entity_kind IS NULL THEN RETURN false;END IF;affected:=ARRAY[entity_kind];
 ELSE affected:=ARRAY['deal'];END IF;
 FOREACH p_type IN ARRAY affected LOOP
  IF EXISTS(SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.origin='{"kind":"native","moduleKey":"native"}' AND o.resource_type=p_type) THEN
   IF public.application_native_resource_governance_allows(w,p_type) IS NOT TRUE THEN RETURN false;END IF;
  ELSE
   keys:=ARRAY(SELECT DISTINCT key FROM (SELECT unnest(public.application_native_field_keys(p_type)) key UNION ALL SELECT 'custom.'||f.field_key FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=p_type AND f.archived_at IS NULL) k ORDER BY key);
   FOR source IN SELECT e.id FROM public.entities e WHERE e.workspace_id=w AND e.kind=p_type AND e.valid_to IS NULL AND e.retracted_at IS NULL ORDER BY e.id FOR SHARE LOOP
    scope:=public.read_admitted_native_scope_snapshot(w,'entity',source.id);
    IF scope IS NULL OR scope->>'held' IS DISTINCT FROM 'false' OR public.member_operation_scope_allows(w,scope->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(scope->'compartments')),true) IS NOT TRUE
     OR public.agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(scope->'compartments'))) IS NOT TRUE
     OR public.application_field_projection_state(w,'{"kind":"native","moduleKey":"native"}',p_type,source.id,'read',NULL,keys) IS NULL THEN RETURN false;END IF;
   END LOOP;
  END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_crm_configuration_governance_allows(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION application_run_native_crm_configuration(w uuid,command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;item_id uuid;subject text;before text;created boolean:=false;
 field public.crm_field_definitions;pipeline public.crm_pipelines;stage public.crm_pipeline_stages;row_value record;state jsonb;current_ids uuid[];requested uuid[];proposed_options jsonb;required boolean;
BEGIN
 IF public.application_native_crm_configuration_command_valid(command) IS NOT TRUE OR public.application_native_crm_configuration_governance_allows(w,command) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 PERFORM public.application_lock_canonical_crm_configuration(w);
 before:=public.application_native_crm_configuration_fingerprint(w);
 INSERT INTO public.application_native_configuration_execution VALUES(txid_current(),pg_backend_pid(),w,actor);
 CASE command->>'kind'
 WHEN 'create_record_field' THEN
  subject:='record_field';created:=true;
  IF (SELECT count(*) FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=command->>'entityKind' AND f.archived_at IS NULL)>=50 THEN RAISE EXCEPTION 'field limit reached' USING ERRCODE='23514';END IF;
  INSERT INTO public.crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,options,is_required,position,created_by)
   VALUES(w,command->>'entityKind',command->>'fieldKey',command->>'label',command->>'fieldType',coalesce(command->'options','[]'),coalesce((command->>'isRequired')::boolean,false),
    coalesce((SELECT max(f.position)+1 FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=command->>'entityKind'),0),actor) RETURNING id INTO item_id;
 WHEN 'update_record_field','set_record_field_archived' THEN
  subject:='record_field';item_id:=(command->>'fieldId')::uuid;SELECT * INTO field FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.id=item_id FOR UPDATE;
  IF NOT FOUND OR command->>'kind'='update_record_field' AND field.archived_at IS NOT NULL THEN RAISE EXCEPTION 'configuration unavailable' USING ERRCODE='42501';END IF;
  IF command->>'kind'='update_record_field' THEN
   proposed_options:=coalesce(command->'options',field.options);required:=coalesce((command->>'isRequired')::boolean,field.is_required);
   IF field.field_type IN('single_select','multi_select','entity_reference') AND jsonb_array_length(proposed_options)=0 OR field.field_type='entity_reference' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(proposed_options) item WHERE item NOT IN('company','person','deal')) THEN RAISE EXCEPTION 'invalid field options' USING ERRCODE='22023';END IF;
   -- Current admitted selected values only; never a new owner payload reader.
   FOR row_value IN SELECT e.id FROM public.entities e WHERE e.workspace_id=w AND e.kind=field.entity_kind AND e.valid_to IS NULL AND e.retracted_at IS NULL ORDER BY e.id FOR SHARE LOOP
    state:=public.application_field_projection_state(w,'{"kind":"native","moduleKey":"native"}',field.entity_kind,row_value.id,'read',NULL,ARRAY['custom.'||field.field_key]);
    IF state IS NULL OR public.application_native_custom_value_valid(field.field_type,proposed_options,required,state#>ARRAY['values','custom.'||field.field_key]) IS NOT TRUE THEN RAISE EXCEPTION 'existing field values require repair' USING ERRCODE='23514';END IF;
   END LOOP;
   UPDATE public.crm_field_definitions SET label=coalesce(command->>'label',label),options=proposed_options,is_required=required WHERE workspace_id=w AND id=item_id;
  ELSE
   IF NOT (command->>'archived')::boolean AND field.archived_at IS NOT NULL AND (SELECT count(*) FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=field.entity_kind AND f.archived_at IS NULL)>=50 THEN RAISE EXCEPTION 'field limit reached' USING ERRCODE='23514';END IF;
   UPDATE public.crm_field_definitions SET archived_at=CASE WHEN (command->>'archived')::boolean THEN coalesce(archived_at,now()) END,
    position=CASE WHEN NOT (command->>'archived')::boolean AND field.archived_at IS NOT NULL THEN coalesce((SELECT max(f.position)+1 FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=field.entity_kind),0) ELSE position END WHERE workspace_id=w AND id=item_id;
  END IF;
 WHEN 'create_pipeline' THEN
  subject:='pipeline';created:=true;
  IF coalesce((command->>'isDefault')::boolean,false) THEN UPDATE public.crm_pipelines SET is_default=false WHERE workspace_id=w AND is_default;END IF;
  INSERT INTO public.crm_pipelines(workspace_id,name,is_default,position,created_by) VALUES(w,command->>'name',coalesce((command->>'isDefault')::boolean,false),coalesce((SELECT max(p.position)+1 FROM public.crm_pipelines p WHERE p.workspace_id=w AND p.archived_at IS NULL),0),actor) RETURNING id INTO item_id;
 WHEN 'update_pipeline' THEN
  subject:='pipeline';item_id:=(command->>'pipelineId')::uuid;SELECT * INTO pipeline FROM public.crm_pipelines p WHERE p.workspace_id=w AND p.id=item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'configuration unavailable' USING ERRCODE='42501';END IF;
  IF coalesce((command->>'archived')::boolean,false) AND (pipeline.is_default OR coalesce((command->>'isDefault')::boolean,false))
   OR command->>'isDefault'='false' AND pipeline.is_default AND command->>'archived' IS DISTINCT FROM 'true'
   OR pipeline.archived_at IS NOT NULL AND command->>'isDefault'='true' AND command->>'archived' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'invalid default lifecycle' USING ERRCODE='23514';END IF;
  IF command->>'archived'='true' THEN
   FOR row_value IN SELECT e.id FROM public.entities e WHERE e.workspace_id=w AND e.kind='deal' AND e.valid_to IS NULL AND e.retracted_at IS NULL ORDER BY e.id FOR SHARE LOOP
    state:=public.application_field_projection_state(w,'{"kind":"native","moduleKey":"native"}','deal',row_value.id,'read',NULL,ARRAY['pipelineId']);
    IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
    IF state#>>'{values,pipelineId}'=item_id::text THEN RAISE EXCEPTION 'pipeline is in use' USING ERRCODE='23514';END IF;
   END LOOP;
  END IF;
  IF command->>'isDefault'='true' THEN UPDATE public.crm_pipelines SET is_default=false WHERE workspace_id=w AND is_default;END IF;
  UPDATE public.crm_pipelines SET name=coalesce(command->>'name',name),is_default=CASE WHEN command->>'archived'='true' THEN false ELSE coalesce((command->>'isDefault')::boolean,is_default) END,
   archived_at=CASE WHEN command ? 'archived' THEN CASE WHEN (command->>'archived')::boolean THEN coalesce(archived_at,now()) END ELSE archived_at END,
   position=CASE WHEN pipeline.archived_at IS NOT NULL AND command->>'archived'='false' THEN coalesce((SELECT max(p.position)+1 FROM public.crm_pipelines p WHERE p.workspace_id=w AND p.archived_at IS NULL),0) ELSE position END WHERE workspace_id=w AND id=item_id;
 WHEN 'create_pipeline_stage' THEN
  subject:='pipeline_stage';created:=true;
  IF NOT EXISTS(SELECT 1 FROM public.crm_pipelines p WHERE p.workspace_id=w AND p.id=(command->>'pipelineId')::uuid AND p.archived_at IS NULL) THEN RAISE EXCEPTION 'parent pipeline unavailable' USING ERRCODE='42501';END IF;
  INSERT INTO public.crm_pipeline_stages(workspace_id,pipeline_id,name,category,probability,required_fields,position)
   VALUES(w,(command->>'pipelineId')::uuid,command->>'name',command->>'category',(command->>'probability')::int,ARRAY(SELECT jsonb_array_elements_text(coalesce(command->'requiredFields','[]'))),
    coalesce((SELECT max(s.position)+1 FROM public.crm_pipeline_stages s WHERE s.workspace_id=w AND s.pipeline_id=(command->>'pipelineId')::uuid AND s.archived_at IS NULL),0)) RETURNING id INTO item_id;
 WHEN 'update_pipeline_stage' THEN
  subject:='pipeline_stage';item_id:=(command->>'stageId')::uuid;SELECT * INTO stage FROM public.crm_pipeline_stages s WHERE s.workspace_id=w AND s.id=item_id FOR UPDATE;
  IF NOT FOUND OR stage.archived_at IS NOT NULL AND command-ARRAY['kind','stageId','archived']<>'{}' AND command->>'archived' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'stage unavailable' USING ERRCODE='42501';END IF;
  IF command->>'archived'='false' AND NOT EXISTS(SELECT 1 FROM public.crm_pipelines p WHERE p.workspace_id=w AND p.id=stage.pipeline_id AND p.archived_at IS NULL) THEN RAISE EXCEPTION 'parent pipeline unavailable' USING ERRCODE='42501';END IF;
  IF command->>'archived'='true' THEN
   FOR row_value IN SELECT e.id FROM public.entities e WHERE e.workspace_id=w AND e.kind='deal' AND e.valid_to IS NULL AND e.retracted_at IS NULL ORDER BY e.id FOR SHARE LOOP
    state:=public.application_field_projection_state(w,'{"kind":"native","moduleKey":"native"}','deal',row_value.id,'read',NULL,ARRAY['pipelineStageId']);
    IF state IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
    IF state#>>'{values,pipelineStageId}'=item_id::text THEN RAISE EXCEPTION 'stage is in use' USING ERRCODE='23514';END IF;
   END LOOP;
  END IF;
  UPDATE public.crm_pipeline_stages SET name=coalesce(command->>'name',name),category=coalesce(command->>'category',category),probability=coalesce((command->>'probability')::int,probability),
   required_fields=CASE WHEN command ? 'requiredFields' THEN ARRAY(SELECT jsonb_array_elements_text(command->'requiredFields')) ELSE required_fields END,
   archived_at=CASE WHEN command ? 'archived' THEN CASE WHEN (command->>'archived')::boolean THEN coalesce(archived_at,now()) END ELSE archived_at END,
   position=CASE WHEN stage.archived_at IS NOT NULL AND command->>'archived'='false' THEN coalesce((SELECT max(s.position)+1 FROM public.crm_pipeline_stages s WHERE s.workspace_id=w AND s.pipeline_id=stage.pipeline_id AND s.archived_at IS NULL),0) ELSE position END WHERE workspace_id=w AND id=item_id;
 WHEN 'reorder_pipelines','reorder_pipeline_stages','reorder_record_fields' THEN
  item_id:=w;subject:='configuration_order';requested:=ARRAY(SELECT jsonb_array_elements_text(command->'orderedIds')::uuid);
  IF command->>'kind'='reorder_pipelines' THEN SELECT array_agg(p.id ORDER BY p.id) INTO current_ids FROM public.crm_pipelines p WHERE p.workspace_id=w AND p.archived_at IS NULL;
  ELSIF command->>'kind'='reorder_pipeline_stages' THEN SELECT array_agg(s.id ORDER BY s.id) INTO current_ids FROM public.crm_pipeline_stages s WHERE s.workspace_id=w AND s.pipeline_id=(command->>'pipelineId')::uuid AND s.archived_at IS NULL;
  ELSE SELECT array_agg(f.id ORDER BY f.id) INTO current_ids FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.entity_kind=command->>'entityKind' AND f.archived_at IS NULL;END IF;
  IF NOT coalesce(current_ids,'{}') @> requested OR NOT requested @> coalesce(current_ids,'{}') OR cardinality(requested)<>cardinality(coalesce(current_ids,'{}')) THEN RAISE EXCEPTION 'exact current order required' USING ERRCODE='40001';END IF;
  IF command->>'kind'='reorder_pipelines' THEN UPDATE public.crm_pipelines SET position=position+1000000 WHERE workspace_id=w AND id=ANY(requested);UPDATE public.crm_pipelines p SET position=array_position(requested,p.id)-1 WHERE p.workspace_id=w AND p.id=ANY(requested);
  ELSIF command->>'kind'='reorder_pipeline_stages' THEN UPDATE public.crm_pipeline_stages SET position=position+1000000 WHERE workspace_id=w AND id=ANY(requested);UPDATE public.crm_pipeline_stages s SET position=array_position(requested,s.id)-1 WHERE s.workspace_id=w AND s.id=ANY(requested);
  ELSE UPDATE public.crm_field_definitions SET position=position+1000000 WHERE workspace_id=w AND id=ANY(requested);UPDATE public.crm_field_definitions f SET position=array_position(requested,f.id)-1 WHERE f.workspace_id=w AND f.id=ANY(requested);END IF;
 ELSE RAISE EXCEPTION 'invalid configuration command' USING ERRCODE='22023';END CASE;
 IF subject='record_field' THEN
  SELECT * INTO field FROM public.crm_field_definitions f WHERE f.workspace_id=w AND f.id=item_id;
  IF field.archived_at IS NULL THEN
   FOR row_value IN SELECT e.id FROM public.entities e WHERE e.workspace_id=w AND e.kind=field.entity_kind AND e.valid_to IS NULL AND e.retracted_at IS NULL ORDER BY e.id FOR SHARE LOOP
    state:=public.application_field_projection_state(w,'{"kind":"native","moduleKey":"native"}',field.entity_kind,row_value.id,'read',NULL,ARRAY['custom.'||field.field_key]);
    IF state IS NULL OR public.application_native_custom_value_valid(field.field_type,field.options,field.is_required,state#>ARRAY['values','custom.'||field.field_key]) IS NOT TRUE THEN RAISE EXCEPTION 'existing field values require repair' USING ERRCODE='23514';END IF;
   END LOOP;
  END IF;
 END IF;
 IF public.application_native_crm_configuration_governance_allows(w,command) IS NOT TRUE THEN RAISE EXCEPTION 'access_unavailable: resulting configuration held' USING ERRCODE='42501';END IF;
 DELETE FROM public.application_native_configuration_execution WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND workspace_id=w;
 RETURN jsonb_build_object('resourceId',item_id,'subjectKind',subject,'created',created,'changed',before IS DISTINCT FROM public.application_native_crm_configuration_fingerprint(w));
END $$;
REVOKE ALL ON FUNCTION application_run_native_crm_configuration(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION application_native_crm_configuration_proposal_allows(w uuid,command jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed boolean:=false;
BEGIN
 BEGIN PERFORM public.application_run_native_crm_configuration(w,command);RAISE EXCEPTION 'validated CRM configuration' USING ERRCODE='P0803';
 EXCEPTION WHEN SQLSTATE 'P0803' THEN allowed:=true;END;RETURN allowed;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_crm_configuration_proposal_allows(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION application_execute_native_crm_configuration(w uuid,acting uuid,command jsonb,expected_revision text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE revision text;review jsonb;outcome jsonb;
BEGIN
 IF acting IS NULL THEN SELECT a.id INTO acting FROM public.assistants a WHERE a.workspace_id=w AND a.kind='primary' AND public.assistant_placement_visible(nullif(current_setting('app.current_user_id',true),'')::uuid,a.id) ORDER BY a.id LIMIT 1;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('application-native-governance:'||w::text||':native',0));
 revision:=public.application_native_governance_revision(w,acting,'native');
 IF expected_revision IS NOT NULL AND expected_revision IS DISTINCT FROM revision THEN RAISE EXCEPTION 'configuration revision changed' USING ERRCODE='40001';END IF;
 review:=public.application_prepare_native_governance_review(w,acting,'native',revision,jsonb_build_object('kind','configure_crm','command',command));
 outcome:=public.application_apply_native_governance_review(w,acting,(review->>'id')::uuid);
 RETURN jsonb_build_object('record',public.application_native_crm_configuration_item(w,outcome->>'subjectKind',(outcome->>'resourceId')::uuid),
  'created',outcome->'created','changed',outcome->'changed','subjectKind',outcome->'subjectKind','reviewId',outcome->'id');
END $$;
REVOKE ALL ON FUNCTION application_execute_native_crm_configuration(uuid,uuid,jsonb,text) FROM PUBLIC;
-- Existing typed lifecycle actions retain their blocker adapter and audit.
-- A private transaction review pins their current complete authority across awaits.
CREATE TABLE application_native_module_lifecycle_reviews (
 transaction_id bigint NOT NULL,backend_pid integer NOT NULL,workspace_id uuid NOT NULL,module_key text NOT NULL,
 actor_user_id uuid NOT NULL,assistant_id uuid NOT NULL,observed_version integer NOT NULL,action text NOT NULL,
 default_state text NOT NULL,authority_revision text NOT NULL,initialized boolean NOT NULL DEFAULT false,used boolean NOT NULL DEFAULT false,
 PRIMARY KEY(transaction_id,backend_pid,workspace_id,module_key)
);
ALTER TABLE application_native_module_lifecycle_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_native_module_lifecycle_reviews FROM PUBLIC;
CREATE FUNCTION application_prepare_native_module_lifecycle(w uuid,module text,action text,expected_version integer,default_state text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid;revision text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=module) THEN RETURN;END IF;
 IF action NOT IN('enable','request_disable','finish_disable') OR expected_version<0 OR default_state NOT IN('enabled','disabled','draining') THEN RAISE EXCEPTION 'invalid lifecycle review' USING ERRCODE='22023';END IF;
 IF acting IS NULL THEN SELECT a.id INTO acting FROM public.assistants a WHERE a.workspace_id=w AND a.kind='primary' AND public.assistant_placement_visible(actor,a.id) ORDER BY a.id LIMIT 1;END IF;
 revision:=public.application_native_governance_revision(w,acting,module);
 INSERT INTO public.application_native_module_lifecycle_reviews(transaction_id,backend_pid,workspace_id,module_key,actor_user_id,assistant_id,observed_version,action,default_state,authority_revision)
  VALUES(txid_current(),pg_backend_pid(),w,module,actor,acting,expected_version,action,default_state,revision);
END $$;
REVOKE ALL ON FUNCTION application_prepare_native_module_lifecycle(uuid,text,text,integer,text) FROM PUBLIC;
CREATE FUNCTION application_guard_native_module_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
 module text:=CASE WHEN TG_OP='DELETE' THEN OLD.module_key ELSE NEW.module_key END;review public.application_native_module_lifecycle_reviews;revision text;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.module_key<>OLD.module_key) THEN RAISE EXCEPTION 'immutable module identity' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=w) OR NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=w AND o.module_key=module) THEN
  IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
 END IF;
 SELECT * INTO review FROM public.application_native_module_lifecycle_reviews r WHERE r.transaction_id=txid_current() AND r.backend_pid=pg_backend_pid()
  AND r.workspace_id=w AND r.module_key=module AND r.actor_user_id=nullif(current_setting('app.current_user_id',true),'')::uuid;
 IF NOT FOUND OR review.used OR TG_OP='DELETE' THEN RAISE EXCEPTION 'access_unavailable: typed current module lifecycle required' USING ERRCODE='42501';END IF;
 revision:=public.application_native_governance_revision(w,review.assistant_id,module);
 IF revision IS DISTINCT FROM review.authority_revision THEN RAISE EXCEPTION 'module governance changed' USING ERRCODE='40001';END IF;
 IF TG_OP='INSERT' THEN
  IF review.observed_version<>0 OR review.initialized OR NEW.version<>1 OR NEW.state<>review.default_state THEN RAISE EXCEPTION 'module lifecycle version changed' USING ERRCODE='40001';END IF;
 ELSE
  IF OLD.version<>(CASE WHEN review.initialized AND review.observed_version=0 THEN 1 ELSE review.observed_version END)
   OR NEW.version<>OLD.version+1 OR NEW.updated_by_user_id IS DISTINCT FROM review.actor_user_id
   OR review.action='enable' AND NEW.state<>'enabled' OR review.action='finish_disable' AND NEW.state<>'disabled'
   OR review.action='request_disable' AND NEW.state NOT IN('draining','disabled') THEN RAISE EXCEPTION 'module lifecycle version changed' USING ERRCODE='40001';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_guard_native_module_lifecycle() FROM PUBLIC;
CREATE TRIGGER application_native_module_lifecycle_authority BEFORE INSERT OR UPDATE OR DELETE ON workspace_modules
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_module_lifecycle();
CREATE FUNCTION application_record_native_module_lifecycle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE review public.application_native_module_lifecycle_reviews;revision text;
BEGIN
 SELECT * INTO review FROM public.application_native_module_lifecycle_reviews r WHERE r.transaction_id=txid_current() AND r.backend_pid=pg_backend_pid() AND r.workspace_id=NEW.workspace_id AND r.module_key=NEW.module_key;
 IF NOT FOUND THEN RETURN NULL;END IF;
 revision:=public.application_native_governance_revision(NEW.workspace_id,review.assistant_id,NEW.module_key);
 UPDATE public.application_native_module_lifecycle_reviews SET authority_revision=revision,initialized=true,used=TG_OP='UPDATE'
  WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND workspace_id=NEW.workspace_id AND module_key=NEW.module_key;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_record_native_module_lifecycle() FROM PUBLIC;
CREATE TRIGGER zz_application_native_module_lifecycle_review AFTER INSERT OR UPDATE ON workspace_modules
 FOR EACH ROW EXECUTE FUNCTION application_record_native_module_lifecycle();
CREATE FUNCTION application_finish_native_module_lifecycle(w uuid,module text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE review public.application_native_module_lifecycle_reviews;
BEGIN
 SELECT * INTO review FROM public.application_native_module_lifecycle_reviews r WHERE r.transaction_id=txid_current() AND r.backend_pid=pg_backend_pid() AND r.workspace_id=w AND r.module_key=module;
 IF NOT FOUND THEN RETURN;END IF;
 IF review.actor_user_id IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid
  OR public.application_native_governance_revision(w,review.assistant_id,module) IS DISTINCT FROM review.authority_revision THEN RAISE EXCEPTION 'module governance changed' USING ERRCODE='40001';END IF;
 DELETE FROM public.application_native_module_lifecycle_reviews WHERE transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND workspace_id=w AND module_key=module;
END $$;
REVOKE ALL ON FUNCTION application_finish_native_module_lifecycle(uuid,text) FROM PUBLIC;

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON application_native_configuration_operations,application_native_configuration_execution,application_native_module_lifecycle_reviews,application_native_crm_configuration_epochs FROM app_user;
 GRANT EXECUTE ON FUNCTION application_prepare_native_module_lifecycle(uuid,text,text,integer,text),application_finish_native_module_lifecycle(uuid,text),application_execute_native_crm_configuration(uuid,uuid,jsonb,text),application_native_crm_configuration_protected(uuid) TO app_user;
END IF;END $$;
COMMIT;
