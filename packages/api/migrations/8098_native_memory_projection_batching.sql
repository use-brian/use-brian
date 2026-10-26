BEGIN;
-- [COMP:api/application-persistence] Project admitted Memory columns together.
-- The complete canonical checks and READ/legacy digests remain unchanged.
DO $memory_selected_projection$
DECLARE signature text;definition text;before text;after text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['application_memory_field_state_before_successor(uuid,uuid,text[])',
  'application_memory_historical_field_state(uuid,uuid,text[])'] LOOP
  definition:=pg_get_functiondef(signature::regprocedure);
  before:=$before$FOREACH field IN ARRAY fields LOOP
  EXECUTE format('SELECT to_jsonb(%I) FROM public.memories WHERE workspace_id=$1 AND id=$2 AND scope_version::text=$3',
   field)
   INTO value USING w,i,row_version;
  $before$;
  IF signature='application_memory_historical_field_state(uuid,uuid,text[])' THEN
   before:=before||$before$IF field IN('valid_to','superseded_by') THEN value:='null'::jsonb;
  ELSIF field='updated_at' THEN SELECT to_jsonb(t.prior_updated_at) INTO value FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND t.predecessor_id=i;END IF;
  $before$;
  END IF;
  before:=before||$before$values_json:=values_json||jsonb_build_object(field,value);
 END LOOP;$before$;
  IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory selected projection prerequisite changed: %',signature;END IF;
  after:=$after$IF cardinality(fields)>0 THEN
  -- Identifiers come only from the validated selected field keys above.
  -- Each column is serialized individually after admission, never as a row.
  SELECT 'SELECT jsonb_build_object('||string_agg(format('%L,to_jsonb(%I)',selected,selected),',' ORDER BY ordinal)||
   ') FROM public.memories WHERE workspace_id=$1 AND id=$2 AND scope_version::text=$3'
   INTO field FROM unnest(fields) WITH ORDINALITY selection(selected,ordinal);
  EXECUTE field INTO values_json USING w,i,row_version;
 END IF;$after$;
  IF signature='application_memory_historical_field_state(uuid,uuid,text[])' THEN
   after:=after||$after$
 IF 'valid_to'=ANY(fields) THEN values_json:=values_json||jsonb_build_object('valid_to',NULL);END IF;
 IF 'superseded_by'=ANY(fields) THEN values_json:=values_json||jsonb_build_object('superseded_by',NULL);END IF;
 IF 'updated_at'=ANY(fields) THEN
  SELECT to_jsonb(t.prior_updated_at) INTO value FROM native_memory_successor_transitions t WHERE t.workspace_id=w AND t.predecessor_id=i;
  values_json:=values_json||jsonb_build_object('updated_at',value);
 END IF;$after$;
  END IF;
  -- All other function bytes, ownership, ACLs and configuration survive.
  EXECUTE replace(definition,before,after);
 END LOOP;
END $memory_selected_projection$;
COMMIT;
