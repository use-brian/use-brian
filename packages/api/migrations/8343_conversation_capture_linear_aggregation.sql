BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

-- [COMP:api/native-turn-frame] Assemble each admitted selection in sequence order.
DO $conversation_capture$
DECLARE
 selection_signature constant text:='capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)';
 guard_placeholder constant text:='__CAPTURE_GUARD_FINGERPRINT__';
 member record;
 helper regprocedure;
 original pg_proc;
 changed text;
 original_normalized text;
 changed_normalized text;
 guard text;
BEGIN
 LOCK TABLE public.native_turn_contract_helpers IN SHARE ROW EXCLUSIVE MODE;
 IF public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_capture_predecessor_changed';END IF;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT guard FROM pg_catalog.pg_proc p
 WHERE p.oid='public.native_turn_helpers_current()'::regprocedure;

 FOR member IN SELECT * FROM (VALUES
  ('capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)','2128b9cdeee539b208b597bca8f7ee4415572ccb68183f4665ca1e4c2da61ce8',
   'c9270581bdc0f22a574f7d3399123a62259b504a6f246372427a5d0b29a610cd'),
  ('capture_conversation_query(uuid,uuid,integer,integer)','9d3ae133fe0754ad603f8f3c932ec1cab7e8e355a0da3140b1dbde5fd9414404',
   'd7426df64a2443d874862b6d4c4b92d3a6156f54f83b0b8330e798902d780d7a')
 ) targets(signature,before_sha,after_sha) LOOP
  helper:=to_regprocedure('public.'||member.signature);
  SELECT * INTO STRICT original FROM pg_catalog.pg_proc WHERE oid=helper;
  -- The query contains the installation-specific guard catalog fingerprint
  -- twice. Authenticate both positions without binding this migration to OIDs.
  IF member.signature<>selection_signature AND
   length(original.prosrc)-length(replace(original.prosrc,guard,''))<>2*length(guard)
  THEN RAISE EXCEPTION 'conversation_capture_guard_predecessor_changed';END IF;
  original_normalized:=replace(original.prosrc,guard,guard_placeholder);
  IF encode(sha256(convert_to(original_normalized,'UTF8')),'hex')<>member.before_sha
   OR NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=member.signature
    AND (h.contract).oid=helper::oid AND (h.contract).prosrc=original.prosrc)
  THEN RAISE EXCEPTION 'conversation_capture_predecessor_changed: %',member.signature;END IF;

  changed:=original.prosrc;
  IF member.signature=selection_signature THEN
   changed:=replace(changed,$before$candidate record;result jsonb;point jsonb;parent jsonb;candidates jsonb:='[]';points jsonb:='[]';policies jsonb:='[]';children jsonb:='[]';attempts integer:=0;resource uuid;field_identity text;$before$,$after$parent jsonb;candidates jsonb;points jsonb;policies jsonb;children jsonb;attempts bigint;$after$);
   changed:=replace(changed,$before$THEN RETURN jsonb_build_object('memo',memo);END IF;$before$,$after$THEN RETURN '{}'::jsonb;END IF;$after$);
   changed:=replace(changed,$before$ FOR candidate IN SELECT id,sequence_num FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num<=through ORDER BY sequence_num,id
 LOOP
  attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  point:=memo#>ARRAY['envelopes',jsonb_build_array(t,candidate.id,fields)::text];
  IF point IS NULL OR point='null'::jsonb OR application_query_scope_admits_point(bounds,point->'source') IS NOT TRUE
   OR point#>>'{source,userId}' IS NOT NULL AND point#>>'{source,userId}' IS DISTINCT FROM visibility->>'userId'
   OR point#>>'{source,assistantId}' IS NOT NULL AND visibility->'assistants'<>'null'::jsonb
    AND NOT coalesce(visibility->'assistants' ? (point#>>'{source,assistantId}'),false) THEN CONTINUE;END IF;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',point#>'{state,recordVersion}'));
  points:=points||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',point#>'{state,recordVersion}','fields',fields,'source',point->'source'));
  policies:=policies||jsonb_build_array(jsonb_build_object('id',candidate.id,'policy',point#>'{state,policyVersion}'));
  children:=children||jsonb_build_array(point);
 END LOOP;
 RETURN jsonb_build_object('memo',memo,'value',jsonb_build_object('parent',parent,'candidates',candidates,'points',points,'policies',policies),'children',children);$before$,$after$ WITH bounded AS MATERIALIZED (
  SELECT id,sequence_num FROM session_messages
  WHERE workspace_id=w AND session_id=s AND sequence_num<=through ORDER BY sequence_num,id LIMIT 4097
 ), cohort_size AS MATERIALIZED (
  SELECT count(*) AS attempts FROM bounded
 ), envelopes AS MATERIALIZED (
  SELECT b.id,b.sequence_num,memo#>ARRAY['envelopes',jsonb_build_array(t,b.id,fields)::text] AS point
  FROM bounded b WHERE (SELECT n.attempts FROM cohort_size n)<=4096
 ), admitted AS (
  SELECT * FROM envelopes WHERE (
   point IS NULL OR point='null'::jsonb OR application_query_scope_admits_point(bounds,point->'source') IS NOT TRUE
   OR point#>>'{source,userId}' IS NOT NULL AND point#>>'{source,userId}' IS DISTINCT FROM visibility->>'userId'
   OR point#>>'{source,assistantId}' IS NOT NULL AND visibility->'assistants'<>'null'::jsonb
    AND NOT coalesce(visibility->'assistants' ? (point#>>'{source,assistantId}'),false)) IS NOT TRUE
 )
 SELECT (SELECT n.attempts FROM cohort_size n),
  coalesce(jsonb_agg(jsonb_build_object('id',id,'version',point#>'{state,recordVersion}') ORDER BY sequence_num,id),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('id',id,'version',point#>'{state,recordVersion}','fields',fields,'source',point->'source') ORDER BY sequence_num,id),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('id',id,'policy',point#>'{state,policyVersion}') ORDER BY sequence_num,id),'[]'),
  coalesce(jsonb_agg(point ORDER BY sequence_num,id),'[]')
 INTO attempts,candidates,points,policies,children FROM admitted;
 IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('value',jsonb_build_object('parent',parent,'candidates',candidates,'points',points,'policies',policies),'children',children);$after$);
  ELSE
   -- Each selection returns projections of its graph. Retain that pass's
   -- exact graph in the query, including its existing expiry check.
   changed:=replace(changed,$before$   memo:=scanned->'memo';
$before$,$after$$after$);
  END IF;
  changed_normalized:=replace(changed,guard,guard_placeholder);
  IF encode(sha256(convert_to(changed_normalized,'UTF8')),'hex')<>member.after_sha
  THEN RAISE EXCEPTION 'conversation_capture_successor_changed: %',member.signature;END IF;
  EXECUTE replace(pg_get_functiondef(helper),original.prosrc,changed);
  IF (SELECT to_jsonb(p) FROM pg_catalog.pg_proc p WHERE p.oid=helper)
   IS DISTINCT FROM jsonb_set(to_jsonb(original),'{prosrc}',to_jsonb(changed))
  THEN RAISE EXCEPTION 'conversation_capture_metadata_changed: %',member.signature;END IF;
  UPDATE public.native_turn_contract_helpers h
  SET contract=jsonb_populate_record(h.contract,jsonb_build_object('prosrc',changed))
  WHERE h.signature=member.signature;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_capture_contract_missing: %',member.signature;END IF;
 END LOOP;

 IF public.native_turn_contract_witness_refresh() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_capture_witness_changed';END IF;
END $conversation_capture$;

COMMIT;
