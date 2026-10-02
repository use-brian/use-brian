import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getPool, getAppPool } from '../../db/client.js'
import { createMemory } from '../../db/memories.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { executeWorkspaceScopeReview as execute, getWorkspaceScopeInventory } from '../scope-review.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture(){
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),assistantId=randomUUID()
  for(const id of [owner,member])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Consolidation',$2)",[workspaceId,owner])
  for(const id of [owner,member])await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode,compartments) VALUES($1,$2,$3,\'assigned\',NULL)',[workspaceId,id,id===owner?'owner':'member'])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,team_scope_mode) VALUES($1,'Assistant',$2,$3,'standard','all')",[assistantId,owner,workspaceId])
  const store=createDbWorkspaceGroupStore(),old=await store.createTeam(owner,workspaceId,{name:'Old',key:'old'}),target=await store.createTeam(owner,workspaceId,{name:'Default',key:'default'})
  await pool.query('UPDATE workspace_access_policies SET default_department_id=$2 WHERE workspace_id=$1',[workspaceId,target.id])
  await pool.query('INSERT INTO workspace_group_members(group_id,user_id) VALUES($1,$2)',[target.id,member])
  const create=()=>createMemory({workspaceId,userId:owner,assistantId,createdByUserId:owner,summary:'Private source',sensitivity:'confidential',compartments:[old.compartmentKey!]})
  const preview=(ids:string[],extra:Record<string,unknown>={})=>execute(workspaceId,owner,{type:'scope.review.preview',resourceKind:'memory',resourceIds:ids,action:'consolidate_default',targetTeamId:target.id,reason:'Explicit default consolidation',...extra})
  const apply=(job:{id:string;version:string;payloadHash:string})=>execute(workspaceId,owner,{type:'scope.review.apply',reviewId:job.id,expectedVersion:job.version,payloadHash:job.payloadHash})
  return {workspaceId,owner,member,assistantId,old,target,create,preview,apply}
}

describe('separate reviewed default consolidation (real PG)',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('freezes concrete human/assistant department scope, preserves private data and holds descendants',async()=>{
    const f=await fixture(),root=await f.create()
    const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) source",[f.workspaceId,root.id])).rows[0].source
    const derived=await createMemory({workspaceId:f.workspaceId,userId:f.owner,assistantId:f.assistantId,createdByUserId:f.owner,summary:'Derived',sensitivity:'confidential',derivation:{producer:'test',sources:[source]}})
    const saved=await f.preview([root.id]),impact=saved.items[0].impact
    expect(saved.expiresAt).toBeTruthy()
    expect(impact?.version).toBe(2)
    if(impact?.version!==2)throw Error('missing impact')
    expect(impact.consolidation?.audiences).toEqual(expect.arrayContaining([
      {userId:f.member,assistantId:null,readBefore:false,readAfter:true,editBefore:false,editAfter:true},
      {userId:f.member,assistantId:f.assistantId,readBefore:false,readAfter:true,editBefore:false,editAfter:true},
    ]))
    expect(impact.consolidation?.futureDefaultMembersWarning).toContain('Future default-department members')
    expect(impact.consolidation?.after).toEqual({...source,compartments:[f.target.compartmentKey]})
    await expect(pool.query("UPDATE workspace_scope_reviews SET expires_at=expires_at+interval '1 second' WHERE id=$1",[saved.id])).rejects.toThrow('scope_review_proposal_immutable')
    expect((await f.apply(saved)).status).toBe('complete')
    const after=(await pool.query('SELECT user_id,assistant_id,sensitivity,compartments,scope_version,scope_held FROM memories WHERE id=$1',[root.id])).rows[0]
    expect(after).toMatchObject({user_id:f.owner,assistant_id:f.assistantId,sensitivity:'confidential',compartments:[f.target.compartmentKey],scope_held:false})
    expect(BigInt(after.scope_version)).toBeGreaterThan(BigInt(root.scopeVersion))
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[derived.id])).rows[0].scope_held).toBe(true)
    expect((await pool.query('SELECT access_mode,classification_mode FROM workspace_access_policies WHERE workspace_id=$1',[f.workspaceId])).rows[0]).toEqual({access_mode:'departments',classification_mode:'legacy'})
  })
  async function derived(f:Awaited<ReturnType<typeof fixture>>,compatible:boolean){
    const parent=await f.create()
    if(compatible)await pool.query('UPDATE memories SET compartments=$2 WHERE id=$1',[parent.id,[f.target.compartmentKey]])
    const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) source",[f.workspaceId,parent.id])).rows[0].source
    const root=await createMemory({workspaceId:f.workspaceId,userId:f.owner,assistantId:f.assistantId,createdByUserId:f.owner,summary:'Derived root',sensitivity:'confidential',compartments:[f.old.compartmentKey!],derivation:{producer:'test',sources:[source]}})
    return {parent,root}
  }
  it('denies an incompatible canonical memory floor through direct review, including predecessor lineage',async()=>{
    const f=await fixture(),{root}=await derived(f,false)
    await expect(f.preview([root.id])).rejects.toMatchObject({code:'scope_review_source_floor_unsupported'})
    const successor=await f.create()
    await pool.query('UPDATE memories SET superseded_by=$2,valid_to=now() WHERE id=$1',[root.id,successor.id])
    await expect(f.preview([successor.id])).rejects.toMatchObject({code:'scope_review_source_floor_unsupported'})
  })
  it('allows a compatible canonical floor, freezing evidence without dropping its protections',async()=>{
    const f=await fixture(),{root,parent}=await derived(f,true),saved=await f.preview([root.id])
    const impact=saved.items[0].impact
    if(impact?.version!==2)throw Error('missing impact')
    expect(impact.consolidation?.sourceFloor?.nodes).toEqual(expect.arrayContaining([expect.objectContaining({resourceId:parent.id})]))
    expect((await f.apply(saved)).status).toBe('complete')
    expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[root.id])).rows[0].compartments).toEqual([f.target.compartmentKey])
  })
  it.each(['changed','held','new'])('direct canonical apply rejects %s parent evidence after preview',async(change)=>{
    const f=await fixture(),{root,parent}=await derived(f,true),saved=await f.preview([root.id])
    if(change==='changed')await pool.query("UPDATE memories SET summary='changed parent' WHERE id=$1",[parent.id])
    if(change==='held')await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[parent.id])
    if(change==='new'){
      const additional=await f.create()
      await pool.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
        SELECT $1,id,'memory',$3,$4 FROM scope_derivations WHERE workspace_id=$1 AND resource_id=$2`,[f.workspaceId,root.id,additional.id,additional.scopeVersion])
      // Adding canonical source evidence need not mutate the root version.
      expect((await pool.query('SELECT scope_version::text version FROM memories WHERE id=$1',[root.id])).rows[0].version).toBe(saved.items[0].source.version)
    }
    expect((await f.apply(saved)).status).toBe('stale')
    expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[root.id])).rows[0].compartments).toContain(f.old.compartmentKey)
  })
  it.each(['episode','entity_link'])('enforces physical %s parents without derivation records',async(kind)=>{
    const f=await fixture(),parent=randomUUID(),root=randomUUID()
    await pool.query(`INSERT INTO episodes(id,workspace_id,user_id,assistant_id,created_by_user_id,source_kind,source_ref,occurred_at,sensitivity,compartments)
      VALUES($1,$2,$3,$4,$3,'web','{}',now(),'confidential',$5)`,[parent,f.workspaceId,f.owner,f.assistantId,[f.old.compartmentKey]])
    if(kind==='episode')await pool.query(`INSERT INTO episodes(id,workspace_id,user_id,assistant_id,created_by_user_id,source_kind,source_ref,occurred_at,sensitivity,compartments,parent_episode_id)
      VALUES($1,$2,$3,$4,$3,'web','{}',now(),'confidential',$5,$6)`,[root,f.workspaceId,f.owner,f.assistantId,[f.old.compartmentKey],parent])
    else await pool.query(`INSERT INTO entity_links(id,workspace_id,user_id,assistant_id,source_kind,source_id,target_kind,target_id,edge_type,source,sensitivity,compartments)
      VALUES($1,$2,$3,$4,'episode',$5,'episode',$5,'mentioned','user','confidential',$6)`,[root,f.workspaceId,f.owner,f.assistantId,parent,[f.old.compartmentKey]])
    await expect(f.preview([root],{resourceKind:kind})).rejects.toMatchObject({code:'scope_review_source_floor_unsupported'})
    await pool.query('UPDATE episodes SET compartments=$2 WHERE id=$1',[parent,[f.target.compartmentKey]])
    const saved=await f.preview([root],{resourceKind:kind})
    await pool.query('UPDATE episodes SET scope_held=true WHERE id=$1',[parent])
    expect((await f.apply(saved)).status).toBe('stale')
    await pool.query('UPDATE episodes SET scope_held=false WHERE id=$1',[parent])
    expect((await f.apply(await f.preview([root],{resourceKind:kind}))).status).toBe('complete')
  })
  it.each(['private','Project','sensitivity','retracted'])('does not declassify a physical source %s floor',async(axis)=>{
    const f=await fixture(),parent=randomUUID(),root=await f.create(),project=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Floor','floor',$3)",[project,f.workspaceId,f.owner])
    await pool.query(`INSERT INTO episodes(id,workspace_id,user_id,assistant_id,created_by_user_id,source_kind,source_ref,occurred_at,sensitivity,compartments,project_ids)
      VALUES($1,$2,$3,$4,$3,'web','{}',now(),'confidential',$5,$6)`,[parent,f.workspaceId,f.owner,f.assistantId,[f.target.compartmentKey],axis==='Project'?[project]:[]])
    await pool.query('UPDATE memories SET source_episode_id=$2 WHERE id=$1',[root.id,parent])
    if(axis==='private')await pool.query('UPDATE memories SET user_id=NULL WHERE id=$1',[root.id])
    if(axis==='sensitivity')await pool.query("UPDATE memories SET sensitivity='internal' WHERE id=$1",[root.id])
    if(axis==='retracted'){
      // A canonical memory source can retract even though episodes cannot.
      const {root:derivedRoot,parent:memoryParent}=await derived(f,true)
      await pool.query('UPDATE memories SET retracted_at=now() WHERE id=$1',[memoryParent.id])
      await expect(f.preview([derivedRoot.id])).rejects.toMatchObject({code:'scope_review_release_required'})
      return
    }
    await expect(f.preview([root.id])).rejects.toMatchObject({code:'scope_review_source_floor_unsupported'})
  })
  it('fails closed if SQL expands the approved compartments on update',async()=>{
    const f=await fixture(),root=await f.create(),saved=await f.preview([root.id])
    const name=`test_floor_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${root.id}'::uuid THEN NEW.compartments=ARRAY['${f.target.compartmentKey}','${f.old.compartmentKey}']; END IF;
      RETURN NEW; END $$`)
    try{
      await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE OF compartments ON memories FOR EACH ROW EXECUTE FUNCTION ${name}()`)
      await expect(f.apply(saved)).rejects.toMatchObject({code:'scope_review_changed'})
      expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[root.id])).rows[0].compartments).toEqual([f.old.compartmentKey])
    }finally{
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON memories; DROP FUNCTION ${name}()`)
    }
  })
  it('explicitly denies unprovable episode stamps rather than treating them as authored roots',async()=>{
    const f=await fixture(),id=randomUUID()
    await pool.query(`INSERT INTO episodes(id,workspace_id,user_id,assistant_id,created_by_user_id,source_kind,source_ref,occurred_at,compartments)
      VALUES($1,$2,$3,$4,$3,'web_chat',$5,now(),$6)`,[id,f.workspaceId,f.owner,f.assistantId,{session_id:randomUUID()},[f.old.compartmentKey]])
    await expect(f.preview([id],{resourceKind:'episode'})).rejects.toMatchObject({code:'scope_review_source_floor_unsupported'})
  })
  it('offers an explicit classified inventory so an administrator can actually select consolidation sources',async()=>{
    const f=await fixture(),root=await f.create()
    const unresolved=await getWorkspaceScopeInventory(f.workspaceId,f.owner,'memory')
    expect(unresolved.items.some(item=>item.id===root.id)).toBe(false)
    const classified=await getWorkspaceScopeInventory(f.workspaceId,f.owner,'memory',undefined,undefined,undefined,true)
    const selected=classified.items.find(item=>item.id===root.id)
    expect(selected?.compartments).toEqual([f.old.compartmentKey])
    expect(selected?.allowedActions).toContain('consolidate_default')
    await expect(getWorkspaceScopeInventory(f.workspaceId,f.member,'memory',undefined,undefined,undefined,true)).rejects.toMatchObject({code:'admin_required'})
    expect((await f.preview([selected!.id])).action).toBe('consolidate_default')
  })
  it('reports read-only collaboration separately from edit scope',async()=>{
    const f=await fixture(),root=await f.create()
    await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.target.id,f.member])
    await pool.query(`WITH request AS (
      INSERT INTO workspace_access_requests(workspace_id,requester_user_id,beneficiary_kind,beneficiary_id,target_team_id,reason,starts_at,expires_at,payload_hash,policy_revision,status,decided_by,decided_at)
      VALUES($1,$2,'member',$2,$3,'Read only',now()-interval '1 hour',now()+interval '1 hour',repeat('a',64),1,'approved',$4,now()) RETURNING *
    ) INSERT INTO workspace_access_grants(workspace_id,request_id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,approved_by)
      SELECT workspace_id,id,beneficiary_kind,beneficiary_id,target_team_id,starts_at,expires_at,decided_by FROM request`,[f.workspaceId,f.member,f.target.id,f.owner])
    const saved=await f.preview([root.id]),impact=saved.items[0].impact
    if(impact?.version!==2)throw Error('missing impact')
    expect(impact.consolidation?.audiences).toContainEqual({userId:f.member,assistantId:null,readBefore:false,readAfter:true,editBefore:false,editAfter:false})
    const cancelled=await execute(f.workspaceId,f.owner,{type:'scope.review.cancel',reviewId:saved.id,expectedVersion:saved.version,payloadHash:saved.payloadHash})
    expect((await f.apply(cancelled)).status).toBe('cancelled')
    expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[root.id])).rows[0].compartments).toEqual([f.old.compartmentKey])
  })
  it.each(['membership','policy','source','descendant'])('refuses stale %s',async(change)=>{
    const f=await fixture(),root=await f.create(),saved=await f.preview([root.id])
    if(change==='membership')await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.target.id,f.member])
    if(change==='policy')await pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1',[f.workspaceId])
    if(change==='source')await pool.query("UPDATE memories SET summary='changed' WHERE id=$1",[root.id])
    if(change==='descendant'){
      const source=(await pool.query("SELECT read_scope_source($1,'memory',$2) source",[f.workspaceId,root.id])).rows[0].source
      await createMemory({workspaceId:f.workspaceId,userId:f.owner,assistantId:f.assistantId,createdByUserId:f.owner,summary:'New descendant',sensitivity:'confidential',derivation:{producer:'test',sources:[source]}})
    }
    expect((await f.apply(saved)).status).toBe('stale')
    expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[root.id])).rows[0].compartments).toEqual([f.old.compartmentKey])
  })
  it('expires, rejects changed hash, and replay cannot advance a second page',async()=>{
    const f=await fixture(),ids:string[]=[]
    for(let i=0;i<26;i++)ids.push((await f.create()).id)
    const saved=await f.preview(ids)
    await expect(f.apply({...saved,payloadHash:'0'.repeat(64)})).rejects.toMatchObject({code:'scope_review_changed'})
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(saved.expiresAt!)+1)
    try{await expect(f.apply(saved)).rejects.toMatchObject({code:'scope_review_expired'})}finally{clock.mockRestore()}
    const page=await f.apply(saved)
    expect(page.status).toBe('running')
    expect((await f.apply(saved)).version).toBe(page.version)
    expect((await pool.query("SELECT count(*)::int count FROM workspace_scope_review_items WHERE review_id=$1 AND status='pending'",[saved.id])).rows[0].count).toBe(1)
    expect((await f.apply(page)).status).toBe('complete')
  })
  it.each([
    ['entity','entities'],['entity_link','entity_links'],['task','tasks'],
    ['workspace_file','workspace_files'],['episode','episodes'],
    ['knowledge_entry','knowledge_entries'],['kb_chunk','kb_chunks'],
  ])('consolidates canonical %s without changing its other protections',async(kind,table)=>{
    const f=await fixture(),id=randomUUID(),project=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[project,f.workspaceId,f.owner])
    const base={id,workspace_id:f.workspaceId,sensitivity:'confidential',compartments:[f.old.compartmentKey],project_ids:[project]}
    const visibility=kind==='knowledge_entry'?{}:{user_id:f.owner,assistant_id:f.assistantId}
    let content:Record<string,unknown>
    if(kind==='entity')content={kind:'project',display_name:'Review source',created_by_user_id:f.owner,source:'user'}
    else if(kind==='entity_link'){
      const source=await f.create(),target=randomUUID()
      await pool.query('UPDATE memories SET compartments=$2 WHERE id=$1',[source.id,[f.target.compartmentKey]])
      await pool.query("INSERT INTO entities(id,kind,display_name,workspace_id,user_id,assistant_id,created_by_user_id,source) VALUES($1,'project','Linked fixture',$2,$3,$4,$3,'user')",[target,f.workspaceId,f.owner,f.assistantId])
      content={source_kind:'memory',source_id:source.id,target_kind:'entity',target_id:target,edge_type:'mentioned',source:'user'}
    }else if(kind==='task')content={title:'Review source',created_by_user_id:f.owner}
    else if(kind==='workspace_file')content={path:'/review.txt',name:'review.txt',storage_uri:'fixture://review',created_by_user_id:f.owner}
    else if(kind==='episode')content={source_kind:'web',source_ref:{},occurred_at:new Date(),created_by_user_id:f.owner}
    else if(kind==='knowledge_entry')content={path:'review.md',title:'Review source',content:'Private review source'}
    else content={chunk_text:'Private review source',created_by_user_id:f.owner,source:'user'}
    const fields={...base,...visibility,...content},columns=Object.keys(fields)
    await pool.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(fields))
    const result=await f.apply(await f.preview([id],{resourceKind:kind}))
    expect(result.status).toBe('complete')
    const source=(await pool.query('SELECT read_scope_source($1,$2,$3) source',[f.workspaceId,kind,id])).rows[0].source
    expect(source).toMatchObject({sensitivity:'confidential',compartments:[f.target.compartmentKey],projectIds:[project]})
    if(kind!=='knowledge_entry')expect(source).toMatchObject({userId:f.owner,assistantId:f.assistantId})
  })
  it('rejects wrong/default wildcard targets, unsupported history/labels, holds, and non-admins; assign_team stays narrow',async()=>{
    const f=await fixture(),root=await f.create()
    await expect(f.preview([root.id],{targetTeamId:f.old.id})).rejects.toMatchObject({code:'scope_review_default_invalid'})
    await expect(f.preview([root.id],{resourceKind:'session_message'})).rejects.toMatchObject({code:'scope_review_action_unsupported'})
    await expect(f.preview([root.id],{action:'assign_team'})).rejects.toMatchObject({code:'scope_review_release_required'})
    await expect(execute(f.workspaceId,f.member,{type:'scope.review.preview',resourceKind:'memory',resourceIds:[root.id],action:'consolidate_default',targetTeamId:f.target.id,reason:'Denied'})).rejects.toMatchObject({code:'admin_required'})
    await pool.query('UPDATE workspace_groups SET read_all=true WHERE id=$1',[f.target.id])
    await expect(f.preview([root.id])).rejects.toMatchObject({code:'scope_review_default_invalid'})
    await pool.query('UPDATE workspace_groups SET read_all=false WHERE id=$1',[f.target.id])
    await pool.query('INSERT INTO workspace_group_compartment_grants(group_id,compartment_key) VALUES($1,$2)',[f.target.id,f.old.compartmentKey])
    await expect(f.preview([root.id])).rejects.toMatchObject({code:'scope_review_default_invalid'})
    await pool.query('DELETE FROM workspace_group_compartment_grants WHERE group_id=$1 AND compartment_key=$2',[f.target.id,f.old.compartmentKey])
    await pool.query("UPDATE memories SET compartments=ARRAY['unsupported'] WHERE id=$1",[root.id])
    await expect(f.preview([root.id])).rejects.toMatchObject({code:'scope_review_labels_unsupported'})
    await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[root.id])
    await expect(f.preview([root.id])).rejects.toMatchObject({code:'scope_review_release_required'})
  })
})
