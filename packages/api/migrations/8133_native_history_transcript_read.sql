BEGIN;
-- [COMP:api/application-persistence] Exact native point/domain read binding for
-- the first canonical history-containing transcript. Three existing unpinned bodies.
DO $history_read_prerequisites$
DECLARE item jsonb;actual pg_proc;canonical_owner oid;actual_acl jsonb;expected_acl jsonb;guard pg_proc;
 lineage_pins text;lineage_pin_count integer;expected_lineage_body text;
 historical_edge_body CONSTANT text:=$historical_edge$
 SELECT e.kind,e.id,e.version FROM knowledge_version_source_edges(w,k,i,v) e
$historical_edge$;
 reviewed_lineage_body CONSTANT text:=$reviewed_lineage$
DECLARE nodes jsonb;
BEGIN
 IF kinds IS NULL OR ids IS NULL OR versions IS NULL
  OR cardinality(kinds) IS DISTINCT FROM cardinality(ids) OR cardinality(ids) IS DISTINCT FROM cardinality(versions)
  OR cardinality(ids) NOT BETWEEN 1 AND 100 OR array_position(kinds,NULL) IS NOT NULL
  OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023'; END IF;
 -- R2 canonical entity leaf transport, after the original complete input validation.
 IF w IS NOT NULL AND cardinality(ids)=1
  AND array_ndims(kinds)=1 AND array_lower(kinds,1)=1
  AND array_ndims(ids)=1 AND array_lower(ids,1)=1
  AND array_ndims(versions)=1 AND array_lower(versions,1)=1
  AND kinds[1] IN('entity','memory')
  AND NOT EXISTS(SELECT 1 FROM public.scope_derivations d
   WHERE d.workspace_id=w AND d.resource_kind=kinds[1] AND d.resource_id=ids[1])
  AND (kinds[1]='entity' AND NOT EXISTS(SELECT 1 FROM public.entities e
    WHERE e.workspace_id=w AND e.superseded_by=ids[1])
   OR kinds[1]='memory' AND NOT EXISTS(SELECT 1 FROM public.memories m
    WHERE m.workspace_id=w AND m.superseded_by=ids[1]))
  AND (SELECT count(*)=11 AND coalesce(bool_and(public.application_field_digest(jsonb_build_object('name',r.proname,'namespace',r.pronamespace,'body',r.prosrc,'config',r.proconfig,'language',r.prolang,'securityDefiner',r.prosecdef,'volatility',r.provolatile,'strict',r.proisstrict,'parallel',r.proparallel))=pin.fingerprint),false)
   FROM (VALUES %s) pin(function_oid,fingerprint)
   JOIN pg_catalog.pg_proc r ON r.oid=pin.function_oid) THEN
  RETURN QUERY SELECT kinds[1],ids[1],versions[1];
  RETURN;
 END IF;
 WITH RECURSIVE lineage(kind,id,version) AS (
  SELECT * FROM unnest(kinds,ids,versions)
  UNION
  SELECT next.kind,next.id,next.version FROM lineage l
   CROSS JOIN LATERAL application_scope_source_edges(w,l.kind,l.id,l.version) next
 ), bounded AS MATERIALIZED(SELECT * FROM lineage LIMIT 4097)
 SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]') INTO nodes FROM bounded b;
 -- UNION terminates native high-water back-edges (including a row edited from
 -- its earlier version). New field-child graphs are separately depth bounded
 -- by capture and the admitted reader; no app role may author metadata edges.
 IF jsonb_array_length(nodes)>4096 OR EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n
  WHERE n->>'version' IS NULL OR n->>'kind' IS NULL OR n->>'id' IS NULL
   OR n->>'kind'='application_field' AND NOT EXISTS(SELECT 1 FROM application_field_observations o
    WHERE o.workspace_id=w AND o.resource_id=(n->>'id')::uuid AND o.version=n->>'version')) THEN
  RAISE EXCEPTION 'scope_ancestry_unavailable' USING ERRCODE='22023'; END IF;
 RETURN QUERY SELECT DISTINCT n->>'kind',(n->>'id')::uuid,n->>'version' FROM jsonb_array_elements(nodes) n;
END $reviewed_lineage$;
BEGIN
 SELECT relowner INTO canonical_owner FROM pg_class WHERE oid='public.memories'::regclass;
 -- Validate CURRENT fixed definitions before reconstructing historical local pins.
 FOR item IN SELECT value FROM jsonb_array_elements($lineage_helpers$[{"signature":"public.application_scope_source_edges(uuid,text,uuid,text)","body":"eb8966087803239c93bcdac1736ba917251adaed34c244feb3f80bc80d2c9077","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_scope_source_edges","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t","t"],"proargnames":["w","k","i","v","kind","id","version"],"proargtypes":["2950","25","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","25","25","2950","25"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)","body":"20d8c359a6b77c9c96aed3be9e31719e60868fb55e34aaedc2714494e6a8e974","language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_scope_source_edges_before_knowledge_versions","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t","t"],"proargnames":["w","k","i","v","kind","id","version"],"proargtypes":["2950","25","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","25","25","2950","25"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.knowledge_version_source_edges(uuid,text,uuid,text)","body":"f4deb0d7b7ef41db5dc1d2fedabcef545c836b9f8a78f48d55a2c7413e62f1cf","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"knowledge_version_source_edges","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t","t"],"proargnames":["w","k","i","v","kind","id","version"],"proargtypes":["2950","25","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","25","25","2950","25"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.scope_source_ancestors(uuid,text,uuid)","body":"d8e33fb3a66e4318ed159e288c797b6d55759481e1339d4e53c372cb6907e0e8","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_ancestors","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t"],"proargnames":["w","k","i","resource_id"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","2950"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)","body":"36bdb461a66fb00b81a5f0f6672b48dcc150858328b035b1ba1da0c3ed3715c8","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_ancestors_before_workflow_run","prorows":1000,"pronargs":3,"proconfig":["search_path=public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t"],"proargnames":["w","k","i","resource_id"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","2950"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.scope_source_ancestors_before_browser_session(uuid,text,uuid)","body":"c5a684292738319265321ce21b76ea01ba775eb216af66ae992c190d39eedc5c","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_ancestors_before_browser_session","prorows":1000,"pronargs":3,"proconfig":["search_path=public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t"],"proargnames":["w","k","i","resource_id"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","2950"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)","body":"401b62c0bf792041938e92d7ea4207f4a3f7bb9f070bfb6a4bea3aa0ee5cb957","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_ancestors_before_browser_profile","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t"],"proargnames":["p_workspace","p_kind","p_id","resource_id"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","25","2950","2950"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.scope_source_table(text)","body":"adc507baa12e1e269887ce7734b66abfce202cb44baf64aea866f2ff82343984","language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_table","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["k"],"proargtypes":["25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.scope_source_table_before_knowledge_versions(text)","body":"50b1e162e95c2cb9e01300d2ed70041cf89350004e11476352463eeba1e9d3d6","language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_table_before_knowledge_versions","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["k"],"proargtypes":["25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.scope_source_table_before_persistent_context(text)","body":"77ae7215cf985148bc013cd5afd14cac03776580e347bf548c67b6d1ca7f40da","language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_table_before_persistent_context","prorows":0,"pronargs":1,"proconfig":null,"proretset":false,"prosecdef":false,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["k"],"proargtypes":["25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.scope_source_table_before_media(text)","body":"93ff1be795bfbee59a38c43da3425018072c18007fe39e99ecd4d7e8731eba15","language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"scope_source_table_before_media","prorows":0,"pronargs":1,"proconfig":null,"proretset":false,"prosecdef":false,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_kind"],"proargtypes":["25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]$lineage_helpers$::jsonb) LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(item->>'signature');
  IF NOT FOUND OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM item->>'body'
   OR actual.proowner IS DISTINCT FROM canonical_owner OR actual.pronamespace IS DISTINCT FROM 'public'::regnamespace
   OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=item->>'language')
   OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM item->'metadata' THEN
   RAISE EXCEPTION 'Native history transcript read lineage helper prerequisite changed: %',item->>'signature';END IF;
  SELECT jsonb_agg(jsonb_build_array(a.grantee,a.grantor,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable)
   INTO actual_acl FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
  IF actual_acl IS DISTINCT FROM jsonb_build_array(jsonb_build_array(canonical_owner,canonical_owner,'EXECUTE',false)) THEN
   RAISE EXCEPTION 'Native history transcript read lineage helper ACL prerequisite changed: %',item->>'signature';END IF;
 END LOOP;
 -- 8128 changed the first current helper, while lineage intentionally keeps its
 -- reviewed 8079 SQL pin. Reconstruct that historical pin; never repin lineage.
 IF encode(sha256(convert_to(historical_edge_body,'UTF8')),'hex') IS DISTINCT FROM '14535b6ea617c43c10f030e519d61bfc558f649876530f9d9f03cc019f7d6be3' THEN
  RAISE EXCEPTION 'Native history transcript read historical edge literal changed';END IF;
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,
  public.application_field_digest(jsonb_build_object('name',p.proname,'namespace',p.pronamespace,
   'body',CASE WHEN helper.ordinal=1 THEN historical_edge_body ELSE p.prosrc END,
   'config',p.proconfig,'language',CASE WHEN helper.ordinal=1 THEN (SELECT oid FROM pg_language WHERE lanname='sql') ELSE p.prolang END,
   'securityDefiner',p.prosecdef,'volatility',p.provolatile,'strict',p.proisstrict,'parallel',p.proparallel))),',' ORDER BY helper.ordinal),count(*)
 INTO lineage_pins,lineage_pin_count
 FROM unnest(ARRAY['public.application_scope_source_edges(uuid,text,uuid,text)','public.application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','public.knowledge_version_source_edges(uuid,text,uuid,text)','public.scope_source_ancestors(uuid,text,uuid)','public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)','public.scope_source_ancestors_before_browser_session(uuid,text,uuid)','public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)','public.scope_source_table(text)','public.scope_source_table_before_knowledge_versions(text)','public.scope_source_table_before_persistent_context(text)','public.scope_source_table_before_media(text)']::text[]) WITH ORDINALITY helper(signature,ordinal)
 JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(helper.signature);
 IF lineage_pin_count<>11 THEN RAISE EXCEPTION 'Native history transcript read lineage identity set changed';END IF;
 expected_lineage_body:=format(reviewed_lineage_body,lineage_pins);
 FOR item IN SELECT value FROM jsonb_array_elements($expected$[{"signature":"public.read_external_source_dependencies(uuid,text[],uuid[],text[])","body":"49d22c1cfdb98f6eb0d4421a8c080bebc55b3d843f234d0805968366db4186a2","runtime":false,"language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_external_source_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_scope_lineage(uuid,text[],uuid[],text[])","body":null,"runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_scope_lineage","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t","t"],"proargnames":["w","kinds","ids","versions","kind","id","version"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","2950","25"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.read_admitted_application_field_snapshot(uuid,uuid,text)","body":"abd012f3005c058db7eee5816037a3ba5dbad91dbc80476d63ef3c85e979936d","runtime":true,"language":"sql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_application_field_snapshot","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v"],"proargtypes":["2950","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.validate_application_field_dependencies()","body":"6f86fbd4c0cc5c77e69a91c6c0c211b0b70c69f49dfd89b3ec85eddff39d9091","runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"validate_application_field_dependencies","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"2279","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)","body":"b15a27fe7a3ec273648b47c19dbaefe940b623a81a45c7761a35b8c2ebf52063","runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_canonical_ancestry_allowed","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v","writing"],"proargtypes":["2950","25","2950","25","16"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":"({CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 0 0 0 0 ]})","pronargdefaults":1}},{"signature":"public.application_field_envelope_ancestry_allowed(uuid,jsonb)","body":"79a23f4fc8d7047973d8b421b4de7285b014ce5c920cbbed75e15f17130f64fb","runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_field_envelope_ancestry_allowed","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","envelope"],"proargtypes":["2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_session_eval_scope(uuid,text,uuid,text,jsonb)","body":"8e2bbdf1f94920c03737e243e08ce75ee7e36d0571269de01c576bc9b8f53729","runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_scope","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v","memo"],"proargtypes":["2950","25","2950","25","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_session_eval_point_state(uuid,text,uuid,text[],jsonb)","body":"f5193aa3bf1e6824d9923260e9a1944c7f7e36169d52e3852fc2489479411fe0","runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_point_state","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","t","i","fields","memo"],"proargtypes":["2950","25","2950","1009","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_session_eval_field(uuid,uuid,text,jsonb)","body":"dfef37bfccf5ccb2f0258c83396fea6b735fcfe1563f36440198166d652d6ba4","runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_field","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v","memo"],"proargtypes":["2950","2950","25","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)","body":"50973b8ff2d29e46ac9fdc0a424b8100d50ce28d3de6964eee52bde01cda43d7","runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_compute_field_envelope","prorows":0,"pronargs":8,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","p_origin","p_type","p_id","p_selection","p_selected_version","p_fields","depth"],"proargtypes":["2950","3802","25","2950","25","25","1009","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":"({CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]})","pronargdefaults":1}},{"signature":"public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])","body":"9d27f33becac8535d1faa949d629b5f460955bfc4a0191f5cb26c3e26975645d","runtime":true,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_dependencies","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t"],"proargnames":["w","kinds","ids","versions","node_version","source"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","3802"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])","body":"02b30a1673331cf5468fd09bd87db98a2e2a7cea528e5c4c5973b36a61ff7b2e","runtime":true,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_attended_memory_evidence","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","kinds","ids","versions"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)","body":"56495fea6eade9f397d21dc725501159dc3f928c2786dcb005dedc4513e0f30d","runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"prepare_native_session_message_batch","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","producer","sources","target"],"proargtypes":["2950","2950","25","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.read_admitted_native_scope_snapshot(uuid,text,uuid)","body":"39740a78f8ad92ad04e7e0231cdb99402e4755471866a9e4526600208fce7b61","runtime":true,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_native_scope_snapshot","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"public.application_memory_history_status(uuid,uuid,text)","body":"129079ae5b1096a988366358b0a45ca0d8da8102361a3df8e25d48d0e510c6ce","runtime":false,"language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_memory_history_status","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i","v"],"proargtypes":["2950","2950","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}]$expected$::jsonb) LOOP
  IF item->>'signature'='public.application_scope_lineage(uuid,text[],uuid[],text[])' THEN
   item:=jsonb_set(item,'{body}',to_jsonb(encode(sha256(convert_to(expected_lineage_body,'UTF8')),'hex')));
  END IF;
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(item->>'signature');
  IF NOT FOUND OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM item->>'body'
   OR actual.proowner IS DISTINCT FROM canonical_owner OR actual.pronamespace IS DISTINCT FROM 'public'::regnamespace
   OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=item->>'language')
   OR (CASE WHEN item->>'signature' IN('public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)',
     'public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)') THEN
    (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proargdefaults']) IS DISTINCT FROM ((item->'metadata')-'proargdefaults')
    OR pg_catalog.pg_get_expr(actual.proargdefaults,0) IS DISTINCT FROM CASE item->>'signature'
     WHEN 'public.application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)' THEN 'false' ELSE '0' END
    ELSE (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM item->'metadata' END) THEN
   RAISE EXCEPTION 'Native history transcript read prerequisite changed: %',item->>'signature';END IF;
  SELECT jsonb_agg(jsonb_build_array(a.grantee,a.grantor,a.privilege_type,a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable)
   INTO actual_acl FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
  SELECT jsonb_agg(jsonb_build_array(g,canonical_owner,'EXECUTE',false) ORDER BY g) INTO expected_acl
   FROM (SELECT canonical_owner AS g UNION SELECT oid FROM pg_roles WHERE rolname='app_user' AND (item->>'runtime')::boolean) grants;
  IF actual_acl IS DISTINCT FROM expected_acl THEN RAISE EXCEPTION 'Native history transcript read ACL prerequisite changed: %',item->>'signature';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.scope_derivation_sources'::regclass
  AND t.tgfoid='public.validate_application_field_dependencies()'::regprocedure
  AND (to_jsonb(t)-ARRAY['oid','tgrelid','tgfoid','tgconstraint'])=$trigger${"tgargs":"\\x","tgattr":[],"tgname":"application_field_derivation_dependencies","tgqual":null,"tgtype":21,"tgnargs":0,"tgenabled":"O","tgnewtable":null,"tgoldtable":null,"tgparentid":"0","tgdeferrable":true,"tgisinternal":false,"tgconstrindid":"0","tgconstrrelid":"0","tginitdeferred":true}$trigger$::jsonb) THEN
  RAISE EXCEPTION 'Native history transcript read deferred trigger prerequisite changed';END IF;
 SELECT * INTO guard FROM pg_proc WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 IF guard.proowner IS DISTINCT FROM canonical_owner OR application_memory_statement_helpers_current() IS NOT TRUE
  OR guard.prosrc NOT LIKE '%SELECT count(*)=122%'
  OR (SELECT count(*) FROM regexp_matches(guard.prosrc,'::oid,''[0-9a-f]{64}''::text','g'))<>122 THEN
  RAISE EXCEPTION 'Native history transcript read Memory guard prerequisite changed';END IF;
END $history_read_prerequisites$;
DO $history_read_body$
DECLARE port regprocedure:='public.application_session_eval_point_state(uuid,text,uuid,text[],jsonb)'::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;
 guard_before jsonb;trigger_before jsonb;dependencies_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 SELECT to_jsonb(t) INTO trigger_before FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies';
 SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) INTO dependencies_before FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.oid<>port;
 after:=$replacement$
DECLARE m session_messages;revision session_context_scope_revisions;source jsonb;parent jsonb;payload jsonb;values_json jsonb;selected jsonb;
 keys text[]:=application_session_field_keys(t);record_version text;source_kind text;source_id uuid;checked jsonb;actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 direct_kinds text[];direct_ids uuid[];direct_versions text[];direct_position integer;history_shape boolean:=false;
 dependency record;admitted jsonb;projection jsonb;label jsonb;seen jsonb:='[]';immutable_scope jsonb;
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

  -- Only the first canonical history-bearing message uses complete per-original admission.
  IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO direct_kinds,direct_ids,direct_versions,history_shape
 FROM session_messages message JOIN sessions session ON session.id=message.session_id AND session.workspace_id=message.workspace_id
 JOIN scope_derivations d ON d.workspace_id=message.workspace_id AND d.resource_kind='session_message'
  AND d.resource_id=message.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM message.user_id
  AND d.assistant_id IS NOT DISTINCT FROM message.assistant_id AND d.sensitivity=message.sensitivity
  AND d.compartments=message.compartments AND d.project_ids=message.project_ids
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE message.workspace_id=w AND message.id=i AND message.scope_version=1 AND message.scope_held IS FALSE;
 IF history_shape IS TRUE THEN
  IF EXISTS(SELECT 1 FROM application_scope_lineage(w,direct_kinds,direct_ids,direct_versions) n
   WHERE n.kind='session_context_revision' OR n.kind='session_message' AND n.id=i) THEN history_shape:=false;END IF;
  FOR direct_position IN 1..cardinality(direct_ids) LOOP
   IF NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
    AND EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[direct_kinds[direct_position]],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]) n
     JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN history_shape:=false;END IF;
  END LOOP;
 END IF;

  END IF;
  IF history_shape IS TRUE THEN
   BEGIN
    IF application_reader_envelope_visible(w,source) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     SELECT o.source_scope INTO immutable_scope FROM application_field_observations o
      WHERE o.workspace_id=w AND o.resource_id=direct_ids[direct_position] AND o.version=direct_versions[direct_position];
     IF immutable_scope IS NULL OR workflow_evidence_envelope_visible(w,immutable_scope) IS NOT TRUE
      OR sensitivity_rank(immutable_scope->>'sensitivity')>sensitivity_rank(source->>'sensitivity')
      OR NOT (source->'compartments')@>(immutable_scope->'compartments') OR NOT (source->'projectIds')@>(immutable_scope->'projectIds')
      OR immutable_scope->>'userId' IS NOT NULL AND immutable_scope->>'userId' IS DISTINCT FROM source->>'userId'
       AND (source->>'userId' IS NOT NULL OR immutable_scope->>'userId' IS DISTINCT FROM actor::text)
      THEN RETURN jsonb_build_object('memo',memo);END IF;
     IF EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
      projection:=read_native_attended_memory_evidence(w,ARRAY['application_field'],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]);
      IF projection IS NULL OR projection->>'purpose' IS DISTINCT FROM 'memory_history' OR projection->>'available' IS DISTINCT FROM 'true'
       OR projection->'root' IS DISTINCT FROM (immutable_scope||jsonb_build_object('resourceKind','application_field','resourceId',direct_ids[direct_position],'version',direct_versions[direct_position]))
       OR jsonb_typeof(projection->'scopes') IS DISTINCT FROM 'array' OR jsonb_array_length(projection->'scopes') NOT BETWEEN 1 AND 8192 THEN RETURN jsonb_build_object('memo',memo);END IF;
      FOR label IN SELECT value FROM jsonb_array_elements(projection->'scopes') LOOP
       IF workflow_evidence_envelope_visible(w,label) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
      END LOOP;
     ELSE
      -- Ordinary originals retain their stricter exact current-version check.
      checked:=application_session_eval_field(w,direct_ids[direct_position],direct_versions[direct_position],memo);
      memo:=coalesce(checked->'memo',memo);admitted:=checked->'value';
      IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM direct_versions[direct_position]
       THEN RETURN jsonb_build_object('memo',memo);END IF;
     END IF;
    END LOOP;
    FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     -- The helper admits the complete originals after metadata discovery.
     -- Transitive ordinary fields retain D1; their immutable tuple is not rewritten.
     IF dependency.source IS NULL OR dependency.source->>'resourceKind' IS DISTINCT FROM 'application_field'
      OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version
      OR NOT EXISTS(SELECT 1 FROM application_field_observations o WHERE o.workspace_id=w
       AND o.resource_id=(dependency.source->>'resourceId')::uuid AND o.version=dependency.node_version)
      OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE THEN RETURN jsonb_build_object('memo',memo);END IF;
     seen:=seen||jsonb_build_array(jsonb_build_array(dependency.source->>'resourceId',dependency.node_version));
     IF jsonb_array_length(seen)>4096 THEN RETURN jsonb_build_object('memo',memo);END IF;
    END LOOP;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     IF NOT seen @> jsonb_build_array(jsonb_build_array(direct_ids[direct_position]::text,direct_versions[direct_position])) THEN RETURN jsonb_build_object('memo',memo);END IF;
    END LOOP;
    FOR dependency IN SELECT * FROM read_external_source_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     admitted:=external_source_snapshot(w,(dependency.source->>'resourceId')::uuid);
     IF dependency.source IS NULL OR admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false'
      OR dependency.source->>'version' IS DISTINCT FROM dependency.node_version OR admitted->>'version' IS DISTINCT FROM dependency.node_version
      OR application_reader_envelope_visible(w,dependency.source) IS NOT TRUE OR application_reader_envelope_visible(w,admitted) IS NOT TRUE
      THEN RETURN jsonb_build_object('memo',memo);END IF;
    END LOOP;
    IF read_admitted_native_scope_snapshot(w,'session_message',i) IS DISTINCT FROM source THEN RETURN jsonb_build_object('memo',memo);END IF;
   EXCEPTION WHEN insufficient_privilege THEN RETURN jsonb_build_object('memo',memo);END;
  ELSE
  checked:=application_session_eval_scope(w,'session_message',i,m.scope_version::text,memo);memo:=checked->'memo';
  IF checked->>'value' IS DISTINCT FROM 'true' THEN RETURN jsonb_build_object('memo',memo);END IF;
  END IF;
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
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Native history transcript read body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM '5be4ee91b3ab9e447ace596249e789b2408568d3519cd60bb769820dc0bb7562'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies') IS DISTINCT FROM trigger_before
  OR (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.oid<>port) IS DISTINCT FROM dependencies_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native history transcript read body or security metadata changed';END IF;
END $history_read_body$;
DO $history_read_body$
DECLARE port regprocedure:='public.application_field_envelope_ancestry_allowed(uuid,jsonb)'::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;
 guard_before jsonb;trigger_before jsonb;dependencies_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 SELECT to_jsonb(t) INTO trigger_before FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies';
 SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) INTO dependencies_before FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.oid<>port;
 after:=$replacement$
DECLARE root record;selected jsonb;recomputed jsonb;result jsonb;memo jsonb:='{}';actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 direct_kinds text[];direct_ids uuid[];direct_versions text[];direct_position integer;history_shape boolean;
BEGIN
 IF envelope IS NULL THEN RETURN false;END IF;
 FOR selected IN WITH RECURSIVE envelopes(value) AS (
  SELECT envelope UNION ALL SELECT child.value FROM envelopes e CROSS JOIN LATERAL jsonb_array_elements(e.value->'children') child(value)
 ) SELECT value FROM envelopes LOOP
  IF selected->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb AND selected->>'typeKey'='memory' AND selected->>'selection'='history' THEN
   IF application_canonical_ancestry_from_admitted_root(w,'memory',(selected->>'id')::uuid,selected->>'selectedVersion',false,
    jsonb_build_object('kind','memory','id',selected->>'id','version',selected->>'selectedVersion','envelope',selected)) IS NOT TRUE THEN RETURN false;END IF;
  ELSIF selected->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb AND selected->>'typeKey'='session_message'
   AND selected->>'selection' IN('read','query','identity') AND selected->>'selectedVersion' IS NULL
   AND selected#>>'{state,sourceKind}'='session_message' THEN
   history_shape:=false;
   IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO direct_kinds,direct_ids,direct_versions,history_shape
 FROM session_messages message JOIN sessions session ON session.id=message.session_id AND session.workspace_id=message.workspace_id
 JOIN scope_derivations d ON d.workspace_id=message.workspace_id AND d.resource_kind='session_message'
  AND d.resource_id=message.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM message.user_id
  AND d.assistant_id IS NOT DISTINCT FROM message.assistant_id AND d.sensitivity=message.sensitivity
  AND d.compartments=message.compartments AND d.project_ids=message.project_ids
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE message.workspace_id=w AND message.id=(selected->>'id')::uuid AND message.scope_version=1 AND message.scope_held IS FALSE;
 IF history_shape IS TRUE THEN
  IF EXISTS(SELECT 1 FROM application_scope_lineage(w,direct_kinds,direct_ids,direct_versions) n
   WHERE n.kind='session_context_revision' OR n.kind='session_message' AND n.id=(selected->>'id')::uuid) THEN history_shape:=false;END IF;
  FOR direct_position IN 1..cardinality(direct_ids) LOOP
   IF NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
    AND EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[direct_kinds[direct_position]],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]) n
     JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN history_shape:=false;END IF;
  END LOOP;
 END IF;

   END IF;
   IF history_shape IS TRUE THEN
    result:=application_session_eval_envelope(w,'session_message',(selected->>'id')::uuid,
     selected->>'selection',ARRAY(SELECT jsonb_array_elements_text(selected->'fields')),memo);
    memo:=coalesce(result->'memo',memo);recomputed:=result->'value';
    IF recomputed IS NULL OR recomputed IS DISTINCT FROM selected THEN RETURN false;END IF;
   ELSE
    IF application_canonical_ancestry_allowed(w,selected#>>'{state,sourceKind}',(selected#>>'{state,sourceId}')::uuid,selected#>>'{state,sourceVersion}') IS NOT TRUE THEN RETURN false;END IF;
   END IF;
  ELSE
   IF scope_source_table(selected#>>'{state,sourceKind}') IS NOT NULL
    AND application_canonical_ancestry_allowed(w,selected#>>'{state,sourceKind}',(selected#>>'{state,sourceId}')::uuid,selected#>>'{state,sourceVersion}') IS NOT TRUE THEN RETURN false;END IF;
  END IF;
 END LOOP;
 RETURN true;
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Native history transcript read body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM '27143be754ab14cd8dd868df6da06a88cf784787b00e7093361f2a3702b2e62d'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies') IS DISTINCT FROM trigger_before
  OR (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.oid<>port) IS DISTINCT FROM dependencies_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native history transcript read body or security metadata changed';END IF;
END $history_read_body$;
DO $history_read_body$
DECLARE port regprocedure:='public.read_native_session_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure;actual pg_proc;metadata jsonb;definition text;before text;after text;
 guard_before jsonb;trigger_before jsonb;dependencies_before jsonb;
BEGIN
 SELECT * INTO actual FROM pg_proc WHERE oid=port;metadata:=to_jsonb(actual)-'prosrc';definition:=pg_get_functiondef(port);before:=actual.prosrc;
 SELECT to_jsonb(p) INTO guard_before FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 SELECT to_jsonb(t) INTO trigger_before FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies';
 SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) INTO dependencies_before FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.oid<>port;
 after:=$replacement$
DECLARE dependency record;item jsonb;rows_json jsonb:='[]';memo jsonb:='{}';result jsonb;admitted jsonb;native_only boolean:=true;belongs boolean;position integer;
 resource application_field_resources;observation application_field_observations;proof jsonb;history_snapshot jsonb;
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;child_kinds text[];child_ids uuid[];child_versions text[];
 eligible boolean;eligible_roots jsonb:='{}';root_shape jsonb;
 wrapper_position integer;current_envelope jsonb;child jsonb;wrapper_rows jsonb;wrapper_row jsonb;frozen application_query_domains;
 direct_kinds text[];direct_ids uuid[];direct_versions text[];direct_position integer;history_shape boolean;
 observed_sources jsonb;expected_sources jsonb;delegated jsonb;wrapper_source jsonb;
BEGIN

 -- A native immutable title delegates its complete stored direct fields only.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND (actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w AND m.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))) THEN
  FOR position IN 1..cardinality(ids) LOOP
   IF kinds[position]<>'session_context_revision' THEN CONTINUE;END IF;

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(s.source_kind='application_field' AND EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO child_kinds,child_ids,child_versions,eligible
 FROM session_context_scope_revisions r JOIN scope_derivations d ON d.workspace_id=r.workspace_id AND d.resource_kind='session_context_revision'
  AND d.resource_id=r.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM r.user_id AND d.assistant_id IS NOT DISTINCT FROM r.assistant_id
  AND d.sensitivity=r.sensitivity AND d.compartments=r.compartments AND d.project_ids=r.project_ids
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE r.workspace_id=w AND r.id=ids[position] AND r.parent_kind='session_title' AND r.parent_id=r.session_id AND r.scope_version=1;
 IF eligible IS TRUE AND EXISTS(SELECT 1 FROM application_scope_lineage(w,child_kinds,child_ids,child_versions) n WHERE n.kind='session_context_revision') THEN eligible:=false;END IF;

   IF eligible IS TRUE THEN
    eligible_roots:=eligible_roots||jsonb_build_object(position::text,jsonb_build_object('kinds',child_kinds,'ids',child_ids,'versions',child_versions));
   END IF;
  END LOOP;
  IF eligible_roots<>'{}'::jsonb THEN
   FOR position IN 1..cardinality(ids) LOOP
    root_shape:=eligible_roots->position::text;
    IF root_shape IS NULL THEN
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]);
    ELSE
     IF versions[position] IS DISTINCT FROM '1' OR session_context_revision_allowed(w,ids[position]) IS NOT TRUE THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     SELECT array_agg(value) INTO child_kinds FROM jsonb_array_elements_text(root_shape->'kinds');
     SELECT array_agg(value::uuid) INTO child_ids FROM jsonb_array_elements_text(root_shape->'ids');
     SELECT array_agg(value) INTO child_versions FROM jsonb_array_elements_text(root_shape->'versions');
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,child_kinds,child_ids,child_versions);
    END IF;
   END LOOP;
   RETURN;
  END IF;
 END IF;

 -- Each original root keeps its own purpose before union/deduplication.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND EXISTS(SELECT 1 FROM unnest(kinds,ids) r(kind,id) JOIN application_field_resources f ON f.workspace_id=w AND f.id=r.id
    WHERE r.kind='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN
  FOR position IN 1..cardinality(ids) LOOP
   SELECT * INTO resource FROM application_field_resources WHERE workspace_id=w AND id=ids[position]
    AND kinds[position]='application_field' AND origin='{"kind":"native","moduleKey":"native"}' AND type_key='memory' AND selection='history';
   IF NOT FOUND THEN
    RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]);
    CONTINUE;
   END IF;
   admitted:=read_admitted_application_field_snapshot(w,ids[position],versions[position]);
   IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM versions[position] THEN
    RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   history_snapshot:=admitted;
   proof:=application_memory_history_status(w,resource.resource_id,resource.selected_version);
   IF proof IS NULL THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   FOR dependency IN SELECT * FROM read_application_field_dependencies(w,ARRAY[kinds[position]],ARRAY[ids[position]],ARRAY[versions[position]]) LOOP
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(proof->'ownFields') f
      WHERE f->>'id'=dependency.source->>'resourceId' AND f->>'version'=dependency.node_version)
     AND NOT EXISTS(SELECT 1 FROM unnest(kinds,ids,versions) r(kind,id,version) WHERE r.kind='application_field'
      AND r.id=(dependency.source->>'resourceId')::uuid AND r.version=dependency.node_version) THEN CONTINUE;END IF;
    IF dependency.source->>'resourceKind'='application_field' AND dependency.source->>'resourceId'=ids[position]::text
     AND dependency.node_version=versions[position] THEN
     -- This exact root was canonically admitted after the caller's metadata discovery.
     IF dependency.source IS DISTINCT FROM (history_snapshot-ARRAY['held','validTo','retractedAt'])
      OR scope_review_state_held('application_field',ids[position]) IS TRUE THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    ELSE
     result:=application_session_eval_field(w,(dependency.source->>'resourceId')::uuid,dependency.node_version,memo);
     memo:=coalesce(result->'memo',memo);admitted:=result->'value';
     IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    END IF;
    node_version:=dependency.node_version;source:=dependency.source;RETURN NEXT;
   END LOOP;
  END LOOP;
  RETURN;
 END IF;
 -- Typed native session wrappers preserve their own immutable binding and all original roots.
 IF kinds IS NOT NULL AND ids IS NOT NULL AND versions IS NOT NULL AND cardinality(ids) BETWEEN 1 AND 100
  AND cardinality(kinds)=cardinality(ids) AND cardinality(versions)=cardinality(ids)
  AND array_position(kinds,NULL) IS NULL AND array_position(ids,NULL) IS NULL AND array_position(versions,NULL) IS NULL
  AND actor IS NOT NULL AND EXISTS(SELECT 1 FROM workspace_members member WHERE member.workspace_id=w AND member.user_id=actor)
  AND nullif(current_setting('app.application_id',true),'') IS NULL
  AND nullif(current_setting('app.public_share_root',true),'') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass WHERE login.rolname=session_user
    AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE'))) THEN
  wrapper_rows:='{}';
  FOR wrapper_position IN 1..cardinality(ids) LOOP
   SELECT * INTO resource FROM application_field_resources f WHERE f.workspace_id=w AND f.id=ids[wrapper_position]
    AND kinds[wrapper_position]='application_field' AND f.origin='{"kind":"native","moduleKey":"native"}'
    AND f.type_key='session_message' AND f.selected_version IS NULL AND f.selection IN('read','query','identity','query_domain');
   IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[kinds[wrapper_position]],ARRAY[ids[wrapper_position]],ARRAY[versions[wrapper_position]]) n
    JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
     AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN CONTINUE;END IF;
   history_shape:=false;
   IF resource.selection<>'query_domain' THEN

 SELECT array_agg(s.source_kind ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_id ORDER BY s.source_kind,s.source_id,s.source_version),
  array_agg(s.source_version ORDER BY s.source_kind,s.source_id,s.source_version),
  count(*) BETWEEN 1 AND 100 AND bool_and(s.source_kind='application_field')
   AND bool_or(EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=s.source_id
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history'))
 INTO direct_kinds,direct_ids,direct_versions,history_shape
 FROM session_messages message JOIN sessions session ON session.id=message.session_id AND session.workspace_id=message.workspace_id
 JOIN scope_derivations d ON d.workspace_id=message.workspace_id AND d.resource_kind='session_message'
  AND d.resource_id=message.id AND d.resource_version='1' AND d.user_id IS NOT DISTINCT FROM message.user_id
  AND d.assistant_id IS NOT DISTINCT FROM message.assistant_id AND d.sensitivity=message.sensitivity
  AND d.compartments=message.compartments AND d.project_ids=message.project_ids
 JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
 WHERE message.workspace_id=w AND message.id=resource.resource_id AND message.scope_version=1 AND message.scope_held IS FALSE;
 IF history_shape IS TRUE THEN
  IF EXISTS(SELECT 1 FROM application_scope_lineage(w,direct_kinds,direct_ids,direct_versions) n
   WHERE n.kind='session_context_revision' OR n.kind='session_message' AND n.id=resource.resource_id) THEN history_shape:=false;END IF;
  FOR direct_position IN 1..cardinality(direct_ids) LOOP
   IF NOT EXISTS(SELECT 1 FROM application_field_resources f WHERE f.workspace_id=w AND f.id=direct_ids[direct_position]
    AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history')
    AND EXISTS(SELECT 1 FROM application_scope_lineage(w,ARRAY[direct_kinds[direct_position]],ARRAY[direct_ids[direct_position]],ARRAY[direct_versions[direct_position]]) n
     JOIN application_field_resources f ON f.workspace_id=w AND f.id=n.id WHERE n.kind='application_field'
      AND f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key='memory' AND f.selection='history') THEN history_shape:=false;END IF;
  END LOOP;
 END IF;

    IF history_shape IS NOT TRUE THEN CONTINUE;END IF;
   END IF;
   SELECT * INTO observation FROM application_field_observations o WHERE o.workspace_id=w AND o.resource_id=resource.id AND o.version=versions[wrapper_position];
   IF NOT FOUND THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   result:=application_session_eval_envelope(w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo);
   memo:=coalesce(result->'memo',memo);current_envelope:=result->'value';
   IF current_envelope IS NULL OR current_envelope->>'resourceId' IS DISTINCT FROM resource.id::text
    OR current_envelope->>'identity' IS DISTINCT FROM resource.identity
    OR current_envelope#>>'{source,version}' IS DISTINCT FROM versions[wrapper_position]
    OR current_envelope#>>'{state,recordVersion}' IS DISTINCT FROM observation.record_version
    OR current_envelope#>>'{state,policyVersion}' IS DISTINCT FROM observation.policy_version
    OR current_envelope#>>'{state,sourceKind}' IS DISTINCT FROM observation.source_kind
    OR current_envelope#>>'{state,sourceId}' IS DISTINCT FROM observation.source_id::text
    OR current_envelope#>>'{state,sourceVersion}' IS DISTINCT FROM observation.source_version
    OR ((current_envelope->'source')-ARRAY['resourceKind','resourceId','version']) IS DISTINCT FROM observation.source_scope
    THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   SELECT coalesce(jsonb_agg(jsonb_build_array(s.source_kind,s.source_id::text,s.source_version) ORDER BY s.source_kind,s.source_id::text,s.source_version),'[]') INTO observed_sources
    FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=resource.id AND s.version=versions[wrapper_position];
   SELECT coalesce(jsonb_agg(jsonb_build_array(s->>'resourceKind',s->>'resourceId',s->>'version') ORDER BY s->>'resourceKind',s->>'resourceId',s->>'version'),'[]') INTO expected_sources
    FROM jsonb_array_elements(current_envelope->'sources') s;
   IF observed_sources IS DISTINCT FROM expected_sources THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   result:=application_session_eval_field(w,resource.id,versions[wrapper_position],memo);
   memo:=coalesce(result->'memo',memo);admitted:=result->'value';
   IF admitted IS NULL OR admitted->>'held' IS DISTINCT FROM 'false' OR admitted->>'version' IS DISTINCT FROM versions[wrapper_position]
    OR (admitted-ARRAY['held','validTo','retractedAt']) IS DISTINCT FROM current_envelope->'source' THEN
    RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
   wrapper_source:=current_envelope->'source';delegated:='[]';
   IF resource.selection='query_domain' THEN
    SELECT * INTO frozen FROM application_query_domains q WHERE q.workspace_id=w AND q.id=resource.resource_id
     AND q.origin=resource.origin AND q.type_key=resource.type_key AND q.schema_version='1';
    IF NOT FOUND OR frozen.identity IS DISTINCT FROM observation.source_version OR observation.source_kind<>'application_query_domain'
     OR observation.source_id IS DISTINCT FROM frozen.id OR jsonb_array_length(current_envelope->'children')>4096 THEN
     RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    FOR child IN SELECT value FROM jsonb_array_elements(current_envelope->'children') LOOP
     IF child->'origin' IS DISTINCT FROM resource.origin OR child->>'typeKey'<>'session_message'
      OR child->>'selection'<>'query' OR child->>'selectedVersion' IS NOT NULL
      OR child#>>'{state,sourceKind}'<>'session_message'
      OR NOT EXISTS(SELECT 1 FROM session_messages message WHERE message.workspace_id=w AND message.id=(child->>'id')::uuid
       AND message.id=(child#>>'{state,sourceId}')::uuid AND message.session_id=(frozen.domain->>'sessionId')::uuid
       AND message.sequence_num<=(frozen.domain->>'throughSequence')::integer)
      OR NOT EXISTS(SELECT 1 FROM application_field_observation_sources s WHERE s.workspace_id=w AND s.resource_id=resource.id AND s.version=versions[wrapper_position]
       AND s.source_kind='application_field' AND s.source_id=(child->>'resourceId')::uuid AND s.source_version=child#>>'{source,version}') THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,ARRAY['application_field'],ARRAY[(child->>'resourceId')::uuid],ARRAY[child#>>'{source,version}']) LOOP
      delegated:=delegated||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
      IF jsonb_array_length(delegated)>4096 THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
     END LOOP;
    END LOOP;
   ELSE
    IF observation.source_kind<>'session_message' OR observation.source_id IS DISTINCT FROM resource.resource_id
     OR observation.source_version<>'1' OR observation.record_version NOT LIKE '1:%' THEN
     RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    FOR dependency IN SELECT * FROM read_native_session_field_dependencies(w,direct_kinds,direct_ids,direct_versions) LOOP
     delegated:=delegated||jsonb_build_array(jsonb_build_object('version',dependency.node_version,'source',dependency.source));
     IF jsonb_array_length(delegated)>4096 THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    END LOOP;
    FOR direct_position IN 1..cardinality(direct_ids) LOOP
     IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(delegated) s WHERE s#>>'{source,resourceKind}'='application_field'
      AND s#>>'{source,resourceId}'=direct_ids[direct_position]::text AND s->>'version'=direct_versions[direct_position]) THEN
      RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
    END LOOP;
   END IF;
   wrapper_rows:=wrapper_rows||jsonb_build_object(wrapper_position::text,jsonb_build_array(jsonb_build_object('version',versions[wrapper_position],'source',wrapper_source))||delegated);
  END LOOP;
  IF wrapper_rows<>'{}'::jsonb THEN
   FOR wrapper_position IN 1..cardinality(ids) LOOP
    IF wrapper_rows ? wrapper_position::text THEN
     RETURN QUERY SELECT value->>'version',value->'source' FROM jsonb_array_elements(wrapper_rows->wrapper_position::text);
    ELSE
     RETURN QUERY SELECT * FROM read_native_session_field_dependencies(w,ARRAY[kinds[wrapper_position]],ARRAY[ids[wrapper_position]],ARRAY[versions[wrapper_position]]);
    END IF;
   END LOOP;
   RETURN;
  END IF;
 END IF;
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
END $replacement$;
 IF array_length(string_to_array(definition,before),1)<>2 THEN RAISE EXCEPTION 'Native history transcript read body splice prerequisite changed';END IF;
 EXECUTE replace(definition,before,after);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid=port) IS DISTINCT FROM metadata
  OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=port) IS DISTINCT FROM 'fc663c87b15ec0a570ca3f75d97e8f1add1ea158fa68bfb13930c361235afbbe'
  OR (SELECT to_jsonb(p) FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM guard_before
  OR (SELECT to_jsonb(t) FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies') IS DISTINCT FROM trigger_before
  OR (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.oid<>port) IS DISTINCT FROM dependencies_before
  OR application_memory_statement_helpers_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Native history transcript read body or security metadata changed';END IF;
END $history_read_body$;
COMMIT;
