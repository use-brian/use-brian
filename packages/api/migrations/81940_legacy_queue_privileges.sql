BEGIN;
-- [COMP:api/migration-owner-role] Repair leftover app_user table/sequence
-- grants on private native field-dependency queues before 8195 authenticates
-- owner-only relation ACLs.
-- Sorts between 8190_ and 8195_; never rename an applied migration.
-- setup.sql / packaged PostgreSQL setup re-grant SELECT/INSERT/UPDATE/DELETE on
-- ALL TABLES and USAGE/SELECT on ALL SEQUENCES to app_user on every deploy.
-- 8158 revoked these private queue relations at creation, but the next setup
-- run restores the blanket grants. 8195 (and 8196-8201) require owner-only ACL
-- and raise native_legacy_queue_relations_changed on leftover grants.
DO $legacy_queue_privileges$
DECLARE relation record;recipient record;
BEGIN
 IF EXISTS(SELECT 1 FROM public._migrations WHERE name='8195_native_publication_invalidation_contract.sql') THEN RETURN;END IF;
 FOR relation IN SELECT oid,relname,relkind,relowner,relacl FROM pg_class
 WHERE oid IN(
  'public.native_field_dependency_batches'::regclass,
  'public.native_field_dependency_work'::regclass,
  pg_get_serial_sequence('public.native_field_dependency_work','id')::regclass) LOOP
  EXECUTE format('REVOKE ALL ON %s public.%I FROM PUBLIC',CASE WHEN relation.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,relation.relname);
  FOR recipient IN SELECT DISTINCT role.rolname FROM aclexplode(coalesce(relation.relacl,acldefault(CASE WHEN relation.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,relation.relowner))) a
   JOIN pg_roles role ON role.oid=a.grantee WHERE a.grantee<>relation.relowner LOOP
   EXECUTE format('REVOKE ALL ON %s public.%I FROM %I',CASE WHEN relation.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,relation.relname,recipient.rolname);
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=ANY(ARRAY[
  'public.native_field_dependency_batches'::regclass,
  'public.native_field_dependency_work'::regclass,
  pg_get_serial_sequence('public.native_field_dependency_work','id')::regclass]) AND
  EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
   WHERE a.grantee<>c.relowner OR a.grantor<>c.relowner OR a.is_grantable))
 THEN RAISE EXCEPTION 'Legacy queue privilege repair left non-owner ACL';END IF;
END $legacy_queue_privileges$;
COMMIT;
