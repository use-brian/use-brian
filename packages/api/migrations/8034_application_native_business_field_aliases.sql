BEGIN;
-- [COMP:api/application-records] Pure canonical business-key codec; no authority.
CREATE OR REPLACE FUNCTION application_native_entity_attribute_values(attributes jsonb) RETURNS jsonb
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
    WHEN 'crm_archived_at' THEN 'archivedAt' WHEN 'pipeline_id' THEN 'pipelineId' WHEN 'pipeline_stage_id' THEN 'pipelineStageId'
    WHEN 'probability' THEN 'probability' ELSE 'attribute.'||entry.key END;
   output:=output||jsonb_build_object(field,entry.value);
  END IF;
 END LOOP;
 RETURN output;
END $$;
REVOKE ALL ON FUNCTION application_native_entity_attribute_values(jsonb) FROM PUBLIC;
COMMIT;
