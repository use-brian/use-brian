-- [COMP:api/native-chat-read-cost] Share only a complete, current, private
-- native Memory frame with the capture that consumes it. No permission cache.
BEGIN;
SET LOCAL check_function_bodies=on;
DO $chat_read_frame$
DECLARE item record;target regprocedure;original text;changed text;definition text;metadata jsonb;
 predecessors jsonb:='[]';evidence jsonb;frame regprocedure;frame_body text;
 manifest text;manifest_definition text;manifest_metadata jsonb;pin record;prior jsonb;
 old_literal text;new_literal text;last_literal text;fingerprint text;pin_count integer;
 signature_before constant text:='CREATE OR REPLACE FUNCTION public.read_native_session_cohort_evidence(';
 signature_after constant text:='CREATE OR REPLACE FUNCTION public.read_native_session_cohort_frame(';
 result_before constant text:=$old$ RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents);$old$;
 result_after constant text:=$new$ -- This frame is private to the definer capture in this same SQL invocation.
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents,'memo',memo);$new$;
 frame_fields_before constant text:=$old$ -- Read every original field under the current actor and original selector.$old$;
 frame_fields_after constant text:=$new$ -- This private port only exports a qualified locked Memory frame. Without
 -- it the caller must use its original reader, not repeat a discarded full proof.
 IF memo#>>'{memoryStatement,workspaceId}' IS DISTINCT FROM w::text THEN RETURN NULL;END IF;
 -- Read every original field under the current actor and original selector.$new$;
 scope_before constant text:=$old$  WHERE n->>'kind'='application_field' AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb OR f.type_key NOT IN('session_message','session_message_annotation'))) THEN$old$;
 scope_after constant text:=$new$  WHERE n->>'kind'='application_field' AND (f.origin<>'{"kind":"native","moduleKey":"native"}'::jsonb
   OR (f.type_key NOT IN('session_message','session_message_annotation')
    AND NOT(f.type_key='memory' AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false))))) THEN$new$;
 capture_declaration_before constant text:=$old$ actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;$old$;
 capture_declaration_after constant text:=$new$ actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 frame_kinds text[];frame_ids uuid[];frame_versions text[];frame_nodes jsonb;frame_result jsonb;
 frame_ancestry boolean:=false;frame_point jsonb;frame_root jsonb;frame_tuple jsonb;frame_actual jsonb;
 frame_kind text;frame_id uuid;frame_version text;$new$;
 capture_before constant text:=$old$ result:=application_session_eval_scan(w,s,t,through,fields,bounds,visibility,memo);memo:=coalesce(result->'memo',memo);scanned:=result->'value';$old$;
 capture_after constant text:=$new$ -- Discover physical identities only. The original scan below still admits
 -- every point, computes payload, and owns the complete query-domain binding.
 IF EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor) THEN
  SELECT array_agg(candidate.kind ORDER BY candidate.sequence_num,candidate.message_id),
   array_agg(candidate.id ORDER BY candidate.sequence_num,candidate.message_id),
   array_agg(candidate.version ORDER BY candidate.sequence_num,candidate.message_id)
   INTO frame_kinds,frame_ids,frame_versions
  FROM(SELECT CASE WHEN t='session_message' THEN 'session_message' ELSE 'session_context_revision' END AS kind,
    CASE WHEN t='session_message' THEN message.id ELSE revision.id END AS id,
    CASE WHEN t='session_message' THEN message.scope_version::text ELSE '1' END AS version,
    message.sequence_num,message.id AS message_id
   FROM session_messages message
   LEFT JOIN session_message_annotation_heads head ON head.workspace_id=message.workspace_id
    AND head.session_id=message.session_id AND head.message_id=message.id
   LEFT JOIN session_context_scope_revisions revision ON revision.workspace_id=head.workspace_id
    AND revision.id=head.scope_revision_id AND revision.session_id=message.session_id
    AND revision.parent_kind='message_annotation' AND revision.parent_id=message.id
   WHERE message.workspace_id=w AND message.session_id=s AND message.sequence_num<=through
    AND(t='session_message' OR revision.id IS NOT NULL)
   ORDER BY message.sequence_num,message.id LIMIT 101) candidate;
  IF cardinality(frame_ids) BETWEEN 1 AND 100 AND array_position(frame_ids,NULL) IS NULL
   AND array_position(frame_versions,NULL) IS NULL THEN
   -- Optional eligibility discovery must not turn an incomplete observation
   -- or an oversized union into a new batch-wide refusal. This bounded metadata
   -- walk proves eligibility only; the complete canonical proof walks it again.
   WITH RECURSIVE candidates(kind,id,version) AS (
    SELECT * FROM unnest(frame_kinds,frame_ids,frame_versions)
    UNION SELECT edge.kind,edge.id,edge.version FROM candidates node
     CROSS JOIN LATERAL application_scope_source_edges(w,node.kind,node.id,node.version) edge
   ), bounded AS MATERIALIZED(SELECT * FROM candidates LIMIT 4097)
   SELECT coalesce(jsonb_agg(to_jsonb(node)),'[]') INTO frame_nodes FROM bounded node;
   IF jsonb_array_length(frame_nodes)<=4096
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(frame_nodes) node
     WHERE node->>'kind' IS NULL OR node->>'id' IS NULL OR node->>'version' IS NULL)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(frame_nodes) node
     LEFT JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=(node->>'id')::uuid
     LEFT JOIN application_field_observations observation ON observation.workspace_id=w
      AND observation.resource_id=resource.id AND observation.version=node->>'version'
     WHERE node->>'kind'='application_field' AND(resource.id IS NULL OR observation.resource_id IS NULL))
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(frame_nodes) node
     JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=(node->>'id')::uuid
     WHERE node->>'kind'='application_field' AND resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb
      AND resource.type_key='memory' AND resource.selection='query_domain')
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(frame_nodes) node
     JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=(node->>'id')::uuid
     WHERE node->>'kind'='application_field' AND resource.type_key='memory'
      AND(resource.selection<>'query_domain' OR resource.selected_version IS NOT NULL)) THEN
    frame_result:=read_native_session_cohort_frame(w,frame_kinds,frame_ids,frame_versions,true);
    -- A rejected candidate cannot suppress a different readable point. Only
    -- the original scan decides membership. An unavailable private Memory
    -- statement likewise keeps the original, empty-worklist behavior.
    IF frame_result->>'admitted'='true' AND jsonb_typeof(frame_result->'memo')='object'
     AND frame_result#>>'{memo,memoryStatement,workspaceId}'=w::text THEN
     memo:=frame_result->'memo';
    END IF;
   END IF;
  END IF;
 END IF;
 result:=application_session_eval_scan(w,s,t,through,fields,bounds,visibility,memo);memo:=coalesce(result->'memo',memo);scanned:=result->'value';$new$;
 ancestry_before constant text:=$old$ IF application_field_envelope_ancestry_allowed(w,envelope) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;$old$;
 ancestry_after constant text:=$new$ -- Only this internally computed envelope can bind to the complete frame.
 -- Re-read every exact native root now. A new annotation head, changed scope,
 -- unknown point or independent source retains the original full validator.
 frame_ancestry:=frame_result->>'admitted'='true'
  AND frame_result#>>'{memo,memoryStatement,workspaceId}'=w::text;
 IF frame_ancestry THEN
  FOR frame_point IN WITH RECURSIVE points(value) AS (
   SELECT envelope UNION ALL SELECT child.value FROM points point
    CROSS JOIN LATERAL jsonb_array_elements(point.value->'children') child(value)
  ) SELECT value FROM points LOOP
   IF frame_point IS NOT DISTINCT FROM envelope THEN
    IF frame_point->'origin' IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
     OR frame_point->>'typeKey' IS DISTINCT FROM t OR frame_point->>'selection' IS DISTINCT FROM 'query_domain'
     OR frame_point->>'id' IS DISTINCT FROM domain_id::text OR frame_point->>'selectedVersion' IS NOT NULL
     OR frame_point#>>'{state,sourceKind}' IS DISTINCT FROM 'application_query_domain'
     OR frame_point#>>'{state,sourceId}' IS DISTINCT FROM domain_id::text
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(frame_point->'sources') reference
      WHERE reference->>'resourceKind' IS DISTINCT FROM 'application_field') THEN
     frame_ancestry:=false;EXIT;
    END IF;
    CONTINUE;
   END IF;
   frame_kind:=frame_point#>>'{state,sourceKind}';
   IF frame_point->'origin' IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
    OR frame_point->>'typeKey' IS DISTINCT FROM t OR frame_point->>'selection' IS DISTINCT FROM 'query'
    OR frame_point->>'selectedVersion' IS NOT NULL OR frame_point->'children' IS DISTINCT FROM '[]'::jsonb
    OR frame_point->'sources' IS DISTINCT FROM '[]'::jsonb
    OR frame_kind IS DISTINCT FROM (CASE WHEN t='session_message' THEN 'session_message' ELSE 'session_context_revision' END)
    OR frame_point#>>'{state,source,held}' IS DISTINCT FROM 'false'
    OR frame_point#>>'{state,source,workspaceId}' IS DISTINCT FROM w::text
    OR frame_point#>>'{state,source,version}' IS DISTINCT FROM frame_point#>>'{state,sourceVersion}' THEN
    frame_ancestry:=false;EXIT;
   END IF;
   frame_id:=(frame_point#>>'{state,sourceId}')::uuid;frame_version:=frame_point#>>'{state,sourceVersion}';
   IF frame_id IS NULL OR frame_version IS NULL
    OR t='session_message' AND frame_id::text IS DISTINCT FROM frame_point->>'id'
    OR t='session_message_annotation' AND NOT EXISTS(SELECT 1 FROM session_message_annotation_heads head
     JOIN session_context_scope_revisions revision ON revision.workspace_id=head.workspace_id AND revision.id=head.scope_revision_id
     WHERE head.workspace_id=w AND head.session_id=s AND head.message_id=(frame_point->>'id')::uuid
      AND head.scope_revision_id=frame_id AND revision.parent_kind='message_annotation'
      AND revision.parent_id=head.message_id AND revision.session_id=s) THEN
    frame_ancestry:=false;EXIT;
   END IF;
   frame_tuple:=jsonb_build_object('workspaceId',frame_point#>'{state,source,workspaceId}',
    'userId',frame_point#>'{state,source,userId}','assistantId',frame_point#>'{state,source,assistantId}',
    'sensitivity',frame_point#>'{state,source,sensitivity}','compartments',frame_point#>'{state,source,compartments}',
    'projectIds',frame_point#>'{state,source,projectIds}','resourceKind',frame_kind,'resourceId',frame_id,'version',frame_version);
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(frame_result->'current') current_root WHERE current_root=frame_tuple) THEN
    frame_ancestry:=false;EXIT;
   END IF;
   IF frame_kind='session_context_revision' THEN
    frame_root:=read_entity_derivation_source(w,frame_kind,frame_id);
    frame_actual:=jsonb_build_object('workspaceId',frame_root->'workspaceId','userId',frame_root->'userId',
     'assistantId',frame_root->'assistantId','sensitivity',frame_root->'sensitivity','compartments',frame_root->'compartments',
     'projectIds',frame_root->'projectIds','resourceKind',frame_kind,'resourceId',frame_id,'version',frame_root->'version');
    IF frame_root->>'held' IS DISTINCT FROM 'false' OR frame_actual IS DISTINCT FROM frame_tuple THEN
     frame_ancestry:=false;EXIT;
    END IF;
   END IF;
   frame_root:=read_admitted_native_scope_snapshot(w,frame_kind,frame_id);
   frame_actual:=jsonb_build_object('workspaceId',frame_root->'workspaceId','userId',frame_root->'userId',
    'assistantId',frame_root->'assistantId','sensitivity',frame_root->'sensitivity','compartments',frame_root->'compartments',
    'projectIds',frame_root->'projectIds','resourceKind',frame_kind,'resourceId',frame_id,'version',frame_root->'version');
   IF frame_root->>'held' IS DISTINCT FROM 'false' OR frame_actual IS DISTINCT FROM frame_tuple THEN
    frame_ancestry:=false;EXIT;
   END IF;
  END LOOP;
 END IF;
 IF frame_ancestry IS DISTINCT FROM true THEN
  IF application_field_envelope_ancestry_allowed(w,envelope) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END IF;$new$;
 snapshots_declaration_before constant text:=$old$DECLARE position integer;memo jsonb:='{}';result jsonb;resource application_field_resources;$old$;
 snapshots_declaration_after constant text:=$new$DECLARE position integer;memo jsonb:='{}';result jsonb;resource application_field_resources;
 frame_nodes jsonb;frame_result jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;$new$;
 snapshots_before constant text:=$old$ FOR position IN 1..cardinality(ids) LOOP$old$;
 snapshots_after constant text:=$new$ -- This is a NEW complete proof after capture materialization. Initial
 -- capture state is never an input. Invalid roots retain per-row held results.
 IF cardinality(ids)<=100 AND array_ndims(ids)=1 AND array_lower(ids,1)=1
  AND array_ndims(versions)=1 AND array_lower(versions,1)=1
  AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND NOT EXISTS(SELECT 1 FROM unnest(ids,versions) root(id,version)
   LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=root.id
   LEFT JOIN application_field_observations observation ON observation.workspace_id=w AND observation.resource_id=field.id
    AND observation.version=root.version WHERE field.id IS NULL OR observation.resource_id IS NULL) THEN
  WITH RECURSIVE candidates(kind,id,version) AS (
   SELECT 'application_field'::text,root.id,root.version FROM unnest(ids,versions) root(id,version)
   UNION SELECT edge.kind,edge.id,edge.version FROM candidates node
    CROSS JOIN LATERAL application_scope_source_edges(w,node.kind,node.id,node.version) edge
  ), bounded AS MATERIALIZED(SELECT * FROM candidates LIMIT 4097)
  SELECT coalesce(jsonb_agg(to_jsonb(node)),'[]') INTO frame_nodes FROM bounded node;
  IF jsonb_array_length(frame_nodes)<=4096
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(frame_nodes) node
    WHERE node->>'kind' IS NULL OR node->>'id' IS NULL OR node->>'version' IS NULL)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(frame_nodes) node
    LEFT JOIN application_field_resources field ON field.workspace_id=w AND field.id=(node->>'id')::uuid
    LEFT JOIN application_field_observations observation ON observation.workspace_id=w AND observation.resource_id=field.id
     AND observation.version=node->>'version'
    WHERE node->>'kind'='application_field' AND(field.id IS NULL OR observation.resource_id IS NULL))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(frame_nodes) node
    JOIN application_field_resources field ON field.workspace_id=w AND field.id=(node->>'id')::uuid
    WHERE node->>'kind'='application_field' AND field.origin='{"kind":"native","moduleKey":"native"}'::jsonb
     AND field.type_key='memory' AND field.selection='query_domain')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(frame_nodes) node
    JOIN application_field_resources field ON field.workspace_id=w AND field.id=(node->>'id')::uuid
    WHERE node->>'kind'='application_field' AND field.type_key='memory'
     AND(field.selection<>'query_domain' OR field.selected_version IS NOT NULL)) THEN
   frame_result:=read_native_session_cohort_frame(w,ARRAY(SELECT 'application_field'::text FROM unnest(ids)),ids,versions,true);
   IF frame_result->>'admitted'='true' AND jsonb_typeof(frame_result->'memo')='object'
    AND frame_result#>>'{memo,memoryStatement,workspaceId}'=w::text THEN memo:=frame_result->'memo';END IF;
  END IF;
 END IF;
 FOR position IN 1..cardinality(ids) LOOP$new$;
 snapshots_branch_before constant text:=$old$  IF FOUND AND resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND resource.type_key IN('session_message','session_message_annotation') THEN$old$;
 snapshots_branch_after constant text:=$new$  IF FOUND AND resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb
   AND(resource.type_key IN('session_message','session_message_annotation')
    OR resource.type_key='memory' AND resource.selected_version IS NULL
     AND resource.selection IN('read','query','identity','query_domain')
     AND coalesce(memo#>>'{memoryStatement,workspaceId}'=w::text,false)) THEN$new$;
 title_declaration_before constant text:=$old$ seen jsonb:='[]';current_source jsonb;$old$;
 title_declaration_after constant text:=$new$ seen jsonb:='[]';current_source jsonb;chat_nodes jsonb;chat_proof jsonb;$new$;
 title_before constant text:=$old$ RETURN root IS NOT NULL AND root->>'held'='false'
  AND application_canonical_ancestry_allowed(w,'session_context_revision',i,'1') IS TRUE;$old$;
 title_after constant text:=$new$ -- Keep the separate historical-purpose branch above. Ordinary current
 -- Memory domains can use the existing complete cohort proof, never a label
 -- or an envelope supplied by the caller. Its explicit denial stays denied.
 IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass
   WHERE login.rolname=session_user AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN
  SELECT coalesce(jsonb_agg(to_jsonb(node)),'[]') INTO chat_nodes
   FROM application_scope_lineage(w,ARRAY['session_context_revision'],ARRAY[i],ARRAY['1']) node;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(chat_nodes) node
   JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=(node->>'id')::uuid
   WHERE node->>'kind'='application_field' AND resource.origin='{"kind":"native","moduleKey":"native"}'::jsonb
    AND resource.type_key='memory' AND resource.selection='query_domain')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(chat_nodes) node
    JOIN application_field_resources resource ON resource.workspace_id=w AND resource.id=(node->>'id')::uuid
    WHERE node->>'kind'='application_field' AND resource.type_key='memory'
     AND(resource.selection<>'query_domain' OR resource.selected_version IS NOT NULL)) THEN
   chat_proof:=read_native_session_cohort_evidence(w,ARRAY['session_context_revision'],ARRAY[i],ARRAY['1'],true);
   IF chat_proof IS NOT NULL THEN RETURN (chat_proof->>'admitted'='true') IS TRUE;END IF;
  END IF;
 END IF;
 RETURN root IS NOT NULL AND root->>'held'='false'
  AND application_canonical_ancestry_allowed(w,'session_context_revision',i,'1') IS TRUE;$new$;
BEGIN
 IF application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native chat read frame helper prerequisite changed';END IF;
 IF to_regprocedure('public.read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)') IS NOT NULL THEN
  RAISE EXCEPTION 'Native chat read frame already exists';END IF;
 -- Fail closed on unknown predecessors; preserve each existing OID, owner,
 -- ACL, volatility, search path, argument contract and all other attributes.
 FOR item IN SELECT * FROM(VALUES
  ('public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)','2afff03ed88d3de82386880a3b582bbfa2c4379b06ecbc06fd98ff467f60c376'),
  ('public.application_session_eval_scope(uuid,text,uuid,text,jsonb)','8e2bbdf1f94920c03737e243e08ce75ee7e36d0571269de01c576bc9b8f53729'),
  ('public.capture_native_session_projection_batch(uuid,uuid,integer,text)','9e72b1560d262c171d30f1b0dfc43d18a13abc907ea5a695f5bf48adbc0a73b3'),
  ('public.read_native_session_field_snapshots(uuid,uuid[],text[])','670666fe20bf2fcce959f7f12e43dbddcf35d1c9edceec63d59d1626a07087b4'),
  ('public.session_context_revision_allowed(uuid,uuid)','44da807d4f4910d3e734e0da54c21c6c2978250c116e958893a3679f9449e7c2')
 ) expected(signature,body_hash) LOOP
  target:=to_regprocedure(item.signature);
  SELECT p.prosrc,pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO original,definition,metadata FROM pg_proc p WHERE p.oid=target;
  IF original IS NULL OR encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM item.body_hash THEN
   RAISE EXCEPTION 'Native chat read frame predecessor changed: %',item.signature;END IF;
  predecessors:=predecessors||jsonb_build_array(jsonb_build_object('oid',target::oid,'signature',item.signature,
   'source',original,'definition',definition,'metadata',metadata));
 END LOOP;
 SELECT p.prosrc,pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO manifest,manifest_definition,manifest_metadata
  FROM pg_proc p WHERE p.oid='public.application_memory_statement_helpers_current()'::regprocedure;
 -- The guard allocates OIDs and full-metadata fingerprints per installation.
 -- Pin its complete reviewed structure without pinning those allocated values;
 -- the current guard independently verifies every actual helper fingerprint.
 changed:=regexp_replace(manifest,'\([0-9]+::oid,''[0-9a-f]{64}''::text\)',
  '(0::oid,''0000000000000000000000000000000000000000000000000000000000000000''::text)','g');
 changed:=regexp_replace(changed,'[0-9]+::oid','0::oid','g');
 IF encode(sha256(convert_to(changed,'UTF8')),'hex') IS DISTINCT FROM 'b9bf035aba34daead13aefd507a87c7700fa80e5e8c02cc548131e8d0f86fb56' THEN
  RAISE EXCEPTION 'Native chat read frame manifest predecessor changed';END IF;

 SELECT value INTO evidence FROM jsonb_array_elements(predecessors) WHERE value->>'signature'='public.read_native_session_cohort_evidence(uuid,text[],uuid[],text[],boolean)';
 original:=evidence->>'source';definition:=evidence->>'definition';
 IF array_length(string_to_array(original,result_before),1)<>2
  OR array_length(string_to_array(original,frame_fields_before),1)<>2
  OR array_length(string_to_array(definition,signature_before),1)<>2 THEN
  RAISE EXCEPTION 'Native chat read frame clone splice changed';END IF;
 frame_body:=replace(replace(original,result_before,result_after),frame_fields_before,frame_fields_after);
 EXECUTE replace(replace(definition,original,frame_body),signature_before,signature_after);
 frame:='public.read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure;
 REVOKE ALL ON FUNCTION public.read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean) FROM PUBLIC;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION public.read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean) FROM app_user;END IF;
 IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid=frame) IS DISTINCT FROM frame_body
  OR (SELECT to_jsonb(p)-ARRAY['oid','proname','prosrc'] FROM pg_proc p WHERE p.oid=frame)
   IS DISTINCT FROM (evidence->'metadata')-ARRAY['oid','proname'] THEN
  RAISE EXCEPTION 'Native chat read frame clone authority changed';END IF;

 FOR item IN SELECT * FROM(VALUES
  ('public.application_session_eval_scope(uuid,text,uuid,text,jsonb)',scope_before,scope_after),
  ('public.read_native_session_field_snapshots(uuid,uuid[],text[])',snapshots_declaration_before,snapshots_declaration_after),
  ('public.read_native_session_field_snapshots(uuid,uuid[],text[])',snapshots_before,snapshots_after),
  ('public.read_native_session_field_snapshots(uuid,uuid[],text[])',snapshots_branch_before,snapshots_branch_after),
  ('public.capture_native_session_projection_batch(uuid,uuid,integer,text)',capture_declaration_before,capture_declaration_after),
  ('public.capture_native_session_projection_batch(uuid,uuid,integer,text)',capture_before,capture_after),
  ('public.capture_native_session_projection_batch(uuid,uuid,integer,text)',ancestry_before,ancestry_after),
  ('public.session_context_revision_allowed(uuid,uuid)',title_declaration_before,title_declaration_after),
  ('public.session_context_revision_allowed(uuid,uuid)',title_before,title_after)
 ) splices(signature,old_body,new_body) LOOP
  target:=item.signature::regprocedure;
  SELECT p.prosrc,pg_get_functiondef(p.oid) INTO original,definition FROM pg_proc p WHERE p.oid=target;
  IF array_length(string_to_array(original,item.old_body),1)<>2 THEN
   RAISE EXCEPTION 'Native chat read frame splice changed: %',item.signature;END IF;
  changed:=replace(original,item.old_body,item.new_body);
  EXECUTE replace(definition,original,changed);
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM changed THEN
   RAISE EXCEPTION 'Native chat read frame replacement changed: %',item.signature;END IF;
 END LOOP;
 -- Capture checks this dependency both before reading and after its independent
 -- final snapshots. Advance only the exact reviewed replacement, at both sites.
 IF (SELECT encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') FROM pg_proc p
  WHERE p.oid='public.read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure)
  IS DISTINCT FROM 'a3ead9fc09f142f7450eabd41b573a07d66ce39adf43aeca1d87786c091634ee' THEN
  RAISE EXCEPTION 'Native chat read frame snapshot replacement changed';END IF;
 target:='public.capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure;
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO original,definition FROM pg_proc p WHERE p.oid=target;
 IF array_length(string_to_array(original,'670666fe20bf2fcce959f7f12e43dbddcf35d1c9edceec63d59d1626a07087b4'),1)<>3 THEN
  RAISE EXCEPTION 'Native chat read frame capture snapshot contracts changed';END IF;
 changed:=replace(original,'670666fe20bf2fcce959f7f12e43dbddcf35d1c9edceec63d59d1626a07087b4',
  'a3ead9fc09f142f7450eabd41b573a07d66ce39adf43aeca1d87786c091634ee');
 EXECUTE replace(definition,original,changed);
 IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM changed THEN
  RAISE EXCEPTION 'Native chat read frame capture contracts replacement changed';END IF;
 FOR prior IN SELECT value FROM jsonb_array_elements(predecessors) LOOP
  IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=(prior->>'oid')::oid) IS DISTINCT FROM prior->'metadata' THEN
   RAISE EXCEPTION 'Native chat read frame changed existing authority: %',prior->>'signature';END IF;
 END LOOP;
 IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid=(evidence->>'oid')::oid) IS DISTINCT FROM evidence->>'source' THEN
  RAISE EXCEPTION 'Native chat read frame changed public proof output';END IF;

 -- Only an already tracked changed helper advances its exact metadata pin.
 -- Capture and title preserve their existing unpinned status. The new private
 -- clone joins the closed manifest; every other pin and security check stays.
 changed:=manifest;
 FOR pin IN SELECT match[1]::oid AS function_oid,match[2] AS fingerprint
  FROM regexp_matches(manifest,'\(([0-9]+)::oid,''([0-9a-f]{64})''::text\)','g') match LOOP
  SELECT value INTO prior FROM jsonb_array_elements(predecessors) WHERE (value->>'oid')::oid=pin.function_oid;
  old_literal:=format('(%s::oid,%L::text)',pin.function_oid,pin.fingerprint);
  IF prior IS NOT NULL THEN
   IF encode(sha256(convert_to(((prior->'metadata')||jsonb_build_object('prosrc',prior->>'source'))::text,'UTF8')),'hex') IS DISTINCT FROM pin.fingerprint THEN
    RAISE EXCEPTION 'Native chat read frame original helper pin changed';END IF;
   SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO fingerprint FROM pg_proc p WHERE p.oid=pin.function_oid;
   new_literal:=format('(%s::oid,%L::text)',pin.function_oid,fingerprint);
   IF array_length(string_to_array(changed,old_literal),1)<>2 THEN RAISE EXCEPTION 'Native chat read frame helper pin changed';END IF;
   changed:=replace(changed,old_literal,new_literal);
   last_literal:=new_literal;
  ELSE last_literal:=old_literal;
  END IF;
 END LOOP;
 SELECT count(*) INTO pin_count FROM regexp_matches(manifest,'\(([0-9]+)::oid,''([0-9a-f]{64})''::text\)','g');
 IF pin_count<>126 OR array_length(string_to_array(changed,'SELECT count(*)=126'),1)<>2
  OR array_length(string_to_array(changed,last_literal),1)<>2 THEN
  RAISE EXCEPTION 'Native chat read frame helper manifest changed';END IF;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO fingerprint FROM pg_proc p WHERE p.oid=frame;
 new_literal:=format('(%s::oid,%L::text)',frame::oid,fingerprint);
 changed:=replace(changed,last_literal,last_literal||','||new_literal);
 changed:=replace(changed,'SELECT count(*)=126','SELECT count(*)=127');
 EXECUTE replace(manifest_definition,manifest,changed);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid='public.application_memory_statement_helpers_current()'::regprocedure)
  IS DISTINCT FROM manifest_metadata OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native chat read frame helper transition failed';END IF;
END $chat_read_frame$;
COMMIT;
