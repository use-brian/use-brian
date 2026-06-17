/**
 * Repair script — inserts missing `_migrations` tracker rows for migrations
 * whose schema changes are already live on the database but were never
 * recorded (manual apply, partial failure, etc.).
 *
 * Reads `DATABASE_URL` from env the same way `migrate.ts` does, so the prod
 * flow via Cloud SQL Proxy works unchanged:
 *
 *   RAW_URL=$(gcloud secrets versions access latest --secret=DATABASE_URL --project=internal-process-490404) && \
 *   LOCAL_URL=$(echo "$RAW_URL" | sed -E 's|@/sidanclaw\?host=/cloudsql/[^&]+|@127.0.0.1:5433/sidanclaw|') && \
 *   DATABASE_URL="$LOCAL_URL" pnpm --filter @sidanclaw/api exec tsx scripts/repair-migrations-tracker.ts
 *
 * The script is idempotent — `ON CONFLICT DO NOTHING` on the `(name)` PK.
 */

import dotenv from 'dotenv'
import { resolve } from 'node:path'

dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '.env') })

import pg from 'pg'

// Which migration filenames to mark as applied. Schema-only drift — no DDL
// runs; we're only updating the tracker so subsequent `pnpm migrate` calls
// don't retry these and crash with "already exists"/"does not exist".
//
// Accepts extra names via argv (e.g. `tsx repair-migrations-tracker.ts
// 083_foo.sql 084_bar.sql`) so a single run can clear multiple drifts.
const TO_MARK = [
  '081_assistant_app_type.sql',
  '082_knowledge_entries_team_scope.sql',
  ...process.argv.slice(2),
]

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()

  try {
    // Ensure the tracker table exists (mirrors migrate.ts behavior).
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    // Show existing state near the window we care about, for sanity.
    const before = await client.query<{ name: string }>(
      `SELECT name FROM _migrations WHERE name >= '079' AND name <= '095' ORDER BY name`,
    )
    console.log('Before repair — _migrations rows in window (079-095):')
    for (const row of before.rows) console.log(`  ${row.name}`)

    for (const name of TO_MARK) {
      const res = await client.query(
        `INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING name`,
        [name],
      )
      if (res.rowCount === 0) {
        console.log(`  skip: ${name} (already in tracker)`)
      } else {
        console.log(`  mark: ${name}`)
      }
    }

    const after = await client.query<{ name: string }>(
      `SELECT name FROM _migrations WHERE name >= '079' AND name <= '095' ORDER BY name`,
    )
    console.log('\nAfter repair — _migrations rows in window (079-095):')
    for (const row of after.rows) console.log(`  ${row.name}`)
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
