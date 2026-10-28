import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getAppPool, getPool } from '../client.js'
import { createDbSavedViewStore } from '../saved-views-store.js'
import { createDbPageGrantStore } from '../page-grant-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { viewsRoutes } from '../../routes/views.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), member = randomUUID(), outsider = randomUUID(), teamspaceId = randomUUID()
  for (const id of [owner, member, outsider]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Tree authority fixture',$2,false)", [workspaceId, owner])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode)
    VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','confidential','assigned')`, [workspaceId, owner, member])
  await pool.query("INSERT INTO teamspaces(id,workspace_id,name,sensitivity,is_default,created_by) VALUES($1,$2,'General','internal',true,$3)", [teamspaceId, workspaceId, owner])
  for (const actor of [owner, member]) await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)', [teamspaceId, actor])
  const lifecycle = vi.fn(), store = createDbSavedViewStore({ onPageLifecycle: lifecycle })
  const grants = createDbPageGrantStore()
  async function page(position: number, parent: string | null = null, team = teamspaceId) {
    const id = randomUUID()
    await pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,name_origin,entity,view_type,binding,page,state,teamspace_id,nest_parent_id,position,clearance)
      VALUES($1,$2,$3,'Tree page','placeholder','tasks','table','{"entity":"tasks","viewType":"table"}','{"blocks":[]}','saved',$4,$5,$6,'internal')`,
    [id, workspaceId, owner, team, parent, position])
    return id
  }
  async function grant(id: string, role: 'view' | 'comment' | 'edit' | 'full') {
    return (await pool.query(`INSERT INTO page_grants(page_id,principal_type,principal_ref,role,created_by)
      VALUES($1,'user',$2,$3,$4) RETURNING id`, [id, member, role, owner])).rows[0].id as string
  }
  async function snapshot() {
    return {
      pages: (await pool.query('SELECT to_jsonb(sv) AS row FROM saved_views sv WHERE workspace_id=$1 ORDER BY id', [workspaceId])).rows,
      receipts: (await pool.query('SELECT to_jsonb(r) AS row FROM workflow_page_event_receipts r WHERE workspace_id=$1 ORDER BY revision', [workspaceId])).rows,
    }
  }
  function app(actor = member) {
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = actor; req.authSessionId = randomUUID(); next() })
    app.use('/api', viewsRoutes({ savedViewStore: store, workspaceStore: createWorkspaceStore() } as Parameters<typeof viewsRoutes>[0]))
    return app
  }
  async function destination() {
    const id = randomUUID()
    await pool.query("INSERT INTO teamspaces(id,workspace_id,name,sensitivity,created_by) VALUES($1,$2,'Destination','internal',$3)", [id, workspaceId, owner])
    for (const actor of [owner, member]) await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)', [id, actor])
    return id
  }
  return { workspaceId, owner, member, outsider, teamspaceId, lifecycle, store, grants, page, grant, snapshot, app, destination }
}

afterAll(async () => { await getAppPool().end(); await pool.end() })

describe('[COMP:doc/page-tree-store] actual changed-row authority and atomicity (PG18)', () => {
  it('uses the real nonowner non-bypass app login', async () => {
    const identity = (await getAppPool().query(`SELECT session_user,current_user,r.rolsuper,r.rolbypassrls,
      pg_get_userbyid(c.relowner)=session_user AS owns_pages
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=session_user AND c.oid='saved_views'::regclass`)).rows[0]
    expect(identity).toEqual({ session_user: 'app_user', current_user: 'app_user', rolsuper: false, rolbypassrls: false, owns_pages: false })
  })

  it('rolls back gap, root and normalization writes when a readable sibling is view-only', async () => {
    const f = await fixture(), moved = await f.page(0), readonly = await f.page(1)
    await f.page(2)
    await f.grant(readonly, 'view')
    const before = await f.snapshot()
    expect(await f.store.reparent(f.member, moved, null, 2)).toBe(false)
    expect(await f.snapshot()).toEqual(before)
    expect(f.lifecycle).not.toHaveBeenCalled()
  })

  it('rolls back an earlier reorder write when a later changed sibling is comment-only', async () => {
    const f = await fixture(), readonly = await f.page(0), editable = await f.page(1)
    await f.grant(readonly, 'comment')
    const before = await f.snapshot()
    await expect(f.store.reorderSiblings(f.member, null, [editable, readonly])).rejects.toThrow('page_tree_mutation_refused')
    expect(await f.snapshot()).toEqual(before)
    expect(f.lifecycle).not.toHaveBeenCalled()
  })

  it('rejects a late missing or wrong-parent reorder ID without retaining prior writes', async () => {
    for (const kind of ['missing', 'wrong-parent', 'duplicate']) {
      const f = await fixture(), first = await f.page(0), second = await f.page(1), parent = await f.page(5)
      const other = kind === 'missing' ? randomUUID() : kind === 'wrong-parent' ? await f.page(0, parent) : first
      const before = await f.snapshot()
      await expect(f.store.reorderSiblings(f.member, null, [second, first, other])).rejects.toThrow('page_tree_mutation_refused')
      expect(await f.snapshot()).toEqual(before)
    }
  })

  it('does not require edit for a reorder row whose position does not change', async () => {
    const f = await fixture(), readonly = await f.page(0), editable = await f.page(1)
    await f.grant(readonly, 'view')
    const before = await f.snapshot()
    await f.store.reorderSiblings(f.member, null, [readonly, editable])
    expect(await f.snapshot()).toEqual(before)
  })

  it('rejects a read-only source and a read-only moved descendant without any receipts', async () => {
    for (const denied of ['root', 'descendant']) {
      const f = await fixture(), root = await f.page(0), child = await f.page(0, root), destination = await f.destination()
      await f.grant(denied === 'root' ? root : child, 'view')
      const before = await f.snapshot()
      expect(await f.store.reparent(f.member, root, null, 0, undefined, destination, undefined, true)).toBe(false)
      expect(await f.snapshot()).toEqual(before)
      expect(f.lifecycle).not.toHaveBeenCalled()
    }
  })

  it('moves an editable child under a readable view-only parent without changing the parent or its receipts', async () => {
    const f = await fixture(), parent = await f.page(0), child = await f.page(1)
    await f.grant(parent, 'view')
    await f.grant(child, 'edit')
    expect(await f.store.getById(f.member, parent)).toMatchObject({ id: parent, effectiveRole: 'view', canEdit: false })
    expect(await f.store.getById(f.member, child)).toMatchObject({ id: child, effectiveRole: 'edit', canEdit: true })
    const parentSnapshot = async () => (await pool.query(`SELECT to_jsonb(sv) AS page,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.revision) FROM workflow_page_event_receipts r WHERE r.page_id=sv.id) AS receipts
      FROM saved_views sv WHERE sv.id=$1`, [parent])).rows
    const before = await parentSnapshot()
    expect(await f.store.reparent(f.member, child, parent, 0)).toBe(true)
    expect(await f.store.getById(f.member, child)).toMatchObject({ nestParentId: parent, position: 0, teamspaceId: f.teamspaceId })
    expect(await parentSnapshot()).toEqual(before)
    expect(f.lifecycle).toHaveBeenCalledTimes(1)
    expect(f.lifecycle).toHaveBeenCalledWith(expect.objectContaining({ pageId: child, parentId: parent, action: 'moved' }))
  })

  it('keeps all-edit moves and reorder useful and preserves cycle and confirmation refusal', async () => {
    const f = await fixture(), root = await f.page(0), child = await f.page(0, root), second = await f.page(1)
    expect(await f.store.reparent(f.member, root, child, 0)).toBe(false)
    const destination = await f.destination(), before = await f.snapshot()
    expect(await f.store.reparent(f.member, root, null, 0, undefined, destination)).toBe(false)
    expect(await f.snapshot()).toEqual(before)
    expect(await f.store.reparent(f.member, root, null, 0, undefined, destination, undefined, true)).toBe(true)
    expect(await f.store.getById(f.member, child)).toMatchObject({ teamspaceId: destination })
    expect(f.lifecycle).toHaveBeenCalledTimes(1)
    const third = await f.page(0), fourth = await f.page(1)
    await f.store.reorderSiblings(f.member, null, [fourth, third, second])
    for (const [position, id] of [fourth, third, second].entries()) expect(await f.store.getById(f.member, id)).toMatchObject({ position })
  })

  it('rechecks existing-grant downgrade after a planned sibling row lock wait', async () => {
    const f = await fixture(), root = await f.page(0), sibling = await f.page(1)
    const grantId = await f.grant(sibling, 'edit'), before = await f.snapshot(), blocker = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM saved_views WHERE id=$1 FOR UPDATE', [sibling])
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = f.store.reparent(f.member, root, null, 1).catch(error => error)
      let waiting = false
      for (let attempt = 0; attempt < 200; attempt++) {
        waiting = (await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting', [pid])).rows[0].waiting
        if (waiting) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      expect(await f.grants.updateGrantRole(f.owner, grantId, 'view')).toBe(true)
      await blocker.query('COMMIT')
      expect(await pending).toBe(false)
      expect(await f.snapshot()).toEqual(before)
      expect(f.lifecycle).not.toHaveBeenCalled()
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await pending
    }
  }, 15000)

  it('composes Page edit with the agent mutation ceiling', async () => {
    const f = await fixture(), groups = createDbWorkspaceGroupStore()
    const team = await groups.createTeam(f.owner, f.workspaceId, { name: 'Tree team', key: 'tree-team' })
    await groups.addMember(f.owner, team.id, f.member)
    await pool.query('UPDATE teamspaces SET workspace_group_id=$2 WHERE id=$1', [f.teamspaceId, team.id])
    const root = await f.page(0), sibling = await f.page(1), before = await f.snapshot()
    await f.grant(root, 'edit')
    const access = { workspaceId: f.workspaceId, userId: f.member, clearance: 'confidential' as const,
      compartments: [team.compartmentKey!], mutationCompartments: [], projectIds: null }
    const read = await runWithAgentAccess(access, () => f.store.getById(f.member, root))
    expect(read).toMatchObject({ effectiveRole: 'edit', canEdit: false })
    expect(await runWithAgentAccess(access, () => f.store.reparent(f.member, root, null, 1))).toBe(false)
    await expect(runWithAgentAccess(access, () => f.store.reorderSiblings(f.member, null, [sibling, root]))).rejects.toThrow('page_tree_mutation_refused')
    expect(await f.snapshot()).toEqual(before)
    expect(f.lifecycle).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/views-routes] canonical capability projection (PG18)', () => {
  it('projects actual roles on both GET aliases and list, and hides unavailable Pages', async () => {
    const f = await fixture(), app = f.app()
    for (const role of [null, 'view', 'comment', 'edit', 'full'] as const) {
      const id = await f.page(0)
      if (role) await f.grant(id, role)
      const capability = { effectiveRole: role ?? 'edit', canEdit: role === null || role === 'edit' || role === 'full' }
      for (const path of ['views', 'saved-views']) {
        const response = await request(app).get(`/api/${path}/${id}`)
        expect(response.status).toBe(200)
        expect(response.body).toMatchObject(capability)
      }
      const list = await request(app).get(`/api/workspaces/${f.workspaceId}/saved-views`)
      expect(list.status).toBe(200)
      expect(list.body.savedViews.find((row: { id: string }) => row.id === id)).toMatchObject(capability)
    }
    const hidden = await f.page(0)
    await pool.query('UPDATE saved_views SET teamspace_id=NULL WHERE id=$1', [hidden])
    for (const id of [hidden, randomUUID()]) {
      const response = await request(app).get(`/api/views/${id}`)
      expect(response.status).toBe(404)
      expect(response.body).not.toHaveProperty('effectiveRole')
      expect(response.body).not.toHaveProperty('canEdit')
    }
  })

  it('omits create/mutation capabilities and derives the newly inserted Page on the following GET', async () => {
    const f = await fixture(), app = f.app()
    const created = await request(app).post(`/api/workspaces/${f.workspaceId}/saved-views`)
      .send({ name: 'Created tree page', binding: { entity: 'tasks', viewType: 'table' } })
    expect(created.status).toBe(201)
    expect(created.body).not.toHaveProperty('effectiveRole')
    expect(created.body).not.toHaveProperty('canEdit')
    const read = await request(app).get(`/api/views/${created.body.id}`)
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ effectiveRole: 'edit', canEdit: true })
    for (const response of [
      await request(app).patch(`/api/saved-views/${created.body.id}`).send({ icon: 'star' }),
      await request(app).patch(`/api/views/${created.body.id}/reparent`).send({ nestParentId: null, position: 0 }),
    ]) {
      expect(response.status).toBe(200)
      expect(response.body).not.toHaveProperty('effectiveRole')
      expect(response.body).not.toHaveProperty('canEdit')
    }
  })
})
