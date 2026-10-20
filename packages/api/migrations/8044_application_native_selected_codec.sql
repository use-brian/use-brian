BEGIN;
-- [COMP:api/application-records] Pure selected codecs carry no policy or identity.
CREATE FUNCTION application_native_entity_values(p_type text,payload jsonb,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE attrs jsonb:=payload->'attributes';selected_attrs jsonb;selected_payload jsonb;values_json jsonb;custom_values jsonb;invalid_archive jsonb;
BEGIN
 IF payload IS NULL OR p_fields IS NULL OR p_type NOT IN('company','person','deal') THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_object_agg(raw_key,attrs->raw_key),'{}') INTO selected_attrs FROM (VALUES
  ('domain','domain'),('email','email'),('phone','phone'),('companyId','company_id'),('contactId','contact_id'),
  ('stage','stage'),('amount','amount'),('closeDate','close_date'),('pipelineId','pipeline_id'),('pipelineStageId','pipeline_stage_id'),
  ('currencyCode','currency_code'),('source','source'),('winLossReason','win_loss_reason'),('probability','probability'),
  ('tags','tags'),('externalRef','external_ref'),('ownerId','owner_id'),('archivedAt','crm_archived_at')
 ) slots(field_key,raw_key) WHERE field_key=ANY(p_fields) AND attrs ? raw_key;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO custom_values
  FROM jsonb_each(CASE WHEN jsonb_typeof(attrs->'custom_fields')='object' THEN attrs->'custom_fields' ELSE '{}' END)
  WHERE 'custom.'||key=ANY(p_fields);
 selected_attrs:=selected_attrs||jsonb_build_object('custom_fields',custom_values);
 -- Preserve an invalid selected historical value for typed review refusal before
 -- evaluation. Do not attempt its cast or turn it into a null/default.
 IF 'archivedAt'=ANY(p_fields) AND attrs ? 'crm_archived_at' AND attrs->'crm_archived_at'<>'null'::jsonb
  AND application_native_date_value_valid(attrs->'crm_archived_at',false) IS NOT TRUE THEN
  invalid_archive:=attrs->'crm_archived_at';selected_attrs:=selected_attrs-'crm_archived_at';
 END IF;
 selected_payload:=jsonb_build_object('attributes',selected_attrs,
  'display_name',CASE WHEN 'name'=ANY(p_fields) THEN payload->'display_name' END,
  'aliases',CASE WHEN 'aliases'=ANY(p_fields) THEN payload->'aliases' END,
  'canonical_id',CASE WHEN p_type='company' AND 'domain'=ANY(p_fields) OR p_type='person' AND 'email'=ANY(p_fields) THEN payload->'canonical_id' END,
  'created_at',CASE WHEN 'createdAt'=ANY(p_fields) THEN payload->'created_at' END,
  'updated_at',CASE WHEN 'updatedAt'=ANY(p_fields) THEN payload->'updated_at' END);
 values_json:=application_native_entity_values(p_type,selected_payload);
 IF invalid_archive IS NOT NULL THEN values_json:=values_json||jsonb_build_object('archivedAt',invalid_archive);END IF;
 RETURN (SELECT coalesce(jsonb_object_agg(key,value),'{}') FROM jsonb_each(values_json) WHERE key=ANY(p_fields));
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN
 RAISE EXCEPTION 'invalid_value: canonical native value requires review' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION application_native_entity_values(text,jsonb,text[]) FROM PUBLIC;
DO $migration$
DECLARE definition text;before text;
BEGIN
 SELECT pg_get_functiondef('public.application_native_projection(text,uuid,text,text[])'::regprocedure) INTO definition;
 before:=$source$required_fields text[] DEFAULT '{}'::text[]$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native selection default changed';END IF;
 definition:=replace(definition,before,'required_fields text[] DEFAULT NULL::text[]');
 before:='IF decision IS NULL THEN RETURN NULL; END IF;';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native selected authority changed';END IF;
 definition:=replace(definition,before,before||$source$
  IF required_fields IS NULL THEN required_fields:=ARRAY(SELECT jsonb_array_elements_text(decision->'read'));END IF;$source$);
 before:='application_native_entity_values(type_key,payload)';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native application codec changed';END IF;
 definition:=replace(definition,before,'application_native_entity_values(type_key,payload,required_fields)');
 before:=$source$AND decision->'read' ? ('custom.'||f.field_key)$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native custom selection changed';END IF;
 EXECUTE replace(definition,before,$source$AND ('custom.'||f.field_key)=ANY(required_fields)$source$);
 SELECT pg_get_functiondef('public.application_field_projection_state_before_module_policy(uuid,jsonb,text,uuid,text,text,text[])'::regprocedure) INTO definition;
 before:='values_json:=application_native_entity_values(p_type,native_row);';
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native member codec changed';END IF;
 EXECUTE replace(definition,before,'values_json:=application_native_entity_values(p_type,native_row,p_fields);');
END $migration$;
COMMIT;
