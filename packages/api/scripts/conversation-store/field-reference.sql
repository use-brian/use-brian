-- [COMP:api/native-turn-frame] All canonical prepared field families share one reference gate.
-- The predecessor was authenticated before replacement. Keep its operation,
-- context, contract and exact observation checks; remove the retired writer's
-- conversation/Memory-only selector restriction.
DO $field_reference$
DECLARE definition text;restriction text:=$old$ AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb
     AND f.type_key IN('session_message','session_message_annotation','memory') AND f.selection IN('read','query','identity','query_domain') AND f.selected_version IS NULL$old$;
BEGIN
 definition:=pg_get_functiondef('native_turn_field_reference(uuid,uuid,uuid,text)'::regprocedure);
 IF strpos(definition,restriction)=0 THEN RAISE EXCEPTION 'conversation_field_reference_predecessor_changed';END IF;
 EXECUTE replace(definition,restriction,'');
END $field_reference$;
