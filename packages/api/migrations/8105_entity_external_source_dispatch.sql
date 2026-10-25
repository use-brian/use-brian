BEGIN;
-- [COMP:api/identity-context] Extend the existing private canonical dispatcher;
-- existing operation-bound receipts and retention guards remain authoritative.
DO $migration$
DECLARE definition text;anchor text;metadata jsonb;target oid:='public.read_entity_derivation_source(uuid,text,uuid)'::regprocedure;
BEGIN
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 anchor:=$source$RETURN read_entity_derivation_source_before_memory_successor(w,k,i);$source$;
 IF length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
  RAISE EXCEPTION 'Canonical entity derivation dispatcher changed; review external source admission';
 END IF;
 EXECUTE replace(definition,anchor,$source$IF k='external_source' THEN RETURN external_source_snapshot(w,i);END IF;
 $source$||anchor);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Canonical entity derivation function identity or privileges changed';
 END IF;
END $migration$;
COMMIT;
