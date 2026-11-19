import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { runtimeRoleSql } from '../crm/runtime-role.mjs'
import { createLocalFixture, fixtureCommandEnvironment, parseLocalFixtureArguments } from '../crm/local-fixture.mjs'

test('[COMP:crm/assurance-fixture] importing actual migrator is inert even with poisoned workspace configuration', () => {
  const source = `const {runMigrations}=await import('./packages/api/scripts/migrate.ts');if(typeof runMigrations!=='function')throw Error('missing API');console.log('inert-import')`
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', source], {
    cwd: new URL('../../', import.meta.url), env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: 'postgres://invalid.example/no', BRIAN_ASSURANCE_FIXTURE: '/unavailable', BRIAN_ASSURANCE_TOKEN: 'invalid' }, encoding: 'utf8', timeout: 15000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'inert-import')
})
test('actual direct CLI still validates malformed fixture before connecting', () => {
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), 'packages/api/scripts/migrate.ts'], {
    cwd: new URL('../../', import.meta.url), env: { PATH: process.env.PATH, HOME: process.env.HOME, BRIAN_ASSURANCE_FIXTURE: '/unavailable' }, encoding: 'utf8', timeout: 15000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Run this suite through scripts\/crm\/local-fixture/)
})
test('fixed canonical installer refuses aliases and never clones function grants', async () => {
  for(const role of ['assurance_app','admin_fixture_app','unsafe;grant']) await assert.rejects(runtimeRoleSql('activate', { role, password: 'a'.repeat(64) }), /Unsupported fixture runtime role/)
  await assert.rejects(runtimeRoleSql('activate', { password: "unsafe'password" }), /Unsafe runtime password/)
  const prepare = await runtimeRoleSql('prepare')
  const activate = await runtimeRoleSql('activate', { password: 'a'.repeat(64) })
  const transition = await runtimeRoleSql('transition')
  const verify = await runtimeRoleSql('verify')
  assert.match(prepare, /ALTER DEFAULT PRIVILEGES.*TABLES/)
  assert.match(prepare, /IF empty_chain THEN/)
  assert.match(activate, /ALTER ROLE app_user LOGIN/)
  assert.doesNotMatch(activate, /GRANT/)
  assert.doesNotMatch(verify, /(?:GRANT|REVOKE|ALTER ROLE)/)
  assert.match(transition, /Unsupported 8112-only/)
  assert.match(transition, /Original Memory helper guard not restored/)
  assert.match(transition, /a.is_grantable/)
  assert.match(transition, /a.grantor<>p.proowner/)
  assert.equal((transition.match(/'memory'\)/g)||[]).length,10)
  assert.equal((transition.match(/'source'\)/g)||[]).length,2)
  assert.doesNotMatch(transition, /GRANT EXECUTE|CASCADE|CREATE (?:OR REPLACE )?FUNCTION/)
})

test('fixture refuses unreviewed runtime roles and callback boundaries before starting PostgreSQL', async () => {
  for(const runtimeRole of ['owner','assurance_app','admin_fixture_app']) await assert.rejects(createLocalFixture({runtimeRole}), /Unsupported fixture runtime role/)
  await assert.rejects(createLocalFixture({beforeApply:async()=>{}}), /explicit pending migration filename/)
  await assert.rejects(createLocalFixture({beforeApplyFile:'../8000.sql',beforeApply:async()=>{}}), /explicit pending migration filename/)
})

test('[COMP:crm/assurance-fixture] fixture command inherits harness controls but never a database selector or credential', () => {
  const caller = { PATH: '/usr/bin', HOME: '/home/fictional', BRIAN_CHAT_COST_OUTPUT: '/tmp/fictional-cost.json', BRIAN_CHAT_COST_SAMPLES: '31',
    DATABASE_URL: 'postgres://127.0.0.1:5432/ambient', TEST_DATABASE_URL: 'postgres://db.example/ambient', CONTEXT_SCOPE_TEST_DATABASE_URL: 'postgres://db.example/scope',
    USEBRIAN_LOCAL_DATABASE: 'managed-postgres', PGHOST: 'db.example', PGHOSTADDR: '192.0.2.1', PGSERVICE: 'ambient', PGPASSFILE: '/tmp/fictional-pass',
    BRIAN_ASSURANCE_FIXTURE: '/tmp/other-marker', BRIAN_ASSURANCE_TEMPLATE: 'other', BRIAN_ASSURANCE_STATEMENT_STATS: 'true', MIGRATION_DIRS: '/elsewhere', PG_POOL_MAX: '99',
    CAMPAIGN_PERMISSION_REPORT: '/tmp/fictional-report.json', BRIAN_MESSAGE_STORE_HMAC_SECRET: 'fictional', BRIAN_RUNTIME_PASSWORD: 'fictional',
    BRIAN_MESSAGE_STORE_DATABASE_URL: 'postgres://db.example/store', ANTHROPIC_API_KEY: 'fictional', NODE_OPTIONS: '--inspect' }
  const fixture = { PATH: '/pg18/bin:/usr/bin', DATABASE_URL: 'postgresql://assurance_owner:x@127.0.0.1:40001/brian_assurance',
    PGHOST: '127.0.0.1', PGPORT: '40001', PG_POOL_MAX: '8', BRIAN_ASSURANCE_FIXTURE: '/tmp/owned-marker', MIGRATION_DIRS: '', NODE_ENV: 'test' }
  const env = fixtureCommandEnvironment(caller, fixture)
  assert.equal(env.BRIAN_CHAT_COST_OUTPUT, '/tmp/fictional-cost.json')
  assert.equal(env.BRIAN_CHAT_COST_SAMPLES, '31')
  assert.equal(env.CAMPAIGN_PERMISSION_REPORT, '/tmp/fictional-report.json')
  for (const [key, value] of Object.entries(fixture)) assert.equal(env[key], value, key)
  for (const key of ['TEST_DATABASE_URL', 'CONTEXT_SCOPE_TEST_DATABASE_URL', 'USEBRIAN_LOCAL_DATABASE', 'PGHOSTADDR', 'PGSERVICE', 'PGPASSFILE',
    'BRIAN_ASSURANCE_TEMPLATE', 'BRIAN_ASSURANCE_STATEMENT_STATS', 'BRIAN_MESSAGE_STORE_HMAC_SECRET', 'BRIAN_RUNTIME_PASSWORD',
    'BRIAN_MESSAGE_STORE_DATABASE_URL', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'HOME']) assert.equal(env[key], undefined, key)
  assert.equal(parseLocalFixtureArguments(['--', 'node']).statementStatistics, false)
  assert.equal(parseLocalFixtureArguments(['--statement-statistics', '--pg-bin', '/pg18/bin', '--', 'node']).statementStatistics, true)
})

test('disposable activation follows successful migration or the explicit prefix boundary', async () => {
  const {readFile}=await import('node:fs/promises')
  const source=await readFile(new URL('../crm/local-fixture.mjs',import.meta.url),'utf8')
  assert.equal((source.match(/await activate\(\)/g)||[]).length,2)
  const callback=source.indexOf('await beforeApply({')
  assert.ok(source.indexOf('await activate()')<callback)
  assert.ok(source.lastIndexOf('await activate()')>source.indexOf("logPath: join(directory, 'migrations.log')"))
  assert.doesNotMatch(source,/convergeRuntimeRole|ALTER ROLE app_user LOGIN/)
})

test('shared safety recognizes the complete closed guard before every existing invocation',async()=>{
  for(const phase of ['prepare','transition','activate','verify']){
    const sql=await runtimeRoleSql(phase,{password:phase==='activate'?'a'.repeat(64):undefined})
    assert.match(sql,/DO \$fixture_guard_shape\$/)
    assert.match(sql,/Unknown fixture Memory guard: complete generated body/)
    assert.match(sql,/actual_oids\[1:120\] IS DISTINCT FROM expected_oids/)
    assert.match(sql,/actual_oids\[121\] IS DISTINCT FROM dispatcher_oid/)
    assert.match(sql,/8128_native_memory_history_admission.sql/)
    assert.match(sql,/IF pinned OR feedback OR amended OR history OR privacy OR chat_read_frame OR typed_manifest OR edge_dispatch\s+OR to_regprocedure\('public\.read_native_session_cohort_frame\(uuid,text\[\],uuid\[\],text\[\],boolean\)'\) IS NOT NULL THEN/)
    assert.match(sql,/actual_oids\[122\] IS DISTINCT FROM helper.oid/)
    assert.match(sql,/public.application_memory_history_status\(uuid,uuid,text\)/)
    assert.match(sql,/SELECT count\(\*\)=121/)
    assert.match(sql,/SELECT count\(\*\)=122/)
    assert.match(sql,/helper.proacl/)

    assert.match(sql,/Unsupported 120-only fixture phase/)
    assert.match(sql,/Unsupported 8112-only fixture phase/)
    const end=sql.indexOf('END $fixture_guard_shape$;'),call=sql.indexOf('IF public.application_memory_statement_helpers_current()')
    if(call!==-1)assert.ok(end<call,phase)
    const recognition=sql.slice(sql.indexOf('DO $fixture_guard_shape$'),end)
    assert.doesNotMatch(recognition,/IF public.application_memory_statement_helpers_current\(\)/)
    assert.match(recognition,/format\('\(%s::oid,%L::text\)',m\[1\]::oid,m\[2\]\)/)
    assert.doesNotMatch(recognition,/CREATE (?:OR REPLACE )?FUNCTION|ALTER FUNCTION|GRANT|REVOKE/)
  }
})
