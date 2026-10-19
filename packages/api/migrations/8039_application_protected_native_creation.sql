BEGIN;
-- [COMP:api/application-records] Current canonical policy before and after native insertion.
CREATE FUNCTION application_native_create_allows(type_key text,record_id uuid,owner_id uuid,tier text,teams text[],projects uuid[],fields text[],prospective_data jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; decision jsonb; command_decision jsonb; command_key text; w uuid;
BEGIN
 context:=application_current_maxima();command_key:=nullif(current_setting('app.application_command_key',true),'');
 IF context IS NULL OR context->>'readOnly'='true' OR type_key NOT IN('company','person','deal','task') OR command_key IS NULL
  OR fields IS NULL OR cardinality(fields)>128 OR array_position(fields,NULL) IS NOT NULL
  OR NOT agent_mutation_scope_allows(teams) THEN RETURN false;END IF;
 w:=(context->>'workspaceId')::uuid;
 decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}',type_key,record_id::text,owner_id,tier,teams,projects,NULL,'create',prospective_data);
 command_decision:=application_resource_fields(w,'{"kind":"native","moduleKey":"native"}',type_key,record_id::text,owner_id,tier,teams,projects,NULL,'command:'||command_key,prospective_data);
 RETURN coalesce(decision IS NOT NULL AND command_decision IS NOT NULL
  AND to_jsonb(fields)<@(decision->'write') AND to_jsonb(fields)<@(command_decision->'write'),false);
END $$;
REVOKE ALL ON FUNCTION application_native_create_allows(text,uuid,uuid,text,text[],uuid[],text[],jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION application_native_create_allows(type_key text,record_id uuid,owner_id uuid,tier text,teams text[],projects uuid[],fields text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT application_native_create_allows(type_key,record_id,owner_id,tier,teams,projects,fields,NULL::jsonb);
$$;
REVOKE ALL ON FUNCTION application_native_create_allows(text,uuid,uuid,text,text[],uuid[],text[]) FROM PUBLIC;
CREATE OR REPLACE FUNCTION application_native_creation_admitted(type_key text,tier text,teams text[],projects uuid[],fields text[]) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT application_native_create_allows(type_key,gen_random_uuid(),nullif(current_setting('app.current_user_id',true),'')::uuid,tier,teams,projects,fields,'{}'::jsonb);
$$;
REVOKE ALL ON FUNCTION application_native_creation_admitted(text,text,text[],uuid[],text[]) FROM PUBLIC;

DO $migration$
DECLARE definition text; before text;
BEGIN
 SELECT pg_get_functiondef('public.application_create_canonical_crm_entity(jsonb)'::regprocedure) INTO definition;
 before:='public.application_native_create_allows(type_key,record_id,actor,tier,teams,projects,fields)';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical CRM creation source changed';END IF;
 definition:=replace(definition,before,$source$public.application_native_create_allows(type_key,record_id,actor,tier,teams,projects,fields,'{}'::jsonb)$source$);
 before:=$source$teams:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'compartments','[]')));$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Canonical implicit defaults source changed';END IF;
 definition:=replace(definition,before,$source$-- The fixed commands do not accept tags. Their legacy constant [] is a read default, not a caller write.
 attributes:=attributes-'tags';
 teams:=ARRAY(SELECT jsonb_array_elements_text(coalesce(params->'compartments','[]')));$source$);
 EXECUTE definition;
 -- Preserve native field admission. A bound app uses the same canonical current
 -- layered helper with actual destination scope, then the actual post-insert point.
 SELECT pg_get_functiondef('public.application_guard_native_entity_fields()'::regprocedure) INTO definition;
 before:=$source$mask:=public.read_native_application_field_catalog(canonical.workspace_id,field_origin,canonical.kind);
  IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'writeFields'),false) THEN
   RAISE EXCEPTION 'access_unavailable: native creation fields unavailable' USING ERRCODE='42501'; END IF;$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native pre-insert field guard source changed';END IF;
 definition:=replace(definition,before,$source$IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
   IF public.application_current_maxima()->>'workspaceId' IS DISTINCT FROM canonical.workspace_id::text
    OR public.application_native_create_allows(canonical.kind,canonical.id,canonical.created_by_user_id,canonical.sensitivity,
     canonical.compartments,canonical.project_ids,fields,'{}'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'access_unavailable: application native creation fields unavailable' USING ERRCODE='42501';END IF;
  ELSE
   mask:=public.read_native_application_field_catalog(canonical.workspace_id,field_origin,canonical.kind);
   IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'writeFields'),false) THEN
    RAISE EXCEPTION 'access_unavailable: native creation fields unavailable' USING ERRCODE='42501';END IF;
  END IF;$source$);
 EXECUTE definition;
 SELECT pg_get_functiondef('public.application_guard_native_entity_creation_point()'::regprocedure) INTO definition;
 before:=$source$mask:=public.read_native_application_field_mask(NEW.workspace_id,field_origin,NEW.kind,NEW.id::text,NEW.scope_version::text);
 IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'writeFields'),false) THEN
  RAISE EXCEPTION 'access_unavailable: actual native creation point fields unavailable' USING ERRCODE='42501';END IF;$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Actual native creation point guard source changed';END IF;
 definition:=replace(definition,before,$source$IF nullif(current_setting('app.application_id',true),'') IS NOT NULL THEN
  IF public.application_current_maxima()->>'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
   OR public.application_native_create_allows(NEW.kind,NEW.id,NEW.created_by_user_id,NEW.sensitivity,NEW.compartments,NEW.project_ids,fields) IS NOT TRUE THEN
   RAISE EXCEPTION 'access_unavailable: actual application native creation point fields unavailable' USING ERRCODE='42501';END IF;
 ELSE
  mask:=public.read_native_application_field_mask(NEW.workspace_id,field_origin,NEW.kind,NEW.id::text,NEW.scope_version::text);
  IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'writeFields'),false) THEN
   RAISE EXCEPTION 'access_unavailable: actual native creation point fields unavailable' USING ERRCODE='42501';END IF;
 END IF;$source$);
 EXECUTE definition;
END $migration$;
COMMIT;
