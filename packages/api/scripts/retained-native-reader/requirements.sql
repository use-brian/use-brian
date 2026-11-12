-- [COMP:api/native-chat-read-cost] Fresh lock discovery and coherent canonical acquisition.
CREATE OR REPLACE FUNCTION public.read_native_retained_requirements(w uuid, roots jsonb, selectors jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;context jsonb;discovered jsonb;
BEGIN
 context:=native_turn_context();
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 discovered:=native_retained_metadata(w,roots,selectors,true);
 IF discovered->>'eligibleMetadata' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('available',false,'reason','unsupported_requirements');END IF;
 IF native_turn_lock_requirements(w,discovered) IS NOT TRUE THEN RETURN jsonb_build_object('available',false,'reason','lock_coverage');END IF;
 SELECT native_retained_capture_requirements(w,roots,selectors) INTO result;
 IF native_retained_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context THEN RETURN jsonb_build_object('available',false,'reason','reader_contract_changed');END IF;
 IF result->>'available'='true' AND (
  result#>'{requirements,nativeMetadata}' IS DISTINCT FROM discovered#>'{witness,nativeMetadata}'
  OR result#>'{requirements,sessionParents}' IS DISTINCT FROM discovered#>'{witness,sessionParents}')
 THEN RETURN jsonb_build_object('available',false,'reason','lock_coverage');END IF;
 IF result->>'available'='true' AND clock_timestamp()>=(result->>'validUntil')::timestamptz THEN
  RAISE EXCEPTION 'native_turn_policy_expired' USING ERRCODE='42501';END IF;
 RETURN result;
END $function$
