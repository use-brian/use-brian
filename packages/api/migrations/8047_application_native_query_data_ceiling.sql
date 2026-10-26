BEGIN;
-- [COMP:api/application-records] Data ceilings are deny-only restrictions over
-- current canonical authority. They never substitute a former actor or grant.
ALTER FUNCTION application_native_query_context(uuid,text) RENAME TO application_native_query_context_before_data_ceiling;
REVOKE ALL ON FUNCTION application_native_query_context_before_data_ceiling(uuid,text) FROM PUBLIC;
CREATE FUNCTION application_native_query_context(w uuid,p_type text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;ceilings jsonb;ceiling jsonb;scope_cap jsonb;v2 jsonb;key text;clause jsonb;clauses jsonb;selector jsonb;scope jsonb;visibility jsonb;
BEGIN
 context:=application_native_query_context_before_data_ceiling(w,p_type);IF context IS NULL THEN RETURN NULL;END IF;
 ceilings:=coalesce(nullif(current_setting('app.native_query_data_ceilings',true),'')::jsonb,'[]'::jsonb);
 IF jsonb_typeof(ceilings) IS DISTINCT FROM 'array' OR jsonb_array_length(ceilings)>16 THEN RETURN NULL;END IF;
 FOR ceiling IN SELECT value FROM jsonb_array_elements(ceilings) LOOP
  IF jsonb_typeof(ceiling) IS DISTINCT FROM 'object' OR ceiling-ARRAY['workspaceId','typeKey','ids','tier','compartments','projectIds','departmentRead','privateUserId','assistants']<>'{}'
   OR NOT ceiling ?& ARRAY['workspaceId','typeKey','ids','tier','compartments','projectIds','departmentRead','privateUserId','assistants']
   OR jsonb_typeof(ceiling->'workspaceId') IS DISTINCT FROM 'string' OR jsonb_typeof(ceiling->'typeKey') IS DISTINCT FROM 'string' OR ceiling->>'typeKey' NOT IN('company','person','deal')
   OR jsonb_typeof(ceiling->'ids') NOT IN('array','null') OR ceiling->'tier' NOT IN('0'::jsonb,'1'::jsonb,'2'::jsonb,'3'::jsonb)
   OR jsonb_typeof(ceiling->'privateUserId') NOT IN('string','null') OR jsonb_typeof(ceiling->'assistants') NOT IN('array','null') THEN RETURN NULL;END IF;
  PERFORM (ceiling->>'workspaceId')::uuid;
  IF ceiling->>'privateUserId' IS NOT NULL THEN PERFORM (ceiling->>'privateUserId')::uuid;END IF;
  IF ceiling->'ids'<>'null' THEN
   IF jsonb_array_length(ceiling->'ids')>100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(ceiling->'ids') item WHERE jsonb_typeof(item)<>'string') THEN RETURN NULL;END IF;
   PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(ceiling->'ids');
  END IF;
  IF ceiling->'assistants'<>'null' THEN
   IF jsonb_array_length(ceiling->'assistants')>256 OR EXISTS(SELECT 1 FROM jsonb_array_elements(ceiling->'assistants') item WHERE jsonb_typeof(item)<>'string') THEN RETURN NULL;END IF;
   PERFORM (value#>>'{}')::uuid FROM jsonb_array_elements(ceiling->'assistants');
  END IF;
  scope_cap:=application_query_scope_cap((ceiling->>'tier')::int,ceiling->'compartments',ceiling->'projectIds');
  IF scope_cap IS NULL THEN RETURN NULL;END IF;
  v2:=ceiling->'departmentRead';
  IF v2<>'null' THEN
   IF application_query_scope_valid(v2) IS NOT TRUE THEN RETURN NULL;END IF;
   scope_cap:=application_query_scope_intersection(scope_cap,v2);IF scope_cap IS NULL THEN RETURN NULL;END IF;
  END IF;
  IF ceiling->>'workspaceId'<>w::text OR ceiling->>'typeKey'<>p_type THEN CONTINUE;END IF;
  selector:=jsonb_build_object('ids',ceiling->'ids','ownerId',NULL,'relationships','[]'::jsonb,'empty',false);
  FOR key IN SELECT unnest(ARRAY['formula','privateFormula']) LOOP
   clauses:='[]';
   FOR clause IN SELECT value FROM jsonb_array_elements(context->key->'clauses') LOOP
    scope:=application_query_scope_intersection(clause->'scope',scope_cap);
    IF scope IS NULL THEN RETURN NULL;END IF;
    clause:=jsonb_set(jsonb_set(clause,'{scope}',scope),'{selector}',application_query_selector_meet(clause->'selector',selector));
    IF clause#>>'{selector,empty}' IS DISTINCT FROM 'true' THEN clauses:=clauses||jsonb_build_array(clause);END IF;
   END LOOP;
   context:=jsonb_set(context,ARRAY[key,'clauses'],(SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM (SELECT DISTINCT value FROM jsonb_array_elements(clauses)) canonical));
  END LOOP;
  visibility:=context->'visibility';
  visibility:=jsonb_set(visibility,'{assistants}',application_query_set_intersection(visibility->'assistants',ceiling->'assistants'));
  IF visibility->>'userId' IS DISTINCT FROM ceiling->>'privateUserId' THEN
   context:=jsonb_set(context,'{privateFormula,clauses}','[]');visibility:=jsonb_set(visibility,'{userId}','null');
  END IF;
  context:=jsonb_set(context,'{visibility}',visibility);
 END LOOP;
 RETURN context;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_native_query_context(uuid,text) FROM PUBLIC;
-- Stored evidence reauthorizes actual current rights, independently of another
-- in-flight query's data selector. The original footprint stays immutable.
DO $migration$
DECLARE definition text;before text:='context:=application_native_query_context(w,p_type)';
BEGIN
 SELECT pg_get_functiondef('public.application_query_domain_state(uuid,jsonb,text,uuid,text[])'::regprocedure) INTO definition;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native query source reauthorization changed';END IF;
 EXECUTE replace(definition,before,'context:=application_native_query_context_before_data_ceiling(w,p_type)');
END $migration$;
COMMIT;
