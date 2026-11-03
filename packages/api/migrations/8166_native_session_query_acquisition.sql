BEGIN;
-- [COMP:api/application-persistence] Preserve both original projections while
-- sharing their acquisition proof and the final caller-validation proof.
DO $install$
DECLARE actual pg_proc;pins text;trusted text;expected jsonb;routine record;recipient record;guard_pin text;old_guard_pin text;pin_count integer;lineage_body text;lineage_values text;
BEGIN
-- The executable lineage template is fixed. Only its historical R2 data pins
-- vary by installation; they may legitimately be stale and select the original
-- recursive fallback. Never execute or accept executable installed text.
 SELECT prosrc INTO lineage_body FROM pg_proc WHERE oid='application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure;
 lineage_values:=substring(lineage_body FROM 'FROM [(]VALUES ([^;]+)[)] pin[(]function_oid,fingerprint[)]');
 IF lineage_values IS NULL OR lineage_values !~ $grammar$^[(][0-9]+::oid,'[0-9a-f]{64}'::text[)](,[(][0-9]+::oid,'[0-9a-f]{64}'::text[)])*$grammar$
 OR encode(sha256(convert_to(replace(lineage_body,'FROM (VALUES '||lineage_values||') pin(function_oid,fingerprint)',
  'FROM (VALUES __R2_PINS__) pin(function_oid,fingerprint)'),'UTF8')),'hex') IS DISTINCT FROM '822b50eabf585cebfa1f558d1996d24b79c39f5e95f649a9a1a707b95f06a5d1'
 OR (SELECT count(*)<>11 OR count(DISTINCT part[1])<>11 FROM regexp_matches(lineage_values,$entry$[(]([0-9]+)::oid,'([0-9a-f]{64})'::text[)]$entry$,'g') part)
 OR EXISTS(SELECT 1 FROM regexp_matches(lineage_values,$entry$[(]([0-9]+)::oid,'([0-9a-f]{64})'::text[)]$entry$,'g') part
  WHERE part[1]::oid<>ALL(ARRAY['public.application_scope_source_edges(uuid,text,uuid,text)'::regprocedure::oid,'public.application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)'::regprocedure::oid,'public.knowledge_version_source_edges(uuid,text,uuid,text)'::regprocedure::oid,'public.scope_source_ancestors(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_ancestors_before_workflow_run(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_ancestors_before_browser_session(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_ancestors_before_browser_profile(uuid,text,uuid)'::regprocedure::oid,'public.scope_source_table(text)'::regprocedure::oid,'public.scope_source_table_before_knowledge_versions(text)'::regprocedure::oid,'public.scope_source_table_before_persistent_context(text)'::regprocedure::oid,'public.scope_source_table_before_media(text)'::regprocedure::oid])) THEN
 RAISE EXCEPTION 'Native query acquisition lineage template changed';END IF;
-- Caller declares actual pg_proc, pins text, trusted text. No invocation occurs before closed-template verification.
 -- Reconstruct the existing SQL guard before invoking it. Its catalog
 -- fingerprints are data; the executable template is fixed by migration8152.
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'application_empty_query_worklist_reset(jsonb)'::regprocedure,
  'application_empty_query_worklist_current(uuid,jsonb)'::regprocedure,
  'read_native_empty_query_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_field_envelope_ancestry_allowed(uuid,jsonb)'::regprocedure);
 trusted:='SELECT application_memory_statement_helpers_current() AND (SELECT count(*)=4 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
    FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid)';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_empty_query_helpers_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql') OR actual.pronamespace<>'public'::regnamespace
  OR NOT actual.prosecdef OR actual.provolatile<>'v' OR actual.proparallel<>'u' OR actual.procost<>100 OR actual.prorows<>0
  OR actual.prokind<>'f' OR actual.prorettype<>'boolean'::regtype OR actual.proretset OR actual.proisstrict OR actual.proleakproof
  OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR actual.prosupport<>0
  OR actual.probin IS NOT NULL OR actual.prosqlbody IS NOT NULL OR actual.proargdefaults IS NOT NULL OR actual.pronargdefaults<>0
  OR actual.proargnames IS NOT NULL OR actual.proargmodes IS NOT NULL OR actual.proallargtypes IS NOT NULL OR actual.protrftypes IS NOT NULL
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Native dependency existing guard changed';END IF;

 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN(
  'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure,
  'read_native_file_session_field_snapshots(uuid,uuid[],text[])'::regprocedure,
  'capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure,
  'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,
  'application_empty_query_helpers_current()'::regprocedure,
  'application_memory_statement_helpers_current()'::regprocedure);
 trusted:='BEGIN
   IF (SELECT count(*)=7 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
    FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
   RETURN application_empty_query_helpers_current();
   END';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_native_file_capture_helpers_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
  OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql') OR actual.pronamespace<>'public'::regnamespace
  OR NOT actual.prosecdef OR actual.provolatile<>'v' OR actual.proparallel<>'u' OR actual.procost<>100 OR actual.prorows<>0
  OR actual.prokind<>'f' OR actual.prorettype<>'boolean'::regtype OR actual.proretset OR actual.proisstrict OR actual.proleakproof
  OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR actual.prosupport<>0
  OR actual.probin IS NOT NULL OR actual.prosqlbody IS NOT NULL OR actual.proargdefaults IS NOT NULL OR actual.pronargdefaults<>0
  OR actual.proargnames IS NOT NULL OR actual.proargmodes IS NOT NULL OR actual.proallargtypes IS NOT NULL OR actual.protrftypes IS NOT NULL
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Native dependency file guard changed';END IF;
-- Declare pins text, trusted text, actual pg_proc in the caller's installer block.
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid)
 INTO pins FROM pg_proc p WHERE oid IN('application_native_covered_queue_current()'::regprocedure,'application_native_root_cover(uuid,jsonb)'::regprocedure,'read_native_covered_memory_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,'read_native_covered_session_frame(uuid,text[],uuid[],text[])'::regprocedure,'validate_native_covered_field_dependency_work(uuid,uuid,bigint)'::regprocedure,'read_native_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,'application_native_file_frame_current(uuid,text[],uuid[],text[],jsonb)'::regprocedure,'application_native_file_capture_helpers_current()'::regprocedure,'application_native_worklist_helpers_current()'::regprocedure,'native_worklist_edges(uuid,jsonb)'::regprocedure,'native_worklist_context(uuid,jsonb)'::regprocedure,'application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure,'read_application_field_dependencies(uuid,text[],uuid[],text[])'::regprocedure,'read_external_source_dependencies(uuid,text[],uuid[],text[])'::regprocedure,'application_empty_query_helpers_current()'::regprocedure,'application_memory_statement_helpers_current()'::regprocedure);
 trusted:='BEGIN
 IF (SELECT count(*)=17 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
  FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN false;END IF;
 RETURN application_native_worklist_helpers_current();
 END';
 SELECT * INTO actual FROM pg_proc WHERE oid='application_native_covered_evidence_helpers_current()'::regprocedure;
 IF actual.prosrc IS DISTINCT FROM trusted OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace','proname'] IS DISTINCT FROM $metadata${"probin":null,"procost":100,"prokind":"f","prorows":0,"pronargs":0,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":null,"proargtypes":[],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$metadata$::jsonb
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.grantee<>actual.proowner OR a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
 THEN RAISE EXCEPTION 'Covered evidence prerequisite guard changed';END IF;
 IF application_native_covered_evidence_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Covered evidence prerequisite dependencies changed';END IF;

 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'Joint capture file prerequisites changed';END IF;

 FOR expected IN SELECT value FROM jsonb_array_elements($canonical$[{"signature":"application_field_digest(jsonb)","body":"e02b7a718d6279a47a7b9c1d5ad697702ed05cdc8467882329f89b80c6b9966b","language":"sql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_field_digest","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"25","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["value"],"proargtypes":["3802"],"proisstrict":true,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"external_source_snapshot(uuid,uuid)","body":"c612c08d4f8bebdea24bb0af5068f2c7fa038ee04746e432ebb880d1de7c9353","language":"plpgsql","appAllowed":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"external_source_snapshot","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_session_field_keys(text)","body":"f463c3c77e9f3ae1d8df58b7c3a2dd4e6d771386b3b9532d79b2ab72b9a5f10a","language":"sql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_field_keys","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"1009","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["t"],"proargtypes":["25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_field_resource_uuid(text)","body":"de0eb792a09c132c8133a2a026c204c3deb59ea430fe4c74a043d2102f9337ce","language":"sql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_field_resource_uuid","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"2950","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["identity"],"proargtypes":["25"],"proisstrict":true,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_session_query_parent(uuid,uuid)","body":"85393998bba4fe1af647bbfaade0ae59e364081e4bbea4de1e57ccaf86cbd2e1","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_query_parent","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_session_query_bounds(uuid,jsonb)","body":"cdcf2c6726be3b8a82e569fe8d2012b1a1d15030048d43a391ee72502328ca8b","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_query_bounds","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","parent"],"proargtypes":["2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_current_field_snapshot(uuid,uuid)","body":"06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_current_field_snapshot","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","i"],"proargtypes":["2950","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"read_entity_derivation_source(uuid,text,uuid)","body":"e707edb588228a6e18790026bd886c4946b5c2adcff0b7428ebfb0fb43e052f3","language":"plpgsql","appAllowed":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_entity_derivation_source","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"read_admitted_native_scope_snapshot(uuid,text,uuid)","body":"90863ef2037d3e5326381afeba23052971da0263006cb83116c68ddf3ac48b78","language":"plpgsql","appAllowed":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_admitted_native_scope_snapshot","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i"],"proargtypes":["2950","25","2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_scope_lineage(uuid,text[],uuid[],text[])","body":null,"language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_scope_lineage","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t","t","t"],"proargnames":["w","kinds","ids","versions","kind","id","version"],"proargtypes":["2950","1009","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","1009","2951","1009","25","2950","25"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"read_native_session_field_snapshots(uuid,uuid[],text[])","body":"a3ead9fc09f142f7450eabd41b573a07d66ce39adf43aeca1d87786c091634ee","language":"plpgsql","appAllowed":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_session_field_snapshots","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"2249","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t","t"],"proargnames":["w","ids","versions","ord","snapshot"],"proargtypes":["2950","2951","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2951","1009","23","3802"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"read_native_application_session_topics(uuid,uuid,integer)","body":"770b488d55b5513206d597f8945730a5b2b6b1f07e4b86f8711bfd141133b1b3","language":"sql","appAllowed":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_application_session_topics","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t"],"proargnames":["w","s","through","value"],"proargtypes":["2950","2950","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2950","23","3802"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_materialize_field_envelope(uuid,jsonb,integer)","body":"6b4340ea9aa09be4512d8259bd1055c40d6986f8cb5e6319c3d1341cf5a989d5","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_materialize_field_envelope","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","envelope","depth"],"proargtypes":["2950","3802","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":"({CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]})","pronargdefaults":1}},{"signature":"read_native_application_session_history(uuid,uuid,integer)","body":"e8536b9e6fba7d699277cc2c24e9e61fe2428779f6aa5c40d3b8d04ff97e192d","language":"sql","appAllowed":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_application_session_history","prorows":1000,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","t"],"proargnames":["w","s","through","value"],"proargtypes":["2950","2950","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2950","23","3802"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"capture_native_session_projection_batch(uuid,uuid,integer,text)","body":"3796513cea433b1d41e5d786d7a59e2c57ae3b04f8a87a4dcd169efa33b1df39","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"capture_native_session_projection_batch","prorows":0,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","through","t"],"proargtypes":["2950","2950","23","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"read_native_application_session_projection(uuid,uuid,integer,text)","body":"260578e84bb3475048984862059580bed6161dc5bf7642378e508e45dc2ecb93","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_application_session_projection","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t"],"proargnames":["w","s","through","t","value"],"proargtypes":["2950","2950","23","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2950","23","25","3802"],"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)","body":"938e4d4ebc47e7f4b0fb5aa6cfbc69ea199150f7e1eac784aaa0aa045cb47af0","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_envelope","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","t","i","selection","fields","memo"],"proargtypes":["2950","25","2950","25","1009","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)","body":"70c4a1c928f38e61aebedb549340a42516ec3ba01f62c432cf526b3b4a735d72","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_query_scan","prorows":0,"pronargs":7,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","t","through","fields","bounds","visibility"],"proargtypes":["2950","2950","25","23","1009","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)","body":"8f01ca980231ecab5963092178ec34d322986d6cd3451b2a037bc721721bae18","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_scan","prorows":0,"pronargs":8,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","t","through","fields","bounds","visibility","memo"],"proargtypes":["2950","2950","25","23","1009","3802","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])","body":"e98b2198a8793a57c982fa992f92cdd5dec0232b93de28d5b9b49cb4b061e1f5","language":"plpgsql","appAllowed":true,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"observe_application_field_projection","prorows":0,"pronargs":8,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","p_origin","p_type","p_id","p_record_version","p_selection","p_selected_version","p_fields"],"proargtypes":["2950","3802","25","2950","25","25","25","1009"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)","body":"50973b8ff2d29e46ac9fdc0a424b8100d50ce28d3de6964eee52bde01cda43d7","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_compute_field_envelope","prorows":0,"pronargs":8,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","p_origin","p_type","p_id","p_selection","p_selected_version","p_fields","depth"],"proargtypes":["2950","3802","25","2950","25","25","1009","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":"({CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]})","pronargdefaults":1}}]$canonical$::jsonb) LOOP
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(expected->>'signature');
 -- Lineage executable shape and closed historical pin roster were checked
 -- independently above; its complete current catalog row remains guarded too.
 IF actual.oid IS NULL OR expected->>'body' IS NOT NULL AND encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
 OR actual.proowner<>(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass)
 OR actual.pronamespace<>'public'::regnamespace OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname=expected->>'language')
 OR to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace'] IS DISTINCT FROM expected->'metadata'
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a WHERE a.grantor<>actual.proowner OR a.privilege_type<>'EXECUTE' OR a.is_grantable
  OR a.grantee<>actual.proowner AND NOT(coalesce((expected->>'appAllowed')::boolean,false) AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user' AND oid=a.grantee)))
 OR (expected->>'appAllowed')::boolean AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') AND NOT EXISTS(
  SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname='app_user' AND a.privilege_type='EXECUTE')
 THEN RAISE EXCEPTION 'Native query acquisition prerequisite changed: %',expected->>'signature';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('capture_native_session_query_stage','application_native_session_query_acquisition_current','read_native_session_query_evidence')) THEN RAISE EXCEPTION 'Native query acquisition helper already exists';END IF;
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO old_guard_pin FROM pg_proc p WHERE oid='application_native_file_capture_helpers_current()'::regprocedure;
 EXECUTE replace($stage$CREATE OR REPLACE FUNCTION public.capture_native_session_query_stage(w uuid, s uuid, through integer, t text, initial_frame jsonb, reader_context jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_generic_plan'
AS $function$
DECLARE parent jsonb;bounds jsonb;visibility jsonb;scanned jsonb;fields text[];domain jsonb;identity_value text;domain_id uuid;
 frozen application_query_domains;envelope jsonb;child jsonb;source jsonb;external jsonb;result jsonb;memo jsonb:='{}';
 captures jsonb;rows_json jsonb:='[]';
 actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 frame_kinds text[];frame_ids uuid[];frame_versions text[];frame_nodes jsonb;frame_result jsonb;
 frame_ancestry boolean:=false;frame_point jsonb;frame_root jsonb;frame_tuple jsonb;frame_actual jsonb;
 frame_kind text;frame_id uuid;frame_version text;file_frame boolean:=false;file_final_proof boolean:=false;file_reader_context jsonb;file_final_lineage jsonb;
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure) IS DISTINCT FROM 'e98b2198a8793a57c982fa992f92cdd5dec0232b93de28d5b9b49cb4b061e1f5'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_current_field_snapshot(uuid,uuid)'::regprocedure) IS DISTINCT FROM '06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_materialize_field_envelope(uuid,jsonb,integer)'::regprocedure) IS DISTINCT FROM '6b4340ea9aa09be4512d8259bd1055c40d6986f8cb5e6319c3d1341cf5a989d5'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)'::regprocedure) IS DISTINCT FROM '70c4a1c928f38e61aebedb549340a42516ec3ba01f62c432cf526b3b4a735d72'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure) IS DISTINCT FROM 'a3ead9fc09f142f7450eabd41b573a07d66ce39adf43aeca1d87786c091634ee'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure) IS DISTINCT FROM '50973b8ff2d29e46ac9fdc0a424b8100d50ce28d3de6964eee52bde01cda43d7' THEN RETURN NULL;END IF;
 IF actor IS NULL OR t NOT IN('session_message','session_message_annotation') OR through IS NULL OR through<0
  OR EXISTS(SELECT 1 FROM pg_roles r JOIN pg_class c ON c.oid='public.session_messages'::regclass WHERE r.rolname=session_user
   AND (r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE'))) THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 parent:=application_session_query_parent(w,s);bounds:=application_session_query_bounds(w,parent);
 IF parent IS NULL OR bounds IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 fields:=ARRAY(SELECT field FROM unnest(application_session_field_keys(t)) field ORDER BY field);
 visibility:=jsonb_build_object('userId',CASE WHEN current_setting('app.agent_shared_audience',true)='true' THEN NULL ELSE actor END,
  'assistants',coalesce(nullif(current_setting('app.agent_visibility_assistants',true),'')::jsonb,'null'::jsonb));
 frame_result:=initial_frame;memo:=frame_result->'memo';file_frame:=true;file_reader_context:=reader_context;
 frame_kinds:=ARRAY(SELECT r->>'kind' FROM jsonb_array_elements(initial_frame->'captureRoots') r);
 frame_ids:=ARRAY(SELECT (r->>'id')::uuid FROM jsonb_array_elements(initial_frame->'captureRoots') r);
 frame_versions:=ARRAY(SELECT r->>'version' FROM jsonb_array_elements(initial_frame->'captureRoots') r);
 IF frame_result->>'admitted' IS DISTINCT FROM 'true' OR frame_result#>>'{memo,memoryStatement,workspaceId}' IS DISTINCT FROM w::text THEN RETURN NULL;END IF;
 result:=application_session_eval_scan(w,s,t,through,fields,bounds,visibility,memo);memo:=coalesce(result->'memo',memo);scanned:=result->'value';
 IF scanned IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 domain:=jsonb_build_object('kind','session_query_domain_v1','sessionId',s,'throughSequence',through,'fields',fields,'bounds',bounds,'visibility',visibility,
  'parentFingerprint',parent->'fingerprint','candidates',scanned->'candidates','points',scanned->'points');
 identity_value:=application_field_digest(jsonb_build_object('kind','session_query_domain_v1','workspaceId',w,'type',t,'domain',domain));
 domain_id:=application_field_resource_uuid(identity_value);
 INSERT INTO application_query_domains(id,workspace_id,origin,type_key,schema_version,domain,identity)
  VALUES(domain_id,w,'{"kind":"native","moduleKey":"native"}',t,'1',domain,identity_value) ON CONFLICT DO NOTHING;
 SELECT * INTO frozen FROM application_query_domains WHERE workspace_id=w AND id=domain_id;
 IF NOT FOUND OR (frozen.type_key,frozen.schema_version,frozen.domain,frozen.identity) IS DISTINCT FROM (t,'1',domain,identity_value) THEN RAISE EXCEPTION 'scope_evidence_immutable' USING ERRCODE='22023';END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_file_capture_helpers_current()'::regprocedure) IS DISTINCT FROM '__OLDGUARD__' THEN RETURN NULL;END IF;
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 result:=application_session_eval_envelope(w,t,domain_id,'query_domain',fields,memo);envelope:=result->'value';
 IF envelope IS NULL OR envelope#>>'{state,recordVersion}' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(envelope->'sources') WHERE value->>'resourceKind'='external_source' LOOP
  external:=external_source_snapshot(w,(source->>'resourceId')::uuid);
  IF external IS NULL OR external->>'held' IS DISTINCT FROM 'false' OR external->>'version' IS DISTINCT FROM source->>'version'
   OR NOT EXISTS(SELECT 1 FROM external_source_observations observation WHERE observation.workspace_id=w AND observation.id=(source->>'resourceId')::uuid
    AND (observation.observation#>>'{retention,mode}'='governed' OR
  observation.observation#>>'{retention,mode}'='released_snapshot'
  AND length(observation.observation#>>'{retention,releaseId}')>0
  AND jsonb_typeof(observation.observation#>'{retention,expiresAt}')='number'
  AND (observation.observation#>>'{retention,expiresAt}')::numeric>extract(epoch FROM clock_timestamp())*1000)) THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 -- Only this internally computed envelope can bind to the complete frame.
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
  IF file_frame THEN RETURN NULL;END IF;
  IF application_field_envelope_ancestry_allowed(w,envelope) IS NOT TRUE THEN RAISE EXCEPTION 'scope_operation_denied' USING ERRCODE='42501';END IF;
 END IF;
 -- The initial proof already qualified selected fields and buffered payload.
 -- Bounded captures receive one independent final proof after materialization.
 -- Larger captures retain the original pre-materialization and snapshot path.
 file_final_proof:=file_frame AND jsonb_array_length(coalesce(envelope->'children','[]'))<100;
 IF NOT file_final_proof THEN RETURN NULL;END IF;
 IF file_frame THEN
  IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_file_capture_helpers_current()'::regprocedure) IS DISTINCT FROM '__OLDGUARD__' THEN RETURN NULL;END IF;
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
  IF file_final_proof THEN
 IF jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name)) IS DISTINCT FROM file_reader_context THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
   -- Preserve the original pre-write discard when the covered graph changes.
   -- This bounded metadata comparison grants no permission or selected value.
   BEGIN
    SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO file_final_lineage
     FROM application_scope_lineage(w,frame_kinds,frame_ids,frame_versions) n;
   EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM='scope_ancestry_unavailable' THEN RETURN NULL;END IF;
    RAISE;
   END;
   IF file_final_lineage IS DISTINCT FROM frame_result->'lineage' THEN RETURN NULL;END IF;
  ELSIF application_native_file_frame_current(w,frame_kinds,frame_ids,frame_versions,frame_result) IS NOT TRUE THEN RETURN NULL;END IF;
 END IF;
 PERFORM application_materialize_field_envelope(w,envelope);
 captures:=jsonb_build_array(envelope)||coalesce(envelope->'children','[]');
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure) IS DISTINCT FROM 'e98b2198a8793a57c982fa992f92cdd5dec0232b93de28d5b9b49cb4b061e1f5'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_current_field_snapshot(uuid,uuid)'::regprocedure) IS DISTINCT FROM '06f3bd17edf6103a9d2014856a9abff19dba216614e6ce17cb13cd1705355403'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_materialize_field_envelope(uuid,jsonb,integer)'::regprocedure) IS DISTINCT FROM '6b4340ea9aa09be4512d8259bd1055c40d6986f8cb5e6319c3d1341cf5a989d5'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)'::regprocedure) IS DISTINCT FROM '70c4a1c928f38e61aebedb549340a42516ec3ba01f62c432cf526b3b4a735d72'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure) IS DISTINCT FROM 'a3ead9fc09f142f7450eabd41b573a07d66ce39adf43aeca1d87786c091634ee'
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure) IS DISTINCT FROM '50973b8ff2d29e46ac9fdc0a424b8100d50ce28d3de6964eee52bde01cda43d7' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF file_frame THEN
  IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_file_capture_helpers_current()'::regprocedure) IS DISTINCT FROM '__OLDGUARD__' THEN RETURN NULL;END IF;
 IF application_native_file_capture_helpers_current() IS NOT TRUE THEN RETURN NULL;END IF;
 END IF;
 rows_json:=jsonb_build_array(jsonb_build_object('row',NULL,'sources',jsonb_build_array(envelope->'source')||(envelope->'sources')));
 FOR child IN SELECT value FROM jsonb_array_elements(coalesce(envelope->'children','[]')) LOOP
  rows_json:=rows_json||jsonb_build_array(jsonb_build_object('row',child#>'{state,values}','sources',jsonb_build_array(child->'source')||(child->'sources')));
 END LOOP;
 RETURN jsonb_build_object('rows',rows_json,'captures',captures);
END $function$
;$stage$,'__OLDGUARD__',old_guard_pin);
 EXECUTE 'CREATE FUNCTION application_native_session_query_acquisition_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $stub$ BEGIN RETURN false;END $stub$';
 FOR routine IN SELECT * FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN('capture_native_session_query_stage','application_native_session_query_acquisition_current') LOOP
 FOR recipient IN SELECT DISTINCT grantee FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a WHERE a.grantee<>routine.proowner LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',routine.oid::regprocedure,CASE WHEN recipient.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(recipient.grantee)) END);
 END LOOP;END LOOP;
 SELECT string_agg(format('(%s::oid,%L::text)',p.oid,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')),',' ORDER BY p.oid),count(*) INTO pins,pin_count FROM pg_proc p WHERE oid IN('application_field_digest(jsonb)'::regprocedure,'external_source_snapshot(uuid,uuid)'::regprocedure,'application_session_field_keys(text)'::regprocedure,'application_field_resource_uuid(text)'::regprocedure,'application_session_query_parent(uuid,uuid)'::regprocedure,'application_session_query_bounds(uuid,jsonb)'::regprocedure,'application_current_field_snapshot(uuid,uuid)'::regprocedure,'read_entity_derivation_source(uuid,text,uuid)'::regprocedure,'read_admitted_native_scope_snapshot(uuid,text,uuid)'::regprocedure,'application_scope_lineage(uuid,text[],uuid[],text[])'::regprocedure,'read_native_session_field_snapshots(uuid,uuid[],text[])'::regprocedure,'read_native_application_session_topics(uuid,uuid,integer)'::regprocedure,'application_materialize_field_envelope(uuid,jsonb,integer)'::regprocedure,'read_native_application_session_history(uuid,uuid,integer)'::regprocedure,'capture_native_session_projection_batch(uuid,uuid,integer,text)'::regprocedure,'read_native_application_session_projection(uuid,uuid,integer,text)'::regprocedure,'application_session_eval_envelope(uuid,text,uuid,text,text[],jsonb)'::regprocedure,'application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)'::regprocedure,'application_session_eval_scan(uuid,uuid,text,integer,text[],jsonb,jsonb,jsonb)'::regprocedure,'observe_application_field_projection(uuid,jsonb,text,uuid,text,text,text,text[])'::regprocedure,'application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)'::regprocedure,'capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)'::regprocedure,'application_native_covered_evidence_helpers_current()'::regprocedure,'application_native_file_capture_helpers_current()'::regprocedure,'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'::regprocedure,'read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'::regprocedure,'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'::regprocedure,'read_native_empty_query_evidence(uuid,text[],uuid[],text[])'::regprocedure);
 IF pin_count<>28 THEN RAISE EXCEPTION 'Native query acquisition roster changed';END IF;
 trusted:='BEGIN
 IF (SELECT count(*)=28 AND coalesce(bool_and(encode(sha256(convert_to(to_jsonb(p)::text,''UTF8'')),''hex'')=pin.fingerprint),false)
 FROM (VALUES '||pins||') pin(function_oid,fingerprint) JOIN pg_catalog.pg_proc p ON p.oid=pin.function_oid) IS NOT TRUE THEN RETURN false;END IF;
 RETURN application_native_covered_evidence_helpers_current();
 END';
 EXECUTE format('CREATE OR REPLACE FUNCTION application_native_session_query_acquisition_current() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',trusted);
 SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO guard_pin FROM pg_proc p WHERE oid='application_native_session_query_acquisition_current()'::regprocedure;
 EXECUTE replace($public$CREATE FUNCTION public.read_native_session_query_evidence(w uuid,s uuid,body_through integer,topics_through integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET plan_cache_mode=force_generic_plan AS $body$
DECLARE roots jsonb;nodes jsonb;sources jsonb;proof jsonb;initial_frame jsonb;final_frame jsonb;reader_context jsonb;history jsonb;topics jsonb;captures jsonb;source jsonb;
 kinds text[];ids uuid[];versions text[];parent jsonb;bounds jsonb;
BEGIN
 -- An unavailable optional operation rolls back all staged observations.
 BEGIN
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_session_query_acquisition_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF application_native_session_query_acquisition_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF has_function_privilege(session_user,'public.read_native_application_session_history(uuid,uuid,integer)','EXECUTE') IS NOT TRUE
 OR has_function_privilege(session_user,'public.read_native_application_session_topics(uuid,uuid,integer)','EXECUTE') IS NOT TRUE
 OR has_function_privilege(session_user,'public.read_native_attended_memory_evidence(uuid,text[],uuid[],text[])','EXECUTE') IS NOT TRUE
 OR has_function_privilege(session_user,'public.read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)','EXECUTE') IS NOT TRUE
 OR has_function_privilege(session_user,'public.read_native_empty_query_evidence(uuid,text[],uuid[],text[])','EXECUTE') IS NOT TRUE THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF body_through IS NULL OR topics_through IS NULL OR body_through<0 OR topics_through<0 THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 parent:=application_session_query_parent(w,s);bounds:=application_session_query_bounds(w,parent);
 IF parent IS NULL OR bounds IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_agg(r ORDER BY r::text) INTO roots FROM(
 SELECT jsonb_build_object('kind','session_message','id',m.id,'version',m.scope_version::text) r
 FROM session_messages m WHERE m.workspace_id=w AND m.session_id=s AND m.sequence_num<=body_through
 UNION SELECT jsonb_build_object('kind','session_context_revision','id',v.id,'version','1')
 FROM session_messages m JOIN session_message_annotation_heads h ON h.workspace_id=m.workspace_id AND h.session_id=m.session_id AND h.message_id=m.id
 JOIN session_context_scope_revisions v ON v.workspace_id=h.workspace_id AND v.id=h.scope_revision_id AND v.session_id=m.session_id AND v.parent_kind='message_annotation' AND v.parent_id=m.id
 WHERE m.workspace_id=w AND m.session_id=s AND m.sequence_num<=topics_through LIMIT 101) q;
 IF roots IS NULL OR jsonb_array_length(roots) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 kinds:=ARRAY(SELECT r->>'kind' FROM jsonb_array_elements(roots) r);
 ids:=ARRAY(SELECT (r->>'id')::uuid FROM jsonb_array_elements(roots) r);
 versions:=ARRAY(SELECT r->>'version' FROM jsonb_array_elements(roots) r);
 reader_context:=jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name));
 SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.kind,n.id,n.version),'[]') INTO nodes FROM application_scope_lineage(w,kinds,ids,versions) n;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(nodes) n WHERE n->>'kind'='workspace_file') THEN
  -- Preserve the original no-file computations and proof precedence.
  SELECT jsonb_agg(value ORDER BY ord) INTO history FROM read_native_application_session_history(w,s,body_through) WITH ORDINALITY r(value,ord);
  IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_session_query_acquisition_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF application_native_session_query_acquisition_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
  SELECT jsonb_agg(value ORDER BY ord) INTO topics FROM read_native_application_session_topics(w,s,topics_through) WITH ORDINALITY r(value,ord);
  IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_session_query_acquisition_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF application_native_session_query_acquisition_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
  SELECT jsonb_agg(q.source ORDER BY q.source::text) INTO sources FROM(SELECT DISTINCT ref.value AS source FROM jsonb_array_elements(history||topics) captured(row)
   CROSS JOIN LATERAL jsonb_array_elements(captured.row->'sources') ref(value)) q;
  IF sources IS NULL OR jsonb_array_length(sources) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
  kinds:=ARRAY(SELECT r->>'resourceKind' FROM jsonb_array_elements(sources) r);
  ids:=ARRAY(SELECT (r->>'resourceId')::uuid FROM jsonb_array_elements(sources) r);
  versions:=ARRAY(SELECT r->>'version' FROM jsonb_array_elements(sources) r);
  proof:=read_native_attended_memory_evidence(w,kinds,ids,versions);
  IF proof IS NULL THEN proof:=read_native_file_session_evidence(w,kinds,ids,versions,true);END IF;
  IF proof IS NULL THEN proof:=read_native_empty_query_evidence(w,kinds,ids,versions);END IF;
  IF proof->>'admitted'='false' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF proof->>'admitted' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
  IF jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name)) IS DISTINCT FROM reader_context THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_session_query_acquisition_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF application_native_session_query_acquisition_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
  RETURN jsonb_build_object('history',history,'annotations',topics,'proof',proof);
 END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_session_query_acquisition_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF application_native_session_query_acquisition_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 initial_frame:=read_native_file_session_cohort_frame(w,kinds,ids,versions,true);
 IF jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name)) IS DISTINCT FROM reader_context THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF initial_frame->>'admitted' IS DISTINCT FROM 'true' OR initial_frame#>>'{memo,memoryStatement,workspaceId}' IS DISTINCT FROM w::text THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 initial_frame:=initial_frame||jsonb_build_object('captureRoots',roots);
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_session_query_acquisition_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF application_native_session_query_acquisition_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 history:=capture_native_session_query_stage(w,s,body_through,'session_message',initial_frame,reader_context);
 IF history IS NULL THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_session_query_acquisition_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF application_native_session_query_acquisition_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 topics:=capture_native_session_query_stage(w,s,topics_through,'session_message_annotation',initial_frame,reader_context);
 IF topics IS NULL THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 captures:=(history->'captures')||(topics->'captures');
 IF captures IS NULL OR jsonb_array_length(captures)>100 THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 ids:=ARRAY(SELECT (r->>'resourceId')::uuid FROM jsonb_array_elements(captures) r);
 versions:=ARRAY(SELECT r#>>'{source,version}' FROM jsonb_array_elements(captures) r);
 IF jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name)) IS DISTINCT FROM reader_context THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_session_query_acquisition_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF application_native_session_query_acquisition_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 final_frame:=read_native_file_session_cohort_frame(w,ARRAY(SELECT 'application_field'::text FROM unnest(ids)),ids,versions,true);
 IF final_frame->>'admitted'='false' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 IF final_frame->>'admitted' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF jsonb_build_object('sessionUser',session_user,'currentUser',current_user,'settings',(SELECT jsonb_object_agg(setting_name,current_setting(setting_name,true)) FROM unnest(ARRAY['app.agent_actor_id','app.agent_clearance','app.agent_compartments','app.agent_mutation_compartments','app.agent_project_ids','app.agent_shared_audience','app.agent_visibility_assistants','app.agent_workspace_id','app.application_assistant_id','app.application_command_key','app.application_credential_id','app.application_credential_review_id','app.application_grant_review_id','app.application_home_binding_id','app.application_id','app.application_native_write_intent','app.application_oauth_id','app.application_record_write_type','app.assistant_transfer','app.association_source_membership_actor','app.association_source_order_actor','app.capture_admission','app.capture_session','app.connector_setup_id','app.creation_admission','app.crm_erasure_capture','app.crm_historical_actor','app.current_user_id','app.deployed_application_module','app.engineering_archive_publication','app.explicit_general','app.external_key_explicit','app.external_key_session','app.external_source_action','app.external_source_actor_id','app.external_source_assistant_id','app.external_source_operation_id','app.external_source_service_binding_id','app.knowledge_event_actor','app.media_intake_parent','app.native_entity_write_intent','app.native_query_data_ceilings','app.native_task_write_intent','app.page_event_moved_id','app.pdf_intake_artifact','app.programmatic_candidate','app.programmatic_candidate_source','app.programmatic_publication_batch','app.public_share_mode','app.public_share_root','app.public_share_token_hash','app.recording_session_admission','app.retained_task_goal','app.routine_intake_apply_receipt','app.routine_intake_toggle_receipt','app.scope_review_actor','app.session_creation_admission','app.source_service_release_review_id','app.system_bypass','app.v2_active','app.v2_assistant_id','app.v2_binding','app.v2_cap','app.v2_context_department','app.workflow_schedule_review']) setting_name)) IS DISTINCT FROM reader_context OR final_frame#>'{memo,memoryStatement,context}' IS DISTINCT FROM initial_frame#>'{memo,memoryStatement,context}' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 FOR source IN SELECT value->'source' FROM jsonb_array_elements(captures) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(final_frame->'current') v WHERE v=source) THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
 END LOOP;
 IF (SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') FROM pg_proc p WHERE oid='application_native_session_query_acquisition_current()'::regprocedure) IS DISTINCT FROM '__GUARD__' THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 IF application_native_session_query_acquisition_current() IS NOT TRUE THEN RAISE EXCEPTION 'native_query_acquisition_unavailable' USING ERRCODE='P8166';END IF;
 RETURN jsonb_build_object('history',history->'rows','annotations',topics->'rows','proof',jsonb_build_object('admitted',true,'immutable',final_frame->'immutable','current',final_frame->'current'));
 EXCEPTION WHEN SQLSTATE 'P8166' THEN RETURN NULL;
 WHEN invalid_parameter_value THEN
  IF SQLERRM='scope_ancestry_unavailable' THEN RETURN NULL;END IF;RAISE;
 END;
END $body$;

$public$,'__GUARD__',guard_pin);
 SELECT * INTO routine FROM pg_proc WHERE oid='read_native_session_query_evidence(uuid,uuid,integer,integer)'::regprocedure;
 FOR recipient IN SELECT DISTINCT grantee FROM aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) a WHERE a.grantee<>routine.proowner LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s',routine.oid::regprocedure,CASE WHEN recipient.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(recipient.grantee)) END);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN GRANT EXECUTE ON FUNCTION read_native_session_query_evidence(uuid,uuid,integer,integer) TO app_user;END IF;
 IF application_native_session_query_acquisition_current() IS NOT TRUE THEN RAISE EXCEPTION 'Native query acquisition installation guard failed';END IF;
END $install$;
COMMIT;
