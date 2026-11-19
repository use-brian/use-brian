/** [COMP:api/configured-capture-authority] Functional candidate proof only.
 * The maintained pristine fixture owner installs this reviewed candidate without
 * changing native registry/pins or disabling any guard. Not an upgrade receipt. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { getPool } from '../client.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
process.env.PG_POOL_MAX='1'
const pool = getPool()
const identity = (await pool.query(`SELECT current_user AS actor,(SELECT usesuper FROM pg_user WHERE usename=current_user) AS super,
 current_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.workspaces'::regclass) AS owner`)).rows[0]
if (identity.super || !identity.owner) throw new Error('Candidate requires the unchanged ordinary fixture owner')
const before = (await pool.query('SELECT native_turn_helpers_current() AS current')).rows[0].current
if (!before) { await pool.end(); throw new Error('Pristine predecessor native helpers are not current') }
const sourceFiles=['./programmatic-intake-ready.integration.test.ts','../../workspace-access/configured-capture-authority.ts','../../ingest/programmatic-terminal.ts']
const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(new URL(file,import.meta.url))).digest('hex') ])))
const source = await readFile(new URL('../../../scripts/conversation-store/configured-task-publication.sql', import.meta.url), 'utf8')
try {
 await pool.query('BEGIN')
 await pool.query(source)
 const after = (await pool.query('SELECT native_turn_helpers_current() AS current')).rows[0].current
 console.log(JSON.stringify({ candidate: 'configured-task-publication', sourceSha256: createHash('sha256').update(source).digest('hex'),
  sourceHashes,nativeHelpersCurrentBefore: before, nativeHelpersCurrentAfter: after, ordinaryOwner: true, fullInstalledQualification: false }))
 if (!after) throw new Error('Candidate changed native helper identity; authenticated enrollment is required before receiving tests')
 await pool.query('COMMIT')
} catch (error) { await pool.query('ROLLBACK'); await pool.end(); throw error }
await import('./programmatic-intake-ready.integration.test.js')
