import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pristineCache } from './pristine-fixture.mjs'
import { prepareRuntimeRole, activateRuntimeRole } from './runtime-role.mjs'

const ossRoot = fileURLToPath(new URL('../../', import.meta.url))
const markerName = 'assurance-fixture.json'

/** Refuse a live target even though local mode never consumes it. */
export function validateAmbientDatabase(env) {
  for (const key of ['DATABASE_URL', 'DATABASE_URL_APP', 'APP_DATABASE_URL']) {
    const value = env[key]
    if (!value) continue
    let url
    try { url = new URL(value) } catch { throw new Error(`Unset ${key}: local assurance refuses an unrecognized database URL`) }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.searchParams.has('host') || url.searchParams.has('service')) {
      throw new Error(`Unset ${key}: local assurance refuses an inherited nonlocal database`)
    }
  }
}

export function cleanRuntimeEnvironment(env) {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot']
    .filter((key) => env[key] !== undefined).map((key) => [key, env[key]]))
}

/**
 * The fixture command's environment: the fixture's own values (runtime
 * prerequisites and database settings) plus the caller's harness controls,
 * the `BRIAN_*` and `CAMPAIGN_*` variables such as `BRIAN_CHAT_COST_OUTPUT`.
 * Fixture markers, database selectors and credential-shaped names are never
 * forwarded, and nothing else from the caller (provider credentials included)
 * reaches the command, so it can only connect to this owned cluster.
 */
export function fixtureCommandEnvironment(callerEnv, fixtureEnv) {
  const forwarded = Object.entries(callerEnv).filter(([key, value]) => typeof value === 'string'
    && /^(?:BRIAN|CAMPAIGN)_[A-Z0-9_]+$/.test(key) && !key.startsWith('BRIAN_ASSURANCE_') && !key.includes('DATABASE')
    && !/SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|PRIVATE|KEY/.test(key))
  return { ...Object.fromEntries(forwarded), ...fixtureEnv }
}

export async function runCommand(command, args, { env, cwd = ossRoot, logPath, inherit = false, onOutput } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
    let output = ''
    if (!inherit) {
      const capture = (chunk) => {
        const text = chunk.toString()
        output = (output + text).slice(-10_000_000)
        try { onOutput?.(text) } catch (error) { child.kill('SIGTERM'); reject(error) }
      }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
    }
    child.on('error', reject)
    child.on('close', async (code, signal) => {
      try {
        if (logPath) await writeFile(logPath, output, { mode: 0o600 })
        if (code !== 0) reject(new Error(`Command ${command} failed (${signal ?? code})${logPath ? `; log: ${logPath}` : ''}`))
        else accept(output)
      } catch (error) { reject(error) }
    })
  })
}

async function availablePort() {
  const server = createServer()
  return new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close((error) => error ? reject(error) : accept(port))
    })
  })
}

/** Creates only a new cluster. No caller-supplied database or data directory. */
export async function createLocalFixture({ pgBin, migrationDirs = [], env = process.env, walArchive = false, beforeApply, beforeApplyFile, runtimeRole = 'app_user', prepareTemplate = false, migrationProgress = false, ordinaryOwner = true, statementStatistics = false, executorProbe, pristineCacheDirectory } = {}) {
  validateAmbientDatabase(env)
  const { default: pg } = await import('pg')
  if (typeof statementStatistics !== 'boolean') throw new Error('Invalid statement statistics profile')
  if (typeof ordinaryOwner !== 'boolean') throw new Error('Invalid ordinary owner profile')
  // Migration 8274 admits only an ordinary owner and refuses a superuser-run chain
  // (installation_runtime_role_unsafe). A superuser owner cannot reach the current
  // schema, so the fixture refuses that profile before creating a cluster.
  if (!ordinaryOwner) throw new Error('Superuser-owned fixtures cannot apply migration 8274 (installation_runtime_role_unsafe). Use the default ordinary-owner profile; perform fixture-only role setup through the bootstrap role.')
  if (runtimeRole !== 'app_user') throw new Error('Unsupported fixture runtime role')
  if ((beforeApply === undefined) !== (beforeApplyFile === undefined) || (beforeApply !== undefined && (typeof beforeApply !== 'function' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.sql$/.test(beforeApplyFile)))) throw new Error('Upgrade callback requires one explicit pending migration filename')
  const runtime = cleanRuntimeEnvironment(env)
  const executable = (name) => pgBin ? join(resolve(pgBin), name) : name
  const version = await runCommand(executable('postgres'), ['--version'], { env: runtime })
  if (!/PostgreSQL\) 18\./.test(version)) throw new Error('Local assurance requires PostgreSQL 18 with pgvector and pg_trgm; select it with --pg-bin')
  const sharedir = (await runCommand(executable('pg_config'), ['--sharedir'], { env: runtime })).trim()
  for (const extension of ['vector', 'pg_trgm']) {
    try { await readFile(join(sharedir, 'extension', `${extension}.control`)) }
    catch { throw new Error(`Selected PostgreSQL lacks ${extension}; select an installation containing it with --pg-bin`) }
  }
  if (pristineCacheDirectory && (walArchive || beforeApply || migrationDirs.length || statementStatistics || executorProbe)) {
    throw new Error('Only the standard OSS migration fixture can use a pristine backup')
  }
  const cache = pristineCacheDirectory && await pristineCache(pristineCacheDirectory, pgBin, runCommand)
  const directory = await mkdtemp(join(tmpdir(), 'brian-crm-'))
  const data = join(directory, 'data')
  const token = randomUUID()
  const password = randomBytes(32).toString('hex')
  const appPassword = randomBytes(32).toString('hex')
  const port = await availablePort()
  const makeUrl = (username, secret, database) => `postgresql://${username}:${secret}@127.0.0.1:${port}/${database}`
  const bootstrapRole = ordinaryOwner ? 'assurance_bootstrap' : 'assurance_owner'
  const adminUrl = makeUrl('assurance_owner', password, 'brian_assurance')
  const appUrl = makeUrl(runtimeRole, appPassword, 'brian_assurance')
  const marker = join(directory, markerName)
  const ownership = { token, port, database: 'brian_assurance', directory, ...(ordinaryOwner ? { bootstrapRole } : {}) }
  await writeFile(marker, JSON.stringify(ownership), { mode: 0o600 })
  const fixtureEnv = {
    ...runtime, PATH: pgBin ? `${resolve(pgBin)}${delimiter}${runtime.PATH ?? ''}` : runtime.PATH,
    DATABASE_URL: adminUrl, DATABASE_URL_APP: appUrl, APP_DATABASE_URL: appUrl,
    PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'assurance_owner',
    PGPASSWORD: password, PGDATABASE: 'brian_assurance',
    MIGRATION_DIRS: migrationDirs.map((path) => resolve(path)).join(delimiter),
    BRIAN_ASSURANCE_FIXTURE: marker, BRIAN_ASSURANCE_TOKEN: token,
    PG_POOL_MAX: '8', NODE_ENV: 'test',
  }
  let started = false
  let stopped = false
  async function dispose() {
    if (stopped) return
    const owned = JSON.parse(await readFile(marker, 'utf8'))
    if (owned.token !== token || owned.directory !== directory) throw new Error('Fixture ownership changed; refusing cleanup')
    if (started) await runCommand(executable('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env: runtime })
    stopped = true
    await rm(directory, { recursive: true })
  }
  const socket = cache ? directory : ''
  const startArguments = ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k '${socket.replaceAll("'", "'\\''")}'`, '-w', 'start']
  /**
   * Owned restart for cold measurements: a fast shutdown of this cluster and a
   * new postmaster on the same data directory, port and settings. Shared
   * buffers and every backend cache start empty and existing connections end,
   * so callers reconnect with fresh pools. The OS page cache is not flushed
   * (that needs elevated privileges), so "cold" means a restarted PostgreSQL,
   * not cold storage.
   */
  async function restart() {
    if (stopped || !started) throw new Error('Fixture is not running; refusing restart')
    const owned = JSON.parse(await readFile(marker, 'utf8'))
    if (owned.token !== token || owned.directory !== directory) throw new Error('Fixture ownership changed; refusing restart')
    await runCommand(executable('pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { env: runtime })
    // As at first start, disposal keeps attempting a stop while pg_ctl starts.
    try { await runCommand(executable('pg_ctl'), startArguments, { env: runtime }) }
    catch (error) {
      // Only an absent pid file proves that no postmaster runs on this data directory.
      if (await readFile(join(data, 'postmaster.pid')).then(() => false, () => true)) started = false
      throw error
    }
  }
  try {
    const restored = cache && await cache.restore(data, runtime)
    if (!restored) {
      const pwfile = join(directory, 'password')
      await writeFile(pwfile, password, { mode: 0o600 })
      await runCommand(executable('initdb'), ['-D', data, '-U', bootstrapRole, '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=scram-sha-256', `--pwfile=${pwfile}`], { env: runtime, logPath: join(directory, 'initdb.log') })
      await rm(pwfile)
    }
    if(walArchive) {
      const archive=join(directory,'wal-archive'),keyFile=join(directory,'wal-key'),config=join(directory,'wal-config.json')
      await mkdir(archive,{mode:0o700});await writeFile(keyFile,randomBytes(32),{mode:0o600})
      await writeFile(config,JSON.stringify({keyFile,keyReference:'disposable-fixture/wal',walArchiveDirectory:archive}),{mode:0o600})
      const shellQuote=(value)=>"'"+value.replaceAll("'","'\\''")+"'"
      const command=[process.execPath,fileURLToPath(new URL('../operations/brian-wal-archive.mjs',import.meta.url)),
        '--config',config,'--source','%p','--name','%f'].map(shellQuote).join(' ')
      await writeFile(join(data,'postgresql.auto.conf'),"archive_mode=on\narchive_command='"+command.replaceAll("'","''")+"'\n",{mode:0o600})
      fixtureEnv.BRIAN_ASSURANCE_WAL_CONFIG=config
    }
    if(statementStatistics) await appendFile(join(data,'postgresql.auto.conf'),"shared_preload_libraries='pg_stat_statements'\npg_stat_statements.track='all'\npg_stat_statements.max=100000\n",{mode:0o600})
    if(executorProbe){
      if(!/^\/[a-zA-Z0-9_/.@-]+$/.test(executorProbe.library)||!/^\/[a-zA-Z0-9_/.@-]+$/.test(executorProbe.output))throw new Error('Executor probe requires simple absolute owned paths')
      await appendFile(join(data,'postgresql.auto.conf'),`shared_preload_libraries='${statementStatistics?'pg_stat_statements,':''}${executorProbe.library}'\n`,{mode:0o600})
    }
    // A watchdog may interrupt pg_ctl after PostgreSQL has daemonized.
    // Disposal must attempt to stop this owned cluster in that window too.
    started = true
    await runCommand(executable('pg_ctl'), startArguments, { env: runtime })
    async function bootstrap(run) {
      const client = new pg.Client({ connectionString: makeUrl(bootstrapRole, password, 'brian_assurance') })
      await client.connect()
      try { return await run(client) } finally { await client.end() }
    }
    if (restored) {
      // initdb trusts only local Unix sockets. The containing directory is owned
      // by this run (0700), and TCP connections continue to require SCRAM.
      const client = new pg.Client({ host: socket, port, database: 'postgres', user: bootstrapRole })
      await client.connect()
      try {
        await client.query(`ALTER ROLE assurance_bootstrap PASSWORD '${password}'; ALTER ROLE assurance_owner PASSWORD '${password}'; ALTER ROLE app_user PASSWORD '${appPassword}'`)
      } finally { await client.end() }
      console.log('Restored verified pristine PostgreSQL backup')
    } else {
      const admin = new pg.Client({ connectionString: makeUrl(bootstrapRole, password, 'postgres') })
      await admin.connect()
      try {
        if (ordinaryOwner) await admin.query(`CREATE ROLE assurance_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`)
        await admin.query('CREATE DATABASE brian_assurance OWNER assurance_owner')

      } finally { await admin.end() }
      if(statementStatistics){
        await bootstrap(client=>client.query('CREATE EXTENSION pg_stat_statements'))
        fixtureEnv.BRIAN_ASSURANCE_STATEMENT_STATS='true'
      }
      if (ordinaryOwner) await bootstrap(async client => {
        // The immutable baseline moves extensions into public, which requires
        // their owner. A temporary installer owns only these extension objects;
        // the initial cluster role also owns pinned system objects.
        await client.query(`BEGIN;
          CREATE ROLE assurance_extension_bootstrap SUPERUSER NOLOGIN;
          SET LOCAL ROLE assurance_extension_bootstrap;
          CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
          CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
          RESET ROLE;
          REASSIGN OWNED BY assurance_extension_bootstrap TO assurance_owner;
          DROP ROLE assurance_extension_bootstrap;
          COMMIT`)
        await prepareRuntimeRole(client)
      })
      const connection = new pg.Client({ connectionString: adminUrl })
      await connection.connect()
      try {
        if (ordinaryOwner) {
          const role = (await connection.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
          if (!role || role.rolsuper || role.rolbypassrls) throw new Error('Ordinary owner profile has elevated privileges')
        }
        await prepareRuntimeRole(connection)
        const activate = () => ordinaryOwner ? bootstrap(client => activateRuntimeRole(client, { password: appPassword })) : activateRuntimeRole(connection, { password: appPassword })
        if (beforeApply) {
          let boundarySeen = false
          const { tsImport } = await import('tsx/esm/api')
          const { runMigrations } = await tsImport('../../packages/api/scripts/migrate.ts', import.meta.url)
          await runMigrations({ databaseUrl: adminUrl, migrationDirs, beforeApply: async migration => {
            if (migration.file !== beforeApplyFile) return
            if (boundarySeen) throw new Error('Upgrade boundary executed twice')
            boundarySeen = true
            // Only this explicit new-disposable upgrade boundary may activate early.
            await activate()
            await beforeApply({ ...migration, adminUrl, appUrl, env: fixtureEnv })
          } })
          if (!boundarySeen) throw new Error('Upgrade boundary missing or already applied: ' + beforeApplyFile)
        } else {
          let pending = ''
          await runCommand(process.execPath, ['--import', import.meta.resolve('tsx'), 'packages/api/scripts/migrate.ts'], {
            env: fixtureEnv, logPath: join(directory, 'migrations.log'),
            onOutput: migrationProgress ? text => {
              const lines = (pending + text).split('\n'); pending = lines.pop() ?? ''
              for (const line of lines) {
                const match = /^\s*apply: ([\w.-]+\.sql)$/.exec(line)
                if (match) console.log(`Preparing database: ${match[1]}`)
              }
            } : undefined,
          })
        }
        await activate()
        if(executorProbe)await bootstrap(client=>client.query(['assurance_owner','app_user'].map(role=>`ALTER ROLE ${role} SET m6_probe.capture='${executorProbe.capture === false ? 'off' : 'on'}';ALTER ROLE ${role} SET m6_probe.output='${executorProbe.output}'`).join(';')))
      } finally { await connection.end() }
      if (cache) await cache.save({ ...fixtureEnv, PGUSER: bootstrapRole })
    }
    if (prepareTemplate) {
      const admin = new pg.Client({ connectionString: makeUrl(bootstrapRole, password, 'postgres') })
      await admin.connect()
      try { await admin.query('CREATE DATABASE brian_assurance_template OWNER assurance_owner TEMPLATE brian_assurance') }
      finally { await admin.end() }
      fixtureEnv.BRIAN_ASSURANCE_TEMPLATE = 'brian_assurance_template'
      await writeFile(marker, JSON.stringify({ ...ownership, template: 'brian_assurance_template' }), { mode: 0o600 })
    }
    // Replay creates tens of thousands of distinct statements. They are setup,
    // not part of the measured operation, and must not evict workload entries.
    // Only this owned fixture's existing bootstrap observer resets statistics;
    // owner/app_user retain their unchanged production privilege floor.
    if (statementStatistics) await bootstrap(client => client.query('SELECT pg_stat_statements_reset()'))
    return { directory, env: fixtureEnv, adminUrl, appUrl, dispose, restart,
      ...(statementStatistics ? { statistics: { maxStatements: 100000, resetAfterMigrations: true, observer: bootstrapRole } } : {}) }
  } catch (error) {
    // Keep failure diagnostics outside the owned cluster before cleanup.
    const evidence = await mkdtemp(join(tmpdir(), 'brian-crm-failure-'))
    for (const file of ['initdb.log', 'postgres.log', 'migrations.log']) {
      const contents = await readFile(join(directory, file), 'utf8').catch(() => null)
      if (contents !== null) await writeFile(join(evidence, file), contents.replaceAll(password, '[redacted]').replaceAll(appPassword, '[redacted]'), { mode: 0o600 })
    }
    await dispose()
    throw new Error(`${error.message}; retained diagnostics: ${evidence}`, { cause: error })
  }
}

/** A test must call this before connecting, never use the ambient integration fallback. */
export async function assertLocalFixture(env = process.env) {
  if (!env.BRIAN_ASSURANCE_FIXTURE || !env.BRIAN_ASSURANCE_TOKEN) throw new Error('Run this suite through scripts/crm/local-fixture.mjs')
  validateAmbientDatabase(env)
  const marker = JSON.parse(await readFile(env.BRIAN_ASSURANCE_FIXTURE, 'utf8'))
  if (marker.token !== env.BRIAN_ASSURANCE_TOKEN) throw new Error('Fixture token mismatch')
  if (marker.bootstrapRole !== undefined && marker.bootstrapRole !== 'assurance_bootstrap') throw new Error('Unsupported fixture bootstrap role')
  for (const key of ['DATABASE_URL', 'DATABASE_URL_APP']) {
    const url = new URL(env[key])
    if (!/^brian_assurance(?:_[a-f0-9]+)?$/.test(marker.database)
      || url.hostname !== '127.0.0.1' || Number(url.port) !== marker.port || url.pathname !== `/${marker.database}`) throw new Error('Database URL is outside the owned fixture')
  }
  return marker
}

/** Clone the owned pristine template, or the quiescent parent after a completed journey. */
export async function cloneLocalFixture(env = process.env, { fromCurrent = false } = {}) {
  const parent = await assertLocalFixture(env)
  if (parent.template !== 'brian_assurance_template' || env.BRIAN_ASSURANCE_TEMPLATE !== parent.template) {
    throw new Error('Owned fixture has no prepared template')
  }
  const database = `brian_assurance_${randomUUID().replaceAll('-', '')}`
  const token = randomUUID(), marker = join(parent.directory, `${database}.json`)
  const withDatabase = value => { const url = new URL(value); url.pathname = `/${database}`; return url.href }
  const adminUrl = withDatabase(env.DATABASE_URL), appUrl = withDatabase(env.DATABASE_URL_APP)
  const maintenanceUrl = new URL(env.DATABASE_URL); maintenanceUrl.pathname = '/postgres'
  if (parent.bootstrapRole) maintenanceUrl.username = parent.bootstrapRole
  const { default: pg } = await import('pg')
  const admin = new pg.Client({ connectionString: maintenanceUrl.href })
  await admin.connect()
  let created = false
  try {
    // PostgreSQL refuses to clone a source database with other active sessions.
    const source = fromCurrent ? parent.database : parent.template
    await admin.query(`CREATE DATABASE "${database}" OWNER assurance_owner TEMPLATE "${source}"`)
    created = true
    await writeFile(marker, JSON.stringify({ token, port: parent.port, database, directory: parent.directory, ...(parent.bootstrapRole ? { bootstrapRole: parent.bootstrapRole } : {}) }), { mode: 0o600 })
  } catch (error) {
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`)
    throw error
  } finally { await admin.end() }
  let disposed = false
  const cloneEnv = { ...env, DATABASE_URL: adminUrl, DATABASE_URL_APP: appUrl, APP_DATABASE_URL: appUrl,
    PGDATABASE: database, BRIAN_ASSURANCE_FIXTURE: marker, BRIAN_ASSURANCE_TOKEN: token }
  delete cloneEnv.BRIAN_ASSURANCE_TEMPLATE
  return { directory: parent.directory, adminUrl, appUrl, env: cloneEnv, async dispose() {
    if (disposed) return
    await assertLocalFixture(cloneEnv)
    const connection = new pg.Client({ connectionString: maintenanceUrl.href })
    await connection.connect()
    try { await connection.query(`DROP DATABASE "${database}" WITH (FORCE)`) }
    finally { await connection.end() }
    await rm(marker)
    disposed = true
  } }
}

/** Preserve ordinary migrations; marked synthetic runs must validate before skipping dotenv. */
export async function loadMigrationEnvironment(loadWorkspaceDotenv, env = process.env) {
  if (env.BRIAN_ASSURANCE_FIXTURE !== undefined || env.BRIAN_ASSURANCE_TOKEN !== undefined) {
    await assertLocalFixture(env)
    return 'fixture'
  }
  await loadWorkspaceDotenv()
  return 'workspace'
}

/** Explicit maintained fixture CLI selection; never accepts arbitrary role names. */
export function parseLocalFixtureArguments(values) {
  const args=[...values]
  let pgBin
  let runtimeRole='app_user'
  let walArchive=false
  let statementStatistics=false
  // Ordinary owner is the only supported profile; the flag stays accepted as explicit.
  let ordinaryOwner=true
  const migrationDirs = []
  while (args[0] && args[0] !== '--') {
    const option = args.shift()
    if(option==='--wal-archive-fixture'){walArchive=true;continue}
    if(option==='--ordinary-owner'){ordinaryOwner=true;continue}
    if(option==='--statement-statistics'){statementStatistics=true;continue}
    const value = args.shift()
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`)
    if (option === '--pg-bin') pgBin = value
    else if (option === '--runtime-role') {
      if (value !== 'app_user') throw new Error('Unsupported fixture runtime role')
      runtimeRole=value
    }
    else if (option === '--migration-dir') migrationDirs.push(value)
    else throw new Error(`Unknown option ${option}`)
  }
  if (args.shift() !== '--' || !args.length) throw new Error('Supply an explicit test command after --; see --help')
  return {pgBin,migrationDirs,walArchive,runtimeRole,ordinaryOwner,statementStatistics,command:args}
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/crm/local-fixture.mjs [--pg-bin DIR] [--migration-dir DIR] [--wal-archive-fixture] [--ordinary-owner (default)] [--statement-statistics] [--runtime-role app_user] -- COMMAND [ARGS...]\nCreates a disposable loopback PostgreSQL 18 database using actual migrations. Requires pgvector/pg_trgm. Never uses an ambient DB.\n--statement-statistics preloads pg_stat_statements (track=all) for nested-statement counts.\nCOMMAND receives the fixture environment plus the caller BRIAN_* and CAMPAIGN_* harness controls (never fixture markers, database selectors or credential-shaped names).')
    return
  }
  const {pgBin,migrationDirs,walArchive,runtimeRole,ordinaryOwner,statementStatistics,command:argsCommand}=parseLocalFixtureArguments(args)
  let interrupted = false
  // Group termination also stops the active child. Keep this owner alive long
  // enough for that failure to unwind through PostgreSQL disposal.
  const onInterrupt = () => { interrupted = true }
  process.on('SIGTERM', onInterrupt)
  process.on('SIGINT', onInterrupt)
  let fixture
  try {
    fixture = await createLocalFixture({ pgBin, migrationDirs, walArchive, runtimeRole, ordinaryOwner, statementStatistics })
    if (interrupted) throw new Error('Disposable fixture interrupted')
    await runCommand(argsCommand[0], argsCommand.slice(1), { env: fixtureCommandEnvironment(process.env, fixture.env), inherit: true })
    if (interrupted) throw new Error('Disposable fixture interrupted')
  } finally {
    try { await fixture?.dispose() }
    finally { process.off('SIGTERM', onInterrupt); process.off('SIGINT', onInterrupt) }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
