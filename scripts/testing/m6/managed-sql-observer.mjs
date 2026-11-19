#!/usr/bin/env node
/** External stock observer for owned pinned-runtime fixtures. Never edits artifact bytes. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { snapshotStatements, statementDelta } from './sql-observer.mjs'
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const safe = (path) => { if (!/^\/[a-zA-Z0-9_/.@-]+$/.test(path)) throw new Error('Use a simple absolute owned observer path'); return path }

export function prepareManagedSqlObserver({ artifactDirectory, sourceDirectory, tarball, out }) {
  for (const path of [artifactDirectory, sourceDirectory, out]) safe(path)
  if (existsSync(out)) throw new Error('Observer output already exists')
  const manifestPath = join(artifactDirectory, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestPath))
  const postgres = join(artifactDirectory, 'bin/postgres'), contrib = join(sourceDirectory, 'contrib/pg_stat_statements')
  if (manifest.postgresql !== '18.7' || manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('Observer requires the pinned local PG18.7 ABI')
  if (sha(postgres) !== manifest.files['bin/postgres'].sha256) throw new Error('Pinned postgres hash mismatch')
  if (sha(tarball) !== manifest.sources.find((s) => s.url.endsWith('/postgresql-18.7.tar.bz2'))?.sha256) throw new Error('PostgreSQL source tarball does not match the pin')
  const original = spawnSync('tar', ['-xOf', tarball, 'postgresql-18.7/contrib/pg_stat_statements/pg_stat_statements.c'])
  if (original.status !== 0 || !original.stdout.equals(readFileSync(join(contrib, 'pg_stat_statements.c')))) throw new Error('Observer source differs from pinned stock source')
  const configure = readFileSync(join(sourceDirectory, 'config.status'), 'utf8')
  for (const option of manifest.configure) if (!configure.includes(`'${option}'`)) throw new Error(`Observer configure mismatch: ${option}`)
  const version = spawnSync(postgres, ['--version'], { encoding: 'utf8' })
  if (version.status !== 0 || version.stdout.trim() !== 'postgres (PostgreSQL) 18.7') throw new Error('Actual pinned binary version differs')
  mkdirSync(join(out, 'share/extension'), { recursive: true, mode: 0o700 })
  const module = join(out, 'pg_stat_statements.dylib')
  copyFileSync(join(contrib, 'pg_stat_statements.dylib'), module)
  const controls = []
  for (const file of readdirSync(contrib).filter((f) => /^pg_stat_statements.*\.(sql|control)$/.test(f))) {
    let bytes = readFileSync(join(contrib, file))
    if (file.endsWith('.control')) bytes = Buffer.from(bytes.toString().replace("'$libdir/pg_stat_statements'", `'${module}'`))
    const destination = join(out, 'share/extension', file); writeFileSync(destination, bytes)
    controls.push({ file, sourceSha256: sha(join(contrib, file)), installedSha256: sha(destination) })
  }
  const record = { recordedAt: new Date().toISOString(), artifactDirectory, artifactManifestSha256: sha(manifestPath),
    postgresSha256: sha(postgres), postgresql: manifest.postgresql, platform: manifest.platform, arch: manifest.arch,
    sourceTarSha256: sha(tarball), sourceSha256: sha(join(contrib, 'pg_stat_statements.c')),
    module, moduleSha256: sha(module), pgConfigHeaderSha256: sha(join(sourceDirectory, 'src/include/pg_config.h')),
    configure: manifest.configure, controls, externalShare: join(out, 'share'),
    config: `shared_preload_libraries = '${module}'\npg_stat_statements.track = 'all'\npg_stat_statements.max = 100000\nextension_control_path = '${join(out, 'share')}:$system'\n`,
    scope: 'Measurement-only external module/config/control paths; release artifact unchanged; no role grants widened' }
  writeFileSync(join(out, 'observer.json'), JSON.stringify(record, null, 2) + '\n')
  return record
}

export async function proveManagedObserver(options) {
  const record = prepareManagedSqlObserver(options), work = join(options.out, 'fixture'), data = join(work, 'data'), socket = join(work, 'socket')
  mkdirSync(socket, { recursive: true, mode: 0o700 })
  if (Buffer.byteLength(join(socket, '.s.PGSQL.55419')) > 100) throw new Error('Observer fixture path too long')
  const require = createRequire(new URL('../../../packages/api/package.json', import.meta.url)), pg = require('pg')
  const command = (name, args) => {
    const result = spawnSync(join(options.artifactDirectory, 'bin', name), args, { encoding: 'utf8', timeout: 30_000 })
    writeFileSync(join(options.out, `${name}-${Date.now()}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
    if (result.status !== 0) throw new Error(`${name} failed: ${result.error?.message ?? result.stderr}`)
  }
  let observer, runtime, started = false
  record.compatibilityStartedAt = new Date().toISOString()
  try {
    command('initdb', ['-D', data, '--auth=trust', '--no-locale', '--encoding=UTF8'])
    writeFileSync(join(data, 'postgresql.auto.conf'), record.config)
    command('pg_ctl', ['-D', data, '-l', join(options.out, 'postgres.log'), '-o', `-k ${socket} -p 55419 -c listen_addresses=''`, 'start']); started = true
    observer = new pg.Client({ host: socket, port: 55419, database: 'postgres' }); await observer.connect()
    await observer.query(`CREATE EXTENSION pg_stat_statements;CREATE ROLE m6_observer_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
      CREATE FUNCTION m6_observer_nested() RETURNS integer LANGUAGE plpgsql AS 'BEGIN PERFORM 1; RETURN 7; END';`)
    record.actual = (await observer.query(`SELECT version(),current_setting('shared_preload_libraries') AS preload,
      current_setting('extension_control_path') AS control_path,current_setting('pg_stat_statements.track') AS track,
      (SELECT extversion FROM pg_extension WHERE extname='pg_stat_statements') AS extension_version`)).rows[0]
    runtime = new pg.Client({ host: socket, port: 55419, database: 'postgres' }); await runtime.connect()
    await runtime.query('SET ROLE m6_observer_runtime')
    record.runtimeRole = (await runtime.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    await observer.query('SELECT pg_stat_statements_reset()')
    const before = await snapshotStatements(observer)
    record.received = (await runtime.query('SELECT m6_observer_nested() AS value')).rows
    record.sql = statementDelta(before, await snapshotStatements(observer))
    const observerBefore = await snapshotStatements(observer)
    const overheadMs = []
    for (let n = 0; n < 3; n++) { const start = performance.now(); await snapshotStatements(observer); overheadMs.push(performance.now() - start) }
    record.observerOnly = { snapshots: 3, elapsedMs: overheadMs, delta: statementDelta(observerBefore, await snapshotStatements(observer)),
      scope: 'No runtime action between snapshots; read-only calibration of residual observer counts and observer query cost, not application latency' }
    record.compatible = record.received[0].value === 7 && record.sql.nested.calls > 0 && !record.runtimeRole.rolsuper && !record.runtimeRole.rolbypassrls
  } catch (error) { record.failure = { name: error.name, message: error.message }; record.compatible = false }
  finally {
    await runtime?.end().catch(() => {}); await observer?.end().catch(() => {})
    if (started) command('pg_ctl', ['-D', data, '-m', 'fast', 'stop'])
    rmSync(work, { recursive: true, force: true })
    record.disposed = true; record.compatibilityFinishedAt = new Date().toISOString()
    record.artifactUnchanged = record.artifactManifestSha256 === sha(join(options.artifactDirectory, 'manifest.json')) && record.postgresSha256 === sha(join(options.artifactDirectory, 'bin/postgres'))
    writeFileSync(join(options.out, 'compatibility.json'), JSON.stringify(record, null, 2) + '\n')
  }
  return record
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = {}
  for (let i = 2; i < process.argv.length; i++) {
    const key = { '--artifact': 'artifactDirectory', '--source': 'sourceDirectory', '--tarball': 'tarball', '--out': 'out' }[process.argv[i]]
    if (!key || !process.argv[i + 1]) throw new Error('Supply --artifact, --source, --tarball and --out')
    opts[key] = resolve(process.argv[++i])
  }
  const result = await proveManagedObserver(opts)
  console.log(JSON.stringify({ compatible: result.compatible, artifactUnchanged: result.artifactUnchanged, disposed: result.disposed, out: opts.out, failure: result.failure }))
  if (!result.compatible || !result.artifactUnchanged) process.exitCode = 1
}
