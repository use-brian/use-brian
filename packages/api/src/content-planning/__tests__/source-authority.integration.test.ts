/** Real migrated database: selected-source authority is not mocked. */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getPool, query } from '../../db/client.js'
import { executeFeedCommands, getFeedCollaboration, withFeedTransaction, type FeedActor } from '../../db/feed-collaboration-store.js'
import { postWorkingCopiesStore, type PostWorkingContent } from '../../db/post-working-copies.js'
import { createMemory } from '../../db/memories.js'
import { readFeedSelectedSources, guardFeedStream } from '../source-authority.js'
import { assertFeedSavedReady, readFeedSaveProjection } from '../projection.js'
import { confirmFeedPost } from '../confirmation.js'
import { readFeedPostHistory } from '../post-history.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
afterAll(async () => { await app.end(); await getPool().end() })

async function fixture() {
  const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID(), sessionId = randomUUID()
  await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [userId])
  await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Selected source fixture','test',$2)", [workspaceId, userId])
  await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId, userId])
  await query("INSERT INTO assistants(id,name,workspace_id,kind,app_type,owner_user_id,clearance) VALUES($1,'Public Feed',$2,'app','distribution',$3,'public')", [assistantId, workspaceId, userId])
  const actor: FeedActor = { userId, assistantId, sessionId, kind: 'user' }
  const content: PostWorkingContent = { title: 'Example draft', privateBrief: '', text: 'A reviewed public statement.', postFormat: 'post', threadSegments: [], article: { sourceUrl: '', title: '', description: '' }, media: [] }
  await postWorkingCopiesStore.put(assistantId, sessionId, userId, { revision: 0, mutationId: randomUUID(), content, create: { platform: 'linkedin' } })
  await executeFeedCommands(actor, { mutationId: randomUUID(), expectedRevision: 1, commands: [{ kind: 'upgrade', seed: randomUUID() }] })
  const file = async (sensitivity = 'internal', compartments: string[] = []) => (await query<{ id: string }>("INSERT INTO workspace_files(workspace_id,path,name,mime,storage_uri,sensitivity,compartments) VALUES($1,$2,'Reference','image/webp','file:///fixture',$3,$4) RETURNING id", [workspaceId, `/${randomUUID()}.webp`, sensitivity, compartments])).rows[0]!.id
  const memory = async (sensitivity: 'internal' | 'confidential' = 'confidential', compartments: string[] = []) => (await createMemory({ assistantId, workspaceId, userId: null, createdByUserId: userId, scope: 'workspace', summary: 'Selected research', sensitivity, compartments, source: 'manual' })).id
  return { actor, workspaceId, file, memory }
}
async function attach(actor: FeedActor, fileId: string, kind: 'user' | 'assistant' = 'user') {
  const copy = (await getFeedCollaboration(actor)).copy!
  const composition = copy.content.composition!
  const block = composition.segments[0]!.content[0]!
  return executeFeedCommands({ ...actor, kind }, { mutationId: randomUUID(), expectedRevision: copy.revision, commands: [{ kind: 'edit', edits: [{ kind: 'replaceBlock', segmentId: composition.segments[0]!.id, blockId: block.attrs.id, preimage: block, replacement: [block, { type: 'image', attrs: { id: randomUUID(), fileId, mimeType: 'image/webp', placement: 'attachment', alt: '' } }] }] }] })
}

describe('[COMP:feed/source-authority] exact selection, isolation, provenance and release', () => {
  it('does not let a v2 workspace owner select department sources without an edge', async () => {
    const f = await fixture(), custodian=randomUUID(), department=randomUUID()
    await query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
    await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[custodian])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'admin','confidential')",[f.workspaceId,custodian])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Research',$3,'team',$1::text,$4)",[department,f.workspaceId,custodian,`team:${department}`])
    await query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Research','team',$3)",[f.workspaceId,`team:${department}`,department])
    const id=await f.file('confidential',[`team:${department}`])
    expect((await query('SELECT compartments FROM workspace_files WHERE id=$1',[id])).rows[0].compartments).toEqual([`team:${department}`])
    expect((await query("SELECT feed_member_source_allows($1,$2,'confidential',$3,NULL) AS allowed",[f.workspaceId,f.actor.userId,[`team:${department}`]])).rows[0].allowed).toBe(false)
    await expect(attach(f.actor,id)).rejects.toMatchObject({code:'file_not_available_to_draft'})
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,department,f.actor.userId])
    const member=randomUUID()
    await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)",[member])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','public')",[f.workspaceId,member])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,department,member])
    await attach(f.actor,id)
    const copy=(await getFeedCollaboration(f.actor)).copy!
    expect(copy.content.sourceSensitivity).toBe('confidential')
    expect(copy.content.sourceCompartments).toContain(`team:${department}`)
    await executeFeedCommands(f.actor,{mutationId:randomUUID(),expectedRevision:copy.revision,commands:[{kind:'release',audience:'public'}]})
    expect((await query('SELECT sensitivity FROM workspace_files WHERE id=$1',[id])).rows[0].sensitivity).toBe('confidential')
    await query("UPDATE department_edges SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,member])
    await expect(getFeedCollaboration(f.actor)).rejects.toMatchObject({code:'draft_source_access_required'})
    await query("UPDATE department_edges SET clearance='confidential',expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,member])
    expect((await query('SELECT feed_draft_audience_allowed($1) AS allowed',[f.actor.sessionId])).rows[0].allowed).toBe(false)
    await query("UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,member])
    expect((await getFeedCollaboration(f.actor)).copy?.revision).toBe(copy.revision)
    // A source's later release to General cannot erase the draft's saved floor.
    await query("UPDATE workspace_files SET sensitivity='public',compartments='{}' WHERE id=$1",[id])
    await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,member])
    await expect(getFeedCollaboration(f.actor)).rejects.toMatchObject({code:'draft_source_access_required'})
    expect((await app.query('SELECT feed_draft_audience_allowed($1) AS allowed',[f.actor.sessionId])).rows[0].allowed).toBe(false)
    await expect(app.query("SELECT feed_member_source_allows($1,$2,'public','{}',NULL)",[f.workspaceId,member])).rejects.toMatchObject({code:'42501'})
  })
  it('syncs a member-selected Internal image with a Public assistant without declassifying either', async () => {
    const f = await fixture(), id = await f.file()
    await attach(f.actor, id)
    const copy = (await getFeedCollaboration(f.actor)).copy!
    expect(copy.content.sourceSensitivity).toBe('internal')
    expect(copy.content.sourceFileIds).toContain(id)
    expect((await query('SELECT sensitivity FROM workspace_files WHERE id=$1', [id])).rows[0].sensitivity).toBe('internal')
    expect((await query('SELECT clearance FROM assistants WHERE id=$1', [f.actor.assistantId])).rows[0].clearance).toBe('public')
    const saved = await readFeedSaveProjection(f.actor, copy.revision, 'linkedin')
    await expect(assertFeedSavedReady(f.actor, saved!.canonical, 'linkedin')).rejects.toMatchObject({ code: 'public_release_required' })
    const release = { mutationId: randomUUID(), expectedRevision: copy.revision, commands: [{ kind: 'release' as const, audience: 'public' as const }] }
    const first = await executeFeedCommands(f.actor, release)
    expect(await executeFeedCommands(f.actor, release)).toEqual(first)
    await expect(assertFeedSavedReady(f.actor, saved!.canonical, 'linkedin')).resolves.toBeTruthy()
    await executeFeedCommands(f.actor, { mutationId: randomUUID(), expectedRevision: copy.revision, commands: [{ kind: 'context', title: 'Changed title' }] })
    const changed = (await getFeedCollaboration(f.actor)).copy!
    const latest = await readFeedSaveProjection(f.actor, changed.revision, 'linkedin')
    await expect(assertFeedSavedReady(f.actor, latest!.canonical, 'linkedin')).rejects.toMatchObject({ code: 'public_release_required' })
  })
  it('replays an Internal reference added to an image slot without changing the queued mutation', async () => {
    const f = await fixture(), id = await f.file()
    const copy = (await getFeedCollaboration(f.actor)).copy!, segment = copy.content.composition!.segments[0]!
    const request = { mutationId: randomUUID(), expectedRevision: copy.revision, commands: [{ kind: 'edit' as const, edits: [{ kind: 'insertBlock' as const, segmentId: segment.id, afterId: segment.content[0]!.attrs.id, node: { type: 'generationPlaceholder' as const, attrs: { id: randomUUID(), kind: 'image' as const, brief: 'Use the selected reference', briefRevision: 1, references: [{ fileId: id }] } } }] }] }
    const receipt = await executeFeedCommands(f.actor, request)
    expect(await executeFeedCommands(f.actor, request)).toEqual(receipt)
    expect((await getFeedCollaboration(f.actor)).copy!.content.sourceFileIds).toEqual([id])
  })
  it('rejects foreign, customer-compartment and model-selected new private files', async () => {
    const f = await fixture(), other = await fixture()
    await expect(attach(f.actor, await other.file())).rejects.toMatchObject({ code: 'file_not_available_to_draft' })
    await expect(attach(f.actor, await f.file('internal', ['client:other']))).rejects.toMatchObject({ code: 'file_not_available_to_draft' })
    const own = await f.file()
    await expect(attach(f.actor, own, 'assistant')).rejects.toMatchObject({ code: 'source_selection_required' })
    await attach(f.actor, own)
  })
  it('retains memory classification after removal and blocks revoked source reads, including the legacy GET store', async () => {
    const f = await fixture(), id = await f.memory()
    await executeFeedCommands(f.actor, { mutationId: randomUUID(), expectedRevision: 2, commands: [{ kind: 'context', selectedMemoryIds: [id] }] })
    const confirmed = await confirmFeedPost(f.actor, { mutationId: randomUUID(), expectedRevision: 3, locale: 'en' })
    expect(confirmed.confirmation.scope.sensitivity).toBe('confidential')
    await executeFeedCommands(f.actor, { mutationId: randomUUID(), expectedRevision: 3, commands: [{ kind: 'context', selectedMemoryIds: [] }] })
    expect((await getFeedCollaboration(f.actor)).copy!.content.sourceSensitivity).toBe('confidential')
    await query('UPDATE memories SET retracted_at=now() WHERE id=$1', [id])
    await expect(getFeedCollaboration(f.actor)).rejects.toMatchObject({ code: 'draft_source_access_required' })
    expect(await postWorkingCopiesStore.get(f.actor.assistantId, f.actor.sessionId)).toBeNull()
    await expect(executeFeedCommands(f.actor, { mutationId: randomUUID(), expectedRevision: 4, commands: [{ kind: 'release', audience: 'public' }] })).rejects.toMatchObject({ code: 'draft_source_access_required' })
  })
  it('requires all draft viewers to read selected resources and rechecks newly added members', async () => {
    const f = await fixture(), id = await f.file()
    await attach(f.actor, id)
    const member = randomUUID()
    await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [member])
    await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','public')", [f.workspaceId, member])
    await expect(getFeedCollaboration(f.actor)).rejects.toMatchObject({ code: 'draft_source_access_required' })
    expect((await query('SELECT feed_draft_audience_allowed($1) AS allowed', [f.actor.sessionId])).rows[0].allowed).toBe(false)
    const restricted = await app.connect()
    try {
      await restricted.query('BEGIN')
      await restricted.query("SELECT set_config('app.current_user_id',$1,true)", [f.actor.userId])
      expect((await restricted.query('SELECT feed_draft_audience_allowed($1) AS allowed', [f.actor.sessionId])).rows[0].allowed).toBe(false)
      await restricted.query('ROLLBACK')
    } finally { restricted.release() }
    await query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, member])
    const sent: string[] = [], close = vi.fn()
    const stream = guardFeedStream<string>({ query }, f.actor.sessionId, f.actor.userId, event => sent.push(event), close)
    stream('allowed')
    await vi.waitFor(() => expect(sent).toEqual(['allowed']))
    await query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, member])
    stream('private after revocation')
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(sent).toEqual(['allowed'])
    await query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, member])

    const sources = await withFeedTransaction(f.actor, (client, scope) => readFeedSelectedSources(client, f.actor, scope, 'file', [id]))
    expect(sources.map(source => source.id)).toEqual([id])
  })
  it('keeps recipient-scoped Email and private-source output out of ambient post history', async () => {
    const f = await fixture()
    const history = await readFeedPostHistory({ query }, { workspaceId: f.workspaceId, assistantIds: [f.actor.assistantId], sessionId: f.actor.sessionId, text: 'Private customer secret', additionalHistorySql: "SELECT 'test'::text AS id,'email'::text AS platform,'ready'::text AS status,'Private customer secret'::text AS body,'post'::text AS post_format,'{}'::jsonb AS format_data,now() AS date,NULL::text AS link" })
    expect(history.sources).toEqual([])
  })
})
