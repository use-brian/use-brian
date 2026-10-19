BEGIN;
-- [COMP:api/application-records] [COMP:security/native-field-policy]
-- Pure data codec: it reads no source, caches no allow and grants no authority.
CREATE FUNCTION application_merge_native_entity_attributes(current_attributes jsonb,proposed_attributes jsonb,fields text[])
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb:=current_attributes;field text;attribute_key text;custom_key text;custom_values jsonb;
BEGIN
 IF jsonb_typeof(current_attributes) IS DISTINCT FROM 'object' OR jsonb_typeof(proposed_attributes) IS DISTINCT FROM 'object'
  OR fields IS NULL OR cardinality(fields)>128 OR array_position(fields,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'invalid_value: invalid native partial attributes' USING ERRCODE='22023';END IF;
 FOR field IN SELECT DISTINCT unnest(fields) LOOP
  IF length(field) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid_value: invalid native partial key' USING ERRCODE='22023';END IF;
  IF field IN('name','canonicalId','aliases') THEN CONTINUE;END IF;
  IF starts_with(field,'custom.') THEN
   custom_key:=substring(field FROM 8);
   IF length(custom_key)=0 OR custom_key IN('__proto__','prototype','constructor') THEN
    RAISE EXCEPTION 'invalid_value: invalid native custom key' USING ERRCODE='22023';END IF;
   custom_values:=CASE WHEN jsonb_typeof(result->'custom_fields')='object' THEN result->'custom_fields' ELSE '{}'::jsonb END;
   IF proposed_attributes->'custom_fields' ? custom_key THEN custom_values:=jsonb_set(custom_values,ARRAY[custom_key],proposed_attributes->'custom_fields'->custom_key,true);
   ELSE custom_values:=custom_values-custom_key;END IF;
   result:=jsonb_set(result,'{custom_fields}',custom_values,true);CONTINUE;
  END IF;
  attribute_key:=CASE field WHEN 'domain' THEN 'domain' WHEN 'email' THEN 'email' WHEN 'phone' THEN 'phone' WHEN 'tags' THEN 'tags'
   WHEN 'externalRef' THEN 'external_ref' WHEN 'companyId' THEN 'company_id' WHEN 'contactId' THEN 'contact_id' WHEN 'stage' THEN 'stage'
   WHEN 'amount' THEN 'amount' WHEN 'closeDate' THEN 'close_date' WHEN 'ownerId' THEN 'owner_id' WHEN 'currencyCode' THEN 'currency_code'
   WHEN 'source' THEN 'source' WHEN 'winLossReason' THEN 'win_loss_reason' WHEN 'archivedAt' THEN 'crm_archived_at'
   WHEN 'pipelineId' THEN 'pipeline_id' WHEN 'pipelineStageId' THEN 'pipeline_stage_id' WHEN 'probability' THEN 'probability'
   ELSE CASE WHEN starts_with(field,'attribute.') THEN substring(field FROM 11) ELSE NULL END END;
  IF attribute_key IS NULL OR length(attribute_key)=0 OR attribute_key IN('__proto__','prototype','constructor','custom_fields') THEN
   RAISE EXCEPTION 'invalid_value: undeclared native partial key' USING ERRCODE='22023';END IF;
  IF proposed_attributes ? attribute_key THEN result:=jsonb_set(result,ARRAY[attribute_key],proposed_attributes->attribute_key,true);
  ELSE result:=result-attribute_key;END IF;
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION application_merge_native_entity_attributes(jsonb,jsonb,text[]) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION application_merge_native_entity_attributes(jsonb,jsonb,text[]) TO app_user;
 END IF;
END $$;
COMMIT;
