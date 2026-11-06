import { test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { assertLocalFixture, cloneLocalFixture } from '../crm/local-fixture.mjs'

test('[COMP:ci/execution-topology] prepared clones isolate writes and preserve the parent', async () => {
  await assertLocalFixture()
  const parent = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await parent.connect()
  const clones = []
  try {
    await parent.query('CREATE TABLE ci_parent_probe(id int)')
    const first = await cloneLocalFixture(), second = await cloneLocalFixture()
    clones.push(first, second)
    await assertLocalFixture(first.env)
    await assert.rejects(assertLocalFixture({ ...first.env, BRIAN_ASSURANCE_TOKEN: 'wrong' }), /token mismatch/)
    await assert.rejects(cloneLocalFixture({ ...process.env, BRIAN_ASSURANCE_TEMPLATE: 'postgres' }), /no prepared template/)
    for (const [index, fixture] of clones.entries()) {
      const db = new pg.Client({ connectionString: fixture.adminUrl })
      await db.connect()
      try {
        assert.equal((await db.query("SELECT to_regclass('ci_parent_probe') AS table_name")).rows[0].table_name, null)
        assert.equal((await db.query("SELECT to_regclass('ci_clone_probe') AS table_name")).rows[0].table_name, null)
        if (index === 0) await db.query('CREATE TABLE ci_clone_probe(id int)')
        assert.ok((await db.query('SELECT count(*)::int AS count FROM _migrations')).rows[0].count > 0)
      } finally { await db.end() }
      const app = new pg.Client({ connectionString: fixture.appUrl })
      await app.connect()
      try { assert.deepEqual((await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows, [{ rolsuper: false, rolbypassrls: false }]) }
      finally { await app.end() }
    }
    await first.dispose(); await first.dispose()
    assert.equal((await parent.query('SELECT count(*)::int AS count FROM ci_parent_probe')).rows[0].count, 0)
    await assertLocalFixture(second.env)
  } finally {
    await Promise.all(clones.map(fixture => fixture.dispose()))
    await parent.query('DROP TABLE IF EXISTS ci_parent_probe')
    await parent.end()
  }
})
