import dotenv from 'dotenv'
import { resolve } from 'node:path'

// Load .env from monorepo root
dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '.env') })
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'

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

  // Ordered migration source dirs. The open submodule's own migrations
  // (open-schema-v1 baseline + any post-squash open migrations) apply first;
  // the platform injects its closed overlay dir(s) via MIGRATION_DIRS so the
  // hosted tier runs open-then-overlay. Local/standalone boot leaves
  // MIGRATION_DIRS unset → open-only. The open runner never imports a closed
  // path; the overlay dir is supplied as config (oss-local-brain-wedge.md §10).
  const openDir = join(import.meta.dirname, '..', 'migrations')
  const extraDirs = (process.env.MIGRATION_DIRS ?? '')
    .split(/[:,]/)
    .map((d) => d.trim())
    .filter(Boolean)
  const dirs = [openDir, ...extraDirs]

  let count = 0
  for (const dir of dirs) {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) {
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
