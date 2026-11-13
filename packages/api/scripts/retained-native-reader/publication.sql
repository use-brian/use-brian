CREATE OR REPLACE FUNCTION public.read_native_retained_publication_cohorts(w uuid, cohorts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE roots jsonb;cohort jsonb;identity jsonb;result jsonb;context jsonb;discovered jsonb;
BEGIN
 IF nullif(current_setting('app.current_user_id',true),'') IS NULL OR EXISTS(
  SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN
  RAISE EXCEPTION 'native_turn_principal_required' USING ERRCODE='42501';END IF;
 IF w IS NULL OR jsonb_typeof(cohorts) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
 IF jsonb_array_length(cohorts)<>2 THEN RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
 FOR cohort IN SELECT value FROM jsonb_array_elements(cohorts) LOOP
  IF jsonb_typeof(cohort) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
  IF jsonb_array_length(cohort) NOT BETWEEN 1 AND 4096 THEN RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
  FOR identity IN SELECT value FROM jsonb_array_elements(cohort) LOOP
   IF jsonb_typeof(identity) IS DISTINCT FROM 'object' OR identity-ARRAY['kind','id','version']<>'{}'
    OR NOT identity ?& ARRAY['kind','id','version'] OR jsonb_typeof(identity->'kind') IS DISTINCT FROM 'string'
    OR jsonb_typeof(identity->'id') IS DISTINCT FROM 'string' OR jsonb_typeof(identity->'version') IS DISTINCT FROM 'string'
    OR length(identity->>'version') NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
   IF identity->>'kind' NOT IN('application_field','session_message','session_context_revision','workspace_file') THEN
    RAISE EXCEPTION 'native_turn_cohort_source_kind' USING ERRCODE='22023';END IF;
   IF (identity->>'id')::uuid IS NULL THEN RAISE EXCEPTION 'native_turn_cohort_shape' USING ERRCODE='22023';END IF;
  END LOOP;
 END LOOP;
 IF native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_turn_reader_contract_changed' USING ERRCODE='42501';END IF;
 SELECT jsonb_agg(n ORDER BY native_turn_key(n||'{"tag":"source"}'::jsonb)) INTO roots
 FROM(SELECT DISTINCT i.value n FROM jsonb_array_elements(cohorts) c CROSS JOIN LATERAL jsonb_array_elements(c.value) i) union_roots;
 -- An oversized union can retain the original independent readers. No
 -- authority has been evaluated and no write has occurred at this point.
 IF jsonb_array_length(roots)>4096 THEN RETURN NULL;END IF;
 context:=native_turn_context();
 discovered:=native_retained_metadata(w,roots,'[]'::jsonb,true);
 IF discovered->>'eligibleMetadata' IS DISTINCT FROM 'true' THEN
  IF discovered->>'authorizationEvaluated'='false'
   OR discovered='{"eligibleMetadata":false,"reason":"selector_candidate_bound"}'::jsonb THEN RETURN NULL;END IF;
  RAISE EXCEPTION 'native_turn_cohort_discovery_refused' USING ERRCODE='42501';END IF;
 IF native_turn_lock_requirements(w,discovered) IS NOT TRUE THEN RAISE EXCEPTION 'native_turn_lock_coverage' USING ERRCODE='42501';END IF;
 SELECT native_retained_capture_cohorts(w,roots,cohorts) INTO result;
 IF native_retained_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'native_turn_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF native_turn_context() IS DISTINCT FROM context THEN
  RAISE EXCEPTION 'native_turn_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF result->>'available' IS DISTINCT FROM 'true' OR result->>'admitted' IS DISTINCT FROM 'true' THEN
  RAISE EXCEPTION 'native_turn_cohort_capture_refused' USING ERRCODE='42501';END IF;
 IF result#>'{requirements,nativeMetadata}' IS DISTINCT FROM discovered#>'{witness,nativeMetadata}'
  OR result#>'{requirements,sessionParents}' IS DISTINCT FROM discovered#>'{witness,sessionParents}' THEN
  RAISE EXCEPTION 'native_turn_lock_coverage' USING ERRCODE='42501';END IF;
 IF result->>'validUntil' IS NULL OR clock_timestamp()>=(result->>'validUntil')::timestamptz THEN
  RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('admitted',true,'cohorts',result->'cohorts');
END $function$
