-- [COMP:api/application-persistence] Native session fields and bounded original query domains.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])')
  AND prosecdef AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='7e086ec57c83f13d85853d4f4555928dc5e0ed0b7dc049de3533647ae73734b2') THEN
  RAISE EXCEPTION 'Canonical field projection dispatcher changed';END IF;
END $$;

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)')
  AND prosecdef AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='96caaec1306351ae65ce2f5e20e518bf4ad17638518ee5e573eb5796225d6368') THEN
  RAISE EXCEPTION 'Native session prerequisite changed: application_compute_field_envelope';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.application_recorded_field_state(uuid,uuid,text,integer)')
  AND prosecdef AND encode(sha256(convert_to(prosrc,'UTF8')),'hex')='f0b7e225262876625f4498a9e3857c9e14e7f8b8505a02b9c4042ef3c68f23be') THEN
  RAISE EXCEPTION 'Native session prerequisite changed: application_recorded_field_state';END IF;
END $$;

CREATE FUNCTION application_session_field_keys(t text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE t WHEN 'session_message' THEN ARRAY['id','role','content','sequenceNum','createdAt','senderUserId','senderAssistantId','channelMessageId','attachments']
  WHEN 'session_message_annotation' THEN ARRAY['id','sequenceNum','topicLabel','topicConfidence','replyToText'] END
$$;
REVOKE ALL ON FUNCTION application_session_field_keys(text) FROM PUBLIC;

-- Current parent authority is independently checked, never inferred from a
-- session id or its creator. No application raw-session grant is introduced.
CREATE FUNCTION application_session_query_parent(w uuid,s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent jsonb;binding jsonb;
BEGIN
 parent:=session_context_parent_snapshot(w,s);
 IF parent IS NULL OR workflow_evidence_envelope_visible(w,parent) IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT jsonb_build_object('id',id,'workspaceId',workspace_id,'assistantId',assistant_id,'userId',user_id,
  'visibility',visibility,'anchorKind',anchor_kind,'anchorRef',anchor_ref,'mode',mode,'channelType',channel_type,
  'channelId',channel_id,'appId',app_id,'contextGroupId',context_group_id,'contextProjectId',context_project_id,
  'contextCompartments',context_compartments,'effectiveClearance',effective_clearance) INTO binding
  FROM sessions WHERE workspace_id=w AND id=s;
 IF binding IS NULL THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('scope',parent-ARRAY['assistant','createdBy'],'fingerprint',application_field_digest(binding));
END $$;
REVOKE ALL ON FUNCTION application_session_query_parent(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION application_session_field_state(w uuid,t text,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m session_messages;revision session_context_scope_revisions;source jsonb;parent jsonb;payload jsonb;values_json jsonb;selected jsonb;
 keys text[]:=application_session_field_keys(t);record_version text;source_kind text;source_id uuid;
BEGIN
 IF keys IS NULL OR fields IS NULL OR cardinality(fields)>cardinality(keys) OR NOT fields<@keys
  OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 -- Only immutable identity/scope metadata is selected before source admission.
 SELECT id,workspace_id,session_id,scope_version,sequence_num INTO m.id,m.workspace_id,m.session_id,m.scope_version,m.sequence_num
  FROM session_messages WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN NULL;END IF;
 parent:=application_session_query_parent(w,m.session_id);IF parent IS NULL THEN RETURN NULL;END IF;
 IF t='session_message' THEN
  source:=read_admitted_native_scope_snapshot(w,'session_message',i);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM m.scope_version::text
   OR application_canonical_ancestry_allowed(w,'session_message',i,m.scope_version::text) IS NOT TRUE THEN RETURN NULL;END IF;
  SELECT jsonb_build_object('id',id,'role',role,'content',content,'sequenceNum',sequence_num,'createdAt',created_at,
   'senderUserId',sender_user_id,'senderAssistantId',sender_assistant_id,'channelMessageId',channel_message_id,'attachments',attachments) INTO values_json
   FROM session_messages WHERE workspace_id=w AND id=i AND scope_version=m.scope_version;
  IF values_json IS NULL THEN RETURN NULL;END IF;
  source_kind:='session_message';source_id:=i;
  -- Selected payload changes remain distinct even when an old native writer
  -- changed text without advancing its scope envelope version.
  record_version:=m.scope_version::text||':'||application_field_digest(values_json);
 ELSE
  SELECT r.* INTO revision FROM session_message_annotation_heads h JOIN session_context_scope_revisions r
   ON r.workspace_id=h.workspace_id AND r.id=h.scope_revision_id
   WHERE h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=i AND r.parent_kind='message_annotation'
    AND r.parent_id=i AND r.session_id=m.session_id;
  IF NOT FOUND OR session_context_revision_allowed(w,revision.id) IS NOT TRUE THEN RETURN NULL;END IF;
  source:=session_context_revision_native(w,revision.id);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
  SELECT content INTO payload FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=revision.id;
  IF payload IS NULL THEN RETURN NULL;END IF;
  values_json:=jsonb_build_object('id',i,'sequenceNum',m.sequence_num,'topicLabel',payload->'topicLabel',
   'topicConfidence',payload->'topicConfidence','replyToText',payload->'replyToText');
  source_kind:='session_context_revision';source_id:=revision.id;record_version:=revision.id::text;
 END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO selected FROM jsonb_each(values_json) WHERE key=ANY(fields);
 RETURN jsonb_build_object('values',selected,'source',source,'recordVersion',record_version,
  'sourceKind',source_kind,'sourceId',source_id,'sourceVersion',source->>'version','ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_field_v1','type',t,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_field_v1','parent',parent->'fingerprint','fields',fields)),
  'references','[]'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_session_field_state(uuid,text,uuid,text[]) FROM PUBLIC;

CREATE FUNCTION application_session_query_bounds(w uuid,parent jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE bounds jsonb;
BEGIN
 bounds:=application_native_query_bounds(w);
 IF bounds IS NULL THEN
  -- This is the already-admitted real personal guest session's scope, not
  -- a workspace/General fallback for an unknown principal or missing source.
  IF parent IS NULL OR parent#>>'{scope,userId}' IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
   OR parent#>>'{scope,sensitivity}' IS DISTINCT FROM 'public' THEN RETURN NULL;END IF;
  bounds:=application_query_scope_cap(sensitivity_rank(parent#>>'{scope,sensitivity}'),parent#>'{scope,compartments}',parent#>'{scope,projectIds}');
 END IF;
 IF application_query_scope_valid(bounds) IS NOT TRUE THEN RETURN NULL;END IF;RETURN bounds;
END $$;
REVOKE ALL ON FUNCTION application_session_query_bounds(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION application_session_query_scan(w uuid,s uuid,t text,through integer,fields text[],bounds jsonb,visibility jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent jsonb;candidate record;point jsonb;candidates jsonb:='[]';points jsonb:='[]';policies jsonb:='[]';attempts integer:=0;
BEGIN
 parent:=application_session_query_parent(w,s);
 IF parent IS NULL OR through IS NULL OR through<0 OR application_session_field_keys(t) IS NULL
  OR fields IS NULL OR NOT fields<@application_session_field_keys(t) OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR application_query_scope_valid(bounds) IS NOT TRUE OR jsonb_typeof(visibility) IS DISTINCT FROM 'object'
  OR visibility-ARRAY['userId','assistants']<>'{}' OR NOT visibility ?& ARRAY['userId','assistants'] THEN RETURN NULL;END IF;
 FOR candidate IN SELECT id,sequence_num FROM session_messages WHERE workspace_id=w AND session_id=s
  AND sequence_num<=through ORDER BY sequence_num,id LOOP
  attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  point:=application_compute_field_envelope(w,'{"kind":"native","moduleKey":"native"}',t,candidate.id,'query',NULL,fields,1);
  IF point IS NULL OR application_query_scope_admits_point(bounds,point->'source') IS NOT TRUE
   OR point#>>'{source,userId}' IS NOT NULL AND point#>>'{source,userId}' IS DISTINCT FROM visibility->>'userId'
   OR point#>>'{source,assistantId}' IS NOT NULL AND visibility->'assistants'<>'null'::jsonb
    AND NOT coalesce(visibility->'assistants' ? (point#>>'{source,assistantId}'),false) THEN CONTINUE;END IF;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',point#>'{state,recordVersion}'));
  points:=points||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',point#>'{state,recordVersion}','fields',fields,'source',point->'source'));
  policies:=policies||jsonb_build_array(jsonb_build_object('id',candidate.id,'policy',point#>'{state,policyVersion}'));
 END LOOP;
 RETURN jsonb_build_object('parent',parent,'candidates',candidates,'points',points,'policies',policies);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION application_session_query_domain_state(w uuid,t text,i uuid,fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains;parent jsonb;current_bounds jsonb;visibility jsonb;scanned jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i
  AND origin='{"kind":"native","moduleKey":"native"}' AND type_key=t;
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'session_query_domain_v1'
  OR frozen.domain-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']<>'{}'
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields) THEN RETURN NULL;END IF;
 parent:=application_session_query_parent(w,(frozen.domain->>'sessionId')::uuid);
 IF parent IS NULL OR parent->'fingerprint' IS DISTINCT FROM frozen.domain->'parentFingerprint' THEN RETURN NULL;END IF;
 current_bounds:=application_session_query_bounds(w,parent);
 IF current_bounds IS NULL OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(current_bounds),4096)->>'contains' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 IF frozen.domain#>>'{visibility,userId}' IS NOT NULL AND frozen.domain#>>'{visibility,userId}' IS DISTINCT FROM visibility->>'userId'
  OR visibility->'assistants'<>'null'::jsonb AND (frozen.domain#>'{visibility,assistants}'='null'::jsonb
   OR NOT coalesce(frozen.domain#>'{visibility,assistants}'<@(visibility->'assistants'),false)) THEN RETURN NULL;END IF;
 scanned:=application_session_query_scan(w,(frozen.domain->>'sessionId')::uuid,t,(frozen.domain->>'throughSequence')::integer,
  fields,frozen.domain->'bounds',frozen.domain->'visibility');
 IF scanned IS NULL OR scanned->'candidates' IS DISTINCT FROM frozen.domain->'candidates'
  OR scanned->'points' IS DISTINCT FROM frozen.domain->'points' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',parent->'scope','recordVersion','1',
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'policies',scanned->'policies')),
  'references','[]'::jsonb,'queryPoints',frozen.domain->'points');
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_session_query_domain_state(uuid,text,uuid,text[]) FROM PUBLIC;

ALTER FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) RENAME TO application_field_projection_state_before_session_queries;
REVOKE ALL ON FUNCTION application_field_projection_state_before_session_queries(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;
CREATE FUNCTION application_field_projection_state(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_origin='{"kind":"native","moduleKey":"native"}'::jsonb AND p_type IN('session_message','session_message_annotation') THEN
  IF p_selected_version IS NOT NULL THEN RETURN NULL;END IF;
  IF p_selection='query_domain' THEN RETURN application_session_query_domain_state(w,p_type,p_id,p_fields);END IF;
  IF p_selection NOT IN('read','query','identity') THEN RETURN NULL;END IF;
  RETURN application_session_field_state(w,p_type,p_id,p_fields);
 END IF;
 RETURN application_field_projection_state_before_session_queries(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields);
END $$;
REVOKE ALL ON FUNCTION application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[]) FROM PUBLIC;

CREATE FUNCTION read_native_application_session_projection(w uuid,s uuid,through integer,t text) RETURNS TABLE(value jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE parent jsonb;bounds jsonb;visibility jsonb;scanned jsonb;fields text[];domain jsonb;identity_value text;domain_id uuid;
 frozen application_query_domains;captured jsonb;point jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR t NOT IN('session_message','session_message_annotation') OR through IS NULL OR through<0
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.session_messages'::regclass WHERE r.rolname=session_user
   AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 parent:=application_session_query_parent(w,s);bounds:=application_session_query_bounds(w,parent);
 IF parent IS NULL OR bounds IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 fields:=ARRAY(SELECT field FROM unnest(application_session_field_keys(t)) field ORDER BY field);
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 scanned:=application_session_query_scan(w,s,t,through,fields,bounds,visibility);
 IF scanned IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 domain:=jsonb_build_object('kind','session_query_domain_v1','sessionId',s,'throughSequence',through,'fields',fields,'bounds',bounds,'visibility',visibility,
  'parentFingerprint',parent->'fingerprint','candidates',scanned->'candidates','points',scanned->'points');
 identity_value:=application_field_digest(jsonb_build_object('kind','session_query_domain_v1','workspaceId',w,'type',t,'domain',domain));
 domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
  VALUES(domain_id,w,'{"kind":"native","moduleKey":"native"}',t,'1',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=domain_id;
 IF NOT FOUND OR (frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity) IS DISTINCT FROM (t,'1',domain,identity_value) THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}',t,domain_id,'1','query_domain',NULL,fields);
 IF captured IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 value:=jsonb_build_object('row',NULL,'sources',captured->'sources');RETURN NEXT;
 FOR point IN SELECT item FROM jsonb_array_elements(scanned->'points') item LOOP
  captured:=observe_application_field_projection(w,'{"kind":"native","moduleKey":"native"}',t,(point->>'id')::uuid,point->>'version','query',NULL,fields);
  IF captured IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
  value:=jsonb_build_object('row',captured->'values','sources',captured->'sources');RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_application_session_projection(uuid,uuid,integer,text) FROM PUBLIC;
CREATE FUNCTION read_native_application_session_history(w uuid,s uuid,through integer) RETURNS TABLE(value jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT * FROM read_native_application_session_projection(w,s,through,'session_message')
$$;
CREATE FUNCTION read_native_application_session_topics(w uuid,s uuid,through integer) RETURNS TABLE(value jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT * FROM read_native_application_session_projection(w,s,through,'session_message_annotation')
$$;
REVOKE ALL ON FUNCTION read_native_application_session_history(uuid,uuid,integer),read_native_application_session_topics(uuid,uuid,integer) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION read_native_application_session_history(uuid,uuid,integer),read_native_application_session_topics(uuid,uuid,integer) TO app_user;
 END IF;
END $$;
-- A canonical native publication executes on the actual non-owner connection.
-- Owner connections cannot qualify the original query domain and are refused.
CREATE FUNCTION lock_native_session_context_publication(w uuid,s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.session_context_revision_contents'::regclass
   WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
  OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor) THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 PERFORM id FROM workspaces WHERE id=w FOR NO KEY UPDATE;
 PERFORM id FROM sessions WHERE workspace_id=w AND id=s FOR UPDATE;
 parent:=session_context_parent_snapshot(w,s);
 IF parent IS NULL OR workflow_evidence_envelope_visible(w,parent) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 RETURN parent;
END $$;
REVOKE ALL ON FUNCTION lock_native_session_context_publication(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION publish_native_session_context_revision(w uuid,s uuid,k text,p uuid,i uuid,payload jsonb,producer text,sources jsonb,
 expected_revision uuid,expected_generation bigint,expected_cursor integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;parent jsonb;target sessions;
 source jsonb;current_source jsonb;floor_tier text;teams text[];projects uuid[];previous uuid;derivation uuid;created timestamptz;memo jsonb:='{}';evaluated jsonb;
BEGIN
 parent:=lock_native_session_context_publication(w,s);
 IF k NOT IN('session_state','episodic_memory','compact_summary','message_annotation') OR p IS NULL OR i IS NULL
  OR session_context_payload_shape(k,payload) IS NOT TRUE OR length(btrim(producer)) NOT BETWEEN 1 AND 256
  OR jsonb_typeof(sources) IS DISTINCT FROM 'array' OR jsonb_array_length(sources) NOT BETWEEN 1 AND 4096
  OR (SELECT count(DISTINCT (node->>'resourceKind',node->>'resourceId')) FROM jsonb_array_elements(sources) node)<>jsonb_array_length(sources) THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT * INTO STRICT target FROM sessions WHERE workspace_id=w AND id=s;
 IF expected_generation IS NOT NULL AND target.session_context_generation<>expected_generation THEN RETURN NULL;END IF;
 IF k='compact_summary' THEN
  IF p<>s OR target.compact_boundary_sequence IS DISTINCT FROM expected_cursor THEN RETURN NULL;END IF;
 ELSIF k='message_annotation' THEN
  IF NOT EXISTS(SELECT 1 FROM session_messages WHERE workspace_id=w AND session_id=s AND id=p)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(sources) node WHERE node->>'resourceKind'='session_message' AND node->>'resourceId'=p::text) THEN
   RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
  SELECT scope_revision_id INTO previous FROM session_message_annotation_heads WHERE workspace_id=w AND session_id=s AND message_id=p;
  IF previous IS DISTINCT FROM expected_revision THEN RETURN NULL;END IF;
 ELSIF k='session_state' THEN
  SELECT scope_revision_id INTO previous FROM session_state WHERE id=p AND session_id=s;
  IF FOUND THEN IF previous IS DISTINCT FROM expected_revision THEN RETURN NULL;END IF;
  ELSIF expected_revision IS NOT NULL OR expected_generation IS NULL THEN RETURN NULL;END IF;
 ELSE
  IF expected_revision IS NOT NULL OR EXISTS(SELECT 1 FROM episodic_memories WHERE id=p) THEN RETURN NULL;END IF;
 END IF;
 floor_tier:=parent->>'sensitivity';teams:=ARRAY(SELECT jsonb_array_elements_text(parent->'compartments'));
 projects:=ARRAY(SELECT jsonb_array_elements_text(parent->'projectIds')::uuid);
 FOR source IN SELECT value FROM jsonb_array_elements(sources) ORDER BY value->>'resourceKind',value->>'resourceId' LOOP
  IF entity_derivation_envelope_valid(source) IS NOT TRUE OR source->>'workspaceId' IS DISTINCT FROM w::text
   OR source->>'userId' IS NOT NULL AND source->>'userId' IS DISTINCT FROM actor::text THEN
   RAISE EXCEPTION 'scope_visibility_incompatible' USING ERRCODE='22023';END IF;
  IF source->>'resourceKind'='application_field' THEN
   evaluated:=application_session_eval_field(w,(source->>'resourceId')::uuid,source->>'version',memo);memo:=coalesce(evaluated->'memo',memo);current_source:=evaluated->'value';
  ELSIF source->>'resourceKind'='external_source' THEN
   current_source:=external_source_snapshot(w,(source->>'resourceId')::uuid);
   IF external_source_retention_allowed(w,(source->>'resourceId')::uuid,source->>'version') IS NOT TRUE THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  ELSE current_source:=read_admitted_native_scope_snapshot(w,source->>'resourceKind',(source->>'resourceId')::uuid);END IF;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR current_source->>'version' IS DISTINCT FROM source->>'version'
   OR current_source->>'validTo' IS NOT NULL OR current_source->>'retractedAt' IS NOT NULL
   OR (current_source->'workspaceId',current_source->'userId',current_source->'assistantId',current_source->'sensitivity')
    IS DISTINCT FROM (source->'workspaceId',source->'userId',source->'assistantId',source->'sensitivity')
   OR NOT (current_source->'compartments')@>(source->'compartments') OR NOT (source->'compartments')@>(current_source->'compartments')
   OR NOT (current_source->'projectIds')@>(source->'projectIds') OR NOT (source->'projectIds')@>(current_source->'projectIds') THEN
   RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF sensitivity_rank(source->>'sensitivity')>sensitivity_rank(floor_tier) THEN floor_tier:=source->>'sensitivity';END IF;
  teams:=ARRAY(SELECT DISTINCT item FROM unnest(teams||ARRAY(SELECT jsonb_array_elements_text(source->'compartments'))) item ORDER BY item);
  projects:=ARRAY(SELECT DISTINCT item FROM unnest(projects||ARRAY(SELECT jsonb_array_elements_text(source->'projectIds')::uuid)) item ORDER BY item);
 END LOOP;
 IF member_operation_scope_allows(w,floor_tier,teams,true) IS NOT TRUE OR agent_mutation_scope_allows(teams) IS NOT TRUE
  OR agent_read_scope_allows(floor_tier,teams,projects) IS NOT TRUE THEN
  RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 INSERT INTO session_context_scope_revisions(id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,payload_sha256)
  VALUES(i,w,s,k,p,(parent->>'userId')::uuid,NULL,floor_tier,teams,projects,encode(sha256(convert_to(payload::text,'UTF8')),'hex')) RETURNING created_at INTO created;
 INSERT INTO session_context_revision_contents(workspace_id,revision_id,content) VALUES(w,i,payload);
 IF k='session_state' THEN
  INSERT INTO session_state(id,session_id,user_id,assistant_id,key,status,summary,detail,source,scope_revision_id)
   VALUES(p,s,target.user_id,target.assistant_id,p::text,'open','',NULL,'tool',i)
   ON CONFLICT(id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id,updated_at=now();
 ELSIF k='episodic_memory' THEN
  INSERT INTO episodic_memories(id,user_id,assistant_id,session_id,topic_label,summary,message_span,scope_revision_id)
   VALUES(p,target.user_id,target.assistant_id,s,'','','{}',i);
 ELSIF k='message_annotation' THEN
  INSERT INTO session_message_annotation_heads(message_id,workspace_id,session_id,scope_revision_id) VALUES(p,w,s,i)
   ON CONFLICT(message_id) DO UPDATE SET scope_revision_id=EXCLUDED.scope_revision_id;
 ELSE
  UPDATE sessions SET compact_summary=NULL,compact_scope_revision_id=i,compact_boundary_sequence=(payload->>'boundarySequence')::integer,
   compaction_count=compaction_count+1,last_compacted_at=now() WHERE workspace_id=w AND id=s;
 END IF;
 UPDATE sessions SET session_context_generation=session_context_generation+1 WHERE workspace_id=w AND id=s;
 INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
 INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
  SELECT w,'session_context_revision',i,'1',producer,(parent->>'userId')::uuid,NULL,floor_tier,teams,projects,revision FROM workspace_access_policies WHERE workspace_id=w RETURNING id INTO derivation;
 INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
  SELECT w,derivation,node->>'resourceKind',(node->>'resourceId')::uuid,node->>'version' FROM jsonb_array_elements(sources) node ORDER BY node->>'resourceKind',node->>'resourceId';
 RETURN jsonb_build_object('source',jsonb_build_object('workspaceId',w,'resourceKind','session_context_revision','resourceId',i,'version','1',
  'userId',parent->'userId','assistantId',NULL,'sensitivity',floor_tier,'compartments',teams,'projectIds',projects),
  'createdAt',created,'userId',target.user_id,'assistantId',target.assistant_id);
END $$;
REVOKE ALL ON FUNCTION publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  GRANT EXECUTE ON FUNCTION lock_native_session_context_publication(uuid,uuid),publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer) TO app_user;
 END IF;
END $$;
-- Private call-local visitor. No caller may supply or retain its worklist.
CREATE FUNCTION application_session_eval_sources_current(w uuid,refs jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE dependency jsonb;current_source jsonb;
BEGIN
 IF jsonb_typeof(refs) IS DISTINCT FROM 'array' OR jsonb_array_length(refs)>4096 THEN RETURN false;END IF;
 FOR dependency IN SELECT value FROM jsonb_array_elements(refs) LOOP
  IF jsonb_typeof(dependency) IS DISTINCT FROM 'object' OR NOT dependency ?& ARRAY['id','version']
   OR dependency-ARRAY['id','version']<>'{}' OR jsonb_typeof(dependency->'version') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
  current_source:=external_source_snapshot(w,(dependency->>'id')::uuid);
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR current_source->>'version' IS DISTINCT FROM dependency->>'version' THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION application_session_eval_sources_current(uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION application_session_eval_scope(w uuid,k text,i uuid,v text,memo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE key text:='native:'||k||':'||i||':'||v;nodes jsonb;node jsonb;refs jsonb:='[]';current_source jsonb;result jsonb;dependency record;policy jsonb;mask jsonb;type_key text;
BEGIN
 IF memo ? key THEN
  IF memo#>>ARRAY[key,'busy']='true' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  RETURN jsonb_build_object('value',memo#>ARRAY[key,'value']='true'::jsonb AND application_session_eval_sources_current(w,memo#>ARRAY[key,'external']),'memo',memo);
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(memo))>=4096 THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
 memo:=memo||jsonb_build_object(key,jsonb_build_object('busy',true));
 SELECT coalesce(jsonb_agg(to_jsonb(n)),'[]') INTO nodes FROM application_scope_lineage(w,ARRAY[k],ARRAY[i],ARRAY[v]) n;
 FOR node IN SELECT value FROM jsonb_array_elements(nodes) ORDER BY value->>'kind',value->>'id',value->>'version' LOOP
  IF node->>'kind'='application_field' THEN
   result:=application_session_eval_field(w,(node->>'id')::uuid,node->>'version',memo);memo:=result->'memo';current_source:=result->'value';
   refs:=refs||coalesce(memo#>ARRAY['field:'||(node->>'id')||':'||(node->>'version'),'external'],'[]'::jsonb);
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  ELSIF node->>'kind'='external_source' THEN
   refs:=refs||jsonb_build_array(jsonb_build_object('id',node->'id','version',node->'version'));
   current_source:=external_source_snapshot(w,(node->>'id')::uuid);
   IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false' OR current_source->>'version' IS DISTINCT FROM node->>'version' THEN
    RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  ELSIF scope_source_table(node->>'kind') IS NOT NULL THEN
   IF node->>'kind'='session_context_revision' AND read_entity_derivation_source(w,node->>'kind',(node->>'id')::uuid) IS NULL THEN
    RETURN jsonb_build_object('value',false,'memo',memo);END IF;
   current_source:=read_admitted_native_scope_snapshot(w,node->>'kind',(node->>'id')::uuid);
   IF node->>'kind' IN('crm_event','session_context_revision') AND current_source IS NULL
    OR current_source IS NOT NULL AND current_source->>'held' IS DISTINCT FROM 'false' THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  END IF;
 END LOOP;
 FOR dependency IN SELECT DISTINCT d.* FROM scope_derivations d JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid WHERE d.workspace_id=w LOOP
  IF nullif(current_setting('app.application_id',true),'') IS NOT NULL OR workflow_evidence_envelope_visible(w,jsonb_build_object('workspaceId',w,
   'userId',dependency.user_id,'assistantId',dependency.assistant_id,'sensitivity',dependency.sensitivity,
   'compartments',dependency.compartments,'projectIds',dependency.project_ids)) IS NOT TRUE THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
 END LOOP;
 -- An explicit raw entity source consumes the complete current field mask,
 -- unlike the selected native anchors of a field projection.
 FOR dependency IN SELECT DISTINCT edge.source_id FROM scope_derivation_sources edge JOIN scope_derivations d
  ON d.workspace_id=edge.workspace_id AND d.id=edge.derivation_id JOIN jsonb_array_elements(nodes) ancestor(value)
  ON d.resource_kind=ancestor.value->>'kind' AND d.resource_id=(ancestor.value->>'id')::uuid
  WHERE d.workspace_id=w AND edge.source_kind='entity' LOOP
  SELECT kind INTO type_key FROM entities WHERE workspace_id=w AND id=dependency.source_id;
  IF NOT FOUND OR type_key NOT IN('company','person','deal') THEN CONTINUE;END IF;
  policy:=application_native_field_contract_for(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id::text);
  IF policy->>'registered' IS DISTINCT FROM 'false' THEN
   mask:=application_current_native_field_policy(w,'{"kind":"native","moduleKey":"native"}',type_key,dependency.source_id);
   IF policy->>'registered' IS DISTINCT FROM 'true' OR policy->>'held' IS DISTINCT FROM 'false' OR mask->>'held' IS DISTINCT FROM 'false'
    OR NOT coalesce(policy#>'{metadata,fieldKeys}'<@(mask->'readFields'),false) THEN RETURN jsonb_build_object('value',false,'memo',memo);END IF;
  END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO refs FROM (SELECT DISTINCT value FROM jsonb_array_elements(refs)) unique_refs;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n JOIN application_field_resources f ON f.workspace_id=w AND f.id=(n->>'id')::uuid
  WHERE n->>'kind'='application_field' AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key NOT IN('session_message','session_message_annotation'))) THEN
  memo:=memo-key;
 ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',true,'external',refs)); END IF;RETURN jsonb_build_object('value',true,'memo',memo);
END $$;
REVOKE ALL ON FUNCTION application_session_eval_scope(uuid,text,uuid,text,jsonb) FROM PUBLIC;

CREATE FUNCTION application_session_eval_point_state(w uuid,t text,i uuid,fields text[],memo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m session_messages;revision session_context_scope_revisions;source jsonb;parent jsonb;payload jsonb;values_json jsonb;selected jsonb;
 keys text[]:=application_session_field_keys(t);record_version text;source_kind text;source_id uuid;checked jsonb;
BEGIN
 IF keys IS NULL OR fields IS NULL OR cardinality(fields)>cardinality(keys) OR NOT fields<@keys
  OR array_position(fields,NULL) IS NOT NULL OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL THEN RETURN NULL;END IF;
 -- Only immutable identity/scope metadata is selected before source admission.
 SELECT id,workspace_id,session_id,scope_version,sequence_num INTO m.id,m.workspace_id,m.session_id,m.scope_version,m.sequence_num
  FROM session_messages WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN NULL;END IF;
 parent:=application_session_query_parent(w,m.session_id);IF parent IS NULL THEN RETURN NULL;END IF;
 IF t='session_message' THEN
  source:=read_admitted_native_scope_snapshot(w,'session_message',i);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' OR source->>'version' IS DISTINCT FROM m.scope_version::text
    THEN RETURN NULL;END IF;
  checked:=application_session_eval_scope(w,'session_message',i,m.scope_version::text,memo);memo:=checked->'memo';
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('memo',memo);END IF;
  SELECT jsonb_build_object('id',id,'role',role,'content',content,'sequenceNum',sequence_num,'createdAt',created_at,
   'senderUserId',sender_user_id,'senderAssistantId',sender_assistant_id,'channelMessageId',channel_message_id,'attachments',attachments) INTO values_json
   FROM session_messages WHERE workspace_id=w AND id=i AND scope_version=m.scope_version;
  IF values_json IS NULL THEN RETURN NULL;END IF;
  source_kind:='session_message';source_id:=i;
  -- Selected payload changes remain distinct even when an old native writer
  -- changed text without advancing its scope envelope version.
  record_version:=m.scope_version::text||':'||application_field_digest(values_json);
 ELSE
  SELECT r.* INTO revision FROM session_message_annotation_heads h JOIN session_context_scope_revisions r
   ON r.workspace_id=h.workspace_id AND r.id=h.scope_revision_id
   WHERE h.workspace_id=w AND h.session_id=m.session_id AND h.message_id=i AND r.parent_kind='message_annotation'
    AND r.parent_id=i AND r.session_id=m.session_id;
  IF NOT FOUND THEN RETURN NULL;END IF;
  checked:=application_session_eval_scope(w,'session_context_revision',revision.id,'1',memo);memo:=checked->'memo';
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('memo',memo);END IF;
  source:=session_context_revision_native(w,revision.id);
  IF source IS NULL OR source->>'held' IS DISTINCT FROM 'false' THEN RETURN NULL;END IF;
  SELECT content INTO payload FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=revision.id;
  IF payload IS NULL THEN RETURN NULL;END IF;
  values_json:=jsonb_build_object('id',i,'sequenceNum',m.sequence_num,'topicLabel',payload->'topicLabel',
   'topicConfidence',payload->'topicConfidence','replyToText',payload->'replyToText');
  source_kind:='session_context_revision';source_id:=revision.id;record_version:=revision.id::text;
 END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO selected FROM jsonb_each(values_json) WHERE key=ANY(fields);
 RETURN jsonb_build_object('memo',memo,'value',jsonb_build_object('values',selected,'source',source,'recordVersion',record_version,
  'sourceKind',source_kind,'sourceId',source_id,'sourceVersion',source->>'version','ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_field_v1','type',t,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_field_v1','parent',parent->'fingerprint','fields',fields)),
  'references','[]'::jsonb));
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION application_session_eval_point_state(uuid,text,uuid,text[],jsonb) FROM PUBLIC;

CREATE FUNCTION application_session_eval_scan(w uuid,s uuid,t text,through integer,fields text[],bounds jsonb,visibility jsonb,memo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE candidate record;result jsonb;point jsonb;parent jsonb;candidates jsonb:='[]';points jsonb:='[]';policies jsonb:='[]';children jsonb:='[]';attempts integer:=0;
BEGIN
 parent:=application_session_query_parent(w,s);
 IF parent IS NULL OR through IS NULL OR through<0 OR application_session_field_keys(t) IS NULL OR fields IS NULL
  OR NOT fields<@application_session_field_keys(t) OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR application_query_scope_valid(bounds) IS NOT TRUE OR jsonb_typeof(visibility) IS DISTINCT FROM 'object'
  OR visibility-ARRAY['userId','assistants']<>'{}' OR NOT visibility ?& ARRAY['userId','assistants'] THEN RETURN jsonb_build_object('memo',memo);END IF;
 FOR candidate IN SELECT id,sequence_num FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num<=through ORDER BY sequence_num,id LOOP
  attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  result:=application_session_eval_envelope(w,t,candidate.id,'query',fields,memo);memo:=coalesce(result->'memo',memo);point:=result->'value';
  IF point IS NULL OR point='null'::jsonb OR application_query_scope_admits_point(bounds,point->'source') IS NOT TRUE
   OR point#>>'{source,userId}' IS NOT NULL AND point#>>'{source,userId}' IS DISTINCT FROM visibility->>'userId'
   OR point#>>'{source,assistantId}' IS NOT NULL AND visibility->'assistants'<>'null'::jsonb
    AND NOT coalesce(visibility->'assistants' ? (point#>>'{source,assistantId}'),false) THEN CONTINUE;END IF;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',point#>'{state,recordVersion}'));
  points:=points||jsonb_build_array(jsonb_build_object('id',candidate.id,'version',point#>'{state,recordVersion}','fields',fields,'source',point->'source'));
  policies:=policies||jsonb_build_array(jsonb_build_object('id',candidate.id,'policy',point#>'{state,policyVersion}'));
  children:=children||jsonb_build_array(point);
 END LOOP;
 RETURN jsonb_build_object('memo',memo,'value',jsonb_build_object('parent',parent,'candidates',candidates,'points',points,'policies',policies),'children',children);
END $$;
REVOKE ALL ON FUNCTION application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION application_session_eval_domain(w uuid,t text,i uuid,fields text[],memo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains;parent jsonb;current_bounds jsonb;visibility jsonb;result jsonb;scanned jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;state jsonb;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i AND origin='{"kind":"native","moduleKey":"native"}' AND type_key=t;
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'session_query_domain_v1'
  OR frozen.domain-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']<>'{}'
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields) THEN RETURN jsonb_build_object('memo',memo);END IF;
 parent:=application_session_query_parent(w,(frozen.domain->>'sessionId')::uuid);
 IF parent IS NULL OR parent->'fingerprint' IS DISTINCT FROM frozen.domain->'parentFingerprint' THEN RETURN jsonb_build_object('memo',memo);END IF;
 current_bounds:=application_session_query_bounds(w,parent);
 IF current_bounds IS NULL OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(current_bounds),4096)->>'contains' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('memo',memo);END IF;
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 IF frozen.domain#>>'{visibility,userId}' IS NOT NULL AND frozen.domain#>>'{visibility,userId}' IS DISTINCT FROM visibility->>'userId'
  OR visibility->'assistants'<>'null'::jsonb AND (frozen.domain#>'{visibility,assistants}'='null'::jsonb
   OR NOT coalesce(frozen.domain#>'{visibility,assistants}'<@(visibility->'assistants'),false)) THEN RETURN jsonb_build_object('memo',memo);END IF;
 result:=application_session_eval_scan(w,(frozen.domain->>'sessionId')::uuid,t,(frozen.domain->>'throughSequence')::integer,fields,frozen.domain->'bounds',frozen.domain->'visibility',memo);
 memo:=coalesce(result->'memo',memo);scanned:=result->'value';
 IF scanned IS NULL OR scanned->'candidates' IS DISTINCT FROM frozen.domain->'candidates' OR scanned->'points' IS DISTINCT FROM frozen.domain->'points' THEN RETURN jsonb_build_object('memo',memo);END IF;
 state:=jsonb_build_object('values','{}'::jsonb,'source',parent->'scope','recordVersion','1',
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','session_query_domain_v1','identity',frozen.identity,'policies',scanned->'policies')),
  'references','[]'::jsonb,'queryPoints',frozen.domain->'points');
 RETURN jsonb_build_object('value',state,'memo',memo,'children',result->'children');
END $$;
REVOKE ALL ON FUNCTION application_session_eval_domain(uuid,text,uuid,text[],jsonb) FROM PUBLIC;

-- The closed no-reference vocabulary uses the canonical field digest algebra.
-- This private function accepts no caller-provided state or admission decision.
CREATE FUNCTION application_session_eval_envelope(w uuid,t text,i uuid,selection text,fields text[],memo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;state jsonb;scope jsonb;identity_value text;resource uuid;version_value text;sources jsonb:='[]';children jsonb:='[]';child jsonb;external record;keys text[];
 origin constant jsonb:='{"kind":"native","moduleKey":"native"}';
BEGIN
 IF t NOT IN('session_message','session_message_annotation') OR selection NOT IN('read','query','identity','query_domain') THEN RETURN jsonb_build_object('memo',memo);END IF;
 keys:=ARRAY(SELECT DISTINCT key FROM unnest(fields) key ORDER BY key);
 IF fields IS NULL OR cardinality(keys)<>cardinality(fields) THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF selection='query_domain' THEN result:=application_session_eval_domain(w,t,i,keys,memo);children:=coalesce(result->'children','[]'::jsonb);
 ELSE result:=application_session_eval_point_state(w,t,i,keys,memo);END IF;
 memo:=coalesce(result->'memo',memo);state:=result->'value';
 IF state IS NULL OR state='null'::jsonb THEN RETURN jsonb_build_object('memo',memo);END IF;
 scope:=jsonb_build_object('workspaceId',w,'userId',state#>'{source,userId}','assistantId',state#>'{source,assistantId}',
  'sensitivity',state#>'{source,sensitivity}','compartments',state#>'{source,compartments}','projectIds',state#>'{source,projectIds}');
 IF entity_derivation_envelope_valid(scope) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
 identity_value:=application_field_digest(jsonb_build_object('workspaceId',w,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity'));
 resource:=application_field_resource_uuid(identity_value);
 FOR external IN SELECT * FROM read_external_source_dependencies(w,ARRAY[state->>'sourceKind'],ARRAY[(state->>'sourceId')::uuid],ARRAY[state->>'sourceVersion']) LOOP
  IF external.source IS NULL OR external.source->>'workspaceId' IS DISTINCT FROM w::text OR external.node_version IS DISTINCT FROM external.source->>'version' THEN RETURN jsonb_build_object('memo',memo);END IF;
  sources:=sources||jsonb_build_array(external.source);
 END LOOP;
 FOR child IN SELECT value FROM jsonb_array_elements(children) LOOP
  sources:=sources||jsonb_build_array(child->'source')||coalesce(child->'sources','[]');
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (SELECT DISTINCT value FROM jsonb_array_elements(sources)) unique_sources;
 IF jsonb_array_length(sources)>4096 OR jsonb_array_length(children)>4096 THEN RETURN jsonb_build_object('memo',memo);END IF;
 version_value:=application_field_digest(jsonb_build_object('resourceId',resource,'recordVersion',state->'recordVersion',
  'sourceVersion',state->'sourceVersion','policyVersion',state->'policyVersion','scope',scope,'sources',sources));
 RETURN jsonb_build_object('memo',memo,'value',jsonb_build_object('resourceId',resource,'identity',identity_value,'origin',origin,'typeKey',t,'id',i,
  'selection',selection,'selectedVersion',NULL,'fields',keys,'fieldIdentity',state->'fieldIdentity','state',state,'children',children,'sources',sources,
  'source',scope||jsonb_build_object('resourceKind','application_field','resourceId',resource,'version',version_value)));
END $$;
REVOKE ALL ON FUNCTION application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb) FROM PUBLIC;

CREATE FUNCTION application_session_eval_field(w uuid,i uuid,v text,memo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE key text:='field:'||i||':'||v;resource application_field_resources;observation application_field_observations;result jsonb;envelope jsonb;current_source jsonb;dependency record;refs jsonb:='[]';
BEGIN
 IF memo ? key THEN
  IF memo#>>ARRAY[key,'busy']='true' OR scope_review_state_held('application_field',i)
   OR application_session_eval_sources_current(w,memo#>ARRAY[key,'external']) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
  RETURN jsonb_build_object('memo',memo,'value',memo#>ARRAY[key,'value']);
 END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(memo))>=4096 OR scope_review_state_held('application_field',i) THEN RETURN jsonb_build_object('memo',memo);END IF;
 SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=i;
 IF NOT FOUND THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF resource.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR resource.type_key NOT IN('session_message','session_message_annotation') THEN
  current_source:=application_recorded_field_state_before_session_eval(w,i,v,0);
  RETURN jsonb_build_object('value',current_source,'memo',memo);
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class tab ON tab.oid='session_messages'::regclass WHERE role.rolname=session_user
  AND (role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,tab.relowner,'USAGE'))) THEN RETURN jsonb_build_object('memo',memo);END IF;
 SELECT * INTO observation FROM application_field_observations WHERE workspace_id=w AND resource_id=i AND version=v;
 IF NOT FOUND OR resource.selected_version IS NOT NULL THEN RETURN jsonb_build_object('memo',memo);END IF;
 memo:=memo||jsonb_build_object(key,jsonb_build_object('busy',true));
 result:=application_session_eval_envelope(w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo);
 memo:=coalesce(result->'memo',memo);envelope:=result->'value';
 IF envelope IS NULL OR envelope->>'identity' IS DISTINCT FROM resource.identity OR envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
  OR workflow_evidence_envelope_visible(w,observation.source_scope) IS NOT TRUE OR workflow_evidence_envelope_visible(w,envelope->'source') IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
 FOR dependency IN SELECT * FROM application_field_observation_sources WHERE workspace_id=w AND resource_id=i AND version=v ORDER BY source_kind,source_id,source_version LOOP
  IF dependency.source_kind='application_field' THEN
   result:=application_session_eval_field(w,dependency.source_id,dependency.source_version,memo);memo:=coalesce(result->'memo',memo);current_source:=result->'value';
  ELSE current_source:=external_source_snapshot(w,dependency.source_id);END IF;
  IF current_source IS NULL OR current_source->>'held' IS DISTINCT FROM 'false'
   OR dependency.source_kind='external_source' AND current_source->>'version' IS DISTINCT FROM dependency.source_version THEN RETURN jsonb_build_object('memo',memo);END IF;
 END LOOP;
 current_source:=(envelope->'source')||jsonb_build_object('held',false,'validTo',NULL,'retractedAt',NULL);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',source->'resourceId','version',source->'version') ORDER BY source::text),'[]') INTO refs
  FROM jsonb_array_elements(envelope->'sources') source WHERE source->>'resourceKind'='external_source';
 IF EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY['application_field'],ARRAY[i],ARRAY[v]) n JOIN application_field_resources f
  ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
   AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key NOT IN('session_message','session_message_annotation'))) THEN
  memo:=memo-key;
 ELSE memo:=memo||jsonb_build_object(key,jsonb_build_object('value',current_source,'external',refs)); END IF;RETURN jsonb_build_object('memo',memo,'value',current_source);
END $$;
REVOKE ALL ON FUNCTION application_session_eval_field(uuid,uuid,text,jsonb) FROM PUBLIC;

ALTER FUNCTION application_recorded_field_state(uuid,uuid,text,integer) RENAME TO application_recorded_field_state_before_session_eval;
REVOKE ALL ON FUNCTION application_recorded_field_state_before_session_eval(uuid,uuid,text,integer) FROM PUBLIC;
CREATE FUNCTION application_recorded_field_state(w uuid,i uuid,v text,depth integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE resource application_field_resources;result jsonb;
BEGIN
 SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=i;
 IF NOT FOUND OR resource.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR resource.type_key NOT IN('session_message','session_message_annotation') THEN
  RETURN application_recorded_field_state_before_session_eval(w,i,v,depth);END IF;
 IF depth NOT BETWEEN 0 AND 3 OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='session_messages'::regclass WHERE r.rolname=session_user
  AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RETURN '{"held":true}';END IF;
 result:=application_session_eval_field(w,i,v,'{}');RETURN coalesce(result->'value','{"held":true}');
END $$;
REVOKE ALL ON FUNCTION application_recorded_field_state(uuid,uuid,text,integer) FROM PUBLIC;

ALTER FUNCTION application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer) RENAME TO application_compute_field_envelope_before_session_eval;
REVOKE ALL ON FUNCTION application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer) FROM PUBLIC;
CREATE FUNCTION application_compute_field_envelope(w uuid,p_origin jsonb,p_type text,p_id uuid,p_selection text,p_selected_version text,p_fields text[],depth integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF p_origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR p_type NOT IN('session_message','session_message_annotation') THEN
  RETURN application_compute_field_envelope_before_session_eval(w,p_origin,p_type,p_id,p_selection,p_selected_version,p_fields,depth);END IF;
 IF depth NOT BETWEEN 0 AND 2 OR p_selection='query_domain' AND depth>1 OR p_selected_version IS NOT NULL THEN RETURN NULL;END IF;
 result:=application_session_eval_envelope(w,p_type,p_id,p_selection,p_fields,'{}');RETURN result->'value';
END $$;
REVOKE ALL ON FUNCTION application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION application_session_eval_sources_current(uuid,jsonb),application_session_eval_scope(uuid,text,uuid,text,jsonb),
   application_session_eval_point_state(uuid,text,uuid,text[],jsonb),application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb),
   application_session_eval_domain(uuid,text,uuid,text[],jsonb),application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb),
   application_session_eval_field(uuid,uuid,text,jsonb),application_recorded_field_state_before_session_eval(uuid,uuid,text,integer),
   application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer) FROM app_user;
 END IF;
END $$;
-- Only the new closed session types share an evaluation. Existing resources
-- keep the exact individual R2 facade and its complete current checks.
CREATE FUNCTION read_native_session_field_snapshots(w uuid,ids uuid[],versions text[]) RETURNS TABLE(ord integer,snapshot jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE position integer;memo jsonb:='{}';result jsonb;resource application_field_resources;
BEGIN
 IF ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 4096 OR cardinality(ids)<>cardinality(versions)
  OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 FOR position IN 1..cardinality(ids) LOOP
  SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=ids[position];
  IF FOUND AND resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key IN('session_message','session_message_annotation') THEN
   result:=application_session_eval_field(w,ids[position],versions[position],memo);memo:=coalesce(result->'memo',memo);snapshot:=coalesce(result->'value','{"held":true}'::jsonb);
  ELSE snapshot:=read_admitted_application_field_snapshot(w,ids[position],versions[position]);END IF;
  ord:=position;RETURN NEXT;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION read_native_session_field_snapshots(uuid,uuid[],text[]) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_native_session_field_snapshots(uuid,uuid[],text[]) TO app_user;END IF;
END $$;
-- The existing shared validator is unchanged. Only a dependency set consisting
-- entirely of the new closed session fields uses this native read-only batch.
CREATE FUNCTION read_native_session_field_dependencies(w uuid,kinds text[],ids uuid[],versions text[])
RETURNS TABLE(node_version text,source jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE dependency record;item jsonb;rows_json jsonb:='[]';memo jsonb:='{}';result jsonb;admitted jsonb;native_only boolean:=true;belongs boolean;
BEGIN
 FOR dependency IN SELECT * FROM read_application_field_dependencies(w,kinds,ids,versions) LOOP
  SELECT origin='{"kind":"native","moduleKey":"native"}'::jsonb AND type_key IN('session_message','session_message_annotation') INTO belongs
   FROM application_field_resources WHERE workspace_id=w AND id=(dependency.source->>'resourceId')::uuid;
  IF belongs IS DISTINCT FROM true THEN native_only:=false;END IF;
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
 END LOOP;
 IF NOT native_only THEN RETURN QUERY SELECT * FROM read_admitted_application_field_dependencies(w,kinds,ids,versions);RETURN;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(rows_json) LOOP
  result:=application_session_eval_field(w,(item#>>'{source,resourceId}')::uuid,item->>'version',memo);memo:=coalesce(result->'memo',memo);admitted:=result->'value';
  IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(rows_json);
END $$;
REVOKE ALL ON FUNCTION read_native_session_field_dependencies(uuid,text[],uuid[],text[]) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_native_session_field_dependencies(uuid,text[],uuid[],text[]) TO app_user;END IF;
END $$;
COMMIT;
