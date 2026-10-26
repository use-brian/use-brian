-- Retire only new broad application legacy review authoring. Keep pending
-- view/apply/cancel, historical definitions, immutable IDs/hashes and held rows.
-- [COMP:api/application-legacy-review]
BEGIN;
DO $guard$
DECLARE expected record; installed pg_proc;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspace_scope_reviews'::regclass);
 app_role oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
BEGIN
 IF owner_id IS NULL OR owner_id<>(SELECT oid FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'application_legacy_retirement_prerequisite_changed' USING ERRCODE='55000';
 END IF;
 IF app_role IS NOT NULL AND (EXISTS(SELECT 1 FROM pg_roles WHERE oid=app_role AND (rolsuper OR rolbypassrls))
  OR pg_has_role(app_role,owner_id,'MEMBER')) THEN
  RAISE EXCEPTION 'application_legacy_retirement_prerequisite_changed' USING ERRCODE='55000';
 END IF;
 FOR expected IN SELECT * FROM (VALUES
  ('guard_application_legacy_review_metadata()','trigger','plpgsql',false,'v','fdff6e30d1c6c2e14f4ebfdecf1fc193',NULL::text,false),
  ('application_legacy_review_authorize(uuid,uuid)','uuid','plpgsql',true,'v','7c80947534231f2e54237f8b6e0e5107',NULL::text,false),
  ('application_legacy_inventory_registry()','text[]','sql',false,'i','94472f13893bc04e88a954691e9fa9a7',NULL::text,false),
  ('application_legacy_review_snapshot(uuid,text,uuid)','jsonb','plpgsql',true,'v','4f287273629a9ae6a60e27716ef4fc02',NULL::text,false),
  ('application_legacy_review_impact(uuid,text,uuid)','jsonb','plpgsql',true,'v','6f67786014c1caf6d281af7c2577f3ad',NULL::text,false),
  ('application_legacy_repair_plan(uuid,uuid)','jsonb','plpgsql',true,'v','167f91ffab87009f5221cdbe97477b7e',NULL::text,false),
  ('application_legacy_inventory(uuid,uuid,text,uuid)','jsonb','plpgsql',true,'v','1071307902b8f5f9bcff54d7d09918c2','NULL::uuid',true),
  ('application_legacy_review_view(uuid,uuid,uuid)','jsonb','plpgsql',true,'v','67345ea54ed84f7a17cc4a19bd5ab506',NULL::text,true),
  ('application_legacy_review_preview(uuid,uuid,text,uuid[],text,text)','jsonb','plpgsql',true,'v','df4dc59689fa6c67b180f53469dca88a',NULL::text,true),
  ('application_legacy_review_apply(uuid,uuid,uuid,text,text,boolean)','jsonb','plpgsql',true,'v','35be9aed39c66a07ced2156b2a061379','false',true)
 ) AS contract(signature,return_type,language_name,security_definer,volatility,body_hash,default_expression,runtime_entry) LOOP
  SELECT * INTO installed FROM pg_proc WHERE oid=to_regprocedure('public.'||expected.signature);
  IF NOT FOUND OR installed.proowner<>owner_id OR installed.prokind<>'f'
   OR installed.prorettype<>to_regtype(expected.return_type)
   OR installed.prolang<>(SELECT oid FROM pg_language WHERE lanname=expected.language_name)
   OR installed.prosecdef IS DISTINCT FROM expected.security_definer
   OR installed.provolatile::text<>expected.volatility OR installed.proparallel<>'u'
   OR installed.proisstrict OR installed.proleakproof OR installed.proargmodes IS NOT NULL
   OR installed.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
   OR md5(installed.prosrc)<>expected.body_hash
   OR pg_get_expr(installed.proargdefaults,0) IS DISTINCT FROM expected.default_expression
   OR installed.pronargdefaults<>(CASE WHEN expected.default_expression IS NULL THEN 0 ELSE 1 END)
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(installed.proacl,acldefault('f',installed.proowner))) a
    WHERE a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR NOT(a.grantee=owner_id OR expected.runtime_entry AND app_role IS NOT NULL AND a.grantee=app_role))
   OR NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(installed.proacl,acldefault('f',installed.proowner))) a WHERE a.grantee=owner_id)
   OR expected.runtime_entry AND app_role IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM aclexplode(coalesce(installed.proacl,acldefault('f',installed.proowner))) a WHERE a.grantee=app_role)
  THEN RAISE EXCEPTION 'application_legacy_retirement_prerequisite_changed' USING ERRCODE='55000'; END IF;
 END LOOP;
END $guard$;
DO $retire$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
  REVOKE ALL ON FUNCTION application_legacy_inventory(uuid,uuid,text,uuid) FROM app_user;
  REVOKE ALL ON FUNCTION application_legacy_review_preview(uuid,uuid,text,uuid[],text,text) FROM app_user;
 END IF;
END $retire$;
COMMIT;
