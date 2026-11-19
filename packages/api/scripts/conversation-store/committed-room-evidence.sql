-- [COMP:api/native-turn-frame] Original record edges of a committed room result.
CREATE FUNCTION public.capture_committed_room_record_evidence(w uuid,s uuid,roots jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $committed_room$
DECLARE route jsonb; membership jsonb; graph jsonb; edge record; node record; source jsonb; observed jsonb; key text; edge_count integer:=0;
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_class c ON c.oid='public.sessions'::regclass
  JOIN pg_catalog.pg_roles runtime ON runtime.rolname='app_user'
  WHERE p.oid='public.conversation_mixed_evidence_route(uuid,jsonb)'::regprocedure
   AND p.proowner=c.relowner AND p.prosecdef AND p.provolatile='s'
   AND p.proconfig=ARRAY['search_path=pg_catalog, public, pg_temp']
   AND p.proacl=ARRAY[makeaclitem(c.relowner,c.relowner,'EXECUTE',false),makeaclitem(runtime.oid,c.relowner,'EXECUTE',false)]
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='__ROUTE_BODY_SHA__'
 ) THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 route:=public.conversation_mixed_evidence_route(w,roots);
 IF route IS NULL OR NOT (route->'families') ? 'record' THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(route->'families') f WHERE f NOT IN ('native','record','retained'))
 THEN RETURN NULL; END IF;

 -- This owner only receives roots derived from the immutable publication
 -- receipt. The canonical destination lock is already held by its caller.
 WITH RECURSIVE closure(kind,id,version) AS (
  SELECT * FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text)
  UNION SELECT e.kind,e.id,e.version FROM closure c
  CROSS JOIN LATERAL public.conversation_source_edges(w,c.kind,c.id,c.version) e
  WHERE c.kind<>'conversation_record'
 )
 SELECT jsonb_agg(to_jsonb(reached)) INTO membership FROM (SELECT * FROM closure LIMIT 4097) reached;
 IF jsonb_array_length(membership)>4096 OR EXISTS (
  SELECT 1 FROM jsonb_to_recordset(membership) AS candidate(kind text,id uuid,version text)
  WHERE candidate.version IS NULL OR CASE candidate.kind
   WHEN 'session_message' THEN NOT EXISTS(SELECT 1 FROM public.session_messages m
    WHERE m.workspace_id=w AND m.session_id=s AND m.id=candidate.id AND m.scope_version::text=candidate.version)
   WHEN 'session_context_revision' THEN NOT EXISTS(SELECT 1 FROM public.session_context_scope_revisions r
    WHERE r.workspace_id=w AND r.session_id=s AND r.id=candidate.id AND r.scope_version::text=candidate.version)
   WHEN 'conversation_record' THEN candidate.version<>'1' OR NOT EXISTS(SELECT 1 FROM public.private_transcript_observations o
    WHERE o.workspace_id=w AND o.session_id=s AND o.id=candidate.id AND o.binding->>'kind'='conversation_record_v1'
     AND o.binding->>'purpose'='native_member_dialogue')
   ELSE false END
 ) THEN RETURN '{"admitted":false}'; END IF;
 FOR edge IN
  SELECT d.id,s.source_id,s.source_version FROM jsonb_to_recordset(membership) AS n(kind text,id uuid,version text)
  JOIN public.scope_derivations d ON d.workspace_id=w AND d.resource_kind=n.kind AND d.resource_id=n.id
  JOIN public.scope_derivation_sources s ON s.workspace_id=w AND s.derivation_id=d.id
  WHERE s.source_kind='conversation_record' AND s.source_id IS NOT NULL
  ORDER BY d.id,s.source_id LIMIT 65537
 LOOP
  edge_count:=edge_count+1;
  IF edge_count>65536 THEN RETURN '{"admitted":false}'; END IF;
  PERFORM public.require_conversation_record_edge(w,edge.id,edge.source_id,edge.source_version);
 END LOOP;
 IF edge_count=0 THEN RETURN '{"admitted":false}'; END IF;

 -- This is continuity of the exact same room, not an external derivative
 -- from each output row. The preceding owner already proved the recorded
 -- edges and their original destination. Evaluate the native row graph once.
 graph:=public.conversation_dag(w,roots,'[]');
 IF graph->>'recordingEligible' IS DISTINCT FROM 'true' OR graph->>'hasExternal' IS DISTINCT FROM 'false'
  OR clock_timestamp()>=(graph->>'validUntil')::timestamptz THEN RETURN '{"admitted":false}'; END IF;
 FOR node IN SELECT * FROM jsonb_to_recordset(membership) AS n(kind text,id uuid,version text)
  WHERE n.kind NOT IN ('application_query_domain','conversation_record')
 LOOP
  key:=node.kind||':'||node.id||':'||node.version;
  IF node.kind='application_field' THEN
   source:=graph#>ARRAY['field:'||node.id||':'||node.version,'value'];
   SELECT o.source_scope INTO observed FROM public.application_field_observations o
    WHERE o.workspace_id=w AND o.resource_id=node.id AND o.version=node.version;
   IF public.workflow_evidence_envelope_visible(w,observed) IS NOT TRUE THEN RETURN '{"admitted":false}'; END IF;
  ELSE
   IF node.kind NOT IN ('session_message','session_context_revision','workspace_file','memory','private_transcript','recording','episode')
    OR graph#>>ARRAY['native:'||key,'value'] IS DISTINCT FROM 'true'
   THEN RETURN '{"admitted":false}'; END IF;
   source:=graph#>ARRAY['current',key];
  END IF;
  IF source->>'held' IS DISTINCT FROM 'false' OR public.workflow_evidence_envelope_visible(w,source) IS NOT TRUE
  THEN RETURN '{"admitted":false}'; END IF;
 END LOOP;
 IF public.conversation_mixed_evidence_route(w,roots) IS DISTINCT FROM route
  OR clock_timestamp()>=(graph->>'validUntil')::timestamptz
 THEN RETURN '{"admitted":false}'; END IF;
 RETURN '{"admitted":true}';
EXCEPTION WHEN insufficient_privilege THEN RETURN '{"admitted":false}';
END $committed_room$;
REVOKE ALL ON FUNCTION public.capture_committed_room_record_evidence(uuid,uuid,jsonb) FROM PUBLIC,app_user;
