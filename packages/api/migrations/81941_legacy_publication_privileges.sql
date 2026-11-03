BEGIN;
-- [COMP:api/migration-owner-role] Repair deployment grants on private publication
-- relations before 8195 authenticates their owner-only ACLs. 81940 repairs only
-- field-dependency queues. Setup also reopened the private reader manifest and
-- granted debug SELECT on publication/shared evidence tables. The latter retain
-- their required app_user CRUD grants; every other non-owner grant is removed.
-- Sorts after the already-released 81940 and before 8195. Do not weaken the
-- independent structural checks or rebuild manifests from an unverified catalog.
DO $legacy_publication_privileges$
DECLARE relation record;recipient record;ids oid[];evidence_ids oid[];runtime_id oid;
BEGIN
 IF EXISTS(SELECT 1 FROM public._migrations WHERE name='8195_native_publication_invalidation_contract.sql') THEN RETURN;END IF;
 ids:=ARRAY[
  'public.native_turn_frames'::regclass,
  'public.native_turn_publication_work'::regclass,
  'public.native_turn_publication_events'::regclass,
  'public.native_turn_publication_seals'::regclass,
  'public.native_turn_publication_impossible'::regclass,
  'public.native_turn_publication_debt'::regclass,
  'public.native_turn_contract_helpers'::regclass,
  to_regclass('public.native_crm_current_cohorts')];
 FOR relation IN SELECT oid,relname,relowner,relacl FROM pg_class WHERE oid=ANY(ids) LOOP
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',relation.relname);
  FOR recipient IN SELECT DISTINCT role.rolname
   FROM aclexplode(coalesce(relation.relacl,acldefault('r',relation.relowner))) a
   JOIN pg_roles role ON role.oid=a.grantee WHERE a.grantee<>relation.relowner LOOP
   EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',relation.relname,recipient.rolname);
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=ANY(ids) AND
  EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   WHERE a.grantee<>c.relowner OR a.grantor<>c.relowner OR a.is_grantable))
 THEN RAISE EXCEPTION 'Legacy publication privilege repair left non-owner ACL';END IF;
 evidence_ids:=ARRAY['public.scope_derivations'::regclass,'public.scope_derivation_sources'::regclass];
 SELECT oid INTO runtime_id FROM pg_roles WHERE rolname='app_user';
 FOR relation IN SELECT oid,relname,relowner,relacl FROM pg_class WHERE oid=ANY(evidence_ids) LOOP
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',relation.relname);
  FOR recipient IN SELECT DISTINCT role.rolname
   FROM aclexplode(coalesce(relation.relacl,acldefault('r',relation.relowner))) a
   JOIN pg_roles role ON role.oid=a.grantee
   WHERE a.grantee<>relation.relowner AND a.grantee IS DISTINCT FROM runtime_id LOOP
   EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',relation.relname,recipient.rolname);
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=ANY(evidence_ids) AND
  EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   WHERE a.grantor<>c.relowner OR a.is_grantable OR a.grantee<>c.relowner AND NOT coalesce(
    a.grantee=runtime_id AND a.privilege_type IN('SELECT','INSERT','UPDATE','DELETE'),false)))
 THEN RAISE EXCEPTION 'Legacy publication privilege repair left unexpected evidence ACL';END IF;
END $legacy_publication_privileges$;
COMMIT;
