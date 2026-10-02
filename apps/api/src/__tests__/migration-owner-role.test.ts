/**
 * Executed proof that the OSS migration chain runs as an ordinary owner role.
 *
 * The self-host recipe creates the migrating role with a plain `createuser`,
 * and a managed Postgres owner is not a superuser either. Every other replay
 * in this suite runs as the embedded superuser, which is why a superuser-only
 * statement can pass them all and still stop a deploy at that file.
 *
 * Spec: docs/architecture/platform/database-schema.md -> "A migration runs as
 * an ordinary owner role".
 *
 * [COMP:api/migration-owner-role]
 */

import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { migratePglite } from '../migrate-pglite.js'

const migrationsDir = fileURLToPath(
  new URL('../../../../packages/api/migrations', import.meta.url),
)

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000f1'
const SKILL_ID = '00000000-0000-4000-8000-0000000000b1'
const DEPARTMENT = 'team:00000000-0000-4000-8000-0000000000d1'

/** A database provisioned the way the self-host recipe leaves it. */
async function openAsOwner(): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector, pg_trgm } })
  await db.waitReady
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE ROLE migration_owner NOSUPERUSER NOBYPASSRLS;
    UPDATE pg_extension
       SET extowner = (SELECT oid FROM pg_authid WHERE rolname = 'migration_owner')
     WHERE extname = 'vector';
    ALTER SCHEMA public OWNER TO migration_owner;
    GRANT CREATE ON DATABASE postgres TO migration_owner;
    SET ROLE migration_owner;
  `)
  return db
}

async function assertOrdinaryOwner(db: PGlite): Promise<void> {
  assert.deepEqual(
    (await db.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows,
    [{ rolsuper: false, rolbypassrls: false }],
  )
}

async function assertNothingLeftBypassed(db: PGlite): Promise<void> {
  assert.deepEqual(
    (await db.query(
      `SELECT tgrelid::regclass::text AS "table", tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgenabled <> 'O'`,
    )).rows,
    [],
  )
  assert.deepEqual(
    (await db.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.workspace_skill_scope_revisions'::regclass`,
    )).rows,
    [{ relforcerowsecurity: true }],
  )
}

describe('[COMP:api/migration-owner-role] Migrations run as an ordinary owner role', () => {
  it('replays the whole chain from empty without a superuser', async () => {
    const db = await openAsOwner()
    try {
      // One connection for every file, so the baseline's row_security = off
      // is still in force when the later data-rewriting migrations run.
      assert.ok((await migratePglite(db, migrationsDir)) > 0)
      assert.equal(await migratePglite(db, migrationsDir), 0)
      await assertOrdinaryOwner(db)
      await assertNothingLeftBypassed(db)
    } finally {
      await db.close()
    }
  })

  it('relabels free-form compartments on upgrade, bypassing triggers and restoring them', async () => {
    const db = await openAsOwner()
    try {
      await migratePglite(db, migrationsDir, { through: '649_department_read_policy.sql' })

      // Seed the pre-cutover state. Only this disposable fixture skips the
      // write guards; the migration under test runs as the owner below.
      await db.exec('RESET ROLE')
      await db.exec(`
        BEGIN;
        SET LOCAL session_replication_role = replica;
        INSERT INTO tasks (title, workspace_id, compartments, updated_at) VALUES
          ('mixed', '${WORKSPACE_ID}', ARRAY['legal', '${DEPARTMENT}'], '2020-01-01Z'),
          ('free-form only', '${WORKSPACE_ID}', ARRAY['hr'], '2020-01-01Z'),
          ('department only', '${WORKSPACE_ID}', ARRAY['${DEPARTMENT}'], '2020-01-01Z');
        INSERT INTO workspace_skill_scope_revisions
          (workspace_id, skill_id, revision, sensitivity, compartments, project_ids, scope_held) VALUES
          ('${WORKSPACE_ID}', '${SKILL_ID}', 1, 'internal', ARRAY['legal', '${DEPARTMENT}'], '{}', false),
          ('${WORKSPACE_ID}', '${SKILL_ID}', 2, 'internal', ARRAY['hr'], '{}', true);
        COMMIT;
      `)
      const versionsBefore = (await db.query(
        'SELECT title, scope_version FROM tasks ORDER BY title',
      )).rows

      // An upgrade arrives on a new connection, where row security is on and
      // a forced table filters its owner instead of refusing the statement.
      await db.exec('SET ROLE migration_owner; SET row_security = on;')
      await assertOrdinaryOwner(db)
      assert.ok((await migratePglite(db, migrationsDir)) > 0)
      await assertNothingLeftBypassed(db)

      await db.exec('RESET ROLE')
      assert.deepEqual(
        (await db.query(
          `SELECT title, compartments, updated_at = '2020-01-01Z' AS untouched
             FROM tasks ORDER BY title`,
        )).rows,
        [
          { title: 'department only', compartments: [DEPARTMENT], untouched: true },
          { title: 'free-form only', compartments: [], untouched: true },
          { title: 'mixed', compartments: [DEPARTMENT], untouched: true },
        ],
      )
      assert.deepEqual(
        (await db.query('SELECT title, scope_version FROM tasks ORDER BY title')).rows,
        versionsBefore,
      )
      // The forced table, including the held row its read policy hides.
      assert.deepEqual(
        (await db.query(
          'SELECT revision::int AS revision, compartments FROM workspace_skill_scope_revisions ORDER BY revision',
        )).rows,
        [
          { revision: 1, compartments: [DEPARTMENT] },
          { revision: 2, compartments: [] },
        ],
      )
    } finally {
      await db.close()
    }
  })
})
