BEGIN;
-- [COMP:api/application-persistence] Retained native Memory relationship links.
-- Clone the current restricted lineage validator, changing only its output to a
-- fresh actor-owned Memory-to-Memory edge. Existing functions/ACLs stay private.
DO $link_lineage$
DECLARE definition text;before text;after text;
BEGIN
 definition:=pg_get_functiondef('public.record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'::regprocedure);
 before:='record_admitted_application_field_derivation(w uuid, k text, i uuid, v text, producer text, sources jsonb)';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory link clone signature changed';END IF;
 definition:=replace(definition,before,'record_admitted_memory_link_derivation(w uuid, i uuid, v text, producer text, sources jsonb)');
 before:='DECLARE actor uuid:=';after:='DECLARE k constant text:=''entity_link'';actor uuid:=';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory link clone declaration changed';END IF;
 definition:=replace(definition,before,after);
 before:='output memories;';after:='output entity_links;';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory link clone output changed';END IF;
 definition:=replace(definition,before,after);
 before:='k<>''memory''';after:='k<>''entity_link''';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory link clone kind changed';END IF;
 definition:=replace(definition,before,after);
 before:='INTO output FROM memories m';after:='INTO output FROM entity_links m';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory link clone table changed';END IF;
 definition:=replace(definition,before,after);
 before:='output.created_by_user_id IS DISTINCT FROM actor';
 after:=$after$output.user_id IS DISTINCT FROM actor OR output.assistant_id IS DISTINCT FROM acting
  OR acting IS NULL OR output.source_kind<>'memory' OR output.target_kind<>'memory'
  OR output.source_episode_id IS NOT NULL OR output.created_at IS DISTINCT FROM transaction_timestamp()
  OR EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='entity_link' AND d.resource_id=i)
  OR EXISTS(SELECT 1 FROM unnest(ARRAY[output.source_id,output.target_id]) endpoint(id) WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(sources) root
    JOIN memories m ON m.workspace_id=w AND m.id=endpoint.id
   WHERE root->>'resourceKind'='memory' AND root->>'resourceId'=endpoint.id::text AND root->>'version'=m.scope_version::text
    AND m.valid_to IS NULL AND m.retracted_at IS NULL AND NOT m.scope_held
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(sources) field
      JOIN application_field_resources r ON r.workspace_id=w AND r.id=(field->>'resourceId')::uuid
      JOIN application_field_observations o ON o.workspace_id=w AND o.resource_id=r.id AND o.version=field->>'version'
     WHERE field->>'resourceKind'='application_field' AND r.origin='{"kind":"native","moduleKey":"native"}'::jsonb
      AND r.type_key='memory' AND r.resource_id=endpoint.id AND r.selection='read'
      AND r.fields@>application_memory_field_keys() AND application_memory_field_keys()@>r.fields
      AND o.source_kind='memory' AND o.source_id=endpoint.id AND o.source_version=m.scope_version::text)))$after$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Memory link clone authorship changed';END IF;
 definition:=replace(definition,before,after);
 EXECUTE definition;
END $link_lineage$;
REVOKE ALL ON FUNCTION record_admitted_memory_link_derivation(uuid,uuid,text,text,jsonb) FROM PUBLIC;

-- This wrapper only imposes the existing canonical ancestry restriction. It does
-- not admit row labels, endpoints or payload, and keeps the canonical evaluator private.
CREATE FUNCTION memory_link_current_ancestry_allows(w uuid,i uuid,v text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN application_canonical_ancestry_allowed(w,'entity_link',i,v);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION memory_link_current_ancestry_allows(uuid,uuid,text) FROM PUBLIC;
CREATE POLICY application_memory_link_ancestry_floor ON entity_links AS RESTRICTIVE FOR SELECT
 USING(memory_link_current_ancestry_allows(workspace_id,id,scope_version::text));
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION record_admitted_memory_link_derivation(uuid,uuid,text,text,jsonb),memory_link_current_ancestry_allows(uuid,uuid,text) TO app_user;
END IF;END $$;
COMMIT;
