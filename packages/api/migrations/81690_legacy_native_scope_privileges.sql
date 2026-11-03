BEGIN;
-- [COMP:api/migration-owner-role] Authenticate one historical private ACL before 8169.
DO $legacy_scope_privileges$
DECLARE actual pg_proc;
 expected jsonb := $expected${"signature":"application_session_eval_scope_current(uuid,text,uuid,text,jsonb)","body":"b977bab4f04ae2d61d7c7d042225d41a97346466f95352e6f8c8e934bd2a46ca","language":"plpgsql","metadata":{"probin":null,"procost":100,"prokind":"f","proname":"application_session_eval_scope_current","prorows":0,"pronargs":5,"proconfig":["search_path=pg_catalog, public, pg_temp"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["w","k","i","v","memo"],"proargtypes":["2950","25","2950","25","3802"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"v","proleakproof":false,"proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}}$expected$::jsonb;
 runtime_id oid := (SELECT oid FROM pg_roles WHERE rolname='app_user');
 owner_id oid := (SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass);
BEGIN
 -- Already installed manifests are immutable, even during direct re-execution.
 IF EXISTS(SELECT 1 FROM public._migrations WHERE name='8169_native_covered_helper_manifest.sql') THEN RETURN;END IF;
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
  RAISE EXCEPTION 'Legacy native scope prerequisite changed: %',expected->>'signature';
 END IF;
 -- Only the reviewed owner-issued runtime grant may be removed.
 IF runtime_id IS NOT NULL THEN
  REVOKE EXECUTE ON FUNCTION public.application_session_eval_scope_current(uuid,text,uuid,text,jsonb) FROM app_user;
 END IF;
END $legacy_scope_privileges$;
COMMIT;
