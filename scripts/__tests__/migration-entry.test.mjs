import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { runtimeRoleSql } from '../crm/runtime-role.mjs'
import { createLocalFixture } from '../crm/local-fixture.mjs'

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

test('disposable activation follows successful migration or the explicit prefix boundary', async () => {
  const {readFile}=await import('node:fs/promises')
  const source=await readFile(new URL('../crm/local-fixture.mjs',import.meta.url),'utf8')
  assert.equal((source.match(/activateRuntimeRole\(connection/g)||[]).length,2)
  const callback=source.indexOf('await beforeApply({')
  assert.ok(source.indexOf('await activateRuntimeRole(connection')<callback)
  assert.ok(source.lastIndexOf('await activateRuntimeRole(connection')>source.indexOf("logPath: join(directory, 'migrations.log')"))
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
    assert.match(sql,/IF pinned OR feedback OR amended OR history THEN/)
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
