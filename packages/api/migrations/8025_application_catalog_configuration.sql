BEGIN;
-- [COMP:security/native-field-policy] [COMP:api/application-records]
-- Current configuration is a restriction at every canonical policy use, even
-- when an old native adapter has no invocation factory around its SQL call.
CREATE FUNCTION application_native_configuration_verified(w uuid,module text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE contract public.application_native_field_contracts; namespace text; procedure_name text; revision text;
BEGIN
 SELECT * INTO contract FROM public.application_native_field_contracts c WHERE c.module_key=module;
 IF NOT FOUND OR contract.configuration_required AND contract.configuration_reader IS NULL THEN RETURN false; END IF;
 IF contract.configuration_reader IS NULL THEN RETURN true; END IF;
 IF public.application_native_configuration_port_valid(contract.configuration_reader) IS NOT TRUE THEN RETURN false; END IF;
 SELECT n.nspname,p.proname INTO namespace,procedure_name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE p.oid=contract.configuration_reader;
 EXECUTE format('SELECT %I.%I($1)',namespace,procedure_name) INTO revision USING w;
 RETURN coalesce(length(revision) BETWEEN 1 AND 256 AND revision ~ '^[A-Za-z0-9_.:-]+$',false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_configuration_verified(uuid,text) FROM PUBLIC;

-- Keep the existing field dictionary, ownership, schema, scope and reader
-- checks intact. Insert the restriction before either private metadata read.
DO $migration$ DECLARE signature text; definition text; original text; replacement text; BEGIN
 FOREACH signature IN ARRAY ARRAY['public.application_native_field_contract_before_catalog(uuid,jsonb,text,text)',
  'public.application_native_field_catalog_for(uuid,jsonb,text)'] LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
  original:=$before$IF NOT FOUND THEN RETURN '{"registered":false}'::jsonb; END IF;$before$;
  replacement:=original||$after$
 IF public.application_native_configuration_verified(w,contract.module_key) IS NOT TRUE THEN
  RETURN '{"registered":true,"held":true}'::jsonb; END IF;$after$;
  IF position(original IN definition)=0 THEN RAISE EXCEPTION 'Canonical native configuration branch changed'; END IF;
  EXECUTE replace(definition,original,replacement);
 END LOOP;
END $migration$;

-- Public to the actual non-owner role, but metadata-only and current-reader
-- scoped. It neither selects business records nor grants a mutation/receipt.
CREATE FUNCTION read_generic_application_catalog_state(w uuid,type_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE schema public.entity_types; origin jsonb:=jsonb_build_object('kind','generic','entityTypeId',type_id);
 policy jsonb; mask jsonb; entry jsonb; fields text[]:='{}'; canonical_type text:='record.'||type_id;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid='public.entity_types'::regclass
  WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL; END IF;
 SELECT * INTO schema FROM public.entity_types t WHERE t.workspace_id=w AND t.id=type_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  IF public.application_current_maxima()->>'workspaceId' IS DISTINCT FROM w::text THEN RETURN NULL; END IF;
  FOR entry IN SELECT resource FROM public.application_generic_catalog(NULL) resource WHERE resource->'origin'=origin LOOP
   fields:=fields||ARRAY(SELECT value->>'key' FROM jsonb_array_elements(entry->'fields'));
  END LOOP;
  IF cardinality(fields)=0 THEN RETURN NULL; END IF;
 ELSE
  IF public.application_native_query_bounds(w) IS NULL THEN RETURN NULL; END IF;
  policy:=public.application_native_field_catalog_for(w,origin,canonical_type);
  IF policy->>'registered'='false' THEN
   fields:=ARRAY(SELECT p->>'name' FROM jsonb_array_elements(schema.properties) p);
  ELSE
   IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL; END IF;
   mask:=public.read_native_application_field_catalog(w,origin,canonical_type);
   IF mask IS NULL THEN RETURN NULL; END IF;
   fields:=ARRAY(SELECT jsonb_array_elements_text(mask->'readFields') UNION SELECT jsonb_array_elements_text(mask->'writeFields'));
  END IF;
 END IF;
 RETURN jsonb_build_object('schemaVersion',schema.schema_version::text,'fields',ARRAY(SELECT DISTINCT field FROM unnest(fields) field ORDER BY field));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION read_generic_application_catalog_state(uuid,uuid) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_generic_application_catalog_state(uuid,uuid) TO app_user;
 END IF;
END $$;
COMMIT;
