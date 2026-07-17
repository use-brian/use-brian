import type { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const migrationRuns = new WeakMap<PGlite, Promise<void>>()
const OSS_CHANNELS_330 = '330_oss_channels.sql'
const OSS_CHANNELS_330_SHA256 = '64aeddde4c05bd186b638be0b0c02f477dd16afb20358c00446b2e9d0d739c1e'

function withoutOuterTransaction(sql: string, file: string): string {
  const begins = sql.match(/^BEGIN;\s*$/gm)?.length ?? 0
  const commits = sql.match(/^COMMIT;\s*$/gm)?.length ?? 0
  if (begins === 0 && commits === 0) return sql
  if (begins !== 1 || commits !== 1) {
    throw new Error(`${file}: expected one outer BEGIN/COMMIT pair`)
  }
  return sql.replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '')
}

/**
 * Apply the open migration baseline (+ any post-squash open migrations) to an
 * embedded PGLite brain. Local boot is OPEN-ONLY — no closed overlay.
 *
 * Each file and its `_migrations` row commit atomically in one runner-owned
 * transaction. Outer BEGIN/COMMIT wrappers are removed before execution. The
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

    const [ddl, seedRaw = ''] = sql.split('-- Seed data')
    const applied = await db.transaction(async (tx) => {
      const existing = await tx.query<{ name: string }>('SELECT name FROM public._migrations WHERE name = $1', [file])
      if (existing.rows.length > 0) return false

      await tx.exec(withoutOuterTransaction(ddl, file))
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
