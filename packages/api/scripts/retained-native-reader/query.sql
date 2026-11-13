-- [COMP:api/native-chat-read-cost] Original canonical materialization and independent post-write proof.
CREATE OR REPLACE FUNCTION public.read_native_retained_session_query(w uuid, s uuid, body_through integer, topics_through integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE roots jsonb;selectors jsonb;initial jsonb;fresh jsonb;context jsonb;captured jsonb;frozen application_query_domains;
 all_captures jsonb:='[]';sources jsonb;source_tuple jsonb;history jsonb;annotations jsonb;
 capture_plan jsonb;

BEGIN
 IF body_through IS NULL OR topics_through IS NULL OR body_through<0 OR topics_through<0 THEN RETURN NULL;END IF;
 IF native_retained_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 context:=native_turn_context();
 -- Identities only: complete payload and actual-principal checks are private.
 SELECT jsonb_agg(n ORDER BY n::text) INTO roots FROM (
  SELECT jsonb_build_object('kind','session_message','id',m.id,'version',m.scope_version::text) n
  FROM session_messages m WHERE m.workspace_id=w AND m.session_id=s
   AND m.sequence_num<=greatest(body_through,topics_through) LIMIT 4097
 ) candidates;
 IF roots IS NULL OR jsonb_array_length(roots)>4096 THEN RETURN NULL;END IF;
 selectors:=jsonb_build_array(jsonb_build_object('type','session_message','sessionId',s,'through',body_through),
  jsonb_build_object('type','session_message_annotation','sessionId',s,'through',topics_through));
 SELECT read_native_retained_requirements(w,roots,selectors) INTO initial;
 IF initial->>'available' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;
 IF native_retained_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR clock_timestamp()>=(initial->>'validUntil')::timestamptz THEN RETURN NULL;END IF;
 IF jsonb_array_length(initial->'queryCaptures') IS DISTINCT FROM 2 THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_agg(expanded.value),'[]') INTO all_captures FROM jsonb_array_elements(initial->'queryCaptures') q
  CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(q->'envelope')||coalesce(q#>'{envelope,children}','[]')) expanded(value);
 -- The complete initial graph remains private; no redundant metadata compile.
 capture_plan:=native_retained_capture_plan(w,initial,all_captures);
 IF capture_plan IS NULL OR native_retained_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR clock_timestamp()>=(initial->>'validUntil')::timestamptz THEN RETURN NULL;END IF;

 -- From the first immutable write onward, failure aborts the whole operation.
 FOR captured IN SELECT value FROM jsonb_array_elements(initial->'queryCaptures') LOOP
  INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
   VALUES((captured->>'domainId')::uuid,w,'{"kind":"native","moduleKey":"native"}',captured->>'type','1',captured->'domain',captured->>'domainIdentity')
   ON CONFLICT DO NOTHING;
  SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=(captured->>'domainId')::uuid;
  IF NOT FOUND OR (frozen.origin,frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity) IS DISTINCT FROM
   ('{"kind":"native","moduleKey":"native"}'::jsonb,captured->>'type','1',captured->'domain',captured->>'domainIdentity')
  THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
  PERFORM application_materialize_field_envelope(w,captured->'envelope');
  IF captured->>'type'='session_message' THEN history:=captured->'rows';ELSE annotations:=captured->'rows';END IF;
 END LOOP;
 SELECT jsonb_agg(source ORDER BY source::text) INTO sources FROM (SELECT DISTINCT value->'source' source FROM jsonb_array_elements(all_captures)) selected;
 SELECT jsonb_agg(jsonb_build_object('kind',v->>'resourceKind','id',v->>'resourceId','version',v->>'version') ORDER BY v::text)
  INTO roots FROM jsonb_array_elements(sources) v;
 -- This is a distinct READ COMMITTED SPI command after observation DML. It
 -- rebuilds canonical domains and points with fresh state, grants and time.
 SELECT read_native_retained_requirements(w,roots,'[]'::jsonb) INTO fresh;
 IF fresh->>'available' IS DISTINCT FROM 'true' OR fresh->>'admitted' IS DISTINCT FROM 'true'
  OR native_turn_context() IS DISTINCT FROM context OR native_retained_helpers_current() IS NOT TRUE
  OR clock_timestamp()>=(fresh->>'validUntil')::timestamptz
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 FOR source_tuple IN SELECT value FROM jsonb_array_elements(sources) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fresh->'immutable') original WHERE original=source_tuple)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fresh->'current') current_source WHERE current_source=source_tuple)
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 IF fresh#>'{requirements,nativeMetadata}' IS DISTINCT FROM initial#>'{requirements,nativeMetadata}'
  OR fresh#>'{requirements,sessionParents}' IS DISTINCT FROM initial#>'{requirements,sessionParents}'
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_retained_graph_equal(capture_plan->'semantic',fresh#>'{metadata,witness,graph}',false) IS NOT TRUE
  OR native_retained_graph_equal(capture_plan->'privacy',fresh#>'{metadata,witness,privacyGraph}',true) IS NOT TRUE
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('history',history,'annotations',annotations,
  'proof',jsonb_build_object('admitted',true,'immutable',fresh->'immutable','current',fresh->'current'));
END
$function$
