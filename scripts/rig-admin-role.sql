-- [COMP:platform/local-rig] Maintained fixture installation, never product authority.
-- The migrator role owns all objects; neither runtime role may own or inherit one.
\if :prepare
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_user') THEN
  IF to_regclass('public._migrations') IS NOT NULL THEN
   IF EXISTS(SELECT FROM public._migrations) THEN
    RAISE EXCEPTION 'Migrated administrative fixture lacks canonical role; preserve it and use a new fixture port';
   END IF;
  END IF;
  CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='app_user' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolcanlogin)) THEN
  RAISE EXCEPTION 'Unsafe canonical fixture role';
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO app_user;
-- Baseline privileges precede migration-specific REVOKEs, which must survive.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO app_user;
\else
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_user') THEN RAISE EXCEPTION 'Canonical role missing before ACL installation';END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='admin_fixture_app') THEN
  CREATE ROLE admin_fixture_app LOGIN PASSWORD 'fixture-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN('app_user','admin_fixture_app') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls))
 OR EXISTS(SELECT FROM pg_auth_members WHERE roleid IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user','admin_fixture_app')) OR member IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user','admin_fixture_app')))
 OR EXISTS(SELECT FROM pg_class WHERE relowner IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user','admin_fixture_app')))
 OR EXISTS(SELECT FROM pg_proc WHERE proowner IN(SELECT oid FROM pg_roles WHERE rolname IN('app_user','admin_fixture_app'))) THEN
  RAISE EXCEPTION 'Fixture runtime role has unsafe privileges, membership or object ownership';
 END IF;
END $$;
-- Migration bookkeeping is never an application/runtime surface.
DO $$ BEGIN IF to_regclass('public._migrations') IS NOT NULL THEN REVOKE ALL ON public._migrations FROM app_user; END IF; END $$;
ALTER ROLE admin_fixture_app SET app.current_user_id='00000000-0000-0000-0000-000000000000';
DO $$ DECLARE entry record;BEGIN
 -- Mirror explicit schema/table/sequence ACLs after all migration revocations.
 REVOKE ALL ON SCHEMA public FROM admin_fixture_app;
 FOR entry IN SELECT a.privilege_type FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
  JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname='public' AND r.rolname='app_user' LOOP
  EXECUTE format('GRANT %s ON SCHEMA public TO admin_fixture_app',entry.privilege_type);
 END LOOP;
 FOR entry IN SELECT c.oid,c.relkind,c.oid::regclass AS relation FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f','S') LOOP
  EXECUTE format('REVOKE ALL ON %s %s FROM admin_fixture_app',CASE WHEN entry.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,entry.relation);
 END LOOP;
 FOR entry IN SELECT c.oid::regclass AS relation,c.relkind,a.privilege_type FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee
  WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f','S') AND r.rolname='app_user' LOOP
  EXECUTE format('GRANT %s ON %s %s TO admin_fixture_app',entry.privilege_type,CASE WHEN entry.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,entry.relation);
 END LOOP;
 -- Column grants require an explicit extension of this installer, never silent drift.
 IF EXISTS(SELECT FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL aclexplode(a.attacl) acl JOIN pg_roles r ON r.oid=acl.grantee
  WHERE n.nspname='public' AND r.rolname IN('app_user','admin_fixture_app')) THEN RAISE EXCEPTION 'Unexpected column-specific fixture ACL';END IF;
END $$;
-- Exact explicit migration-declared grants, never an ALL FUNCTIONS allow.
DO $$ DECLARE entry record;BEGIN
 FOR entry IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM admin_fixture_app',entry.signature);
 END LOOP;
 FOR entry IN SELECT DISTINCT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid=a.grantee
 WHERE n.nspname='public' AND r.rolname='app_user' AND a.privilege_type='EXECUTE' LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO admin_fixture_app',entry.signature);
 END LOOP;
 IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND has_function_privilege('admin_fixture_app',p.oid,'EXECUTE') IS DISTINCT FROM has_function_privilege('app_user',p.oid,'EXECUTE')) THEN
  RAISE EXCEPTION 'Canonical and fixture function execution privileges differ';
 END IF;
END $$;
COMMIT;
\endif
