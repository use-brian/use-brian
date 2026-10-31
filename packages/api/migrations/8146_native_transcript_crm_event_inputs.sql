BEGIN;
-- [COMP:api/application-persistence] CRM events are immutable canonical sources,
-- not editable table resources. Keep all later native/source/causal checks.
DO $migration$
DECLARE signature text; definition text;
 original text:=$before$node->>'resourceKind' NOT IN('application_field','external_source') AND scope_source_table(node->>'resourceKind') IS NULL$before$;
 replacement text:=$after$node->>'resourceKind' NOT IN('application_field','external_source','crm_event') AND scope_source_table(node->>'resourceKind') IS NULL$after$;
 immutable_original text:=$before$IN('application_field','external_source','session_context_revision')$before$;
 immutable_replacement text:=$after$IN('application_field','external_source','session_context_revision','crm_event')$after$;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'public.publish_native_session_message(uuid,uuid,jsonb,text,jsonb,jsonb)',
  'public.prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)'
 ] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(signature) AND prosecdef
   AND prokind='f' AND prorettype='jsonb'::regtype) THEN
   RAISE EXCEPTION 'Canonical native transcript prerequisite changed: %',signature;
  END IF;
  SELECT pg_get_functiondef(to_regprocedure(signature)) INTO definition;
  IF (length(definition)-length(replace(definition,original,'')))/length(original)<>1 THEN
   RAISE EXCEPTION 'Canonical native transcript source-kind guard changed: %',signature;
  END IF;
  -- Events cannot use native D1 disappearance semantics or silently lose their
  -- lineage on an altered envelope. Require exact current and retained inputs.
  IF (length(definition)-length(replace(definition,immutable_original,'')))/length(immutable_original)<>2 THEN
   RAISE EXCEPTION 'Canonical native transcript immutable-source guards changed: %',signature;
  END IF;
  definition:=replace(definition,immutable_original,immutable_replacement);
  EXECUTE replace(definition,original,replacement);
 END LOOP;
END $migration$;
COMMIT;
