/** Native validation launcher for the unnumbered 8296 render on a pristine 8295 clone. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { expect } from 'vitest'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const directory = fileURLToPath(new URL('../../../scripts/conversation-store/', import.meta.url))
const migrations = fileURLToPath(new URL('../../../migrations/', import.meta.url))
const name = '8296_configured_task_publication.sql'
const scratch = await mkdtemp(join(tmpdir(), 'configured-task-upgrade-'))
const connection = new pg.Client({ connectionString: process.env.DATABASE_URL })
const startedAt = new Date().toISOString()
const { tsImport } = await import('tsx/esm/api')
const { runMigrations } = await tsImport('../../../scripts/migrate.ts', import.meta.url)

try {
 const inputs = join(scratch, 'migrations')
 const pending = join(scratch, 'pending')
 await mkdir(inputs)
 await mkdir(pending)
 for (const file of await readdir(migrations)) await symlink(join(migrations, file), join(inputs, file))
 execFileSync(process.execPath,[join(directory,'build-configured-task-publication.mjs'),'--output',join(pending,name)],{stdio:'pipe'})
 await symlink(join(pending,name), join(inputs,name))
 const sql = await readFile(join(pending,name),'utf8')
 const rehearsal = sql.replace(/^BEGIN;$/m,'').replace(/COMMIT;\s*$/,'')
 await connection.connect()
 const { authenticateConversationInstallation: authenticatePredecessor } = await import(join(directory,'installation-authentication-8294.mjs'))
 const { authenticateConversationInstallation: authenticateSuccessor } = await import(join(directory,'installation-authentication-8296.mjs'))
 const before = await authenticatePredecessor(connection)
 expect(before).toMatchObject({functions:392,witnessCurrent:true})
 const snapshot = async () => (await connection.query(`SELECT to_jsonb(p) AS routine
  FROM pg_catalog.pg_proc p WHERE oid='public.check_programmatic_publication_commit()'::regprocedure`)).rows[0].routine
 const pristine = await snapshot()
 const assertRefuses = async (change: () => Promise<unknown>, error: string) => {
  await connection.query('BEGIN')
  try {
   await change()
   const altered = await snapshot()
   await connection.query('SAVEPOINT configured_upgrade')
   await expect(connection.query(rehearsal)).rejects.toMatchObject({message:error})
   await connection.query('ROLLBACK TO SAVEPOINT configured_upgrade')
   expect(await snapshot()).toEqual(altered)
   expect((await connection.query("SELECT to_regprocedure('public.seal_configured_task_candidate()') IS NULL AS absent")).rows[0].absent).toBe(true)
  } finally {
   await connection.query('ROLLBACK')
  }
  expect(await snapshot()).toEqual(pristine)
 }
 await assertRefuses(
  () => connection.query('ALTER FUNCTION public.check_programmatic_publication_commit() COST 101'),
  'configured_task_source_member_changed: check_programmatic_publication_commit()',
 )
 await assertRefuses(
  async () => {
   const {rows:[{definition}]} = await connection.query(`SELECT pg_get_functiondef(
    'public.check_programmatic_publication_commit()'::regprocedure
   ) AS definition`)
   const changed = definition.replace('DECLARE batch pending_ingest_batches;', 'DECLARE batch pending_ingest_batches; /* fixture drift */')
   expect(changed).not.toBe(definition)
   await connection.query(changed)
  },
  'configured_task_source_member_changed: check_programmatic_publication_commit()',
 )
 await assertRefuses(
  async () => {
   const {rows:[{statement}]} = await connection.query(`SELECT format('CREATE FUNCTION public.fixture_configured_task_pin() RETURNS text LANGUAGE sql AS %L',
    'SELECT '||quote_literal(encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))||'::text') AS statement
    FROM pg_catalog.pg_proc p WHERE p.oid='public.check_programmatic_publication_commit()'::regprocedure`)
   await connection.query(statement)
  },
  'configured_task_ordinary_pin_consumer: check_programmatic_publication_commit()',
 )
 const {configuredSourceSql,configuredSchemaAuthenticationSql}=await import(join(directory,'configured-task-publication.mjs'))
 await connection.query('BEGIN')
 try {
  await connection.query(configuredSourceSql)
  await connection.query(configuredSchemaAuthenticationSql('diagnostics_').split('DO $diagnostics_schema$')[0])
  const {rows:[structure]}=await connection.query(`SELECT
   (SELECT count(*) FROM pg_attribute WHERE attrelid='public.episode_extraction_items'::regclass AND attnum>0 AND NOT attisdropped) AS columns,
   (SELECT jsonb_agg(jsonb_build_object('actual',to_jsonb(a)-ARRAY['attrelid','attnum','attcacheoff'],'reference',to_jsonb(r)-ARRAY['attrelid','attnum','attcacheoff']))
    FROM pg_attribute a JOIN pg_attribute r ON a.attname=r.attname WHERE a.attrelid='public.episode_extraction_items'::regclass
    AND r.attrelid='pg_temp.diagnostics_item_reference'::regclass AND a.attname LIKE 'configured_%'
    AND (to_jsonb(a)-ARRAY['attrelid','attnum','attcacheoff']) IS DISTINCT FROM (to_jsonb(r)-ARRAY['attrelid','attnum','attcacheoff'])) AS attr_differences,
   (SELECT jsonb_agg(jsonb_build_object('definition',pg_get_constraintdef(oid),'enforced',conenforced,'valid',convalidated))
    FROM pg_constraint WHERE conname='configured_task_receipt_complete') AS receipt_checks,
   (SELECT jsonb_agg(jsonb_build_object('actual',to_jsonb(a)-ARRAY['oid','tgrelid'],'reference',to_jsonb(r)-ARRAY['oid','tgrelid']))
    FROM pg_trigger r LEFT JOIN pg_trigger a ON a.tgname=r.tgname
    AND a.tgrelid=CASE WHEN r.tgname='configured_task_receipt_guard' THEN 'public.episode_extraction_items'::regclass ELSE 'public.tasks'::regclass END
    WHERE r.tgrelid='pg_temp.diagnostics_item_reference'::regclass AND NOT r.tgisinternal
    AND (a.oid IS NULL OR (to_jsonb(a)-ARRAY['oid','tgrelid']) IS DISTINCT FROM (to_jsonb(r)-ARRAY['oid','tgrelid']))) AS trigger_differences`)
  console.log(JSON.stringify({configuredSchemaDiagnostics:structure}))
 } finally {
  await connection.query('ROLLBACK')
 }
 const result = await runMigrations({databaseUrl:process.env.DATABASE_URL!,migrationDirs:[pending]})
 expect(result.appliedCount).toBe(1)
 const after = await authenticateSuccessor(connection,{sourceRoot:scratch})
 expect(after).toMatchObject({functions:396,witnessCurrent:true})
 console.log(JSON.stringify({
  migration:name,sha256:createHash('sha256').update(sql).digest('hex'),startedAt,authenticatedAt:new Date().toISOString(),
  before,after,refused:['ordinary routine body drift','ordinary routine metadata drift','unknown ordinary body fingerprint consumer'],
 }))
} finally {
 await connection.end()
 await rm(scratch,{recursive:true,force:true})
}

// A separate test process owns and closes its own canonical pools.
const vitest = createRequire(import.meta.url).resolve('vitest/vitest.mjs')
execFileSync(process.execPath,[vitest,'run','--config','vitest.integration.config.ts','--maxWorkers=1',
 'src/db/__tests__/engineering-history-store.integration.test.ts','-t','publishes exact original once|preserves queued bytes'],{stdio:'inherit'})

await import('./programmatic-intake-ready.integration.test.js')
