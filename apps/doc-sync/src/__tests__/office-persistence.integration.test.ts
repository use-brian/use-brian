import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { yDocToSnapshot, type DocumentSnapshot, type OfficeArtifactSnapshot } from '@use-brian/office-model'
import { createOfficeArtifactStore } from '@use-brian/api/db/office-artifacts.js'
import { getAppPool, getPool } from '@use-brian/api/db/client.js'
import { officeSnapshotUpdate, storeOfficeSnapshot } from '../office-collab.js'

const { assertLocalFixture } = await import(new URL('../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const artifacts = createOfficeArtifactStore()
afterAll(async () => { await getAppPool().end(); await pool.end() })

function snapshot(artifactId: string, workspaceId: string, title: string): DocumentSnapshot {
  return {
    schemaVersion: 1, capabilityVersion: 1, artifactId, workspaceId, family: 'document',
    locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: null, rootId: randomUUID(),
    title, resources: [], accessibility: { title }, sections: [{ id: randomUUID(),
      page: { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72, orientation: 'portrait' },
      header: [], footer: [], showPageNumber: false, nodes: [],
    }],
  }
}

const hash = (value: OfficeArtifactSnapshot) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const doc = (value: DocumentSnapshot) => {
  const result = new Y.Doc()
  Y.applyUpdate(result, officeSnapshotUpdate(value))
  return result
}

describe('[COMP:doc-sync/office-collab] PostgreSQL head fencing', () => {
  it('keeps an old room from adopting a newer head and permits only its exact canonical replacement', async () => {
    const workspaceId = randomUUID(), owner = randomUUID(), file1 = randomUUID(), file2 = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [owner])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Office live fixture',$2)", [workspaceId, owner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId, owner])
    const artifact = await artifacts.createShell({ userId: owner, workspaceId, family: 'document', title: 'Live fixture', templateVersionId: null, capabilityVersion: 1, sensitivity: 'internal' })
    const first = snapshot(artifact.id, workspaceId, 'First head')
    await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri) VALUES($1,$2,'/first.json','first.json','fixture://first'),($3,$2,'/second.json','second.json','fixture://second')", [file1, workspaceId, file2])
    const v1 = await artifacts.commitVersion({ userId: owner, artifactId: artifact.id, snapshotTitle: first.title, expectedVersion: 0, snapshotFileId: file1, snapshotHash: hash(first), operationClock: new Uint8Array(), schemaVersion: 1, capabilityVersion: 1, origin: 'manual', authorType: 'user', authorUserId: owner, summary: 'First fixture head' })
    if (!v1) throw new Error('first version missing')
    const firstDoc = doc(first)
    await storeOfficeSnapshot({ artifactId: artifact.id, ydoc: firstDoc, committedHead: { version: 1, snapshotHash: hash(first) }, query: async (sql, params) => (await pool.query(sql, params)).rows })

    const liveEdit = { ...first, title: 'Authorized live edit', accessibility: { title: 'Authorized live edit' } }
    const liveDoc = doc(liveEdit)
    const liveReceipt = await storeOfficeSnapshot({ artifactId: artifact.id, ydoc: liveDoc, expectedBaseVersion: 1, query: async (sql, params) => (await pool.query(sql, params)).rows })
    const second = { ...first, title: 'Second immutable head', accessibility: { title: 'Second immutable head' } }
    const secondDoc = doc(second)
    const secondHeadHash = hash(second)
    const v2 = await artifacts.commitVersion({ userId: owner, artifactId: artifact.id, snapshotTitle: second.title, expectedVersion: 1, snapshotFileId: file2, snapshotHash: secondHeadHash, operationClock: new Uint8Array(), schemaVersion: 1, capabilityVersion: 1, origin: 'ai', authorType: 'system', summary: 'Second fixture head' })
    if (!v2) throw new Error('second version missing')

    await expect(storeOfficeSnapshot({ artifactId: artifact.id, ydoc: liveDoc, expectedBaseVersion: 1, query: async (sql, params) => (await pool.query(sql, params)).rows })).rejects.toThrow(/base no longer matches/)
    expect((await pool.query('SELECT base_version::int AS base,canonical_hash AS hash FROM office_collab_documents WHERE artifact_id=$1', [artifact.id])).rows).toEqual([{ base: 1, hash: liveReceipt.hash }])

    const replacement = await storeOfficeSnapshot({ artifactId: artifact.id, ydoc: secondDoc, committedHead: { version: 2, snapshotHash: secondHeadHash }, query: async (sql, params) => (await pool.query(sql, params)).rows })
    expect(replacement.baseVersion).toBe(2)
    expect(replacement.hash).toBe(hash(yDocToSnapshot(secondDoc)))
    expect((await pool.query('SELECT base_version::int AS base,canonical_hash AS hash FROM office_collab_documents WHERE artifact_id=$1', [artifact.id])).rows).toEqual([{ base: 2, hash: replacement.hash }])

    const wrongWorkspace = doc({ ...second, workspaceId: randomUUID() })
    await expect(storeOfficeSnapshot({ artifactId: artifact.id, ydoc: wrongWorkspace, expectedBaseVersion: 2, query: async (sql, params) => (await pool.query(sql, params)).rows })).rejects.toThrow(/base no longer matches/)
    expect((await pool.query('SELECT base_version::int AS base,canonical_hash AS hash FROM office_collab_documents WHERE artifact_id=$1', [artifact.id])).rows).toEqual([{ base: 2, hash: replacement.hash }])

    await pool.query('DELETE FROM office_collab_documents WHERE artifact_id=$1', [artifact.id])
    await expect(storeOfficeSnapshot({ artifactId: artifact.id, ydoc: liveDoc, expectedBaseVersion: 1, query: async (sql, params) => (await pool.query(sql, params)).rows })).rejects.toThrow(/base no longer matches/)
    expect((await pool.query('SELECT artifact_id FROM office_collab_documents WHERE artifact_id=$1', [artifact.id])).rows).toEqual([])
    await expect(storeOfficeSnapshot({ artifactId: artifact.id, ydoc: secondDoc, committedHead: { version: 2, snapshotHash: secondHeadHash }, query: async (sql, params) => (await pool.query(sql, params)).rows })).resolves.toMatchObject({ baseVersion: 2 })

    firstDoc.destroy(); liveDoc.destroy(); secondDoc.destroy(); wrongWorkspace.destroy()
  })
})
