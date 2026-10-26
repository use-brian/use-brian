BEGIN;
-- [COMP:api/application-persistence] Current own negative-feedback review only.
-- Recall tuples are current identity associations, not historical content evidence.
CREATE FUNCTION application_feedback_field_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT ARRAY['id','event_name','message_id','details','created_at','session_id','assistant_id','user_id']::text[]
$$;
REVOKE ALL ON FUNCTION application_feedback_field_keys() FROM PUBLIC;
CREATE FUNCTION application_feedback_query_context(w uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;bounds jsonb;policy jsonb;mask jsonb;keys text[];fields jsonb;scope jsonb;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR nullif(current_setting('app.agent_workspace_id',true),'') IS DISTINCT FROM w::text
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.analytics_events'::regclass WHERE r.rolname=session_user
   AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
 -- Unsupported in-flight data selectors hold instead of dropping a restriction.
 IF coalesce(nullif(current_setting('app.native_query_data_ceilings',true),'')::jsonb,'[]'::jsonb)<>'[]'::jsonb THEN RETURN NULL;END IF;
 bounds:=application_native_query_bounds(w);IF bounds IS NULL OR application_query_scope_valid(bounds) IS NOT TRUE THEN RETURN NULL;END IF;
 keys:=ARRAY(SELECT key FROM unnest(application_feedback_field_keys()) key ORDER BY key);
 policy:=application_native_field_catalog_for(w,'{"kind":"native","moduleKey":"native"}','feedback_event');
 IF policy->>'registered'='false' THEN
  SELECT jsonb_agg(jsonb_build_object('key',key,'read','[]'::jsonb,'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key)
   INTO fields FROM unnest(keys) key;
  -- This is the public schema definition, not a default for a data row or missing ancestor.
  scope:=jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb);
  policy:=jsonb_build_object('registered',true,'held',false,'nativeDefault',true,'roleKeys','[]'::jsonb,
   'metadata',jsonb_build_object('moduleKey','native','origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey','feedback_event',
    'schemaVersion','feedback-fields-v1','policyVersion','feedback-fields-v1','fieldKeys',keys,'fields',fields,'scope',scope),
   'fingerprint',application_field_digest(jsonb_build_object('kind','feedback-fields-v1','workspaceId',w,'fields',fields)));
  mask:=application_native_member_field_permissions(w,policy,actor);
 ELSE
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR NOT coalesce(to_jsonb(keys)<@(policy#>'{metadata,fieldKeys}'),false) THEN RETURN NULL;END IF;
  mask:=read_native_application_field_catalog(w,'{"kind":"native","moduleKey":"native"}','feedback_event');
  mask:=jsonb_build_object('read',mask->'readFields');
 END IF;
 IF workflow_evidence_envelope_visible(w,policy#>'{metadata,scope}') IS NOT TRUE OR jsonb_typeof(mask->'read') IS DISTINCT FROM 'array' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('policy',policy,'read',mask->'read','bounds',bounds,
  'visibility',jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
   'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb)));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_feedback_query_context(uuid) FROM PUBLIC;


CREATE FUNCTION application_feedback_field_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;source jsonb;policy jsonb;mask jsonb;v text;values_json jsonb:='{}';field text;value jsonb;message_id uuid;parent jsonb;
BEGIN
 IF fields IS NULL OR NOT fields<@application_feedback_field_keys() OR NOT ARRAY['message_id','event_name','session_id']::text[]<@fields
  OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f) THEN RETURN NULL;END IF;
 context:=application_feedback_query_context(w);
 IF context IS NULL OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RETURN NULL;END IF;
 SELECT scope_version::text INTO v FROM analytics_events WHERE workspace_id=w AND id=i
  AND user_id=nullif(current_setting('app.current_user_id',true),'')::uuid;
 IF NOT FOUND OR v IS NULL THEN RETURN NULL;END IF;
 source:=read_admitted_native_scope_snapshot(w,'feedback_event',i);
 IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM v
  OR application_query_scope_admits_point(context->'bounds',source) IS NOT TRUE
  OR application_canonical_ancestry_allowed(w,'feedback_event',i,v) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM read_external_source_dependencies(w,ARRAY['feedback_event'],ARRAY[i],ARRAY[v])) THEN RETURN NULL;END IF;
 policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','feedback_event',i::text);
 IF policy->>'registered' IS DISTINCT FROM 'false' THEN
  IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false'
   OR policy#>>'{metadata,recordVersion}' IS DISTINCT FROM v THEN RETURN NULL;END IF;
  mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','feedback_event',i::text,v);
  IF mask IS NULL OR NOT coalesce(to_jsonb(fields)<@(mask->'readFields'),false) THEN RETURN NULL;END IF;
 END IF;
 -- No event kind, message pointer, timestamp or details enters scoring before the mask.
 FOREACH field IN ARRAY fields LOOP
  IF field='message_id' THEN SELECT to_jsonb(metadata->>'messageId') INTO value FROM analytics_events WHERE workspace_id=w AND id=i AND scope_version::text=v;
  ELSIF field='details' THEN SELECT to_jsonb(metadata->>'details') INTO value FROM analytics_events WHERE workspace_id=w AND id=i AND scope_version::text=v;
  ELSE EXECUTE format('SELECT to_jsonb(%I) FROM public.analytics_events WHERE workspace_id=$1 AND id=$2 AND scope_version::text=$3',field) INTO value USING w,i,v;END IF;
  values_json:=values_json||jsonb_build_object(field,value);
 END LOOP;
 IF values_json->>'event_name'<>'feedback_negative' THEN RETURN NULL;END IF;
 message_id:=(values_json->>'message_id')::uuid;
 parent:=application_session_field_state(w,'session_message',message_id,ARRAY['id','role']);
 IF parent IS NULL OR parent#>>'{values,role}'<>'assistant'
  OR NOT EXISTS(SELECT 1 FROM session_messages sm WHERE sm.workspace_id=w AND sm.id=message_id
   AND sm.session_id=(values_json->>'session_id')::uuid AND sm.assistant_id=(values_json->>'assistant_id')::uuid) THEN RETURN NULL;END IF;
 source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId','sensitivity',source->'sensitivity',
  'compartments',source->'compartments','projectIds',source->'projectIds','resourceKind','feedback_event','resourceId',i,'version',v);
 RETURN jsonb_build_object('values',values_json,'source',source,'recordVersion',v,'sourceKind','feedback_event','sourceId',i,'sourceVersion',v,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','feedback-fields-v1','fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','feedback-fields-v1','catalog',context#>'{policy,fingerprint}','record',policy->'fingerprint','mask',mask)),
  'references',jsonb_build_array(jsonb_build_object('origin','{"kind":"native","moduleKey":"native"}'::jsonb,'typeKey','session_message','id',message_id,'fields',ARRAY['id','role'])));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_feedback_field_state(uuid,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION application_feedback_outcome_scan(w uuid,memory_ids uuid[],fields text[],window_start timestamptz,window_end timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;recall record;telemetry record;event record;memory_state jsonb;message_state jsonb;feedback_state jsonb;tuple jsonb;
 memory_candidates jsonb:='[]';candidate uuid;raw_source jsonb;associations jsonb:='[]';feedback_rows jsonb:='[]';policies jsonb:='[]';refs jsonb:='[]';seen integer:=0;event_seen integer:=0;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;origin jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 context:=application_feedback_query_context(w);
 IF context IS NULL OR memory_ids IS NULL OR cardinality(memory_ids)>100 OR array_position(memory_ids,NULL) IS NOT NULL
  OR cardinality(memory_ids)<>(SELECT count(DISTINCT i) FROM unnest(memory_ids) i)
  OR window_start IS NULL OR window_end IS NULL OR window_start>window_end OR window_end>statement_timestamp()
  OR window_end-window_start>interval '30 days' OR fields IS DISTINCT FROM ARRAY(SELECT f FROM unnest(application_feedback_field_keys()) f ORDER BY f)
  OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false) THEN RETURN NULL;END IF;
 -- Every requested Memory remains an exact self-contained dependency, even
 -- with no recall/feedback rows. Unsupported source profiles are never zero.
 FOREACH candidate IN ARRAY memory_ids LOOP
  raw_source:=read_scope_source(w,'memory',candidate);
  IF raw_source IS NULL OR raw_source->>'held' IS DISTINCT FROM 'false'
   OR workflow_evidence_envelope_visible(w,raw_source) IS NOT TRUE
   OR application_query_scope_admits_point(context->'bounds',raw_source) IS NOT TRUE THEN RETURN NULL;END IF;
  IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,ARRAY['memory'],ARRAY[candidate],ARRAY[raw_source->>'version'])) THEN
   RAISE EXCEPTION 'outcome_profile_unavailable' USING ERRCODE='0A000';END IF;
  memory_state:=application_memory_field_state(w,candidate,ARRAY['id']);
  IF memory_state IS NULL THEN RETURN NULL;END IF;
  memory_candidates:=memory_candidates||jsonb_build_array(jsonb_build_object('id',candidate,'version',memory_state->>'sourceVersion'));
  policies:=policies||jsonb_build_array(jsonb_build_object('memoryId',candidate,'policy',memory_state->'policyVersion'));
  refs:=refs||jsonb_build_array(jsonb_build_object('origin',origin,'typeKey','memory','id',candidate,'fields',ARRAY['id']));
 END LOOP;
 -- Identity-only metadata discovery is complete and bounded. Each candidate's
 -- two real parents are admitted before interpreting its telemetry or window.
 FOR recall IN SELECT r.id,r.memory_id,r.session_id,r.assistant_message_id FROM memory_recall_events r WHERE r.workspace_id=w AND r.memory_id=ANY(memory_ids) ORDER BY r.id LOOP
  seen:=seen+1;IF seen>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  IF recall.assistant_message_id IS NULL THEN CONTINUE;END IF;
  raw_source:=read_scope_source(w,'session_message',recall.assistant_message_id);
  IF raw_source IS NULL OR raw_source->>'held' IS DISTINCT FROM 'false'
   OR workflow_evidence_envelope_visible(w,raw_source) IS NOT TRUE
   OR application_session_query_parent(w,recall.session_id) IS NULL THEN CONTINUE;END IF;
  IF EXISTS(SELECT 1 FROM read_external_source_dependencies(w,ARRAY['session_message'],ARRAY[recall.assistant_message_id],ARRAY[raw_source->>'version'])) THEN
   RAISE EXCEPTION 'outcome_profile_unavailable' USING ERRCODE='0A000';END IF;
  memory_state:=application_memory_field_state(w,recall.memory_id,ARRAY['id']);
  message_state:=application_session_field_state(w,'session_message',recall.assistant_message_id,ARRAY['id','role']);
  IF memory_state IS NULL OR message_state IS NULL OR message_state#>>'{values,role}'<>'assistant'
   OR NOT EXISTS(SELECT 1 FROM session_messages sm WHERE sm.id=recall.assistant_message_id AND sm.workspace_id=w AND sm.session_id=recall.session_id
    AND sm.assistant_id=nullif(current_setting('app.v2_assistant_id',true),'')::uuid) THEN CONTINUE;END IF;
  SELECT user_id,recall_kind,created_at INTO telemetry FROM memory_recall_events WHERE workspace_id=w AND id=recall.id
   AND memory_id=recall.memory_id AND session_id=recall.session_id AND assistant_message_id=recall.assistant_message_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF telemetry.created_at<window_start OR telemetry.created_at>window_end THEN CONTINUE;END IF;
  tuple:=jsonb_build_object('id',recall.id,'memoryId',recall.memory_id,'sessionId',recall.session_id,'messageId',recall.assistant_message_id,
   'userId',telemetry.user_id,'recallKind',telemetry.recall_kind,'createdAt',telemetry.created_at,
   'memoryVersion',memory_state->>'sourceVersion','messageVersion',message_state->>'sourceVersion');
  associations:=associations||jsonb_build_array(tuple);
  policies:=policies||jsonb_build_array(jsonb_build_object('recallId',recall.id,'memory',memory_state->'policyVersion','message',message_state->'policyVersion'));
  refs:=refs||jsonb_build_array(jsonb_build_object('origin',origin,'typeKey','memory','id',recall.memory_id,'fields',ARRAY['id']),
   jsonb_build_object('origin',origin,'typeKey','session_message','id',recall.assistant_message_id,'fields',ARRAY['id','role']));
  -- Exact own-policy precedes kind discovery or unsupported refusal. Metadata
  -- discriminator/pointer only discover unsupported profiles, never score them.
  FOR event IN SELECT ae.id,ae.scope_version,ae.scope_held,ae.workspace_id,ae.metadata->>'messageId' AS message_id
   FROM analytics_events ae WHERE ae.user_id=actor AND ae.session_id=recall.session_id
    AND ae.event_name IN('feedback_positive','feedback_negative') ORDER BY ae.id LOOP
   event_seen:=event_seen+1;IF event_seen>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
   IF event.message_id IS DISTINCT FROM recall.assistant_message_id::text THEN CONTINUE;END IF;
   IF event.workspace_id IS NULL OR event.scope_version IS NULL OR read_scope_source(w,'feedback_event',event.id) IS NULL THEN
    RAISE EXCEPTION 'outcome_profile_unavailable' USING ERRCODE='0A000';END IF;
   feedback_state:=application_feedback_field_state(w,event.id,fields);
   IF feedback_state IS NULL THEN CONTINUE;END IF;
   IF (feedback_state#>>'{values,created_at}')::timestamptz<window_start OR (feedback_state#>>'{values,created_at}')::timestamptz>window_end THEN CONTINUE;END IF;
   feedback_rows:=feedback_rows||jsonb_build_array(jsonb_build_object('recallId',recall.id,'feedbackId',event.id,'version',feedback_state->>'sourceVersion','values',feedback_state->'values'));
   policies:=policies||jsonb_build_array(jsonb_build_object('recallId',recall.id,'feedbackId',event.id,'policy',feedback_state->'policyVersion'));
   refs:=refs||jsonb_build_array(jsonb_build_object('origin',origin,'typeKey','feedback_event','id',event.id,'fields',fields));
  END LOOP;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO refs FROM(SELECT DISTINCT value FROM jsonb_array_elements(refs)) r;
 -- Values stay transient; immutable domain metadata stores identities/versions only.
 RETURN jsonb_build_object('memoryCandidates',memory_candidates,'associations',associations,'feedback',feedback_rows,'policies',policies,'references',refs);
END $$;
REVOKE ALL ON FUNCTION application_feedback_outcome_scan(uuid,uuid[],text[],timestamptz,timestamptz) FROM PUBLIC;

CREATE FUNCTION application_feedback_outcome_domain_state(w uuid,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains;context jsonb;scanned jsonb;feedback_metadata jsonb;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i AND origin='{"kind":"native","moduleKey":"native"}' AND type_key='feedback_event';
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'memory_outcome_domain_v1'
  OR frozen.domain-ARRAY['kind','fields','bounds','visibility','memoryIds','windowStart','windowEnd','memoryCandidates','associations','feedback','policies']<>'{}'
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields) THEN RETURN NULL;END IF;
 context:=application_feedback_query_context(w);
 IF context IS NULL OR context#>>'{policy,metadata,schemaVersion}' IS DISTINCT FROM frozen.schema_version
  OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false)
  OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(context->'bounds'),4096)->>'contains' IS DISTINCT FROM 'true'
  OR frozen.domain->'visibility' IS DISTINCT FROM context->'visibility' THEN RETURN NULL;END IF;
 scanned:=application_feedback_outcome_scan(w,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(frozen.domain->'memoryIds')),
  fields,(frozen.domain->>'windowStart')::timestamptz,(frozen.domain->>'windowEnd')::timestamptz);
 SELECT coalesce(jsonb_agg(value-'values' ORDER BY value->>'recallId',value->>'feedbackId'),'[]') INTO feedback_metadata FROM jsonb_array_elements(scanned->'feedback');
 IF scanned IS NULL OR scanned->'memoryCandidates' IS DISTINCT FROM frozen.domain->'memoryCandidates'
  OR scanned->'associations' IS DISTINCT FROM frozen.domain->'associations'
  OR feedback_metadata IS DISTINCT FROM frozen.domain->'feedback' OR scanned->'policies' IS DISTINCT FROM frozen.domain->'policies' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',context#>'{policy,metadata,scope}','recordVersion',frozen.schema_version,
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','memory_outcome_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','memory_outcome_domain_v1','identity',frozen.identity,'policy',context#>'{policy,fingerprint}','policies',scanned->'policies')),
  'references',scanned->'references');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_feedback_outcome_domain_state(uuid,uuid,text[]) FROM PUBLIC;

ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_feedback_outcome;
REVOKE ALL ON FUNCTION application_field_projection_state_before_feedback_outcome(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type='feedback_event' THEN
  IF p_selected_version IS NOT NULL THEN RETURN NULL;END IF;
  IF p_selection='query_domain' THEN RETURN application_feedback_outcome_domain_state(w,p_id,p_fields);END IF;
  IF p_selection NOT IN('read','query','identity') THEN RETURN NULL;END IF;
  RETURN application_feedback_field_state(w,p_id,p_fields);
 END IF;
 RETURN application_field_projection_state_before_feedback_outcome(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;

CREATE FUNCTION read_native_memory_outcome_projection(w uuid,memory_ids uuid[],fields text[],window_start timestamptz,window_end timestamptz) RETURNS TABLE(value jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;scanned jsonb;domain jsonb;identity_value text;domain_id uuid;frozen application_query_domains;captured jsonb;feedback_metadata jsonb;
BEGIN
 fields:=ARRAY(SELECT f FROM unnest(fields) f ORDER BY f);memory_ids:=ARRAY(SELECT i FROM unnest(memory_ids) i ORDER BY i);
 context:=application_feedback_query_context(w);scanned:=application_feedback_outcome_scan(w,memory_ids,fields,window_start,window_end);
 IF context IS NULL OR scanned IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(item-'values' ORDER BY item->>'recallId',item->>'feedbackId'),'[]') INTO feedback_metadata FROM jsonb_array_elements(scanned->'feedback') item;
 domain:=jsonb_build_object('kind','memory_outcome_domain_v1','fields',fields,'bounds',context->'bounds','visibility',context->'visibility',
  'memoryIds',memory_ids,'windowStart',window_start,'windowEnd',window_end,'memoryCandidates',scanned->'memoryCandidates','associations',scanned->'associations','feedback',feedback_metadata,'policies',scanned->'policies');
 identity_value:=application_field_digest(jsonb_build_object('kind','memory_outcome_domain_v1','workspaceId',w,'domain',domain));domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity) VALUES(domain_id,w,'{"kind":"native","moduleKey":"native"}','feedback_event',
  context#>>'{policy,metadata,schemaVersion}',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=domain_id;
 IF NOT FOUND OR(frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity) IS DISTINCT FROM('feedback_event',context#>>'{policy,metadata,schemaVersion}',domain,identity_value) THEN
  RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}','feedback_event',domain_id,frozen.schema_version,'query_domain',NULL,fields);
 IF captured IS NULL THEN RAISE EXCEPTION 'query_domain_unavailable' USING ERRCODE='42501';END IF;
 value:=jsonb_build_object('associations',scanned->'associations','feedback',scanned->'feedback','sources',captured->'sources');RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION read_native_memory_outcome_projection(uuid,uuid[],text[],timestamptz,timestamptz) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_native_memory_outcome_projection(uuid,uuid[],text[],timestamptz,timestamptz) TO app_user;
END IF;END $$;
-- Proposal only. Replace the current 8096 facade in 8112 without a new rename,
-- preserving its owner, ACL, SECURITY DEFINER and canonical search_path.
CREATE OR REPLACE FUNCTION read_entity_derivation_source(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid;
 root jsonb;parent jsonb;context jsonb;policy jsonb;mask jsonb;feedback_message_id uuid;feedback_session_id uuid;expected text;
BEGIN
 IF k='feedback_event' THEN
  actor:=nullif(current_setting('app.current_user_id',true),'')::uuid;
  IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
   OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
   OR nullif(current_setting('app.agent_workspace_id',true),'') IS NOT NULL AND current_setting('app.agent_workspace_id',true)<>w::text
   OR nullif(current_setting('app.agent_actor_id',true),'') IS NOT NULL AND current_setting('app.agent_actor_id',true)<>actor::text
   OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.analytics_events'::regclass WHERE r.rolname=session_user
    AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN NULL;END IF;
  root:=read_scope_source(w,k,i);
  IF root IS NULL OR root->>'userId' IS DISTINCT FROM actor::text OR root->>'held' IS DISTINCT FROM 'false'
   OR root->>'version' IS NULL OR root->>'validTo' IS NOT NULL OR root->>'retractedAt' IS NOT NULL
   OR entity_derivation_envelope_valid(root) IS NOT TRUE OR scope_review_state_held(k,i)
   OR agent_visibility_allows(w,(root->>'userId')::uuid,(root->>'assistantId')::uuid) IS NOT TRUE
   OR workflow_evidence_envelope_visible(w,root) IS NOT TRUE THEN RETURN NULL;END IF;
  -- This is only canonical source metadata. The existing negative-only source
  -- identity, exact own-user floor and full current field masks remain mandatory.
  context:=application_feedback_query_context(w);
  IF context IS NULL OR NOT coalesce(to_jsonb(application_feedback_field_keys())<@(context->'read'),false) THEN RETURN NULL;END IF;
  policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}','feedback_event',i::text);
  IF policy->>'registered' IS DISTINCT FROM 'false' THEN
   IF policy->>'held' IS DISTINCT FROM 'false' OR policy#>>'{metadata,recordVersion}' IS DISTINCT FROM root->>'version' THEN RETURN NULL;END IF;
   mask:=read_native_application_field_mask(w,'{"kind":"native","moduleKey":"native"}','feedback_event',i::text,root->>'version');
   IF mask IS NULL OR NOT coalesce(to_jsonb(application_feedback_field_keys())<@(mask->'readFields'),false) THEN RETURN NULL;END IF;
  END IF;
  SELECT (a.metadata->>'messageId')::uuid,a.session_id INTO feedback_message_id,feedback_session_id FROM analytics_events a
   WHERE a.workspace_id=w AND a.id=i AND a.user_id=actor AND a.scope_version::text=root->>'version';
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM session_messages sm WHERE sm.workspace_id=w AND sm.id=feedback_message_id
   AND sm.session_id=feedback_session_id AND sm.assistant_id=(root->>'assistantId')::uuid) THEN RETURN NULL;END IF;
  SELECT s.source_version INTO expected FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
   WHERE d.workspace_id=w AND d.resource_kind='feedback_event' AND d.resource_id=i AND d.resource_version=root->>'version'
    AND s.source_kind='session_message' AND s.source_id=feedback_message_id;
  IF NOT FOUND THEN RETURN NULL;END IF;
  parent:=read_entity_derivation_source(w,'session_message',feedback_message_id);
  IF parent IS NULL OR parent->>'held' IS DISTINCT FROM 'false' OR parent->>'version' IS DISTINCT FROM expected
   OR application_session_query_parent(w,feedback_session_id) IS NULL THEN RETURN NULL;END IF;
  RETURN root||jsonb_build_object('requiredSources',coalesce(parent->'requiredSources','[]'::jsonb));
 END IF;
 -- Byte-identical current Memory retirement,8105external-source and fallback branches.
 IF k='memory' AND EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NOT NULL) THEN
  RETURN native_memory_historical_source(w,i,application_memory_field_keys());
 END IF;
 IF k='external_source' THEN RETURN external_source_snapshot(w,i);END IF;
 RETURN read_entity_derivation_source_before_memory_successor(w,k,i);
END $$;
COMMIT;
