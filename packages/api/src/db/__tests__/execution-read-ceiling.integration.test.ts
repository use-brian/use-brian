import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool, getAppPool, queryWithRLS, applyRLSGucs } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createMemory } from '../memories.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
const tables=['memories','entities','entity_links','tasks','workspace_files','episodes','knowledge_entries','kb_chunks'] as const
async function fixture(table:typeof tables[number]) {
  const workspaceId=randomUUID(),userId=randomUUID(),assistantId=randomUUID(),projectId=randomUUID()
  let id:string=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Read ceiling fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind) VALUES($1,'Fixture assistant',$2,$3,'primary')",[assistantId,userId,workspaceId])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'product','Product')",[workspaceId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[projectId,workspaceId,userId])
  const args=[id,workspaceId,userId,assistantId]
  if(table==='memories')id=(await createMemory({workspaceId,userId,assistantId,createdByUserId:userId,summary:'Fixture source',sensitivity:'internal'})).id
  if(table==='entities')await pool.query("INSERT INTO entities(id,workspace_id,created_by_user_id,assistant_id,kind,display_name,source) VALUES($1,$2,$3,$4,'person','Fixture source','user')",args)
  if(table==='entity_links') {
    const endpoints=[randomUUID(),randomUUID()]
    for(const endpoint of endpoints)await pool.query("INSERT INTO entities(id,workspace_id,created_by_user_id,assistant_id,kind,display_name,source) VALUES($1,$2,$3,$4,'person','Fixture endpoint','user')",[endpoint,...args.slice(1)])
    await pool.query("INSERT INTO entity_links(id,workspace_id,user_id,assistant_id,source_kind,source_id,target_kind,target_id,edge_type,source) VALUES($1,$2,$3,$4,'entity',$5,'entity',$6,'mentioned','user')",[...args,...endpoints])
  }
  if(table==='tasks')await pool.query("INSERT INTO tasks(id,workspace_id,created_by_user_id,assistant_id,title) VALUES($1,$2,$3,$4,'Fixture source')",args)
  if(table==='workspace_files')await pool.query("INSERT INTO workspace_files(id,workspace_id,created_by_user_id,assistant_id,path,name,storage_uri) VALUES($1,$2,$3,$4,'/fixture.txt','fixture.txt','gs://fixture/file')",args)
  if(table==='episodes')await pool.query("INSERT INTO episodes(id,workspace_id,created_by_user_id,assistant_id,source_kind,source_ref,occurred_at) VALUES($1,$2,$3,$4,'fixture','{}',now())",args)
  if(table==='knowledge_entries')await pool.query("INSERT INTO knowledge_entries(id,workspace_id,created_by,path,title,content) VALUES($1,$2,$3,'fixture.md','Fixture source','Fixture content')",args.slice(0,3))
  if(table==='kb_chunks')await pool.query("INSERT INTO kb_chunks(id,workspace_id,created_by_user_id,assistant_id,chunk_text,source) VALUES($1,$2,$3,$4,'Fixture source','user')",args)
  await pool.query(`UPDATE ${table} SET compartments=ARRAY['product'],project_ids=$2,sensitivity='internal' WHERE id=$1`,[id,[projectId]])
  const access={workspaceId,userId,clearance:'internal' as const,compartments:['product'],mutationCompartments:['product'],projectIds:[projectId]}
  const read=()=>queryWithRLS(userId,`SELECT id FROM ${table} WHERE id=$1`,[id])
  return {workspaceId,userId,id,projectId,access,read}
}
describe('[COMP:api/execution-read-ceiling] direct app-role source projection',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it.each(tables)('bounds %s reads, updates and deletes independently of caller SQL',async table=>{
    const f=await fixture(table)
    expect((await runWithAgentAccess(f.access,f.read)).rows).toHaveLength(1)
    for(const denied of [{...f.access,compartments:[]},{...f.access,projectIds:[]},{...f.access,clearance:'public' as const}]) {
      await runWithAgentAccess(denied,async()=>{
        expect((await f.read()).rows).toEqual([])
        expect((await queryWithRLS(f.userId,`UPDATE ${table} SET compartments='{}' WHERE id=$1 RETURNING id`,[f.id])).rows).toEqual([])
        expect((await queryWithRLS(f.userId,`DELETE FROM ${table} WHERE id=$1 RETURNING id`,[f.id])).rows).toEqual([])
      })
    }
    // No transaction-local agent setting may leak to the next human request.
    expect((await f.read()).rows).toHaveLength(1)
    expect((await pool.query(`SELECT compartments FROM ${table} WHERE id=$1`,[f.id])).rows[0].compartments).toEqual(['product'])
    await runWithAgentAccess({...f.access,compartments:null,projectIds:null},async()=>expect((await f.read()).rows).toHaveLength(1))
    await pool.query(`UPDATE ${table} SET compartments='{}',project_ids='{}',sensitivity='public' WHERE id=$1`,[f.id])
    expect((await runWithAgentAccess({...f.access,compartments:[],projectIds:[],clearance:'public'},f.read)).rows).toHaveLength(1)
  })
  it.each(tables)('enforces current member read versus mutation reach on %s without relying on caller SQL',async table=>{
    const f=await fixture(table),groups=createDbWorkspaceGroupStore(),approver=randomUUID(),requestId=randomUUID()
    const team=await groups.createTeam(f.userId,f.workspaceId,{name:'Finance',key:'finance'})
    await groups.removeMember(f.userId,team.id,f.userId)
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[approver])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[f.workspaceId,approver])
    await pool.query("UPDATE workspace_members SET role='member',clearance='internal',team_scope_mode='assigned',compartments=NULL WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await pool.query(`UPDATE ${table} SET compartments=$2,project_ids='{}'${table==='knowledge_entries'?'':',user_id=NULL'} WHERE id=$1`,[f.id,[team.compartmentKey]])
    expect((await f.read()).rows).toEqual([])
    await pool.query(`INSERT INTO workspace_access_requests(id,workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,$3,'member',$3,$4,'Fixture request',now(),now()+interval '1 day',$5,1,'approved',$6,now())`,[requestId,f.workspaceId,f.userId,team.id,'b'.repeat(64),approver])
    const grant=(await pool.query(`INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM workspace_access_requests WHERE id=$1 RETURNING id`,[requestId])).rows[0]
    expect((await f.read()).rows).toHaveLength(1)
    expect((await queryWithRLS(f.userId,`UPDATE ${table} SET compartments='{}' WHERE id=$1 RETURNING id`,[f.id])).rows).toEqual([])
    expect((await queryWithRLS(f.userId,`DELETE FROM ${table} WHERE id=$1 RETURNING id`,[f.id])).rows).toEqual([])
    await pool.query(`UPDATE ${table} SET sensitivity='confidential' WHERE id=$1`,[f.id])
    expect((await f.read()).rows).toEqual([])
    await pool.query(`UPDATE ${table} SET sensitivity='internal' WHERE id=$1`,[f.id])
    await pool.query('UPDATE workspace_access_grants SET revoked_at=now(),revoked_by=$2 WHERE id=$1',[grant.id,approver])
    // A retained agent grant cannot override current member revocation.
    expect((await runWithAgentAccess({...f.access,compartments:null,projectIds:null},f.read)).rows).toEqual([])
    expect((await f.read()).rows).toEqual([])
  })
  it('checks destination member authority on direct SQL inserts and scope-changing updates',async()=>{
    const f=await fixture('entities')
    await pool.query("UPDATE workspace_members SET role='member',compartments='{}',clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await pool.query("UPDATE entities SET compartments='{}',project_ids='{}' WHERE id=$1",[f.id])
    expect((await f.read()).rows).toHaveLength(1)
    await expect(queryWithRLS(f.userId,"UPDATE entities SET compartments=ARRAY['product'] WHERE id=$1",[f.id])).rejects.toThrow(/row-level security/)
    await expect(queryWithRLS(f.userId,"INSERT INTO entities(workspace_id,created_by_user_id,kind,display_name,source,compartments) VALUES($1,$2,'person','Blocked destination','user',ARRAY['product'])",[f.workspaceId,f.userId])).rejects.toThrow(/row-level security/)
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    expect((await f.read()).rows).toEqual([])
  })
  it('adds the member operation floor during upgrade without changing existing source data',async()=>{
    const f=await fixture('entities'),client=await pool.connect()
    const migration=(await readFile(new URL('../../../migrations/589_member_operation_floor.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
    try {
      await client.query('BEGIN')
      const before=(await client.query('SELECT to_jsonb(e) row FROM entities e WHERE id=$1',[f.id])).rows[0].row
      for(const table of [...tables,'memories_shadow'])for(const policy of ['member_operation_read','member_operation_insert','member_operation_update','member_operation_delete'])await client.query(`DROP POLICY ${policy} ON ${table}`)
      await client.query('DROP FUNCTION member_operation_scope_allows(uuid,text,text[],boolean)')
      await client.query(migration)
      expect((await client.query('SELECT to_jsonb(e) row FROM entities e WHERE id=$1',[f.id])).rows[0].row).toEqual(before)
      expect((await client.query("SELECT count(*)::int count FROM pg_policies WHERE policyname LIKE 'member_operation_%' AND permissive='RESTRICTIVE'")).rows[0].count).toBe(36)
    } finally {await client.query('ROLLBACK');client.release()}
  })
  it('rejects malformed grants even for General rows and keeps the shadow deny-by-default',async()=>{
    const f=await fixture('entities'),client=await getAppPool().connect()
    try {
      await client.query('BEGIN');await runWithAgentAccess(f.access,()=>applyRLSGucs(client,f.userId))
      for(const setting of ['app.agent_compartments','app.agent_project_ids']) {
        for(const invalid of ['broken','{}','true','[1]','[null]']) {
          await client.query('SELECT set_config($1,$2,true)',[setting,invalid])
          expect((await client.query("SELECT agent_read_scope_allows('public','{}','{}') allowed")).rows[0].allowed).toBe(false)
        }
        await client.query("SELECT set_config($1,'null',true)",[setting])
      }
      await client.query("SET LOCAL app.agent_clearance='unknown'")
      expect((await client.query("SELECT agent_read_scope_allows('public','{}','{}') allowed")).rows[0].allowed).toBe(false)
      expect((await client.query('SELECT id FROM memories_shadow')).rows).toEqual([])
      await client.query('ROLLBACK')
    }finally{client.release()}
  })
  it('rejects out-of-project destinations on inserts and updates without widening Team mutation authority',async()=>{
    const f=await fixture('entities'),other=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Other','other',$3)",[other,f.workspaceId,f.userId])
    await runWithAgentAccess(f.access,async()=>{
      await expect(queryWithRLS(f.userId,'UPDATE entities SET project_ids=$2 WHERE id=$1',[f.id,[other]])).rejects.toThrow(/row-level security/)
      await expect(queryWithRLS(f.userId,"INSERT INTO entities(workspace_id,created_by_user_id,kind,display_name,source,project_ids) VALUES($1,$2,'person','Forbidden','user',$3)",[f.workspaceId,f.userId,[other]])).rejects.toThrow(/row-level security/)
    })
    await runWithAgentAccess({...f.access,mutationCompartments:[]},async()=>{
      expect((await f.read()).rows).toHaveLength(1)
      expect((await queryWithRLS(f.userId,"UPDATE entities SET display_name='Forbidden' WHERE id=$1 RETURNING id",[f.id])).rows).toEqual([])
    })
  })
  it('upgrades existing rows and installs restrictive policies on all nine source tables',async()=>{
    const f=await fixture('entities'),client=await pool.connect()
    const migration=(await readFile(new URL('../../../migrations/585_agent_read_ceiling.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
    try {
      await client.query('BEGIN')
      for(const table of [...tables,'memories_shadow'])for(const policy of ['execution_read_ceiling','execution_read_update_source','execution_read_delete_source','execution_project_insert'])await client.query(`DROP POLICY ${policy} ON ${table}`)
      await client.query('DROP FUNCTION agent_read_scope_allows(text,text[],uuid[])')
      await client.query('DROP FUNCTION agent_scope_grant_allows(text,text[])')
      await client.query(migration)
      const policies=await client.query("SELECT tablename,permissive FROM pg_policies WHERE policyname='execution_read_ceiling' ORDER BY tablename")
      expect(policies.rows.map(row=>row.tablename)).toEqual([...tables,'memories_shadow'].sort())
      expect(policies.rows.every(row=>row.permissive==='RESTRICTIVE')).toBe(true)
      await client.query('SET LOCAL ROLE assurance_app')
      await runWithAgentAccess({...f.access,compartments:[]},()=>applyRLSGucs(client,f.userId))
      expect((await client.query('SELECT id FROM entities WHERE id=$1',[f.id])).rows).toEqual([])
      await client.query('ROLLBACK')
    }finally{await client.query('ROLLBACK');client.release()}
  })
})
