BEGIN;
-- [COMP:api/migration-owner-role] Repair leftover app_user EXECUTE on query-scope
-- helpers before 8183 enrolls them into the flat covered manifest.
-- Sorts between 8182_ and 8183_; never rename an applied migration.
-- setup.sql / packaged PostgreSQL setup historically granted EXECUTE on all
-- functions to app_user. 81110 repaired only its reviewed roster; these three
-- helpers kept the leftover grant and fail 8183's owner-only ACL pin.
DO $legacy_query_scope_privileges$
DECLARE actual pg_proc;expected jsonb;repairs text[]:='{}';signature text;
 runtime_id oid := (SELECT oid FROM pg_roles WHERE rolname='app_user');
 owner_id oid := (SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass);
BEGIN
 IF EXISTS(SELECT 1 FROM public._migrations WHERE name='8183_native_turn_requirements.sql') THEN RETURN;END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[
{"signature":"application_query_scope_admits_point(jsonb,jsonb)","body":"2ec2c0a0efb6b177ebb027b3da0be792970b9a80bec17a0124f0871ac738fdfb","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_query_scope_admits_point","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"16","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["bounds","source"],"proargtypes":["3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},
{"signature":"application_query_scope_escape(jsonb[],integer,text[],text[],text[],integer)","body":"da5916c9103078288651ffd20c529938e97281dccf610a1fccee4d78e1a29f68","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_query_scope_escape","prorows":0,"pronargs":6,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["conditions","p_position","positive","negative","departments","budget"],"proargtypes":["3807","23","1009","1009","1009","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},
{"signature":"application_query_scope_union_contains(jsonb,jsonb,integer)","body":"838ead45c8eaa93d9d8f34a5d35cac23a7deec81798a12078aa49bf805ffc9c4","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_query_scope_union_contains","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["original","current_scopes","budget"],"proargtypes":["3802","3802","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}
]$expected$::jsonb) LOOP
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(expected->>'signature'));
 IF actual.oid IS NULL OR encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM expected->>'body'
  OR actual.proowner IS DISTINCT FROM owner_id OR actual.pronamespace<>'public'::regnamespace
  OR actual.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname=expected->>'language')
  OR (to_jsonb(actual)-ARRAY['oid','prosrc','proowner','proacl','prolang','pronamespace']) IS DISTINCT FROM expected->'metadata'
  OR NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantee=owner_id AND a.grantor=owner_id AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
  OR EXISTS(SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
   WHERE a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
    OR (a.grantee<>owner_id AND NOT(a.grantee<>0 AND a.grantee=coalesce(runtime_id,0)))) THEN
  RAISE EXCEPTION 'Legacy query scope prerequisite changed: %',expected->>'signature';
 END IF;
 repairs:=array_append(repairs,expected->>'signature');
 END LOOP;
 -- No ACL changes precede validation of the complete closed roster.
 IF runtime_id IS NOT NULL THEN
  FOREACH signature IN ARRAY repairs LOOP
   EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM app_user',signature);
  END LOOP;
 END IF;
END $legacy_query_scope_privileges$;
COMMIT;
