/** Embedded bootstrap precedes owner migrations. [COMP:api/migration-owner-role] */
import { PGlite } from '@electric-sql/pglite'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { preparePgliteRuntimeRole } from '../migrate-pglite.js'

describe('[COMP:api/migration-owner-role] embedded runtime bootstrap', () => {
  it('prepares a restricted fresh role and preserves an existing migrated role without replaying grants', async () => {
    const db = new PGlite()
    await db.waitReady
    try {
      await preparePgliteRuntimeRole(db)
      assert.deepEqual((await db.query(`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls
        FROM pg_roles WHERE rolname='app_user'`)).rows,
      [{rolcanlogin:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolbypassrls:false}])
      await db.exec('CREATE TABLE bootstrap_probe(id integer); CREATE SEQUENCE bootstrap_sequence')
      assert.deepEqual((await db.query(`SELECT has_table_privilege('app_user','bootstrap_probe','SELECT') AS table_access,
        has_sequence_privilege('app_user','bootstrap_sequence','USAGE') AS sequence_access`)).rows,
      [{table_access:true,sequence_access:true}])
      await db.exec(`CREATE TABLE _migrations(name text PRIMARY KEY); INSERT INTO _migrations VALUES('fixture_checkpoint.sql');
        REVOKE SELECT ON bootstrap_probe FROM app_user;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM app_user;`)
      const defaults=(await db.query('SELECT defaclobjtype,defaclacl::text FROM pg_default_acl ORDER BY oid')).rows
      await preparePgliteRuntimeRole(db)
      await preparePgliteRuntimeRole(db)
      assert.deepEqual((await db.query("SELECT has_table_privilege('app_user','bootstrap_probe','SELECT') AS allowed")).rows,[{allowed:false}])
      assert.deepEqual((await db.query('SELECT defaclobjtype,defaclacl::text FROM pg_default_acl ORDER BY oid')).rows,defaults)
    } finally { await db.close() }
  })

  it('preserves an existing migrated brain with a missing runtime role and refuses bootstrap', async () => {
    const db = new PGlite()
    await db.waitReady
    try {
      await db.exec("CREATE TABLE _migrations(name text PRIMARY KEY); INSERT INTO _migrations VALUES('fixture_checkpoint.sql')")
      await assert.rejects(preparePgliteRuntimeRole(db),/applied migrations but no app_user role/)
      assert.deepEqual((await db.query("SELECT rolname FROM pg_roles WHERE rolname='app_user'")).rows,[])
      assert.deepEqual((await db.query('SELECT name FROM _migrations')).rows,[{name:'fixture_checkpoint.sql'}])
      assert.deepEqual((await db.query('SELECT oid FROM pg_default_acl')).rows,[])
    } finally { await db.close() }
  })

  for (const [name,change] of [
    ['elevated attributes','ALTER ROLE app_user BYPASSRLS'],
    ['role membership','CREATE ROLE fixture_parent; GRANT fixture_parent TO app_user'],
    ['object ownership','CREATE TABLE owned_probe(id integer); ALTER TABLE owned_probe OWNER TO app_user'],
  ]) it(`refuses ${name} before changing an existing role`, async () => {
    const db = new PGlite()
    await db.waitReady
    try {
      await db.exec('CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS')
      await db.exec(change)
      await assert.rejects(preparePgliteRuntimeRole(db),/unsafe privileges, membership or object ownership/)
      assert.deepEqual((await db.query('SELECT oid FROM pg_default_acl')).rows,[])
    } finally { await db.close() }
  })
})
