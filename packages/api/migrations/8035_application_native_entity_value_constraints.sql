BEGIN;
-- [COMP:api/application-records] [COMP:crm/entity-invariants]
-- Private pure value codecs; neither caller identity nor source data is granted.
CREATE FUNCTION application_native_date_value_valid(value jsonb,day_only boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE text_value text:=value#>>'{}';
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN RETURN false;END IF;
 IF day_only THEN
  RETURN text_value ~ '^\d{4}-\d{2}-\d{2}$' AND substring(text_value FROM 1 FOR 4)::int>=100
   AND to_char(text_value::date,'YYYY-MM-DD')=text_value;
 END IF;
 IF text_value !~ '^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2}))?$' THEN RETURN false;END IF;
 PERFORM text_value::timestamptz;RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_date_value_valid(jsonb,boolean) FROM PUBLIC;
CREATE FUNCTION application_native_decimal_value_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE text_value text:=value#>>'{}';
BEGIN
 RETURN jsonb_typeof(value) IN('number','string') AND length(text_value)<=96
  AND text_value ~ '^-?(0|[1-9]\d*)(\.\d{1,18})?$' AND text_value::numeric>=0;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_decimal_value_valid(jsonb) FROM PUBLIC;
CREATE FUNCTION application_native_custom_value_valid(field_type text,options jsonb,required boolean,value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF value IS NULL OR value='null'::jsonb OR value='""'::jsonb THEN RETURN NOT required;END IF;
 CASE field_type
 WHEN 'text' THEN RETURN jsonb_typeof(value)='string' AND length(value#>>'{}')<=10000;
 WHEN 'number' THEN RETURN jsonb_typeof(value)='number' AND abs((value#>>'{}')::numeric)<=1.7976931348623157e308::numeric;
 WHEN 'date' THEN RETURN public.application_native_date_value_valid(value,true);
 WHEN 'boolean' THEN RETURN jsonb_typeof(value)='boolean';
 WHEN 'single_select' THEN RETURN jsonb_typeof(value)='string' AND options ? (value#>>'{}');
 WHEN 'multi_select' THEN
  IF jsonb_typeof(value)<>'array' THEN RETURN false;END IF;
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value) element WHERE jsonb_typeof(element)<>'string' OR NOT options ? (element#>>'{}'));
 WHEN 'entity_reference' THEN RETURN jsonb_typeof(value)='string' AND (value#>>'{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
 ELSE RETURN false;
 END CASE;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION application_native_custom_value_valid(text,jsonb,boolean,jsonb) FROM PUBLIC;

CREATE FUNCTION application_guard_native_entity_values() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE attributes jsonb:=NEW.attributes; value jsonb; field text; maximum int; definition record; custom_values jsonb;
 old_custom jsonb:='{}';old_value jsonb;custom_key text;known boolean;
BEGIN
 IF NEW.kind NOT IN('company','person','deal') THEN RETURN NEW;END IF;
 IF jsonb_typeof(attributes) IS DISTINCT FROM 'object' OR length(btrim(NEW.display_name))=0
  OR length(NEW.display_name)>(CASE WHEN NEW.kind='person' AND attributes->'self'='true'::jsonb THEN 8192 ELSE 256 END) THEN
  RAISE EXCEPTION 'invalid_value: invalid canonical native record shape' USING ERRCODE='22023';END IF;
 FOR field,maximum IN SELECT * FROM (VALUES ('domain',320),('email',320),('phone',100),('source',100),('win_loss_reason',2000)) constraints(key,limit_value) LOOP
  value:=attributes->field;
  IF value IS NOT NULL AND value<>'null'::jsonb AND (jsonb_typeof(value)<>'string' OR length(value#>>'{}')>maximum) THEN
   RAISE EXCEPTION 'invalid_value: invalid canonical native text slot' USING ERRCODE='22023';END IF;
 END LOOP;
 value:=attributes->'tags';
 IF value IS NOT NULL AND (jsonb_typeof(value) IS DISTINCT FROM 'array') THEN
  RAISE EXCEPTION 'invalid_value: invalid canonical native tags' USING ERRCODE='22023';END IF;
 IF value IS NOT NULL AND (jsonb_array_length(value)>64 OR EXISTS(SELECT 1 FROM jsonb_array_elements(value) element
   WHERE jsonb_typeof(element)<>'string' OR length(element#>>'{}')>100)) THEN
  RAISE EXCEPTION 'invalid_value: invalid canonical native tags' USING ERRCODE='22023';END IF;
 IF attributes ? 'external_ref' AND jsonb_typeof(attributes->'external_ref') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'invalid_value: invalid canonical native external reference' USING ERRCODE='22023';END IF;
 FOR field IN SELECT unnest(ARRAY['company_id','contact_id','owner_id','pipeline_id','pipeline_stage_id']) LOOP
  value:=attributes->field;
  IF value IS NOT NULL AND value<>'null'::jsonb AND (jsonb_typeof(value)<>'string'
    OR (value#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
   RAISE EXCEPTION 'invalid_value: invalid canonical native reference ID' USING ERRCODE='22023';END IF;
 END LOOP;
 IF NEW.kind='deal' THEN
  value:=attributes->'stage';
  IF value IS NOT NULL AND (jsonb_typeof(value) IS DISTINCT FROM 'string' OR (value#>>'{}') NOT IN('lead','qualified','proposal','negotiation','won','lost')) THEN
   RAISE EXCEPTION 'invalid_value: invalid canonical deal stage' USING ERRCODE='22023';END IF;
  value:=attributes->'amount';
  IF value IS NOT NULL AND value<>'null'::jsonb AND public.application_native_decimal_value_valid(value) IS NOT TRUE THEN
   RAISE EXCEPTION 'invalid_value: invalid canonical deal amount' USING ERRCODE='22023';END IF;
  value:=attributes->'currency_code';
  IF value IS NOT NULL AND value<>'null'::jsonb AND (jsonb_typeof(value)<>'string' OR (value#>>'{}') !~ '^[A-Z]{3}$') THEN
   RAISE EXCEPTION 'invalid_value: invalid canonical deal currency' USING ERRCODE='22023';END IF;
  value:=attributes->'probability';
  IF value IS NOT NULL AND value<>'null'::jsonb THEN
   IF jsonb_typeof(value)<>'number' THEN RAISE EXCEPTION 'invalid_value: invalid canonical probability' USING ERRCODE='22023';END IF;
   IF (value#>>'{}')::numeric NOT BETWEEN 0 AND 100 THEN RAISE EXCEPTION 'invalid_value: invalid canonical probability' USING ERRCODE='22023';END IF;
  END IF;
 END IF;
 FOR field IN SELECT unnest(ARRAY['close_date','crm_archived_at']) LOOP
  value:=attributes->field;
  IF value IS NOT NULL AND value<>'null'::jsonb AND public.application_native_date_value_valid(value,false) IS NOT TRUE THEN
   RAISE EXCEPTION 'invalid_value: invalid canonical native date' USING ERRCODE='22023';END IF;
 END LOOP;
 custom_values:=coalesce(attributes->'custom_fields','{}');
 IF jsonb_typeof(custom_values) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'invalid_value: invalid canonical custom field map' USING ERRCODE='22023';END IF;
 IF TG_OP='UPDATE' THEN old_custom:=CASE WHEN jsonb_typeof(OLD.attributes->'custom_fields')='object' THEN OLD.attributes->'custom_fields' ELSE '{}'::jsonb END;END IF;
 -- Hold the actual vocabulary while a canonical mutation validates it.
 PERFORM id FROM public.crm_field_definitions WHERE workspace_id=NEW.workspace_id AND entity_kind=NEW.kind ORDER BY id FOR SHARE;
 FOR custom_key IN SELECT key FROM (SELECT jsonb_object_keys(custom_values) AS key UNION SELECT jsonb_object_keys(old_custom)) keys LOOP
  SELECT * INTO definition FROM public.crm_field_definitions WHERE workspace_id=NEW.workspace_id AND entity_kind=NEW.kind AND field_key=custom_key;
  known:=FOUND;
  value:=custom_values->custom_key;old_value:=old_custom->custom_key;
  IF NEW.kind='person' AND custom_key IN('organisation_name','position','mailing_address') THEN
   IF value IS NOT NULL AND value<>'null'::jsonb AND (jsonb_typeof(value)<>'string'
    OR length(value#>>'{}')>(CASE WHEN custom_key='mailing_address' THEN 600 ELSE 200 END)) THEN
    RAISE EXCEPTION 'invalid_value: invalid canonical person profile slot' USING ERRCODE='22023';END IF;
   IF NOT known THEN CONTINUE;END IF;
  ELSIF NOT known THEN RAISE EXCEPTION 'invalid_value: unknown canonical custom field' USING ERRCODE='22023';END IF;
  IF definition.archived_at IS NOT NULL THEN
   IF value IS DISTINCT FROM old_value THEN RAISE EXCEPTION 'invalid_value: archived canonical custom field is immutable' USING ERRCODE='22023';END IF;
  ELSIF public.application_native_custom_value_valid(definition.field_type,definition.options,definition.is_required,value) IS NOT TRUE THEN
   RAISE EXCEPTION 'invalid_value: invalid canonical custom field value' USING ERRCODE='22023';END IF;
 END LOOP;
 FOR definition IN SELECT * FROM public.crm_field_definitions WHERE workspace_id=NEW.workspace_id AND entity_kind=NEW.kind
  AND archived_at IS NULL AND is_required LOOP
  IF public.application_native_custom_value_valid(definition.field_type,definition.options,true,custom_values->definition.field_key) IS NOT TRUE THEN
   RAISE EXCEPTION 'invalid_value: required canonical custom field is missing' USING ERRCODE='22023';END IF;
 END LOOP;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION application_guard_native_entity_values() FROM PUBLIC;
CREATE TRIGGER application_native_entity_values BEFORE INSERT OR UPDATE OF attributes,display_name,kind,workspace_id ON public.entities
 FOR EACH ROW EXECUTE FUNCTION application_guard_native_entity_values();
COMMIT;
