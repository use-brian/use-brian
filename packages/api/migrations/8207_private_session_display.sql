BEGIN;
-- [COMP:api/session-display-history] Human display is not current model evidence.
-- All relaxed evaluation is private to this call graph. Canonical readers,
-- observations, source tuples and stored conversations remain unchanged.

CREATE FUNCTION private_session_display_memory_domain(w uuid,i uuid,fields text[],memo jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE frozen application_query_domains;context jsonb;candidate jsonb;state jsonb;
 candidates jsonb:='[]';policies jsonb:='[]';selected_policy jsonb;seen uuid[]:='{}';candidate_id uuid;
BEGIN
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=i
  AND origin='{"kind":"native","moduleKey":"native"}' AND type_key='memory';
 IF NOT FOUND OR frozen.domain->>'kind' IS DISTINCT FROM 'memory_query_domain_v1'
  OR frozen.domain-ARRAY['kind','fields','bounds','visibility','includeRetained','candidates','policies']<>'{}'
  OR frozen.domain->'fields' IS DISTINCT FROM to_jsonb(fields)
  OR jsonb_typeof(frozen.domain->'candidates') IS DISTINCT FROM 'array'
  OR jsonb_typeof(frozen.domain->'policies') IS DISTINCT FROM 'array'
  OR jsonb_typeof(frozen.domain->'includeRetained') IS DISTINCT FROM 'boolean'
  OR jsonb_array_length(frozen.domain->'candidates')>4096 THEN RETURN NULL;END IF;
 context:=application_memory_query_context(w);
 IF context IS NULL OR context#>>'{policy,metadata,schemaVersion}' IS DISTINCT FROM frozen.schema_version
  OR NOT coalesce(to_jsonb(fields)<@(context->'read'),false)
  OR application_query_scope_union_contains(frozen.domain->'bounds',jsonb_build_array(context->'bounds'),4096)->>'contains' IS DISTINCT FROM 'true'
  OR frozen.domain->'visibility' IS DISTINCT FROM context->'visibility' THEN RETURN NULL;END IF;
 -- The original cohort is historical evidence. Newly added candidates cannot
 -- change its old bytes; every original positive candidate still must qualify.
 FOR candidate IN SELECT value FROM jsonb_array_elements(frozen.domain->'candidates') LOOP
  IF jsonb_typeof(candidate) IS DISTINCT FROM 'object' OR candidate-ARRAY['id','version','source']<>'{}'
   OR NOT candidate ?& ARRAY['id','version','source'] OR jsonb_typeof(candidate->'version') IS DISTINCT FROM 'string' THEN RETURN NULL;END IF;
  candidate_id:=(candidate->>'id')::uuid;
  IF candidate_id=ANY(seen) THEN RETURN NULL;END IF;seen:=array_append(seen,candidate_id);
  IF NOT (frozen.domain->>'includeRetained')::boolean AND EXISTS(
   SELECT 1 FROM scope_derivations WHERE workspace_id=w AND resource_kind='memory' AND resource_id=candidate_id) THEN RETURN NULL;END IF;
  IF EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=candidate_id AND valid_to IS NOT NULL) THEN
   -- Authentic successor history keeps its complete canonical restrictions.
   state:=application_memory_field_state(w,candidate_id,fields);
  ELSE state:=private_session_display_memory_state(w,candidate_id,fields,memo);END IF;
  IF state IS NULL OR state->>'recordVersion' IS DISTINCT FROM candidate->>'version'
   OR state->'source' IS DISTINCT FROM candidate->'source'
   OR application_query_scope_admits_point(frozen.domain->'bounds',state->'source') IS NOT TRUE THEN RETURN NULL;END IF;
  selected_policy:=CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(frozen.domain->'policies') p
   WHERE p->>'id'=candidate_id::text AND p->'policy'=state->'legacyPolicyVersion')
   THEN state->'legacyPolicyVersion' ELSE state->'policyVersion' END;
  candidates:=candidates||jsonb_build_array(jsonb_build_object('id',candidate_id,'version',state->'recordVersion','source',state->'source'));
  policies:=policies||jsonb_build_array(jsonb_build_object('id',candidate_id,'policy',selected_policy));
 END LOOP;
 IF candidates IS DISTINCT FROM frozen.domain->'candidates' OR policies IS DISTINCT FROM frozen.domain->'policies' THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('values','{}'::jsonb,'source',context#>'{policy,metadata,scope}','recordVersion',frozen.schema_version,
  'sourceKind','application_query_domain','sourceId',i,'sourceVersion',frozen.identity,'ownerId',NULL,
  'fieldIdentity',application_field_digest(jsonb_build_object('kind','memory_query_domain_v1','identity',frozen.identity,'fields',fields)),
  'policyVersion',application_field_digest(jsonb_build_object('kind','memory_query_domain_v1','identity',frozen.identity,'policy',context#>'{policy,fingerprint}','policies',policies)),
  'references','[]'::jsonb);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION private_session_display_memory_domain(uuid,uuid,text[],jsonb) FROM PUBLIC;

-- Clone current canonical bodies, preserving intervening migration protections.
-- Every recursive native call remains in this private human-purpose graph.
DO $display_clones$
DECLARE names text[]:=ARRAY['scope','field','point_state','domain','envelope','scan'];
 suffix text;definition text;before text;after text;signature text;replacement text;occurrences integer;
BEGIN
 FOREACH suffix IN ARRAY names LOOP
  signature:=CASE suffix
   WHEN 'scope' THEN 'uuid,text,uuid,text,jsonb'
   WHEN 'field' THEN 'uuid,uuid,text,jsonb'
   WHEN 'point_state' THEN 'uuid,text,uuid,text[],jsonb'
   WHEN 'domain' THEN 'uuid,text,uuid,text[],jsonb'
   WHEN 'envelope' THEN 'uuid,text,uuid,text,text[],jsonb'
   WHEN 'scan' THEN 'uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb' END;
  definition:=pg_get_functiondef(('public.application_session_eval_'||suffix||'('||signature||')')::regprocedure);
  FOREACH replacement IN ARRAY names LOOP
   definition:=replace(definition,'application_session_eval_'||replacement||'(', 'private_session_display_eval_'||replacement||'(');
  END LOOP;
  IF suffix IN('field','envelope') THEN
   before:='NOT IN(''session_message'',''session_message_annotation'')';
   occurrences:=array_length(string_to_array(definition,before),1)-1;
   IF occurrences<1 THEN RAISE EXCEPTION 'Private display native vocabulary changed: %',suffix;END IF;
   definition:=replace(definition,before,'NOT IN(''session_message'',''session_message_annotation'',''memory'')');
  END IF;
  IF suffix='scope' THEN
   before:='SELECT coalesce(jsonb_agg(to_jsonb(n)),''[]'') INTO nodes FROM application_scope_lineage(w,ARRAY[k],ARRAY[i],ARRAY[v]) n;';
   IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Private display lineage changed';END IF;
   definition:=replace(definition,before,before||'
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>''kind'' NOT IN(''application_field'',''application_query_domain'',''session_message'',''session_context_revision'',''memory'',''workspace_file''))
 THEN RETURN jsonb_build_object(''value'',false,''memo'',memo);END IF;
 PERFORM s.resource_id FROM scope_resource_states s JOIN jsonb_array_elements(nodes) n
  ON s.resource_kind=n->>''kind'' AND s.resource_id=(n->>''id'')::uuid
  WHERE s.workspace_id=w ORDER BY s.resource_kind,s.resource_id,s.resource_version FOR SHARE OF s NOWAIT;');
   before:='IF node->>''kind'' IN(''crm_event'',''session_context_revision'') AND current_source IS NULL';
   IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Private display native source check changed';END IF;
   definition:=replace(definition,before,'IF node->>''kind'' IN(''session_message'',''session_context_revision'',''memory'',''workspace_file'') AND current_source IS NULL');
   before:='OR current_source IS NOT NULL AND current_source->>''held'' IS DISTINCT FROM ''false''';
   IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Private display source version check changed';END IF;
   definition:=replace(definition,before,'OR current_source IS NOT NULL AND (current_source->>''held'' IS DISTINCT FROM ''false''
    OR current_source->>''version'' IS DISTINCT FROM node->>''version'')');
  END IF;
  IF suffix='envelope' THEN
   before:='state:=CASE WHEN selection=''query_domain'' THEN application_memory_statement_domain(w,i,keys,memo->''memoryStatement'') ELSE application_memory_statement_state(w,i,keys,memo->''memoryStatement'') END;';
   IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Private display envelope dispatch changed';END IF;
   after:='IF selection=''query_domain'' THEN state:=private_session_display_memory_domain(w,i,keys,memo);
  ELSIF EXISTS(SELECT 1 FROM memories WHERE workspace_id=w AND id=i AND valid_to IS NOT NULL) THEN state:=application_memory_field_state(w,i,keys);
  ELSE state:=private_session_display_memory_state(w,i,keys,memo);END IF;';
   definition:=replace(definition,before,after);
  END IF;
  IF suffix='field' THEN
   before:='IF envelope IS NULL OR envelope->>''identity'' IS DISTINCT FROM resource.identity';
   IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Private display recorded field identity changed';END IF;
   definition:=replace(definition,before,before||'
  OR envelope#>>''{state,recordVersion}'' IS DISTINCT FROM observation.record_version
  OR envelope#>>''{state,sourceVersion}'' IS DISTINCT FROM observation.source_version');
   before:='OR envelope#>>''{state,policyVersion}'' IS DISTINCT FROM observation.policy_version';
   -- Memory READ-mask compatibility is already handled by the original domain
   -- reducer; point observations may also use the exact canonical legacy digest.
   IF array_length(string_to_array(definition,before),1)=2 THEN
    definition:=replace(definition,before,'OR (envelope#>>''{state,policyVersion}'' IS DISTINCT FROM observation.policy_version
   AND NOT coalesce(resource.type_key=''memory'' AND envelope#>>''{state,legacyPolicyVersion}''=observation.policy_version,false))');
   END IF;
  END IF;
  EXECUTE definition;
  EXECUTE 'REVOKE ALL ON FUNCTION public.private_session_display_eval_'||suffix||'('||signature||') FROM PUBLIC';
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
   EXECUTE 'REVOKE ALL ON FUNCTION public.private_session_display_eval_'||suffix||'('||signature||') FROM app_user';
  END IF;
 END LOOP;
 -- A live Memory's positive checks are unchanged except that its ancestry is
 -- evaluated recursively for this purpose. Pass the same busy-node memo so a
 -- derived Memory/query cycle cannot start a fresh unbounded traversal.
 definition:=pg_get_functiondef('public.application_memory_field_state_before_successor(uuid,uuid,text[])'::regprocedure);
 before:='CREATE OR REPLACE FUNCTION public.application_memory_field_state_before_successor(w uuid, i uuid, fields text[])';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Private display Memory signature changed';END IF;
 definition:=replace(definition,before,'CREATE OR REPLACE FUNCTION public.private_session_display_memory_state(w uuid, i uuid, fields text[], memo jsonb)');
 before:='application_canonical_ancestry_allowed(w,''memory'',i,row_version) IS NOT TRUE';
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Private display Memory ancestry changed';END IF;
 definition:=replace(definition,before,'(private_session_display_eval_scope(w,''memory'',i,row_version,memo)->>''value'') IS DISTINCT FROM ''true''');
 EXECUTE definition;
 REVOKE ALL ON FUNCTION private_session_display_memory_state(uuid,uuid,text[],jsonb) FROM PUBLIC;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION private_session_display_memory_state(uuid,uuid,text[],jsonb),private_session_display_memory_domain(uuid,uuid,text[],jsonb) FROM app_user;
 END IF;
END $display_clones$;

-- The recovery command owns mutation locks. This separate display-purpose
-- copy retains every authority/binding check but holds only read locks.
DO $display_parent$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.read_native_session_recovery_parent(uuid,uuid,uuid,integer)'::regprocedure);
 IF array_length(string_to_array(definition,'FOR UPDATE'),1)<>3
  OR array_length(string_to_array(definition,'read_native_session_recovery_parent('),1)<>2 THEN
  RAISE EXCEPTION 'Private display parent lock contract changed';END IF;
 definition:=replace(definition,'read_native_session_recovery_parent(','private_session_display_parent(');
 definition:=replace(definition,'FOR UPDATE','FOR SHARE');
 EXECUTE definition;
 REVOKE ALL ON FUNCTION private_session_display_parent(uuid,uuid,uuid,integer) FROM PUBLIC;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION private_session_display_parent(uuid,uuid,uuid,integer) FROM app_user;
 END IF;
END $display_parent$;

CREATE FUNCTION read_private_session_display(w uuid,i uuid,device uuid,version integer,after_sequence integer,page_size integer)
-- Preserve the caller's native observation settings. Session point identities
-- include timestamp JSON; changing TimeZone here would alter unchanged hashes.
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 parent jsonb;current_parent jsonb;item record;checked jsonb;source jsonb;readable boolean;returned jsonb;verified jsonb:='[]';
 result jsonb:='[]';next_sequence integer:=NULL;more boolean:=false;seen integer:=0;
BEGIN
 IF after_sequence IS NULL OR after_sequence<0 OR page_size IS NULL OR page_size<1 OR page_size>100 THEN
  RAISE EXCEPTION 'invalid_session_display' USING ERRCODE='22023';END IF;
 IF private_session_display_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'session_display_contract_changed' USING ERRCODE='42501';END IF;
 parent:=private_session_display_parent(w,i,device,version);
 -- Native source snapshots hold their row SHARE locks through this transaction.
 -- Freeze policy changes too, including absent-to-present field registrations.
 -- NOWAIT fails closed if a writer acquired its policy row first, avoiding a
 -- read/write lock inversion with source mutations that subsequently bump it.
 BEGIN
  PERFORM singleton FROM application_policy_contract_epoch WHERE singleton FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
  PERFORM workspace_id FROM application_policy_workspace_epochs WHERE workspace_id=w FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
  PERFORM workspace_id FROM workspace_access_policies WHERE workspace_id=w FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END;
 IF parent->>'storedWorkspaceId' IS DISTINCT FROM w::text OR parent->>'channelType' IS DISTINCT FROM 'web'
  OR parent->>'appOrigin' IS DISTINCT FROM 'chat'
  OR NOT EXISTS(SELECT 1 FROM sessions WHERE id=i AND workspace_id=w AND visibility='personal'
   AND user_id=actor AND anchor_kind='none' AND mode IS NULL)
  OR scope_review_state_held('session',i) IS TRUE
 THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
 -- Only final human/assistant text can enter this DTO. Shape checks select no
 -- protected text, and tool-result carriers never become phantom placeholders.
 FOR item IN SELECT m.id,m.sequence_num,m.role,m.created_at,m.scope_version
  FROM session_messages m WHERE m.workspace_id=w AND m.session_id=i AND m.sequence_num>after_sequence
   AND m.role IN('user','assistant')
   AND (jsonb_typeof(m.content)='string' OR jsonb_typeof(m.content)='array'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b
     WHERE b->>'type'='text' AND jsonb_typeof(b->'text')='string'))
   AND NOT (m.role='assistant' AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b WHERE b->>'type'='tool_use'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content)='array' THEN m.content ELSE '[]' END) b WHERE b->>'type'='tool_result')
  ORDER BY m.sequence_num,m.id LIMIT page_size+1 FOR SHARE OF m
 LOOP
  seen:=seen+1;IF seen>page_size THEN more:=true;EXIT;END IF;next_sequence:=item.sequence_num;
  BEGIN
  source:=read_admitted_native_scope_snapshot(w,'session_message',item.id);
  readable:=source IS NOT NULL AND source->>'held'='false' AND source->>'version'=item.scope_version::text
   AND source->>'userId'=actor::text AND workflow_evidence_envelope_visible(w,source) IS TRUE
   AND scope_review_state_held('session_message',item.id) IS NOT TRUE;
  IF readable THEN
   checked:=private_session_display_eval_scope(w,'session_message',item.id,item.scope_version::text,'{}');
   readable:=checked->>'value'='true';
  END IF;
  EXCEPTION WHEN insufficient_privilege OR lock_not_available OR invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN readable:=false;END;
  result:=result||jsonb_build_array(jsonb_build_object('id',item.id,'sequence',item.sequence_num,'role',item.role,
   'timestamp',item.created_at,'available',coalesce(readable,false),
   'content',CASE WHEN readable THEN (SELECT content FROM session_messages WHERE workspace_id=w AND session_id=i AND id=item.id AND scope_version=item.scope_version) ELSE NULL END));
 END LOOP;
 -- Re-admit all original sources with a fresh memo after every payload read.
 -- No previous successful memo or captured current scope authorizes delivery.
 FOR returned IN SELECT value FROM jsonb_array_elements(result) LOOP
  IF returned->>'available'='true' THEN
   BEGIN
   SELECT scope_version INTO item FROM session_messages WHERE workspace_id=w AND session_id=i AND id=(returned->>'id')::uuid;
   source:=read_admitted_native_scope_snapshot(w,'session_message',(returned->>'id')::uuid);
   readable:=source IS NOT NULL AND source->>'held'='false' AND source->>'userId'=actor::text
    AND source->>'version'=item.scope_version::text AND workflow_evidence_envelope_visible(w,source) IS TRUE
    AND scope_review_state_held('session_message',(returned->>'id')::uuid) IS NOT TRUE;
   IF readable THEN
    checked:=private_session_display_eval_scope(w,'session_message',(returned->>'id')::uuid,item.scope_version::text,'{}');
    readable:=checked->>'value'='true';
   END IF;
   EXCEPTION WHEN insufficient_privilege OR lock_not_available OR invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN readable:=false;END;
   IF NOT coalesce(readable,false) THEN returned:=returned||'{"available":false,"content":null}'::jsonb;END IF;
  END IF;
  verified:=verified||jsonb_build_array(returned);
 END LOOP;
 result:=verified;
 current_parent:=private_session_display_parent(w,i,device,version);
 IF current_parent IS DISTINCT FROM parent OR private_session_display_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'session_display_unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('sessionId',i,'workspaceId',w,'mode','personal_transcript_display','rows',result,
  'nextSequence',CASE WHEN more THEN next_sequence ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION read_private_session_display(uuid,uuid,uuid,integer,integer,integer) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION read_private_session_display(uuid,uuid,uuid,integer,integer,integer) TO app_user;
END IF;END $$;
-- Metadata pins are drift fences only, never cached data authorization.
CREATE TABLE private_session_display_contract(signature text PRIMARY KEY,fingerprint text NOT NULL);
ALTER TABLE private_session_display_contract ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private_session_display_contract FROM PUBLIC;
CREATE FUNCTION private_session_display_helpers_current() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT count(*)=24 AND bool_and(p.oid IS NOT NULL AND c.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'))
 FROM private_session_display_contract c LEFT JOIN pg_proc p ON p.oid=to_regprocedure(c.signature)
$$;
REVOKE ALL ON FUNCTION private_session_display_helpers_current() FROM PUBLIC;
INSERT INTO private_session_display_contract(signature,fingerprint)
 SELECT signature,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM unnest(ARRAY[
 'public.application_session_eval_scope(uuid,text,uuid,text,jsonb)',
 'public.application_session_eval_field(uuid,uuid,text,jsonb)',
 'public.application_session_eval_point_state(uuid,text,uuid,text[],jsonb)',
 'public.application_session_eval_domain(uuid,text,uuid,text[],jsonb)',
 'public.application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)',
 'public.application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)',
 'public.application_memory_field_state_before_successor(uuid,uuid,text[])',
 'public.application_memory_field_state(uuid,uuid,text[])',
 'public.application_memory_historical_field_state(uuid,uuid,text[])',
 'public.application_memory_query_context(uuid)',
 'public.application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)',
 'public.read_native_session_recovery_parent(uuid,uuid,uuid,integer)',
 'public.private_session_display_parent(uuid,uuid,uuid,integer)',
 'public.read_admitted_native_scope_snapshot(uuid,text,uuid)',
 'public.application_scope_lineage(uuid,text[],uuid[],text[])',
 'public.private_session_display_eval_scope(uuid,text,uuid,text,jsonb)',
 'public.private_session_display_eval_field(uuid,uuid,text,jsonb)',
 'public.private_session_display_eval_point_state(uuid,text,uuid,text[],jsonb)',
 'public.private_session_display_eval_domain(uuid,text,uuid,text[],jsonb)',
 'public.private_session_display_eval_envelope(uuid,text,uuid,text,text[],jsonb)',
 'public.private_session_display_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)',
 'public.private_session_display_memory_state(uuid,uuid,text[],jsonb)',
 'public.private_session_display_memory_domain(uuid,uuid,text[],jsonb)',
 'public.read_private_session_display(uuid,uuid,uuid,integer,integer,integer)'
 ]) signature JOIN pg_proc p ON p.oid=signature::regprocedure;
DO $$ BEGIN
 IF private_session_display_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Private display contract incomplete';END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON TABLE private_session_display_contract FROM app_user;
  REVOKE ALL ON FUNCTION private_session_display_helpers_current() FROM app_user;
 END IF;
END $$;
COMMIT;
