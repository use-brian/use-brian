BEGIN;
-- [COMP:api/application-records] [COMP:security/native-field-policy]
-- A prospective restriction, never permission to insert a canonical source.
CREATE FUNCTION application_native_entity_creation_fields_allowed(w uuid,type_key text,fields text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field_origin jsonb:='{"kind":"native","moduleKey":"native"}';mask jsonb;
BEGIN
 IF type_key NOT IN('company','person','deal') OR fields IS NULL OR cardinality(fields)>128
  OR array_position(fields,NULL) IS NOT NULL THEN RETURN false;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners o
  WHERE o.workspace_id=w AND o.origin=field_origin AND o.resource_type=type_key) THEN RETURN true;END IF;
 mask:=public.read_native_application_field_catalog(w,field_origin,type_key);
 RETURN mask IS NOT NULL AND coalesce(to_jsonb(fields)<@(mask->'writeFields'),false);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_entity_creation_fields_allowed(uuid,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_guard_native_entity_creation_point() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE field_origin jsonb:='{"kind":"native","moduleKey":"native"}';fields text[];mask jsonb;
BEGIN
 IF NEW.kind NOT IN('company','person','deal') OR NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners o
  WHERE o.workspace_id=NEW.workspace_id AND o.origin=field_origin AND o.resource_type=NEW.kind) THEN RETURN NEW;END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id THEN
   RAISE EXCEPTION 'access_unavailable: immutable protected native destination' USING ERRCODE='42501';END IF;
  IF NEW.kind=OLD.kind THEN RETURN NEW;END IF;
 END IF;
 fields:=ARRAY(SELECT DISTINCT CASE field WHEN '@canonicalId' THEN CASE NEW.kind WHEN 'company' THEN 'domain' WHEN 'person' THEN 'email' ELSE 'canonicalId' END
  ELSE field END FROM jsonb_object_keys(public.application_native_entity_business_values(NEW)) field ORDER BY 1);
 mask:=public.read_native_application_field_mask(NEW.workspace_id,field_origin,NEW.kind,NEW.id::text,NEW.scope_version::text);
 IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'writeFields'),false) THEN
  RAISE EXCEPTION 'access_unavailable: actual native creation point fields unavailable' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_guard_native_entity_creation_point() FROM PUBLIC;
CREATE TRIGGER application_native_entity_creation_point AFTER INSERT OR UPDATE OF kind,workspace_id ON public.entities
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_entity_creation_point();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION application_native_entity_creation_fields_allowed(uuid,text,text[]) TO app_user;
 END IF;
END $$;
COMMIT;
