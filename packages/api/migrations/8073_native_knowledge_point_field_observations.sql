BEGIN;
-- [COMP:api/application-persistence] Current Knowledge ID fields and related identities.
-- Extend only the R3 native adapter; every original ancestry/envelope/source guard remains intact.
ALTER FUNCTION application_knowledge_field_state(uuid,uuid,text[]) RENAME TO application_knowledge_field_state_before_related_identities;
REVOKE ALL ON FUNCTION application_knowledge_field_state_before_related_identities(uuid,uuid,text[]) FROM PUBLIC;
CREATE FUNCTION application_knowledge_field_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE state jsonb;raw_ids jsonb;target_id uuid;target jsonb;identities jsonb:='[]';ids jsonb:='[]';references_json jsonb;
 before_policy jsonb;before_catalog jsonb;after_policy jsonb;after_catalog jsonb;
BEGIN
 before_policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',i::text);
 IF before_policy->>'registered'='true' THEN before_catalog:=application_native_field_catalog_for(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry');END IF;
 state:=application_knowledge_field_state_before_related_identities(w,i,fields);
 IF state IS NULL THEN RETURN NULL;END IF;
 IF before_policy->>'registered'='true' THEN
  after_policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',i::text);
  after_catalog:=application_native_field_catalog_for(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry');
  IF before_policy->>'held' IS DISTINCT FROM 'false' OR before_catalog->>'held' IS DISTINCT FROM 'false'
   OR after_policy->>'held' IS DISTINCT FROM 'false' OR after_catalog->>'held' IS DISTINCT FROM 'false'
   OR before_policy->'fingerprint' IS DISTINCT FROM after_policy->'fingerprint'
   OR before_catalog->'fingerprint' IS DISTINCT FROM after_catalog->'fingerprint' THEN RETURN NULL;END IF;
  -- The original field state above still checks every current selected mask.
  -- Its observation identifies stable rules, not another actor's unused rights.
  state:=state||jsonb_build_object('policyVersion',application_field_digest(jsonb_build_object('kind','knowledge-selected-fields-v2',
   'fields',fields,'catalog',after_catalog->'fingerprint','record',after_policy->'fingerprint')));
 END IF;
 IF NOT 'relatedIds'=ANY(fields) THEN RETURN state;END IF;
 raw_ids:=coalesce(nullif(state#>'{values,relatedIds}','null'::jsonb),'[]'::jsonb);
 IF jsonb_typeof(raw_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(raw_ids)>256
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(raw_ids) value WHERE jsonb_typeof(value)<>'string') THEN RETURN NULL;END IF;
 references_json:=state->'references';
 FOR target_id IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(raw_ids) value ORDER BY value::uuid LOOP
  -- An identity consumes only the target's ID, never its body or title.
  target:=application_knowledge_field_state(w,target_id,ARRAY['id']);
  IF target IS NULL THEN CONTINUE;END IF;
  ids:=ids||to_jsonb(target_id);
  identities:=identities||jsonb_build_array(jsonb_build_object('id',target_id,'version',target->'recordVersion','policy',target->'policyVersion','source',target->'source'));
  references_json:=references_json||jsonb_build_array(jsonb_build_object('origin','{"kind":"native","moduleKey":"native"}'::jsonb,
   'typeKey','knowledge_entry','id',target_id,'fields',jsonb_build_array('id')));
 END LOOP;
 IF jsonb_array_length(references_json)>256 THEN RETURN NULL;END IF;
 RETURN state||jsonb_build_object('values',(state->'values')||jsonb_build_object('relatedIds',ids),'references',references_json,
  'policyVersion',application_field_digest(jsonb_build_object('kind','knowledge-related-identities-v1','policy',state->'policyVersion','identities',identities)));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_knowledge_field_state(uuid,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION read_native_knowledge_point_projection(w uuid,i uuid,expected_version text,legacy_only boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE version text;fields text[];state jsonb;captured jsonb;native_sources jsonb;
BEGIN
 IF expected_version IS NULL OR legacy_only IS NULL THEN RETURN NULL;END IF;
 SELECT scope_version::text INTO version FROM knowledge_entries WHERE workspace_id=w AND id=i;
 IF NOT FOUND OR version IS DISTINCT FROM expected_version OR legacy_only AND EXISTS(
  SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='knowledge_entry' AND d.resource_id=i) THEN RETURN NULL;END IF;
 fields:=ARRAY(SELECT field FROM unnest(application_knowledge_field_keys()) field ORDER BY field);
 state:=application_knowledge_field_state(w,i,fields);
 IF state IS NULL OR state->>'recordVersion' IS DISTINCT FROM expected_version THEN RETURN NULL;END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','knowledge_entry',i,expected_version,'read',NULL,fields);
 IF captured IS NULL THEN RETURN NULL;END IF;
 -- These native pointers come from this capture's exact immutable admitted
 -- observations, including only target identities actually projected.
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO native_sources FROM (
  SELECT DISTINCT observation.source_scope||jsonb_build_object('resourceKind','knowledge_entry','resourceId',observation.source_id,'version',observation.source_version) AS value
  FROM jsonb_array_elements(captured->'sources') source
  JOIN application_field_observations observation ON observation.workspace_id=w AND observation.resource_id=(source->>'resourceId')::uuid AND observation.version=source->>'version'
  JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=observation.resource_id
  WHERE source->>'resourceKind'='application_field' AND observation.source_kind='knowledge_entry'
   AND resource.origin='{"kind":"native","moduleKey":"native"}' AND resource.type_key='knowledge_entry'
 ) observed;
 RETURN captured||jsonb_build_object('nativeSources',native_sources,'recordVersion',expected_version);
END $$;
REVOKE ALL ON FUNCTION read_native_knowledge_point_projection(uuid,uuid,text,boolean) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_native_knowledge_point_projection(uuid,uuid,text,boolean) TO app_user;
END IF;END $$;

-- Previously hidden point relations need a fresh current source decision too.
-- Metadata still supplies no rights; the original coordinator/validator owns use.
ALTER FUNCTION read_native_knowledge_query_cohort_sources(uuid,text[],uuid[],text[]) RENAME TO read_native_knowledge_query_cohort_sources_before_point_identities;
REVOKE ALL ON FUNCTION read_native_knowledge_query_cohort_sources_before_point_identities(uuid,text[],uuid[],text[]) FROM PUBLIC;
CREATE FUNCTION read_native_knowledge_query_cohort_sources(w uuid,kinds text[],ids uuid[],versions text[]) RETURNS TABLE(source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE nodes jsonb;parent record;target_id uuid;current_source jsonb;attempts integer:=0;
BEGIN
 RETURN QUERY SELECT * FROM read_native_knowledge_query_cohort_sources_before_point_identities(w,kinds,ids,versions);
 SELECT coalesce(jsonb_agg(to_jsonb(node)),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) node;
 FOR parent IN SELECT DISTINCT entry.id,entry.related_ids FROM jsonb_to_recordset(nodes) node(kind text,id uuid,version text)
  JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=node.id AND node.kind='application_field'
  JOIN application_field_observations observation ON observation.workspace_id=w AND observation.resource_id=resource.id AND observation.version=node.version
  JOIN knowledge_entries entry ON entry.workspace_id=w AND entry.id=resource.resource_id
  WHERE resource.origin='{"kind":"native","moduleKey":"native"}' AND resource.type_key='knowledge_entry'
   AND resource.selection IN('read','query','identity') AND 'relatedIds'=ANY(resource.fields) LOOP
  IF cardinality(parent.related_ids)>256 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
  FOR target_id IN SELECT DISTINCT id FROM unnest(parent.related_ids) id WHERE id IS NOT NULL ORDER BY id LOOP
   attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023';END IF;
   current_source:=read_scope_source(w,'knowledge_entry',target_id);
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN CONTINUE;END IF;
   source:=jsonb_build_object('workspaceId',w,'userId',current_source->'userId','assistantId',current_source->'assistantId',
    'sensitivity',current_source->'sensitivity','compartments',current_source->'compartments','projectIds',current_source->'projectIds',
    'resourceKind','knowledge_entry','resourceId',target_id,'version',current_source->'version');RETURN NEXT;
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_knowledge_query_cohort_sources(uuid,text[],uuid[],text[]) FROM PUBLIC;
COMMIT;
