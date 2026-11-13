CREATE OR REPLACE FUNCTION public.read_native_turn_requirements(w uuid, roots jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;context jsonb;discovered jsonb;
BEGIN
 context:=native_turn_context();
 IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
  FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) THEN
  IF native_retained_helpers_current() IS TRUE THEN
  result:=read_native_retained_requirements(w,roots,'[]'::jsonb);
  IF (SELECT count(*)=1 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')='__RETAINED_GUARD_FINGERPRINT__'),false)
   FROM pg_proc p WHERE p.oid=to_regprocedure('public.native_retained_helpers_current()')) IS NOT TRUE
  THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
  IF native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
  IF result->>'available'='true' THEN RETURN result-ARRAY['metadata','queryCaptures'];END IF;
  END IF;
 END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 discovered:=native_turn_metadata_acquire(w,roots);
 IF discovered->>'eligibleMetadata' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('available',false,'reason','unsupported_requirements');END IF;
 IF native_turn_lock_requirements(w,discovered) IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','lock_coverage');END IF;
 SELECT native_turn_capture_requirements(w,roots) INTO result;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 IF result->>'available'='true' AND (
  result#>'{requirements,nativeMetadata}' IS DISTINCT FROM discovered#>'{witness,nativeMetadata}'
  OR result#>'{requirements,sessionParents}' IS DISTINCT FROM discovered#>'{witness,sessionParents}')
 THEN RETURN jsonb_build_object('available',false,'reason','lock_coverage');END IF;
 IF result->>'available'='true' AND clock_timestamp()>=(result->>'validUntil')::timestamptz THEN
  RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 RETURN result;
END $function$
