-- Spec: docs/architecture/features/application-platform-management.md: retired host source authoring.
-- [COMP:api/source-service-binding] Keep saved identities/current recovery; retire new host command authority.
BEGIN;
DO $retirement$
DECLARE expected record;installed pg_proc;definition text;original text;replacement text;before_properties jsonb;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.application_source_setup_reviews'::regclass);
 app_role oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
BEGIN
 IF owner_id IS NULL OR owner_id<>(SELECT oid FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'application_source_retirement_prerequisite_changed' USING ERRCODE='55000';END IF;
 FOR expected IN SELECT * FROM (VALUES
  ('application_prepare_source_setup(uuid,uuid,jsonb)','uuid','v',true,'48e848488b37a3323fcebc6c6e35cb28'),
  ('application_apply_source_setup(uuid,uuid)','uuid','v',true,'efabf2268edcf8892c1bca555e70741e'),
  ('application_scoped_grant_allowed_before_records(uuid,jsonb)','boolean','s',false,'a1be02705b3c8de9e0ae67ab3fcb871e')
 ) AS contract(signature,return_type,volatility,runtime_entry,body_hash) LOOP
  SELECT * INTO installed FROM pg_proc WHERE oid=to_regprocedure('public.'||expected.signature);
  IF NOT FOUND OR installed.proowner<>owner_id OR installed.prokind<>'f'
   OR installed.prorettype<>to_regtype(expected.return_type)
   OR installed.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR NOT installed.prosecdef OR installed.provolatile::text<>expected.volatility OR installed.proparallel<>'u'
   OR installed.proisstrict OR installed.proleakproof OR installed.proretset OR installed.provariadic<>0
   OR installed.prosupport<>0 OR installed.prosqlbody IS NOT NULL OR installed.procost<>100 OR installed.prorows<>0
   OR installed.protrftypes IS NOT NULL OR installed.proargmodes IS NOT NULL
   OR installed.proargnames IS DISTINCT FROM (CASE expected.signature
    WHEN 'application_prepare_source_setup(uuid,uuid,jsonb)' THEN ARRAY['w','a','p']
    WHEN 'application_apply_source_setup(uuid,uuid)' THEN ARRAY['r','approval_id'] ELSE ARRAY['a','p'] END)
   OR installed.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
   OR installed.proargdefaults IS NOT NULL OR installed.pronargdefaults<>0
   OR md5(installed.prosrc)<>expected.body_hash
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(installed.proacl,acldefault('f',installed.proowner))) a
    WHERE a.grantor<>owner_id OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR NOT(a.grantee=owner_id OR expected.runtime_entry AND app_role IS NOT NULL AND a.grantee=app_role))
   OR NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(installed.proacl,acldefault('f',installed.proowner))) a WHERE a.grantee=owner_id)
   OR expected.runtime_entry AND app_role IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM aclexplode(coalesce(installed.proacl,acldefault('f',installed.proowner))) a WHERE a.grantee=app_role)
  THEN RAISE EXCEPTION 'application_source_retirement_prerequisite_changed: %',expected.signature USING ERRCODE='55000';END IF;
  before_properties:=to_jsonb(installed)-'prosrc';
  definition:=pg_get_functiondef(installed.oid);
  CASE expected.signature
   WHEN 'application_prepare_source_setup(uuid,uuid,jsonb)' THEN
    original:=$old$ snapshot:=application_source_setup_snapshot(w,a,(p->>'instanceId')::uuid);$old$;
    replacement:=$new$ IF p ? 'effectBinding' THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';END IF;
 snapshot:=application_source_setup_snapshot(w,a,(p->>'instanceId')::uuid);$new$;
   WHEN 'application_apply_source_setup(uuid,uuid)' THEN
    original:=$old$ RETURN v.profile_id;END IF;
 SELECT * INTO a FROM application_source_setup_approvals$old$;
    replacement:=$new$ RETURN v.profile_id;END IF;
 IF v.proposal ? 'effectBinding' THEN RAISE EXCEPTION 'source_access_denied' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM application_source_setup_approvals$new$;
   WHEN 'application_scoped_grant_allowed_before_records(uuid,jsonb)' THEN
    original:=$old$ AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'actions') action WHERE action NOT IN('read','command:source.derive','command:source.retain')
   AND NOT(action='command:source.mutate' AND s.source_effect_binding IS NOT DISTINCT FROM 'command_v1'))
 AND (p->'writeFields'='[]'::jsonb OR (s.source_effect_binding='command_v1' AND p->'actions' @> '["command:source.mutate"]'::jsonb)));$old$;
    replacement:=$new$ AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p->'actions') action WHERE action NOT IN('read','command:source.derive','command:source.retain'))
 AND p->'writeFields'='[]'::jsonb);$new$;
  END CASE;
  IF (length(definition)-length(replace(definition,original,'')))/length(original)<>1 THEN
   RAISE EXCEPTION 'application_source_retirement_prerequisite_changed: replacement %',expected.signature USING ERRCODE='55000';END IF;
  EXECUTE replace(definition,original,replacement);
  IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=installed.oid) IS DISTINCT FROM before_properties THEN
   RAISE EXCEPTION 'application_source_retirement_properties_changed: %',expected.signature USING ERRCODE='55000';END IF;
 END LOOP;
END $retirement$;
COMMIT;
