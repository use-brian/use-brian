import type { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { toPgliteMigrationSql } from '@use-brian/api/migrations/pglite-sql.js'

const migrationRuns = new WeakMap<PGlite, Promise<void>>()
const OSS_CHANNELS_330 = '330_oss_channels.sql'
const OSS_CHANNELS_330_SHA256 = '64aeddde4c05bd186b638be0b0c02f477dd16afb20358c00446b2e9d0d739c1e'

function concurrentIndexStatements(sql: string): string[] | null {
  if (!/concurrently/i.test(sql) || /^\s*BEGIN/im.test(sql)) return null
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
}

/**
 * Apply the open migration baseline (+ any post-squash open migrations) to an
 * embedded PGLite brain. Local boot is OPEN-ONLY — no closed overlay.
 *
 * Each ordinary file and its `_migrations` row commit atomically in one
 * runner-owned transaction. Outer BEGIN/COMMIT wrappers are removed before
 * execution. `CREATE INDEX CONCURRENTLY` files are the deliberate exception:
 * PostgreSQL and PGLite reject those statements inside a transaction, so the
 * runner applies their idempotent statements one at a time and records the
 * file afterwards. The
 * squash separates schema from seed rows with a `-- Seed data` marker (see
 * `000_open_schema_v1.sql`); its DDL runs in one exec and each seed INSERT in a
 * separate exec inside that same transaction. Calls sharing a PGlite instance
 * are serialized and each file re-checks the ledger after entering its
 * transaction, so migration SQL cannot run from a stale applied-set snapshot.
 *
 * See the open-core split (repo CLAUDE.md; plan in git history) §12.7.
 */
export async function migratePglite(db: PGlite, migrationsDir: string): Promise<number> {
  const previous = migrationRuns.get(db) ?? Promise.resolve()
  const run = previous.then(() => migratePgliteExclusive(db, migrationsDir))
  migrationRuns.set(db, run.then(() => undefined, () => undefined))
  return run
}

async function migratePgliteExclusive(db: PGlite, migrationsDir: string): Promise<number> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS public._migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  )
  // Edition signal for OSS-only migrations (see 280_oss_connectors.sql). The
  // embedded PGLite path is ALWAYS the open edition, so mark it 'oss' for the
  // whole session; the node-pg runner sets the same GUC from MIGRATION_DIRS.
  await db.exec(`SELECT set_config('app.migration_edition', 'oss', false)`)
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()

  let count = 0
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')

    // Migration 326 already creates every OSS channel table. Released migration
    // 330 repeats several channels catalog updates in one transaction, which
    // native PostgreSQL accepts but PGLite rejects. Preserve 330 byte-for-byte
    // and supersede only its exact checksum after verifying 326's tables;
    // append-only migrations 331-334 apply the same shape changes safely.
    if (file === OSS_CHANNELS_330) {
      const checksum = createHash('sha256').update(sql).digest('hex')
      if (checksum !== OSS_CHANNELS_330_SHA256) {
        throw new Error(`${file}: content changed; refusing PGLite compatibility path`)
      }
      const applied = await db.transaction(async (tx) => {
        const existing = await tx.query<{ name: string }>('SELECT name FROM public._migrations WHERE name = $1', [file])
        if (existing.rows.length > 0) return false

        const tables = await tx.query<{
          channels: string | null
          integrations: string | null
          assistants: string | null
          users: string | null
        }>(
          `SELECT to_regclass('public.channels')::text AS channels,
                  to_regclass('public.channel_integrations')::text AS integrations,
                  to_regclass('public.channel_assistants')::text AS assistants,
                  to_regclass('public.channel_user_cache')::text AS users`,
        )
        const state = tables.rows[0]
        if (!state || Object.values(state).some((value) => value == null)) {
          throw new Error(`${file}: migration 326 channel tables are missing`)
        }
        await tx.query('INSERT INTO public._migrations (name) VALUES ($1)', [file])
        return true
      })
      if (applied) count++
      continue
    }

    // Match the node-postgres migration runner: concurrent indexes must be
    // separate, top-level statements. The repository's concurrent-index
    // migrations use IF NOT EXISTS, so a process crash between statements is
    // safe to resume before the ledger row is written.
    const concurrentStatements = concurrentIndexStatements(sql)
    if (concurrentStatements) {
      const existing = await db.query<{ name: string }>(
        'SELECT name FROM public._migrations WHERE name = $1',
        [file],
      )
      if (existing.rows.length > 0) continue

      for (const statement of concurrentStatements) {
        await db.exec(statement)
      }
      await db.query('INSERT INTO public._migrations (name) VALUES ($1)', [file])
      count++
      continue
    }

    const [ddl, seedRaw = ''] = sql.split('-- Seed data')
    const applied = await db.transaction(async (tx) => {
      const existing = await tx.query<{ name: string }>('SELECT name FROM public._migrations WHERE name = $1', [file])
      if (existing.rows.length > 0) return false

      await tx.exec(toPgliteMigrationSql(ddl, file))
      for (const insert of seedRaw.split('\n').filter((l) => l.trimStart().startsWith('INSERT'))) {
        await tx.exec(insert)
      }
      await tx.query('INSERT INTO public._migrations (name) VALUES ($1)', [file])
      return true
    })
    if (applied) count++
  }
  return count
}
