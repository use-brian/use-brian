-- [COMP:api/native-turn-frame] Authenticate the retained guard before invocation.
DO $authenticate_retained_guard$
DECLARE actual pg_proc;reference pg_proc;expected jsonb;relation pg_class;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 body constant text:=__PUBLICATION_RETAINED_GUARD_BODY__;
BEGIN
 -- Reading the private registry must not execute an unreviewed RLS policy/rule.
 SELECT * INTO relation FROM pg_class WHERE oid=to_regclass('public.native_retained_contract_helpers');
 IF relation.oid IS NULL OR relation.relkind<>'r' OR relation.relpersistence<>'p'
  OR relation.relowner<>owner_id OR NOT relation.relrowsecurity OR relation.relforcerowsecurity
  OR coalesce(relation.relacl,acldefault('r',owner_id)) IS DISTINCT FROM acldefault('r',owner_id)
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=relation.oid)
  OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=relation.oid)
  OR (SELECT jsonb_agg(jsonb_build_array(attnum,attname,atttypid,atttypmod,attnotnull,attgenerated,attidentity,attisdropped,attacl) ORDER BY attnum)
   FROM pg_attribute WHERE attrelid=relation.oid AND attnum>0) IS DISTINCT FROM
   '[[1,"signature","25",-1,true,"","",false,null],[2,"fingerprint","25",-1,true,"","",false,null]]'::jsonb
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation.oid AND attnum>0
   AND (atthasdef OR attcollation<>'pg_catalog."default"'::regcollation))
 THEN RAISE EXCEPTION 'publication_retained_registry_changed';END IF;
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.native_retained_helpers_current()');
 IF actual.oid IS NULL THEN RAISE EXCEPTION 'publication_retained_guard_missing';END IF;
 -- This declaration is reconstructed from the immutable source and named
 -- retirement, never from actual.prosrc or an installed registry record.
 EXECUTE format('CREATE FUNCTION pg_temp.publication_retained_guard_reference() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',body);
 SELECT * INTO STRICT reference FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname='publication_retained_guard_reference';
 expected:=(to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proowner','proacl'])||jsonb_build_object(
  'oid',actual.oid,'proname','native_retained_helpers_current','pronamespace','public'::regnamespace::oid,
  'proowner',owner_id,'proacl',ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]);
 IF (actual.prosrc COLLATE "C") IS DISTINCT FROM (body COLLATE "C") OR to_jsonb(actual) IS DISTINCT FROM expected
 THEN RAISE EXCEPTION 'publication_retained_guard_changed';END IF;
 INSERT INTO pg_temp.publication_reviewed_contracts VALUES('native_retained_helpers_current()',expected,encode(sha256(convert_to(expected::text,'UTF8')),'hex'));
 INSERT INTO pg_temp.publication_expected_current VALUES('native_retained_helpers_current()',expected);
 INSERT INTO pg_temp.publication_successor_templates VALUES('native_retained_helpers_current()',jsonb_build_array(body));
 DROP FUNCTION pg_temp.publication_retained_guard_reference();
END $authenticate_retained_guard$;
