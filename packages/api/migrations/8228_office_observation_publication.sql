-- [COMP:api/office-generation] Canonical Office observations are native lineage roots.
BEGIN;
DO $$ DECLARE definition text; original text; replacement text; BEGIN
 SELECT pg_get_functiondef('record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure) INTO definition;
 original:=$before$('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','session_message','session_context_revision','external_source')$before$;
 replacement:=$after$('memory','entity','entity_link','task','workspace_file','episode','knowledge_entry','kb_chunk','session_message','session_context_revision','external_source','office_observation')$after$;
 IF position(original IN definition)=0 THEN RAISE EXCEPTION 'Native Memory source admission changed'; END IF;
 EXECUTE replace(definition,original,replacement);
END $$;
COMMIT;
