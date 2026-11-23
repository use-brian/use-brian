import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, expect, it, vi } from 'vitest'
import { getAppPool, getPool } from '../client.js'
import { createDbDocPageSourceStore } from '../doc-page-source-store.js'
import { createDbRetrievalStore } from '../retrieval-store.js'
import { createWorkspaceStore } from '../workspace-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

afterAll(() => Promise.all([pool.end(), getAppPool().end()]))

it('[COMP:api/doc-page-source-store] reconciles changed blocks, scope and the ingest stamp atomically', async () => {
  const ownerUserId = randomUUID(), pageId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [ownerUserId])
  const { id: workspaceId } = await createWorkspaceStore().create(ownerUserId, 'Page store fixture', 'Authored blocks')
  const assistant = await pool.query("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary'", [workspaceId])
  const actor = { workspaceId, userId: ownerUserId, assistantId: assistant.rows[0].id, assistantKind: 'primary', clearance: 'confidential' } as const
  const retrieval = createDbRetrievalStore()
  const findEdited = () => retrieval.search(actor, { query: 'Edited', scope: 'kb_chunk' })
  await pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,clearance)
    VALUES($1,$2,$3,'Reading list','companies','table','internal')`, [pageId, workspaceId, ownerUserId])
  const chunks = Array.from({ length: 300 }, (_, i) => ({
    pageId, blockId: String(i), sectionEpisodeId: null, text: 'Sample ' + i, contentHash: 'fixture-' + i,
  }))
  const input = { pageId, workspaceId, ownerUserId, version: 1, collaborative: false, teamspaceId: null,
    sensitivity: 'internal', contentHash: 'first', chunks }
  const store = createDbDocPageSourceStore()
  await store.upsertPageChunks(input)
  const read = async () => (await pool.query(
    "SELECT source_path,chunk_text,xmin::text AS revision FROM kb_chunks WHERE workspace_id=$1 AND source='doc_page' ORDER BY source_path",
    [workspaceId],
  )).rows
  await pool.query(`UPDATE kb_chunks SET embedding_failed_at=now(), embedding=$2
    WHERE workspace_id=$1`, [workspaceId, JSON.stringify(Array(768).fill(0.1))])
  const initial = await read()
  expect(initial).toHaveLength(300)
  await pool.query('UPDATE saved_views SET version=2 WHERE id=$1', [pageId])
  const edited = [{ ...chunks[0], text: 'Edited', contentHash: 'changed' }, ...chunks.slice(1, -1)]
  const current = { ...input, version: 2, contentHash: 'second', chunks: edited }
  const statements = vi.spyOn(pg.Client.prototype, 'query')
  try {
    await store.upsertPageChunks(current)
    const writes = statements.mock.calls.map(args => String(args[0])).filter(sql => /^(INSERT INTO|DELETE FROM) kb_chunks/.test(sql))
    expect(writes).toHaveLength(2)
  } finally {
    statements.mockRestore()
  }
  const updated = await read()
  expect(updated).toHaveLength(299)
  expect(updated[0].chunk_text).toBe('Edited')
  expect((await findEdited()).data).toMatchObject([{ source_path: pageId + '#0' }])
  const prior = new Map(initial.map(row => [row.source_path, row.revision]))
  expect(updated.filter(row => row.revision !== prior.get(row.source_path))).toHaveLength(1)
  const embeddings = await pool.query(`SELECT chunk_text,embedding IS NULL AS reset, embedding_failed_at IS NULL AS retry
    FROM kb_chunks WHERE workspace_id=$1 AND source_path=ANY($2::text[]) ORDER BY source_path`,
    [workspaceId, [pageId + '#0', pageId + '#1']])
  expect(embeddings.rows).toEqual([
    { chunk_text: 'Edited', reset: true, retry: true }, { chunk_text: 'Sample 1', reset: false, retry: false },
  ])
  const episodeId = randomUUID()
  await pool.query(`INSERT INTO episodes(id,workspace_id,source_kind,source_ref,occurred_at,created_by_user_id,user_id)
    VALUES($1,$2,'doc_page','{}',now(),$3,$3)`, [episodeId, workspaceId, ownerUserId])
  const provenance = { ...current, chunks: edited.map(block => ({ ...block, sectionEpisodeId: episodeId })) }
  await store.upsertPageChunks(provenance)
  expect((await pool.query(`SELECT source_episode_id,embedding IS NOT NULL AS embedded
    FROM kb_chunks WHERE workspace_id=$1 AND source_path=$2`, [workspaceId, pageId + '#1'])).rows)
    .toEqual([{ source_episode_id: episodeId, embedded: true }])
  const republished = await read()
  // The stamp and prune must roll back if any incoming row is invalid.
  await expect(store.upsertPageChunks({ ...current, contentHash: 'invalid',
    chunks: [{ ...edited[0], sectionEpisodeId: 'invalid UUID' }] })).rejects.toThrow()
  expect((await pool.query('SELECT brain_last_ingest_hash FROM saved_views WHERE id=$1', [pageId])).rows[0].brain_last_ingest_hash)
    .toBe('second')
  await expect(store.upsertPageChunks({ ...input, chunks: [] })).rejects.toThrow('page_source_changed')
  await expect(store.upsertPageChunks({ ...current, collaborative: true })).rejects.toThrow('page_source_changed')
  expect(await read()).toEqual(republished)
  await pool.query("UPDATE saved_views SET clearance='confidential' WHERE id=$1", [pageId])
  await expect(store.upsertPageChunks(current)).rejects.toThrow('page_source_changed')
  await store.upsertPageChunks({ ...current, sensitivity: 'confidential' })
  expect((await pool.query('SELECT DISTINCT sensitivity FROM kb_chunks WHERE workspace_id=$1', [workspaceId])).rows)
    .toEqual([{ sensitivity: 'confidential' }])
  await store.upsertPageChunks({ ...current, sensitivity: 'confidential', contentHash: 'empty', chunks: [] })
  expect(await read()).toEqual([])
  expect((await findEdited()).data).toEqual([])
  expect((await pool.query('SELECT brain_last_ingest_hash AS hash FROM saved_views WHERE id=$1', [pageId])).rows)
    .toEqual([{ hash: 'empty' }])
})
