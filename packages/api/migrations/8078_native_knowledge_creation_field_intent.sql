BEGIN;
-- [COMP:api/application-persistence] Current typed destination field intent.
-- Admission is a restriction in the original retained transaction, not a token.
CREATE FUNCTION native_knowledge_creation_fields_allowed(w uuid,fields text[],i uuid DEFAULT NULL,v text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;mask jsonb;output knowledge_entries;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF fields IS NULL OR NOT ARRAY['path','title','content']::text[]<@fields
  OR NOT fields<@ARRAY['path','title','content','summary','tags','metadata']::text[]
  OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR (i IS NULL) IS DISTINCT FROM (v IS NULL)
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL OR current_setting('app.system_bypass',true)='true'
  OR nullif(current_setting('app.agent_actor_id',true),'') IS DISTINCT FROM actor::text THEN RETURN false;END IF;
 -- Delegates current member/actor, catalog, bounds and the closed physical schema.
 context:=application_knowledge_query_context(w);
 IF context IS NULL THEN RETURN false;END IF;
 IF context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN
  mask:=read_native_application_field_catalog(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry');
  IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'writeFields'),false) THEN RETURN false;END IF;
 END IF;
 IF i IS NOT NULL THEN
  SELECT k.* INTO output FROM knowledge_entries k WHERE k.workspace_id=w AND k.id=i AND k.scope_version::text=v
   AND k.xmin::text::bigint=(pg_current_xact_id()::text::numeric % 4294967296)::bigint FOR UPDATE;
  IF NOT FOUND OR output.created_by IS DISTINCT FROM actor OR output.scope_held OR output.source_id IS NOT NULL OR output.source_sha IS NOT NULL
   OR member_operation_scope_allows(w,output.sensitivity,output.compartments,true) IS NOT TRUE
   OR agent_mutation_scope_allows(output.compartments) IS NOT TRUE
   OR agent_read_scope_allows(output.sensitivity,output.compartments,output.project_ids) IS NOT TRUE THEN RETURN false;END IF;
  IF context#>>'{policy,nativeDefault}' IS DISTINCT FROM 'true' THEN
   mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',i::text,v);
   IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'writeFields'),false) THEN RETURN false;END IF;
  END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range
 OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION native_knowledge_creation_fields_allowed(uuid,text[],uuid,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION native_knowledge_creation_fields_allowed(uuid,text[],uuid,text) TO app_user;
END IF;END $$;
COMMIT;
