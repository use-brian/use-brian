-- [COMP:api/native-turn-frame] Bound contention on one recording channel's route fence.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

DO $recording_channel_lock_wait$
DECLARE
 member_signature constant text:='conversation_recording_scope(uuid,jsonb)';
 routine constant regprocedure:='public.conversation_recording_scope(uuid,jsonb)'::regprocedure;
 before_sha constant text:='0ffc9d8cece56f560b2e116b5eeb41ff336e52eee881dd0f757b23014219a6fa';
 after_sha constant text:='ae25a0941e5bdc6f4190929e8de9dde510bd91a541a1e1b3d3ae36ef5d814cda';
 original pg_proc;
 changed text;
BEGIN
 LOCK TABLE public.native_turn_contract_helpers IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO STRICT original FROM pg_proc WHERE oid=routine;
 IF public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE OR public.native_conversation_conversion_contract() IS NOT TRUE
  OR encode(sha256(convert_to(original.prosrc,'UTF8')),'hex')<>before_sha
  OR NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=member_signature
    AND (h.contract).oid=routine::oid AND (h.contract).prosrc=original.prosrc)
 THEN RAISE EXCEPTION 'recording_channel_lock_predecessor_changed';END IF;

 changed:=original.prosrc;
 changed:=replace(changed,$before$DECLARE epochs jsonb;initial jsonb;pass integer;$before$,$after$DECLARE epochs jsonb;initial jsonb;pass integer;
 channel_ids uuid[]; previous_lock_timeout text; lock_wait_ms integer; lock_deadline timestamptz;
 waiting_for_recording_lock boolean:=false;$after$);
 changed:=replace(changed,$before$  initial:=epochs;$before$,$after$  initial:=epochs;
 SELECT array_agg(id ORDER BY id) INTO channel_ids FROM (
  SELECT (p#>>'{channel,id}')::uuid id FROM jsonb_each(epochs) parent(key,p)
  UNION SELECT (audience->>'channelId')::uuid FROM jsonb_each(epochs) parent(key,p)
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{audiences}','[]'::jsonb)) audience
 ) channels_to_lock;
 -- Receipt appends lock workspace before channel. Follow the same order
 -- before entering either the channel fence or the source graph's row locks.
 IF cardinality(channel_ids)=1 THEN
  previous_lock_timeout:=current_setting('lock_timeout');
  SELECT least(200,coalesce(nullif(setting::integer,0),200)) INTO STRICT lock_wait_ms
  FROM pg_settings WHERE name='lock_timeout';
  lock_deadline:=clock_timestamp()+lock_wait_ms*interval '1 millisecond';
  PERFORM set_config('lock_timeout',lock_wait_ms||'ms',true);
  waiting_for_recording_lock:=true;
  PERFORM id FROM workspaces WHERE id=w FOR SHARE;
  waiting_for_recording_lock:=false;
 END IF;$after$);
 changed:=replace(changed,$before$ -- A channel key lock also fences a new route inserted through its FK.
 PERFORM id FROM channels WHERE workspace_id=w AND id IN(
  SELECT (p#>>'{channel,id}')::uuid FROM jsonb_each(epochs) parent(key,p)
  UNION SELECT (audience->>'channelId')::uuid FROM jsonb_each(epochs) parent(key,p)
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(p#>'{audiences}','[]'::jsonb)) audience
 ) ORDER BY id FOR UPDATE NOWAIT;$before$,$after$ -- The exclusive key lock also fences a new route inserted through its FK.
 IF cardinality(channel_ids)=1 THEN
  lock_wait_ms:=floor(extract(epoch FROM lock_deadline-clock_timestamp())*1000)::integer;
  waiting_for_recording_lock:=true;
  IF lock_wait_ms>0 THEN
   PERFORM set_config('lock_timeout',lock_wait_ms||'ms',true);
   PERFORM id FROM channels WHERE workspace_id=w AND id=channel_ids[1] FOR UPDATE;
  ELSE
   PERFORM id FROM channels WHERE workspace_id=w AND id=channel_ids[1] FOR UPDATE NOWAIT;
  END IF;
  waiting_for_recording_lock:=false;
  PERFORM set_config('lock_timeout',previous_lock_timeout,true);
 ELSE
  PERFORM id FROM channels WHERE workspace_id=w AND id=ANY(channel_ids) ORDER BY id FOR UPDATE NOWAIT;
 END IF;$after$);
 changed:=replace(changed,$before$EXCEPTION WHEN lock_not_available OR invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;$before$,$after$EXCEPTION WHEN lock_not_available THEN
 IF waiting_for_recording_lock THEN RAISE;END IF;
 RETURN false;
 WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;$after$);
 IF encode(sha256(convert_to(changed,'UTF8')),'hex')<>after_sha
 THEN RAISE EXCEPTION 'recording_channel_lock_successor_changed';END IF;
 EXECUTE replace(pg_get_functiondef(routine),original.prosrc,changed);
 IF (SELECT to_jsonb(p) FROM pg_proc p WHERE p.oid=routine)
  IS DISTINCT FROM jsonb_set(to_jsonb(original),'{prosrc}',to_jsonb(changed))
 THEN RAISE EXCEPTION 'recording_channel_lock_metadata_changed';END IF;
 UPDATE public.native_turn_contract_helpers h
 SET contract=jsonb_populate_record(h.contract,jsonb_build_object('prosrc',changed))
 WHERE h.signature=member_signature;
 IF NOT FOUND OR public.native_turn_contract_witness_refresh() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'recording_channel_lock_witness_changed';END IF;
END $recording_channel_lock_wait$;

COMMIT;
