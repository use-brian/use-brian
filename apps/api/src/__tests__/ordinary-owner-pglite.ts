/**
 * [COMP:api/migration-owner-role] Ordinary-owner embedded fixture for full-chain suites.
 *
 * Migration 8274 admits only an ordinary owner (no SUPERUSER, no BYPASSRLS) and
 * refuses a superuser-run chain with `installation_runtime_role_unsafe`. Suites that
 * replay the complete chain therefore migrate the way the self-host recipe leaves a
 * database: app_user prepared first, then a plain owner of `public`. The bootstrap
 * superuser only provisions roles and seeds disposable fixture rows.
 *
 * Spec: docs/architecture/platform/database-schema.md -> "A migration runs as an
 * ordinary owner role".
 */
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'
import { preparePgliteRuntimeRole } from '../migrate-pglite.js'

const ORDINARY_OWNER = 'migration_owner'

/** A fresh database whose session role is the ordinary migration owner. */
export async function openOrdinaryOwnerPglite(): Promise<PGlite> {
  const db = new PGlite({ extensions: { vector, pg_trgm } })
  await db.waitReady
  await preparePgliteRuntimeRole(db)
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE ROLE ${ORDINARY_OWNER} NOSUPERUSER NOBYPASSRLS;
    UPDATE pg_extension
       SET extowner = (SELECT oid FROM pg_authid WHERE rolname = '${ORDINARY_OWNER}')
     WHERE extname = 'vector';
    ALTER SCHEMA public OWNER TO ${ORDINARY_OWNER};
    GRANT CREATE ON DATABASE postgres TO ${ORDINARY_OWNER};
    SET ROLE ${ORDINARY_OWNER};
  `)
  await preparePgliteRuntimeRole(db)
  return db
}

/** Run disposable fixture setup in the bootstrap session, then return to the owner. */
export async function asBootstrap<T>(db: PGlite, run: () => Promise<T>): Promise<T> {
  await db.exec('RESET ROLE')
  try { return await run() } finally { await db.exec(`SET ROLE ${ORDINARY_OWNER}`) }
}
