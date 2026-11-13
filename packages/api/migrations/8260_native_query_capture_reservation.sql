-- [COMP:api/native-chat-read-cost] Reserve staged query graphs without charging every reused capture as new.
-- Capacity only: source admission, immutable writes and the fresh final compiler remain unchanged.
BEGIN;
DO $query_capture_reservation$
DECLARE target regprocedure:='public.read_native_turn_session_query(uuid,uuid,integer,integer)'::regprocedure;
 routine pg_proc;original text;successor text;old_fingerprint text;new_fingerprint text;signature text;ok boolean;
 declaration_anchor constant text:=$declaration_anchor$ all_captures jsonb:='[]';sources jsonb;source_tuple jsonb;history jsonb;annotations jsonb;$declaration_anchor$;
 reservation_declaration constant text:=$reservation_declaration$
 reservation_metadata jsonb;reservation_semantic_nodes jsonb;reservation_semantic_edges jsonb;reservation_staged_privacy jsonb;
 reservation_privacy_nodes jsonb:='[]';reservation_privacy_edges jsonb:='[]';reservation_frontier jsonb;
 reservation_batch jsonb;reservation_next jsonb;reservation_step integer:=0;
$reservation_declaration$;
 before_branch constant text:=$before_branch$ -- Each new canonical capture adds at most its field resource, query-domain
 -- source, and metadata node; its existing point/native dependencies were all
 -- seeded before admission. These conservative budgets keep predictable
 -- final-compiler overflow on the pre-write fallback side of the boundary.
 IF jsonb_array_length(all_captures)>4096
  OR (initial#>>'{counts,semanticNodes}')::integer+3*jsonb_array_length(all_captures)>4096
  OR (initial#>>'{counts,privacyNodes}')::integer+3*jsonb_array_length(all_captures)>4096
  OR (initial#>>'{counts,semanticEdges}')::integer+16*jsonb_array_length(all_captures)>16384
  OR (initial#>>'{counts,privacyEdges}')::integer+16*jsonb_array_length(all_captures)>16384
 THEN RETURN NULL;END IF;$before_branch$;
 reservation_branch constant text:=$reservation_branch$ -- Capacity planning only. The admitted initial graph already contains every
 -- physical selector point, including rows filtered out of the returned values.
 -- Add the exact staged observation relations instead of a per-capture charge.
 IF jsonb_array_length(all_captures)>4096 THEN RETURN NULL;END IF;
 -- Compact admission deliberately returns only its native/parent witnesses.
 -- Obtain the complete bounded graph from the canonical metadata compiler;
 -- missing graph arrays must never become an empty capacity reservation.
 reservation_metadata:=native_turn_compact_metadata(w,roots,selectors);
 IF reservation_metadata->>'eligibleMetadata' IS DISTINCT FROM 'true'
  OR jsonb_typeof(reservation_metadata#>'{witness,nodes}') IS DISTINCT FROM 'array'
  OR jsonb_typeof(reservation_metadata#>'{witness,edges}') IS DISTINCT FROM 'array'
  OR jsonb_typeof(reservation_metadata#>'{witness,privacyNodes}') IS DISTINCT FROM 'array'
 THEN RETURN NULL;END IF;
 IF reservation_metadata->'counts' IS DISTINCT FROM initial->'counts'
  OR reservation_metadata#>'{counts,semanticNodes}' IS DISTINCT FROM to_jsonb(jsonb_array_length(reservation_metadata#>'{witness,nodes}'))
  OR reservation_metadata#>'{counts,semanticEdges}' IS DISTINCT FROM to_jsonb(jsonb_array_length(reservation_metadata#>'{witness,edges}'))
  OR reservation_metadata#>'{counts,privacyNodes}' IS DISTINCT FROM to_jsonb(jsonb_array_length(reservation_metadata#>'{witness,privacyNodes}'))
  OR reservation_metadata#>'{witness,nativeMetadata}' IS DISTINCT FROM initial#>'{requirements,nativeMetadata}'
  OR reservation_metadata#>'{witness,sessionParents}' IS DISTINCT FROM initial#>'{requirements,sessionParents}'
 THEN RETURN NULL;END IF;
 WITH captures AS MATERIALIZED(SELECT value e FROM jsonb_array_elements(all_captures)),
 staged(parent,child,edge_kind) AS (
  SELECT jsonb_build_object('tag','source','kind','application_field','id',e->'resourceId','version',e#>'{source,version}'),
   jsonb_build_object('tag','source','kind',e#>'{state,sourceKind}','id',e#>'{state,sourceId}','version',e#>'{state,sourceVersion}'),'observation'
  FROM captures
  UNION ALL
  SELECT jsonb_build_object('tag','source','kind','application_field','id',e->'resourceId','version',e#>'{source,version}'),
   jsonb_build_object('tag','source','kind',source->'resourceKind','id',source->'resourceId','version',source->'version'),'observation_child'
  FROM captures CROSS JOIN LATERAL jsonb_array_elements(e->'sources') source
  UNION ALL
  SELECT jsonb_build_object('tag','source','kind','application_field','id',e->'resourceId','version',e#>'{source,version}'),
   jsonb_build_object('tag','point','kind',e->'typeKey','id',e->'id','fields',e->'fields'),'field_point'
  FROM captures WHERE e->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
   AND e->>'typeKey' IN('session_message','session_message_annotation') AND e->>'selectedVersion' IS NULL
   AND e->>'selection' IN('read','query','identity')
  UNION ALL
  SELECT jsonb_build_object('tag','source','kind','application_query_domain','id',q->'domainId','version',q->'domainIdentity'),
   jsonb_build_object('tag','point','kind',q->'type','id',m.id,'fields',q#>'{domain,fields}'),'domain_candidate'
  FROM jsonb_array_elements(initial->'queryCaptures') q JOIN session_messages m
   ON m.workspace_id=w AND m.session_id=(q#>>'{domain,sessionId}')::uuid
   AND m.sequence_num<=(q#>>'{domain,throughSequence}')::integer
 ), combined AS (
  SELECT value edge FROM jsonb_array_elements(reservation_metadata#>'{witness,edges}')
  UNION ALL SELECT jsonb_build_object('parent',parent,'child',child,'edge_kind',edge_kind) FROM staged
 ), bounded AS(SELECT DISTINCT edge FROM combined LIMIT 16385)
 SELECT coalesce(jsonb_agg(edge),'[]'::jsonb) INTO reservation_semantic_edges FROM bounded;
 IF jsonb_array_length(reservation_semantic_edges)>16384 THEN RETURN NULL;END IF;
 WITH combined AS (
  SELECT value node FROM jsonb_array_elements(reservation_metadata#>'{witness,nodes}')
  UNION ALL SELECT value->'parent' FROM jsonb_array_elements(reservation_semantic_edges)
  UNION ALL SELECT value->'child' FROM jsonb_array_elements(reservation_semantic_edges)
 ), bounded AS(SELECT DISTINCT node FROM combined LIMIT 4097)
 SELECT coalesce(jsonb_agg(node),'[]'::jsonb) INTO reservation_semantic_nodes FROM bounded;
 IF jsonb_array_length(reservation_semantic_nodes)>4096 THEN RETURN NULL;END IF;

 -- Recording privacy is versionless and includes all retained observations.
 -- Rebuild its bounded closure with the staged relations overlaid on canonical
 -- stored adjacency. Reused resources may have older versions outside the
 -- initial roots; their ancestors must not disappear from the reservation.
 WITH captures AS MATERIALIZED(SELECT value e FROM jsonb_array_elements(all_captures)), staged(parent,child) AS (
  SELECT jsonb_build_object('kind','application_field','id',e->'resourceId'),
   jsonb_build_object('kind',e#>'{state,sourceKind}','id',e#>'{state,sourceId}') FROM captures
  UNION ALL
  SELECT jsonb_build_object('kind','application_field','id',e->'resourceId'),
   jsonb_build_object('kind',source->'resourceKind','id',source->'resourceId')
  FROM captures CROSS JOIN LATERAL jsonb_array_elements(e->'sources') source
  UNION ALL
  -- The canonical resource-metadata edge exists for query-domain fields too.
  SELECT jsonb_build_object('kind','application_field','id',e->'resourceId'),
   jsonb_build_object('kind','session_message','id',e->'id') FROM captures
  WHERE e->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb
   AND e->>'typeKey' IN('session_message','session_message_annotation')
 ), bounded AS(SELECT DISTINCT parent,child FROM staged LIMIT 16385)
 SELECT coalesce(jsonb_agg(jsonb_build_object('parent',parent,'child',child)),'[]'::jsonb)
 INTO reservation_staged_privacy FROM bounded;
 IF jsonb_array_length(reservation_staged_privacy)>16384 THEN RETURN NULL;END IF;
 WITH combined AS (
  SELECT value node FROM jsonb_array_elements(reservation_metadata#>'{witness,privacyNodes}')
  UNION ALL SELECT value->'parent' FROM jsonb_array_elements(reservation_staged_privacy)
  UNION ALL SELECT value->'child' FROM jsonb_array_elements(reservation_staged_privacy)
 ), bounded AS(SELECT DISTINCT node FROM combined LIMIT 4097)
 SELECT coalesce(jsonb_agg(node),'[]'::jsonb) INTO reservation_frontier FROM bounded;
 IF jsonb_array_length(reservation_frontier)>4096 THEN RETURN NULL;END IF;
 WHILE jsonb_array_length(reservation_frontier)>0 LOOP
  reservation_step:=reservation_step+1;
  IF reservation_step>4096 THEN RETURN NULL;END IF;
  WITH combined AS (
   SELECT parent,child FROM native_turn_privacy_edges(w,reservation_frontier)
   UNION ALL
   SELECT edge->'parent',edge->'child' FROM jsonb_array_elements(reservation_staged_privacy) edge
    WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(reservation_frontier) node WHERE node=edge->'parent')
  ), bounded AS(SELECT DISTINCT parent,child FROM combined LIMIT 16385)
  SELECT coalesce(jsonb_agg(jsonb_build_object('parent',parent,'child',child)),'[]'::jsonb)
  INTO reservation_batch FROM bounded;
  WITH bounded AS (
   SELECT DISTINCT value edge FROM jsonb_array_elements(reservation_privacy_edges||reservation_batch) LIMIT 16385
  ) SELECT coalesce(jsonb_agg(edge),'[]'::jsonb) INTO reservation_privacy_edges FROM bounded;
  IF jsonb_array_length(reservation_privacy_edges)>16384 THEN RETURN NULL;END IF;
  WITH bounded AS (
   SELECT DISTINCT value node FROM jsonb_array_elements(reservation_privacy_nodes||reservation_frontier) LIMIT 4097
  ) SELECT coalesce(jsonb_agg(node),'[]'::jsonb) INTO reservation_privacy_nodes FROM bounded;
  IF jsonb_array_length(reservation_privacy_nodes)>4096 THEN RETURN NULL;END IF;
  WITH bounded AS (
   SELECT DISTINCT edge->'child' node FROM jsonb_array_elements(reservation_batch) edge
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(reservation_privacy_nodes) seen WHERE seen=edge->'child') LIMIT 4097
  ) SELECT coalesce(jsonb_agg(node),'[]'::jsonb) INTO reservation_next FROM bounded;
  IF jsonb_array_length(reservation_privacy_nodes)+jsonb_array_length(reservation_next)>4096 THEN RETURN NULL;END IF;
  reservation_frontier:=reservation_next;
 END LOOP;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR clock_timestamp()>=(initial->>'validUntil')::timestamptz THEN RETURN NULL;END IF;
 -- No admission result is carried by this plan. The original write loop and
 -- independent fresh canonical compiler below still own every source decision.
$reservation_branch$;
BEGIN
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'query_reservation_dependency_changed: %',signature;END IF;
 END LOOP;
 SELECT * INTO STRICT routine FROM pg_proc WHERE oid=target;
 original:=routine.prosrc;
 old_fingerprint:=encode(sha256(convert_to(to_jsonb(routine)::text,'UTF8')),'hex');
 IF encode(sha256(convert_to(original,'UTF8')),'hex') IS DISTINCT FROM 'e9a09bf8f31898a3c66b00ddc6848a6fd1caa9a4be61993005f383c4e9c2981a'
  OR routine.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
  OR routine.pronamespace<>'public'::regnamespace OR routine.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR NOT routine.prosecdef OR routine.provolatile<>'v' OR routine.proparallel<>'u' OR routine.prokind<>'f'
  OR routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  OR routine.prorettype<>'jsonb'::regtype OR routine.proargtypes<>'2950 2950 23 23'::oidvector OR routine.pronargs<>4
  OR routine.proargnames IS DISTINCT FROM ARRAY['w','s','body_through','topics_through']
  OR routine.proargmodes IS NOT NULL OR routine.proallargtypes IS NOT NULL OR routine.proargdefaults IS NOT NULL
  OR routine.pronargdefaults<>0 OR routine.provariadic<>0 OR routine.proretset OR routine.proisstrict OR routine.proleakproof
  OR routine.procost<>100 OR routine.prorows<>0 OR routine.probin IS NOT NULL OR routine.prosqlbody IS NOT NULL
  OR routine.prosupport<>0 OR routine.protrftypes IS NOT NULL
  OR (SELECT count(*)=2 AND coalesce(bool_and(a.grantee IN(routine.proowner,(SELECT oid FROM pg_roles WHERE rolname='app_user'))
    AND a.grantor=routine.proowner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable),false)
   FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h
   WHERE h.signature='read_native_turn_session_query(uuid,uuid,integer,integer)' AND h.fingerprint=old_fingerprint)
 THEN RAISE EXCEPTION 'query_reservation_predecessor_changed';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.prokind='f' AND p.oid<>target AND (
  position(quote_literal(original) IN p.prosrc)>0 OR position(old_fingerprint IN p.prosrc)>0
  OR position(encode(sha256(convert_to(original,'UTF8')),'hex') IN p.prosrc)>0))
 THEN RAISE EXCEPTION 'query_reservation_unexpected_pin_consumer';END IF;
 IF (length(original)-length(replace(original,declaration_anchor,'')))/length(declaration_anchor)<>1
  OR (length(original)-length(replace(original,before_branch,'')))/length(before_branch)<>1
 THEN RAISE EXCEPTION 'query_reservation_splice_changed';END IF;
 successor:=replace(replace(original,declaration_anchor,declaration_anchor||reservation_declaration),before_branch,reservation_branch);
 EXECUTE replace(pg_get_functiondef(target),original,successor);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=target) IS DISTINCT FROM to_jsonb(routine)-'prosrc'
  OR (SELECT prosrc FROM pg_proc WHERE oid=target) IS DISTINCT FROM successor
 THEN RAISE EXCEPTION 'query_reservation_metadata_changed';END IF;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT new_fingerprint FROM pg_proc p WHERE oid=target;
 UPDATE native_turn_contract_helpers h SET fingerprint=new_fingerprint
  WHERE h.signature='read_native_turn_session_query(uuid,uuid,integer,integer)' AND h.fingerprint=old_fingerprint;
 IF NOT FOUND THEN RAISE EXCEPTION 'query_reservation_registry_changed';END IF;
 FOREACH signature IN ARRAY ARRAY['native_turn_helpers_current()','native_turn_publication_contract()',
  'application_native_worklist_helpers_current()','application_native_dependency_batch_helpers_current()',
  'application_native_field_reference_helpers_current()','application_memory_statement_helpers_current()'] LOOP
  EXECUTE 'SELECT public.'||signature INTO ok;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'query_reservation_successor_changed: %',signature;END IF;
 END LOOP;
END $query_capture_reservation$;
COMMIT;
