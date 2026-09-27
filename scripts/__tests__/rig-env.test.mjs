import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DEFAULT_DATABASE_URL, maskUrl, readDotEnvValue, resolveRigDatabase } from '../rig-env.mjs'

const root = '/repo/brian-platform/use-brian'
/** A readText stub: one canned `.env` body at <root>/.env, nothing elsewhere. */
const dotenv = (body) => (path) => (path === `${root}/.env` ? body : null)
const none = () => null

describe('[COMP:platform/local-rig] local rig database resolution', () => {
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
