import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { loadPreparedPglite, preparedIdentity, savePreparedPglite } from './prepared-pglite.js'

test('[COMP:ci/execution-topology] prepared PGlite isolates copies and rejects stale/tampered images', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brian-pglite-proof-'))
  const path = join(directory, 'image.tar'), original = new PGlite()
  const copies: PGlite[] = []
  const installedCatalog = `SELECT c.oid AS relation, p.oid AS routine, c.relowner AS owner, p.proacl AS acl
    FROM pg_class c, pg_proc p
    WHERE c.oid = 'public.fixture_probe'::regclass AND p.oid = 'public.fixture_probe_read()'::regprocedure`
  try {
    await original.exec(`
      CREATE ROLE fixture_owner NOSUPERUSER NOBYPASSRLS;
      CREATE TABLE fixture_probe(id int);
      ALTER TABLE fixture_probe OWNER TO fixture_owner;
      INSERT INTO fixture_probe VALUES (1);
      CREATE FUNCTION fixture_probe_read() RETURNS int LANGUAGE sql AS 'SELECT 1';
      ALTER FUNCTION fixture_probe_read() OWNER TO fixture_owner;
      REVOKE ALL ON FUNCTION fixture_probe_read() FROM PUBLIC;
      SET ROLE fixture_owner;
    `)
    const catalog = (await original.query(installedCatalog)).rows
    assert.equal(catalog.length, 1)
    await assert.rejects(savePreparedPglite(original, path, 'stale'), /Source changed/)
    await savePreparedPglite(original, path, await preparedIdentity())
    copies.push(await loadPreparedPglite(path), await loadPreparedPglite(path))
    for (const copy of copies) {
      assert.deepEqual((await copy.query(installedCatalog)).rows, catalog)
      assert.deepEqual((await copy.query('SELECT current_user = session_user AS bootstrap')).rows, [{ bootstrap: true }])
    }
    await copies[0].exec('INSERT INTO fixture_probe VALUES (2)')
    assert.deepEqual((await copies[1].query('SELECT * FROM fixture_probe')).rows, [{ id: 1 }])
    const manifest = await readFile(`${path}.json`, 'utf8')
    await writeFile(`${path}.json`, JSON.stringify({ ...JSON.parse(manifest), identity: 'stale' }))
    await assert.rejects(loadPreparedPglite(path), /mismatch/)
    await writeFile(`${path}.json`, manifest)
    await writeFile(path, 'tampered')
    await assert.rejects(loadPreparedPglite(path), /mismatch/)
  } finally {
    await Promise.all([...copies, original].map(db => db.close()))
    await rm(directory, { recursive: true, force: true })
  }
})
