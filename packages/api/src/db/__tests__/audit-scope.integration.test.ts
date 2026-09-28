import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { getPool,getAppPool,queryWithRLS,runWithAgentAccess } from '../client.js'
import { createContact } from '../crm.js'
import { createMemory } from '../memories.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { listCrmOperationsAudit } from '../../crm-operations/privacy.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),columns=['scope_subject_kind','scope_sources','scope_origin','scope_held','scope_erased']
async function fixture(){
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),assistantId=randomUUID()
  for(const id of [owner,member])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Audit fixture',$2)",[workspaceId,owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','internal','assigned')",[workspaceId,owner,member])
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Fixture','standard')",[assistantId,workspaceId,owner])
  const groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(owner,workspaceId,{name:'Fixture department',key:'fixture-department'})
  await groups.addMember(owner,team.id,member)
  const contact=await createContact(owner,{workspaceId,name:'Fixture contact',compartments:[team.compartmentKey!]})
  const append=async(metadata:Record<string,unknown>={})=>{
    const auditId=randomUUID(),workspaceAuditId=randomUUID()
    await pool.query(`INSERT INTO association_audit_log(id,workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,metadata,scope_sources,scope_origin)
      VALUES($1,$2,'crm.fixture','contact',$3,'user',$4,$5,'[]','legacy')`,[auditId,workspaceId,contact.id,owner,JSON.stringify(metadata)])
    await pool.query(`INSERT INTO workspace_audit_log(id,workspace_id,actor_user_id,event_type,subject_id,details)
      VALUES($1,$2,$3,'crm.fixture',$4,$5)`,[workspaceAuditId,workspaceId,owner,contact.id,JSON.stringify({subjectKind:'contact',...metadata})])
    return {auditId,workspaceAuditId}
  }
  const context={workspaceId,actor:{kind:'user' as const,userId:member},authority:{role:'member' as const,canWrite:true,canConfigure:false,trustedIdentitySources:[]}}
  return {workspaceId,owner,member,assistantId,groups,team,contact,append,context}
}
describe('[COMP:api/audit-scope] retained audit audiences',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it.each(['department','clearance','private_user','private_assistant','project'] as const)('preserves %s in both logs after a source release',async axis=>{
    const f=await fixture(),reader:Parameters<typeof runWithAgentAccess>[0]={workspaceId:f.workspaceId,userId:f.owner,clearance:'confidential',compartments:null,projectIds:null,visibilityAssistantIds:null}
    if(axis==='department')reader.compartments=[]
    if(axis==='clearance'){await pool.query("UPDATE entities SET sensitivity='confidential' WHERE id=$1",[f.contact.id]);reader.clearance='internal'}
    if(axis==='private_user'){await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1',[f.contact.id,f.owner]);reader.userId=f.member}
    if(axis==='private_assistant'){await pool.query('UPDATE entities SET assistant_id=$2 WHERE id=$1',[f.contact.id,f.assistantId]);reader.visibilityAssistantIds=[]}
    if(axis==='project'){
      const projectId=randomUUID();await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[projectId,f.workspaceId,f.owner])
      await pool.query('UPDATE entities SET project_ids=$2 WHERE id=$1',[f.contact.id,[projectId]]);reader.projectIds=[]
    }
    const rows=await f.append({private:'Protected audit'})
    await pool.query("UPDATE entities SET user_id=NULL,assistant_id=NULL,sensitivity='public',compartments='{}',project_ids='{}' WHERE id=$1",[f.contact.id])
    for(const [table,id] of [['association_audit_log',rows.auditId],['workspace_audit_log',rows.workspaceAuditId]]){
      expect((await runWithAgentAccess(reader,()=>queryWithRLS(reader.userId!,`SELECT id FROM ${table} WHERE id=$1`,[id]))).rows).toEqual([])
      expect((await queryWithRLS(f.owner,`SELECT id FROM ${table} WHERE id=$1`,[id])).rows).toHaveLength(1)
    }
  })
  it('requires all typed metadata sources and filters pagination after membership loss',async()=>{
    const f=await fixture(),other=await f.groups.createTeam(f.owner,f.workspaceId,{name:'Other department',key:'other-department'}),contact=await createContact(f.owner,{workspaceId:f.workspaceId,name:'Other contact',compartments:[other.compartmentKey!]})
    await f.append({contactId:contact.id})
    expect((await listCrmOperationsAudit(f.context)).entries).toEqual([])
    await f.groups.addMember(f.owner,other.id,f.member)
    expect((await listCrmOperationsAudit(f.context)).entries).toHaveLength(1)
    await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.team.id,f.member])
    expect((await listCrmOperationsAudit(f.context)).entries).toEqual([])
    await expect(listCrmOperationsAudit({...f.context,actor:{kind:'integration_key',credentialId:randomUUID()}})).rejects.toMatchObject({code:'not_authorized'})
  })
  it.each([
    ['memory','memories'],['entity_link','entity_links'],['task','tasks'],
    ['workspace_file','workspace_files'],['episode','episodes'],
    ['knowledge_entry','knowledge_entries'],['kb_chunk','kb_chunks'],
  ])('protects canonical %s history after release and holding',async(kind,table)=>{
    const f=await fixture(),id=randomUUID()
    let sourceId:string=id,content:Record<string,unknown>
    if(kind==='memory'){
      sourceId=(await createMemory({workspaceId:f.workspaceId,userId:null,assistantId:f.assistantId,createdByUserId:f.owner,
        scope:'workspace',summary:'Protected source',sensitivity:'internal',compartments:[f.team.compartmentKey!]})).id
    }else{
      if(kind==='entity_link')content={source_kind:'entity',source_id:f.contact.id,target_kind:'entity',target_id:f.contact.id,edge_type:'mentioned',source:'user'}
      else if(kind==='task')content={title:'Protected task',created_by_user_id:f.owner}
      else if(kind==='workspace_file')content={path:'/fixture.txt',name:'fixture.txt',storage_uri:'fixture://content',created_by_user_id:f.owner}
      else if(kind==='episode')content={source_kind:'web',source_ref:{},occurred_at:new Date(),created_by_user_id:f.owner}
      else if(kind==='knowledge_entry')content={path:'fixture.md',title:'Protected knowledge',content:'Protected content'}
      else content={chunk_text:'Protected chunk',created_by_user_id:f.owner,source:'user'}
      const visibility=['entity_link','episode','kb_chunk'].includes(kind)?{user_id:f.member}:{}
      const fields={id,workspace_id:f.workspaceId,sensitivity:'internal',compartments:[f.team.compartmentKey],...visibility,...content},keys=Object.keys(fields)
      await pool.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(fields))
    }
    const auditId=randomUUID()
    await pool.query(`INSERT INTO workspace_audit_log(id,workspace_id,actor_user_id,event_type,subject_id,details)
      VALUES($1,$2,$3,'fixture.change',$4,jsonb_build_object('subjectKind',$5::text))`,[auditId,f.workspaceId,f.owner,sourceId,kind])
    await pool.query(`UPDATE ${table} SET compartments='{}' WHERE id=$1`,[sourceId])
    expect((await queryWithRLS(f.member,'SELECT id FROM workspace_audit_log WHERE id=$1',[auditId])).rows).toHaveLength(1)
    await f.groups.removeMember(f.owner,f.team.id,f.member)
    expect((await queryWithRLS(f.member,'SELECT id FROM workspace_audit_log WHERE id=$1',[auditId])).rows).toEqual([])
    await f.groups.addMember(f.owner,f.team.id,f.member)
    expect((await queryWithRLS(f.member,'SELECT id FROM workspace_audit_log WHERE id=$1',[auditId])).rows).toHaveLength(1)
    await pool.query(`UPDATE ${table} SET scope_held=true WHERE id=$1`,[sourceId])
    expect((await queryWithRLS(f.member,'SELECT id FROM workspace_audit_log WHERE id=$1',[auditId])).rows).toEqual([])
  })
  it('rejects rebinding, lowering, invented source references and read-only mutations',async()=>{
    const f=await fixture(),{auditId}=await f.append()
    expect((await pool.query('SELECT scope_sources,scope_origin FROM association_audit_log WHERE id=$1',[auditId])).rows[0]).toMatchObject({scope_origin:'captured',scope_sources:[{resourceId:f.contact.id,compartments:[f.team.compartmentKey]}]})
    for(const change of ["scope_sources='[]'","scope_origin='legacy'","subject_id=gen_random_uuid()","metadata=jsonb_build_object('contactId',gen_random_uuid())"])
      await expect(pool.query(`UPDATE association_audit_log SET ${change} WHERE id=$1`,[auditId])).rejects.toThrow('audit_scope_release_required')
    await runWithAgentAccess({workspaceId:f.workspaceId,userId:f.member,clearance:'internal',compartments:[f.team.compartmentKey!],mutationCompartments:[],projectIds:null,visibilityAssistantIds:null},async()=>{
      expect((await queryWithRLS(f.member,'SELECT id FROM association_audit_log WHERE id=$1',[auditId])).rows).toHaveLength(1)
      expect((await queryWithRLS(f.member,"UPDATE association_audit_log SET metadata='{}' WHERE id=$1 RETURNING id",[auditId])).rows).toEqual([])
      expect((await queryWithRLS(f.member,'DELETE FROM association_audit_log WHERE id=$1 RETURNING id',[auditId])).rows).toEqual([])
    })
  })
  it('keeps terminal erased receipts minimal and administrative',async()=>{
    const f=await fixture(),rows=await f.append({private:'Protected body'})
    for(const [table,id,column,subject] of [['association_audit_log',rows.auditId,'metadata',"'00000000-0000-0000-0000-000000000000'::uuid"],['workspace_audit_log',rows.workspaceAuditId,'details','NULL']]){
      await pool.query(`UPDATE ${table} SET subject_id=${subject},${column}='{"erased":true}' WHERE id=$1`,[id])
      expect((await pool.query(`SELECT scope_sources,scope_erased FROM ${table} WHERE id=$1`,[id])).rows[0]).toEqual({scope_sources:[],scope_erased:true})
      expect((await queryWithRLS(f.owner,`SELECT id FROM ${table} WHERE id=$1`,[id])).rows).toHaveLength(1)
      expect((await queryWithRLS(f.member,`SELECT id FROM ${table} WHERE id=$1`,[id])).rows).toEqual([])
      await expect(pool.query(`UPDATE ${table} SET ${column}='{"private":"Revived"}' WHERE id=$1`,[id])).rejects.toThrow('audit_receipt_erased')
      await expect(pool.query(`UPDATE ${table} SET created_at=now()+interval '1 hour' WHERE id=$1`,[id])).rejects.toThrow('audit_receipt_erased')
      const actorColumn=table==='association_audit_log'?'acting_user_id':'actor_user_id'
      await expect(pool.query(`UPDATE ${table} SET ${actorColumn}=$2 WHERE id=$1`,[id,f.member])).rejects.toThrow('audit_receipt_erased')
      await pool.query(`UPDATE ${table} SET ${actorColumn}=NULL WHERE id=$1`,[id])
    }
  })
  it('retains protection when retention removes descriptive metadata',async()=>{
    const f=await fixture(),{workspaceAuditId}=await f.append({private:'Private'})
    await pool.query(`UPDATE workspace_audit_log SET details='{"retentionRedacted":true}' WHERE id=$1`,[workspaceAuditId])
    expect((await queryWithRLS(f.member,'SELECT id FROM workspace_audit_log WHERE id=$1',[workspaceAuditId])).rows).toHaveLength(1)
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.contact.id])
    expect((await queryWithRLS(f.member,'SELECT id FROM workspace_audit_log WHERE id=$1',[workspaceAuditId])).rows).toEqual([])
  })
  it('backfills a real pre-migration log as legacy rather than inventing provenance',async()=>{
    const f=await fixture(),{auditId}=await f.append(),client=await pool.connect()
    const migration=(await readFile(new URL('../../../migrations/583_audit_scope.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
    try{
      await client.query('BEGIN')
      for(const table of ['association_audit_log','workspace_audit_log']){
        for(const suffix of ['read','insert','update','delete'])await client.query(`DROP POLICY audit_scope_${suffix} ON ${table}`)
        await client.query(`DROP TRIGGER crm_scope_audit_guard ON ${table}`)
        await client.query(`ALTER TABLE ${table} ${columns.map(c=>`DROP COLUMN ${c}`).join(',')}`)
      }
      for(const fn of ['guard_audit_scope()','audit_scope_visible(jsonb,boolean)','capture_audit_scope(uuid,text,uuid,jsonb)','audit_subject_scope(uuid,text,uuid,boolean)'])await client.query(`DROP FUNCTION ${fn}`)
      await client.query(migration)
      expect((await client.query('SELECT scope_origin FROM association_audit_log WHERE id=$1',[auditId])).rows[0].scope_origin).toBe('legacy')
      await client.query("INSERT INTO workspace_access_policies(workspace_id,classification_mode) VALUES($1,'strict') ON CONFLICT(workspace_id) DO UPDATE SET classification_mode='strict'",[f.workspaceId])
      await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.owner])
      await client.query('SET LOCAL ROLE assurance_app')
      expect((await client.query('SELECT id FROM association_audit_log WHERE id=$1',[auditId])).rows).toEqual([])
    }finally{await client.query('ROLLBACK');client.release()}
  })
})
