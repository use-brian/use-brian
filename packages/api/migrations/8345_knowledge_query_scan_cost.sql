BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

-- [COMP:api/application-persistence] Verify the released reader before replacing its computation.
DO $knowledge_reader$
BEGIN
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('public.application_knowledge_field_state(uuid,uuid,text[])','19856801ae0d51de9fdc43f4b3380356558f2d74fd5d11683dda9de1710b80a6'),
   ('public.application_knowledge_field_state_before_version_evidence(uuid,uuid,text[])','222bf2bf7203342639c318a25f6c339723d1ebdf1c34a53e2e054822f253e449'),
   ('public.application_knowledge_field_state_before_related_identities(uuid,uuid,text[])','f05492b3184c64bb3effbc20a55bfc49119b5197d87073d0f04699ba700fc265'),
   ('public.application_knowledge_query_scan(uuid,text[],jsonb,boolean,jsonb)','8c1834353899500f84a03db8f99e22903119acf1891df370bd221e05a99734ad')
  ) expected(signature,body_sha)
  LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected.body_sha
 ) THEN RAISE EXCEPTION 'knowledge_query_scan_predecessor_changed'; END IF;
END $knowledge_reader$;

CREATE FUNCTION public.application_knowledge_admitted_fields(w uuid,i uuid,fields text[],context jsonb,include_values boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 origin constant jsonb:='{"kind":"native","moduleKey":"native"}';
 row_version text;
 source jsonb;
 policy jsonb;
 mask jsonb;
 before_policy jsonb;
 before_catalog jsonb;
 after_policy jsonb;
 after_catalog jsonb;
 values_json jsonb:='{}';
 policy_version text;
 raw_ids jsonb;
BEGIN
 IF fields IS NULL OR NOT fields<@application_knowledge_field_keys() OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT field) FROM unnest(fields) field)
  OR context IS NULL OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RETURN NULL; END IF;

 SELECT scope_version::text INTO row_version FROM knowledge_entries WHERE workspace_id=w AND id=i;
 IF NOT FOUND OR knowledge_current_evidence_state(w,i,row_version)->>'current' IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
 before_policy:=application_native_field_contract_for(w,origin,'knowledge_entry',i::text);
 IF before_policy->>'registered'='true' THEN before_catalog:=application_native_field_catalog_for(w,origin,'knowledge_entry'); END IF;

 -- Retained history without the matching current derivation cannot become a native leaf.
 IF EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='knowledge_entry' AND d.resource_id=i)
  AND NOT EXISTS(SELECT 1 FROM scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='knowledge_entry' AND d.resource_id=i AND d.resource_version=row_version)
  AND knowledge_revision_publication_valid(w,i,row_version) IS NOT TRUE
 THEN RETURN NULL; END IF;
 source:=read_admitted_native_scope_snapshot(w,'knowledge_entry',i);
 IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM row_version
  OR application_query_scope_admits_point(context->'bounds',source) IS NOT TRUE
  OR application_canonical_ancestry_allowed(w,'knowledge_entry',i,row_version) IS NOT TRUE THEN RETURN NULL; END IF;
 policy:=application_native_field_contract_for(w,origin,'knowledge_entry',i::text);
 IF policy->>'registered' IS DISTINCT FROM 'false' THEN
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR policy#>>'{metadata,recordVersion}' IS DISTINCT FROM row_version THEN RETURN NULL; END IF;
  mask:=read_native_application_field_mask(w,origin,'knowledge_entry',i::text,row_version);
  IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'readFields'),false) THEN RETURN NULL; END IF;
 END IF;

 IF include_values THEN
  -- Read only the admitted fields and only the exact version. No whole-row projection.
  SELECT coalesce(jsonb_object_agg(field,CASE field
   WHEN 'id' THEN to_jsonb(k.id) WHEN 'path' THEN to_jsonb(k.path) WHEN 'title' THEN to_jsonb(k.title)
   WHEN 'summary' THEN to_jsonb(k.summary) WHEN 'content' THEN to_jsonb(k.content) WHEN 'tags' THEN to_jsonb(k.tags)
   WHEN 'relatedIds' THEN to_jsonb(k.related_ids) WHEN 'metadata' THEN to_jsonb(k.metadata)
   WHEN 'sourceId' THEN to_jsonb(k.source_id) WHEN 'sourceSha' THEN to_jsonb(k.source_sha)
   WHEN 'createdBy' THEN to_jsonb(k.created_by) WHEN 'createdAt' THEN to_jsonb(k.created_at)
   WHEN 'updatedAt' THEN to_jsonb(k.updated_at) END),'{}')
  INTO values_json FROM knowledge_entries k CROSS JOIN unnest(fields) field
  WHERE k.workspace_id=w AND k.id=i AND k.scope_version::text=row_version;
  raw_ids:=values_json->'relatedIds';
 ELSIF 'relatedIds'=ANY(fields) THEN
  -- Related identities contribute to the policy fingerprint even during a metadata scan.
  SELECT to_jsonb(k.related_ids) INTO raw_ids FROM knowledge_entries k
  WHERE k.workspace_id=w AND k.id=i AND k.scope_version::text=row_version;
 END IF;

 IF before_policy->>'registered'='true' THEN
  after_policy:=application_native_field_contract_for(w,origin,'knowledge_entry',i::text);
  after_catalog:=application_native_field_catalog_for(w,origin,'knowledge_entry');
  IF before_policy->>'held' IS DISTINCT FROM 'false' OR before_catalog->>'held' IS DISTINCT FROM 'false'
   OR after_policy->>'held' IS DISTINCT FROM 'false' OR after_catalog->>'held' IS DISTINCT FROM 'false'
   OR before_policy->'fingerprint' IS DISTINCT FROM after_policy->'fingerprint'
   OR before_catalog->'fingerprint' IS DISTINCT FROM after_catalog->'fingerprint' THEN RETURN NULL; END IF;
  policy_version:=application_field_digest(jsonb_build_object('kind','knowledge-selected-fields-v2',
   'fields',fields,'catalog',after_catalog->'fingerprint','record',after_policy->'fingerprint'));
 ELSE
  policy_version:=application_field_digest(jsonb_build_object('kind','knowledge-fields-v1',
   'catalog',context#>'{policy,fingerprint}','record',policy->'fingerprint','mask',mask));
 END IF;

 IF 'relatedIds'=ANY(fields) THEN
  raw_ids:=coalesce(nullif(raw_ids,'null'::jsonb),'[]');
  IF jsonb_typeof(raw_ids) IS DISTINCT FROM 'array' OR jsonb_array_length(raw_ids)>256
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(raw_ids) value WHERE jsonb_typeof(value)<>'string') THEN RETURN NULL; END IF;
  values_json:=values_json||jsonb_build_object('relatedIds',raw_ids);
 END IF;

 source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId',
  'sensitivity',source->'sensitivity','compartments',source->'compartments','projectIds',source->'projectIds',
  'resourceKind','knowledge_entry','resourceId',i,'version',row_version);
 RETURN jsonb_build_object('values',values_json,'source',source,'recordVersion',row_version,'sourceKind','knowledge_entry',
  'sourceId',i,'sourceVersion',row_version,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','knowledge-fields-v1','fields',fields)),
  'policyVersion',policy_version,'references','[]'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;

CREATE FUNCTION public.application_knowledge_related_fields(w uuid,state jsonb,context jsonb,scan_targets jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE identities jsonb; ids jsonb; refs jsonb;
BEGIN
 IF NOT coalesce((state->'values') ? 'relatedIds',false) THEN RETURN state; END IF;
 WITH targets AS MATERIALIZED (
  SELECT id,CASE WHEN scan_targets IS NULL THEN application_knowledge_admitted_fields(w,id,ARRAY['id'],context,false)
   ELSE nullif(scan_targets->id::text,'null'::jsonb) END AS target
  FROM (SELECT DISTINCT value::uuid AS id FROM jsonb_array_elements_text(state#>'{values,relatedIds}') value) related
 )
 SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('id',id,'version',target->'recordVersion',
   'policy',target->'policyVersion','source',target->'source') ORDER BY id),'[]'),
  coalesce(jsonb_agg(jsonb_build_object('origin','{"kind":"native","moduleKey":"native"}'::jsonb,
   'typeKey','knowledge_entry','id',id,'fields',jsonb_build_array('id')) ORDER BY id),'[]')
 INTO ids,identities,refs FROM targets WHERE target IS NOT NULL;
 RETURN state||jsonb_build_object('values',(state->'values')||jsonb_build_object('relatedIds',ids),'references',refs,
  'policyVersion',application_field_digest(jsonb_build_object('kind','knowledge-related-identities-v1',
   'policy',state->'policyVersion','identities',identities)));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.application_knowledge_admitted_fields(uuid,uuid,text[],jsonb,boolean),
 public.application_knowledge_related_fields(uuid,jsonb,jsonb,jsonb) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON FUNCTION public.application_knowledge_admitted_fields(uuid,uuid,text[],jsonb,boolean),
  public.application_knowledge_related_fields(uuid,jsonb,jsonb,jsonb) FROM app_user;
END IF; END $$;

CREATE OR REPLACE FUNCTION public.application_knowledge_field_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb:=application_knowledge_query_context(w);
BEGIN
 RETURN application_knowledge_related_fields(w,application_knowledge_admitted_fields(w,i,fields,context,true),context,NULL);
END $$;

CREATE OR REPLACE FUNCTION public.application_knowledge_query_scan(w uuid,fields text[],bounds jsonb,include_retained boolean,disabled jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb; candidate_count integer; result jsonb;
BEGIN
 IF fields IS NULL OR NOT fields<@application_knowledge_field_keys() OR application_query_scope_valid(bounds) IS NOT TRUE
  OR include_retained IS NULL OR jsonb_typeof(disabled) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 SELECT count(*) INTO candidate_count FROM (SELECT 1 FROM knowledge_entries WHERE workspace_id=w LIMIT 4097) candidates;
 IF candidate_count>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501'; END IF;
 context:=application_knowledge_query_context(w);
 IF context IS NULL THEN RETURN NULL; END IF;

 WITH admitted AS MATERIALIZED (
  SELECT k.id,k.scope_version::text AS version,
   application_knowledge_admitted_fields(w,k.id,fields,context,false) AS state
  FROM knowledge_entries k WHERE k.workspace_id=w
   AND (k.source_id IS NULL OR NOT disabled ? k.source_id::text)
   AND (include_retained OR NOT EXISTS(SELECT 1 FROM scope_derivations d
    WHERE d.workspace_id=w AND d.resource_kind='knowledge_entry' AND d.resource_id=k.id))
  ORDER BY k.id
 ), visible AS MATERIALIZED (
  SELECT * FROM admitted WHERE state IS NOT NULL AND application_query_scope_admits_point(bounds,state->'source') IS TRUE
 ), related_ids AS (
  SELECT DISTINCT value::uuid AS id FROM visible
  CROSS JOIN LATERAL jsonb_array_elements_text(visible.state#>'{values,relatedIds}') value
 ), related AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(id::text,application_knowledge_admitted_fields(w,id,ARRAY['id'],context,false)),'{}') AS states
  FROM related_ids
 ), completed AS MATERIALIZED (
  SELECT visible.id,visible.version,application_knowledge_related_fields(w,visible.state,context,related.states) AS state
  FROM visible CROSS JOIN related
 )
 SELECT jsonb_build_object(
  'candidates',coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'source',state->'source') ORDER BY id),'[]'),
  'policies',coalesce(jsonb_agg(jsonb_build_object('id',id,'policy',state->'policyVersion') ORDER BY id),'[]'))
 INTO result FROM completed WHERE state IS NOT NULL;
 RETURN result;
END $$;

COMMIT;
