import {prepareDepartmentCommand} from '../command-review.js'
import {viewsRoutes} from '../../routes/views.js'
import {contextScopeRoutes} from '../../routes/context-scopes.js'
import express from 'express'
import request from 'supertest'
import { approvalsRoutes } from '../../routes/approvals.js'
import { workspaceAccessRoutes } from '../../routes/workspace-access.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { createWorkspaceStore } from '../../db/workspace-store.js'
import type { UnifiedApprovalRouteOptions } from '../../routes/approvals.js'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getPool, getAppPool } from '../../db/client.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { executeDepartmentAccessCommand as execute, getWorkspaceAccess } from '../service.js'
import type { WorkspaceAccessOverview } from '@use-brian/shared'
import { getDepartmentalReadinessSystem } from '../readiness.js'

// Policy scenarios exercise a certified future release. A separate case below
// restores the real deployment resolver and proves that this binary refuses it.
vi.mock('../readiness.js',()=>({getDepartmentalReadinessSystem:vi.fn(async()=>({
  ready:true,enforcementVersion:2,requiredEnforcementVersion:2,missingCapabilities:[],
}))}))

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), member = randomUUID(), manager = randomUUID(), stranger = randomUUID()
  for (const id of [owner, member, manager, stranger]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Approval fixture',$2)`, [workspaceId, owner])
  for (const id of [owner, member, manager, stranger]) await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,$3,'assigned')`, [workspaceId, id, id === owner ? 'owner' : 'member'])
  const groups = createDbWorkspaceGroupStore()
  const target = await groups.createTeam(owner, workspaceId, { name: 'Research', key: 'research' })
  await execute(workspaceId, owner, { type: 'department.configure', teamId: target.id, directoryVisibility: 'workspace', requestable: true })
  await execute(workspaceId, owner, { type: 'department.manager.set', teamId: target.id, userId: manager, capabilities: ['approve_read_requests', 'manage_members'] })
  const request = () => execute(workspaceId, member, { type: 'access.request.create', targetTeamId: target.id, beneficiaryKind: 'member', beneficiaryId: member, reason: 'Review project requirements', days: 30, ongoing: false })
  function decision(view: WorkspaceAccessOverview, decision: 'approved' | 'rejected' = 'approved') {
    const r = view.requests[0]
    return { type: 'access.request.decide' as const, requestId: r.id, expectedVersion: r.version, payloadHash: r.payloadHash, policyRevision: view.policyRevision, decision }
  }
  return { workspaceId, owner, member, manager, stranger, target, groups, request, decision }
}
function appFor(userId:string) {
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=userId;next()})
  app.use('/api/approvals',approvalsRoutes({approvalsStore:createPendingApprovalsStore(),workspaceStore:createWorkspaceStore(),bridgeDeps:{} as UnifiedApprovalRouteOptions['bridgeDeps'],emailReviewContext:async()=>null}))
  app.use('/api',workspaceAccessRoutes())
  app.use('/api',contextScopeRoutes({workspaceStore:createWorkspaceStore()}))
  return app
}
async function reviewedPost(workspaceId:string,userId:string,command:unknown){
  const app=appFor(userId),view=await getWorkspaceAccess(workspaceId,userId)
  const preview=await request(app).post(`/api/workspaces/${workspaceId}/access/command-review`).send({command,expectedPolicyRevision:view.policyRevision,idempotencyKey:randomUUID()})
  if(preview.status!==200)return preview
  return request(app).post(`/api/workspaces/${workspaceId}/access/commands`).send({type:'access.command.apply',reviewId:preview.body.id,payloadHash:preview.body.payloadHash})
}
/** Prepare the canonical intent before exercising the legacy response adapter. */
function reviewedLegacy(app:ReturnType<typeof appFor>,workspaceId:string,userId:string) {
  async function run(method:'post'|'patch'|'put'|'delete',path:string,body:Record<string,unknown>={}) {
    const parts=path.split('/'),groupIndex=parts.indexOf('groups'),teamId=parts[groupIndex+1]
    let command:Record<string,unknown>
    if(groupIndex>=0){
      const action=parts[groupIndex+2],subject=parts[groupIndex+3]
      command=!teamId?{type:'department.create',...body}:!action?{type:'department.update',teamId,...body}
        :action==='members'?{type:'department.member.set',teamId,userId:subject??body.userId,enabled:method!=='delete',...(method==='put'?{activateAssigned:body.activateAssigned??false}:{})}
        :action==='assistants'?{type:'department.assistant.set',teamId,assistantId:subject,enabled:method!=='delete'}
        :action==='read-grants'?{type:'department.read_bundle.set',teamId,...body}
        :{type:'department.archive',teamId}
    } else command={type:'assistant.audience.set',assistantId:parts[parts.indexOf('assistants')+1],...body}
    const view=await getWorkspaceAccess(workspaceId,userId)
    let review
    try{review=await prepareDepartmentCommand(workspaceId,userId,{command,expectedPolicyRevision:view.policyRevision,idempotencyKey:randomUUID()})}
    catch(error){const e=error as {status:number;code:string};return{status:e.status,body:{error:e.code}}}
    return request(app)[method](path).set({'X-Brian-Access-Review-Id':review.id,'X-Brian-Access-Review-Hash':review.payloadHash}).send(body)
  }
  return {post:(path:string)=>({send:(body:Record<string,unknown>)=>run('post',path,body)}),patch:(path:string)=>({send:(body:Record<string,unknown>)=>run('patch',path,body)}),put:(path:string)=>({send:(body:Record<string,unknown>)=>run('put',path,body)}),delete:(path:string)=>run('delete',path)}
}
describe('[COMP:api/workspace-access] canonical request and approval transactions', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })
  it('projects current read reach separately from ordinary membership and hides other member settings',async()=>{
    const f=await fixture()
    const granted=await f.request();await execute(f.workspaceId,f.manager,f.decision(granted))
    const admin=await getWorkspaceAccess(f.workspaceId,f.owner),self=await getWorkspaceAccess(f.workspaceId,f.member),manager=await getWorkspaceAccess(f.workspaceId,f.manager)
    expect(admin.people.find(row=>row.id===f.member)?.access).toMatchObject({teamScopeMode:'assigned',readTeamIds:[f.target.id],membershipTeamIds:[]})
    expect(self.people.find(row=>row.id===f.member)?.access?.readTeamIds).toContain(f.target.id)
    expect(admin.people.find(row=>row.id===f.owner)?.access).toMatchObject({effectiveClearance:'confidential',readTeamIds:null,membershipTeamIds:null})
    await execute(f.workspaceId,f.owner,{type:'department.member.set',teamId:f.target.id,userId:f.member,enabled:true})
    const managed=await getWorkspaceAccess(f.workspaceId,f.manager)
    expect(managed.people.find(row=>row.id===f.member)).toBeDefined()
    expect(managed.people.find(row=>row.id===f.member)?.access).toBeUndefined()
    expect(manager.people.find(row=>row.id===f.manager)?.access).toBeDefined()
  })
  it('updates member clearance at the reviewed policy revision and audits without changing role or memberships',async()=>{
    const f=await fixture(),before=await getWorkspaceAccess(f.workspaceId,f.owner)
    const response=await reviewedPost(f.workspaceId,f.owner,{type:'member.access.set',userId:f.member,clearance:'public',teamScopeMode:'assigned',expectedPolicyRevision:before.policyRevision})
    expect(response.status,JSON.stringify(response.body)).toBe(200)
    expect(response.body.people.find((row:{id:string})=>row.id===f.member)).toMatchObject({role:'member',access:{clearance:'public',effectiveClearance:'public',teamScopeMode:'assigned'}})
    expect(BigInt(response.body.policyRevision)).toBeGreaterThan(BigInt(before.policyRevision))
    const event=(await pool.query("SELECT changes FROM workspace_access_events WHERE workspace_id=$1 AND kind='member.access.set'",[f.workspaceId])).rows[0]
    expect(event.changes).toMatchObject({before:{role:'member',clearance:'internal',team_scope_mode:'assigned'},after:{role:'member',clearance:'public',team_scope_mode:'assigned'}})
    expect((await pool.query('SELECT 1 FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.target.id,f.member])).rows).toHaveLength(0)
    const {resolveReadClearanceSystem}=await import('../../db/workspace-store.js')
    expect(await resolveReadClearanceSystem(f.member,f.workspaceId,'confidential')).toBe('public')
  })
  it('refuses stale member permission reviews and never silently repeats their mutation',async()=>{
    const f=await fixture(),view=await getWorkspaceAccess(f.workspaceId,f.owner)
    const command={type:'member.access.set',userId:f.member,clearance:'public',teamScopeMode:'assigned',expectedPolicyRevision:view.policyRevision}
    await execute(f.workspaceId,f.owner,command)
    await expect(execute(f.workspaceId,f.owner,command)).rejects.toMatchObject({code:'access_policy_conflict'})
    expect((await pool.query("SELECT count(*)::int AS count FROM workspace_access_events WHERE workspace_id=$1 AND kind='member.access.set'",[f.workspaceId])).rows[0].count).toBe(1)
  })
  it('refuses manager, administrator-target, foreign-person and unsupported-tier permission writes',async()=>{
    const f=await fixture(),other=await fixture(),view=await getWorkspaceAccess(f.workspaceId,f.owner)
    const command={type:'member.access.set',userId:f.member,clearance:'confidential',teamScopeMode:'assigned',expectedPolicyRevision:view.policyRevision}
    await expect(execute(f.workspaceId,f.manager,command)).rejects.toMatchObject({code:'admin_required'})
    await expect(execute(f.workspaceId,f.owner,{...command,userId:f.owner})).rejects.toMatchObject({code:'member_role_required'})
    await expect(execute(f.workspaceId,f.owner,{...command,userId:other.member})).rejects.toMatchObject({code:'not_found'})
    await expect(execute(f.workspaceId,f.owner,{...command,clearance:'restricted'})).rejects.toMatchObject({code:'invalid_command'})
    await expect(execute(f.workspaceId,f.owner,{...command,teamScopeMode:'all'})).rejects.toMatchObject({code:'invalid_command'})
  })
  it('preserves limited legacy scope and atomically refuses assigned-mode changes without complete readiness',async()=>{
    const f=await fixture()
    await pool.query("UPDATE workspace_members SET team_scope_mode='legacy',compartments=$3 WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member,[f.target.compartmentKey]])
    const initial=await getWorkspaceAccess(f.workspaceId,f.owner)
    expect(initial.people.find(row=>row.id===f.member)?.access).toMatchObject({teamScopeMode:'legacy',readTeamIds:[f.target.id],membershipTeamIds:[f.target.id]})
    const resolver=vi.mocked(getDepartmentalReadinessSystem),ready=resolver.getMockImplementation()!
    resolver.mockResolvedValue({ready:false,enforcementVersion:1,requiredEnforcementVersion:2,missingCapabilities:['fixture']})
    try{
      await expect(execute(f.workspaceId,f.owner,{type:'member.access.set',userId:f.member,clearance:'public',teamScopeMode:'assigned',expectedPolicyRevision:initial.policyRevision})).rejects.toMatchObject({code:'departmental_enforcement_incomplete'})
      expect((await pool.query('SELECT clearance,team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.member])).rows[0]).toEqual({clearance:'internal',team_scope_mode:'legacy'})
      const changed=await execute(f.workspaceId,f.owner,{type:'member.access.set',userId:f.member,clearance:'public',teamScopeMode:'legacy',expectedPolicyRevision:initial.policyRevision})
      expect(changed.people.find(row=>row.id===f.member)?.access).toMatchObject({clearance:'public',teamScopeMode:'legacy'})
    }finally{resolver.mockImplementation(ready)}
    const reviewed=await getWorkspaceAccess(f.workspaceId,f.owner)
    const changed=await execute(f.workspaceId,f.owner,{type:'member.access.set',userId:f.member,clearance:'public',teamScopeMode:'assigned',expectedPolicyRevision:reviewed.policyRevision})
    expect(changed.people.find(row=>row.id===f.member)?.access).toMatchObject({teamScopeMode:'assigned',readTeamIds:[],membershipTeamIds:[]})
    await expect(execute(f.workspaceId,f.owner,{type:'member.access.set',userId:f.member,clearance:'public',teamScopeMode:'legacy',expectedPolicyRevision:changed.policyRevision})).rejects.toMatchObject({code:'legacy_mode_not_assignable'})
  })
  it('rolls back a member permission change and policy revision when its audit cannot persist',async()=>{
    const f=await fixture(),before=await getWorkspaceAccess(f.workspaceId,f.owner)
    await pool.query(`CREATE FUNCTION fixture_refuse_person_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${f.workspaceId}'::uuid AND NEW.kind='member.access.set' THEN RAISE EXCEPTION 'fixture_audit_failure'; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE TRIGGER fixture_refuse_person_audit BEFORE INSERT ON workspace_access_events FOR EACH ROW EXECUTE FUNCTION fixture_refuse_person_audit()')
    try{
      await expect(execute(f.workspaceId,f.owner,{type:'member.access.set',userId:f.member,clearance:'public',teamScopeMode:'assigned',expectedPolicyRevision:before.policyRevision})).rejects.toMatchObject({code:'access_conflict'})
      const after=await getWorkspaceAccess(f.workspaceId,f.owner)
      expect(after.policyRevision).toBe(before.policyRevision)
      expect(after.people.find(row=>row.id===f.member)?.access).toEqual(before.people.find(row=>row.id===f.member)?.access)
    }finally{await pool.query('DROP TRIGGER fixture_refuse_person_audit ON workspace_access_events');await pool.query('DROP FUNCTION fixture_refuse_person_audit()')}
  })
  it('creates and updates Teams through the legacy HTTP adapter and the same audited service',async()=>{
    const f=await fixture(),app=appFor(f.owner)
    const created=await reviewedLegacy(app,f.workspaceId,f.owner).post(`/api/workspaces/${f.workspaceId}/groups`).send({name:'Product',key:'product'})
    expect(created.status,JSON.stringify(created.body)).toBe(201)
    const id=created.body.group.id
    expect((await pool.query('SELECT directory_visibility FROM workspace_groups WHERE id=$1',[id])).rows[0].directory_visibility).toBe('members')
    const updated=await reviewedLegacy(app,f.workspaceId,f.owner).patch(`/api/workspaces/${f.workspaceId}/groups/${id}`).send({name:'Product design',color:'#112233'})
    expect(updated.status,JSON.stringify(updated.body)).toBe(200)
    expect(updated.body.group).toMatchObject({id,name:'Product design',color:'#112233'})
    const events=(await pool.query('SELECT kind,changes FROM workspace_access_events WHERE workspace_id=$1 AND subject_id=$2 ORDER BY created_at,id',[f.workspaceId,id])).rows
    expect(events.map(row=>row.kind)).toEqual(['department.create','department.update'])
    expect(events[0].changes.before).toBeNull()
    expect(events[1].changes).toMatchObject({before:{name:'Product'},after:{name:'Product design'}})
  })
  it('refuses a foreign Team before the old metadata route can mutate it',async()=>{
    const f=await fixture(),other=await fixture()
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')",[other.workspaceId,f.owner])
    const response=await reviewedLegacy(appFor(f.owner),f.workspaceId,f.owner).patch(`/api/workspaces/${f.workspaceId}/groups/${other.target.id}`).send({name:'Wrong workspace'})
    expect(response.status).toBe(404)
    expect((await pool.query('SELECT name FROM workspace_groups WHERE id=$1',[other.target.id])).rows[0].name).toBe('Research')
  })
  it('preserves legacy member mode by default and refuses incomplete explicit activation atomically',async()=>{
    const f=await fixture();await pool.query("UPDATE workspace_members SET team_scope_mode='legacy' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.stranger])
    const path=`/api/workspaces/${f.workspaceId}/groups/${f.target.id}/members/${f.stranger}`
    const response=await reviewedLegacy(appFor(f.owner),f.workspaceId,f.owner).put(path).send({})
    expect(response.status).toBe(204)
    expect((await pool.query('SELECT team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.stranger])).rows[0].team_scope_mode).toBe('legacy')
    await execute(f.workspaceId,f.owner,{type:'department.member.set',teamId:f.target.id,userId:f.stranger,enabled:false})
    const resolver=vi.mocked(getDepartmentalReadinessSystem),ready=resolver.getMockImplementation()!
    resolver.mockImplementation((await vi.importActual<typeof import('../readiness.js')>('../readiness.js')).getDepartmentalReadinessSystem)
    try{
      const denied=await reviewedLegacy(appFor(f.owner),f.workspaceId,f.owner).put(path).send({activateAssigned:true})
      expect(denied.status).toBe(409);expect(denied.body.error).toBe('departmental_enforcement_incomplete')
      expect((await pool.query('SELECT 1 FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.target.id,f.stranger])).rows).toHaveLength(0)
    }finally{resolver.mockImplementation(ready)}
    expect((await reviewedLegacy(appFor(f.owner),f.workspaceId,f.owner).put(path).send({activateAssigned:true})).status).toBe(204)
    expect((await pool.query('SELECT team_scope_mode FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.stranger])).rows[0].team_scope_mode).toBe('assigned')
  })
  it('uses delegated membership rules on the old route and rejects expanded packages',async()=>{
    const f=await fixture(),app=appFor(f.manager),path=`/api/workspaces/${f.workspaceId}/groups/${f.target.id}/members`
    expect((await reviewedLegacy(app,f.workspaceId,f.manager).put(`${path}/${f.stranger}`).send({})).status).toBe(204)
    expect((await reviewedLegacy(app,f.workspaceId,f.manager).put(`${path}/${f.manager}`).send({})).status).toBe(403)
    // Read bundles exist only in a workspace rolled back to the legacy read (D26).
    await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspaceId])
    await execute(f.workspaceId,f.owner,{type:'department.read_bundle.set',teamId:f.target.id,readAll:true,groupIds:[]})
    expect((await reviewedLegacy(app,f.workspaceId,f.manager).delete(`${path}/${f.stranger}`)).status).toBe(403)
    expect((await reviewedLegacy(appFor(f.owner),f.workspaceId,f.owner).delete(`${path}/${f.stranger}`)).status).toBe(204)
  })
  it('refuses read bundles in a v2 workspace, validates them after a legacy rollback, and archives through the same service',async()=>{
    const f=await fixture(),other=await fixture(),app=appFor(f.owner),base=`/api/workspaces/${f.workspaceId}/groups/${f.target.id}`
    const retired=await reviewedLegacy(app,f.workspaceId,f.owner).put(`${base}/read-grants`).send({readAll:true,groupIds:[]})
    expect(retired.status).toBe(410)
    expect(retired.body.error).toBe('department_read_bundle_retired')
    expect((await pool.query('SELECT read_all FROM workspace_groups WHERE id=$1',[f.target.id])).rows[0].read_all).toBe(false)
    await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspaceId])
    const denied=await reviewedLegacy(app,f.workspaceId,f.owner).put(`${base}/read-grants`).send({readAll:true,groupIds:[other.target.id]})
    expect(denied.status).toBe(404)
    expect((await pool.query('SELECT read_all FROM workspace_groups WHERE id=$1',[f.target.id])).rows[0].read_all).toBe(false)
    expect((await reviewedLegacy(app,f.workspaceId,f.owner).put(`${base}/read-grants`).send({readAll:true,groupIds:[]})).status).toBe(204)
    expect((await reviewedLegacy(app,f.workspaceId,f.owner).post(`${base}/archive`).send({})).status).toBe(204)
    expect((await pool.query('SELECT status FROM workspace_groups WHERE id=$1',[f.target.id])).rows[0].status).toBe('archived')
  })
  it('keeps assistant additions behind current readiness and allows recovery removal',async()=>{
    const f=await fixture(),assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name) VALUES($1,$2,$3,'Fixture assistant')",[assistantId,f.workspaceId,f.owner])
    const path=`/api/workspaces/${f.workspaceId}/groups/${f.target.id}/assistants/${assistantId}`
    expect((await reviewedLegacy(appFor(f.owner),f.workspaceId,f.owner).put(path).send({})).status).toBe(204)
    const resolver=vi.mocked(getDepartmentalReadinessSystem),ready=resolver.getMockImplementation()!
    resolver.mockImplementation((await vi.importActual<typeof import('../readiness.js')>('../readiness.js')).getDepartmentalReadinessSystem)
    try{
      expect((await reviewedLegacy(appFor(f.owner),f.workspaceId,f.owner).delete(path)).status).toBe(204)
      expect((await reviewedLegacy(appFor(f.owner),f.workspaceId,f.owner).put(path).send({})).status).toBe(409)
      expect((await pool.query('SELECT 1 FROM workspace_group_assistants WHERE group_id=$1 AND assistant_id=$2',[f.target.id,assistantId])).rows).toHaveLength(0)
    }finally{resolver.mockImplementation(ready)}
  })
  it('routes full assistant audiences through the same current workspace and readiness checks',async()=>{
    const f=await fixture(),other=await fixture(),assistantId=randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name) VALUES($1,$2,$3,'Fixture assistant')",[assistantId,f.workspaceId,f.owner])
    const path=`/api/workspaces/${f.workspaceId}/assistants/${assistantId}/context`
    const config={teamMode:'assigned',teamIds:[f.target.id],defaultGroupId:f.target.id,projectMode:'all',projectIds:[],defaultProjectId:null}
    const app=appFor(f.owner)
    expect((await reviewedLegacy(app,f.workspaceId,f.owner).put(path).send({...config,teamIds:[other.target.id],defaultGroupId:other.target.id})).status).toBe(404)
    expect((await reviewedLegacy(app,f.workspaceId,f.owner).put(path).send(config)).status).toBe(204)
    expect((await pool.query('SELECT team_scope_mode,default_workspace_group_id FROM assistants WHERE id=$1',[assistantId])).rows[0]).toEqual({team_scope_mode:'assigned',default_workspace_group_id:f.target.id})
    const event=(await pool.query("SELECT changes FROM workspace_access_events WHERE workspace_id=$1 AND subject_id=$2 AND kind='assistant.audience.set'",[f.workspaceId,assistantId])).rows[0]
    expect(event.changes.after).toMatchObject({team_ids:[f.target.id],team_scope_mode:'assigned'})
    const resolver=vi.mocked(getDepartmentalReadinessSystem),ready=resolver.getMockImplementation()!
    resolver.mockImplementation((await vi.importActual<typeof import('../readiness.js')>('../readiness.js')).getDepartmentalReadinessSystem)
    try{expect((await reviewedLegacy(app,f.workspaceId,f.owner).put(path).send({...config,teamIds:[],defaultGroupId:null})).status).toBe(409)}finally{resolver.mockImplementation(ready)}
    expect((await pool.query('SELECT group_id FROM workspace_group_assistants WHERE assistant_id=$1',[assistantId])).rows.map(row=>row.group_id)).toEqual([f.target.id])
  })
  it('does not leave a Team membership bypass in page-sharing group routes',async()=>{
    const f=await fixture(),other=await fixture(),pageId=randomUUID(),app=express()
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')",[other.workspaceId,f.owner])
    app.use(express.json());app.use((req,_res,next)=>{req.userId=f.owner;next()})
    // The page reader supplies a known accessible page; all group and command
    // authority below is real PostgreSQL, including the cross-workspace actor.
    app.use('/api',viewsRoutes({savedViewStore:{getById:async()=>({id:pageId,workspaceId:f.workspaceId})},workspaceStore:createWorkspaceStore(),workspaceGroupStore:f.groups} as never))
    const path=`/api/views/${pageId}/groups/${f.target.id}/members`
    expect((await reviewedLegacy(app,f.workspaceId,f.owner).post(path).send({userId:f.stranger})).status).toBe(201)
    expect((await pool.query("SELECT count(*)::int AS n FROM workspace_access_events WHERE workspace_id=$1 AND kind='department.member.set'",[f.workspaceId])).rows[0].n).toBe(1)
    expect((await reviewedLegacy(app,f.workspaceId,f.owner).delete(`${path}/${f.stranger}`)).status).toBe(200)
    const foreign=`/api/views/${pageId}/groups/${other.target.id}/members`
    expect((await request(app).get(foreign)).status).toBe(404)
    expect((await request(app).post(foreign).send({userId:other.member})).status).toBe(404)
    expect((await request(app).delete(`${foreign}/${other.owner}`)).status).toBe(404)
    const sharing=await f.groups.createGroup(f.owner,f.workspaceId,'Sharing fixture')
    const ordinary=`/api/views/${pageId}/groups/${sharing.id}/members`
    expect((await request(app).post(ordinary).send({userId:f.stranger})).status).toBe(201)
    expect((await request(app).delete(`${ordinary}/${f.stranger}`)).status).toBe(200)
  })
  it('rolls back Team creation and its compartment when audit persistence fails',async()=>{
    const f=await fixture()
    await pool.query(`CREATE FUNCTION fixture_refuse_team_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id='${f.workspaceId}'::uuid AND NEW.kind='department.create' THEN RAISE EXCEPTION 'fixture_audit_failure'; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE TRIGGER fixture_refuse_team_audit BEFORE INSERT ON workspace_access_events FOR EACH ROW EXECUTE FUNCTION fixture_refuse_team_audit()')
    try{
      await expect(execute(f.workspaceId,f.owner,{type:'department.create',name:'Rollback fixture',key:'rollback-fixture'})).rejects.toMatchObject({code:'access_conflict'})
      expect((await pool.query("SELECT 1 FROM workspace_groups WHERE workspace_id=$1 AND key='rollback-fixture'",[f.workspaceId])).rows).toEqual([])
      expect((await pool.query("SELECT 1 FROM workspace_compartments WHERE workspace_id=$1 AND label='Rollback fixture'",[f.workspaceId])).rows).toEqual([])
    }finally{await pool.query('DROP TRIGGER fixture_refuse_team_audit ON workspace_access_events');await pool.query('DROP FUNCTION fixture_refuse_team_audit()')}
  })
  it('blocks new delegated authority with real release evidence and retains recovery commands',async()=>{
    const f=await fixture();await f.request()
    const pending=await getWorkspaceAccess(f.workspaceId,f.manager)
    const resolver=vi.mocked(getDepartmentalReadinessSystem)
    const ready=resolver.getMockImplementation()!
    const actual=await vi.importActual<typeof import('../readiness.js')>('../readiness.js')
    resolver.mockImplementation(actual.getDepartmentalReadinessSystem)
    try{
      const view=await getWorkspaceAccess(f.workspaceId,f.owner)
      expect(view.readiness).toMatchObject({ready:false,requiredEnforcementVersion:2})
      await expect(f.request()).rejects.toMatchObject({code:'departmental_enforcement_incomplete',status:409})
      await expect(execute(f.workspaceId,f.owner,{type:'department.manager.set',teamId:f.target.id,userId:f.stranger,capabilities:['manage_members']})).rejects.toMatchObject({code:'departmental_enforcement_incomplete'})
      await expect(execute(f.workspaceId,f.manager,{type:'department.member.set',teamId:f.target.id,userId:f.stranger,enabled:true})).rejects.toMatchObject({code:'departmental_enforcement_incomplete'})
      await expect(execute(f.workspaceId,f.manager,f.decision(pending))).rejects.toMatchObject({code:'departmental_enforcement_incomplete'})
      const unchanged=await getWorkspaceAccess(f.workspaceId,f.owner)
      expect(unchanged.requests[0].status).toBe('pending');expect(unchanged.grants).toHaveLength(0)
      expect(unchanged.teams[0].managerIds).not.toContain(f.stranger)
      // Direct HTTP and the common queue enter the same service gate.
      const response=await reviewedPost(f.workspaceId,f.manager,f.decision(pending))
      expect(response.status).toBe(409);expect(response.body.error).toBe('departmental_enforcement_incomplete')
      const queueResponse=await request(appFor(f.manager)).post(`/api/approvals/${pending.requests[0].approvalId}/respond`).send({decision:'approved'})
      expect(queueResponse.status).toBe(409);expect(queueResponse.body.error).toBe('departmental_enforcement_incomplete')
      await execute(f.workspaceId,f.manager,f.decision(pending,'rejected'))
      await execute(f.workspaceId,f.owner,{type:'department.manager.set',teamId:f.target.id,userId:f.manager,capabilities:[]})
      expect((await getWorkspaceAccess(f.workspaceId,f.owner)).teams[0].managerIds).toEqual([])
      await expect(execute(f.workspaceId,f.owner,{type:'department.manager.set',teamId:f.target.id,userId:f.stranger,capabilities:['manage_members'],ready:true})).rejects.toMatchObject({code:'invalid_command'})
    }finally{resolver.mockImplementation(ready)}
  })
  it('creates one review card and atomically settles request, grant, card and audit', async () => {
    const f = await fixture(), requested = await f.request(), request = requested.requests[0]
    expect(request.approvalId).toBeTruthy()
    const card = (await pool.query('SELECT approver_user_id,status FROM pending_approvals WHERE id=$1', [request.approvalId])).rows[0]
    expect(card).toEqual({ approver_user_id: f.manager, status: 'pending' })
    const reviewed = await getWorkspaceAccess(f.workspaceId, f.manager)
    expect(reviewed.requests[0].canDecide).toBe(true)
    const result = await execute(f.workspaceId, f.manager, f.decision(reviewed))
    expect(result.requests[0].status).toBe('approved')
    expect(result.grants).toHaveLength(1)
    expect((await pool.query('SELECT status FROM pending_approvals WHERE id=$1', [request.approvalId])).rows[0].status).toBe('approved')
    expect((await pool.query(`SELECT count(*)::int AS n FROM workspace_access_events WHERE workspace_id=$1 AND kind='access.request.decide'`, [f.workspaceId])).rows[0].n).toBe(1)
    const audit=(await pool.query("SELECT changes FROM workspace_access_events WHERE workspace_id=$1 AND kind='access.request.decide'",[f.workspaceId])).rows[0].changes
    expect(audit).toMatchObject({before:{status:'pending'},after:{status:'approved',decided_by:f.manager}})
    const retry = await execute(f.workspaceId, f.manager, f.decision(reviewed))
    expect(retry.grants).toHaveLength(1)
  })
  it('allows grant revocation and idempotent decisions when the release is no longer ready',async()=>{
    const f=await fixture();await f.request()
    const reviewed=await getWorkspaceAccess(f.workspaceId,f.manager)
    const granted=await execute(f.workspaceId,f.manager,f.decision(reviewed))
    const resolver=vi.mocked(getDepartmentalReadinessSystem),ready=resolver.getMockImplementation()!
    const actual=await vi.importActual<typeof import('../readiness.js')>('../readiness.js')
    resolver.mockImplementation(actual.getDepartmentalReadinessSystem)
    try{
      expect((await execute(f.workspaceId,f.manager,f.decision(reviewed))).grants).toHaveLength(1)
      const result=await execute(f.workspaceId,f.member,{type:'access.grant.revoke',grantId:granted.grants[0].id,reason:'No longer required'})
      expect(result.readiness.ready).toBe(false);expect(result.grants[0].status).toBe('revoked')
      await execute(f.workspaceId,f.owner,{type:'department.member.set',teamId:f.target.id,userId:f.stranger,enabled:true})
      expect((await getWorkspaceAccess(f.workspaceId,f.owner)).teams[0].memberIds).toContain(f.stranger)
    }finally{resolver.mockImplementation(ready)}
  })
  it('keeps access audit events append-only while preserving workspace and actor deletion semantics',async()=>{
    const f=await fixture();
    const event=(await pool.query(`INSERT INTO workspace_access_events(workspace_id,actor_user_id,kind,policy_revision,changes) VALUES($1,$2,'fixture.event',1,'{"before":null,"after":{"enabled":true}}') RETURNING id`,[f.workspaceId,f.stranger])).rows[0];
    await expect(pool.query("UPDATE workspace_access_events SET changes='{}' WHERE id=$1",[event.id])).rejects.toThrow('access_audit_append_only');
    await expect(pool.query('UPDATE workspace_access_events SET actor_user_id=NULL WHERE id=$1',[event.id])).rejects.toThrow('access_audit_append_only');
    await expect(pool.query('DELETE FROM workspace_access_events WHERE id=$1',[event.id])).rejects.toThrow('access_audit_append_only');
    await expect(pool.query('TRUNCATE workspace_access_events')).rejects.toThrow('access_audit_append_only');
    await pool.query('DELETE FROM users WHERE id=$1',[f.stranger]);
    expect((await pool.query('SELECT actor_user_id,changes FROM workspace_access_events WHERE id=$1',[event.id])).rows[0]).toEqual({actor_user_id:null,changes:{before:null,after:{enabled:true}}});
    await pool.query('DELETE FROM workspaces WHERE id=$1',[f.workspaceId]);
    expect((await pool.query('SELECT id FROM workspace_access_events WHERE id=$1',[event.id])).rows).toEqual([]);
  });
  it('refuses a stale policy review, and succeeds only after a fresh review', async () => {
    const f = await fixture(); await f.request()
    const before = await getWorkspaceAccess(f.workspaceId, f.manager)
    await f.groups.addMember(f.owner, f.target.id, f.stranger)
    await expect(execute(f.workspaceId, f.manager, f.decision(before))).rejects.toMatchObject({ code: 'request_review_stale' })
    expect((await getWorkspaceAccess(f.workspaceId, f.owner)).grants).toHaveLength(0)
    await execute(f.workspaceId, f.manager, f.decision(await getWorkspaceAccess(f.workspaceId, f.manager)))
  })
  it('rejects changed payloads and self-approval without settling the review', async () => {
    const f = await fixture(); const requested = await f.request()
    await expect(execute(f.workspaceId, f.member, f.decision(requested))).rejects.toMatchObject({ code: 'independent_approver_required' })
    const reviewed = await getWorkspaceAccess(f.workspaceId, f.manager)
    await expect(execute(f.workspaceId, f.manager, { ...f.decision(reviewed), payloadHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'request_changed' })
    expect((await getWorkspaceAccess(f.workspaceId, f.owner)).requests[0].status).toBe('pending')
  })
  it('keeps approval metadata from unrelated members, including raw RLS reads', async () => {
    const f = await fixture(); const requested = await f.request()
    expect((await getWorkspaceAccess(f.workspaceId, f.stranger)).requests).toEqual([])
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_user_id',$1,true)`, [f.stranger])
      expect((await client.query('SELECT id FROM pending_approvals WHERE id=$1', [requested.requests[0].approvalId])).rows).toEqual([])
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('rechecks delegated authority and prevents membership escalation through expanded packages', async () => {
    const f = await fixture(); await f.request()
    const before = await getWorkspaceAccess(f.workspaceId, f.manager)
    await execute(f.workspaceId, f.owner, { type: 'department.manager.set', teamId: f.target.id, userId: f.manager, capabilities: [] })
    await expect(execute(f.workspaceId, f.manager, f.decision(before))).rejects.toMatchObject({ code: 'not_found' })
    await execute(f.workspaceId, f.owner, { type: 'department.manager.set', teamId: f.target.id, userId: f.manager, capabilities: ['manage_members'] })
    await f.groups.setTeamReadBundle(f.owner, f.target.id, { readAll: true, compartmentKeys: [] })
    await expect(execute(f.workspaceId, f.manager, { type: 'department.member.set', teamId: f.target.id, userId: f.stranger, enabled: true })).rejects.toMatchObject({ code: 'expanded_team_requires_admin' })
  })
  it('recovers a pending card after its delegated reviewer loses authority',async()=>{
    const f=await fixture(),created=await f.request(),approvalId=created.requests[0].approvalId;
    await execute(f.workspaceId,f.owner,{type:'department.manager.set',teamId:f.target.id,userId:f.manager,capabilities:[]});
    const card=(await pool.query('SELECT approver_user_id,approval_payload,status FROM pending_approvals WHERE id=$1',[approvalId])).rows[0];
    expect(card.approver_user_id).toBe(f.owner);expect(card.status).toBe('pending');
    expect(card.approval_payload.policyRevision).toBe((await getWorkspaceAccess(f.workspaceId,f.owner)).policyRevision);
    const former=await request(appFor(f.manager)).post(`/api/approvals/${approvalId}/respond`).send({decision:'approved'});
    // RLS hides the reassigned card before the assigned-reviewer check.
    expect(former.status).toBe(404);
    await request(appFor(f.owner)).post(`/api/approvals/${approvalId}/respond`).send({decision:'approved'}).expect(200);
    expect((await getWorkspaceAccess(f.workspaceId,f.member)).grants).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int n FROM workspace_access_events WHERE workspace_id=$1 AND kind='access.reviewer.refresh'",[f.workspaceId])).rows[0].n).toBe(1);
  });
  it('leaves a request unassigned when no independent reviewer remains, then recovers it explicitly',async()=>{
    const f=await fixture();
    const created=await execute(f.workspaceId,f.owner,{type:'access.request.create',targetTeamId:f.target.id,beneficiaryKind:'member',beneficiaryId:f.owner,reason:'Independent review',days:7,ongoing:false});
    const requestId=created.requests[0].id,oldCard=created.requests[0].approvalId;
    await execute(f.workspaceId,f.owner,{type:'department.manager.set',teamId:f.target.id,userId:f.manager,capabilities:[]});
    expect((await getWorkspaceAccess(f.workspaceId,f.owner)).requests[0].approvalId).toBeNull();
    expect((await pool.query('SELECT status FROM pending_approvals WHERE id=$1',[oldCard])).rows[0].status).toBe('superseded');
    await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.stranger]);
    const refreshed=await execute(f.workspaceId,f.owner,{type:'access.request.assign',requestId});
    expect(refreshed.requests[0].approvalId).not.toBe(oldCard);
    expect((await pool.query('SELECT approver_user_id FROM pending_approvals WHERE id=$1',[refreshed.requests[0].approvalId])).rows[0].approver_user_id).toBe(f.stranger);
  });
  it('uses the same transaction through HTTP and the shared approval queue, without a generic settlement bypass',async()=>{
    const f=await fixture(),memberApp=appFor(f.member),managerApp=appFor(f.manager)
    const created=await reviewedPost(f.workspaceId,f.member,{type:'access.request.create',targetTeamId:f.target.id,beneficiaryKind:'member',beneficiaryId:f.member,reason:'Review requirements',days:7,ongoing:false})
    expect(created.status,JSON.stringify(created.body)).toBe(200)
    const id=created.body.requests[0].approvalId
    const queue=await request(managerApp).get(`/api/approvals?workspaceId=${f.workspaceId}`).expect(200)
    expect(queue.body.approvals.map((r:{id:string})=>r.id)).toContain(id)
    const unrelated=await request(appFor(f.stranger)).get(`/api/approvals?workspaceId=${f.workspaceId}`).expect(200)
    expect(unrelated.body.approvals).toEqual([])
    expect(await createPendingApprovalsStore().respond(id,'approved',f.manager)).toBeNull()
    const response=await request(managerApp).post(`/api/approvals/${id}/respond`).send({decision:'approved'}).expect(200)
    expect(response.body).toMatchObject({kind:'department_access',status:'approved'})
    expect((await getWorkspaceAccess(f.workspaceId,f.member)).grants).toHaveLength(1)
    await request(managerApp).post(`/api/approvals/${id}/respond`).send({decision:'approved'}).expect(200)
    expect((await getWorkspaceAccess(f.workspaceId,f.member)).grants).toHaveLength(1)
  })
  it('authorizes an exact older request independently of the overview history limit',async()=>{
    const f=await fixture(),created=await f.request(),old=created.requests[0];
    await pool.query(`INSERT INTO workspace_access_requests(workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision)
      SELECT $1,$2,'member',$2,$3,'History fixture',now(),now()+interval '7 days',repeat('a',64),1 FROM generate_series(1,501)`,[f.workspaceId,f.member,f.target.id]);
    expect((await getWorkspaceAccess(f.workspaceId,f.member)).requests.some(r=>r.id===old.id)).toBe(false);
    await execute(f.workspaceId,f.member,{type:'access.request.cancel',requestId:old.id,expectedVersion:old.version});
    expect((await pool.query('SELECT status FROM workspace_access_requests WHERE id=$1',[old.id])).rows[0].status).toBe('cancelled');
  });
  it('supports beneficiary revocation and cancels requests without granting access', async () => {
    const f = await fixture(); await f.request()
    const reviewed = await getWorkspaceAccess(f.workspaceId, f.manager)
    const granted = await execute(f.workspaceId, f.manager, f.decision(reviewed))
    await execute(f.workspaceId, f.member, { type: 'access.grant.revoke', grantId: granted.grants[0].id, reason: 'Review complete' })
    expect((await pool.query('SELECT effective_member_read_compartments($1,$2) AS reach', [f.member, f.workspaceId])).rows[0].reach).toEqual([])
    const again = await f.request(), pending = again.requests.find(r => r.status === 'pending')!
    await execute(f.workspaceId, f.member, { type: 'access.request.cancel', requestId: pending.id, expectedVersion: pending.version })
    expect((await pool.query('SELECT status FROM pending_approvals WHERE id=$1', [pending.approvalId])).rows[0].status).toBe('superseded')
  })
})
