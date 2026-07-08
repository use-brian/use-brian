import type { PGlite } from '@electric-sql/pglite'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Apply the open migration baseline (+ any post-squash open migrations) to an
 * embedded PGLite brain. Local boot is OPEN-ONLY — no closed overlay.
 *
 * PGLite runs a whole multi-statement `.exec()` string as ONE implicit
 * transaction, so a large mixed DDL+DML file (the squashed baseline is ~950
 * statements) rolls back as a unit on the slightest edge. The squash separates
 * the schema from its seed rows with a `-- Seed data` marker (see
 * `000_open_schema_v1.sql`); we apply the DDL block in one `exec` and each seed
 * INSERT on its own — the verified-reliable shape. Files without the marker
 * (small future migrations) apply whole. Idempotent: tracks applied files in
 * `_migrations`, mirroring the node-pg runner (`packages/api/scripts/migrate.ts`).
 *
 * See the open-core split (repo CLAUDE.md; plan in git history) §12.7.
 */
export async function migratePglite(db: PGlite, migrationsDir: string): Promise<number> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS public._migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  )
  // Edition signal for OSS-only migrations (see 280_oss_connectors.sql). The
  // embedded PGLite path is ALWAYS the open edition, so mark it 'oss' for the
  // whole session; the node-pg runner sets the same GUC from MIGRATION_DIRS.
  await db.exec(`SELECT set_config('app.migration_edition', 'oss', false)`)
  const { rows } = await db.query<{ name: string }>('SELECT name FROM public._migrations')
  const applied = new Set(rows.map((r) => r.name))
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()

  let count = 0
  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    const [ddl, seedRaw = ''] = sql.split('-- Seed data')
    await db.exec(ddl)
    for (const insert of seedRaw.split('\n').filter((l) => l.trimStart().startsWith('INSERT'))) {
      await db.exec(insert)
    }
    await db.query('INSERT INTO public._migrations (name) VALUES ($1)', [file])
    count++
  }
  return count
}
