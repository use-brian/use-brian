BEGIN;
-- [COMP:corrections/retraction-store] Generated values are not available in BEFORE.
-- summary/detail remain compared, so the generated vector cannot conceal a body change.
DO $generated_vector_order$
DECLARE port regprocedure;definition text;metadata jsonb;before text;after text;
BEGIN
 before := $before$ARRAY['retracted_at','retracted_reason','retracted_by','valid_to','scope_version','updated_at']$before$;
 after := $after$ARRAY['retracted_at','retracted_reason','retracted_by','valid_to','scope_version','updated_at','search_vector']$after$;
 FOREACH port IN ARRAY ARRAY['public.advance_memory_scope_version()'::regprocedure,'public.invalidate_retracted_memory_descendants()'::regprocedure] LOOP
  SELECT to_jsonb(p)-'prosrc' INTO metadata FROM pg_proc p WHERE oid=port;
  definition:=pg_get_functiondef(port);
  IF array_length(string_to_array(definition,before),1)<>3 THEN RAISE EXCEPTION 'Memory generated vector prerequisite changed';END IF;
  EXECUTE replace(definition,before,after);
  IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata THEN
   RAISE EXCEPTION 'Memory invalidation metadata changed';END IF;
 END LOOP;
END $generated_vector_order$;
COMMIT;
