import { admitPersonalWebSession } from '../../workspace-access/session-create-admission.js'
import { randomUUID } from 'node:crypto'
import express, { type ErrorRequestHandler } from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { sessionRoutes } from '../sessions.js'
import { requireAuth } from '../../auth/middleware.js'
import { createTokens } from '../../auth/jwt.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { getPool, getAppPool, queryWithRLS, applyRLSGucs } from '../../db/client.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { findOrCreateSession } from '../../db/sessions.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), secret = 'personal-session-integration-secret'
afterAll(async () => { await getAppPool().end(); await pool.end() })
const app = express(); app.use(express.json())
app.use('/api/sessions', requireAuth(secret), sessionRoutes())
app.use(((error, _req, res, _next) => { console.error(error); res.status(500).json({ error: error.message }) }) as ErrorRequestHandler)
async function fixture() {
  const owner = randomUUID(), user = randomUUID(), w = randomUUID(), assistant = randomUUID()
  for (const id of [owner,user]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Personal session',$2,false)", [w,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [w,owner,user])
  const groups = createDbWorkspaceGroupStore(), team = await groups.createTeam(owner,w,{name:'Common',key:'common'})
  await groups.addMember(owner,team.id,user)
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,team_scope_mode,default_workspace_group_id) VALUES($1,'Personal',$2,$3,'standard','internal','all',$4)", [assistant,owner,w,team.id])
  await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='simple',default_department_id=$2 WHERE workspace_id=$1", [w,team.id])
  const auth = (await authSessionStore.create(user,{deviceLabel:'test',userAgent:null,ipAddress:null}))!
  const token = createTokens(user,secret,auth).accessToken
  const body = {workspaceId:w,assistantId:assistant,channelId:randomUUID()}
  const post = (patch: Record<string, unknown> = {}, credential = token) => request(app).post('/api/sessions/personal').set('Authorization',`Bearer ${credential}`).send({...body,...patch})
  return {owner,user,w,assistant,team,auth,token,body,post}
}
// Deliberately bypass the helper: a valid app actor/session supplies BOTH a
// fabricated receipt and matching row. Receipt equality cannot authorize scope.
async function pairedInsert(f: Awaited<ReturnType<typeof fixture>>, binding: {
  team?: string | null; project?: string | null; compartments?: string[]
} = {}) {
  const client = await getAppPool().connect(), channelId = randomUUID()
  const revision = (await pool.query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[f.w])).rows[0].revision
  const team = binding.team ?? null, project = binding.project ?? null, compartments = binding.compartments ?? []
  try {
    await client.query('BEGIN'); await applyRLSGucs(client,f.user)
    // Even a caller asserting unrestricted execution GUCs cannot bypass the
    // independent canonical member/assistant checks.
    await client.query("SELECT set_config('app.agent_compartments','null',true), set_config('app.agent_project_ids','null',true), set_config('app.agent_clearance','confidential',true)")
    await client.query("SELECT set_config('app.session_creation_admission',$1,true)",[JSON.stringify({
      protocol:'1',provenance:'authenticated_personal_web',actorUserId:f.user,
      authSessionId:f.auth.id,authVersion:f.auth.authVersion,workspaceId:f.w,policyRevision:revision,
      assistantId:f.assistant,userId:f.user,channelId,appId:'Use Brian',
      contextGroupId:team,contextProjectId:project,compartments,
    })])
    const row = (await client.query(`INSERT INTO sessions(assistant_id,user_id,workspace_id,channel_type,channel_id,app_id,app_origin,
      visibility,context_group_id,context_project_id,context_compartments)
      VALUES($1,$2,$3,'web',$4,'Use Brian','chat','owner',$5,$6,$7)
      RETURNING id,visibility,context_group_id,context_project_id,context_compartments`,
    [f.assistant,f.user,f.w,channelId,team,project,compartments])).rows[0]
    await client.query('COMMIT'); return row
  } finally { await client.query('ROLLBACK'); client.release() }
}
describe('personal web production HTTP admission / app PostgreSQL', () => {
  it('creates private without either default; explicit bound context remains private and unreadable to peers', async () => {
    const f = await fixture(), response = await f.post()
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    expect(response.body.session).toMatchObject({userId:f.user,visibility:'owner',contextGroupId:null,contextProjectId:null,contextCompartments:[],effectiveClearance:null})
    const bound = await f.post({channelId:randomUUID(),contextGroupId:f.team.id})
    expect(bound.status, JSON.stringify(bound.body)).toBe(201)
    expect(bound.body.session).toMatchObject({visibility:'owner',contextGroupId:f.team.id,contextCompartments:[f.team.compartmentKey]})
    expect((await queryWithRLS(f.owner,'SELECT id FROM sessions WHERE id=$1',[response.body.session.id])).rows).toEqual([])
    const role = await getAppPool().query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
    expect(role.rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
  })
  it('retains explicit Project floors and refuses foreign assistants and unauthorized context', async () => {
    const f = await fixture(), other = await fixture(), project = randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Project','project',$3)",[project,f.w,f.owner])
    await pool.query("UPDATE assistants SET project_scope_mode='assigned' WHERE id=$1",[f.assistant])
    expect((await f.post({contextProjectId:project})).status).toBe(404)
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)',[project,f.user])
    await pool.query('INSERT INTO assistant_project_grants(assistant_id,project_id) VALUES($1,$2)',[f.assistant,project])
    const bound = await f.post({contextProjectId:project})
    expect(bound.status).toBe(201)
    expect(bound.body.session).toMatchObject({visibility:'owner',contextGroupId:null,contextProjectId:project,contextCompartments:[]})
    expect((await f.post({channelId:randomUUID(),assistantId:other.assistant})).status).toBe(404)
    expect((await f.post({channelId:randomUUID(),contextGroupId:other.team.id})).status).toBe(404)
  })
  it('rejects body proofs, sessionless credentials, revoked/expired sessions and auth-version changes', async () => {
    const f = await fixture()
    for (const patch of [{visibility:'workspace'},{userId:f.owner},{provenance:'authenticated_personal_web'},{authSessionId:f.auth.id}]) expect((await f.post(patch)).status).toBe(400)
    expect((await f.post({},createTokens(f.user,secret).accessToken)).status).toBe(401)
    await pool.query("UPDATE auth_sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE id=$1", [f.auth.id])
    expect((await f.post()).status).toBe(401)
    const g = await fixture()
    await authSessionStore.revokeForUser(g.user,g.auth.id)
    expect((await g.post()).status).toBe(401)
    const h = await fixture()
    await pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1',[h.user])
    expect((await h.post()).status).toBe(401)
  })
  it('SQL rejects paired receipt/row forgeries outside current member and assistant Team/Project authority', async () => {
    const f = await fixture(), groups = createDbWorkspaceGroupStore()
    const other = await groups.createTeam(f.owner,f.w,{name:'Restricted',key:'restricted'})
    await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=$2",[f.w,f.user])
    if (!other.compartmentKey || !f.team.compartmentKey) throw new Error('Fixture Teams require backing keys')
    const forbidden = {team:other.id,compartments:[other.compartmentKey]}
    await expect(pairedInsert(f,forbidden)).rejects.toMatchObject({code:'42501',message:'personal_session_scope_unavailable'})
    // Owner-private General and the granted Team are valid even in Simple;
    // neither INSERT inherits the assistant or workspace default.
    expect(await pairedInsert(f)).toMatchObject({visibility:'owner',context_group_id:null,context_project_id:null,context_compartments:[]})
    const allowed = {team:f.team.id,compartments:[f.team.compartmentKey]}
    expect(await pairedInsert(f,allowed)).toMatchObject({visibility:'owner',context_group_id:f.team.id})
    await pool.query("UPDATE assistants SET team_scope_mode='assigned',default_workspace_group_id=NULL WHERE id=$1",[f.assistant])
    await expect(pairedInsert(f,allowed)).rejects.toMatchObject({code:'42501'})
    await pool.query('INSERT INTO workspace_group_assistants(group_id,assistant_id) VALUES($1,$2)',[f.team.id,f.assistant])
    expect(await pairedInsert(f,allowed)).toMatchObject({context_group_id:f.team.id})
    await pool.query("UPDATE assistants SET compartments='{}' WHERE id=$1",[f.assistant])
    await expect(pairedInsert(f,allowed)).rejects.toMatchObject({code:'42501'})
    await pool.query('UPDATE assistants SET compartments=NULL WHERE id=$1',[f.assistant])
    await pool.query("UPDATE workspace_members SET compartments='{}' WHERE workspace_id=$1 AND user_id=$2",[f.w,f.user])
    await expect(pairedInsert(f,allowed)).rejects.toMatchObject({code:'42501'})
    await pool.query('UPDATE workspace_members SET compartments=NULL WHERE workspace_id=$1 AND user_id=$2',[f.w,f.user])
    const project = randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Restricted','restricted',$3)",[project,f.w,f.owner])
    await expect(pairedInsert(f,{project})).rejects.toMatchObject({code:'42501'})
    expect((await f.post({channelId:randomUUID(),contextProjectId:project})).status).toBe(404)
    await pool.query('INSERT INTO workspace_project_members(project_id,user_id) VALUES($1,$2)',[project,f.user])
    await pool.query("UPDATE assistants SET project_scope_mode='assigned' WHERE id=$1",[f.assistant])
    await expect(pairedInsert(f,{project})).rejects.toMatchObject({code:'42501'})
    await pool.query('INSERT INTO assistant_project_grants(assistant_id,project_id) VALUES($1,$2)',[f.assistant,project])
    expect(await pairedInsert(f,{...allowed,project})).toMatchObject({visibility:'owner',context_group_id:f.team.id,context_project_id:project})
    await pool.query("UPDATE workspace_access_policies SET access_mode='departments',default_department_id=NULL WHERE workspace_id=$1",[f.w])
    await pool.query('UPDATE assistants SET default_workspace_group_id=NULL WHERE id=$1',[f.assistant])
    await pool.query("UPDATE workspace_groups SET status='archived' WHERE id=$1",[f.team.id])
    await expect(pairedInsert(f,allowed)).rejects.toMatchObject({code:'42501'})
    await pool.query("UPDATE workspace_projects SET status='archived' WHERE id=$1",[project])
    await expect(pairedInsert(f,{project})).rejects.toMatchObject({code:'42501'})
  })
  it('SQL independently rejects member clearance escalation despite forged execution caps', async () => {
    const f = await fixture()
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.w,f.user])
    await expect(pairedInsert(f)).rejects.toMatchObject({code:'42501'})
    expect((await f.post()).status).toBe(404)
    await pool.query("UPDATE assistants SET clearance='public' WHERE id=$1",[f.assistant])
    expect(await pairedInsert(f)).toMatchObject({visibility:'owner',context_group_id:null})
  })
  it('terminal SQL checks current proof, expiry, envelope and one use; personal receipts cannot publish shared roots', async () => {
    const f = await fixture(), client = await getAppPool().connect()
    const params = {...f.body,userId:f.user,channelType:'web',appOrigin:'chat'}
    const principal = {actorUserId:f.user,authSessionId:f.auth.id,authVersion:f.auth.authVersion}
    const sql = `INSERT INTO sessions(assistant_id,user_id,workspace_id,channel_type,channel_id,app_id,app_origin,visibility,context_compartments)
      VALUES($1,$2,$3,'web',$4,'Use Brian','chat',$5,'{}') RETURNING id`
    const values = [f.assistant,f.user,f.w,f.body.channelId,'owner']
    try {
      await client.query('BEGIN'); await applyRLSGucs(client,f.user)
      await admitPersonalWebSession(client,params,principal)
      const receipt = JSON.parse((await client.query("SELECT current_setting('app.session_creation_admission') AS receipt")).rows[0].receipt)
      for (const patch of [{actorUserId:f.owner},{authVersion:-1},{authSessionId:randomUUID()},
        {workspaceId:randomUUID()},{assistantId:randomUUID()},{channelId:randomUUID()},
        {policyRevision:'0'},{contextGroupId:f.team.id},{compartments:[f.team.compartmentKey]}]) {
        await client.query('SAVEPOINT refusal')
        await client.query("SELECT set_config('app.session_creation_admission',$1,true)",[JSON.stringify({...receipt,...patch})])
        await expect(client.query(sql,values)).rejects.toMatchObject({code:'42501'})
        await client.query('ROLLBACK TO SAVEPOINT refusal')
      }
      await client.query('SAVEPOINT shared')
      await expect(client.query(sql,[...values.slice(0,4),'workspace'])).rejects.toMatchObject({code:'42501'})
      await client.query('ROLLBACK TO SAVEPOINT shared')
      // Expiry is checked at terminal INSERT, not only helper entry.
      await client.query('SAVEPOINT expired')
      await client.query("UPDATE auth_sessions SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE id=$1",[f.auth.id])
      await expect(client.query(sql,values)).rejects.toMatchObject({code:'42501'})
      await client.query('ROLLBACK TO SAVEPOINT expired')
      expect((await client.query(sql,values)).rows).toHaveLength(1)
      await client.query('SAVEPOINT consumed')
      await expect(client.query(sql,values)).rejects.toMatchObject({code:'42501'})
      await client.query('ROLLBACK TO SAVEPOINT consumed')
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('preserves historical null and bound resumes despite new selections/defaults/revisions', async () => {
    const f = await fixture()
    await pool.query("UPDATE workspace_access_policies SET setup_state='legacy' WHERE workspace_id=$1",[f.w])
    const old = await findOrCreateSession({assistantId:f.assistant,userId:f.user,channelType:'web',channelId:f.body.channelId,appOrigin:'chat',contextGroupId:null,contextProjectId:null})
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready' WHERE workspace_id=$1",[f.w])
    const resumed = await f.post({contextGroupId:f.team.id,expectedPolicyRevision:'0'})
    expect(resumed.status).toBe(201)
    expect(resumed.body.session).toMatchObject({id:old.id,contextGroupId:null,contextProjectId:null,contextCompartments:[]})
    const boundChannel = randomUUID(), bound = await f.post({channelId:boundChannel,contextGroupId:f.team.id})
    await pool.query("UPDATE workspace_access_policies SET access_mode='departments',default_department_id=NULL WHERE workspace_id=$1",[f.w])
    await pool.query('UPDATE assistants SET default_workspace_group_id=NULL WHERE id=$1',[f.assistant])
    await pool.query("UPDATE workspace_groups SET status='archived' WHERE id=$1",[f.team.id])
    expect((await f.post({channelId:boundChannel,contextGroupId:null})).body.session).toMatchObject({id:bound.body.session.id,contextGroupId:f.team.id})
  })
  it('rechecks revocation after waiting on workspace and refuses stale policy and membership', async () => {
    const f = await fixture(), writer = await pool.connect()
    try {
      await writer.query('BEGIN'); await writer.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[f.w])
      const pending = f.post().then(response => response)
      const assertion = expect(pending).resolves.toMatchObject({status:401,body:{error:'authenticated_session_required'}})
      let waiting = false
      for (let i=0;i<100&&!waiting;i++) {
        waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT id FROM workspaces WHERE id=$1 FOR UPDATE'")).rows.length>0
        if (!waiting) await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(waiting).toBe(true)
      await writer.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[f.auth.id]); await writer.query('COMMIT'); await assertion
      expect((await pool.query('SELECT id FROM sessions WHERE workspace_id=$1',[f.w])).rows).toEqual([])
    } finally { await writer.query('ROLLBACK'); writer.release() }
    const g=await fixture()
    expect((await g.post({expectedPolicyRevision:'0'})).status).toBe(409)
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[g.w,g.user])
    expect((await g.post()).status).toBe(404)
  })
})
