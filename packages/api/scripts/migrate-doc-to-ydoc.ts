/**
 * Hard-cutover data migration: convert every legacy block-JSON doc page
 * (`saved_views.page`) into an initial Y.Doc row in `documents`.
 *
 * Idempotent — only converts rows that don't already have a `documents`
 * row (LEFT JOIN ... IS NULL). The pure converter lives in
 * `src/db/doc-migration.ts` (unit-tested); this is the DB driver.
 *
 *   --dry-run            convert in-memory + assert round-trip; write nothing
 *   --verify             re-decode existing documents.ydoc vs saved_views.page
 *   --workspace=<uuid>   scope to one workspace (staged rollout)
 *   --limit=<n>          cap the batch
 *
 * Run: pnpm migrate:doc-ydoc -- --dry-run
 */

import dotenv from 'dotenv'
import { resolve } from 'node:path'
dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '.env') })

import pg from 'pg'
import type { Page } from '@use-brian/core/dist/views/blocks.js'
import { snapshotFromUpdate, canonicalizePage } from '@use-brian/doc-model'
import { convertPageToDocRow, runSelfTest } from '../src/db/doc-migration.js'

const args = process.argv.slice(2)
const has = (f: string) => args.includes(f)
const valueOf = (k: string): string | undefined =>
  args.find((a) => a.startsWith(`${k}=`))?.split('=')[1]

const DRY_RUN = has('--dry-run')
const VERIFY = has('--verify')
const workspace = valueOf('--workspace')
const limit = valueOf('--limit')

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

type Row = { id: string; name: string | null; page: Page | null }

async function main(): Promise<void> {
  // Always self-test the 16-kind round-trip so the run demonstrably exercises
  // every block kind even when the local DB has no doc pages.
  const self = runSelfTest()
  console.log(
    `[self-test] 16-kind round-trip: idsPreserved=${self.idsPreserved} roundTripOk=${self.roundTripOk}`,
  )
  if (!self.ok) {
    console.error('[self-test] FAILED — aborting before touching the database')
    process.exit(1)
  }

  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    if (VERIFY) return await verify(client)

    const params: unknown[] = []
    let where = 'sv.page IS NOT NULL AND cd.page_id IS NULL'
    if (workspace) {
      params.push(workspace)
      where += ` AND sv.workspace_id = $${params.length}`
    }
    let sql = `
      SELECT sv.id, sv.name, sv.page
      FROM saved_views sv
      LEFT JOIN documents cd ON cd.page_id = sv.id
      WHERE ${where}
      ORDER BY sv.created_at`
    if (limit) sql += ` LIMIT ${parseInt(limit, 10)}`

    const { rows } = await client.query<Row>(sql, params)
    console.log(`[migrate] ${rows.length} page(s) to convert${DRY_RUN ? ' (dry-run)' : ''}`)

    let converted = 0
    let skipped = 0
    let warned = 0
    for (const row of rows) {
      const page: Page = row.page ?? { blocks: [] }
      const result = convertPageToDocRow(page, row.name ?? '')

      if (!result.idsPreserved) {
        console.error(`  ✗ ${row.id} — block ids NOT preserved; skipping (manual review)`)
        skipped++
        continue
      }
      if (!result.roundTripOk) {
        console.warn(`  ⚠ ${row.id} — round-trip differs from canonical (still converting)`)
        warned++
      }

      if (DRY_RUN) {
        converted++
        continue
      }

      await client.query(
        `INSERT INTO documents (page_id, ydoc, snapshot_json, snapshot_title, seq, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, 1, now())
         ON CONFLICT (page_id) DO NOTHING`,
        [row.id, result.ydoc, result.snapshotJson, result.title],
      )
      converted++
    }

    console.log(
      `[migrate] done — converted=${converted} skipped=${skipped} warned=${warned}${DRY_RUN ? ' (no writes)' : ''}`,
    )
    if (skipped > 0) process.exitCode = 2
  } finally {
    await client.end()
  }
}

async function verify(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ id: string; page: Page | null; ydoc: Buffer }>(
    `SELECT sv.id, sv.page, cd.ydoc
     FROM documents cd JOIN saved_views sv ON sv.id = cd.page_id
     WHERE cd.ydoc IS NOT NULL`,
  )
  let ok = 0
  let bad = 0
  for (const row of rows) {
    const decoded = snapshotFromUpdate(new Uint8Array(row.ydoc))
    const expected = canonicalizePage(row.page ?? { blocks: [] })
    const ids = decoded.page.blocks.map((b) => b.id)
    const expectedIds = (row.page?.blocks ?? []).map((b) => b.id)
    const idsOk =
      expectedIds.length === 0 || JSON.stringify(ids) === JSON.stringify(expectedIds)
    const shapeOk = JSON.stringify(decoded.page) === JSON.stringify(expected)
    if (idsOk && shapeOk) ok++
    else {
      bad++
      console.error(`  ✗ ${row.id} — verify mismatch (idsOk=${idsOk} shapeOk=${shapeOk})`)
    }
  }
  console.log(`[verify] ok=${ok} bad=${bad}`)
  if (bad > 0) process.exitCode = 2
}

main().catch((err) => {
  console.error('migrate-doc-to-ydoc failed:', err)
  process.exit(1)
})
