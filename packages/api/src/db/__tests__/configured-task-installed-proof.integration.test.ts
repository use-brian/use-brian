/** Receiving receipt on the real numbered 8296 migration. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import pg from 'pg'
import { afterAll, expect } from 'vitest'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const root = new URL('../../../', import.meta.url)
const paths = [
 'migrations/8051_application_native_operation_completion.sql',
 'migrations/770_engineering_pending_archive_erasure.sql',
 'migrations/8296_configured_task_publication.sql',
 'scripts/conversation-store/configured-task-publication.sql',
 'scripts/conversation-store/configured-task-publication.mjs',
 'scripts/conversation-store/build-configured-task-publication.mjs',
 'scripts/conversation-store/installation-authentication-8294.mjs',
 'scripts/conversation-store/installation-authentication-8296.mjs',
 'src/workspace-access/configured-capture-authority.ts',
 'src/ingest/programmatic-terminal.ts',
 'src/db/__tests__/programmatic-intake-ready.integration.test.ts',
 'src/db/__tests__/engineering-history-store.integration.test.ts',
]
const hashes = () => Promise.all(paths.map(async file => [file,createHash('sha256').update(await readFile(new URL(file,root))).digest('hex')]))
const before = await hashes()
const startedAt = new Date().toISOString()
afterAll(async () => {
 const after = await hashes()
 console.log(JSON.stringify({proof:'configured-task-publication-installed', startedAt, endedAt:new Date().toISOString(),
  sourceInputsUnchanged:JSON.stringify(before)===JSON.stringify(after),before:Object.fromEntries(before),after:Object.fromEntries(after)}))
 expect(after).toEqual(before)
})
const connection = new pg.Client({connectionString:process.env.DATABASE_URL})
await connection.connect()
try {
 expect((await connection.query("SELECT name FROM public._migrations WHERE name='8296_configured_task_publication.sql'")).rowCount).toBe(1)
 const {authenticateConversationInstallation} = await import(new URL('scripts/conversation-store/installation-authentication-8296.mjs',root).href)
 const proof = await authenticateConversationInstallation(connection)
 expect(proof).toMatchObject({functions:396,witnessCurrent:true})
 console.log(JSON.stringify({installation:proof,authenticatedAt:new Date().toISOString()}))
} finally {
 await connection.end()
}

const vitest = createRequire(import.meta.url).resolve('vitest/vitest.mjs')
execFileSync(process.execPath,[vitest,'run','--config','vitest.integration.config.ts','--maxWorkers=1',
 'src/db/__tests__/engineering-history-store.integration.test.ts','-t','publishes exact original once|preserves queued bytes'],{stdio:'inherit'})
await import('./programmatic-intake-ready.integration.test.js')
