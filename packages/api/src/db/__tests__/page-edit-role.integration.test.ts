import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../client.js'
import { createDbSavedViewStore } from '../saved-views-store.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { createDbPageGrantStore } from '../page-grant-store.js'
import { createDbCommentThreadStore } from '../comment-thread-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { viewsRoutes } from '../../routes/views.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
type Role = 'view' | 'comment' | 'edit' | 'full'

async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), member = randomUUID(), outsider = randomUUID(), teamspaceId = randomUUID()
  for (const id of [owner, member, outsider]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Page role fixture',$2,false)", [workspaceId, owner])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode)
    VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','confidential','assigned')`, [workspaceId, owner, member])
  await pool.query("INSERT INTO teamspaces(id,workspace_id,name,sensitivity,created_by) VALUES($1,$2,'General','internal',$3)", [teamspaceId, workspaceId, owner])
  for (const user of [owner, member]) await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)', [teamspaceId, user])
  const lifecycle = vi.fn(), store = createDbSavedViewStore({ onPageLifecycle: lifecycle })
  const page = { blocks: [{ id: 'body', kind: 'text' as const, text: 'Original body' }] }
  const changedPage = { blocks: [{ id: 'body', kind: 'text' as const, text: 'Changed body' }] }
  async function makePage(opts: { creator?: string; private?: boolean; documents?: boolean } = {}) {
    const id = randomUUID()
    await pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,name_origin,description,icon,entity,view_type,binding,page,state,teamspace_id,clearance)
      VALUES($1,$2,$3,'Original title','auto','Original description','book','tasks','table','{"entity":"tasks","viewType":"table"}',$4,'saved',$5,'internal')`,
    [id, workspaceId, opts.creator ?? owner, JSON.stringify(page), opts.private ? null : teamspaceId])
    if (opts.documents) await pool.query(`INSERT INTO documents(page_id,ydoc,state_vector,snapshot_json,snapshot_title,seq)
      VALUES($1,'','',$2,'Original title',7)`, [id, JSON.stringify(page)])
    return id
  }
  async function grant(pageId: string, role: Role, kind = 'user', ref: string | null = member, status?: 'expired' | 'revoked') {
    return (await pool.query(`INSERT INTO page_grants(page_id,principal_type,principal_ref,role,created_by,expires_at,revoked_at)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $6='expired' THEN now()-interval '1 day' END,CASE WHEN $6='revoked' THEN now() END) RETURNING id`,
    [pageId, kind, ref, role, owner, status ?? null])).rows[0].id as string
  }
  async function snapshot(pageId: string) {
    return (await pool.query(`SELECT to_jsonb(sv) AS page,
      (SELECT to_jsonb(d) FROM documents d WHERE d.page_id=sv.id) AS document,
      (SELECT count(*)::int FROM workflow_page_event_receipts r WHERE r.page_id=sv.id) AS receipts
      FROM saved_views sv WHERE sv.id=$1`, [pageId])).rows
  }
  function app(actor = member) {
    const app = express()
    // Verified host identity is supplied here; router, stores and DB authority are real.
    app.use(express.json(), (req, _res, next) => { req.userId = actor; next() })
    app.use('/api', viewsRoutes({ savedViewStore: store, workspaceStore: createWorkspaceStore(), pageGrantStore: createDbPageGrantStore() } as Parameters<typeof viewsRoutes>[0]))
    return app
  }
  return { workspaceId, owner, member, outsider, teamspaceId, page, changedPage, store, lifecycle, makePage, grant, snapshot, app }
}

afterAll(async () => { await getAppPool().end(); await pool.end() })

describe('[COMP:api/saved-views-store] authenticated Page edit roles (PG18)', () => {
  it('uses the nonowner non-bypass app login for actor-bound statements', async () => {
    const role = (await getAppPool().query(`SELECT session_user,current_user,r.rolsuper,r.rolbypassrls,
      pg_get_userbyid(c.relowner)=session_user AS owns_pages
      FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=session_user AND c.oid='saved_views'::regclass`)).rows[0]
    expect(role).toEqual({ session_user: 'app_user', current_user: 'app_user', rolsuper: false, rolbypassrls: false, owns_pages: false })
  })

  for (const role of ['view', 'comment'] as const) {
    it(`${role} keeps reads but denies HTTP metadata and legacy body writes without receipts or lifecycle`, async () => {
      const f = await fixture(), id = await f.makePage()
      await f.grant(id, role)
      expect(await f.store.getById(f.member, id)).toMatchObject({ id, name: 'Original title' })
      expect(await f.store.getPage(f.member, id)).toEqual(f.page)
      const before = await f.snapshot(id), app = f.app()
      for (const fields of [{ name: 'Changed title' }, { icon: 'star' }, { description: 'Changed description', fullWidth: true }]) {
        const response = await request(app).patch(`/api/saved-views/${id}`).send(fields)
        expect.soft(response.status).toBe(404)
        expect.soft(await f.snapshot(id)).toEqual(before)
      }
      const response = await request(app).patch(`/api/views/${id}/page`).send({ page: f.changedPage })
      expect.soft(response.status).toBe(404)
      expect.soft(await f.snapshot(id)).toEqual(before)
      expect.soft(await f.store.getPage(f.owner, id)).toEqual(f.page)
      expect.soft(f.lifecycle).not.toHaveBeenCalled()
    })

    it(`${role} denies canonical store metadata, legacy body and deletion`, async () => {
      const f = await fixture(), id = await f.makePage()
      await f.grant(id, role)
      const before = await f.snapshot(id)
      expect.soft(await f.store.update(f.member, id, { name: 'Changed', nameOrigin: 'user', icon: 'star' })).toBeNull()
      expect.soft(await f.store.updatePage(f.member, id, f.changedPage)).toBe(false)
      expect.soft(await f.store.remove(f.member, id)).toBe(false)
      expect.soft(await f.snapshot(id)).toEqual(before)
      expect.soft(f.lifecycle).not.toHaveBeenCalled()
    })

    it(`${role} denies direct app-user root and document updates and deletes`, async () => {
      const f = await fixture(), id = await f.makePage({ documents: true })
      await f.grant(id, role)
      const before = await f.snapshot(id)
      expect.soft((await queryWithRLS(f.member, "UPDATE saved_views SET name='Changed' WHERE id=$1 RETURNING id", [id])).rows).toHaveLength(0)
      expect.soft((await queryWithRLS(f.member, "UPDATE documents SET snapshot_json=$2,seq=seq+1 WHERE page_id=$1 RETURNING page_id", [id, JSON.stringify(f.changedPage)])).rows).toHaveLength(0)
      expect.soft((await queryWithRLS(f.member, 'DELETE FROM documents WHERE page_id=$1 RETURNING page_id', [id])).rows).toHaveLength(0)
      expect.soft((await queryWithRLS(f.member, 'DELETE FROM saved_views WHERE id=$1 RETURNING id', [id])).rows).toHaveLength(0)
      expect.soft(await f.snapshot(id)).toEqual(before)
    })

    it(`${role} denies direct app-user document insertion`, async () => {
      const f = await fixture(), id = await f.makePage()
      await f.grant(id, role)
      const before = await f.snapshot(id)
      await expect(queryWithRLS(f.member, "INSERT INTO documents(page_id,ydoc,state_vector,snapshot_json) VALUES($1,'','','{}')", [id])).rejects.toMatchObject({ code: '42501' })
      expect(await f.snapshot(id)).toEqual(before)
    })
  }

  for (const role of [null, 'edit', 'full'] as const) {
    it(`${role ?? 'no-grant baseline'} permits HTTP metadata, legacy body and direct document writes`, async () => {
      const f = await fixture(), id = await f.makePage()
      if (role) await f.grant(id, role)
      const response = await request(f.app()).patch(`/api/saved-views/${id}`).send({ name: 'Changed title', icon: 'star' })
      expect(response.status).toBe(200)
      expect(await f.store.getById(f.owner, id)).toMatchObject({ name: 'Changed title', nameOrigin: 'user', icon: 'star' })
      expect((await request(f.app()).patch(`/api/views/${id}/page`).send({ page: f.changedPage })).status).toBe(200)
      expect(await f.store.getPage(f.owner, id)).toEqual(f.changedPage)
      expect((await queryWithRLS(f.member, "INSERT INTO documents(page_id,ydoc,state_vector,snapshot_json) VALUES($1,'','',$2) RETURNING page_id", [id, JSON.stringify(f.page)])).rows).toHaveLength(1)
      expect((await queryWithRLS(f.member, "UPDATE documents SET snapshot_json=$2,seq=seq+1 WHERE page_id=$1 RETURNING page_id", [id, JSON.stringify(f.changedPage)])).rows).toHaveLength(1)
      expect(await f.store.getPage(f.owner, id)).toEqual(f.changedPage)
      expect((await queryWithRLS(f.member, 'DELETE FROM documents WHERE page_id=$1 RETURNING page_id', [id])).rows).toHaveLength(1)
      expect(await f.store.remove(f.member, id)).toBe(true)
      expect(await f.snapshot(id)).toEqual([])
      expect(f.lifecycle).toHaveBeenCalled()
    })
  }

  for (const [userRole, lowerRole, allowed] of [['view', 'full', false], ['edit', 'view', true]] as const) {
    it(`explicit user ${userRole} overrides group and workspace ${lowerRole}`, async () => {
      const f = await fixture(), id = await f.makePage(), group = randomUUID()
      await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by) VALUES($1,$2,'Sharing group',$3)", [group, f.workspaceId, f.owner])
      await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [group, f.member])
      await f.grant(id, lowerRole, 'workspace', null)
      await f.grant(id, lowerRole, 'group', group)
      await f.grant(id, userRole)
      const before = await f.snapshot(id)
      expect((await f.store.update(f.member, id, { name: 'Changed' })) !== null).toBe(allowed)
      if (!allowed) expect(await f.snapshot(id)).toEqual(before)
    })
  }

  for (const [groupRole, workspaceRole, allowed] of [['comment', 'full', false], ['edit', 'view', true]] as const) {
    it(`single applicable group ${groupRole} overrides workspace ${workspaceRole}`, async () => {
      const f = await fixture(), id = await f.makePage(), group = randomUUID()
      await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by) VALUES($1,$2,'Sharing group',$3)", [group, f.workspaceId, f.owner])
      await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)', [group, f.member])
      await f.grant(id, workspaceRole, 'workspace', null)
      await f.grant(id, groupRole, 'group', group)
      expect((await f.store.update(f.member, id, { name: 'Changed' })) !== null).toBe(allowed)
    })
  }

  for (const status of ['expired', 'revoked'] as const) {
    it(`ignores ${status} user downgrade and retains workspace edit`, async () => {
      const f = await fixture(), id = await f.makePage()
      await f.grant(id, 'edit', 'workspace', null)
      await f.grant(id, 'view', 'user', f.member, status)
      expect(await f.store.update(f.member, id, { name: 'Changed' })).toMatchObject({ name: 'Changed' })
    })
  }

  it('excludes public principals from authenticated member role resolution', async () => {
    const f = await fixture(), id = await f.makePage()
    await f.grant(id, 'view', 'link', 'synthetic-token-hash')
    await f.grant(id, 'comment', 'published', null)
    expect(await f.store.update(f.member, id, { name: 'Changed' })).toMatchObject({ name: 'Changed' })
  })

  it('does not let creator or workspace owner override an explicit view downgrade', async () => {
    const f = await fixture(), id = await f.makePage()
    await f.grant(id, 'view', 'user', f.owner)
    const before = await f.snapshot(id)
    expect.soft(await f.store.getById(f.owner, id)).toMatchObject({ id })
    expect.soft(await f.store.update(f.owner, id, { name: 'Changed' })).toBeNull()
    expect.soft((await request(f.app(f.owner)).patch(`/api/saved-views/${id}`).send({ icon: 'star' })).status).toBe(404)
    expect.soft(await f.snapshot(id)).toEqual(before)
  })

  it('keeps private creator admission and hides private, foreign-member and missing pages equally', async () => {
    const f = await fixture(), privateId = await f.makePage({ private: true }), generalId = await f.makePage()
    await f.grant(privateId, 'full')
    expect(await f.store.getById(f.member, privateId)).toBeNull()
    expect(await f.store.update(f.member, privateId, { name: 'Changed' })).toBeNull()
    expect(await f.store.update(f.owner, privateId, { name: 'Creator edit' })).toMatchObject({ name: 'Creator edit' })
    const hidden = await request(f.app()).patch(`/api/saved-views/${privateId}`).send({ name: 'Denied' })
    const foreign = await request(f.app(f.outsider)).patch(`/api/saved-views/${generalId}`).send({ name: 'Denied' })
    const missing = await request(f.app()).patch(`/api/saved-views/${randomUUID()}`).send({ name: 'Denied' })
    expect([hidden.status, foreign.status, missing.status]).toEqual([404, 404, 404])
    expect(hidden.body).toEqual(missing.body)
    expect(foreign.body).toEqual(missing.body)
  })

  it('retains independent current agent mutation ceilings despite an explicit full role', async () => {
    const f = await fixture(), id = await f.makePage(), groupStore = createDbWorkspaceGroupStore()
    const team = await groupStore.createTeam(f.owner, f.workspaceId, { name: 'Page department', key: 'page-department' })
    await groupStore.addMember(f.owner, team.id, f.member)
    await pool.query('UPDATE teamspaces SET workspace_group_id=$2 WHERE id=$1', [f.teamspaceId, team.id])
    await f.grant(id, 'full')
    const access = { workspaceId: f.workspaceId, userId: f.member, clearance: 'confidential' as const, compartments: [team.compartmentKey!], mutationCompartments: [], projectIds: null, visibilityAssistantIds: null }
    expect(await runWithAgentAccess(access, () => f.store.getById(f.member, id))).toMatchObject({ id })
    expect(await runWithAgentAccess(access, () => f.store.update(f.member, id, { name: 'Denied' }))).toBeNull()
    expect(await runWithAgentAccess({ ...access, mutationCompartments: [team.compartmentKey!] }, () => f.store.update(f.member, id, { name: 'Allowed' }))).toMatchObject({ name: 'Allowed' })
  })


  it('a temporary Department read grant plus Page full still cannot mutate root or documents', async () => {
    const f = await fixture(), id = await f.makePage({ documents: true }), groups = createDbWorkspaceGroupStore()
    const team = await groups.createTeam(f.owner, f.workspaceId, { name: 'Read department', key: 'read-department' })
    await pool.query('UPDATE teamspaces SET workspace_group_id=$2 WHERE id=$1', [f.teamspaceId, team.id])
    const requestId = randomUUID()
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Page fixture',now()-interval '1 day',now()+interval '1 day',repeat('a',64),1,'approved',$5,now())`, [requestId, f.workspaceId, f.member, team.id, f.owner])
    const grantId = (await pool.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1 RETURNING id`, [requestId])).rows[0].id
    await f.grant(id, 'full')
    const before = await f.snapshot(id)
    expect(await f.store.getById(f.member, id)).toMatchObject({ id })
    expect(await f.store.getPage(f.member, id)).toEqual(f.page)
    expect(await f.store.update(f.member, id, { name: 'Denied' })).toBeNull()
    expect((await queryWithRLS(f.member, "UPDATE documents SET snapshot_title='Denied' WHERE page_id=$1 RETURNING page_id", [id])).rows).toHaveLength(0)
    expect(await f.snapshot(id)).toEqual(before)
    await pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1', [grantId, f.owner])
    expect(await f.store.getById(f.member, id)).toBeNull()
  })

  it('preserves legitimate comment writes and creator share management under an explicit comment role', async () => {
    const f = await fixture(), id = await f.makePage(), assistantId = randomUUID()
    await f.grant(id, 'comment')
    await f.grant(id, 'view', 'user', f.owner)
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,clearance) VALUES($1,$2,$3,'Comment fixture','internal')", [assistantId, f.workspaceId, f.owner])
    const comments = createDbCommentThreadStore()
    const thread = await comments.createThread({ userId: f.member, pageId: id, workspaceId: f.workspaceId, assistantId, anchorKind: 'human_block', anchorBlockId: 'body', firstComment: { role: 'user', body: 'First comment', senderUserId: f.member } })
    expect(thread.pageId).toBe(id)
    expect(await comments.addComment({ userId: f.member, threadId: thread.id, role: 'user', body: 'Reply', senderUserId: f.member })).toMatchObject({ body: 'Reply' })
    expect(await comments.setResolved({ userId: f.member, threadId: thread.id, resolved: true })).toMatchObject({ resolvedBy: f.member })
    const sharing = await request(f.app(f.owner)).post(`/api/views/${id}/grants`).send({ principalType: 'workspace', principalRef: f.workspaceId, role: 'edit' })
    expect(sharing.status).toBe(201)
    expect(sharing.body.grant.role).toBe('edit')
    expect(await f.store.update(f.owner, id, { name: 'Still denied' })).toBeNull()
  })

  it('canonical role is opaque for unavailable pages and explicit for the admitted no-grant baseline', async () => {
    const f = await fixture(), id = await f.makePage(), privateId = await f.makePage({ private: true })
    const resolve = async (actor: string, pageId: string) => (await queryWithRLS(actor,
      'SELECT public.saved_view_effective_role($1::uuid) AS role,public.saved_view_edit_operation_scope_allows($1::uuid) AS editable', [pageId])).rows[0]
    expect(await resolve(f.member, id)).toEqual({ role: 'edit', editable: true })
    for (const role of ['view', 'comment', 'edit', 'full'] as const) {
      await pool.query('DELETE FROM page_grants WHERE page_id=$1', [id])
      await f.grant(id, role)
      expect(await resolve(f.member, id)).toEqual({ role, editable: role === 'edit' || role === 'full' })
    }
    await f.grant(privateId, 'full')
    for (const [actor, pageId] of [[f.member, privateId], [f.outsider, id], [f.member, randomUUID()]]) {
      expect(await resolve(actor!, pageId!)).toEqual({ role: null, editable: false })
    }
  })

  it('missing and malformed actor contexts cannot obtain role or edit capability', async () => {
    const f = await fixture(), id = await f.makePage(), client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      for (const actor of ['', 'not-a-uuid', randomUUID()]) {
        await client.query("SELECT set_config('app.current_user_id',$1,true)", [actor])
        expect((await client.query('SELECT public.saved_view_effective_role($1) AS role,public.saved_view_edit_operation_scope_allows($1) AS editable', [id])).rows).toEqual([{ role: null, editable: false }])
      }
    } finally { await client.query('ROLLBACK'); client.release() }
  })

  it('canonical callable ACLs and definer configuration expose no PUBLIC execute or arbitrary actor argument', async () => {
    const rows = (await pool.query(`SELECT p.proname,p.prosecdef,p.provolatile,p.pronargs,p.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) AS public_execute,
      has_function_privilege('app_user',p.oid,'EXECUTE') AS app_execute,
      NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE a.grantee NOT IN(p.proowner,(SELECT oid FROM pg_roles WHERE rolname='app_user')) OR a.is_grantable) AS narrow_acl
      FROM pg_proc p WHERE p.oid IN('public.saved_view_effective_role(uuid)'::regprocedure,'public.saved_view_edit_operation_scope_allows(uuid)'::regprocedure)
      ORDER BY p.proname`)).rows
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toMatchObject({ prosecdef: true, provolatile: 's', pronargs: 1, proconfig: ['search_path=pg_catalog, public'], public_execute: false, app_execute: true, narrow_acl: true })
  })

  it('preserves cross-workspace group applicability through supported workspace membership removal and restoration', async () => {
    const f = await fixture(), id = await f.makePage(), otherWorkspace = randomUUID(), group = randomUUID()
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Group directory fixture',$2)", [otherWorkspace, f.owner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [otherWorkspace, f.owner, f.member])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by) VALUES($1,$2,'Cross workspace group',$3)", [group, otherWorkspace, f.owner])
    // Canonical migration 472 requires a workspace member BEFORE group join.
    await createDbWorkspaceGroupStore().addMember(f.owner, group, f.member)
    await f.grant(id, 'comment', 'group', group)
    const resolve = () => queryWithRLS(f.member, 'SELECT public.saved_view_effective_role($1) AS role', [id])
    const visibleGroup = () => queryWithRLS(f.member, 'SELECT group_id FROM workspace_group_members WHERE group_id=$1', [group])
    expect((await visibleGroup()).rows).toHaveLength(1)
    expect((await resolve()).rows).toEqual([{ role: 'comment' }])
    expect(await f.store.update(f.member, id, { name: 'Denied' })).toBeNull()

    // Production workspace removal revokes directory admission. Its current
    // contract does not delete sharing-group rows, so that residual row must
    // not become applicable through a SECURITY DEFINER role resolver.
    expect(await createWorkspaceStore().removeMember(f.owner, otherWorkspace, f.member)).toBe(true)
    expect((await pool.query('SELECT group_id FROM workspace_group_members WHERE group_id=$1 AND user_id=$2', [group, f.member])).rows).toHaveLength(1)
    expect((await visibleGroup()).rows).toHaveLength(0)
    expect((await resolve()).rows).toEqual([{ role: 'edit' }])
    expect(await f.store.update(f.member, id, { name: 'Allowed after membership removal' })).toMatchObject({ name: 'Allowed after membership removal' })

    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [otherWorkspace, f.member])
    expect((await visibleGroup()).rows).toHaveLength(1)
    expect((await resolve()).rows).toEqual([{ role: 'comment' }])
    expect(await f.store.update(f.member, id, { name: 'Denied after restoration' })).toBeNull()
  })
})
