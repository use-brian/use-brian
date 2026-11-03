CREATE FUNCTION crm_formula_comparison.scope_before(original jsonb,current_scopes jsonb,budget int) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original_scope jsonb:=public.application_normalize_native_query_bounds(original); scope jsonb; normalized jsonb[]:='{}';
 tier int; departments text[]; required_departments text[]; options jsonb; conditions jsonb[]; used int:=1; escaped jsonb;
 original_context text; current_context text; department text; general_covered boolean; department_covered boolean;
BEGIN
 IF budget IS NULL OR budget<1 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
 IF public.application_query_scope_valid(original) IS NOT TRUE OR jsonb_typeof(current_scopes) IS DISTINCT FROM 'array'
  THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
 FOR scope IN SELECT value FROM jsonb_array_elements(current_scopes) LOOP
  used:=used+1;
  IF used>budget THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
  IF public.application_query_scope_valid(scope) IS NOT TRUE THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
  scope:=public.application_normalize_native_query_bounds(scope);
  -- These axes are independent upper sets. Coverage of the original maximum
  -- Project/other-label/Project-ID combination covers every subset as well.
  IF (scope->'projectLabels'='null' OR (original_scope->'projectLabels')<@(scope->'projectLabels'))
   AND (scope->'otherLabels'='null' OR original_scope->'otherLabels'<>'null' AND (original_scope->'otherLabels')<@(scope->'otherLabels'))
   AND (scope->'projectIds'='null' OR original_scope->'projectIds'<>'null' AND (original_scope->'projectIds')<@(scope->'projectIds')) THEN
   normalized:=array_append(normalized,scope);
  END IF;
 END LOOP;
 original_context:=original_scope->>'contextDepartment';
 FOR tier IN 1..3 LOOP
  general_covered:=(original_scope->>'tier')::int<tier;
  conditions:='{}';department_covered:=false;required_departments:='{}';
  IF original_scope->'departments'='null' THEN
   IF tier>(original_scope->>'tier')::int THEN departments:='{}';
   ELSE
    -- A fresh Department outside every finite current map witnesses the
    -- legacy universe. Only a current universe can cover that combination.
    departments:=ARRAY['d:*'];required_departments:=departments;
    IF original_context IS NOT NULL THEN departments:=array_append(departments,'d:='||original_context);required_departments:=departments; END IF;
   END IF;
  ELSE
   SELECT coalesce(array_agg('d:='||key ORDER BY key),'{}') INTO departments FROM jsonb_each(original_scope->'departments') WHERE (value#>>'{}')::int>=tier;
   IF original_context IS NOT NULL THEN
    IF NOT ('d:='||original_context=ANY(departments)) THEN departments:='{}';
    ELSE required_departments:=ARRAY['d:='||original_context]; END IF;
   END IF;
  END IF;
  FOREACH scope IN ARRAY normalized LOOP
   used:=used+1;
   IF used>budget THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
   IF tier<=(scope->>'tier')::int THEN general_covered:=true; END IF;
   IF cardinality(departments)=0 OR department_covered THEN CONTINUE; END IF;
   current_context:=scope->>'contextDepartment';
   IF current_context IS NOT NULL AND NOT ('d:='||current_context=ANY(departments))
    OR scope->'departments'='null' AND tier>(scope->>'tier')::int THEN CONTINUE; END IF;
   options:='[]';
   FOREACH department IN ARRAY departments LOOP
    IF scope->'departments'<>'null' AND (department='d:*' OR coalesce((scope#>>ARRAY['departments',substr(department,4)])::int,0)<tier) THEN
     options:=options||jsonb_build_array(jsonb_build_object('present',department));
    END IF;
   END LOOP;
   IF current_context IS NOT NULL AND NOT ('d:='||current_context=ANY(required_departments)) THEN
    options:=options||jsonb_build_array(jsonb_build_object('absent','d:='||current_context));
   END IF;
   IF jsonb_array_length(options)=0 THEN department_covered:=true;
   ELSE conditions:=array_append(conditions,options); END IF;
  END LOOP;
  IF NOT general_covered THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
  IF cardinality(departments)>0 AND NOT department_covered THEN
   escaped:=public.application_query_scope_escape(conditions,1,required_departments,'{}',departments,budget-used);
   used:=used+(escaped->>'used')::int;
   IF escaped->>'escape'='true' THEN RETURN jsonb_build_object('contains',false,'used',used); END IF;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('contains',true,'used',used);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN jsonb_build_object('contains',false,'used',used);
END $$;
CREATE OR REPLACE FUNCTION crm_formula_comparison.before(current_domain jsonb,original jsonb,required_fields text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original_clause jsonb; original_selector jsonb; current_clause jsonb; point jsonb; points jsonb[]; fields text[]; field text;
 scopes jsonb; checked jsonb; used int:=0;
BEGIN
 IF current_domain->>'kind' IS DISTINCT FROM 'application_query' OR original->>'kind' IS DISTINCT FROM 'application_query'
  OR current_domain->'version' IS DISTINCT FROM '1'::jsonb OR original->'version' IS DISTINCT FROM '1'::jsonb
  OR current_domain-ARRAY['kind','version','clauses']<>'{}'::jsonb OR original-ARRAY['kind','version','clauses']<>'{}'::jsonb
  OR jsonb_typeof(current_domain->'clauses') IS DISTINCT FROM 'array' OR jsonb_typeof(original->'clauses') IS DISTINCT FROM 'array'
  OR jsonb_array_length(current_domain->'clauses')>4096 OR jsonb_array_length(original->'clauses')>4096
  OR required_fields IS NULL OR cardinality(required_fields)>128 OR array_position(required_fields,NULL) IS NOT NULL THEN RETURN false; END IF;
 FOR current_clause IN SELECT value FROM jsonb_array_elements((current_domain->'clauses')||(original->'clauses')) LOOP
  IF jsonb_typeof(current_clause) IS DISTINCT FROM 'object' OR NOT current_clause ?& ARRAY['scope','selector','read']
   OR current_clause-ARRAY['scope','selector','read']<>'{}'::jsonb
   OR public.application_query_scope_valid(current_clause->'scope') IS NOT TRUE
   OR public.application_query_selector_valid_normalized(current_clause->'selector') IS NOT TRUE
   OR jsonb_typeof(current_clause->'read') IS DISTINCT FROM 'array' OR jsonb_array_length(current_clause->'read')>128
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(current_clause->'read') item WHERE jsonb_typeof(item)<>'string') THEN RETURN false; END IF;
 END LOOP;
 fields:=ARRAY[NULL::text]||required_fields;
 FOR original_clause IN SELECT value FROM jsonb_array_elements(original->'clauses') LOOP
  original_selector:=original_clause->'selector';
  IF original_selector->>'empty'='true' THEN CONTINUE; END IF;
  IF original_selector->'ids'='null' THEN points:=ARRAY[original_selector];
  ELSE
   SELECT coalesce(array_agg(jsonb_set(original_selector,'{ids}',jsonb_build_array(value))),'{}') INTO points
    FROM jsonb_array_elements(original_selector->'ids');
  END IF;
  FOREACH point IN ARRAY points LOOP
   FOREACH field IN ARRAY fields LOOP
    scopes:='[]';
    FOR current_clause IN SELECT value FROM jsonb_array_elements(current_domain->'clauses') LOOP
     used:=used+1;
     IF used>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
     IF (field IS NULL OR (current_clause->'read') ? field) AND public.application_query_selector_covers(current_clause->'selector',point) THEN
      scopes:=scopes||jsonb_build_array(current_clause->'scope');
     END IF;
    END LOOP;
    checked:=crm_formula_comparison.scope_before(original_clause->'scope',scopes,4096-used);
    used:=used+(checked->>'used')::int;
    IF checked->>'contains' IS DISTINCT FROM 'true' THEN RETURN false; END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN false;
END $$;
