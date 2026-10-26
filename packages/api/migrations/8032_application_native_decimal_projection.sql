BEGIN;
-- [COMP:api/application-records] Transport JSON must not round a native amount.
DO $$
DECLARE definition text; before text:=$source$'amount',payload->'attributes'->'amount'$source$;
BEGIN
 SELECT pg_get_functiondef('public.application_native_projection(text,uuid,text,text[])'::regprocedure) INTO definition;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native decimal projection source changed; review the canonical adapter';END IF;
 EXECUTE replace(definition,before,$source$'amount',payload->'attributes'->>'amount'$source$);
END $$;
DO $$
DECLARE definition text; before text:=$source$'amount',native_row#>'{attributes,amount}'$source$;
BEGIN
 SELECT pg_get_functiondef('public.application_field_projection_state_before_module_policy(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure) INTO definition;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native decimal evidence source changed; review the canonical field boundary';END IF;
 EXECUTE replace(definition,before,$source$'amount',native_row#>>'{attributes,amount}'$source$);
END $$;
COMMIT;
