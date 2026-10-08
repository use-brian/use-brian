import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { OrganizationCommand } from '@use-brian/shared'
import { getPool, getAppPool } from '../../db/client.js'
import { executeOrganizationCommand, getOrganizationChart } from '../../db/org-chart-store.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
async function fixture() {
  const workspaceId=randomUUID(), owner=randomUUID(), member=randomUUID(), colleague=randomUUID(), assistant=randomUUID()
  for (const [id,name] of [[owner,'Owner'],[member,'Member'],[colleague,'Colleague']]) await pool.query('INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,$2)',[id,name])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Organization fixture',$2)`,[workspaceId,owner])
  for (const id of [owner,member,colleague]) await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,$3,'assigned')`,[workspaceId,id,id===owner?'owner':'member'])
  await pool.query(`INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind) VALUES($1,'Research assistant',$2,$3,'standard')`,[assistant,owner,workspaceId])
  const run=(command:OrganizationCommand,actor=owner)=>executeOrganizationCommand(workspaceId,actor,command)
  const unit=async(name:string,parentId:string|null=null,visibility:'members'|'workspace'='members',teamId:string|null=null)=>{
    const result=await run({type:'org.unit.save',name,parentId,teamId,directoryVisibility:visibility,position:0})
    return result.units.find(u=>u.name===name)!
  }
  const place=async(unitId:string,userId:string|null,assistantId:string|null=null,extra:Partial<Extract<OrganizationCommand,{type:'org.placement.save'}>>={})=>{
    const result=await run({type:'org.placement.save',unitId,userId,assistantId,isPrimary:true,reportsToUserId:null,accountableUserId:null,...extra})
    return result.placements.find(p=>p.unitId===unitId&&p.userId===userId&&p.assistantId===assistantId)!
  }
  return{workspaceId,owner,member,colleague,assistant,run,unit,place}
}

describe('[COMP:api/organization-chart] real directory and hierarchy transactions',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('initializes only the explicitly selected primary assignment, reuses its unit and never changes permission rows',async()=>{
    const f=await fixture(),groups=createDbWorkspaceGroupStore()
    const teams=await Promise.all(['Research','Operations'].map(name=>groups.createTeam(f.owner,f.workspaceId,{name,key:name.toLowerCase()})))
    for(const team of teams)await groups.addMember(f.owner,team.id,f.member)
    await groups.setTeamAssistant(f.owner,teams[1].id,f.assistant,true)
    const snapshot=async()=>({
      members:(await pool.query('SELECT * FROM workspace_members WHERE workspace_id=$1 ORDER BY user_id',[f.workspaceId])).rows,
      people:(await pool.query('SELECT * FROM workspace_group_members WHERE group_id=ANY($1::uuid[]) ORDER BY group_id,user_id',[teams.map(t=>t.id)])).rows,
      assistants:(await pool.query('SELECT * FROM workspace_group_assistants WHERE group_id=ANY($1::uuid[]) ORDER BY group_id,assistant_id',[teams.map(t=>t.id)])).rows,
    })
    const before=await snapshot(),chart=await getOrganizationChart(f.workspaceId,f.owner)
    expect(chart.initialization?.candidates.find(c=>c.subjectId===f.member)?.teamIds).toEqual(teams.map(t=>t.id).sort())
    expect((await getOrganizationChart(f.workspaceId,f.member)).initialization).toBeUndefined()
    const command:OrganizationCommand={type:'org.initialize.subject',subjectId:f.member,kind:'member',teamId:teams[1].id,
      expectedRevision:chart.revision,expectedPolicyRevision:chart.initialization!.policyRevision}
    const result=await f.run(command)
    expect(result.units).toHaveLength(1)
    expect(result.units[0]).toMatchObject({teamId:teams[1].id,name:'Operations',parentId:null,directoryVisibility:'members'})
    expect(result.placements).toHaveLength(1)
    expect(result.placements[0]).toMatchObject({userId:f.member,isPrimary:true,reportsToUserId:null,accountableUserId:null})
    expect(result.initialization?.candidates.some(c=>c.subjectId===f.member)).toBe(false)
    await expect(f.run(command)).rejects.toThrow('organization_conflict')
    const assistant=await f.run({type:'org.initialize.subject',subjectId:f.assistant,kind:'assistant',teamId:teams[1].id,
      expectedRevision:result.revision,expectedPolicyRevision:result.initialization!.policyRevision})
    expect(assistant.units).toHaveLength(1);expect(assistant.placements).toHaveLength(2)
    expect(assistant.placements.find(p=>p.assistantId===f.assistant)).toMatchObject({isPrimary:true,accountableUserId:null})
    expect(await snapshot()).toEqual(before)
    expect((await pool.query("SELECT kind FROM workspace_access_events WHERE workspace_id=$1 AND kind='org.initialize.subject'",[f.workspaceId])).rows).toHaveLength(2)
  })
  it('rejects stale assignment snapshots, non-admins, foreign Teams and subjects without creating any unit',async()=>{
    const f=await fixture(),groups=createDbWorkspaceGroupStore()
    const team=await groups.createTeam(f.owner,f.workspaceId,{name:'Research',key:'research'})
    await groups.addMember(f.owner,team.id,f.member)
    const chart=await getOrganizationChart(f.workspaceId,f.owner)
    const command:Extract<OrganizationCommand,{type:'org.initialize.subject'}>={type:'org.initialize.subject',subjectId:f.member,kind:'member',teamId:team.id,
      expectedRevision:chart.revision,expectedPolicyRevision:chart.initialization!.policyRevision}
    await expect(f.run(command,f.member)).rejects.toThrow('admin_required')
    await expect(f.run({...command,teamId:randomUUID()})).rejects.toThrow('organization_conflict')
    await expect(f.run({...command,subjectId:f.colleague})).rejects.toThrow('organization_conflict')
    await groups.removeMember(f.owner,team.id,f.member)
    await expect(f.run(command)).rejects.toThrow('organization_conflict')
    const current=await getOrganizationChart(f.workspaceId,f.owner)
    expect(current.units).toEqual([]);expect(current.placements).toEqual([])
  })
  it('promotes a reviewed secondary placement atomically and only one concurrent initialization wins',async()=>{
    const f=await fixture(),groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(f.owner,f.workspaceId,{name:'Research',key:'research'})
    await groups.addMember(f.owner,team.id,f.member)
    const unit=await f.unit('Existing division',null,'members',team.id)
    const secondary=await f.place(unit.id,f.member,null,{isPrimary:false})
    const chart=await getOrganizationChart(f.workspaceId,f.owner)
    const command:OrganizationCommand={type:'org.initialize.subject',subjectId:f.member,kind:'member',teamId:team.id,
      expectedRevision:chart.revision,expectedPolicyRevision:chart.initialization!.policyRevision}
    const results=await Promise.allSettled([f.run(command),f.run(command)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    const current=await getOrganizationChart(f.workspaceId,f.owner)
    expect(current.units).toHaveLength(1);expect(current.placements).toHaveLength(1)
    expect(current.placements[0]).toMatchObject({id:secondary.id,isPrimary:true})
  })
  it('shows the full admin unassigned roster but only the member themself before publication',async()=>{
    const f=await fixture()
    expect((await getOrganizationChart(f.workspaceId,f.owner)).subjects).toHaveLength(4)
    const member=await getOrganizationChart(f.workspaceId,f.member)
    expect(member.subjects.map(s=>s.id)).toEqual([f.member])
    expect(member.canManage).toBe(false)
    await expect(f.unit('Root')).resolves.toBeDefined()
    await expect(f.run({type:'org.unit.save',name:'Unauthorized',parentId:null,teamId:null,directoryVisibility:'workspace',position:0},f.member)).rejects.toThrow('admin_required')
  })
  it('A14 projects visible descendants to the root without hidden ancestors, siblings or edge endpoints',async()=>{
    const f=await fixture(),hidden=await f.unit('Private division'),visible=await f.unit('Published department',hidden.id,'workspace')
    await f.place(hidden.id,f.colleague)
    await f.place(visible.id,f.member,null,{reportsToUserId:f.colleague})
    const chart=await getOrganizationChart(f.workspaceId,f.member)
    expect(chart.units.map(u=>[u.name,u.parentId])).toEqual([['Published department',null]])
    expect(chart.placements[0].reportsToUserId).toBeNull()
    expect(JSON.stringify(chart)).not.toContain(f.colleague)
    expect(JSON.stringify(chart)).not.toContain(hidden.id)
  })
  it('unlinked restricted units expose only self and accountable assistants, never siblings',async()=>{
    const f=await fixture(),unit=await f.unit('Restricted')
    await f.place(unit.id,f.member)
    await f.place(unit.id,f.colleague)
    await f.place(unit.id,null,f.assistant,{accountableUserId:f.member})
    const chart=await getOrganizationChart(f.workspaceId,f.member)
    expect(chart.units).toHaveLength(1)
    expect(chart.placements).toHaveLength(2)
    expect(chart.subjects.map(s=>s.id).sort()).toEqual([f.member,f.assistant].sort())
  })
  it('restricted linked units follow current authorized Team readers and managers, not organizational placement',async()=>{
    const f=await fixture(),groups=createDbWorkspaceGroupStore()
    const team=await groups.createTeam(f.owner,f.workspaceId,{name:'Research audience',key:'research'})
    const unit=await f.unit('Restricted department',null,'members',team.id)
    await f.place(unit.id,f.member)
    await f.place(unit.id,f.colleague)
    expect((await getOrganizationChart(f.workspaceId,f.member)).units).toEqual([])
    expect(await groups.listGroups(f.member,f.workspaceId)).toEqual([])
    await groups.addMember(f.owner,team.id,f.member)
    expect((await getOrganizationChart(f.workspaceId,f.member)).units.map(u=>u.id)).toEqual([unit.id])
    expect((await groups.listGroups(f.member,f.workspaceId)).map(g=>g.id)).toEqual([team.id])
    await groups.removeMember(f.owner,team.id,f.member)
    expect((await getOrganizationChart(f.workspaceId,f.member)).units).toEqual([])
    await pool.query(`INSERT INTO workspace_team_managers(workspace_id,team_id,user_id,capabilities,granted_by) VALUES($1,$2,$3,ARRAY['manage_members'],$4)`,[f.workspaceId,team.id,f.member,f.owner])
    expect((await getOrganizationChart(f.workspaceId,f.member)).placements).toHaveLength(2)
    expect((await pool.query('SELECT effective_member_team_compartments($1,$2) AS reach',[f.member,f.workspaceId])).rows[0].reach).toEqual([])
    await pool.query('UPDATE workspace_team_managers SET revoked_at=now() WHERE workspace_id=$1',[f.workspaceId])
    expect((await getOrganizationChart(f.workspaceId,f.member)).units).toEqual([])
  })
  it('requires a current department edge for a restricted linked unit in a v2 workspace, even for a legacy-unrestricted member',async()=>{
    const f=await fixture(),groups=createDbWorkspaceGroupStore()
    const team=await groups.createTeam(f.owner,f.workspaceId,{name:'Fictional Alder audience',key:'alder'})
    const unit=await f.unit('Fictional Alder division',null,'members',team.id)
    await f.place(unit.id,f.colleague)
    // Legacy reach is unrestricted for this member, so only the department floor can hide the unit.
    await pool.query("UPDATE workspace_members SET team_scope_mode='legacy' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
    expect((await pool.query('SELECT effective_member_read_compartments($1,$2) IS NULL AS open',[f.member,f.workspaceId])).rows[0].open).toBe(true)
    const visible=async()=>(await getOrganizationChart(f.workspaceId,f.member)).units.map(u=>u.id)
    expect(await visible()).toEqual([])
    expect((await getOrganizationChart(f.workspaceId,f.member)).placements).toEqual([])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')",[f.workspaceId,team.id,f.member])
    expect(await visible()).toEqual([unit.id])
    await pool.query("UPDATE department_edges SET expires_at=now()-interval '1 second' WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3",[f.workspaceId,team.id,f.member])
    expect(await visible()).toEqual([])
    // The legacy rollback switch keeps the legacy Team rule.
    await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspaceId])
    expect(await visible()).toEqual([unit.id])
  })
  it('publishing a unit does not reveal its hidden linked audience name or identifier',async()=>{
    const f=await fixture(),groups=createDbWorkspaceGroupStore()
    const team=await groups.createTeam(f.owner,f.workspaceId,{name:'Private audience',key:'private-audience'})
    await f.unit('Published directory',null,'workspace',team.id)
    const chart=await getOrganizationChart(f.workspaceId,f.member)
    expect(chart.units).toHaveLength(1)
    expect(chart.units[0]).toMatchObject({teamId:null,teamName:null})
    expect(chart.teams).toEqual([])
    expect(JSON.stringify(chart)).not.toContain(team.id)
    expect(JSON.stringify(chart)).not.toContain(team.name)
  })
  it('A13 moves never change membership, assistant grants or clearance',async()=>{
    const f=await fixture(),one=await f.unit('One'),two=await f.unit('Two'),p=await f.place(one.id,f.member)
    const before=await pool.query('SELECT * FROM workspace_members WHERE workspace_id=$1 ORDER BY user_id',[f.workspaceId])
    await f.run({type:'org.placement.save',id:p.id,expectedVersion:p.version,unitId:two.id,userId:f.member,assistantId:null,isPrimary:true,reportsToUserId:null,accountableUserId:null})
    const after=await pool.query('SELECT * FROM workspace_members WHERE workspace_id=$1 ORDER BY user_id',[f.workspaceId])
    expect(after.rows).toEqual(before.rows)
    expect((await pool.query('SELECT * FROM workspace_group_members WHERE user_id=$1',[f.member])).rows).toEqual([])
    expect((await pool.query('SELECT * FROM workspace_group_assistants WHERE assistant_id=$1',[f.assistant])).rows).toEqual([])
  })
  it('A12 rejects unit and reporting cycles, duplicate primaries and stale moves atomically',async()=>{
    const f=await fixture(),root=await f.unit('Root'),child=await f.unit('Child',root.id)
    await expect(f.run({type:'org.unit.save',id:root.id,expectedVersion:root.version,name:root.name,parentId:child.id,teamId:null,directoryVisibility:'members',position:0})).rejects.toThrow('organization_conflict')
    const a=await f.place(root.id,f.member,null,{reportsToUserId:f.colleague})
    await expect(f.place(child.id,f.colleague,null,{reportsToUserId:f.member})).rejects.toThrow('organization_conflict')
    await expect(f.place(child.id,f.member)).rejects.toThrow('organization_conflict')
    await f.run({type:'org.placement.remove',id:a.id,expectedVersion:a.version})
    await expect(f.run({type:'org.placement.remove',id:a.id,expectedVersion:a.version})).rejects.toThrow('organization_conflict')
    expect((await getOrganizationChart(f.workspaceId,f.owner)).placements).toEqual([])
  })
  it('A12 rejects same-workspace violations in service and raw database writes',async()=>{
    const f=await fixture(),other=await fixture(),unit=await f.unit('Local'),foreign=await other.unit('Other')
    await expect(f.place(unit.id,other.member)).rejects.toThrow('organization_conflict')
    await expect(f.place(foreign.id,f.member)).rejects.toThrow('organization_conflict')
    await expect(pool.query('UPDATE workspace_org_units SET parent_id=$1 WHERE id=$2',[foreign.id,unit.id])).rejects.toThrow()
    await expect(pool.query('UPDATE workspace_org_units SET workspace_id=$1 WHERE id=$2',[other.workspaceId,unit.id])).rejects.toThrow('organization_workspace_mismatch')
    await expect(getOrganizationChart(f.workspaceId,other.member)).rejects.toThrow('not_found')
  })
  it('archives only with explicit relocation, retaining audit and leaving linked audiences untouched',async()=>{
    const f=await fixture(),root=await f.unit('Root'),child=await f.unit('Child',root.id)
    await f.place(root.id,f.member)
    await expect(pool.query('UPDATE workspace_org_units SET archived_at=now() WHERE id=$1',[root.id])).rejects.toThrow('organization_move_required')
    const result=await f.run({type:'org.unit.archive',id:root.id,expectedVersion:root.version,destinationId:null})
    expect(result.units.map(u=>[u.id,u.parentId])).toEqual([[child.id,null]])
    expect(result.placements).toEqual([])
    expect((await pool.query(`SELECT kind FROM workspace_access_events WHERE workspace_id=$1 AND kind='org.unit.archive'`,[f.workspaceId])).rows).toHaveLength(1)
    expect((await pool.query('SELECT archived_at FROM workspace_org_units WHERE id=$1',[root.id])).rows[0].archived_at).toBeTruthy()
  })
  it('A12 permits only one concurrent optimistic edit and hides raw rows from a non-superuser member',async()=>{
    const f=await fixture(),unit=await f.unit('Root')
    const command:OrganizationCommand={type:'org.unit.save',id:unit.id,expectedVersion:unit.version,name:'Renamed',parentId:null,teamId:null,directoryVisibility:'members',position:0}
    const results=await Promise.allSettled([f.run(command),f.run(command)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    const client=await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_user_id',$1,true),set_config('app.system_bypass','false',true)`,[f.member])
      const role=await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
      expect(role.rows[0]).toEqual({rolsuper:false,rolbypassrls:false})
      for(const table of ['workspace_org_units','workspace_org_placements','workspace_access_events','workspace_team_managers']) expect((await client.query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows).toEqual([])
      await expect(client.query(`INSERT INTO workspace_org_units(workspace_id,name) VALUES($1,'Forbidden')`,[f.workspaceId])).rejects.toThrow()
    } finally {await client.query('ROLLBACK');client.release()}
  })
})
