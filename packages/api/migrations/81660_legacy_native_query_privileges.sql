BEGIN;
-- [COMP:api/migration-owner-role] Exact historical native query-helper ACL repair.
-- Sorts before 8166_; installed acquisition guards retain their catalog pins.
DO $legacy_query_privileges$
DECLARE actual pg_proc;expected jsonb;repairs text[]:='{}';signature text;
 runtime_id oid := (SELECT oid FROM pg_roles WHERE rolname='app_user');
 owner_id oid := (SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass);
BEGIN
 IF EXISTS(SELECT 1 FROM public._migrations WHERE name='8166_native_session_query_acquisition.sql') THEN RETURN;END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements($expected$[{"signature":"application_session_field_keys(text)","body":"f463c3c77e9f3ae1d8df58b7c3a2dd4e6d771386b3b9532d79b2ab72b9a5f10a","language":"sql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_field_keys","prorows":0,"pronargs":1,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":false,"prorettype":"1009","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["t"],"proargtypes":["25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"i","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_session_query_bounds(uuid,jsonb)","body":"cdcf2c6726be3b8a82e569fe8d2012b1a1d15030048d43a391ee72502328ca8b","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_query_bounds","prorows":0,"pronargs":2,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","parent"],"proargtypes":["2950","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"application_materialize_field_envelope(uuid,jsonb,integer)","body":"6b4340ea9aa09be4512d8259bd1055c40d6986f8cb5e6319c3d1341cf5a989d5","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_materialize_field_envelope","prorows":0,"pronargs":3,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"2278","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","envelope","depth"],"proargtypes":["2950","3802","23"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":"({CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]})","pronargdefaults":1}},{"signature":"application_session_query_scan(uuid,uuid,text,integer,text[],jsonb,jsonb)","body":"70c4a1c928f38e61aebedb549340a42516ec3ba01f62c432cf526b3b4a735d72","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_query_scan","prorows":0,"pronargs":7,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","s","t","through","fields","bounds","visibility"],"proargtypes":["2950","2950","25","23","1009","3802","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}},{"signature":"read_native_application_session_projection(uuid,uuid,integer,text)","body":"260578e84bb3475048984862059580bed6161dc5bf7642378e508e45dc2ecb93","language":"plpgsql","appAllowed":false,"metadata":{"probin":null,"procost":100,"prokind":"f","proname":"read_native_application_session_projection","prorows":1000,"pronargs":4,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":true,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":["i","i","i","i","t"],"proargnames":["w","s","through","t","value"],"proargtypes":["2950","2950","23","25"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":["2950","2950","23","25","3802"],"proargdefaults":null,"pronargdefaults":0}}]$expected$::jsonb) LOOP
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
  RAISE EXCEPTION 'Legacy native query prerequisite changed: %',expected->>'signature';
 END IF;
 repairs:=array_append(repairs,expected->>'signature');
 END LOOP;
 -- No ACL changes precede validation of the complete closed roster.
 IF runtime_id IS NOT NULL THEN
  FOREACH signature IN ARRAY repairs LOOP
   EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM app_user',signature);
  END LOOP;
 END IF;
END $legacy_query_privileges$;
COMMIT;
