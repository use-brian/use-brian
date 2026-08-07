import dotenv from 'dotenv'
import { resolve } from 'node:path'

// Load .env from monorepo root
dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '.env') })
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { orderMigrationFiles } from './migration-order.js'
import { findAppliedMigrationRenames } from './migration-renames.js'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const client = new pg.Client({ connectionString: DATABASE_URL })

async function migrate() {
  await client.connect()

  // Create migrations tracking table if it doesn't exist
  await client.query(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  // Get already-applied migrations
  const { rows: applied } = await client.query('SELECT name FROM public._migrations ORDER BY name')
  const appliedSet = new Set(applied.map((r) => r.name))

  // A released migration was renamed to resolve sequence collisions. Preserve
  // both ledger identities so upgraded databases do not rerun identical DDL,
  // while an older release can still recognize the migration after rollback.
  for (const { previousName, currentName } of findAppliedMigrationRenames(appliedSet)) {
    await client.query(
      `INSERT INTO public._migrations (name, applied_at)
       SELECT $2, applied_at FROM public._migrations WHERE name = $1
       ON CONFLICT (name) DO NOTHING`,
      [previousName, currentName],
    )
    appliedSet.add(currentName)
    console.log(`  alias: ${previousName} -> ${currentName}`)
  }

  // Migration source dirs. The open submodule's own migrations dir is always
  // included; the platform injects its closed overlay dir(s) via
  // MIGRATION_DIRS. All dirs' files are merged into a single name-sorted
  // sequence below — never applied dir-by-dir. Local/standalone boot leaves
  // MIGRATION_DIRS unset → open-only. The open runner never imports a closed
  // path; the overlay dir is supplied as config (oss-local-brain-wedge.md §10).
  const openDir = join(import.meta.dirname, '..', 'migrations')
  const extraDirs = (process.env.MIGRATION_DIRS ?? '')
    .split(/[:,]/)
    .map((d) => d.trim())
    .filter(Boolean)
  const dirs = [openDir, ...extraDirs]

  // Edition signal for OSS-only migrations. The hosted tier injects its closed
  // overlay dir(s) via MIGRATION_DIRS; OSS/standalone leaves it unset. A
  // migration whose table is owned by the closed overlay in hosted but must be
  // created for OSS guards its body on `current_setting('app.migration_edition')`
  // — see 280_oss_connectors.sql. Session-level (is_local=false) so it persists
  // across every file on this one migrate connection. Unset second arg → the
  // migration treats it as not-oss and no-ops, which is the safe default.
  const migrationEdition = extraDirs.length > 0 ? 'hosted' : 'oss'
  await client.query(`SELECT set_config('app.migration_edition', $1, false)`, [migrationEdition])

  // Merge every dir's files into ONE global name-sorted sequence before
  // applying. Applying dir-by-dir breaks a fresh hosted bootstrap: an open
  // post-baseline migration can ALTER a table the overlay baseline creates
  // (e.g. 285 vs 000_overlay_v1). Filenames are globally unique across dirs
  // by convention; orderMigrationFiles enforces that and sorts.
  const ordered = orderMigrationFiles(
    await Promise.all(
      dirs.map(async (dir) => ({ dir, files: await readdir(dir) })),
    ),
  )

  let count = 0
  for (const { dir, file } of ordered) {
    if (appliedSet.has(file)) {
      console.log(`  skip: ${file} (already applied)`)
      continue
    }
    const sql = await readFile(join(dir, file), 'utf-8')
    console.log(`  apply: ${file}`)
    // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. The
    // node-postgres simple-query protocol wraps a MULTI-statement string in an
    // implicit transaction, so a file with several CONCURRENTLY statements (e.g.
    // 139_hnsw_indexes.sql) fails with 25001 even though it has no BEGIN/COMMIT.
    // For such files (CONCURRENTLY present, no explicit BEGIN — they are plain
    // index DDL, never dollar-quoted bodies), send each statement on its own so
    // none is implicitly transaction-wrapped. All other files keep the single
    // batched query (preserves dollar-quoted functions + explicit BEGIN/COMMIT).
    if (/concurrently/i.test(sql) && !/^\s*BEGIN/im.test(sql)) {
      // Strip comments BEFORE splitting on `;` — a `--` comment can itself
      // contain a literal `;` (139's "...no embedding column; episode..."),
      // which a naive split would slice into invalid SQL. These CONCURRENTLY
      // index files have no string/dollar-quoted bodies, so comment-stripping
      // then `;`-splitting is safe.
      const statements = sql
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/--[^\n]*/g, '') // line comments
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
      for (const stmt of statements) {
        await client.query(stmt)
      }
    } else {
      await client.query(sql)
    }
    await client.query('INSERT INTO public._migrations (name) VALUES ($1)', [file])
    appliedSet.add(file)
    count++
  }

  if (count === 0) {
    console.log('No new migrations to apply.')
  } else {
    console.log(`Applied ${count} migration(s).`)
  }

  await client.end()
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
