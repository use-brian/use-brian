BEGIN;
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_native_field_dictionary_valid(jsonb,jsonb,text[])'::regprocedure) IS DISTINCT FROM '24ca06ca4b2c010555a22bd4a86ced264eb8330fa777310d1da1f38313c6b6a7' THEN RAISE EXCEPTION 'Canonical field metadata prerequisite changed';END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_native_intersect_field_catalog(jsonb,jsonb,text[])'::regprocedure) IS DISTINCT FROM '5d12a15fa5a714c96580e013b1873cc7e0fd565f752f82a0ea238f9468dd8efc' THEN RAISE EXCEPTION 'Canonical field metadata prerequisite changed';END IF;
END $$;
-- [COMP:security/native-field-policy] Pure metadata computation only, no admission cache.
ALTER FUNCTION application_native_field_dictionary_valid(jsonb,jsonb,text[]) RENAME TO application_native_field_dictionary_before_simple_rules;
REVOKE ALL ON FUNCTION application_native_field_dictionary_before_simple_rules(jsonb,jsonb,text[]) FROM PUBLIC;
CREATE FUNCTION application_native_field_dictionary_valid(keys jsonb,fields jsonb,roles text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF jsonb_typeof(keys) IS DISTINCT FROM 'array' OR jsonb_typeof(fields) IS DISTINCT FROM 'array' THEN
  RETURN application_native_field_dictionary_before_simple_rules(keys,fields,roles);END IF;
 IF jsonb_array_length(keys)<=128 AND jsonb_array_length(keys)=jsonb_array_length(fields)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(keys) item WHERE jsonb_typeof(item)<>'string'
   OR length(item#>>'{}') NOT BETWEEN 1 AND 128 OR item#>>'{}'=ANY(ARRAY['__proto__','prototype','constructor']))
  AND (SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(keys))
  AND (SELECT count(*)=count(DISTINCT value->>'key') FROM jsonb_array_elements(fields))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) field
   WHERE jsonb_typeof(field) IS DISTINCT FROM 'object' OR NOT field ?& ARRAY['key','read','write','releaseReadTo','releaseWriteTo']
    OR field-ARRAY['key','read','write','releaseReadTo','releaseWriteTo']<>'{}'::jsonb
    OR jsonb_typeof(field->'key') IS DISTINCT FROM 'string' OR NOT keys ? (field->>'key')
    OR application_native_field_rule_valid(field->'read',roles) IS NOT TRUE
    OR application_native_field_rule_valid(field->'write',roles) IS NOT TRUE)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) field
   CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(field->'releaseReadTo',field->'releaseWriteTo')) profile
   WHERE jsonb_typeof(profile) IS DISTINCT FROM 'array' OR jsonb_array_length(profile)>2
    OR NOT profile<@'["external_user","service"]'::jsonb
    OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(profile))) THEN RETURN true;END IF;
 RETURN application_native_field_dictionary_before_simple_rules(keys,fields,roles);
EXCEPTION WHEN invalid_parameter_value THEN
 RETURN application_native_field_dictionary_before_simple_rules(keys,fields,roles);
END $$;
REVOKE ALL ON FUNCTION application_native_field_dictionary_valid(jsonb,jsonb,text[]) FROM PUBLIC;

ALTER FUNCTION application_native_intersect_field_catalog(jsonb,jsonb,text[]) RENAME TO application_native_intersect_catalog_before_simple_rules;
REVOKE ALL ON FUNCTION application_native_intersect_catalog_before_simple_rules(jsonb,jsonb,text[]) FROM PUBLIC;
CREATE FUNCTION application_native_intersect_field_catalog(record_fields jsonb,catalog_fields jsonb,roles text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE keys jsonb;result jsonb;
BEGIN
 IF record_fields IS NOT DISTINCT FROM catalog_fields AND jsonb_typeof(record_fields)='array' THEN
  SELECT coalesce(jsonb_agg(field->'key' ORDER BY field->>'key'),'[]') INTO keys FROM jsonb_array_elements(record_fields) field;
  IF application_native_field_dictionary_valid(keys,record_fields,roles) IS TRUE THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('key',field->'key',
    'read',(SELECT coalesce(jsonb_agg(DISTINCT normalized ORDER BY normalized),'[]') FROM (
      SELECT coalesce((SELECT jsonb_agg(value ORDER BY value) FROM jsonb_array_elements(clause)),'[]') normalized
      FROM jsonb_array_elements(field->'read') clause) rules),
    'write',(SELECT coalesce(jsonb_agg(DISTINCT normalized ORDER BY normalized),'[]') FROM (
      SELECT coalesce((SELECT jsonb_agg(value ORDER BY value) FROM jsonb_array_elements(clause)),'[]') normalized
      FROM jsonb_array_elements(field->'write') clause) rules),
    'releaseReadTo',(SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM jsonb_array_elements(field->'releaseReadTo')),
    'releaseWriteTo',(SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') FROM jsonb_array_elements(field->'releaseWriteTo'))) ORDER BY field->>'key'),'[]')
    INTO result FROM jsonb_array_elements(record_fields) field;
   RETURN result;
  END IF;
 END IF;
 RETURN application_native_intersect_catalog_before_simple_rules(record_fields,catalog_fields,roles);
EXCEPTION WHEN invalid_parameter_value THEN
 RETURN application_native_intersect_catalog_before_simple_rules(record_fields,catalog_fields,roles);
END $$;
REVOKE ALL ON FUNCTION application_native_intersect_field_catalog(jsonb,jsonb,text[]) FROM PUBLIC;
COMMIT;
