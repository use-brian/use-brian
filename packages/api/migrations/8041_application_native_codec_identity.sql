BEGIN;
-- [COMP:api/application-field-evidence] A changed value codec is a field revision,
-- never an in-place rewrite of immutable observations or a fake business edit.
DO $migration$
DECLARE definition text;before text:=$source$'kind','builtin','version',1$source$;
BEGIN
 SELECT pg_get_functiondef('public.application_field_projection_state_before_module_policy(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure) INTO definition;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native builtin identity source changed; review the codec revision';END IF;
 EXECUTE replace(definition,before,$source$'kind','builtin','version',CASE WHEN p_type='deal' AND field='amount' THEN 2 ELSE 1 END$source$);
END $migration$;
COMMIT;
