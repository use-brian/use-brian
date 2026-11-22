import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import pg from 'pg'
import { createLocalFixture } from '../local-fixture.mjs'

test('[COMP:api/knowledge-store] source path upgrade preserves existing identities and fences old sync runs', async () => {
  const workspaceId = randomUUID()
  const userId = randomUUID()
  const sourceId = randomUUID()
  const peerId = randomUUID()
  const heldId = randomUUID()
  const entryId = randomUUID()
  const chunkId = randomUUID()
  const pageChunkId = randomUUID()
  const orphanChunkId = randomUUID()
  const oldLease = randomUUID()
  const newLease = randomUUID()
  const recordedAt = '2026-04-01T00:00:00.000Z'
  const checkpoint = 'fixture-previous-head'
  const error = 'knowledge_source_target_conflict'
  let fixture
  let client

  try {
    fixture = await createLocalFixture({
      pgBin: process.env.PG_BIN,
      beforeApplyFile: '8339_knowledge_source_path_identity.sql',
      beforeApply: async ({ adminUrl }) => {
        const seed = new pg.Client({ connectionString: adminUrl })
        await seed.connect()
        try {
          await seed.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
          await seed.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Knowledge upgrade',$2)", [workspaceId, userId])
          await seed.query(`INSERT INTO workspace_knowledge_sources(id,workspace_id,source_type,repo,last_synced_sha,last_synced_at,sync_error,sync_run_id,sync_lease_until,binding_held)
            VALUES($1,$4,'github','fixture/source',$5,$6,$7,$8,clock_timestamp()+interval '15 minutes',false),
                  ($2,$4,'github','fixture/peer',$5,$6,NULL,NULL,NULL,false),
                  ($3,$4,'github','fixture/held',$5,$6,NULL,NULL,NULL,true)`,
          [sourceId, peerId, heldId, workspaceId, checkpoint, recordedAt, error, oldLease])
          await seed.query(`INSERT INTO knowledge_entries(id,workspace_id,path,title,content,source_id,source_sha,updated_at)
            VALUES($1,$2,'readme','Original','Original body',$3,$4,$5)`, [entryId, workspaceId, sourceId, checkpoint, recordedAt])
          await seed.query(`INSERT INTO kb_chunks(id,workspace_id,source_path,chunk_text,user_id,created_by_user_id,source,updated_at)
            VALUES($1,$4,'readme','Linked',$5,$5,'user',$6), ($2,$4,'readme','Page',$5,$5,'doc_page',$6),
                  ($3,$4,'gone','Unmatched',$5,$5,'user',$6)`, [chunkId, pageChunkId, orphanChunkId, workspaceId, userId, recordedAt])
        } finally {
          await seed.end()
        }
      },
    })
    client = new pg.Client({ connectionString: fixture.adminUrl })
    await client.connect()

    const { rows: sources } = await client.query(`SELECT id,last_synced_sha,last_synced_at,sync_error,sync_dirty,sync_run_id,sync_lease_until,binding_held
      FROM workspace_knowledge_sources WHERE workspace_id=$1`, [workspaceId])
    assert.equal(sources.length, 3)
    for (const source of sources) {
      assert.equal(source.last_synced_sha, checkpoint)
      assert.equal(source.last_synced_at.toISOString(), recordedAt)
      assert.equal(source.sync_error, source.id === sourceId ? error : null)
      assert.equal(source.sync_dirty, source.id !== heldId)
      assert.equal(source.binding_held, source.id === heldId)
      assert.equal(source.sync_run_id, null)
      assert.equal(source.sync_lease_until, null)
    }
    const { rows: [entry] } = await client.query('SELECT id,source_id,source_sha,updated_at FROM knowledge_entries WHERE workspace_id=$1', [workspaceId])
    assert.deepEqual(entry, { id: entryId, source_id: sourceId, source_sha: checkpoint, updated_at: new Date(recordedAt) })
    const { rows: chunks } = await client.query('SELECT id,knowledge_entry_id,updated_at FROM kb_chunks WHERE workspace_id=$1', [workspaceId])
    assert.equal(chunks.length, 3)
    for (const chunk of chunks) {
      assert.equal(chunk.knowledge_entry_id, chunk.id === chunkId ? entryId : null)
      assert.equal(chunk.updated_at.toISOString(), recordedAt)
    }

    const capture = { workspaceId, bindingVersion: '1', lastSyncedSha: checkpoint, branch: 'main', rootPath: '',
      sourceType: 'github', connectorInstanceId: null, bindingSensitivity: null, bindingCompartments: null, bindingProjectIds: null }
    const mutate = (id, expected, values) => client.query('SELECT id FROM apply_knowledge_source_sync_worker($1,$2)', [
      { workspaceId, sourceId: id, sourceSha: 'fixture-head', sensitivity: 'internal', path: 'readme',
        title: 'Peer', content: 'Peer body', compartments: [], projectIds: [], tags: [], ...values }, expected,
    ])
    await assert.rejects(mutate(sourceId, { ...capture, id: sourceId, repo: 'fixture/source', syncRunId: oldLease }, { operation: 'checkpoint' }),
      /knowledge_source_changed/)
    const peerCapture = { ...capture, id: peerId, repo: 'fixture/peer', syncRunId: newLease }
    const { rows: [claimed] } = await client.query('SELECT sync_dirty FROM claim_knowledge_source_sync_worker($1,$2,$3,$4)',
      [workspaceId, peerId, newLease, peerCapture])
    assert.equal(claimed.sync_dirty, true)

    const { rows: [created] } = await mutate(peerId, peerCapture)
    const { rows: [updated] } = await mutate(peerId, peerCapture, { content: 'Peer body updated' })
    assert.equal(updated.id, created.id)
    assert.notEqual(updated.id, entryId)
    await client.query("INSERT INTO knowledge_entries(workspace_id,path,title,content) VALUES($1,'readme','Manual','Manual body')", [workspaceId])
    await assert.rejects(client.query("INSERT INTO knowledge_entries(workspace_id,path,title,content) VALUES($1,'readme','Duplicate','Duplicate body')", [workspaceId]),
      { code: '23505', constraint: 'knowledge_entries_workspace_source_path_key' })
    await assert.rejects(client.query('DELETE FROM workspace_knowledge_sources WHERE id=$1', [sourceId]),
      { code: '23503', constraint: 'knowledge_entries_source_id_fkey' })
    assert.deepEqual((await client.query('SELECT content,scope_held FROM knowledge_entries WHERE id=$1', [entryId])).rows,
      [{ content: 'Original body', scope_held: false }])
    assert.deepEqual((await client.query('SELECT native_turn_helpers_current() AS turns,native_retained_helpers_current() AS retained,native_turn_publication_contract() AS publication')).rows,
      [{ turns: true, retained: true, publication: true }])
  } finally {
    await client?.end()
    await fixture?.dispose()
  }
})
