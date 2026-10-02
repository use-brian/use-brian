import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { viewsRoutes } from '../../routes/views.js'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../client.js'
import { createDbSavedViewStore, copySavedViewPage } from '../saved-views-store.js'
import { createTeamspaceStore } from '../teamspace-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { withPagePlacement } from '../page-placement-admission.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), store = createDbSavedViewStore()
// local-fixture creates its non-bypass app role after running migrations.
await pool.query('GRANT EXECUTE ON FUNCTION lock_page_placement_teamspace(uuid,uuid) TO assurance_app')
async function fixture(mode = 'simple', linked = true) {
  const w = randomUUID(), owner = randomUUID(), group = randomUUID(), teamspace = randomUUID(), fileId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [owner])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Page admission',$2)", [w, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [w, owner])
  await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1,$2,'Department',$3,'team',$1::uuid::text,$4)", [group, w, owner, `team:${group}`])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Department',$3,'team',$4)", [w, `team:${group}`, owner, group])
  // Legacy fixture intake precedes mode readiness; never forge an admission receipt.
  await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri) VALUES($1,$2,'/source.txt','source.txt','fixture://source')", [fileId, w])
  await pool.query("UPDATE workspace_access_policies SET access_mode=$2,setup_state='ready',default_department_id=$3 WHERE workspace_id=$1", [w, mode, group])
  await pool.query("INSERT INTO teamspaces(id,workspace_id,name,sensitivity,is_default,workspace_group_id,created_by) VALUES($1,$2,'Default','internal',true,$3,$4)", [teamspace, w, linked ? group : null, owner])
  if (!linked) await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)', [teamspace, owner])
  const create = (patch: Partial<Parameters<typeof store.createDraft>[0]> = {}) => store.createDraft({ userId: owner, workspaceId: w, name: 'Authored', entity: 'tasks', viewType: 'table', binding: { entity: 'tasks', viewType: 'table' }, page: { blocks: [] }, ...patch }, { provenance: { kind: 'human-authored', actorId: owner } })
  return { w, owner, group, teamspace, fileId, create }
}
afterAll(async () => { await getAppPool().end(); await pool.end() })
describe('authored page placement admission', () => {
  it('copies the current canonical live page through production HTTP as an app-role member', async () => {
    const f = await fixture(), source = await f.create(), member = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [member])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'member','confidential','assigned')", [f.w, member])
    await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [f.group, member])
    await pool.query("INSERT INTO documents(page_id,ydoc,state_vector,snapshot_json,snapshot_title,seq) VALUES($1,'','','{\"blocks\":[]}','Live source',7)", [source.id])
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = member; req.authSessionId = randomUUID(); next() })
    app.use('/api', viewsRoutes({ savedViewStore: store } as Parameters<typeof viewsRoutes>[0]))
    const path = `/api/workspaces/${f.w}/views/${source.id}/copy`
    expect((await request(app).post(path).send({ sourceVersion: 6 })).status).toBe(409)
    expect((await request(app).post(path).send({ sourceVersion: 7, page: { blocks: [] } })).status).toBe(400)
    await expect(runWithAgentAccess({ workspaceId: f.w, userId: member, clearance: 'confidential', compartments: [`team:${f.group}`], mutationCompartments: [], projectIds: null }, () => copySavedViewPage({ userId: member, workspaceId: f.w, sourcePageId: source.id, sourceVersion: 7 })))
      .rejects.toMatchObject({ code: 'context_not_available' })
    const plain = { blocks: [{ kind: 'heading', id: 'heading', level: 1, text: 'Plain page' }, { kind: 'text', id: 'body', text: 'Current canonical text.' }, { kind: 'divider', id: 'line' }] }
    await pool.query('UPDATE documents SET snapshot_json=$2::jsonb WHERE page_id=$1', [source.id, JSON.stringify(plain)])
    const response = await request(app).post(path).send({ sourceVersion: 7 })
    expect(response.status).toBe(201)
    expect(await store.getById(member, response.body.id)).toMatchObject({ name: 'Live source', teamspaceId: f.teamspace, createdBy: member, page: plain })
    expect((await request(app).post(path).send({ sourceVersion: 7, teamspaceId: null })).body).toMatchObject({ error: 'page_copy_destination_floor_conflict' })
    const foreign = await fixture()
    expect((await request(app).post(`/api/workspaces/${foreign.w}/views/${source.id}/copy`).send({ sourceVersion: 7 })).status).toBe(404)
    await pool.query('UPDATE saved_views SET anchor_key=$2 WHERE id=$1', [source.id, `recording-synthesis:${randomUUID()}`])
    expect((await request(app).post(path).send({ sourceVersion: 7 })).body).toMatchObject({ error: 'page_source_admission_required' })
  })
  it('rejects all embedded-source forms in the locked live body, not just root pointers', async () => {
    const f = await fixture(), source = await f.create()
    await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1', [f.fileId])
    expect((await queryWithRLS(f.owner, 'SELECT id FROM workspace_files WHERE id=$1', [f.fileId])).rows).toHaveLength(0)
    await pool.query("INSERT INTO documents(page_id,ydoc,state_vector,snapshot_json,seq) VALUES($1,'','','{}',7)", [source.id])
    const embedded = [
      { kind: 'file', id: 'file', url: `/api/workspace-files/${f.fileId}` },
      { kind: 'image', id: 'image', url: `/api/workspace-files/${f.fileId}` },
      { kind: 'audio', id: 'audio', url: `/api/recordings/${randomUUID()}` },
      { kind: 'bookmark', id: 'office', url: `/office/${randomUUID()}` },
      { kind: 'child_page', id: 'child', childPageId: randomUUID() },
      { kind: 'data', id: 'data', binding: { entity: 'custom', entityTypeId: randomUUID(), viewType: 'table' } },
      { kind: 'extraction_slot', id: 'structured', recordId: randomUUID() },
      { kind: 'text', id: 'nested', text: 'Plain', sources: [{ kind: 'workspace_file', id: f.fileId }] },
      { kind: 'text', id: 'markdown', text: `[secret](/api/workspace-files/${f.fileId})` },
      { kind: 'text', id: 'html', text: `<img src="/api/workspace-files/${f.fileId}">` },
    ]
    for (const block of embedded) {
      await pool.query('UPDATE documents SET snapshot_json=$2::jsonb WHERE page_id=$1', [source.id, JSON.stringify({ blocks: [block] })])
      await expect(copySavedViewPage({ workspaceId: f.w, userId: f.owner, sourcePageId: source.id, sourceVersion: 7 }))
        .rejects.toMatchObject({ code: 'page_copy_embedded_source_admission_required' })
    }
    expect((await pool.query('SELECT id FROM saved_views WHERE workspace_id=$1', [f.w])).rows).toHaveLength(1)
  })
  it('rechecks a source page changed while copy waits, including a newly held embedded file', async () => {
    const f = await fixture(), source = await f.create(), blocker = await pool.connect()
    const version = (await pool.query('SELECT version FROM saved_views WHERE id=$1', [source.id])).rows[0].version
    let pending: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      // Canonical file hold metadata also takes workspace first. Publish the
      // hold/content change on that transaction while copy waits at the barrier.
      await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.w])
      await blocker.query('SELECT id FROM saved_views WHERE id=$1 FOR UPDATE', [source.id])
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = copySavedViewPage({ workspaceId: f.w, userId: f.owner, sourcePageId: source.id, sourceVersion: version }).catch(error => error)
      let waiting = false
      for (let i = 0; i < 100; i++) {
        waiting = (await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting
        if (waiting) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      await blocker.query('UPDATE workspace_files SET scope_held=true WHERE id=$1', [f.fileId])
      await blocker.query('UPDATE saved_views SET page=$2::jsonb,version=version+1 WHERE id=$1', [source.id, JSON.stringify({ blocks: [{ kind: 'file', id: 'file', url: `/api/workspace-files/${f.fileId}` }] })])
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({ code: 'page_copy_source_changed' })
      await expect(copySavedViewPage({ workspaceId: f.w, userId: f.owner, sourcePageId: source.id, sourceVersion: version + 1 }))
        .rejects.toMatchObject({ code: 'page_copy_embedded_source_admission_required' })
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending
    }
    expect((await pool.query('SELECT id FROM saved_views WHERE workspace_id=$1', [f.w])).rows).toHaveLength(1)
  })
  it('preserves private copy floors and refuses private-to-shared broadening or admin escape', async () => {
    const f = await fixture(), source = await f.create({ teamspaceId: null })
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = f.owner; req.authSessionId = randomUUID(); next() })
    app.use('/api', viewsRoutes({ savedViewStore: store } as Parameters<typeof viewsRoutes>[0]))
    const version = (await pool.query('SELECT version FROM saved_views WHERE id=$1', [source.id])).rows[0].version
    const path = `/api/workspaces/${f.w}/views/${source.id}/copy`
    const admin = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [admin])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'admin','confidential')", [f.w, admin])
    await expect(copySavedViewPage({ userId: admin, workspaceId: f.w, sourcePageId: source.id, sourceVersion: version }))
      .rejects.toMatchObject({ code: 'context_not_available' })
    const result = await request(app).post(path).send({ sourceVersion: version })
    expect(result.status).toBe(201)
    expect(await store.getById(f.owner, result.body.id)).toMatchObject({ teamspaceId: null })
    expect((await request(app).post(path).send({ sourceVersion: version, teamspaceId: f.teamspace })).status).toBe(409)
  })
  it('uses only the linked canonical default for both create APIs', async () => {
    const f = await fixture()
    expect(await f.create()).toMatchObject({ teamspaceId: f.teamspace })
    expect(await store.create({ userId: f.owner, workspaceId: f.w, name: 'View', binding: { entity: 'tasks', viewType: 'table' } }, { provenance: { kind: 'human-authored', actorId: f.owner } })).toMatchObject({ teamspaceId: f.teamspace })
  })
  it('keeps explicit null and private parent private', async () => {
    const f = await fixture(), parent = await f.create({ teamspaceId: null })
    expect(parent.teamspaceId).toBeNull()
    expect(await f.create({ nestParentId: parent.id })).toMatchObject({ teamspaceId: null })
    await expect(f.create({ nestParentId: parent.id, teamspaceId: f.teamspace })).rejects.toMatchObject({ code: 'access_mode_destination_conflict' })
  })
  it('requires Departments selection, accepts an authorized destination and inherits sensitivity', async () => {
    const f = await fixture('departments')
    await expect(f.create()).rejects.toMatchObject({ code: 'context_selection_required' })
    const parent = await f.create({ teamspaceId: f.teamspace })
    await pool.query("UPDATE saved_views SET clearance='confidential' WHERE id=$1", [parent.id])
    expect(await f.create({ nestParentId: parent.id })).toMatchObject({ teamspaceId: f.teamspace, clearance: 'confidential' })
  })
  it('blocks a generic unlinked default without repairing it or writing a page', async () => {
    const f = await fixture('simple', false)
    await expect(f.create()).rejects.toMatchObject({ code: 'page_linked_default_teamspace_provisioning_required', status: 409 })
    expect((await pool.query('SELECT id FROM saved_views WHERE workspace_id=$1', [f.w])).rows).toHaveLength(0)
    expect((await pool.query('SELECT workspace_group_id FROM teamspaces WHERE id=$1', [f.teamspace])).rows[0].workspace_group_id).toBeNull()
    expect(await f.create({ teamspaceId: null })).toMatchObject({ teamspaceId: null })
  })
  it('rejects foreign parents and Teamspaces and stale destination metadata', async () => {
    const f = await fixture(), foreign = await fixture(), parent = await foreign.create()
    await expect(f.create({ nestParentId: parent.id })).rejects.toMatchObject({ code: 'context_not_available' })
    await expect(f.create({ teamspaceId: foreign.teamspace })).rejects.toMatchObject({ code: 'context_selection_required' })
    await pool.query('UPDATE teamspaces SET workspace_group_id=NULL WHERE id=$1', [f.teamspace])
    await expect(f.create({ teamspaceId: f.teamspace })).rejects.toMatchObject({ code: 'context_selection_required' })
  })
  it('never substitutes owner or read reach for author mutation authority', async () => {
    const f = await fixture()
    await expect(runWithAgentAccess({ workspaceId: f.w, userId: f.owner, clearance: 'confidential', compartments: [`team:${f.group}`], mutationCompartments: [], projectIds: null }, () => f.create())).rejects.toMatchObject({ code: 'context_not_available' })
    await expect(f.create({ userId: randomUUID() })).rejects.toThrow()
  })
  it('rejects unproven bodies even with a private or canonical parent placement', async () => {
    const f = await fixture(), parent = await f.create()
    await expect(store.create({ userId: f.owner, workspaceId: f.w, name: 'Unproven view', binding: { entity: 'tasks', viewType: 'table' } }))
      .rejects.toMatchObject({ code: 'page_source_admission_required', status: 409 })
    for (const placement of [{}, { teamspaceId: null }, { nestParentId: parent.id }]) {
      await expect(store.createDraft({ userId: f.owner, workspaceId: f.w, name: 'Source body', entity: 'tasks', viewType: 'table', binding: { entity: 'tasks', viewType: 'table' }, page: { blocks: [] }, ...placement }))
        .rejects.toMatchObject({ code: 'page_source_admission_required', status: 409 })
    }
  })
  it('retains the maximum input, parent and Teamspace sensitivity', async () => {
    const f = await fixture(), parent = await f.create()
    const options = { provenance: { kind: 'human-authored' as const, actorId: f.owner } }
    expect(await withPagePlacement(f.w, f.owner, { nestParentId: parent.id, clearance: 'confidential' }, async (_client, placement) => placement.clearance, options)).toBe('confidential')
    await pool.query("UPDATE saved_views SET clearance='confidential' WHERE id=$1", [parent.id])
    expect(await withPagePlacement(f.w, f.owner, { nestParentId: parent.id, clearance: 'public' }, async (_client, placement) => placement.clearance, options)).toBe('confidential')
    await pool.query("UPDATE teamspaces SET sensitivity='confidential' WHERE id=$1", [f.teamspace])
    expect(await f.create()).toMatchObject({ clearance: 'confidential' })
  })
  it('enforces private ambient sensitivity and actor bounds', async () => {
    const f = await fixture()
    expect(await runWithAgentAccess({ workspaceId: f.w, userId: f.owner, clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [] }, () => f.create({ teamspaceId: null })))
      .toMatchObject({ teamspaceId: null })
    await expect(runWithAgentAccess({ workspaceId: f.w, userId: f.owner, clearance: 'public', compartments: [], mutationCompartments: [], projectIds: [] }, () => f.create({ teamspaceId: null })))
      .rejects.toMatchObject({ code: 'context_not_available' })
    await expect(runWithAgentAccess({ workspaceId: f.w, userId: randomUUID(), clearance: 'confidential', compartments: null, mutationCompartments: null, projectIds: null }, () => f.create({ teamspaceId: null })))
      .rejects.toMatchObject({ code: 'not_found' })
  })
  it('holds destination metadata against concurrent mutation until admission commits', async () => {
    const f = await fixture(), unrelated = await fixture(), writer = await pool.connect()
    try {
      await writer.query('BEGIN')
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await withPagePlacement(f.w, f.owner, {}, async (_client, placement) => {
        const mutation = writer.query("UPDATE teamspaces SET sensitivity='confidential' WHERE id=$1", [f.teamspace])
        let blocked = false
        for (let i = 0; i < 100; i++) {
          blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked
          if (blocked) break
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(blocked).toBe(true)
        // No relation-wide SHARE lock: unrelated workspaces keep writing.
        await pool.query("UPDATE teamspaces SET description='Unrelated' WHERE id=$1", [unrelated.teamspace])
        expect(placement.clearance).toBe('internal')
        // Wait after admission COMMIT, not while holding its destination lock.
        void mutation.catch(() => {})
      }, { provenance: { kind: 'human-authored', actorId: f.owner } })
      await writer.query('COMMIT')
      expect(await f.create()).toMatchObject({ clearance: 'confidential' })
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
    }
  })
  it('limits the fixed app-role metadata lock to current workspace members and local rows', async () => {
    const f = await fixture(), other = await fixture()
    const locked = await queryWithRLS(f.owner, 'SELECT * FROM lock_page_placement_teamspace($1,$2)', [f.w, f.teamspace])
    expect(locked.rows).toMatchObject([{ id: f.teamspace, department_id: f.group }])
    expect((await queryWithRLS(f.owner, 'SELECT * FROM lock_page_placement_teamspace($1,$2)', [f.w, other.teamspace])).rows).toHaveLength(0)
    await expect(queryWithRLS(other.owner, 'SELECT * FROM lock_page_placement_teamspace($1,$2)', [f.w, f.teamspace])).rejects.toMatchObject({ code: '42501' })
    await expect(queryWithRLS(randomUUID(), 'SELECT * FROM lock_page_placement_teamspace($1,$2)', [f.w, f.teamspace])).rejects.toMatchObject({ code: '42501' })
  })
  it('blocks unreviewed Teamspace creation in ready modes', async () => {
    const f = await fixture()
    await expect(createTeamspaceStore().create({ workspaceId: f.w, createdBy: f.owner, name: 'New audience', sensitivity: 'internal' })).rejects.toMatchObject({ code: 'context_selection_required' })
  })
})
