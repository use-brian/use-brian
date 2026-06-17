/**
 * Embedded brain DB server (OSS local boot, oss-local-brain-wedge.md §12.4/§12.7).
 *
 * PGLite is one in-process WASM instance, but the boot runs the api (4000) and
 * doc-sync (8080) as separate processes that must share one brain. This single
 * process owns the file-backed PGLite instance and serves it over the Postgres
 * wire protocol via PGLiteSocketServer, so every other process connects with a
 * plain `pg.Pool` against `DATABASE_URL` — `client.ts` is UNCHANGED (no fork).
 *
 * v0 storage lock: flat-scan, no HNSW (writes ~1ms/row; reads ~10ms at single-
 * user scale). The Postgres container is the code-identical escape hatch.
 */
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { migratePglite } from './migrate-pglite.js'

const dataDir = process.env.PGLITE_DATA_DIR || join(homedir(), '.sidanclaw', 'brain')
// Default to a distinctive high port so it never collides with a local Postgres
// on 5432; the launcher sets PGLITE_PORT explicitly.
const port = parseInt(process.env.PGLITE_PORT || '54329', 10)
// Open migrations dir, resolved relative to this file (src/ and dist/ are
// siblings under sidanclaw/apps/api, so the path is the same either way).
const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(here, '../../../packages/api/migrations')

const db = new PGlite(dataDir, { extensions: { vector, pg_trgm } })
await db.waitReady
const applied = await migratePglite(db, migrationsDir)
console.log(`[pglite] migrated ${applied} new migration(s); brain at ${dataDir}`)

const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 })
await server.start()
console.log(`[pglite] embedded brain serving on 127.0.0.1:${port}`)

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  await server.stop().catch(() => {})
  await db.close().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
