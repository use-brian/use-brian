BEGIN;
-- [COMP:api/application-records] One fixed builtin revision dictionary for point/query evidence.
CREATE FUNCTION application_native_builtin_field_revision(p_type text,p_field text) RETURNS int
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN p_type='deal' AND p_field='amount' THEN 2
  WHEN p_type='company' AND p_field='domain' OR p_type='person' AND p_field='email' THEN 2 ELSE 1 END;
$$;
REVOKE ALL ON FUNCTION application_native_builtin_field_revision(text,text) FROM PUBLIC;
DO $migration$
DECLARE definition text; before text; signature text;
BEGIN
 SELECT pg_get_functiondef('public.application_native_entity_values(text,jsonb)'::regprocedure) INTO definition;
 before:=$source$'domain',attrs->'domain'$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native domain codec changed; review canonical fallback';END IF;
 definition:=replace(definition,before,$source$'domain',coalesce(attrs->>'domain',payload->>'canonical_id')$source$);
 before:=$source$'email',attrs->'email'$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native email codec changed; review canonical fallback';END IF;
 EXECUTE replace(definition,before,$source$'email',coalesce(attrs->>'email',payload->>'canonical_id')$source$);
 FOR signature IN SELECT unnest(ARRAY['public.application_field_projection_state_before_module_policy(uuid,jsonb,text,uuid,text,text,text[])',
  'public.application_native_query_field_metadata(uuid,text,text[])']) LOOP
  SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
  before:=$source$CASE WHEN p_type='deal' AND field='amount' THEN 2 ELSE 1 END$source$;
  IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native builtin identity changed; review shared revision dictionary';END IF;
  EXECUTE replace(definition,before,'public.application_native_builtin_field_revision(p_type,field)');
 END LOOP;
END $migration$;
-- Query cursors bind actual compiled codecs, not only unchanged field shapes.
DO $migration$
DECLARE definition text; before text;
BEGIN
 SELECT pg_get_functiondef('public.application_native_query_catalog(uuid,text)'::regprocedure) INTO definition;
 before:=$source$RETURN jsonb_build_object('typeKey',p_type,'fields',context->'read','customFields',custom_fields);$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native query catalog changed; review cursor codec identity';END IF;
 EXECUTE replace(definition,before,$source$IF application_native_query_field_metadata(w,p_type,ARRAY(SELECT jsonb_array_elements_text(context->'read'))) IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('typeKey',p_type,'fields',context->'read','customFields',custom_fields,
  'schemaVersion',application_field_digest(jsonb_build_object('kind','native-query-schema-v2','policySchema',context#>'{policy,metadata,schemaVersion}',
   'fields',application_native_query_field_metadata(w,p_type,ARRAY(SELECT jsonb_array_elements_text(context->'read'))))));$source$);
END $migration$;
COMMIT;
