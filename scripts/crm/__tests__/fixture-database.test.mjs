import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import pg from 'pg'
import { assertLocalFixture, cleanRuntimeEnvironment, runCommand } from '../local-fixture.mjs'

test('[COMP:crm/assurance-fixture] Default PostgreSQL clients remain inside the disposable cluster', async () => {
  const marker = await assertLocalFixture()
  const defaults = new pg.Client()
  try {
    await defaults.connect()
    const result = await defaults.query(`SELECT current_database() AS database, current_user AS role,
      host(inet_server_addr()) AS host, inet_server_port() AS port`)
    assert.deepEqual(result.rows, [{ database: 'brian_assurance', role: 'assurance_owner', host: '127.0.0.1', port: marker.port }])
  } finally { await defaults.end() }
  // An explicit database name must still target this server, never an ambient instance.
  const missing = new pg.Client({ database: `fixture_missing_${randomUUID().replaceAll('-', '')}` })
  try { await assert.rejects(missing.connect(), { code: '3D000' }) }
  finally { await missing.end() }
})

test('[COMP:crm/assurance-fixture] Actual migrations and application-role RLS', async () => {
  await assertLocalFixture()
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL })
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP })
  await owner.connect()
  await app.connect()
  try {
    const migrations = await owner.query('SELECT name FROM _migrations ORDER BY name')
    assert(migrations.rows.some((row) => row.name === '000_open_schema_v1.sql'))
    assert(migrations.rows.some((row) => row.name === '460_association_operations.sql'))
    const roles = await app.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')
    assert.equal(roles.rows[0].rolsuper, false)
    assert.equal(roles.rows[0].rolbypassrls, false)
    const userId = randomUUID()
    const otherUserId = randomUUID()
    const workspaceId = randomUUID()
    const otherWorkspaceId = randomUUID()
    await owner.query(`INSERT INTO users (id, auth_provider_id) VALUES ($1::uuid,$1::text),($2::uuid,$2::text)`, [userId, otherUserId])
    await owner.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Fixture One',$2),($3,'Fixture Two',$4)`, [workspaceId, userId, otherWorkspaceId, otherUserId])
    await owner.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner'),($3,$4,'owner')`, [workspaceId, userId, otherWorkspaceId, otherUserId])
    await owner.query(`INSERT INTO association_membership_plans (workspace_id,plan_key,name,currency,fee_minor,billing_period)
      VALUES ($1,'annual','Annual','USD',0,'annual'),($2,'annual','Annual','USD',0,'annual')`, [workspaceId, otherWorkspaceId])
    await app.query('BEGIN')
    await app.query(`SELECT set_config('app.current_user_id',$1,true)`, [userId])
    const rows = await app.query('SELECT workspace_id FROM association_membership_plans')
    assert.deepEqual(rows.rows.map((row) => row.workspace_id), [workspaceId])
    const write = await app.query(`UPDATE association_membership_plans SET name='Changed' WHERE workspace_id=$1`, [otherWorkspaceId])
    assert.equal(write.rowCount, 0)
    await assert.rejects(app.query(`INSERT INTO association_membership_plans (workspace_id,plan_key,name,currency,fee_minor,billing_period)
      VALUES ($1,'forbidden','Forbidden','USD',0,'annual')`, [otherWorkspaceId]), /row-level security/)
    await app.query('ROLLBACK')
  } finally {
    await app.end()
    await owner.end()
  }
})

test('[COMP:crm/assurance-fixture] Group interruption disposes only the owned PostgreSQL cluster', { timeout: 35_000 }, async t => {
  await assertLocalFixture()
  const directory = await mkdtemp(join(tmpdir(), 'fixture-interruption-test-'))
  const env = { ...cleanRuntimeEnvironment(process.env), TMPDIR: directory }
  const pgBin = (await runCommand('pg_config', ['--bindir'], { env })).trim()
  const child = spawn(process.execPath, ['scripts/crm/local-fixture.mjs', '--pg-bin', pgBin, '--', process.execPath,
    '-e', "console.log('fixture-ready');setInterval(()=>{},1000)"], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  const startedAt = new Date().toISOString()
  t.diagnostic(JSON.stringify({ ownedProcessGroup: child.pid, startedAt, maxSeconds: 25 }))
  const stop = signal => { try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  const deadline = setTimeout(() => stop('SIGKILL'), 25_000)
  let output = ''
  try {
    await new Promise((accept, reject) => {
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('fixture-ready')) accept() })
      child.stderr.on('data', chunk => { output += chunk })
      child.once('error', reject)
      child.once('close', () => reject(new Error('Disposable child exited before readiness: ' + output)))
    })
    const names = (await readdir(directory)).filter(name => name.startsWith('brian-crm-'))
    assert.equal(names.length, 1)
    const postmaster = Number((await readFile(join(directory, names[0], 'data', 'postmaster.pid'), 'utf8')).split('\n')[0])
    t.diagnostic(JSON.stringify({ ownedPostmaster: postmaster, directory: join(directory, names[0]) }))
    stop('SIGTERM')
    await closed
    assert.equal((await readdir(directory)).filter(name => name.startsWith('brian-crm-')).length, 0)
    assert.throws(() => process.kill(postmaster, 0), { code: 'ESRCH' })
    t.diagnostic(JSON.stringify({ ownedProcessGroup: child.pid, finishedAt: new Date().toISOString(), disposed: true }))
  } finally {
    clearTimeout(deadline)
    stop('SIGKILL')
    await closed
    // Failure cleanup is confined to this test's newly created root and a
    // marker whose owned directory matches; never select an ambient cluster.
    for (const name of (await readdir(directory)).filter(name => name.startsWith('brian-crm-'))) {
      const owned = join(directory, name)
      const marker = JSON.parse(await readFile(join(owned, 'assurance-fixture.json'), 'utf8'))
      assert.equal(marker.directory, owned)
      await runCommand(join(pgBin, 'pg_ctl'), ['-D', join(owned, 'data'), '-m', 'fast', '-w', 'stop'], { env })
    }
    await rm(directory, { recursive: true })
  }
})
