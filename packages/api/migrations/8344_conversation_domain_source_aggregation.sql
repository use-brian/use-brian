BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

-- [COMP:api/native-turn-frame] Assemble the exact sources of conversation envelopes.
DO $conversation_envelope$
DECLARE
 member_signature constant text:='conversation_dag_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb[])';
 helper constant regprocedure:='public.conversation_dag_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb[])'::regprocedure;
 original pg_proc;
 changed text;
BEGIN
 LOCK TABLE public.native_turn_contract_helpers IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO STRICT original FROM pg_catalog.pg_proc WHERE oid=helper;
 IF public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE
  OR encode(sha256(convert_to(original.prosrc,'UTF8')),'hex')<>'68ae875f64e99ac4e2a672d17319abdd8c8bd4d6078928215263b718a6279905'
  OR NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=member_signature
    AND (h.contract).oid=helper::oid AND (h.contract).prosrc=original.prosrc)
 THEN RAISE EXCEPTION 'conversation_envelope_predecessor_changed';END IF;

 changed:=original.prosrc;
 changed:=replace(changed,$before$children jsonb:='[]';child jsonb;external record;$before$,$after$children jsonb:='[]';external record;$after$);
 changed:=replace(changed,$before$ FOR child IN SELECT value FROM jsonb_array_elements(children) LOOP
  sources:=sources||jsonb_build_array(child->'source')||coalesce(child->'sources','[]');
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (SELECT DISTINCT value FROM jsonb_array_elements(sources)) unique_sources;$before$,$after$ -- Expand each child's source and inherited sources before globally deduplicating.
 -- Retain JSONB concatenation for each child, including scalar or JSON null sources.
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (
  SELECT existing.value FROM jsonb_array_elements(sources) existing(value)
  UNION
  SELECT inherited.value FROM jsonb_array_elements(children) child(value)
  CROSS JOIN LATERAL jsonb_array_elements(
   jsonb_build_array(child.value->'source')||coalesce(child.value->'sources','[]')) inherited(value)
 ) unique_sources;$after$);
 IF encode(sha256(convert_to(changed,'UTF8')),'hex')<>'743bc7d7207e289e9916f899590d48852e6df696744ca5572c18684ddd198368'
 THEN RAISE EXCEPTION 'conversation_envelope_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(helper),original.prosrc,changed);
 IF (SELECT to_jsonb(p) FROM pg_catalog.pg_proc p WHERE p.oid=helper)
  IS DISTINCT FROM jsonb_set(to_jsonb(original),'{prosrc}',to_jsonb(changed))
 THEN RAISE EXCEPTION 'conversation_envelope_metadata_changed';END IF;
 UPDATE public.native_turn_contract_helpers h
 SET contract=jsonb_populate_record(h.contract,jsonb_build_object('prosrc',changed))
 WHERE h.signature=member_signature;
 IF NOT FOUND OR public.native_turn_contract_witness_refresh() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_envelope_witness_changed';END IF;
END $conversation_envelope$;

COMMIT;
