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
  try {
    await original.exec('CREATE TABLE fixture_probe(id int); INSERT INTO fixture_probe VALUES (1)')
    await assert.rejects(savePreparedPglite(original, path, 'stale'), /Source changed/)
    await savePreparedPglite(original, path, await preparedIdentity())
    copies.push(await loadPreparedPglite(path), await loadPreparedPglite(path))
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
