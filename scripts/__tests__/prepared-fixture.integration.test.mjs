import { test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { assertLocalFixture, cloneLocalFixture } from '../crm/local-fixture.mjs'

test('[COMP:ci/execution-topology] prepared clones isolate writes and preserve the parent', async () => {
  const marker = await assertLocalFixture()
  const parent = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await parent.connect()
  const clones = []
  try {
    const expectedOwner = { role: 'assurance_owner', rolsuper: !marker.bootstrapRole, rolbypassrls: !marker.bootstrapRole }
    const ownerRole = client => client.query('SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    assert.deepEqual((await ownerRole(parent)).rows, [expectedOwner])
    if (marker.bootstrapRole) {
      assert.deepEqual((await parent.query("SELECT extname,pg_get_userbyid(extowner) AS owner FROM pg_extension WHERE extname IN('pg_trgm','vector') ORDER BY extname")).rows,
        ['pg_trgm', 'vector'].map(extname => ({ extname, owner: 'assurance_owner' })))
      assert.equal((await parent.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname='assurance_extension_bootstrap'")).rows[0].n, 0)
    }
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
        assert.deepEqual((await ownerRole(db)).rows, [expectedOwner])
        assert.equal((await db.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()')).rows[0].owner, 'assurance_owner')
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
