import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {applyRLSGucs,getAppPool,getPool} from '../client.js'
import {createDbWorkspaceGroupStore} from '../workspace-group-store.js'

// Legacy (department_read_v2=false) derived entity and file writers, called as
// the member's app session. Project participation is navigation metadata and
// grants no read or write authority (scoped-context.md, projects.md; decision 2,
// 2026-11-17): a Project label keeps only its active-Project check, and Team
// scope, sensitivity, membership and visibility decide.
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()

async function fixture(){
  const workspaceId=randomUUID(),ownerId=randomUUID(),memberId=randomUUID(),participantId=randomUUID(),projectId=randomUUID()
  for(const id of [ownerId,memberId,participantId])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Derived participation fixture',$2,false)",[workspaceId,ownerId])
  for(const [id,role] of [[ownerId,'owner'],[memberId,'member'],[participantId,'member']])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'internal')",[workspaceId,id,role])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[projectId,workspaceId,ownerId])
  const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(ownerId,workspaceId,{name:'Product',key:'product'})
  const key=team.compartmentKey!
  await pool.query("UPDATE workspace_members SET team_scope_mode='assigned' WHERE workspace_id=$1 AND user_id=ANY($2::uuid[])",[workspaceId,[memberId,participantId]])
  // The member belongs to the Team and takes no Project part; the participant
  // leads the Project and belongs to no Team.
  await groups.addMember(ownerId,team.id,memberId)
  await pool.query("INSERT INTO workspace_project_members(project_id,user_id,role) VALUES($1,$2,'lead')",[projectId,participantId])
  // A General source with no Project, so each case judges the writer's own
  // destination check rather than the source read.
  const source=(await pool.query("INSERT INTO entities(kind,display_name,sensitivity,workspace_id,created_by_user_id,source) VALUES('person','Fictional source person','internal',$1,$2,'user') RETURNING id",[workspaceId,ownerId])).rows[0].id as string
  const snapshot=(await pool.query("SELECT read_scope_source($1,'entity',$2) AS source",[workspaceId,source])).rows[0].source
  const derivation={producer:'participation-regression',sources:[snapshot]}
  const asMember=async<T>(actor:string,run:(client:import('pg').PoolClient)=>Promise<T>)=>{
    const client=await getAppPool().connect()
    try {await client.query('BEGIN');await applyRLSGucs(client,actor);const value=await run(client);await client.query('COMMIT');return value}
    catch(error) {await client.query('ROLLBACK');throw error}
    finally {client.release()}
  }
  const envelope=(actor:string,compartments:string[])=>({workspaceId,createdByUserId:actor,userId:null,assistantId:null,sensitivity:'internal',compartments,projectIds:[projectId],source:'extracted'})
  const entity=(actor:string,compartments:string[]=[])=>asMember(actor,client=>client.query('SELECT id,project_ids FROM create_source_derived_entity($1::jsonb,$2::jsonb)',
    [JSON.stringify({...envelope(actor,compartments),kind:'person',displayName:'Fictional derived person'}),JSON.stringify(derivation)]).then(result=>result.rows[0]))
  const file=(actor:string,compartments:string[]=[])=>{
    const name=`derived-${randomUUID()}.md`
    return asMember(actor,client=>client.query('SELECT id,project_ids FROM create_source_derived_file($1::jsonb,$2::jsonb)',
      [JSON.stringify({...envelope(actor,compartments),path:`/derived/${name}`,parentPath:'/derived',name,title:'Fictional derived note',summary:null,mime:'text/markdown',
        sizeBytes:12,storageUri:`fixture://${name}`,tags:[],relatedIds:[],metadata:{}}),JSON.stringify(derivation)]).then(result=>result.rows[0]))
  }
  const count=async()=>Number((await pool.query('SELECT (SELECT count(*) FROM entities WHERE workspace_id=$1 AND id<>$2)+(SELECT count(*) FROM workspace_files WHERE workspace_id=$1) AS n',[workspaceId,source])).rows[0].n)
  return {workspaceId,projectId,key,memberId,participantId,entity,file,count}
}

describe('[COMP:api/task-mutation-scope] legacy derived writers treat Project participation as metadata',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it.each(['entity','file'] as const)('lets a Team member who takes no Project part write a derived %s into an active Project',async kind=>{
    const f=await fixture()
    expect(await f[kind](f.memberId,[f.key])).toMatchObject({project_ids:[f.projectId]})
    expect(await f[kind](f.memberId)).toMatchObject({project_ids:[f.projectId]})
    expect(await f.count()).toBe(2)
  })
  it.each(['entity','file'] as const)('gives a Project participant without Team membership no derived %s write into the Team',async kind=>{
    const f=await fixture()
    await expect(f[kind](f.participantId,[f.key])).rejects.toThrow('scope_operation_denied')
    expect(await f.count()).toBe(0)
  })
  it.each(['entity','file'] as const)('refuses a derived %s into an archived Project for every member',async kind=>{
    const f=await fixture()
    await pool.query("UPDATE workspace_projects SET status='archived' WHERE id=$1",[f.projectId])
    for(const actor of [f.memberId,f.participantId])await expect(f[kind](actor)).rejects.toThrow('scope_operation_denied')
    expect(await f.count()).toBe(0)
  })
})
