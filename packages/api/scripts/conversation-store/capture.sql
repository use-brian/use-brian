-- [COMP:api/native-turn-frame] Canonical conversation query capture.
CREATE OR REPLACE FUNCTION public.capture_conversation_selection(w uuid, s uuid, t text, through integer, fields text[], bounds jsonb, visibility jsonb, memo jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE candidate record;result jsonb;point jsonb;parent jsonb;candidates jsonb:='[]';points jsonb:='[]';policies jsonb:='[]';children jsonb:='[]';attempts integer:=0;resource uuid;field_identity text;
BEGIN
 parent:=application_session_query_parent(w,s);
 IF parent IS NULL OR through IS NULL OR through<0 OR application_session_field_keys(t) IS NULL OR fields IS NULL
  OR NOT fields<@application_session_field_keys(t) OR array_position(fields,NULL) IS NOT NULL
  OR cardinality(fields)<>(SELECT count(DISTINCT f) FROM unnest(fields) f)
  OR application_query_scope_valid(bounds) IS NOT TRUE OR jsonb_typeof(visibility) IS DISTINCT FROM 'object'
  OR visibility-ARRAY['userId','assistants']<>'{}' OR NOT visibility ?& ARRAY['userId','assistants'] THEN RETURN jsonb_build_object('memo',memo);END IF;
 IF (SELECT count(*) FROM(SELECT 1 FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num<=through LIMIT 4097) candidates)>4096
 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
 -- The graph admits complete all-version privacy before selecting any point payload.
 FOR candidate IN SELECT id,sequence_num FROM session_messages WHERE workspace_id=w AND session_id=s AND sequence_num<=through ORDER BY sequence_num,id
 LOOP
  attempts:=attempts+1;IF attempts>4096 THEN RAISE EXCEPTION 'query_domain_complexity_unavailable' USING ERRCODE='42501';END IF;
  point:=memo#>ARRAY['envelopes',jsonb_build_array(t,candidate.id,fields)::text];
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
END $function$;
REVOKE ALL ON FUNCTION capture_conversation_selection(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb) FROM PUBLIC,app_user;
CREATE OR REPLACE FUNCTION public.capture_conversation_query(w uuid, s uuid, body_through integer, topics_through integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE parent jsonb;bounds jsonb;visibility jsonb;context jsonb;memo jsonb;scanned jsonb;captured jsonb;
 selections jsonb;initial jsonb;fresh jsonb;fields text[];selection jsonb;pass integer;frozen application_query_domains;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR body_through IS NULL AND topics_through IS NULL OR body_through<0 OR topics_through<0
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.session_messages'::regclass WHERE r.rolname=session_user
   AND(r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 context:=native_turn_context();
 selections:=jsonb_build_array(jsonb_build_object('type','session_message','through',body_through,'sessionId',s),
  jsonb_build_object('type','session_message_annotation','through',topics_through,'sessionId',s));
 FOR pass IN 1..2 LOOP
  parent:=application_session_query_parent(w,s);bounds:=application_session_query_bounds(w,parent);
  IF parent IS NULL OR bounds IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
   'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
  memo:=conversation_dag(w,'[]',(SELECT jsonb_agg(value) FROM jsonb_array_elements(selections) WHERE value->>'through' IS NOT NULL));fresh:='[]';
  FOR selection IN SELECT value FROM jsonb_array_elements(selections) WHERE value->>'through' IS NOT NULL LOOP
   fields:=ARRAY(SELECT field FROM unnest(application_session_field_keys(selection->>'type')) field ORDER BY field);
   scanned:=capture_conversation_selection(w,s,selection->>'type',(selection->>'through')::integer,fields,bounds,visibility,memo);
   memo:=scanned->'memo';
   IF scanned->'value' IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   captured:=native_turn_build_query_capture(w,s,selection->>'type',(selection->>'through')::integer,fields,parent,bounds,visibility,scanned);
   IF recording_source_read_allowed(w,'application_field',(captured#>>'{envelope,resourceId}')::uuid) IS NOT TRUE
    OR scope_review_state_held('application_field',(captured#>>'{envelope,resourceId}')::uuid)
   THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   fresh:=fresh||jsonb_build_array(captured);
  END LOOP;
  IF pass=1 THEN
   initial:=fresh;
   FOR captured IN SELECT value FROM jsonb_array_elements(initial) LOOP
    INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
     VALUES((captured->>'domainId')::uuid,w,'{"kind":"native","moduleKey":"native"}',captured->>'type','1',captured->'domain',captured->>'domainIdentity') ON CONFLICT DO NOTHING;
    SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=(captured->>'domainId')::uuid;
    IF NOT FOUND OR (frozen.origin,frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity) IS DISTINCT FROM
     ('{"kind":"native","moduleKey":"native"}'::jsonb,captured->>'type','1',captured->'domain',captured->>'domainIdentity')
    THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
    PERFORM application_materialize_field_envelope(w,captured->'envelope');
   END LOOP;
  ELSIF fresh IS DISTINCT FROM initial THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE p.oid='native_turn_helpers_current()'::regprocedure)
  IS DISTINCT FROM '__CAPTURE_GUARD_FINGERPRINT__' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF clock_timestamp()>=(memo->>'validUntil')::timestamptz THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('history',coalesce((SELECT c->'rows' FROM jsonb_array_elements(initial) c WHERE c->>'type'='session_message'),'[]'::jsonb),
  'annotations',coalesce((SELECT c->'rows' FROM jsonb_array_elements(initial) c WHERE c->>'type'='session_message_annotation'),'[]'::jsonb));
END $function$;
REVOKE ALL ON FUNCTION capture_conversation_query(uuid,uuid,integer,integer) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION capture_conversation_query(uuid,uuid,integer,integer) TO app_user;
