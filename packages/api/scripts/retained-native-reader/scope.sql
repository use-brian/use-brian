CREATE OR REPLACE FUNCTION public.read_native_retained_scope_evidence(w uuid, roots jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 result:=read_native_retained_requirements(w,roots,'[]'::jsonb);
 IF native_retained_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'retained_reader_contract_changed' USING ERRCODE='42501';END IF;
 IF result->>'available' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',result->'immutable','current',result->'current');
END $function$
