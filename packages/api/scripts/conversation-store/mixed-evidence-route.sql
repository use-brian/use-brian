-- [COMP:api/caller-scope-evidence] Bounded topology for mixed source admission.
CREATE FUNCTION public.conversation_mixed_evidence_route(w uuid, roots jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $route$
DECLARE
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 native_roots constant text[]:=ARRAY['application_field','session_message','session_context_revision','memory','workspace_file','private_transcript'];
 page_kinds constant text[]:=ARRAY['page_event_changed','page_event_destination','page_live_changed','page_live_destination'];
 route jsonb;
BEGIN
 IF actor IS NULL OR nullif(current_setting('app.application_id',true),'') IS NOT NULL
  OR nullif(current_setting('app.public_share_root',true),'') IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.session_messages'::regclass
    WHERE r.rolname=session_user AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE')))
 THEN RETURN NULL; END IF;
 IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(roots) IS DISTINCT FROM 'array' OR jsonb_array_length(roots) NOT BETWEEN 1 AND 4096
 THEN RAISE EXCEPTION 'invalid_scope_source' USING ERRCODE='22023'; END IF;

 WITH RECURSIVE original AS MATERIALIZED(
  SELECT r.ord,r.kind,r.id,r.version
  FROM ROWS FROM(jsonb_to_recordset(roots) AS (kind text,id uuid,version text))
   WITH ORDINALITY AS r(kind,id,version,ord)
 ), reached(kind,id,version) AS(
  SELECT o.kind,o.id,o.version FROM original o WHERE o.kind=ANY(native_roots||page_kinds)
  UNION SELECT e.kind,e.id,e.version FROM reached p
   CROSS JOIN LATERAL conversation_source_edges(w,p.kind,p.id,p.version) e
  WHERE p.kind NOT IN ('conversation_record','conversation_record_refused','conversation_record_current_root')
 ), nodes AS MATERIALIZED(
  SELECT * FROM reached LIMIT 4097
 ), edges AS MATERIALIZED(
  SELECT n.kind AS pk,n.id AS pi,n.version AS pv,e.kind,e.id,e.version
  FROM nodes n CROSS JOIN LATERAL conversation_source_edges(w,n.kind,n.id,n.version) e
  WHERE n.kind NOT IN ('conversation_record','conversation_record_refused','conversation_record_current_root')
  LIMIT 65537
 ), types AS MATERIALIZED(
  SELECT n.*,CASE
   WHEN n.kind=ANY(page_kinds) THEN 'page'
   WHEN n.kind='conversation_record' THEN 'record'
   WHEN n.kind='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb
    AND f.type_key='memory' AND f.selection='history' THEN 'history'
   WHEN n.kind='application_field' AND (f.id IS NULL
     OR f.origin IS DISTINCT FROM '{"kind":"native","moduleKey":"native"}'::jsonb
     OR f.type_key NOT IN('session_message','session_message_annotation','memory')) THEN 'independent'
   WHEN n.kind='application_field' AND f.type_key='memory' AND f.selection='query_domain'
    AND EXISTS(SELECT 1 FROM application_query_domains d WHERE d.workspace_id=w AND d.id=f.resource_id
      AND d.domain->>'includeRetained'='true') THEN 'retained'
   WHEN n.kind=ANY(native_roots||ARRAY['application_query_domain','recording','episode']) THEN 'native'
   ELSE 'independent' END AS family
  FROM nodes n LEFT JOIN application_field_resources f ON n.kind='application_field' AND f.workspace_id=w AND f.id=n.id
 ), inherited(kind,id,version,family) AS(
  SELECT t.kind,t.id,t.version,t.family FROM types t WHERE t.family<>'native'
  UNION SELECT e.pk,e.pi,e.pv,a.family FROM inherited a
   JOIN edges e ON (e.kind,e.id,e.version)=(a.kind,a.id,a.version)
 ), families AS(
  SELECT o.ord,CASE
   WHEN NOT o.kind=ANY(native_roots||page_kinds) OR max(t.family)='independent' THEN 'independent'
   WHEN bool_or(a.family='record') THEN 'record'
   WHEN bool_or(a.family='history') AND max(t.family)='history' THEN 'history'
   WHEN bool_or(a.family IN ('history','independent')) THEN 'hybrid'
   WHEN bool_or(a.family='retained') THEN 'retained'
   WHEN bool_or(a.family='page') THEN 'page'
   ELSE 'native' END AS family
  FROM original o LEFT JOIN inherited a ON (o.kind,o.id,o.version)=(a.kind,a.id,a.version)
  LEFT JOIN types t ON (o.kind,o.id,o.version)=(t.kind,t.id,t.version)
  GROUP BY o.ord,o.kind
 )
 SELECT CASE WHEN (SELECT count(*) FROM nodes)>4096 OR (SELECT count(*) FROM edges)>65536 THEN NULL ELSE
  jsonb_build_object('actor',actor,'families',(SELECT jsonb_agg(family ORDER BY ord) FROM families),
   'footprint',encode(sha256(convert_to(jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.kind,t.id,t.version) FROM types t),
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.pk,e.pi,e.pv,e.kind,e.id,e.version) FROM edges e),
    (SELECT jsonb_build_array(c.revision,p.revision) FROM application_policy_contract_epoch c
     CROSS JOIN application_policy_workspace_epochs p WHERE c.singleton AND p.workspace_id=w),
    native_turn_context())::text,'UTF8')),'hex'))
  END INTO route;
 IF route IS NULL THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501'; END IF;
 RETURN route;
END $route$;
REVOKE ALL ON FUNCTION public.conversation_mixed_evidence_route(uuid,jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.conversation_mixed_evidence_route(uuid,jsonb) TO app_user;

-- The typed reader owns the native part of a closure with an independent
-- dependency. The receiver must still admit the explicitly returned leaves.
-- Database-native field observations are admitted exactly by their owning
-- native or application field adapter inside conversation_dag.
CREATE FUNCTION public.capture_hybrid_conversation_evidence(w uuid, roots jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $hybrid$
DECLARE
 route jsonb; memo jsonb; n record; stored jsonb; source jsonb; key text; selected_history boolean;
 native_roots constant text[]:=ARRAY['application_field','session_message','session_context_revision','memory','workspace_file','private_transcript'];
 page_kinds constant text[]:=ARRAY['page_event_changed','page_event_destination','page_live_changed','page_live_destination'];
 immutable jsonb:='[]'; currents jsonb:='[]'; independent jsonb:='[]';
BEGIN
 route:=public.conversation_mixed_evidence_route(w,roots);
 IF route IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(route->'families') f
  WHERE f NOT IN ('native','hybrid','retained','page','record','history'))
 THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501'; END IF;
 selected_history:=NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(route->'families') f WHERE f<>'history');
 IF NOT selected_history THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(route->'families') f WHERE f='history')
  THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501'; END IF;
  -- A retained conversation record keeps its own current origin/recipient proof.
  -- It does not go through the ordinary native source snapshot register.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(route->'families') f WHERE f='record')
   AND EXISTS(SELECT 1 FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text)
    WHERE public.conversation_record_derivation_current(w,r.kind,r.id,r.version,(route->>'actor')::uuid) IS NOT TRUE)
  THEN RETURN '{"admitted":false}'; END IF;
  memo:=public.conversation_dag(w,roots,'[]');
  IF memo->>'recordingEligible' IS DISTINCT FROM 'true' THEN RETURN '{"admitted":false}'; END IF;
 END IF;
 FOR n IN
  WITH RECURSIVE closure(kind,id,version) AS (
   SELECT * FROM jsonb_to_recordset(roots) AS r(kind text,id uuid,version text)
   UNION SELECT e.kind,e.id,e.version FROM closure c
    CROSS JOIN LATERAL public.conversation_source_edges(w,c.kind,c.id,c.version) e
  )
  SELECT * FROM closure
  WHERE NOT selected_history OR kind IN ('external_source','office_observation','page_event_changed','page_event_destination','page_live_changed','page_live_destination')
  ORDER BY kind,id,version
 LOOP
  key:=n.kind||':'||n.id||':'||n.version;
  IF n.kind='application_query_domain' THEN CONTINUE; END IF;
  IF n.kind='conversation_record' THEN
   IF n.version<>'1' OR NOT EXISTS(SELECT 1 FROM public.private_transcript_observations o
    WHERE o.workspace_id=w AND o.id=n.id AND o.binding->>'kind'='conversation_record_v1'
     AND o.binding->>'purpose'='native_member_dialogue')
   THEN RETURN '{"admitted":false}'; END IF;
   CONTINUE;
  END IF;
  IF n.kind='application_field' THEN
   source:=memo#>ARRAY['field:'||n.id||':'||n.version,'value'];
   IF source->>'held' IS DISTINCT FROM 'false' THEN RETURN '{"admitted":false}'; END IF;
   SELECT o.source_scope INTO STRICT stored FROM public.application_field_observations o
    WHERE o.workspace_id=w AND o.resource_id=n.id AND o.version=n.version;
   immutable:=immutable||jsonb_build_array(stored||jsonb_build_object('resourceKind',n.kind,'resourceId',n.id,'version',n.version));
  ELSIF n.kind='external_source' THEN
   -- The graph has already checked the live SQL pin. The caller separately
   -- requires the original context/delivery action on this exact observation.
   IF NOT selected_history AND memo#>>ARRAY['native:'||key,'value'] IS DISTINCT FROM 'true' THEN RETURN '{"admitted":false}'; END IF;
   SELECT jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'resourceKind',n.kind,
    'resourceId',n.id,'version',o.version,'sensitivity',o.sensitivity,'compartments',o.compartments,'projectIds',o.project_ids)
   INTO stored FROM public.external_source_observations o WHERE o.workspace_id=w AND o.id=n.id AND o.version=n.version;
   IF stored IS NULL THEN RETURN '{"admitted":false}'; END IF;
   independent:=independent||jsonb_build_array(stored);
   CONTINUE;
  ELSIF n.kind='office_observation' OR n.kind=ANY(page_kinds) THEN
   -- Both need the receiver's principal, which can differ from the SQL actor.
   -- Their host adapters check the saved identity and the exact current grants.
   stored:=public.read_scope_source(w,n.kind,n.id);
   IF stored->>'held' IS DISTINCT FROM 'false' OR stored->>'version' IS DISTINCT FROM n.version
   THEN RETURN '{"admitted":false}'; END IF;
   independent:=independent||jsonb_build_array(stored-ARRAY['held','validTo','retractedAt','requiredSources']);
   CONTINUE;
  ELSE
   IF n.kind NOT IN ('recording','episode') AND NOT n.kind=ANY(native_roots)
    AND public.scope_source_table(n.kind) IS NULL
   THEN RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='42501'; END IF;
   IF memo#>>ARRAY['native:'||key,'value'] IS DISTINCT FROM 'true' THEN RETURN '{"admitted":false}'; END IF;
   source:=memo#>ARRAY['current',key];
   IF source IS NULL OR source='null'::jsonb THEN CONTINUE; END IF;
   IF n.kind='session_context_revision' AND source->>'version' IS DISTINCT FROM n.version
   THEN RETURN '{"admitted":false}'; END IF;
  END IF;
  source:=jsonb_build_object('workspaceId',w,'userId',source->'userId','assistantId',source->'assistantId',
   'sensitivity',source->'sensitivity','compartments',source->'compartments','projectIds',source->'projectIds',
   'resourceKind',n.kind,'resourceId',n.id,'version',source->'version');
  IF n.kind='session_context_revision' THEN immutable:=immutable||jsonb_build_array(source); END IF;
  currents:=currents||jsonb_build_array(source);
 END LOOP;
 IF native_turn_helpers_current() IS NOT TRUE OR NOT selected_history AND clock_timestamp()>=(memo->>'validUntil')::timestamptz
  OR public.conversation_mixed_evidence_route(w,roots) IS DISTINCT FROM route
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('admitted',true,'immutable',immutable,'current',currents,'independent',independent);
END $hybrid$;
REVOKE ALL ON FUNCTION public.capture_hybrid_conversation_evidence(uuid,jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION public.capture_hybrid_conversation_evidence(uuid,jsonb) TO app_user;
