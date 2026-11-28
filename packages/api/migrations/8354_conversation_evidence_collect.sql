-- [COMP:api/native-turn-frame] Collect ordered generic conversation proof facts in linear time.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

DO $evidence_collection$
DECLARE
 target_signature constant text:='capture_conversation_evidence_generic(uuid,jsonb,jsonb,jsonb)';
 routine constant regprocedure:='public.capture_conversation_evidence_generic(uuid,jsonb,jsonb,jsonb)'::regprocedure;
 guard_slot constant text:='__CAPTURE_GUARD_FINGERPRINT__';
 original pg_proc;
 guard text;
 changed text;
BEGIN
 LOCK TABLE public.native_turn_contract_helpers IN SHARE ROW EXCLUSIVE MODE;
 IF public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_evidence_collection_predecessor_changed';END IF;

 SELECT * INTO STRICT original FROM pg_proc WHERE oid=routine;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT guard
 FROM pg_proc p WHERE p.oid='public.native_turn_helpers_current()'::regprocedure;
 IF length(original.prosrc)-length(replace(original.prosrc,guard,''))<>2*length(guard)
  OR encode(sha256(convert_to(replace(original.prosrc,guard,guard_slot),'UTF8')),'hex')<>'31fa50a433e91fcd1ed3f59c05fb6cd4660388bf5126e6564022cf73addab3ac'
  OR NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=target_signature AND (h.contract).prosrc=original.prosrc)
 THEN RAISE EXCEPTION 'conversation_evidence_collection_predecessor_changed';END IF;

 -- Each admitted fact is appended once and each cohort is converted once.
 -- The graph, admission loop, immutable fact lookup and order are unchanged.
 changed:=original.prosrc;
 changed:=replace(changed,$before$immutable jsonb:='[]';currents jsonb:='[]'$before$,$after$immutable jsonb[];currents jsonb[]$after$);
 changed:=replace(changed,$before$ immutable:='[]';currents:='[]';$before$,$after$ immutable:='{}';currents:='{}';$after$);
 changed:=replace(changed,$before$immutable:=immutable||jsonb_build_array(observation.source_scope$before$,$after$immutable:=array_append(immutable,observation.source_scope$after$);
 changed:=replace(changed,$before$immutable:=immutable||jsonb_build_array(source);$before$,$after$immutable:=array_append(immutable,source);$after$);
 changed:=replace(changed,$before$currents:=currents||jsonb_build_array(source-ARRAY['held','validTo','retractedAt']);$before$,$after$currents:=array_append(currents,source-ARRAY['held','validTo','retractedAt']);$after$);
 changed:=replace(changed,$before$jsonb_build_object('immutable',immutable,'current',currents)$before$,$after$jsonb_build_object('immutable',to_jsonb(immutable),'current',to_jsonb(currents))$after$);
 IF encode(sha256(convert_to(replace(changed,guard,guard_slot),'UTF8')),'hex')<>'d61bb703cce500ca35179518805be6c6004fccd4a16d6c64a96f0bdec009acbf'
 THEN RAISE EXCEPTION 'conversation_evidence_collection_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(routine),original.prosrc,changed);
 IF (SELECT to_jsonb(p) FROM pg_proc p WHERE p.oid=routine)
  IS DISTINCT FROM jsonb_set(to_jsonb(original),'{prosrc}',to_jsonb(changed))
 THEN RAISE EXCEPTION 'conversation_evidence_collection_metadata_changed';END IF;

 UPDATE public.native_turn_contract_helpers h SET contract=jsonb_populate_record(h.contract,jsonb_build_object('prosrc',changed))
 WHERE h.signature=target_signature;
 IF NOT FOUND OR public.native_turn_contract_witness_refresh() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_evidence_collection_witness_changed';END IF;
END $evidence_collection$;

COMMIT;
