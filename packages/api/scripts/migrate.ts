import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'
import { orderMigrationFiles } from './migration-order.js'
import { findAppliedMigrationRenames } from '../src/migrations/renames.js'
import { nativePageCompletionRecoverySql } from './migration-recovery.js'
import { toMigrationExecutionSql } from '../src/migrations/execution-sql.js'
import { performance } from 'node:perf_hooks'
import { MigrationDiagnostics } from './migration-diagnostics.js'

export type MigrationOptions = {
  databaseUrl: string
  migrationDirs?: string[]
  beforeApply?: (migration: { file: string; dir: string; appliedCount: number }) => Promise<void> | void
}

/** Trusted orchestration hook: callback returns cannot suppress a migration. */
export async function runMigrations({ databaseUrl, migrationDirs = [], beforeApply }: MigrationOptions) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const client = new pg.Client({ connectionString: databaseUrl })
  const started = performance.now()
  let diagnostics: MigrationDiagnostics | undefined
  let failed = false
  let lockWaitMs = 0
  console.log('[migration] connecting')
  try {
    await client.connect()
    console.log(`[migration] connected elapsed_ms=${Math.round(performance.now() - started)}`)
    const { rows: backend } = await client.query<{ pid: number }>(
      "SELECT set_config('application_name','use-brian-migrate',false),pg_backend_pid() AS pid",
    )
    diagnostics = new MigrationDiagnostics(databaseUrl, backend[0].pid)
    // Session-scoped: migration files commit independently. Serialize before
    // reading the ledger so another runner cannot retain a stale applied set.
    diagnostics.start('migration_lock')
    await client.query("SELECT pg_advisory_lock(hashtextextended('use-brian:migrations', 0))")
    lockWaitMs = diagnostics.finish('acquired')
    diagnostics.start('ledger')
    // Create migrations tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)
    diagnostics.finish()

    // Historical SQL may have committed before its separate ledger insertion.
    // Recognize only the independently authenticated, known completed boundary.
    diagnostics.start('recovery')
    await client.query(await nativePageCompletionRecoverySql())
    diagnostics.finish()

    // Get already-applied migrations after serialized recovery.
    diagnostics.start('ledger')
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
    diagnostics.finish()
    diagnostics.start('prepare')

    // Migration source dirs. The open submodule's own migrations dir is always
    // included; the platform injects its closed overlay dir(s) via
    // MIGRATION_DIRS. All dirs' files are merged into a single name-sorted
    // sequence below — never applied dir-by-dir. Local/standalone boot leaves
    // MIGRATION_DIRS unset → open-only. The open runner never imports a closed
    // path; the overlay dir is supplied as config (oss-local-brain-wedge.md §10).
    const openDir = join(import.meta.dirname, '..', 'migrations')
    const extraDirs = migrationDirs.map((dir) => resolve(dir))
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
    diagnostics.finish()

    let count = 0
    let skipped = 0
    for (const { dir, file } of ordered) {
      if (appliedSet.has(file)) {
        skipped++
        console.log(`  skip: ${file} (already applied)`)
        continue
      }
      diagnostics.start('prepare', file)
      const sql = toMigrationExecutionSql(await readFile(join(dir, file), 'utf-8'), file)
      await beforeApply?.({ file, dir, appliedCount: count })
      diagnostics.finish()
      diagnostics.start('apply', file)
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
      diagnostics.finish('applied')
      appliedSet.add(file)
      count++
    }

    if (count === 0) {
      console.log('No new migrations to apply.')
    } else {
      console.log(`Applied ${count} migration(s).`)
    }

    console.log(`[migration] complete elapsed_ms=${Math.round(performance.now() - started)} lock_wait_ms=${lockWaitMs} applied=${count} skipped=${skipped}`)
    return { appliedCount: count, edition: migrationEdition }
  } catch (error) {
    failed = true
    diagnostics?.fail(error)
    throw error
  } finally {
    await diagnostics?.stop()
    if (failed) await client.end().catch(() => {})
    else await client.end()
  }
}

async function main() {
  if (process.env.BRIAN_ASSURANCE_FIXTURE !== undefined || process.env.BRIAN_ASSURANCE_TOKEN !== undefined) {
    const fixtureModule = new URL('../../../scripts/crm/local-fixture.mjs', import.meta.url)
    const { loadMigrationEnvironment } = await import(fixtureModule.href)
    await loadMigrationEnvironment(() => { throw new Error('Fixture validation must precede environment isolation') })
  } else {
    dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '.env') })
  }
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const migrationDirs = (process.env.MIGRATION_DIRS ?? '').split(/[:,]/).map(dir => dir.trim()).filter(Boolean)
  await runMigrations({ databaseUrl, migrationDirs })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error('Migration failed:', error); process.exitCode = 1 })
}
