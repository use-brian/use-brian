import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { createMemory } from '../../db/memories.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { executeWorkspaceScopeReview as execute, getWorkspaceScopeInventory as inventory } from '../scope-review.js'
import { getHeldMemorySummary, recheckHeldMemory, requestHeldMemoryReview } from '../hold-recovery.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), member = randomUUID(), assistantId = randomUUID()
  for (const id of [owner, member]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Recovery fixture',$2)", [workspaceId, owner])
  for (const id of [owner, member]) await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, id, id === owner ? 'owner' : 'member'])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind) VALUES($1,'Recovery assistant',$2,$3,'standard')", [assistantId, owner, workspaceId])
  const team = await createDbWorkspaceGroupStore().createTeam(owner, workspaceId, { name: 'Research', key: 'research' })
  const create = (summary = 'Standing context') => createMemory({ workspaceId, userId: owner, assistantId, createdByUserId: owner, summary, sensitivity: 'confidential' })
  const derived = async (ids: string[], summary = 'Saved from a turn') => {
    const sources = []
    for (const id of ids) sources.push((await pool.query("SELECT read_scope_source($1,'memory',$2) AS source", [workspaceId, id])).rows[0].source)
    return createMemory({ workspaceId, userId: owner, assistantId, createdByUserId: owner, summary, sensitivity: 'confidential', derivation: { producer: 'recovery-fixture', sources } })
  }
  const release = (ids: string[], actor = owner) => execute(workspaceId, actor, { type: 'scope.review.preview', resourceKind: 'memory', resourceIds: ids, action: 'release', targetTeamId: null, reason: 'Hold was a summary regeneration' })
  const apply = (job: { id: string; version: string; payloadHash: string }) => execute(workspaceId, owner, { type: 'scope.review.apply', reviewId: job.id, expectedVersion: job.version, payloadHash: job.payloadHash })
  const row = async (id: string) => (await pool.query('SELECT scope_held, valid_to, superseded_by, summary FROM memories WHERE id=$1', [id])).rows[0]
  return { workspaceId, owner, member, assistantId, team, create, derived, release, apply, row }
}

/** The pre-fix summary regeneration: retire the old summary AND hold everything that read it. */
async function regenerateTheOldWay(f: Awaited<ReturnType<typeof fixture>>, summaryId: string): Promise<string> {
  const successor = await f.create('Standing context, regenerated')
  await pool.query("SELECT hold_scope_descendants($1,'memory',$2)", [f.workspaceId, summaryId])
  await pool.query('UPDATE memories SET valid_to=now(), superseded_by=$2 WHERE id=$1', [summaryId, successor.id])
  return successor.id
}

describe('[COMP:api/scope-hold-recovery] re-check automatically, release by hand', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('releases a summary-held memory as an identical replacement; the original stays held as history', async () => {
    const f = await fixture(), soul = await f.create(), saved = await f.derived([soul.id])
    const successorId = await regenerateTheOldWay(f, soul.id)
    expect((await f.row(saved.id)).scope_held).toBe(true)

    const listed = await inventory(f.workspaceId, f.owner, 'memory')
    expect(listed.items.find(item => item.id === saved.id)?.recovery).toEqual({ status: 'safe' })

    const preview = await f.release([saved.id])
    expect(preview.items[0].impact).toMatchObject({ release: { heads: [{ resourceKind: 'memory', resourceId: successorId }] } })
    expect((await f.apply(preview)).status).toBe('complete')

    const original = await f.row(saved.id)
    expect(original.scope_held).toBe(true) // never un-held
    expect(original.valid_to).not.toBeNull()
    const replacement = await f.row(original.superseded_by)
    expect(replacement).toMatchObject({ scope_held: false, valid_to: null, summary: 'Saved from a turn' })
    const lineage = (await pool.query(`SELECT ds.source_id FROM scope_derivations d JOIN scope_derivation_sources ds ON ds.derivation_id=d.id
      WHERE d.resource_kind='memory' AND d.resource_id=$1`, [original.superseded_by])).rows.map(r => r.source_id)
    expect(lineage).toEqual([successorId])
    // Released history drops out of the review queue.
    expect((await inventory(f.workspaceId, f.owner, 'memory')).items.some(item => item.id === saved.id)).toBe(false)
  })

  it('refuses a memory whose source was really reclassified', async () => {
    const f = await fixture(), source = await f.create(), saved = await f.derived([source.id])
    await pool.query("UPDATE memories SET compartments=ARRAY['research'] WHERE id=$1", [source.id])
    expect((await f.row(saved.id)).scope_held).toBe(true)
    expect((await recheckHeldMemory(pool, f.workspaceId, saved.id)).recovery).toEqual({ status: 'blocked', reason: 'labels_changed' })
    await expect(f.release([saved.id])).rejects.toMatchObject({ code: 'scope_review_release_blocked' })
    expect((await f.row(saved.id)).scope_held).toBe(true)
  })

  it('goes stale when the re-check changes between preview and apply', async () => {
    const f = await fixture(), soul = await f.create(), saved = await f.derived([soul.id])
    const successorId = await regenerateTheOldWay(f, soul.id)
    const preview = await f.release([saved.id])
    await pool.query("UPDATE memories SET compartments=ARRAY['research'] WHERE id=$1", [successorId])
    expect((await f.apply(preview)).status).toBe('stale')
    expect((await f.row(saved.id))).toMatchObject({ scope_held: true, valid_to: null })
  })

  it('never offers release of an administrator hold, and refuses a non-admin', async () => {
    const f = await fixture(), held = await f.create()
    const hold = await execute(f.workspaceId, f.owner, { type: 'scope.review.preview', resourceKind: 'memory', resourceIds: [held.id], action: 'hold', targetTeamId: null, reason: 'Administrator hold' })
    await f.apply(hold)
    expect((await recheckHeldMemory(pool, f.workspaceId, held.id)).recovery).toEqual({ status: 'blocked', reason: 'administrator_hold' })
    const soul = await f.create(), saved = await f.derived([soul.id])
    await regenerateTheOldWay(f, soul.id)
    await expect(f.release([saved.id], f.member)).rejects.toMatchObject({ code: 'admin_required' })
  })

  it('refuses an edited memory whose predecessor read a source that was really reclassified', async () => {
    const f = await fixture(), x = await f.create('Input'), m1 = await f.derived([x.id])
    const { updateMemory } = await import('../../db/memories.js')
    const m2 = await updateMemory(m1.id, { summary: 'Edited', derivation: { producer: 'recovery-fixture', sources: [] } },
      { userId: f.owner, workspaceId: f.workspaceId, assistantId: f.assistantId, assistantKind: 'standard' })
    expect(m2).not.toBeNull()
    await pool.query("UPDATE memories SET compartments=ARRAY['research'] WHERE id=$1", [x.id])
    expect((await f.row(m2!.id)).scope_held).toBe(true)
    expect((await recheckHeldMemory(pool, f.workspaceId, m2!.id)).recovery).toMatchObject({ status: 'blocked' })
  })

  it('refuses when an input of the retired summary is reclassified, even though the successor no longer reads it', async () => {
    const f = await fixture(), x = await f.create('Input'), soul = await f.derived([x.id], 'Standing context')
    const saved = await f.derived([soul.id])
    await regenerateTheOldWay(f, soul.id) // the successor reads nothing from x
    await pool.query("UPDATE memories SET compartments=ARRAY['research'] WHERE id=$1", [x.id])
    expect((await f.row(soul.id)).scope_held).toBe(true) // the retired summary that read x is held by the real change
    expect((await recheckHeldMemory(pool, f.workspaceId, saved.id)).recovery).toEqual({ status: 'blocked', reason: 'labels_changed' })
    await expect(f.release([saved.id])).rejects.toMatchObject({ code: 'scope_review_release_blocked' })
  })

  it('never releases an administrator hold, even after a later source change rewrites the hold reason', async () => {
    const f = await fixture(), source = await f.create(), saved = await f.derived([source.id])
    await f.apply(await execute(f.workspaceId, f.owner, { type: 'scope.review.preview', resourceKind: 'memory', resourceIds: [saved.id], action: 'hold', targetTeamId: null, reason: 'Administrator hold' }))
    await pool.query("SELECT hold_scope_descendants($1,'memory',$2)", [f.workspaceId, source.id])
    expect((await pool.query("SELECT holding_reason FROM scope_resource_states WHERE resource_id=$1 AND review_state='held'", [saved.id])).rows.map(r => r.holding_reason)).toContain('source_changed')
    expect((await recheckHeldMemory(pool, f.workspaceId, saved.id)).recovery).toEqual({ status: 'blocked', reason: 'administrator_hold' })
  })

  it('makes the replacement readable to its owner through the app role', async () => {
    const f = await fixture(), soul = await f.create(), saved = await f.derived([soul.id])
    await regenerateTheOldWay(f, soul.id)
    await f.apply(await f.release([saved.id]))
    const replacementId = (await f.row(saved.id)).superseded_by
    const app = await getAppPool().connect()
    try {
      await app.query('BEGIN')
      await app.query("SELECT set_config('app.current_user_id',$1,true)", [f.owner])
      const visible = (await app.query('SELECT id FROM memories WHERE id = ANY($1::uuid[])', [[saved.id, replacementId]])).rows.map(r => r.id)
      expect(visible).toEqual([replacementId])
      await app.query('ROLLBACK')
    } finally { app.release() }
  })

  it('tells a member how many of their memories are hidden and records one review request', async () => {
    const f = await fixture(), soul = await f.create(), saved = await f.derived([soul.id])
    await regenerateTheOldWay(f, soul.id)
    expect(await getHeldMemorySummary(f.workspaceId, f.owner)).toEqual({ count: 1, requestedAt: null })
    const first = await requestHeldMemoryReview(f.workspaceId, f.owner)
    expect(first.requestedAt).not.toBeNull()
    expect((await requestHeldMemoryReview(f.workspaceId, f.owner)).requestedAt).toBe(first.requestedAt)
    expect((await inventory(f.workspaceId, f.owner, 'memory')).releaseRequests).toBe(1)
    await expect(requestHeldMemoryReview(f.workspaceId, f.member)).rejects.toMatchObject({ code: 'nothing_held' })
    expect(saved.id).toBeTruthy()
  })
})
