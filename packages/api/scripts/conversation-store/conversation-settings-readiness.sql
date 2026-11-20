-- [COMP:api/conversation-visibility] A versioned handshake prevents older
-- API binaries from opening settings from this migration during rollout.
CREATE FUNCTION public.conversation_visibility_settings_ready(protocol integer) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $settings_ready$
 SELECT protocol=1
  AND coalesce(has_function_privilege(current_user,to_regprocedure('public.read_conversation_member_tiers(uuid[],boolean)'),'EXECUTE'),false)
  AND coalesce(has_function_privilege(current_user,to_regprocedure('public.read_conversation_visibility(uuid,uuid,integer)'),'EXECUTE'),false)
  AND coalesce(has_function_privilege(current_user,to_regprocedure('public.change_conversation_visibility(uuid,uuid,integer,bigint,text,jsonb)'),'EXECUTE'),false)
  AND coalesce(has_function_privilege(current_user,to_regprocedure('public.capture_native_page_turn_anchor(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,uuid)'),'EXECUTE'),false)
  AND coalesce(has_function_privilege(current_user,to_regprocedure('public.pin_verified_channel_conversation_append(uuid,uuid,uuid,uuid,text,text,boolean,boolean,bigint,uuid,uuid)'),'EXECUTE'),false)
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY[
   'public.read_native_conversation_history(uuid,uuid,integer)',
   'public.read_native_page_conversation_rows(uuid,text)',
   'public.lock_conversation_member_read(uuid,uuid,uuid)',
   'public.read_public_conversation_history(uuid,jsonb,uuid,text,text,integer)',
   'public.conversation_record_derivation_current(uuid,text,uuid,text,uuid)',
   'public.read_compiled_conversation_payload(public.conversation_envelopes,integer,integer,integer,boolean,uuid,text)'
  ]) owner_function(signature)
   WHERE to_regprocedure(signature) IS NULL OR has_function_privilege(current_user,to_regprocedure(signature),'EXECUTE'))
$settings_ready$;
REVOKE ALL ON FUNCTION public.conversation_visibility_settings_ready(integer) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.conversation_visibility_settings_ready(integer) TO app_user;
