BEGIN;
-- [COMP:api/application-records] Storage format is metadata of an admitted amount,
-- never another field permission, payload store or public result value.
DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('public.read_native_application_record(uuid,text,uuid,text[])'::regprocedure) INTO definition;
 before:='policy jsonb;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native point declaration changed';END IF;
 definition:=replace(definition,before,$source$policy jsonb; value_encoding text; value_encodings jsonb:='{}';$source$);
 before:=$source$RETURN captured||jsonb_build_object('id',p_id,'recordVersion',state->>'recordVersion');$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native selected point result changed';END IF;
 EXECUTE replace(definition,before,$source$IF p_type='deal' AND 'amount'=ANY(fields) THEN
  SELECT coalesce(jsonb_typeof(e.attributes->'amount'),'null') INTO value_encoding FROM entities e
   WHERE e.workspace_id=w AND e.id=p_id AND e.kind='deal' AND e.scope_version::text=(state->>'recordVersion');
  IF NOT FOUND THEN RETURN NULL;END IF;
  value_encodings:=jsonb_build_object('amount',CASE WHEN value_encoding IN('number','string','null') THEN value_encoding ELSE 'invalid' END);
 END IF;
 RETURN captured||jsonb_build_object('id',p_id,'recordVersion',state->>'recordVersion','valueEncodings',value_encodings);$source$);
END $migration$;
COMMIT;
