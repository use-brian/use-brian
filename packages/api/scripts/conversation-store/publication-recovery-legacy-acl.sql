-- [COMP:api/native-turn-frame] Closed historical inherited EXECUTE repair.
-- phase: before_auth
CREATE TEMP TABLE publication_legacy_acl_repairs(signature text PRIMARY KEY,canonical_acl aclitem[] NOT NULL) ON COMMIT DROP;
DO $legacy_default$
DECLARE owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');actual aclitem[];present boolean;
BEGIN
 IF runtime_id IS NULL OR EXISTS(SELECT 1 FROM pg_default_acl WHERE defaclrole=owner_id AND defaclobjtype='f' AND defaclnamespace=0)
 THEN RAISE EXCEPTION 'publication_legacy_function_default_changed';END IF;
 SELECT defaclacl INTO actual FROM pg_default_acl WHERE defaclrole=owner_id AND defaclobjtype='f' AND defaclnamespace='public'::regnamespace;
 present:=FOUND;
 IF present AND actual IS DISTINCT FROM ARRAY[makeaclitem(runtime_id,owner_id,'EXECUTE',false)]
 THEN RAISE EXCEPTION 'publication_legacy_function_default_changed';END IF;
END $legacy_default$;
CREATE FUNCTION pg_temp.publication_authenticate_acl(signature text,actual pg_catalog.pg_proc,expected_acl jsonb,actual_acl jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $authenticate_acl$
DECLARE profile constant jsonb:=__PUBLICATION_LEGACY_ACL_PROFILE__::jsonb;binding jsonb;legacy_acl jsonb;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');legacy_raw aclitem[];canonical_raw aclitem[];
BEGIN
 IF actual_acl IS NOT DISTINCT FROM expected_acl THEN RETURN;END IF;
 SELECT value INTO binding FROM jsonb_array_elements(profile->'functions') WHERE value->>'signature'=signature;
 IF binding IS NULL
 THEN RAISE EXCEPTION 'publication_predecessor_changed: %',signature;END IF;
 SELECT jsonb_agg(value ORDER BY value->>'grantee' COLLATE "C") INTO legacy_acl
 FROM jsonb_array_elements(expected_acl||jsonb_build_array(jsonb_build_object('grantee','app_user','grantor','OWNER','privilege','EXECUTE','grantable',false)));
 -- The historical per-schema default compiles entries in grantee-OID order.
 -- Neither expected grants nor their raw order are copied from installed ACLs.
 SELECT array_agg(makeaclitem(grantee,owner_id,'EXECUTE',false) ORDER BY grantee) INTO legacy_raw
 FROM(SELECT CASE value->>'grantee' WHEN 'OWNER' THEN owner_id WHEN 'PUBLIC' THEN 0::oid END grantee
  FROM jsonb_array_elements(expected_acl) UNION ALL SELECT runtime_id) grants;
 IF actual_acl IS DISTINCT FROM legacy_acl OR (actual).proacl IS DISTINCT FROM legacy_raw
 THEN RAISE EXCEPTION 'publication_predecessor_changed: %',signature;END IF;
 SELECT array_agg(makeaclitem(grantee,owner_id,'EXECUTE',false) ORDER BY grantee) INTO canonical_raw
 FROM(SELECT CASE value->>'grantee' WHEN 'OWNER' THEN owner_id WHEN 'PUBLIC' THEN 0::oid END grantee
  FROM jsonb_array_elements(expected_acl)) grants;
 INSERT INTO pg_temp.publication_legacy_acl_repairs VALUES(signature,canonical_raw);
END $authenticate_acl$;
-- phase: after_auth
DO $normalize_legacy_acl$
DECLARE routine record;actual pg_proc;next_row pg_proc;expected jsonb;
BEGIN
 -- The whole predecessor closure and current guards have authenticated, and
 -- ORIGINAL fingerprint consumers have been classified, before this mutation.
 FOR routine IN SELECT repair.signature,repair.canonical_acl,old.metadata,old.fingerprint
  FROM pg_temp.publication_legacy_acl_repairs repair JOIN pg_temp.publication_reviewed_contracts old USING(signature)
  ORDER BY repair.signature COLLATE "C"
 LOOP
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||routine.signature);
  IF to_jsonb(actual) IS DISTINCT FROM routine.metadata OR EXISTS(SELECT 1 FROM native_turn_contract_helpers h
   WHERE h.signature=routine.signature AND to_jsonb(h.contract) IS DISTINCT FROM routine.metadata)
   OR EXISTS(SELECT 1 FROM native_retained_contract_helpers h WHERE h.signature=routine.signature AND h.fingerprint<>routine.fingerprint)
  THEN RAISE EXCEPTION 'publication_legacy_acl_predecessor_changed: %',routine.signature;END IF;
  expected:=jsonb_set(routine.metadata,'{proacl}',to_jsonb(routine.canonical_acl));
  EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM app_user',routine.signature);
  SELECT * INTO STRICT next_row FROM pg_proc WHERE oid=(actual).oid;
  IF to_jsonb(next_row) IS DISTINCT FROM expected
  THEN RAISE EXCEPTION 'publication_legacy_acl_successor_changed: %',routine.signature;END IF;
  UPDATE native_turn_contract_helpers h SET contract=next_row WHERE h.signature=routine.signature;
  UPDATE native_retained_contract_helpers h SET fingerprint=encode(sha256(convert_to(expected::text,'UTF8')),'hex')
   WHERE h.signature=routine.signature AND h.fingerprint=routine.fingerprint;
  UPDATE pg_temp.publication_expected_current SET metadata=expected WHERE signature=routine.signature;
 END LOOP;
END $normalize_legacy_acl$;
