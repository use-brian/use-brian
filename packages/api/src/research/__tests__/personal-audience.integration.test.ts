/** Default research Page audience through real native stores and app-role RLS. */
import { randomUUID } from 'node:crypto'
import express from 'express'
import pg from 'pg'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { createWorkspaceStore } from '../../db/workspace-store.js'
import { createDbSavedViewStore } from '../../db/saved-views-store.js'
import { createDbDocPageStore } from '../../db/doc-page-store.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { readWorkspacePageDirectory } from '../../db/page-directory.js'
import { createSearchAdapters, readSearchItem } from '../../workspace-search/adapters.js'
import { createWorkspaceSearchService } from '../../workspace-search/service.js'
import { viewsRoutes } from '../../routes/views.js'
import { getResearchActivityForViewer, openResearchActivitySystem, type ResearchActivity } from '../../db/research-store.js'
import { beginResearchActivity, createResearchDeliveryDeps } from '../runtime.js'
import { recordResearchDelivery } from '../delivery.js'
import { briefFixture, savedResearch } from './fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), search = createWorkspaceSearchService(createSearchAdapters())
const marker = 'privatequartzresearch'

async function fixture() {
  const owner = randomUUID(), actor = randomUUID(), workspaces = createWorkspaceStore()
  for (const id of [owner, actor]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  // Production creation seeds ordinary General; production membership joins it.
  const workspace = await workspaces.create(owner, 'Research audience fixture', 'Compare fictional suppliers')
  await workspaces.addMember(owner, workspace.id, actor)
  const workspaceId = workspace.id
  const assistantId = (await pool.query("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary'", [workspaceId])).rows[0].id as string
  const generalId = (await pool.query('SELECT id FROM teamspaces WHERE workspace_id=$1 AND is_default', [workspaceId])).rows[0].id as string
  expect((await pool.query('SELECT user_id FROM teamspace_members WHERE teamspace_id=$1 ORDER BY user_id', [generalId])).rows.map(r => r.user_id).sort()).toEqual([owner, actor].sort())
  expect((await pool.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1', [workspaceId])).rows).toHaveLength(2)
  const lifecycle = vi.fn(), store = createDbSavedViewStore({ onPageLifecycle: lifecycle }), docs = createDbDocPageStore()
  const deps = createResearchDeliveryDeps(store)
  async function open(opts: { visibility?: 'personal' | 'workspace'; projectId?: string | null; sensitivity?: 'internal' | 'confidential'; activityCompartments?: string[]; requestCompartments?: string[]; sessionTeam?: { id: string; compartmentKey: string | null }; absentCapturedVersion?: boolean; legacyRequest?: boolean } = {}) {
    const sessionId = randomUUID(), requestId = randomUUID(), outputId = randomUUID()
    await pool.query(`INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id,effective_clearance,visibility,anchor_kind,app_origin,context_project_id,context_group_id,context_compartments)
      VALUES($1,$2,$3,'web',$1::uuid::text,$4,'internal',$5,'none','chat',$6,$7,$8)`, [sessionId, assistantId, actor, workspaceId, opts.visibility ?? 'personal', opts.projectId ?? null, opts.sessionTeam?.id ?? null, opts.sessionTeam ? [opts.sessionTeam.compartmentKey!] : []])
    const requestText = `Research ${marker} suppliers`
    for (const [id,role,text,sequence] of [[requestId,'user',requestText,1],[outputId,'assistant',`${marker} findings`,2]] as const) {
      if (opts.legacyRequest && role === 'user') {
        // Retained all-NULL legacy scope is a valid native schema shape (608).
        await pool.query('INSERT INTO session_messages(id,session_id,role,content,sequence_num) VALUES($1,$2,$3,$4::jsonb,$5)', [id,sessionId,role,JSON.stringify([{type:'text',text}]),sequence])
      } else {
        await pool.query(`INSERT INTO session_messages(id,session_id,role,content,sequence_num,workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,'internal',$9,'{}',1,false)`, [id,sessionId,role,JSON.stringify([{type:'text',text}]),sequence,workspaceId,actor,assistantId,role === 'user' ? opts.requestCompartments ?? [] : []])
      }
    }
    const activity = opts.absentCapturedVersion
      ? (await openResearchActivitySystem({ workspaceId,sessionId,requestMessageId:requestId,requestMessageVersion:null,actorUserId:actor,assistantId,
          projectId:opts.projectId ?? null,entry:'explicit',runtime:{surface:'test'},sensitivity:'internal',compartments:[],plannedPageId:randomUUID(),idempotencyKey:`legacy-version:${randomUUID()}` })).activity
      : await beginResearchActivity({ workspaceId, sessionId, requestMessageId: requestId, actorUserId: actor, assistantId,
          projectId: opts.projectId ?? null, entry: 'explicit', runtime: { surface: 'test' }, sensitivity: opts.sensitivity ?? 'internal', compartments:opts.activityCompartments })
    return { activity, sessionId, requestId, outputId, requestText }
  }
  function deliver(source: Awaited<ReturnType<typeof open>>, activity: ResearchActivity = source.activity) {
    return recordResearchDelivery(deps, { activity, observation: { receipts: [], sources: [], gaps: [] },
      finalText: `## ${marker} findings\nFictional supplier comparison.`, outputMessageId: source.outputId, requestText: source.requestText })
  }
  function app(userId: string) {
    const app = express()
    app.use(express.json(), (req, _res, next) => { req.userId = userId; next() })
    app.use('/api', viewsRoutes({ savedViewStore: store, workspaceStore: workspaces } as Parameters<typeof viewsRoutes>[0]))
    return app
  }
  async function snapshot() {
    return (await pool.query(`SELECT
      (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM saved_views s WHERE workspace_id=$1) AS pages,
      (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY revision),'[]') FROM workflow_page_event_receipts r WHERE workspace_id=$1) AS receipts,
      (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY id),'[]') FROM research_artifact_links l WHERE workspace_id=$1) AS links`, [workspaceId])).rows[0]
  }
  return { owner, actor, workspaceId, assistantId, generalId, workspaces, store, docs, lifecycle, open, deliver, app, snapshot }
}

async function expectRefused(f: Awaited<ReturnType<typeof fixture>>, source: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['open']>>, activity = source.activity) {
  let result: ResearchActivity | undefined
  try { result = await f.deliver(source, activity) }
  catch (error) { expect(error).toMatchObject({ code: 'research_source_unavailable' }) }
  if (result) {
    expect.soft(result.status).toBe('partial')
    expect.soft(String(result.saveError ?? '')).toMatch(/^research_source_(unavailable|changed|unsupported)$/)
  }
  expect.soft((await pool.query('SELECT id FROM saved_views WHERE id=$1', [source.activity.plannedPageId])).rows).toHaveLength(0)
  expect.soft((await pool.query('SELECT id FROM research_artifact_links WHERE activity_id=$1', [source.activity.id])).rows).toHaveLength(0)
  expect.soft(f.lifecycle).not.toHaveBeenCalled()
}

afterAll(async () => { await getAppPool().end(); await pool.end() })

describe('[COMP:api/research-source-authority] selected personal WEB default Page audience (PG18)', () => {
  it('uses actual nonowner non-BYPASSRLS app_user for all actor projections', async () => {
    const role = (await getAppPool().query(`SELECT session_user,current_user,r.rolsuper,r.rolbypassrls,
      pg_get_userbyid(c.relowner)=session_user AS owns_pages FROM pg_roles r CROSS JOIN pg_class c
      WHERE r.rolname=session_user AND c.oid='saved_views'::regclass`)).rows[0]
    expect(role).toEqual({ session_user: 'app_user', current_user: 'app_user', rolsuper: false, rolbypassrls: false, owns_pages: false })
  })

  it('keeps a personal result private despite ordinary General admitting both current members', async () => {
    const f = await fixture(), source = await f.open(), settled = await f.deliver(source), id = source.activity.plannedPageId!
    expect(settled).toMatchObject({ status: 'saved', saveError: null })
    const raw = (await pool.query('SELECT teamspace_id,project_id,shared_project_id,nest_parent_id,state,auto_prune_at FROM saved_views WHERE id=$1', [id])).rows[0]
    expect.soft(raw).toEqual({ teamspace_id: null, project_id: null, shared_project_id: null, nest_parent_id: null, state: 'saved', auto_prune_at: null })
    const own = await request(f.app(f.actor)).get(`/api/views/${id}`)
    expect(own.status).toBe(200)
    expect(own.body).toMatchObject({ id, name: source.requestText, originPrompt: source.requestText })
    expect(await f.store.getPage(f.actor, id)).toMatchObject({ blocks: expect.any(Array) })
    expect(JSON.stringify(await f.docs.getVersionedPage(f.actor, id))).toContain(marker)
    // Workspace ownership does not authorize another member's personal result.
    expect.soft(await f.store.getById(f.owner, id)).toBeNull()
    expect.soft(await f.store.getPage(f.owner, id)).toBeNull()
    expect.soft(await f.docs.getVersionedPage(f.owner, id)).toBeNull()
    for (const path of [`/api/views/${id}`, `/api/saved-views/${id}`]) {
      const hidden = await request(f.app(f.owner)).get(path)
      expect.soft(hidden.status).toBe(404)
      expect.soft(JSON.stringify(hidden.body)).not.toContain(marker)
    }
    expect((await f.store.list({ userId: f.actor, workspaceId: f.workspaceId })).map(p => p.id)).toContain(id)
    expect((await readWorkspacePageDirectory(f.actor, f.workspaceId)).status).toBe(200)
    expect((await search({ userId: f.actor, workspaceId: f.workspaceId }, { q: marker, kind: 'pages' })).items.map(p => p.id)).toContain(id)
    expect.soft((await f.store.list({ userId: f.owner, workspaceId: f.workspaceId })).map(p => p.id)).not.toContain(id)
    const directory = await readWorkspacePageDirectory(f.owner, f.workspaceId)
    expect(directory.status).toBe(200)
    if (directory.status === 200) expect.soft(directory.body.pages.map(p => p.id)).not.toContain(id)
    expect.soft((await search({ userId: f.owner, workspaceId: f.workspaceId }, { q: marker, kind: 'pages' })).items).toEqual([])
    expect.soft(await readSearchItem({ userId: f.owner, workspaceId: f.workspaceId }, 'pages', `page:${id}`, new AbortController().signal)).toBeNull()
    // The History first-prompt entry consumes originPrompt from the metadata
    // response above, so its payload is denied too; there is no second history API.
    expect(await getResearchActivityForViewer(f.owner, f.workspaceId, source.activity.id)).toBeNull()
    expect(f.lifecycle).toHaveBeenCalledTimes(1)
  })

  for (const change of ['held', 'edited', 'deleted', 'membership'] as const) {
    it(`refuses a ${change} originating source instead of falling through to General`, async () => {
      const f = await fixture(), source = await f.open()
      if (change === 'held') await pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1', [source.requestId])
      if (change === 'edited') await pool.query(`UPDATE session_messages SET content='[{"type":"text","text":"Changed request"}]'::jsonb WHERE id=$1`, [source.requestId])
      if (change === 'deleted') await pool.query('DELETE FROM session_messages WHERE id=$1', [source.requestId])
      if (change === 'membership') expect(await f.workspaces.removeMember(f.owner, f.workspaceId, f.actor)).toBe(true)
      await expectRefused(f, source)
    })
  }

  it('refuses a mismatched trusted activity/request identity rather than authoring from unrelated private source', async () => {
    const f = await fixture(), source = await f.open(), other = await f.open()
    await expectRefused(f, source, { ...source.activity, requestMessageId: other.requestId })
  })

  it('replays one matching private planned ID and reports the actual current version without a second lifecycle', async () => {
    const f = await fixture(), source = await f.open(), id = source.activity.plannedPageId!
    await f.deliver(source)
    const old = await f.docs.getVersionedPage(f.actor, id)
    expect(old).not.toBeNull()
    const patch = await f.docs.applyPatch({ userId: f.actor, pageId: id, expectedVersion: old!.version,
      nextPage: { blocks: [{ id: 'changed', kind: 'text', text: 'Edited retained result' }] },
      undo: { appliedAt: new Date().toISOString(), resultingVersion: old!.version + 1, inverseOps: [] } })
    expect(patch).not.toBeNull()
    const before = await f.snapshot()
    const replayed = await f.deliver(source)
    expect(replayed.status).toBe('saved')
    const after = await f.snapshot()
    expect.soft(after.pages).toEqual(before.pages)
    expect.soft(after.receipts).toEqual(before.receipts)
    expect.soft(f.lifecycle).toHaveBeenCalledTimes(1)
    const detail = await getResearchActivityForViewer(f.actor, f.workspaceId, source.activity.id)
    expect.soft(detail?.artifacts.some(a => a.version === old!.version + 1)).toBe(true)
    expect.soft((await f.store.getById(f.actor, id))?.teamspaceId).toBeNull()
  })

  it('conflicts with an owned shared General planned ID without relocating, replacing or claiming a new write', async () => {
    const f = await fixture(), source = await f.open(), id = source.activity.plannedPageId!
    await pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,page,state,teamspace_id)
      VALUES($1,$2,$3,'Existing shared page','tasks','table','{"blocks":[]}','saved',$4)`, [id,f.workspaceId,f.actor,f.generalId])
    const before = await f.snapshot()
    const result = await f.deliver(source)
    expect.soft(result.status).toBe('partial')
    expect.soft(String(result.saveError ?? '')).toMatch(/^(research_source_(changed|unavailable)|research_page_placement_conflict)$/)
    expect.soft(await f.snapshot()).toEqual(before)
    expect.soft(f.lifecycle).not.toHaveBeenCalled()
  })

  it('keeps a formerly saved result historical when source authority is later unavailable', async () => {
    const f = await fixture(), source = await f.open(), id = source.activity.plannedPageId!
    const saved = await f.deliver(source)
    await pool.query('UPDATE session_messages SET scope_held=true WHERE id=$1', [source.requestId])
    const before = await f.snapshot()
    let rejected = false
    try { await f.deliver(source, saved) }
    catch (error) { expect(error).toMatchObject({ code: 'research_source_unavailable' }); rejected = true }
    expect.soft(rejected).toBe(true)
    expect.soft(await f.snapshot()).toEqual(before)
    expect.soft((await pool.query('SELECT status FROM research_activities WHERE id=$1', [saved.id])).rows[0].status).toBe('saved')
    expect.soft((await f.store.getById(f.actor, id))?.teamspaceId).toBeNull()
    expect.soft(f.lifecycle).toHaveBeenCalledTimes(1)
  })

  it('rechecks the source after waiting on the canonical workspace placement barrier', async () => {
    const f = await fixture(), source = await f.open(), blocker = await pool.connect()
    let pending: Promise<ResearchActivity> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId])
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = f.deliver(source)
      let waiting = false
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const blocked = await pool.query(`SELECT 1 FROM pg_stat_activity a WHERE a.usename='app_user'
          AND $1::int=ANY(pg_blocking_pids(a.pid)) AND a.query LIKE '%SELECT id FROM workspaces%'`, [blockerPid])
        if (blocked.rows.length) { waiting = true; break }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(waiting).toBe(true)
      // The canonical source-version trigger also takes the workspace lock.
      // Commit its supported hold in the transaction that already owns it.
      await blocker.query('UPDATE session_messages SET scope_held=true WHERE id=$1', [source.requestId])
      await blocker.query('COMMIT')
      let result: ResearchActivity | undefined
      try { result = await pending }
      catch (error) { expect(error).toMatchObject({ code: 'research_source_unavailable' }) }
      if (result) expect.soft(result).toMatchObject({ status: 'partial', saveError: expect.stringMatching(/^research_source_/) })
      expect.soft((await pool.query('SELECT id FROM saved_views WHERE id=$1', [source.activity.plannedPageId])).rows).toHaveLength(0)
      expect.soft(f.lifecycle).not.toHaveBeenCalled()
    } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending.catch(() => {}) }
  })

  it('keeps plain workspace-room output in General and readable to its existing room audience', async () => {
    const f = await fixture(), source = await f.open({ visibility: 'workspace' })
    expect((await f.deliver(source)).status).toBe('saved')
    expect(await f.store.getById(f.owner, source.activity.plannedPageId!)).toMatchObject({ teamspaceId: f.generalId })
  })

  it('keeps legacy user-Project output placement unchanged', async () => {
    const f = await fixture(), projectId = randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Legacy project','legacy project',$3)", [projectId,f.workspaceId,f.actor])
    const source = await f.open({ projectId })
    expect((await f.deliver(source)).status).toBe('saved')
    expect(await f.store.getById(f.actor, source.activity.plannedPageId!)).toMatchObject({ teamspaceId: f.generalId, projectId, sharedProjectId: null })
  })

  it('keeps admitted shared Project collection output unchanged', async () => {
    const f = await briefFixture(), result = await savedResearch(f, f.people.member, f.projectId)
    expect(result.activity.status).toBe('saved')
    expect(await createDbSavedViewStore().getById(f.people.lead, result.activity.plannedPageId!)).toMatchObject({ sharedProjectId: f.projectId, teamspaceId: null })
  })

  it('retains ready-profile source-derived refusal rather than presenting private placement as an adapter', async () => {
    const f = await fixture(), source = await f.open()
    await pool.query('INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING', [f.workspaceId])
    expect((await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1", [f.workspaceId])).rowCount).toBe(1)
    expect(await f.deliver(source)).toMatchObject({ status: 'partial', saveError: 'page_source_admission_required' })
    expect((await pool.query('SELECT id FROM saved_views WHERE id=$1', [source.activity.plannedPageId])).rows).toHaveLength(0)
    expect(f.lifecycle).not.toHaveBeenCalled()
  })

  it('refuses an actor-hidden confidential activity without owner projection settlement', async () => {
    const f = await fixture(), source = await f.open({ sensitivity: 'confidential' }), before = await f.snapshot()
    expect(await getResearchActivityForViewer(f.actor, f.workspaceId, source.activity.id)).toBeNull()
    await expect(f.deliver(source)).rejects.toMatchObject({ code: 'research_source_unavailable' })
    expect(await f.snapshot()).toEqual(before)
    expect(f.lifecycle).not.toHaveBeenCalled()
  })

  it('retains existing confidential-floor refusal for a currently admitted actor', async () => {
    const f = await fixture()
    await pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.actor])
    const source = await f.open({ sensitivity: 'confidential' })
    expect(await getResearchActivityForViewer(f.actor, f.workspaceId, source.activity.id)).not.toBeNull()
    expect(await f.deliver(source)).toMatchObject({ status: 'partial', saveError: 'research_confidential_floor' })
    expect((await pool.query('SELECT id FROM saved_views WHERE id=$1', [source.activity.plannedPageId])).rows).toHaveLength(0)
  })

  for (const floor of ['activity', 'request', 'session'] as const) {
    it(`refuses an actor-readable actual ${floor} Team floor without silently erasing it`, async () => {
      const f = await fixture(), groups = createDbWorkspaceGroupStore()
      const team = await groups.createTeam(f.owner,f.workspaceId,{ name:'Research department',key:'research-department' })
      await groups.addMember(f.owner,team.id,f.actor)
      await groups.setTeamAssistant(f.owner,team.id,f.assistantId,true)
      expect(await groups.activateMemberTeamMode(f.actor,f.workspaceId,f.actor)).toBe(true)
      const granted = (await queryWithRLS(f.actor,'SELECT effective_member_team_compartments($1,$2) AS labels',[f.actor,f.workspaceId])).rows[0].labels
      expect(granted).not.toBeNull()
      expect(granted).toContain(team.compartmentKey)
      const labels = [team.compartmentKey!]
      const source = await f.open(floor === 'activity' ? { activityCompartments:labels }
        : floor === 'request' ? { requestCompartments:labels } : { sessionTeam:team })
      const requestRow = await queryWithRLS(f.actor,'SELECT id,scope_version,compartments FROM session_messages WHERE id=$1',[source.requestId])
      expect(requestRow.rows).toHaveLength(1)
      expect((await queryWithRLS(f.actor,'SELECT id,context_compartments FROM sessions WHERE id=$1',[source.sessionId])).rows).toHaveLength(1)
      expect(await getResearchActivityForViewer(f.actor,f.workspaceId,source.activity.id)).not.toBeNull()
      const identity = (await pool.query('SELECT request_message_version::text AS captured FROM research_activities WHERE id=$1',[source.activity.id])).rows[0]
      expect(identity.captured).toBe(String(requestRow.rows[0].scope_version))
      const before = await f.snapshot()
      await expectRefused(f,source)
      expect(await f.snapshot()).toEqual(before)
    })
  }

  for (const legacy of ['missing captured version', 'nullable legacy request version'] as const) {
    it(`refuses a readable source with ${legacy} without canonical effects`, async () => {
      const f = await fixture(), source = await f.open(legacy === 'missing captured version' ? { absentCapturedVersion:true } : { legacyRequest:true })
      const request = (await queryWithRLS(f.actor,'SELECT id,scope_version FROM session_messages WHERE id=$1',[source.requestId])).rows[0]
      expect(request).toBeDefined()
      expect(await getResearchActivityForViewer(f.actor,f.workspaceId,source.activity.id)).not.toBeNull()
      const captured = (await pool.query('SELECT request_message_version FROM research_activities WHERE id=$1',[source.activity.id])).rows[0].request_message_version
      if (legacy === 'missing captured version') { expect(captured).toBeNull(); expect(request.scope_version).not.toBeNull() }
      else expect(request.scope_version).toBeNull()
      const before = await f.snapshot()
      await expectRefused(f,source)
      expect(await f.snapshot()).toEqual(before)
    })
  }

  it('pins exact membership session and request rows on the actual writer before INSERT', async () => {
    const f = await fixture(), source = await f.open(), before = await f.snapshot()
    const sourceState = async () => (await pool.query(`SELECT
      (SELECT to_jsonb(m) FROM workspace_members m WHERE workspace_id=$1 AND user_id=$2) AS membership,
      (SELECT to_jsonb(s) FROM sessions s WHERE id=$3) AS session,
      (SELECT to_jsonb(m) FROM session_messages m WHERE id=$4) AS request`,[f.workspaceId,f.actor,source.sessionId,source.requestId])).rows[0]
    const sourceBefore = await sourceState()
    const original = pg.Client.prototype.query
    let releaseInsert!: () => void, reachedInsert!: () => void
    const released = new Promise<void>(resolve => { releaseInsert = resolve })
    const reached = new Promise<void>(resolve => { reachedInsert = resolve })
    const pinClients: { table:string; client:pg.Client }[] = []
    let writer: pg.Client | undefined, gateOnce = false, pending: Promise<ResearchActivity> | undefined
    // This observes/delegates every real query unchanged. Only the timing of
    // the actual Page INSERT is gated; no row, predicate or authority is mocked.
    const spy = vi.spyOn(pg.Client.prototype,'query').mockImplementation((function(this:pg.Client,...args:unknown[]) {
      const first = args[0] as string | { text?:string }
      const sql = typeof first === 'string' ? first : first?.text ?? ''
      const params = args[1] as unknown[] | undefined
      for (const table of ['workspace_members','sessions','session_messages']) {
        if (sql.includes(`FROM ${table} WHERE`) && sql.includes('FOR SHARE')) pinClients.push({table,client:this})
      }
      if (!gateOnce && /INSERT\s+INTO\s+saved_views/.test(sql) && Array.isArray(params) && params.includes(f.workspaceId)) {
        gateOnce = true; writer = this; reachedInsert()
        return released.then(() => Reflect.apply(original,this,args))
      }
      return Reflect.apply(original,this,args)
    }) as typeof original)
    let observer: pg.PoolClient | undefined, timeout: ReturnType<typeof setTimeout> | undefined
    try {
      pending = f.deliver(source)
      await Promise.race([reached,new Promise<never>((_,reject) => { timeout = setTimeout(() => reject(new Error('Page INSERT gate not reached')),5000) })])
      if (timeout) clearTimeout(timeout)
      expect(pinClients.map(p => p.table)).toEqual(['workspace_members','sessions','session_messages'])
      expect(pinClients.every(p => p.client === writer)).toBe(true)
      const role = (await Reflect.apply(original,writer!,['SELECT session_user,current_user,pg_backend_pid() AS pid'])).rows[0]
      expect(role).toMatchObject({session_user:'app_user',current_user:'app_user'})
      observer = await pool.connect()
      for (const [sql,values] of [
        ['SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE NOWAIT',[f.workspaceId,f.actor]],
        ['SELECT id FROM sessions WHERE id=$1 FOR UPDATE NOWAIT',[source.sessionId]],
        ['SELECT id FROM session_messages WHERE id=$1 FOR UPDATE NOWAIT',[source.requestId]],
      ] as const) {
        await observer.query('BEGIN')
        try { await expect(observer.query(sql,[...values])).rejects.toMatchObject({code:'55P03'}) }
        finally { await observer.query('ROLLBACK') }
      }
      expect(await f.snapshot()).toEqual(before)
      releaseInsert()
      expect(await pending).toMatchObject({status:'saved',saveError:null})
      expect(await f.store.getById(f.actor,source.activity.plannedPageId!)).toMatchObject({teamspaceId:null})
      expect((await queryWithRLS(f.actor,'SELECT id FROM session_messages WHERE id=$1',[source.requestId])).rows).toHaveLength(1)
      expect(f.lifecycle).toHaveBeenCalledTimes(1)
      expect(await sourceState()).toEqual(sourceBefore)
    } finally {
      if (timeout) clearTimeout(timeout)
      releaseInsert()
      await pending?.catch(() => undefined)
      spy.mockRestore()
      if (observer) { await observer.query('ROLLBACK'); observer.release() }
    }
  })

  it('preserves private create and replay with distinct app and owner pools (constrained-pool selection)', async () => {
    expect(getAppPool()).not.toBe(pool)
    expect(process.env.PG_SINGLE_CONNECTION).not.toBe('true')
    expect(getAppPool().options.max).toBe(Number(process.env.PG_POOL_MAX ?? 4))
    expect(pool.options.max).toBe(Number(process.env.PG_POOL_MAX ?? 4))
    const f = await fixture(), source = await f.open()
    expect(await f.deliver(source)).toMatchObject({status:'saved',saveError:null})
    const before = await f.snapshot()
    expect(await f.deliver(source)).toMatchObject({status:'saved',saveError:null})
    expect(await f.snapshot()).toEqual(before)
    expect(f.lifecycle).toHaveBeenCalledTimes(1)
    expect(await f.store.getById(f.owner,source.activity.plannedPageId!)).toBeNull()
  })

  it('refuses a currently review-held request using inherited native message policy', async () => {
    const f = await fixture(), source = await f.open()
    await pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
      SELECT $1,'session_message',id,scope_version::text,'held',1,'Fictional source review' FROM session_messages WHERE id=$2`,[f.workspaceId,source.requestId])
    expect((await queryWithRLS(f.actor,'SELECT id FROM session_messages WHERE id=$1',[source.requestId])).rows).toHaveLength(0)
    const before = await f.snapshot()
    await expectRefused(f,source)
    expect(await f.snapshot()).toEqual(before)
  })

  for (const target of ['hidden private', 'foreign workspace', 'wrong creator'] as const) {
    it(`refuses a ${target} pre-minted Page without relocation or a new receipt`, async () => {
      const f = await fixture(), source = await f.open(), id = source.activity.plannedPageId!
      const foreign = target === 'foreign workspace' ? await fixture() : null
      await pool.query(`INSERT INTO saved_views(id,workspace_id,created_by,name,entity,view_type,page,state,teamspace_id)
        VALUES($1,$2,$3,'Existing result','tasks','table','{"blocks":[]}','saved',$4)`,
      [id,foreign?.workspaceId ?? f.workspaceId,foreign?.owner ?? f.owner,target === 'wrong creator' ? f.generalId : null])
      if (target !== 'wrong creator') expect(await f.store.getById(f.actor,id)).toBeNull()
      const before = await f.snapshot(), targetBefore = (await pool.query('SELECT to_jsonb(s) AS value FROM saved_views s WHERE id=$1',[id])).rows
      const settled = await f.deliver(source)
      expect(settled.status).toBe('partial')
      expect(settled.saveError).toBe('research_page_placement_conflict')
      expect(await f.snapshot()).toEqual(before)
      expect((await pool.query('SELECT to_jsonb(s) AS value FROM saved_views s WHERE id=$1',[id])).rows).toEqual(targetBefore)
      expect(f.lifecycle).not.toHaveBeenCalled()
    })
  }
})
