BEGIN;
-- [COMP:api/application-records] [COMP:security/native-field-policy]
-- Pure business-key codecs, private to canonical admission. No ACL is copied.
CREATE FUNCTION application_native_entity_attribute_values(attributes jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE entry record; custom record; output jsonb:='{}'; field text;
BEGIN
 IF jsonb_typeof(attributes) IS DISTINCT FROM 'object' THEN RETURN jsonb_build_object('attribute.attributes',attributes); END IF;
 FOR entry IN SELECT * FROM jsonb_each(attributes) LOOP
  IF entry.key='custom_fields' AND jsonb_typeof(entry.value)='object' THEN
   FOR custom IN SELECT * FROM jsonb_each(entry.value) LOOP output:=output||jsonb_build_object('custom.'||custom.key,custom.value); END LOOP;
  ELSE
   field:=CASE entry.key WHEN 'domain' THEN 'domain' WHEN 'email' THEN 'email' WHEN 'phone' THEN 'phone' WHEN 'tags' THEN 'tags'
    WHEN 'external_ref' THEN 'externalRef' WHEN 'company_id' THEN 'companyId' WHEN 'contact_id' THEN 'contactId'
    WHEN 'stage' THEN 'stage' WHEN 'amount' THEN 'amount' WHEN 'close_date' THEN 'closeDate' WHEN 'owner_id' THEN 'ownerId'
    WHEN 'currency_code' THEN 'currencyCode' WHEN 'source' THEN 'source' WHEN 'win_loss_reason' THEN 'winLossReason'
    WHEN 'archived_at' THEN 'archivedAt' ELSE 'attribute.'||entry.key END;
   output:=output||jsonb_build_object(field,entry.value);
  END IF;
 END LOOP;
 RETURN output;
END $$;
REVOKE ALL ON FUNCTION application_native_entity_attribute_values(jsonb) FROM PUBLIC;
CREATE FUNCTION application_native_entity_business_values(entity public.entities) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE output jsonb:=jsonb_build_object('name',entity.display_name)||public.application_native_entity_attribute_values(entity.attributes);
BEGIN
 IF entity.canonical_id IS NOT NULL THEN output:=output||jsonb_build_object('@canonicalId',entity.canonical_id); END IF;
 IF cardinality(entity.aliases)>0 THEN output:=output||jsonb_build_object('aliases',entity.aliases); END IF;
 RETURN output;
END $$;
REVOKE ALL ON FUNCTION application_native_entity_business_values(public.entities) FROM PUBLIC;

-- A restriction-only port. Missing/unowned records still need the canonical
-- writer's ordinary source predicate; true is never a row or mutation grant.
CREATE FUNCTION application_native_entity_field_writes_allowed(record_id uuid,patch jsonb,typed_fields text[] DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source record; required text[]; mask jsonb; field_origin jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 SELECT e.workspace_id,e.kind,e.scope_version INTO source FROM public.entities e WHERE e.id=record_id;
 IF NOT FOUND OR source.kind NOT IN('company','person','deal') OR NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners o
  WHERE o.workspace_id=source.workspace_id AND o.origin=field_origin AND o.resource_type=source.kind) THEN RETURN true; END IF;
 IF jsonb_typeof(patch) IS DISTINCT FROM 'object' OR typed_fields IS NOT NULL AND (cardinality(typed_fields)>128
   OR array_position(typed_fields,NULL) IS NOT NULL) THEN RETURN false; END IF;
 required:=coalesce(typed_fields,ARRAY(SELECT jsonb_object_keys(CASE WHEN patch ? 'attributes'
  THEN public.application_native_entity_attribute_values(patch->'attributes') ELSE '{}'::jsonb END)));
 IF patch ? 'displayName' THEN required:=required||'name'::text; END IF;
 IF patch ? 'canonicalId' THEN required:=required||CASE source.kind WHEN 'company' THEN 'domain' WHEN 'person' THEN 'email' ELSE 'canonicalId' END; END IF;
 required:=ARRAY(SELECT DISTINCT field FROM unnest(required) field ORDER BY field);
 IF cardinality(required)=0 THEN RETURN true; END IF;
 mask:=public.read_native_application_field_mask(source.workspace_id,field_origin,source.kind,record_id::text,source.scope_version::text);
 RETURN mask IS NOT NULL AND coalesce(to_jsonb(required)<@(mask->'writeFields'),false);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_entity_field_writes_allowed(uuid,jsonb,text[]) FROM PUBLIC;

CREATE FUNCTION application_guard_native_entity_fields() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE canonical public.entities; field_origin jsonb:='{"kind":"native","moduleKey":"native"}'; previous jsonb; proposed jsonb; changed text[]; intent jsonb;
 fields text[]; valid_intent boolean:=false; mask jsonb; field text;
BEGIN
 IF TG_OP='INSERT' THEN canonical:=NEW;ELSE canonical:=OLD;END IF;
 IF canonical.kind NOT IN('company','person','deal') OR NOT EXISTS(SELECT 1 FROM public.workspaces w WHERE w.id=canonical.workspace_id)
  OR NOT EXISTS(SELECT 1 FROM public.application_native_resource_owners o WHERE o.workspace_id=canonical.workspace_id AND o.origin=field_origin
   AND o.resource_type=canonical.kind) THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.kind<>OLD.kind) THEN
  RAISE EXCEPTION 'access_unavailable: immutable protected native identity' USING ERRCODE='42501'; END IF;
 previous:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE public.application_native_entity_business_values(OLD) END;
 proposed:=CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE public.application_native_entity_business_values(NEW) END;
 SELECT ARRAY(SELECT key FROM (SELECT jsonb_object_keys(previous) AS key UNION SELECT jsonb_object_keys(proposed)) keys
  WHERE previous->key IS DISTINCT FROM proposed->key ORDER BY key) INTO changed;
 intent:=nullif(current_setting('app.native_entity_write_intent',true),'')::jsonb;
 IF TG_OP='UPDATE' AND intent->>'workspaceId'=canonical.workspace_id::text AND intent->>'typeKey'=canonical.kind AND intent->>'id'=canonical.id::text THEN
  IF intent-ARRAY['workspaceId','typeKey','id','fields']<>'{}'::jsonb OR jsonb_typeof(intent->'fields') IS DISTINCT FROM 'array'
   OR jsonb_array_length(intent->'fields')>128 OR EXISTS(SELECT 1 FROM jsonb_array_elements(intent->'fields') value WHERE jsonb_typeof(value)<>'string') THEN
   RAISE EXCEPTION 'access_unavailable: invalid native write intent' USING ERRCODE='42501'; END IF;
  valid_intent:=true;changed:=changed||ARRAY(SELECT jsonb_array_elements_text(intent->'fields'));
 END IF;
 IF TG_OP='UPDATE' AND TG_ARGV[0]='attributes' AND NOT valid_intent THEN
  changed:=changed||ARRAY(SELECT jsonb_object_keys(public.application_native_entity_attribute_values(OLD.attributes))
   UNION SELECT jsonb_object_keys(public.application_native_entity_attribute_values(NEW.attributes)));
 END IF;
 IF TG_OP='UPDATE' AND TG_ARGV[0] IN('name','@canonicalId','aliases') THEN changed:=changed||TG_ARGV[0]; END IF;
 IF TG_OP='UPDATE' AND (OLD.valid_to IS NULL AND NEW.valid_to IS NOT NULL OR OLD.retracted_at IS NULL AND NEW.retracted_at IS NOT NULL) THEN
  changed:=changed||ARRAY(SELECT jsonb_object_keys(previous));
 END IF;
 fields:=ARRAY(SELECT DISTINCT CASE key WHEN '@canonicalId' THEN CASE canonical.kind WHEN 'company' THEN 'domain' WHEN 'person' THEN 'email' ELSE 'canonicalId' END
  ELSE key END FROM unnest(changed) key ORDER BY 1);
 IF cardinality(fields)=0 THEN IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END IF;
 IF TG_OP='INSERT' THEN
  mask:=public.read_native_application_field_catalog(canonical.workspace_id,field_origin,canonical.kind);
  IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'writeFields'),false) THEN
   RAISE EXCEPTION 'access_unavailable: native creation fields unavailable' USING ERRCODE='42501'; END IF;
 ELSIF public.application_native_entity_field_writes_allowed(canonical.id,'{}'::jsonb,fields) IS NOT TRUE THEN
  RAISE EXCEPTION 'access_unavailable: native write fields unavailable' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION application_guard_native_entity_fields() FROM PUBLIC;
CREATE TRIGGER application_native_entity_changed_fields BEFORE INSERT OR UPDATE OR DELETE ON public.entities
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_entity_fields('changed');
CREATE TRIGGER application_native_entity_attribute_fields BEFORE UPDATE OF attributes ON public.entities
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_entity_fields('attributes');
CREATE TRIGGER application_native_entity_name_field BEFORE UPDATE OF display_name ON public.entities
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_entity_fields('name');
CREATE TRIGGER application_native_entity_canonical_field BEFORE UPDATE OF canonical_id ON public.entities
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_entity_fields('@canonicalId');
CREATE TRIGGER application_native_entity_aliases_field BEFORE UPDATE OF aliases ON public.entities
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_entity_fields('aliases');
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION application_native_entity_field_writes_allowed(uuid,jsonb,text[]) TO app_user;
 END IF;
END $$;
COMMIT;
