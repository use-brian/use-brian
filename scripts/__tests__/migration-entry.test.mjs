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
test('shared runtime installer refuses injected role arguments and keeps explicit migration ACLs', async () => {
  await assert.rejects(runtimeRoleSql('converge', { role: 'unsafe;grant', password: 'a'.repeat(64) }))
  const prepare = await runtimeRoleSql('prepare')
  const converge = await runtimeRoleSql('converge', { role: 'assurance_app', password: 'a'.repeat(64) })
  assert.match(prepare, /ALTER DEFAULT PRIVILEGES.*TABLES/)
  assert.doesNotMatch(converge, /GRANT.*ON ALL (?:TABLES|FUNCTIONS)/)
  assert.match(converge, /NOINHERIT/)
  assert.doesNotMatch(converge, /GRANT app_user TO/)
})

test('fixture refuses unreviewed runtime roles and callback boundaries before starting PostgreSQL', async () => {
  await assert.rejects(createLocalFixture({runtimeRole:'owner'}), /Unsupported fixture runtime role/)
  await assert.rejects(createLocalFixture({beforeApply:async()=>{}}), /explicit pending migration filename/)
  await assert.rejects(createLocalFixture({beforeApplyFile:'../8000.sql',beforeApply:async()=>{}}), /explicit pending migration filename/)
})
