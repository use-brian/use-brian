-- [COMP:crm/r2-store] Add the closed summary policy input contract before activation.
BEGIN;

-- Preserve the old provider registration and reader during the additive stage.
-- An adapter explicitly names that registration and its real input revisions.
CREATE TABLE public.crm_summary_policy_adapters (
  workspace_id uuid NOT NULL,
  origin jsonb NOT NULL DEFAULT '{"kind":"native","moduleKey":"native"}'::jsonb,
  resource_type text NOT NULL CHECK (resource_type IN('person','company','deal')),
  provider_module text NOT NULL CHECK (provider_module='native'),
  provider_contract_version text NOT NULL CHECK (length(provider_contract_version) BETWEEN 1 AND 128),
  provider_metadata_hash text NOT NULL CHECK (provider_metadata_hash ~ '^[a-f0-9]{64}$'),
  provider_catalog_hash text NOT NULL CHECK (provider_catalog_hash ~ '^[a-f0-9]{64}$'),
  ir_version integer NOT NULL CHECK (ir_version=1),
  catalog jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY(workspace_id,resource_type),
  FOREIGN KEY(workspace_id,origin,resource_type) REFERENCES public.application_native_resource_owners(workspace_id,origin,resource_type) ON DELETE CASCADE,
  CHECK (origin='{"kind":"native","moduleKey":"native"}'::jsonb)
);

-- Facts have no actor. All writes to the typed inputs are owned database
-- mutations; a reader cannot supply a dependency value or an allow decision.
CREATE TABLE public.crm_summary_policy_inputs (
  workspace_id uuid NOT NULL,
  resource_type text NOT NULL,
  input_key text NOT NULL CHECK (length(input_key) BETWEEN 1 AND 128),
  value boolean NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY(workspace_id,resource_type,input_key),
  FOREIGN KEY(workspace_id,resource_type) REFERENCES public.crm_summary_policy_adapters(workspace_id,resource_type) ON DELETE CASCADE
);

-- One instance per immutable typed interpretation of an input. Each interval
-- is half-open; both start and end are observable with no database mutation.
CREATE TABLE public.crm_summary_policy_requirements (
  workspace_id uuid NOT NULL,
  resource_type text NOT NULL,
  policy_key text NOT NULL CHECK (length(policy_key) BETWEEN 1 AND 128),
  read_rules jsonb NOT NULL,
  input_key text,
  expected_value boolean,
  valid_during tstzrange NOT NULL CHECK (NOT isempty(valid_during) AND (lower_inf(valid_during) OR lower_inc(valid_during)) AND NOT upper_inc(valid_during)),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY(workspace_id,resource_type,policy_key),
  FOREIGN KEY(workspace_id,resource_type) REFERENCES public.crm_summary_policy_adapters(workspace_id,resource_type) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,resource_type,input_key) REFERENCES public.crm_summary_policy_inputs(workspace_id,resource_type,input_key),
  CHECK ((input_key IS NULL)=(expected_value IS NULL))
);

CREATE TABLE public.crm_summary_record_policies (
  workspace_id uuid NOT NULL,
  resource_type text NOT NULL,
  record_id uuid NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  policy_key text NOT NULL,
  PRIMARY KEY(workspace_id,resource_type,record_id,policy_key),
  FOREIGN KEY(workspace_id,resource_type,policy_key) REFERENCES public.crm_summary_policy_requirements(workspace_id,resource_type,policy_key) ON DELETE CASCADE
);
CREATE INDEX crm_summary_record_policies_by_requirement ON public.crm_summary_record_policies(workspace_id,resource_type,policy_key,record_id);

ALTER TABLE public.crm_summary_policy_adapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_summary_policy_inputs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_summary_policy_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_summary_record_policies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_summary_policy_adapters,public.crm_summary_policy_inputs,public.crm_summary_policy_requirements,
  public.crm_summary_record_policies FROM PUBLIC,app_user;

-- Portable identity of the legacy definition to which this adapter belongs;
-- no cached callback result enters summary authorization.
CREATE FUNCTION public.crm_summary_provider_definition(reader regprocedure) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT encode(sha256(convert_to(pg_get_functiondef(reader),'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION public.crm_summary_provider_definition(regprocedure) FROM PUBLIC,app_user;

CREATE FUNCTION public.crm_summary_guard_adapter() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE contract public.application_native_field_contracts;
BEGIN
  SELECT c.* INTO contract FROM public.application_native_resource_owners o
    JOIN public.application_native_field_contracts c ON c.module_key=o.module_key
    WHERE o.workspace_id=NEW.workspace_id AND o.origin=NEW.origin AND o.resource_type=NEW.resource_type;
  IF NOT FOUND OR NEW.provider_module IS DISTINCT FROM contract.module_key
    OR NEW.provider_contract_version IS DISTINCT FROM contract.contract_version
    OR public.application_native_record_port_valid(contract.metadata_reader) IS NOT TRUE
    OR public.application_native_catalog_port_valid(contract.catalog_reader) IS NOT TRUE
    OR NEW.provider_metadata_hash IS DISTINCT FROM public.crm_summary_provider_definition(contract.metadata_reader)
    OR NEW.provider_catalog_hash IS DISTINCT FROM public.crm_summary_provider_definition(contract.catalog_reader)
    OR jsonb_typeof(NEW.catalog) IS DISTINCT FROM 'object'
    OR NEW.catalog-ARRAY['schemaVersion','policyVersion','fieldKeys','fields','scope']<>'{}'::jsonb
    OR NOT NEW.catalog ?& ARRAY['schemaVersion','policyVersion','fieldKeys','fields','scope']
    OR length(NEW.catalog->>'schemaVersion') NOT BETWEEN 1 AND 128
    OR length(NEW.catalog->>'policyVersion') NOT BETWEEN 1 AND 128
    OR public.application_native_field_dictionary_valid(NEW.catalog->'fieldKeys',NEW.catalog->'fields',contract.role_keys) IS NOT TRUE
    OR public.entity_derivation_envelope_valid(NEW.catalog->'scope') IS NOT TRUE
    OR NEW.catalog#>>'{scope,workspaceId}' IS DISTINCT FROM NEW.workspace_id::text THEN
    RAISE EXCEPTION 'crm_summary_invalid_policy_adapter' USING ERRCODE='22023';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.workspace_id,NEW.origin,NEW.resource_type,NEW.provider_module) IS DISTINCT FROM
      (OLD.workspace_id,OLD.origin,OLD.resource_type,OLD.provider_module) THEN RAISE EXCEPTION 'immutable summary policy adapter'; END IF;
  END IF;
  NEW.revision:=nextval('public.application_policy_revision_seq');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_guard_adapter() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_guard_adapter BEFORE INSERT OR UPDATE ON public.crm_summary_policy_adapters
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_guard_adapter();

CREATE FUNCTION public.crm_summary_guard_policy_input() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.workspace_id,NEW.resource_type,NEW.input_key) IS DISTINCT FROM (OLD.workspace_id,OLD.resource_type,OLD.input_key) THEN
      RAISE EXCEPTION 'immutable summary policy input';
    END IF;
  END IF;
  NEW.revision:=nextval('public.application_policy_revision_seq');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_guard_policy_input() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_guard_policy_input BEFORE INSERT OR UPDATE ON public.crm_summary_policy_inputs
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_guard_policy_input();

CREATE FUNCTION public.crm_summary_guard_policy_requirement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE allowed_roles text[]; catalog_fields jsonb;
BEGIN
  SELECT c.role_keys,a.catalog->'fieldKeys' INTO allowed_roles,catalog_fields
    FROM public.crm_summary_policy_adapters a JOIN public.application_native_field_contracts c ON c.module_key=a.provider_module
    WHERE a.workspace_id=NEW.workspace_id AND a.resource_type=NEW.resource_type;
  IF NOT FOUND OR jsonb_typeof(NEW.read_rules) IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(NEW.read_rules))>128
    OR EXISTS(SELECT 1 FROM jsonb_each(NEW.read_rules) field WHERE NOT catalog_fields ? field.key
      OR public.application_native_field_rule_valid(field.value,allowed_roles) IS NOT TRUE) THEN
    RAISE EXCEPTION 'crm_summary_invalid_policy_requirement' USING ERRCODE='22023';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.workspace_id,NEW.resource_type,NEW.policy_key) IS DISTINCT FROM (OLD.workspace_id,OLD.resource_type,OLD.policy_key) THEN
      RAISE EXCEPTION 'immutable summary policy requirement';
    END IF;
  END IF;
  NEW.revision:=nextval('public.application_policy_revision_seq');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_guard_policy_requirement() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_guard_policy_requirement BEFORE INSERT OR UPDATE ON public.crm_summary_policy_requirements
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_guard_policy_requirement();

CREATE FUNCTION public.crm_summary_guard_record_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.entities e WHERE e.id=NEW.record_id
    AND e.workspace_id=NEW.workspace_id AND e.kind=NEW.resource_type) THEN
    RAISE EXCEPTION 'crm_summary_record_policy_mismatch' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_guard_record_policy() FROM PUBLIC,app_user;
CREATE TRIGGER crm_summary_guard_record_policy BEFORE INSERT OR UPDATE ON public.crm_summary_record_policies
  FOR EACH ROW EXECUTE FUNCTION public.crm_summary_guard_record_policy();

CREATE FUNCTION public.crm_summary_unadapted_providers()
RETURNS TABLE(workspace_id uuid, provider_module text, resource_type text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT o.workspace_id, o.module_key, o.resource_type,
    CASE WHEN a.workspace_id IS NULL THEN 'adapter_missing' ELSE 'adapter_predecessor_changed' END
  FROM public.application_native_resource_owners o
  JOIN public.application_native_field_contracts c ON c.module_key=o.module_key
  LEFT JOIN public.crm_summary_policy_adapters a ON a.workspace_id=o.workspace_id AND a.resource_type=o.resource_type
  WHERE o.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND o.resource_type IN('person','company','deal')
    AND (a.workspace_id IS NULL OR (a.provider_module,a.provider_contract_version,a.provider_metadata_hash,a.provider_catalog_hash)
      IS DISTINCT FROM (c.module_key,c.contract_version,public.crm_summary_provider_definition(c.metadata_reader),public.crm_summary_provider_definition(c.catalog_reader))
      OR public.application_native_record_port_valid(c.metadata_reader) IS NOT TRUE
      OR public.application_native_catalog_port_valid(c.catalog_reader) IS NOT TRUE)
  ORDER BY o.workspace_id,o.module_key,o.resource_type
$$;
REVOKE ALL ON FUNCTION public.crm_summary_unadapted_providers() FROM PUBLIC,app_user;

-- The later activation migration calls this within its transaction after
-- locking the registry. Additive installation never retires the old reader.
CREATE FUNCTION public.crm_summary_require_adapted_providers() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE missing record;
BEGIN
  SELECT * INTO missing FROM public.crm_summary_unadapted_providers() LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'crm_summary_provider_adapter_required' USING ERRCODE='55000',
    DETAIL=format('Workspace %s, module %s, type %s: %s',missing.workspace_id,missing.provider_module,missing.resource_type,missing.reason),
    HINT='Install and verify the provider''s versioned CRM summary adapter before activating the new summary reader.';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_require_adapted_providers() FROM PUBLIC,app_user;
-- Resolve policies by exact requirement/version rather than by candidate row.
-- All inputs are facts acquired from the active owner; caller record IDs do
-- not grant access. This private function never releases business values.
CREATE FUNCTION public.crm_summary_admitted_policy_facts(
  w uuid, actor uuid, resource_type_key text, record_ids uuid[], required_fields text[], boundary_time timestamptz
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  WITH adapter AS MATERIALIZED (
    SELECT a.* FROM public.crm_summary_policy_adapters a WHERE a.workspace_id=w AND a.resource_type=resource_type_key
  ), roles AS MATERIALIZED (
    SELECT r.role_key,r.starts_at,r.expires_at FROM public.application_native_role_assignments r JOIN adapter a ON a.provider_module=r.module_key
      WHERE r.workspace_id=w AND r.user_id=actor AND r.status='active'
  ), active_roles AS MATERIALIZED (
    SELECT coalesce(array_agg(DISTINCT role_key),'{}') AS role_keys FROM roles
    WHERE starts_at<=boundary_time AND (expires_at IS NULL OR expires_at>boundary_time)
  ), requirements AS MATERIALIZED (
    SELECT DISTINCT p.policy_key,p.revision,p.read_rules,p.input_key,p.expected_value,p.valid_during,
      i.revision AS input_revision,i.value AS input_value,
      p.valid_during @> boundary_time AND (p.input_key IS NULL OR i.value=p.expected_value) AS applies
    FROM public.crm_summary_record_policies link
    JOIN public.crm_summary_policy_requirements p USING(workspace_id,resource_type,policy_key)
    LEFT JOIN public.crm_summary_policy_inputs i USING(workspace_id,resource_type,input_key)
    WHERE link.workspace_id=w AND link.resource_type=resource_type_key AND link.record_id=ANY(record_ids)
  ), evaluated AS MATERIALIZED (
    SELECT p.*,NOT EXISTS(SELECT 1 FROM jsonb_each(p.read_rules) rule
      WHERE rule.key=ANY(required_fields) AND public.application_native_field_rule_allows(rule.value,r.role_keys) IS NOT TRUE) AS allowed
    FROM requirements p CROSS JOIN active_roles r
  ), transitions AS MATERIALIZED (
    SELECT starts_at AS moment FROM roles WHERE starts_at>boundary_time
    UNION ALL SELECT expires_at FROM roles WHERE expires_at>boundary_time
    UNION ALL SELECT lower(valid_during) FROM requirements WHERE lower(valid_during)>boundary_time
    UNION ALL SELECT upper(valid_during) FROM requirements WHERE upper(valid_during)>boundary_time
  )
  SELECT jsonb_build_object('available',
     required_fields<@ARRAY(SELECT jsonb_array_elements_text(a.catalog->'fieldKeys'))
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.catalog->'fields') field
       WHERE field->>'key'=ANY(required_fields) AND public.application_native_field_rule_allows(field->'read',r.role_keys) IS NOT TRUE)
     AND NOT EXISTS(SELECT 1 FROM evaluated p WHERE p.applies AND NOT p.allowed),
    'adapterRevision',a.revision,
    'dependencies',(SELECT coalesce(jsonb_agg(jsonb_build_array(policy_key,revision,input_key,input_revision) ORDER BY policy_key),'[]') FROM requirements),
    'nextChange',(SELECT min(moment) FROM transitions))
  FROM adapter a CROSS JOIN active_roles r
$$;
REVOKE ALL ON FUNCTION public.crm_summary_admitted_policy_facts(uuid,uuid,text,uuid[],text[],timestamptz) FROM PUBLIC,app_user;
COMMIT;
