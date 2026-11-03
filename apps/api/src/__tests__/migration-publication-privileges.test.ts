/** [COMP:api/migration-owner-role] Upgrade after deployment re-grants debug SELECT. */
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { toPgliteMigrationSql } from '@use-brian/api/migrations/pglite-sql.js'
import { migratePglite, preparePgliteRuntimeRole } from '../migrate-pglite.js'

const migrationsDir = fileURLToPath(new URL('../../../../packages/api/migrations', import.meta.url))
const repair = '81941_legacy_publication_privileges.sql'
const blocked = '8195_native_publication_invalidation_contract.sql'
const tables = [
  'native_turn_frames',
  'native_turn_publication_work',
  'native_turn_publication_events',
  'native_turn_publication_seals',
  'native_turn_publication_impossible',
  'native_turn_publication_debt',
  'native_turn_contract_helpers',
]
const evidenceTables = ['scope_derivations', 'scope_derivation_sources']

it('[COMP:api/migration-owner-role] repairs publication grants without accepting structural drift', async () => {
  const db = new PGlite({ extensions: { vector, pg_trgm } })
  await db.waitReady
  try {
    await preparePgliteRuntimeRole(db)
    await db.exec(`CREATE EXTENSION IF NOT EXISTS vector;
      CREATE ROLE migration_owner NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE "brian-debug" NOLOGIN;
      UPDATE pg_extension SET extowner='migration_owner'::regrole WHERE extname='vector';
      ALTER SCHEMA public OWNER TO migration_owner;
      GRANT CREATE ON DATABASE postgres TO migration_owner;
      SET ROLE migration_owner;`)
    await preparePgliteRuntimeRole(db)
    await migratePglite(db, migrationsDir, { through: '8190_native_turn_query_contract.sql' })
    const repairSql = toPgliteMigrationSql(await readFile(`${migrationsDir}/${repair}`, 'utf8'), repair)
    const blockedSql = toPgliteMigrationSql(await readFile(`${migrationsDir}/${blocked}`, 'utf8'), blocked)
    const snapshot = async () => ({
      tables: (await db.query(`SELECT to_jsonb(c)-'relacl' AS metadata FROM pg_class c
        WHERE oid=ANY($1::regclass[]) ORDER BY oid`, [[...tables, ...evidenceTables]])).rows,
      functions: (await db.query(`SELECT to_jsonb(p) AS metadata FROM pg_proc p
        WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows,
    })
    const before = await snapshot()
    // Reproduce the actual legacy runtime + debug setup, not just grants on
    // the first six failing tables: later guards also pin reader/evidence ACLs.
    await db.exec(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO app_user;
      GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO "brian-debug";
      REVOKE ALL ON TABLE public.application_native_module_lifecycle_reviews FROM app_user,"brian-debug";`)
    for (const table of tables.filter(name => name !== 'native_turn_contract_helpers')) {
      await db.exec(`REVOKE ALL ON TABLE public.${table} FROM app_user`)
    }
    await db.exec('GRANT SELECT ON TABLE public.native_turn_frames TO PUBLIC')
    // The queue-only repair has already run, exactly as in the deployment log.
    await migratePglite(db, migrationsDir, { through: '81940_legacy_queue_privileges.sql' })
    await assert.rejects(db.transaction(tx => tx.exec(blockedSql)), /native_annotation_publication_table_changed/)
    assert.equal(await migratePglite(db, migrationsDir, { through: repair }), 1)
    assert.deepEqual(await snapshot(), before)
    assert.deepEqual((await db.query(`SELECT c.relname FROM pg_class c
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=ANY($1::regclass[])
      AND (a.grantee<>c.relowner OR a.grantor<>c.relowner OR a.is_grantable)`, [tables])).rows, [])
    for (const table of evidenceTables) {
      assert.deepEqual((await db.query(`SELECT a.privilege_type FROM pg_class c
        CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=$1::regclass
        AND a.grantee<>c.relowner ORDER BY a.privilege_type`, [table])).rows,
      ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map(privilege_type => ({ privilege_type })))
      assert.equal((await db.query<{ allowed: boolean }>(`SELECT bool_and(
        has_table_privilege('app_user',$1,privilege)) AS allowed
        FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) privilege`, [table])).rows[0].allowed, true)
      assert.equal((await db.query<{ allowed: boolean }>(`SELECT has_table_privilege('brian-debug',$1,'SELECT') AS allowed`, [table])).rows[0].allowed, false)
    }
    const repaired = (await db.query(`SELECT to_jsonb(c) AS metadata FROM pg_class c
      WHERE oid=ANY($1::regclass[]) ORDER BY oid`, [tables])).rows
    await db.transaction(tx => tx.exec(repairSql))
    assert.deepEqual((await db.query(`SELECT to_jsonb(c) AS metadata FROM pg_class c
      WHERE oid=ANY($1::regclass[]) ORDER BY oid`, [tables])).rows, repaired)
    assert.equal(await migratePglite(db, migrationsDir, { through: repair }), 0)
    // Repair only ACLs: independent structural authentication must still fail.
    await db.exec('ALTER TABLE public.native_turn_publication_work DISABLE ROW LEVEL SECURITY')
    await assert.rejects(migratePglite(db, migrationsDir, { through: blocked }), /native_annotation_publication_table_changed/)
    assert.deepEqual((await db.query('SELECT name FROM _migrations WHERE name=$1', [blocked])).rows, [])
    await db.exec('ALTER TABLE public.native_turn_publication_work ENABLE ROW LEVEL SECURITY')
    await migratePglite(db, migrationsDir)
    assert.deepEqual((await db.query('SELECT name FROM _migrations WHERE name=$1', [blocked])).rows, [{ name: blocked }])
    const installed = await snapshot()
    // Re-executing a historical repair must not invalidate newer manifest pins.
    await db.transaction(tx => tx.exec(repairSql))
    assert.deepEqual(await snapshot(), installed)
  } finally {
    await db.close()
  }
})
