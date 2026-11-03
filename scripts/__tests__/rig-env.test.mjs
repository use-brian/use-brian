import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { DEFAULT_DATABASE_URL, maskUrl, readDotEnvValue, resolveRigDatabase, rigRuntimeDatabase } from '../rig-env.mjs'

const root = '/repo/brian-platform/use-brian'
/** A readText stub: one canned `.env` body at <root>/.env, nothing elsewhere. */
const dotenv = (body) => (path) => (path === `${root}/.env` ? body : null)
const none = () => null
const apiRequire = createRequire(new URL('../../packages/api/package.json', import.meta.url))
const pgRequire = createRequire(apiRequire.resolve('pg'))
const { parse: parsePgConnection } = pgRequire('pg-connection-string')

describe('[COMP:platform/local-rig] local rig database resolution', () => {
  test('normal runtime connects to the same database as a restricted role with an independent secret', () => {
    const db = resolveRigDatabase({ root, env: { DATABASE_URL: 'postgres://owner:owner-secret@127.0.0.1:5999/brain?sslmode=disable' }, readText: none })
    const runtime = rigRuntimeDatabase(db)
    const url = new URL(runtime.url)
    assert.equal(url.username, 'app_user')
    assert.match(url.password, /^[a-f0-9]{64}$/)
    assert.equal(url.password, runtime.password)
    assert.equal(url.host, '127.0.0.1:5999')
    assert.equal(url.pathname, '/brain')
    assert.equal(url.search, '?sslmode=disable')
    assert.notEqual(rigRuntimeDatabase(db).password, runtime.password)
    assert.throws(() => rigRuntimeDatabase({ ...db, isLoopback: false }), /loopback/)
    assert.throws(() => rigRuntimeDatabase(db, "unsafe'password"), /Unsafe/)
  })

  test('the actual normal rig launch environment overrides an inherited owner app connection', () => {
    const rig = readFileSync(new URL('../rig-up.sh', import.meta.url), 'utf8')
    const assignments = rig.slice(rig.indexOf('  launch_env=('), rig.indexOf('  launch_args=()'))
    const runtime = rigRuntimeDatabase(resolveRigDatabase({ root, env: {}, readText: none }))
    const result = spawnSync('bash', ['-c', assignments + '\nenv "${launch_env[@]}" node -e \'console.log(new URL(process.env.DATABASE_URL_APP).username); console.log(new URL(process.env.DATABASE_URL).username)\''], {
      env: { PATH: process.env.PATH, RIG_DB_URL: DEFAULT_DATABASE_URL, RIG_APP_DB_URL: runtime.url,
        DATABASE_URL_APP: DEFAULT_DATABASE_URL, API_PORT_FILE: '/dev/null', API_PORT: '4100', CORE_ONLY: '1' },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'app_user\nbrian')
  })
  test('query credentials cannot override the canonical runtime login', () => {
    const db = resolveRigDatabase({ root, env: { DATABASE_URL: 'postgres://owner:owner-secret@127.0.0.1:5999/brain?user=owner&password=query-secret&sslmode=disable' }, readText: none })
    const runtime = rigRuntimeDatabase(db)
    const parsed = parsePgConnection(runtime.url)
    assert.equal(parsed.user, 'app_user')
    assert.equal(parsed.password, runtime.password)
    assert.equal(parsed.host, '127.0.0.1')
    assert.equal(parsed.port, '5999')
    assert.equal(parsed.database, 'brain')
    assert.equal(parsed.ssl, false)
  })
  test('administrative mode cannot inherit a real database or dotenv URL', () => {
    const db = resolveRigDatabase({ root,
      env: { USEBRIAN_ADMIN_ONLY: '1', DATABASE_URL: 'postgres://remote.example/real' },
      readText: () => { throw new Error('must not read dotenv for admin database') },
    })
    assert.equal(db.source, 'admin-fixture')
    assert.equal(db.database, 'usebrian_admin_test')
    assert.equal(db.port, '5443')
    assert.equal(db.host, '127.0.0.1')
  })

  test('the shell environment wins over .env', () => {
    const db = resolveRigDatabase({
      root,
      env: { DATABASE_URL: 'postgres://a:b@127.0.0.1:5999/shell' },
      readText: dotenv('DATABASE_URL=postgres://c:d@127.0.0.1:5442/file'),
    })
    assert.equal(db.source, 'env')
    assert.equal(db.database, 'shell')
    assert.equal(db.port, '5999')
  })

  test('falls back to .env, then to the rig default', () => {
    const fromFile = resolveRigDatabase({
      root,
      env: {},
      readText: dotenv('# brain\nDATABASE_URL=postgres://c:d@127.0.0.1:5442/usebrian\n'),
    })
    assert.equal(fromFile.source, 'dotenv')
    assert.equal(fromFile.user, 'c')
    assert.equal(fromFile.password, 'd')

    const fallback = resolveRigDatabase({ root, env: {}, readText: none })
    assert.equal(fallback.source, 'default')
    assert.equal(fallback.url, DEFAULT_DATABASE_URL)
    assert.equal(fallback.port, '5442')
    assert.equal(fallback.database, 'usebrian')
  })

  test('reads .env the way the launcher does', () => {
    // Quoted value keeps a `#` that would otherwise read as a comment.
    assert.equal(
      readDotEnvValue('DATABASE_URL="postgres://u:pa#ss@127.0.0.1:5442/db"', 'DATABASE_URL'),
      'postgres://u:pa#ss@127.0.0.1:5442/db',
    )
    // Unquoted value drops an inline comment, and `export ` is tolerated.
    assert.equal(
      readDotEnvValue('export DATABASE_URL=postgres://127.0.0.1:5442/db # the brain', 'DATABASE_URL'),
      'postgres://127.0.0.1:5442/db',
    )
    // Last assignment wins, as a shell would.
    assert.equal(
      readDotEnvValue('DATABASE_URL=first\nOTHER=x\nDATABASE_URL=second', 'DATABASE_URL'),
      'second',
    )
    assert.equal(readDotEnvValue('OTHER=x', 'DATABASE_URL'), null)
  })

  test('percent-encoded credentials are decoded for the container', () => {
    const db = resolveRigDatabase({
      root,
      env: { DATABASE_URL: 'postgres://us%40r:p%3Ass@127.0.0.1:5442/usebrian' },
      readText: none,
    })
    assert.equal(db.user, 'us@r')
    assert.equal(db.password, 'p:ss')
  })

  test('only a loopback host may be managed', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const url = host === '::1' ? `postgres://u:p@[${host}]:5442/db` : `postgres://u:p@${host}:5442/db`
      assert.equal(resolveRigDatabase({ root, env: { DATABASE_URL: url }, readText: none }).isLoopback, true, host)
    }
    for (const url of ['postgres://u:p@db.internal:5432/brian', 'postgres://u:p@10.0.0.4:5432/brian']) {
      assert.equal(resolveRigDatabase({ root, env: { DATABASE_URL: url }, readText: none }).isLoopback, false, url)
    }
  })

  test("libpq's socket form is named, not reported as a parse failure", () => {
    // What production actually uses. It is a valid connection string, so the
    // error has to say why the rig cannot own it rather than "not a URL".
    for (const url of [
      'postgres://u:p@/brian?host=/cloudsql/project:region:instance',
      'postgres:///brian?host=/run/postgresql',
    ]) {
      assert.throws(
        () => resolveRigDatabase({ root, env: { DATABASE_URL: url }, readText: none }),
        /unix-socket form/,
        url,
      )
    }
  })

  test('defaults fill in what a sparse URL omits', () => {
    const db = resolveRigDatabase({
      root,
      env: { DATABASE_URL: 'postgres://127.0.0.1/' },
      readText: none,
    })
    assert.equal(db.port, '5432')
    assert.equal(db.database, 'postgres')
    assert.equal(db.user, 'postgres')
    assert.equal(db.password, '')
  })

  test('a non-postgres or unparseable URL is rejected, not guessed at', () => {
    assert.throws(
      () => resolveRigDatabase({ root, env: { DATABASE_URL: 'mysql://u:p@127.0.0.1/db' }, readText: none }),
      /must be a postgres:\/\/ URL/,
    )
    assert.throws(
      () => resolveRigDatabase({ root, env: { DATABASE_URL: 'not a url' }, readText: none }),
      /is not a URL/,
    )
  })

  test('the display form never carries the password', () => {
    assert.equal(
      maskUrl('postgres://brian:s3cret@127.0.0.1:5442/usebrian'),
      'postgres://brian@127.0.0.1:5442/usebrian',
    )
    const db = resolveRigDatabase({
      root,
      env: { DATABASE_URL: 'postgres://brian:s3cret@127.0.0.1:5442/usebrian' },
      readText: none,
    })
    assert.ok(!db.display.includes('s3cret'))
  })
})
