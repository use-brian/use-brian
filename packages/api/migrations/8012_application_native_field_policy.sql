-- Current native-member field masks. Global policy activation remains closed.
-- [COMP:security/native-field-policy]
BEGIN;

-- Only deployed migrations own these ports. No application role may register
-- code, claim a resource owner or write a role assignment directly.
CREATE TABLE application_native_field_contracts (
 module_key text PRIMARY KEY CHECK(module_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
 contract_version text NOT NULL CHECK(length(contract_version) BETWEEN 1 AND 128),
 role_keys text[] NOT NULL CHECK(cardinality(role_keys)<=64 AND array_position(role_keys,NULL) IS NULL),
 metadata_reader regprocedure NOT NULL
);
CREATE TABLE application_native_resource_owners (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 origin jsonb NOT NULL,
 resource_type text NOT NULL CHECK(resource_type ~ '^[a-z][a-z0-9_.-]{0,127}$'),
 module_key text NOT NULL REFERENCES application_native_field_contracts(module_key),
 PRIMARY KEY(workspace_id,origin,resource_type),
 CHECK(coalesce(jsonb_typeof(origin)='object' AND (
  origin->>'kind'='native' AND origin-ARRAY['kind','moduleKey']='{}'::jsonb AND origin->>'moduleKey'=module_key
  OR origin->>'kind'='generic' AND origin-ARRAY['kind','entityTypeId']='{}'::jsonb
   AND resource_type='record.'||(origin->>'entityTypeId')),false))
);
CREATE TABLE application_native_role_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 module_key text NOT NULL REFERENCES application_native_field_contracts(module_key),
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role_key text NOT NULL CHECK(role_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked')),
 starts_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(starts_at)),
 expires_at timestamptz CHECK(expires_at IS NULL OR isfinite(expires_at) AND expires_at>starts_at),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 issued_by_user_id uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX application_native_role_current ON application_native_role_assignments(workspace_id,module_key,user_id,status);
ALTER TABLE application_native_field_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_native_resource_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_native_role_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON application_native_field_contracts,application_native_resource_owners,application_native_role_assignments FROM PUBLIC;

CREATE FUNCTION application_native_contract_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE port pg_proc; storage_owner oid;
BEGIN
 SELECT * INTO port FROM pg_proc WHERE oid=NEW.metadata_reader;
 SELECT relowner INTO storage_owner FROM pg_class WHERE oid='public.application_native_field_contracts'::regclass;
 IF port.oid IS NULL OR port.proowner<>storage_owner OR NOT port.prosecdef OR port.prokind<>'f'
  OR port.prorettype<>'jsonb'::regtype OR port.proargtypes<>'2950 3802 25 25'::oidvector
  OR NOT coalesce(port.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp'],false)
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(port.proacl,acldefault('f',port.proowner))) a
   WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='app_user' AND has_function_privilege(r.oid,port.oid,'EXECUTE'))
  OR (SELECT count(*)<>count(DISTINCT role) FROM unnest(NEW.role_keys) role)
  OR EXISTS(SELECT 1 FROM unnest(NEW.role_keys) role WHERE role !~ '^[a-z][a-z0-9_.-]{0,127}$') THEN
  RAISE EXCEPTION 'invalid_native_field_contract' USING ERRCODE='22023';
 END IF;
 IF TG_OP='UPDATE' AND NEW.module_key<>OLD.module_key THEN
  RAISE EXCEPTION 'immutable_native_field_owner' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_native_contract_guard() FROM PUBLIC;
CREATE TRIGGER application_native_contract_guard BEFORE INSERT OR UPDATE ON application_native_field_contracts
 FOR EACH ROW EXECUTE FUNCTION application_native_contract_guard();

CREATE FUNCTION application_native_owner_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.origin<>OLD.origin
  OR NEW.resource_type<>OLD.resource_type OR NEW.module_key<>OLD.module_key) THEN
  RAISE EXCEPTION 'immutable_native_field_owner' USING ERRCODE='22023';
 END IF;
 IF NEW.origin->>'kind'='generic' AND NOT EXISTS(SELECT 1 FROM entity_types t
  WHERE t.workspace_id=NEW.workspace_id AND t.id=(NEW.origin->>'entityTypeId')::uuid) THEN
  RAISE EXCEPTION 'invalid_native_field_owner' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_native_owner_guard() FROM PUBLIC;
CREATE TRIGGER application_native_owner_guard BEFORE INSERT OR UPDATE ON application_native_resource_owners
 FOR EACH ROW EXECUTE FUNCTION application_native_owner_guard();

CREATE FUNCTION application_native_role_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM application_native_field_contracts c WHERE c.module_key=NEW.module_key AND NEW.role_key=ANY(c.role_keys)) THEN
  RAISE EXCEPTION 'invalid_native_role_assignment' USING ERRCODE='22023';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.module_key<>OLD.module_key OR NEW.user_id<>OLD.user_id
   OR NEW.role_key<>OLD.role_key OR NEW.issued_by_user_id<>OLD.issued_by_user_id OR NEW.created_at<>OLD.created_at
   OR OLD.status='revoked' AND NEW.status<>'revoked' THEN
   RAISE EXCEPTION 'immutable_native_role_assignment' USING ERRCODE='22023';
  END IF;
  NEW.version:=OLD.version+1;NEW.updated_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_native_role_guard() FROM PUBLIC;
CREATE TRIGGER application_native_role_guard BEFORE INSERT OR UPDATE ON application_native_role_assignments
 FOR EACH ROW EXECUTE FUNCTION application_native_role_guard();

-- A single rule is a bounded conjunction of role alternatives. Validate the
-- entire declared vocabulary, including fields this request does not select.
CREATE FUNCTION application_native_field_rule_valid(rule jsonb,roles text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE clause jsonb; normalized jsonb[]:='{}'; identity jsonb;
BEGIN
 IF jsonb_typeof(rule) IS DISTINCT FROM 'array' OR jsonb_array_length(rule)>8 THEN RETURN false; END IF;
 FOR clause IN SELECT value FROM jsonb_array_elements(rule) LOOP
  IF jsonb_typeof(clause) IS DISTINCT FROM 'array' OR jsonb_array_length(clause)>64 THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(clause) item WHERE jsonb_typeof(item)<>'string' OR NOT (item#>>'{}')=ANY(roles))
   OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(clause)) THEN RETURN false; END IF;
  SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO identity FROM jsonb_array_elements(clause);
  IF identity=ANY(normalized) THEN RETURN false; END IF;
  normalized:=array_append(normalized,identity);
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION application_native_field_rule_valid(jsonb,text[]) FROM PUBLIC;
CREATE FUNCTION application_native_field_rule_allows(rule jsonb,roles text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rule) clause WHERE NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements_text(clause) role WHERE role=ANY(roles)))
$$;
REVOKE ALL ON FUNCTION application_native_field_rule_allows(jsonb,text[]) FROM PUBLIC;

CREATE FUNCTION read_native_application_field_mask(w uuid,p_origin jsonb,p_type text,p_id text,p_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 acting uuid:=nullif(current_setting('app.v2_assistant_id',true),'')::uuid; canonical_type text:=p_type;
 contract application_native_field_contracts; namespace text; procedure_name text; metadata jsonb; source jsonb;
 field jsonb; profile jsonb; roles text[]; keys text[]; readable text[]:='{}'; writable text[]:='{}'; can_write boolean;
BEGIN
 IF actor IS NULL OR p_id IS NULL OR p_version IS NULL OR length(p_id) NOT BETWEEN 1 AND 256 OR length(p_version) NOT BETWEEN 1 AND 256
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.application_native_field_contracts'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)::uuid<>w
  OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)::uuid<>actor
  OR acting IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM assistants a WHERE a.workspace_id=w AND a.id=acting)
   OR assistant_placement_visible(actor,acting) IS NOT TRUE) THEN RETURN NULL; END IF;
 IF p_origin->>'kind'='generic' THEN canonical_type:='record.'||((p_origin->>'entityTypeId')::uuid)::text; END IF;
 SELECT c.* INTO contract FROM application_native_resource_owners o JOIN application_native_field_contracts c USING(module_key)
  WHERE o.workspace_id=w AND o.origin=p_origin AND o.resource_type=canonical_type;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT n.nspname,p.proname INTO namespace,procedure_name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=contract.metadata_reader;
 IF namespace IS NULL THEN RETURN NULL; END IF;
 EXECUTE format('SELECT %I.%I($1,$2,$3,$4)',namespace,procedure_name) INTO metadata USING w,p_origin,canonical_type,p_id;
 -- Closed metadata shape: a deployed port never returns a business payload.
 IF jsonb_typeof(metadata) IS DISTINCT FROM 'object'
  OR NOT metadata ?& ARRAY['moduleKey','origin','typeKey','schemaVersion','policyVersion','recordVersion','fieldKeys','fields','source']
  OR metadata-ARRAY['moduleKey','origin','typeKey','schemaVersion','policyVersion','recordVersion','fieldKeys','fields','source']<>'{}'::jsonb
  OR metadata->>'moduleKey' IS DISTINCT FROM contract.module_key OR metadata->'origin' IS DISTINCT FROM p_origin
  OR metadata->>'typeKey' IS DISTINCT FROM canonical_type OR metadata->>'recordVersion' IS DISTINCT FROM p_version
  OR jsonb_typeof(metadata->'schemaVersion') IS DISTINCT FROM 'string' OR jsonb_typeof(metadata->'policyVersion') IS DISTINCT FROM 'string'
  OR length(metadata->>'schemaVersion') NOT BETWEEN 1 AND 128 OR length(metadata->>'policyVersion') NOT BETWEEN 1 AND 128
  OR jsonb_typeof(metadata->'fieldKeys') IS DISTINCT FROM 'array' OR jsonb_typeof(metadata->'fields') IS DISTINCT FROM 'array'
  OR jsonb_array_length(metadata->'fieldKeys')>128 OR jsonb_array_length(metadata->'fields')<>jsonb_array_length(metadata->'fieldKeys')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(metadata->'fieldKeys') item WHERE jsonb_typeof(item)<>'string' OR length(item#>>'{}') NOT BETWEEN 1 AND 128
   OR item#>>'{}'=ANY(ARRAY['__proto__','prototype','constructor'])) THEN RETURN NULL; END IF;
 keys:=ARRAY(SELECT jsonb_array_elements_text(metadata->'fieldKeys'));
 IF cardinality(keys)<>(SELECT count(DISTINCT field_key) FROM unnest(keys) field_key)
  OR cardinality(keys)<>(SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(metadata->'fields')) THEN RETURN NULL; END IF;
 source:=metadata->'source';
 IF jsonb_typeof(source) IS DISTINCT FROM 'object' OR source->>'workspaceId' IS DISTINCT FROM w::text
  OR source->>'held' IS DISTINCT FROM 'false' OR source->>'validTo' IS NOT NULL OR source->>'retractedAt' IS NOT NULL
  OR source->>'version' IS DISTINCT FROM p_version OR entity_derivation_envelope_valid(source) IS NOT TRUE
  OR agent_visibility_allows(w,(source->>'userId')::uuid,(source->>'assistantId')::uuid) IS NOT TRUE
  OR workflow_evidence_envelope_visible(w,source) IS NOT TRUE THEN RETURN NULL; END IF;
 SELECT coalesce(array_agg(DISTINCT a.role_key),'{}') INTO roles FROM application_native_role_assignments a
  WHERE a.workspace_id=w AND a.module_key=contract.module_key AND a.user_id=actor AND a.status='active'
   AND a.starts_at<=statement_timestamp() AND (a.expires_at IS NULL OR a.expires_at>statement_timestamp())
   AND a.role_key=ANY(contract.role_keys);
 can_write:=member_operation_row_allows(member_principal_operation_grants(actor,true,w),w,source->>'sensitivity',
  ARRAY(SELECT jsonb_array_elements_text(source->'compartments')))
  AND agent_mutation_scope_allows(ARRAY(SELECT jsonb_array_elements_text(source->'compartments')));
 FOR field IN SELECT value FROM jsonb_array_elements(metadata->'fields') LOOP
  IF jsonb_typeof(field) IS DISTINCT FROM 'object' OR NOT field ?& ARRAY['key','read','write','releaseReadTo','releaseWriteTo']
   OR field-ARRAY['key','read','write','releaseReadTo','releaseWriteTo']<>'{}'::jsonb OR jsonb_typeof(field->'key') IS DISTINCT FROM 'string'
   OR NOT coalesce(field->>'key'=ANY(keys),false)
   OR application_native_field_rule_valid(field->'read',contract.role_keys) IS NOT TRUE
   OR application_native_field_rule_valid(field->'write',contract.role_keys) IS NOT TRUE THEN RETURN NULL; END IF;
  FOR profile IN SELECT value FROM jsonb_array_elements(jsonb_build_array(field->'releaseReadTo',field->'releaseWriteTo')) LOOP
   IF jsonb_typeof(profile) IS DISTINCT FROM 'array' OR jsonb_array_length(profile)>2
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(profile) item WHERE item NOT IN('"external_user"'::jsonb,'"service"'::jsonb))
    OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(profile)) THEN RETURN NULL; END IF;
  END LOOP;
  IF application_native_field_rule_allows(field->'read',roles) THEN readable:=readable||(field->>'key'); END IF;
  IF can_write AND application_native_field_rule_allows(field->'write',roles) THEN writable:=writable||(field->>'key'); END IF;
 END LOOP;
 RETURN jsonb_build_object('moduleKey',contract.module_key,'schemaVersion',metadata->'schemaVersion','recordVersion',p_version,
  'policyVersion',application_field_digest(jsonb_build_object('contract',contract.contract_version,'roles',contract.role_keys,
    'schema',metadata->'schemaVersion','policy',metadata->'policyVersion','fields',metadata->'fields')),
  'readFields',ARRAY(SELECT unnest(readable) ORDER BY 1),'writeFields',ARRAY(SELECT unnest(writable) ORDER BY 1));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range OR datetime_field_overflow
 OR undefined_function OR undefined_table OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION read_native_application_field_mask(uuid,jsonb,text,text,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON application_native_field_contracts,application_native_resource_owners,application_native_role_assignments FROM app_user;
  GRANT EXECUTE ON FUNCTION read_native_application_field_mask(uuid,jsonb,text,text,text) TO app_user;
 END IF;
END $$;
COMMIT;
