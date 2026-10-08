import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

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

export async function runCommand(command, args, { env, cwd = ossRoot, logPath, inherit = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
    let output = ''
    if (!inherit) {
      const capture = (chunk) => { output = (output + chunk.toString()).slice(-10_000_000) }
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
export async function createLocalFixture({ pgBin, migrationDirs = [], env = process.env, walArchive = false } = {}) {
  validateAmbientDatabase(env)
  const runtime = cleanRuntimeEnvironment(env)
  const executable = (name) => pgBin ? join(resolve(pgBin), name) : name
  const version = await runCommand(executable('postgres'), ['--version'], { env: runtime })
  if (!/PostgreSQL\) 18\./.test(version)) throw new Error('Local assurance requires PostgreSQL 18 with pgvector and pg_trgm; select it with --pg-bin')
  const sharedir = (await runCommand(executable('pg_config'), ['--sharedir'], { env: runtime })).trim()
  for (const extension of ['vector', 'pg_trgm']) {
    try { await readFile(join(sharedir, 'extension', `${extension}.control`)) }
    catch { throw new Error(`Selected PostgreSQL lacks ${extension}; select an installation containing it with --pg-bin`) }
  }
  const directory = await mkdtemp(join(tmpdir(), 'brian-crm-'))
  const data = join(directory, 'data')
  const token = randomUUID()
  const password = randomBytes(32).toString('hex')
  const appPassword = randomBytes(32).toString('hex')
  const port = await availablePort()
  const makeUrl = (username, secret, database) => `postgresql://${username}:${secret}@127.0.0.1:${port}/${database}`
  const adminUrl = makeUrl('assurance_owner', password, 'brian_assurance')
  const appUrl = makeUrl('assurance_app', appPassword, 'brian_assurance')
  const marker = join(directory, markerName)
  await writeFile(marker, JSON.stringify({ token, port, database: 'brian_assurance', directory }), { mode: 0o600 })
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
  try {
    const pwfile = join(directory, 'password')
    await writeFile(pwfile, password, { mode: 0o600 })
    await runCommand(executable('initdb'), ['-D', data, '-U', 'assurance_owner', '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=scram-sha-256', `--pwfile=${pwfile}`], { env: runtime, logPath: join(directory, 'initdb.log') })
    await rm(pwfile)
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
    await runCommand(executable('pg_ctl'), ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ''`, '-w', 'start'], { env: runtime })
    started = true
    const admin = new pg.Client({ connectionString: makeUrl('assurance_owner', password, 'postgres') })
    await admin.connect()
    try {
      await admin.query('CREATE DATABASE brian_assurance')
      await admin.query('CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS')
    } finally { await admin.end() }
    await runCommand(process.execPath, ['--import', import.meta.resolve('tsx'), 'packages/api/scripts/migrate.ts'], { env: fixtureEnv, logPath: join(directory, 'migrations.log') })
    const connection = new pg.Client({ connectionString: adminUrl })
    await connection.connect()
    try {
      // Passwords are generated hex, never user input or command arguments.
      await connection.query(`CREATE ROLE assurance_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
      await connection.query('GRANT app_user TO assurance_app')
      await connection.query(`GRANT USAGE ON SCHEMA public TO assurance_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO assurance_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO assurance_app;
        ALTER ROLE assurance_app SET app.current_user_id = '00000000-0000-0000-0000-000000000000'`)
    } finally { await connection.end() }
    return { directory, env: fixtureEnv, adminUrl, appUrl, dispose }
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
  for (const key of ['DATABASE_URL', 'DATABASE_URL_APP']) {
    const url = new URL(env[key])
    if (url.hostname !== '127.0.0.1' || Number(url.port) !== marker.port || url.pathname !== '/brian_assurance') throw new Error('Database URL is outside the owned fixture')
  }
  return marker
}

async function main(args) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/crm/local-fixture.mjs [--pg-bin DIR] [--migration-dir DIR] [--wal-archive-fixture] -- COMMAND [ARGS...]\nCreates a disposable loopback PostgreSQL 18 database using actual migrations. Requires pgvector/pg_trgm. Never uses an ambient DB.')
    return
  }
  let pgBin
  let walArchive=false
  const migrationDirs = []
  while (args[0] && args[0] !== '--') {
    const option = args.shift()
    if(option==='--wal-archive-fixture'){walArchive=true;continue}
    const value = args.shift()
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`)
    if (option === '--pg-bin') pgBin = value
    else if (option === '--migration-dir') migrationDirs.push(value)
    else throw new Error(`Unknown option ${option}`)
  }
  if (args.shift() !== '--' || !args.length) throw new Error('Supply an explicit test command after --; see --help')
  const fixture = await createLocalFixture({ pgBin, migrationDirs, walArchive })
  try {
    await runCommand(args[0], args.slice(1), { env: fixture.env, inherit: true })
  } finally { await fixture.dispose() }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
