import { createHash, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getPool, getAppPool } from '../../db/client.js'
import { createMemory } from '../../db/memories.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { executeWorkspaceScopeReview as execute, getWorkspaceScopeInventory as inventory, getWorkspaceScopeReview as review } from '../scope-review.js'
import { workspaceAccessRoutes } from '../../routes/workspace-access.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture() {
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID(),assistantId=randomUUID()
  for(const id of [owner,member])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Review fixture',$2)",[workspaceId,owner])
  for(const id of [owner,member])await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)',[workspaceId,id,id===owner?'owner':'member'])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind) VALUES($1,'Review assistant',$2,$3,'standard')",[assistantId,owner,workspaceId])
  const team=await createDbWorkspaceGroupStore().createTeam(owner,workspaceId,{name:'Research',key:'research'})
  const create=()=>createMemory({workspaceId,userId:owner,assistantId,createdByUserId:owner,summary:'Private fixture content',sensitivity:'confidential'})
  const preview=(ids:string[],action='confirm_general',resourceKind='memory')=>execute(workspaceId,owner,{type:'scope.review.preview',resourceKind,resourceIds:ids,action,targetTeamId:action==='assign_team'?team.id:null,reason:'Explicit classification review'})
  const apply=(job:{id:string;version:string;payloadHash:string})=>execute(workspaceId,owner,{type:'scope.review.apply',reviewId:job.id,expectedVersion:job.version,payloadHash:job.payloadHash})
  return {workspaceId,owner,member,assistantId,team,create,preview,apply}
}

describe('[COMP:api/workspace-scope-review] durable classification with real database guards',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  const derived=async(f:Awaited<ReturnType<typeof fixture>>,ids:string[])=>{
    const sources=[]
    for(const id of ids)sources.push((await pool.query('SELECT read_scope_source($1,\'memory\',$2) AS source',[f.workspaceId,id])).rows[0].source)
    return createMemory({workspaceId:f.workspaceId,userId:f.owner,assistantId:f.assistantId,createdByUserId:f.owner,summary:'Derived impact fixture',sensitivity:'confidential',derivation:{producer:'review-fixture',sources}})
  }
  it('freezes bounded content plus transitive and overlapping impact and applies the same reach',async()=>{
    const f=await fixture(),first=await f.create(),second=await f.create()
    const shared=await derived(f,[first.id,second.id]),leaf=await derived(f,[shared.id])
    const saved=await f.preview([first.id,second.id],'assign_team')
    for(const item of saved.items){
      expect(item.impact).toEqual({version:2,dependents:{},descendants:[shared,leaf].sort((a,b)=>a.id.localeCompare(b.id)).map(row=>({resourceKind:'memory',resourceId:row.id,version:row.scopeVersion,held:false}))})
      expect(item.content).toEqual(expect.objectContaining({title:expect.any(String),text:expect.any(String)}))
    }
    expect(saved.items.every(item=>item.content!.text.length<=12_000)).toBe(true)
    await expect(pool.query("UPDATE workspace_scope_review_items SET impact_snapshot='{}' WHERE review_id=$1",[saved.id])).rejects.toThrow('scope_review_proposal_immutable')
    expect((await f.apply(saved)).status).toBe('complete')
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=ANY($1::uuid[])',[[shared.id,leaf.id]])).rows).toEqual([{scope_held:true},{scope_held:true}])
  })
  it('includes predecessor-derived memories when reviewing a successor',async()=>{
    const f=await fixture(),original=await f.create(),output=await derived(f,[original.id]),successor=await f.create()
    await pool.query('UPDATE memories SET valid_to=now(),superseded_by=$2 WHERE id=$1',[original.id,successor.id])
    const saved=await f.preview([successor.id],'assign_team')
    expect(saved.items[0].impact?.descendants.map(row=>row.resourceId)).toEqual([output.id])
    await f.apply(saved)
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[output.id])).rows[0].scope_held).toBe(true)
  })
  it('refuses new derivations created after preview even without a source version or policy change',async()=>{
    const f=await fixture(),root=await f.create(),saved=await f.preview([root.id],'assign_team')
    await derived(f,[root.id])
    const result=await f.apply(saved)
    expect(result.status).toBe('stale')
    expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[root.id])).rows[0].compartments).toEqual([])
  })
  it('requires a new preview if a known descendant is unexpectedly held',async()=>{
    const f=await fixture(),root=await f.create(),output=await derived(f,[root.id]),saved=await f.preview([root.id],'assign_team')
    await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[output.id])
    expect((await f.apply(saved)).status).toBe('stale')
    expect((await pool.query('SELECT compartments FROM memories WHERE id=$1',[root.id])).rows[0].compartments).toEqual([])
  })
  it.each([1,2])('refuses more than 500 unique descendants across %s selected roots without creating a job',async(rootCount)=>{
    const f=await fixture(),roots:string[]=[]
    for(let i=0;i<rootCount;i++){
      const root=await f.create();roots.push(root.id)
      const outputs:string[]=[]
      for(let j=0;j<(rootCount===1?501:251);j++)outputs.push((await f.create()).id)
      const derivations=(await pool.query<{id:string}>(`INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,sensitivity,compartments,project_ids,source_policy_revision)
        SELECT workspace_id,'memory',id,scope_version::text,'impact-bound-fixture',user_id,assistant_id,sensitivity,compartments,project_ids,1 FROM memories WHERE id=ANY($1::uuid[]) RETURNING id`,[outputs])).rows.map(row=>row.id)
      await pool.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
        SELECT $1,id,'memory',$2,$3 FROM unnest($4::uuid[]) AS id`,[f.workspaceId,root.id,root.scopeVersion,derivations])
    }
    await expect(f.preview(roots,'assign_team')).rejects.toMatchObject({code:'scope_review_impact_too_large'})
    expect((await pool.query('SELECT id FROM workspace_scope_reviews WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(0)
  })
  it('accounts for shared descendants already held by an earlier page of the same job',async()=>{
    const f=await fixture(),ids:string[]=[]
    for(let i=0;i<26;i++)ids.push((await f.create()).id)
    const output=await derived(f,ids),saved=await f.preview(ids,'assign_team')
    const page=await f.apply(saved)
    expect(page.status).toBe('running')
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[output.id])).rows[0].scope_held).toBe(true)
    expect((await f.apply(page)).status).toBe('complete')
  })
  it('shows no invalidation for General confirmation or retaining a hold',async()=>{
    const f=await fixture(),root=await f.create();await derived(f,[root.id])
    expect((await f.preview([root.id])).items[0].impact).toEqual({version:2,dependents:{},descendants:[]})
    await f.apply(await f.preview([root.id],'hold'))
    expect((await f.preview([root.id],'hold')).items[0].impact).toEqual({version:2,dependents:{},descendants:[]})
  })
  it('keeps pre-impact jobs inspectable and cancellable while refusing apply',async()=>{
    const f=await fixture(),root=await f.create(),saved=await f.preview([root.id])
    const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value!==null&&typeof value==='object'?`{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`:JSON.stringify(value)
    const payloadHash=createHash('sha256').update(canonical({workspaceId:f.workspaceId,resourceKind:saved.resourceKind,action:saved.action,targetTeamId:null,targetCompartment:null,reason:saved.reason,selectionRevision:saved.selectionRevision,snapshots:saved.items.map(item=>item.source)})).digest('hex')
    const id=randomUUID()
    await pool.query(`INSERT INTO workspace_scope_reviews(id,workspace_id,created_by,resource_kind,action,reason,payload_hash,policy_revision,selection_revision)
      SELECT $2,workspace_id,created_by,resource_kind,action,reason,$3,policy_revision,selection_revision FROM workspace_scope_reviews WHERE id=$1`,[saved.id,id,payloadHash])
    await pool.query(`INSERT INTO workspace_scope_review_items(workspace_id,review_id,resource_kind,resource_id,resource_version,source_snapshot)
      SELECT workspace_id,$2,resource_kind,resource_id,resource_version,source_snapshot FROM workspace_scope_review_items WHERE review_id=$1`,[saved.id,id])
    const old=await review(f.workspaceId,f.owner,id)
    expect(old.items[0].impact).toBeNull()
    await expect(f.apply(old)).rejects.toMatchObject({code:'scope_review_impact_missing'})
    expect((await execute(f.workspaceId,f.owner,{type:'scope.review.cancel',reviewId:id,expectedVersion:old.version,payloadHash})).status).toBe('cancelled')
  })
  it.each(['root','descendant'])('blocks canonical %s validation during classification and refuses the stale derived write',async(kind)=>{
    const f=await fixture(),root=await f.create(),input=kind==='root'?root:await derived(f,[root.id]),saved=await f.preview([root.id],'assign_team')
    const source=(await pool.query('SELECT read_scope_source($1,\'memory\',$2) AS source',[f.workspaceId,input.id])).rows[0].source
    const client=await pool.connect(),originalQuery=client.query.bind(client)
    let reached!:()=>void,release!:()=>void
    const atWrite=new Promise<void>(resolve=>{reached=resolve}),resume=new Promise<void>(resolve=>{release=resolve})
    const querySpy=vi.spyOn(client,'query').mockImplementation((async(...args:unknown[])=>{
      if(typeof args[0]==='string'&&args[0].startsWith('UPDATE memories SET compartments=')){reached();await resume}
      return (originalQuery as (...args:unknown[])=>Promise<unknown>)(...args)
    }) as typeof client.query)
    const connectSpy=vi.spyOn(pool,'connect').mockImplementationOnce((()=>Promise.resolve(client)) as typeof pool.connect)
    const applying=f.apply(saved)
    let writing:Promise<unknown>|undefined
    try{
      await atWrite
      // Attach the rejection handler now, so the deliberate refusal cannot be
      // reported as an unhandled rejection while the first transaction commits.
      writing=createMemory({workspaceId:f.workspaceId,userId:f.owner,assistantId:f.assistantId,createdByUserId:f.owner,summary:'Concurrent derived fixture',sensitivity:'confidential',derivation:{producer:'review-fixture',sources:[source]}}).then(()=>({unexpectedSuccess:true}),error=>error)
      let blocked=false
      for(let i=0;i<100&&!blocked;i++){
        blocked=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT read_scope_source(%'")).rows.length>0
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(blocked).toBe(true)
      release();expect((await applying).status).toBe('complete')
      expect(await writing).toMatchObject({code:'scope_source_changed'})
    }finally{release();await applying.catch(()=>undefined);await writing;querySpy.mockRestore();connectSpy.mockRestore()}
  })
  it('rejects foreign and stale impact references at the database boundary',async()=>{
    const f=await fixture(),other=await fixture(),root=await f.create(),foreign=await other.create(),output=await derived(f,[root.id]),saved=await f.preview([root.id],'assign_team')
    for(const reference of [{resourceId:foreign.id,version:foreign.scopeVersion,held:false},{resourceId:output.id,version:'999',held:false},{resourceId:output.id,version:output.scopeVersion,held:true}]){
      const id=randomUUID()
      await pool.query(`INSERT INTO workspace_scope_reviews(id,workspace_id,created_by,resource_kind,action,target_team_id,target_compartment,reason,payload_hash,policy_revision,selection_revision)
        SELECT $2,workspace_id,created_by,resource_kind,action,target_team_id,target_compartment,reason,payload_hash,policy_revision,selection_revision FROM workspace_scope_reviews WHERE id=$1`,[saved.id,id])
      await expect(pool.query(`INSERT INTO workspace_scope_review_items(workspace_id,review_id,resource_kind,resource_id,resource_version,source_snapshot,impact_snapshot)
        SELECT workspace_id,$2,resource_kind,resource_id,resource_version,source_snapshot,$3::jsonb FROM workspace_scope_review_items WHERE review_id=$1`,[saved.id,id,JSON.stringify({version:1,descendants:[reference]})])).rejects.toThrow('scope_review_reference_invalid')
    }
  })
  it('preserves private visibility, clearance and content while explicitly confirming General',async()=>{
    const f=await fixture(),record=await f.create(),before=await inventory(f.workspaceId,f.owner)
    expect(before).toMatchObject({total:'1',completeCoverage:false})
    expect(before.items[0]?.content).toEqual({title:'memory',text:'Private fixture content'})
    const preview=await f.preview([record.id])
    expect(preview.status).toBe('preview')
    expect((await inventory(f.workspaceId,f.owner)).total).toBe('1')
    const applied=await f.apply(preview)
    expect(applied).toMatchObject({status:'complete',version:'2',completeCoverage:true})
    expect(applied.items[0]).toMatchObject({status:'applied',resultVersion:record.scopeVersion})
    expect((await inventory(f.workspaceId,f.owner)).total).toBe('0')
    expect((await pool.query('SELECT user_id,assistant_id,sensitivity,compartments,summary FROM memories WHERE id=$1',[record.id])).rows[0]).toEqual({user_id:f.owner,assistant_id:f.assistantId,sensitivity:'confidential',compartments:[],summary:'Private fixture content'})
    expect((await pool.query('SELECT classification_mode,reviewed_inventory_revision::text FROM workspace_access_policies WHERE workspace_id=$1',[f.workspaceId])).rows[0]).toEqual({classification_mode:'review',reviewed_inventory_revision:'2'})
  })
  it('resumes bounded pages and does not replay an old apply even under concurrent requests',async()=>{
    const f=await fixture(),ids:string[]=[]
    for(let i=0;i<26;i++)ids.push((await f.create()).id)
    const preview=await f.preview(ids)
    const results=await Promise.all([f.apply(preview),f.apply(preview)])
    for(const result of results){expect(result.status).toBe('running');expect(result.items.filter(i=>i.status==='applied')).toHaveLength(25)}
    expect((await pool.query("SELECT count(*)::int n FROM workspace_access_events WHERE workspace_id=$1 AND kind='scope.review.apply'",[f.workspaceId])).rows[0].n).toBe(1)
    const loaded=await review(f.workspaceId,f.owner,preview.id)
    expect((await f.apply(loaded)).status).toBe('complete')
    expect((await f.apply(preview)).status).toBe('complete')
    expect((await inventory(f.workspaceId,f.owner)).total).toBe('0')
  })
  it('cancels pending work without rolling back a committed page and exposes resumable jobs',async()=>{
    const f=await fixture(),ids:string[]=[]
    for(let i=0;i<26;i++)ids.push((await f.create()).id)
    const running=await f.apply(await f.preview(ids))
    const projection=await inventory(f.workspaceId,f.owner,'memory',undefined,running.id)
    expect(projection.recentReviews.map(r=>r.id)).toContain(running.id)
    expect(projection.selectedReview?.version).toBe(running.version)
    const cancelled=await execute(f.workspaceId,f.owner,{type:'scope.review.cancel',reviewId:running.id,expectedVersion:running.version,payloadHash:running.payloadHash})
    expect(cancelled.status).toBe('cancelled');expect(cancelled.items.filter(i=>i.status==='applied')).toHaveLength(25)
    expect(cancelled.items.filter(i=>i.status==='cancelled')).toHaveLength(1)
    expect((await f.apply(cancelled)).status).toBe('cancelled')
    expect((await inventory(f.workspaceId,f.owner)).total).toBe('1')
  })
  it('pages tied history without omissions when new jobs arrive or an old job changes status',async()=>{
    const f=await fixture(),record=await f.create(),saved=await f.preview([record.id]);
    // Frozen copies share a timestamp to exercise the UUID tie-breaker.
    await pool.query(`INSERT INTO workspace_scope_reviews(workspace_id,created_by,resource_kind,action,reason,payload_hash,policy_revision,selection_revision,created_at)
      SELECT workspace_id,created_by,resource_kind,action,reason,payload_hash,policy_revision,selection_revision,created_at
      FROM workspace_scope_reviews CROSS JOIN generate_series(1,40) WHERE id=$1`,[saved.id]);
    const expected=(await pool.query<{id:string}>('SELECT id FROM workspace_scope_reviews WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC',[f.workspaceId])).rows.map(r=>r.id);
    const first=await inventory(f.workspaceId,f.owner);
    expect(first.recentReviews.map(r=>r.id)).toEqual(expected.slice(0,20));
    expect(first.nextReviewCursor).toBe(expected[19]);
    const added=await f.preview([record.id]);
    await execute(f.workspaceId,f.owner,{type:'scope.review.cancel',reviewId:saved.id,expectedVersion:saved.version,payloadHash:saved.payloadHash});
    const second=await inventory(f.workspaceId,f.owner,'memory',undefined,added.id,first.nextReviewCursor!);
    expect(second.recentReviews.map(r=>r.id)).toEqual(expected.slice(20,40));
    expect(second.selectedReview?.id).toBe(added.id);
    const last=await inventory(f.workspaceId,f.owner,'memory',undefined,undefined,second.nextReviewCursor!);
    expect(last.recentReviews.map(r=>r.id)).toEqual(expected.slice(40));
    expect(last.nextReviewCursor).toBeNull();
    expect((await inventory(f.workspaceId,f.owner)).recentReviews[0].id).toBe(added.id);
    await expect(pool.query("UPDATE workspace_scope_reviews SET created_at=created_at+interval '1 day' WHERE id=$1",[saved.id])).rejects.toThrow('scope_review_anchor_immutable');
    await expect(pool.query('UPDATE workspace_scope_reviews SET id=$2 WHERE id=$1',[saved.id,randomUUID()])).rejects.toThrow('scope_review_anchor_immutable');
  })
  it('rejects foreign, missing and malformed history cursors and rechecks administrator access',async()=>{
    const f=await fixture(),other=await fixture(),record=await other.create(),foreign=await other.preview([record.id]);
    for(const anchor of [foreign.id,randomUUID()])await expect(inventory(f.workspaceId,f.owner,'memory',undefined,undefined,anchor)).rejects.toMatchObject({code:'not_found'});
    await expect(inventory(f.workspaceId,f.owner,'memory',undefined,undefined,'invalid')).rejects.toMatchObject({code:'invalid_command'});
    await expect(inventory(other.workspaceId,other.member,'memory',undefined,undefined,foreign.id)).rejects.toMatchObject({code:'admin_required'});
  })
  it.each([
    ['entity','entities'],['entity_link','entity_links'],['task','tasks'],
    ['workspace_file','workspace_files'],['episode','episodes'],
    ['knowledge_entry','knowledge_entries'],['kb_chunk','kb_chunks'],
  ])('assigns a Team to canonical %s without changing its other protections',async(kind,table)=>{
    const f=await fixture(),id=randomUUID(),project=randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[project,f.workspaceId,f.owner])
    const base={id,workspace_id:f.workspaceId,sensitivity:'confidential',compartments:[],project_ids:[project]}
    const visibility=kind==='knowledge_entry'?{}:{user_id:f.owner,assistant_id:f.assistantId}
    let content:Record<string,unknown>
    if(kind==='entity')content={kind:'project',display_name:'Review source',created_by_user_id:f.owner,source:'user'}
    else if(kind==='entity_link'){
      const source=await f.create(),target=randomUUID()
      await pool.query("INSERT INTO entities(id,kind,display_name,workspace_id,user_id,assistant_id,created_by_user_id,source) VALUES($1,'project','Linked fixture',$2,$3,$4,$3,'user')",[target,f.workspaceId,f.owner,f.assistantId])
      content={source_kind:'memory',source_id:source.id,target_kind:'entity',target_id:target,edge_type:'mentioned',source:'user'}
    }else if(kind==='task')content={title:'Review source',created_by_user_id:f.owner}
    else if(kind==='workspace_file')content={path:'/review.txt',name:'review.txt',storage_uri:'fixture://review',created_by_user_id:f.owner}
    else if(kind==='episode')content={source_kind:'web',source_ref:{},occurred_at:new Date(),created_by_user_id:f.owner}
    else if(kind==='knowledge_entry')content={path:'review.md',title:'Review source',content:'Private review source'}
    else content={chunk_text:'Private review source',created_by_user_id:f.owner,source:'user'}
    const fields={...base,...visibility,...content},columns=Object.keys(fields)
    await pool.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(fields))
    expect((await inventory(f.workspaceId,f.owner,kind)).items.find(r=>r.id===id)).toMatchObject({
      canClassify:true,sensitivity:'confidential',projectIds:[project],
      content:{title:expect.any(String),text:expect.any(String)},
    })
    const result=await f.apply(await f.preview([id],'assign_team',kind))
    expect(result.status).toBe('complete')
    const source=(await pool.query('SELECT read_scope_source($1,$2,$3) source',[f.workspaceId,kind,id])).rows[0].source
    expect(source).toMatchObject({sensitivity:'confidential',compartments:[f.team.compartmentKey],projectIds:[project]})
    if(kind!=='knowledge_entry')expect(source).toMatchObject({userId:f.owner,assistantId:f.assistantId})
    expect((await inventory(f.workspaceId,f.owner,kind)).items.map(r=>r.id)).not.toContain(id)
  })
  it('inspects and holds every frozen immutable evidence family',async()=>{
    const f=await fixture(),memory=await f.create(),entityId=randomUUID(),sessionId=randomUUID(),skillId=randomUUID()
    await pool.query("INSERT INTO entities(id,kind,display_name,workspace_id,user_id,assistant_id,created_by_user_id,source) VALUES($1,'person','Evidence target',$2,$3,$4,$3,'user')",[entityId,f.workspaceId,f.owner,f.assistantId])
    const crm=(await pool.query<{id:string}>(`INSERT INTO crm_domain_event_outbox(workspace_id,event_type,event_key,subject_kind,subject_id,payload,actor_kind)
      VALUES($1,'crm.submission.received',$2,'contact',$3,$4::jsonb,'user') RETURNING id`,[f.workspaceId,randomUUID(),entityId,JSON.stringify({body:'immutable-evidence-token'})])).rows[0].id
    const memoryVerification=(await pool.query<{id:string}>("INSERT INTO memory_verifications(workspace_id,memory_id,verified_by,action,user_value,reason) VALUES($1,$2,$3,'edit_summary',$4::jsonb,'immutable-evidence-token') RETURNING id",[f.workspaceId,memory.id,f.owner,JSON.stringify('immutable-evidence-token')])).rows[0].id
    const brainVerification=(await pool.query<{id:string}>("INSERT INTO brain_verifications(workspace_id,target_kind,target_id,verified_by,action,user_value,reason) VALUES($1,'entity',$2,$3,'edit_summary',$4::jsonb,'immutable-evidence-token') RETURNING id",[f.workspaceId,entityId,f.owner,JSON.stringify('immutable-evidence-token')])).rows[0].id
    const correction=(await pool.query<{id:string}>("INSERT INTO correction_audit(workspace_id,action,primitive,row_id,actor_user_id,reason,row_snapshot) VALUES($1,'retract','memory',$2,$3,'immutable-evidence-token',$4::jsonb) RETURNING id",[f.workspaceId,memory.id,f.owner,JSON.stringify({body:'immutable-evidence-token'})])).rows[0].id
    await pool.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id,effective_clearance) VALUES($1,$2,$3,'web',$5,$4,'confidential')",[sessionId,f.assistantId,f.owner,f.workspaceId,sessionId])
    const message=(await pool.query<{id:string}>(`INSERT INTO session_messages(session_id,role,content,sequence_num,sender_user_id,workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
      VALUES($1,'user',$2::jsonb,1,$3,$4,$3,$5,'confidential','{}','{}',1,false) RETURNING id`,[sessionId,JSON.stringify([{type:'text',text:'immutable-evidence-token'}]),f.owner,f.workspaceId,f.assistantId])).rows[0].id
    const feedback=(await pool.query<{id:string}>(`INSERT INTO analytics_events(user_id,assistant_id,session_id,event_name,metadata,workspace_id,sensitivity,compartments,project_ids,scope_version,scope_held)
      VALUES($1,$2,$3,'feedback_negative',$4::jsonb,$5,'confidential','{}','{}',1,false) RETURNING id`,[f.owner,f.assistantId,sessionId,JSON.stringify({body:'immutable-evidence-token'}),f.workspaceId])).rows[0].id
    await pool.query("INSERT INTO workspace_skills(id,slug,name,description,content,workspace_id) VALUES($1,$2,'Evidence skill','Fixture','immutable-evidence-token',$3)",[skillId,`evidence-${skillId}`,f.workspaceId])
    const skillRevision=(await pool.query<{id:string}>(`INSERT INTO workspace_skill_scope_revisions(workspace_id,skill_id,revision,user_id,assistant_id,sensitivity,compartments,project_ids)
      VALUES($1,$2,1,$3,$4,'confidential','{}','{}') RETURNING id`,[f.workspaceId,skillId,f.owner,f.assistantId])).rows[0].id
    await pool.query('UPDATE workspace_skills SET scope_revision_id=$2 WHERE id=$1',[skillId,skillRevision])
    const cases=[
      ['crm_event','crm_domain_event_outbox',crm],['memory_verification','memory_verifications',memoryVerification],
      ['brain_verification','brain_verifications',brainVerification],['correction_audit','correction_audit',correction],
      ['session_message','session_messages',message],['feedback_event','analytics_events',feedback],
      ['workspace_skill_revision','workspace_skill_scope_revisions',skillRevision],
    ] as const
    for(const [kind,,id] of cases){
      const item=(await inventory(f.workspaceId,f.owner,kind)).items.find(row=>row.id===id)
      expect(item).toMatchObject({allowedActions:['hold'],content:{title:expect.any(String),text:expect.stringContaining('immutable-evidence-token')}})
      expect((await f.apply(await f.preview([id],'hold',kind))).status).toBe('complete')
      expect((await pool.query('SELECT read_scope_review_source($1,$2,$3) source',[f.workspaceId,kind,id])).rows[0].source).toMatchObject({held:true})
    }
    const client=await getAppPool().connect()
    try{
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.system_bypass','false',true)",[f.owner])
      for(const [,table,id] of cases)expect((await client.query(`SELECT id FROM ${table} WHERE id=$1`,[id])).rows).toEqual([])
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('inspects every frozen cache/index impact and makes a hold effective at RLS',async()=>{
    const f=await fixture(),sessionId=randomUUID(),fileId=randomUUID(),recordingId=randomUUID(),typeId=randomUUID()
    await pool.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id,effective_clearance) VALUES($1,$2,$3,'web',$5,$4,'confidential')",[sessionId,f.assistantId,f.owner,f.workspaceId,sessionId])
    const fileCache=(await pool.query<{id:string}>(`INSERT INTO file_cache(session_id,file_name,mime_type,content,size_bytes,expires_at,workspace_id,user_id,assistant_id,sensitivity)
      VALUES($1,'impact.txt','text/plain','cache-impact-token',18,now()+interval '1 day',$2,$3,$4,'confidential') RETURNING id`,[sessionId,f.workspaceId,f.owner,f.assistantId])).rows[0].id
    await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,user_id,assistant_id,sensitivity) VALUES($1,$2,'/impact.txt','impact.txt','fixture://impact',$3,$3,$4,'confidential')",[fileId,f.workspaceId,f.owner,f.assistantId])
    const fileSegment=(await pool.query<{id:string}>(`INSERT INTO file_segments(workspace_id,file_id,segment_index,char_start,char_end,content,created_by_user_id,user_id,assistant_id,sensitivity)
      VALUES($1,$2,0,0,17,'segment-impact-token',$3,$3,$4,'confidential') RETURNING id`,[f.workspaceId,fileId,f.owner,f.assistantId])).rows[0].id
    await pool.query("INSERT INTO episodes(id,workspace_id,created_by_user_id,user_id,assistant_id,source_kind,source_ref,occurred_at,sensitivity) VALUES($1,$2,$3,$3,$4,'recording','{}',now(),'confidential')",[recordingId,f.workspaceId,f.owner,f.assistantId])
    await pool.query("INSERT INTO recordings(id,workspace_id,title,mime,gcs_key,user_id,assistant_id,sensitivity,created_by_user_id) VALUES($1,$2,'recording-impact-token','audio/wav','fixture-impact',$3,$4,'confidential',$3)",[recordingId,f.workspaceId,f.owner,f.assistantId])
    const transcript=(await pool.query<{id:string}>(`INSERT INTO transcript_segments(workspace_id,recording_id,segment_index,start_ms,end_ms,segment_text,user_id,assistant_id,sensitivity,created_by_user_id)
      VALUES($1,$2,0,0,1000,'transcript-impact-token',$3,$4,'confidential',$3) RETURNING id`,[f.workspaceId,recordingId,f.owner,f.assistantId])).rows[0].id
    await pool.query("INSERT INTO entity_types(id,workspace_id,name,properties,created_by) VALUES($1,$2,'Impact type',$3::jsonb,$4)",[typeId,f.workspaceId,JSON.stringify([{name:'title',label:'Title',config:{kind:'text'},required:true}]),f.owner])
    const entityInstance=(await pool.query<{id:string}>("INSERT INTO entity_instances(entity_type_id,workspace_id,data,created_by,user_id,assistant_id,sensitivity) VALUES($1,$2,$3::jsonb,$4,$4,$5,'confidential') RETURNING id",[typeId,f.workspaceId,JSON.stringify({title:{kind:'text',value:'entity-impact-token'}}),f.owner,f.assistantId])).rows[0].id
    const blueprint=(await pool.query<{id:string}>(`INSERT INTO blueprint_records(workspace_id,spec_snapshot,subject,anchor_key,fields,source_kind,source_id,sensitivity,created_by)
      VALUES($1,'{}','Blueprint impact',$2,$3::jsonb,'brain','fixture','confidential',$4) RETURNING id`,[f.workspaceId,`impact-${randomUUID()}`,JSON.stringify({body:'blueprint-impact-token'}),f.owner])).rows[0].id
    const office=(await pool.query<{id:string}>(`INSERT INTO office_artifacts(workspace_id,family,title,creator_user_id,owner_user_id,capability_version,sensitivity,visibility_user_ids)
      VALUES($1,'document','office-impact-token',$2,$2,1,'confidential',ARRAY[$2]::uuid[]) RETURNING id`,[f.workspaceId,f.owner])).rows[0].id
    const cases=[
      ['file_cache','file_cache',fileCache,'cache-impact-token'],['file_segment','file_segments',fileSegment,'segment-impact-token'],
      ['recording','recordings',recordingId,'recording-impact-token'],['transcript_segment','transcript_segments',transcript,'transcript-impact-token'],
      ['entity_instance','entity_instances',entityInstance,'entity-impact-token'],['blueprint_record','blueprint_records',blueprint,'blueprint-impact-token'],
      ['office_artifact','office_artifacts',office,'office-impact-token'],
    ] as const
    for(const [kind,,id,token] of cases){
      const item=(await inventory(f.workspaceId,f.owner,kind)).items.find(row=>row.id===id)
      expect(item).toMatchObject({allowedActions:['confirm_general','hold'],content:{title:expect.any(String),text:expect.stringContaining(token)}})
      expect((await f.apply(await f.preview([id],'hold',kind))).status).toBe('complete')
      expect((await pool.query('SELECT read_scope_review_source($1,$2,$3) source',[f.workspaceId,kind,id])).rows[0].source).toMatchObject({held:true})
    }
    const client=await getAppPool().connect()
    try{
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.system_bypass','false',true)",[f.owner])
      for(const [,table,id] of cases)expect((await client.query(`SELECT id FROM ${table} WHERE id=$1`,[id])).rows).toEqual([])
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('uses the canonical service from authenticated HTTP and rejects anonymous/member review access',async()=>{
    const f=await fixture(),record=await f.create()
    const appFor=(id?:string)=>{const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=id;next()});app.use('/api',workspaceAccessRoutes());return app}
    const anonymous=await request(appFor()).get(`/api/workspaces/${f.workspaceId}/scope-review`)
    expect({status:anonymous.status,body:anonymous.body}).toEqual({status:401,body:{error:'unauthorized'}})
    await request(appFor(f.member)).get(`/api/workspaces/${f.workspaceId}/scope-review`).expect(403)
    const app=appFor(f.owner),root=`/api/workspaces/${f.workspaceId}`
    const preview=await request(app).post(`${root}/access/commands`).send({type:'scope.review.preview',resourceKind:'memory',resourceIds:[record.id],action:'confirm_general',targetTeamId:null,reason:'HTTP review'}).expect(200)
    const projection=await request(app).get(`${root}/scope-review?reviewId=${preview.body.id}`).expect(200)
    expect(projection.headers['cache-control']).toBe('no-store')
    expect(projection.body.selectedReview.id).toBe(preview.body.id)
    const older=await request(app).get(`${root}/scope-review?reviewAfter=${preview.body.id}`).expect(200)
    expect(older.body.recentReviews).toEqual([]);expect(older.body.nextReviewCursor).toBeNull()
    await request(app).get(`${root}/scope-review?reviewAfter=invalid`).expect(400)
    expect((await request(app).post(`${root}/access/commands`).send({type:'scope.review.apply',reviewId:preview.body.id,expectedVersion:preview.body.version,payloadHash:preview.body.payloadHash}).expect(200)).body.status).toBe('complete')
  })
  it.each(['content','delete','policy'])('invalidates pending review after a %s change without classifying it',async(change)=>{
    const f=await fixture(),record=await f.create(),preview=await f.preview([record.id],'assign_team')
    if(change==='content')await pool.query("UPDATE memories SET summary='Changed after preview' WHERE id=$1",[record.id])
    else if(change==='delete')await pool.query('DELETE FROM memories WHERE id=$1',[record.id])
    else await pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1',[f.workspaceId])
    const applied=await f.apply(preview)
    expect(applied.status).toBe('stale');expect(applied.items[0].status).toBe('stale')
    expect((await pool.query('SELECT 1 FROM scope_resource_states WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
  })
  it('retains committed pages when a remaining source changes',async()=>{
    const f=await fixture(),ids:string[]=[]
    for(let i=0;i<26;i++)ids.push((await f.create()).id)
    const running=await f.apply(await f.preview(ids)),pending=running.items.find(i=>i.status==='pending')!
    await pool.query("UPDATE memories SET summary='Changed remaining item' WHERE id=$1",[pending.resourceId])
    const stale=await f.apply(running)
    expect(stale.status).toBe('stale');expect(stale.items.filter(i=>i.status==='applied')).toHaveLength(25)
    expect(stale.items.filter(i=>i.status==='stale')).toHaveLength(1)
  })
  it('holds known descendants and refuses to release an existing hold through General or Team actions',async()=>{
    const f=await fixture(),record=await f.create()
    const snapshot=(await pool.query('SELECT read_scope_source($1,$2,$3) source',[f.workspaceId,'memory',record.id])).rows[0].source
    const derived=await createMemory({workspaceId:f.workspaceId,userId:f.owner,assistantId:f.assistantId,createdByUserId:f.owner,summary:'Derived fixture',sensitivity:'confidential',derivation:{producer:'review-fixture',sources:[snapshot]}})
    await f.apply(await f.preview([record.id],'hold'))
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=ANY($1::uuid[])',[[record.id,derived.id]])).rows).toEqual([{scope_held:true},{scope_held:true}])
    for(const action of ['confirm_general','assign_team'])await expect(f.preview([record.id],action)).rejects.toMatchObject({code:'scope_review_release_required'})
    expect((await inventory(f.workspaceId,f.owner)).total).toBe('2')
  })
  it('does not certify a selected descendant invalidated by an earlier item in the same page',async()=>{
    const f=await fixture(),record=await f.create()
    // Stable order makes the ancestor apply before its selected descendant.
    const first='00000000-0000-4000-8000-000000000001'
    await pool.query('UPDATE memories SET id=$2 WHERE id=$1',[record.id,first])
    const snapshot=(await pool.query('SELECT read_scope_source($1,$2,$3) source',[f.workspaceId,'memory',first])).rows[0].source
    const derived=await createMemory({workspaceId:f.workspaceId,userId:f.owner,assistantId:f.assistantId,createdByUserId:f.owner,summary:'Selected descendant',sensitivity:'confidential',derivation:{producer:'review-fixture',sources:[snapshot]}})
    const result=await f.apply(await f.preview([first,derived.id],'assign_team'))
    expect(result.status).toBe('stale')
    expect(result.items.map(i=>i.status)).toEqual(['applied','stale'])
    expect((await pool.query('SELECT scope_held,compartments FROM memories WHERE id=$1',[derived.id])).rows[0]).toEqual({scope_held:true,compartments:[]})
  })
  it('rechecks current administrator membership for inventory, progress and apply',async()=>{
    const f=await fixture(),record=await f.create(),preview=await f.preview([record.id])
    await expect(inventory(f.workspaceId,f.member)).rejects.toMatchObject({code:'admin_required'})
    await expect(review(f.workspaceId,f.member,preview.id)).rejects.toMatchObject({code:'admin_required'})
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.owner])
    await expect(f.apply(preview)).rejects.toMatchObject({code:'admin_required'})
    expect((await pool.query('SELECT status FROM workspace_scope_reviews WHERE id=$1',[preview.id])).rows[0].status).toBe('preview')
  })
  it('refuses cross-workspace IDs, duplicate selections, proposal mutation and incorrect confirmation hashes',async()=>{
    const f=await fixture(),foreign=await fixture(),record=await f.create(),other=await foreign.create()
    await expect(f.preview([other.id])).rejects.toMatchObject({code:'scope_review_selection_unavailable'})
    await expect(f.preview([record.id,record.id.toUpperCase()])).rejects.toMatchObject({code:'invalid_command'})
    const preview=await f.preview([record.id])
    await expect(f.apply({...preview,payloadHash:'f'.repeat(64)})).rejects.toMatchObject({code:'scope_review_changed'})
    await expect(pool.query("UPDATE workspace_scope_reviews SET reason='Changed' WHERE id=$1",[preview.id])).rejects.toThrow('scope_review_proposal_immutable')
    await expect(pool.query("UPDATE workspace_scope_review_items SET source_snapshot='{}' WHERE review_id=$1",[preview.id])).rejects.toThrow('scope_review_proposal_immutable')
    expect((await review(f.workspaceId,f.owner,preview.id)).status).toBe('preview')
  })
  it('protects review metadata and writes through the real application database role',async()=>{
    const f=await fixture(),preview=await f.preview([(await f.create()).id]),client=await getAppPool().connect()
    try{
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.system_bypass','false',true)",[f.member])
      for(const table of ['workspace_scope_reviews','workspace_scope_review_items'])expect((await client.query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows).toEqual([])
      await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.owner])
      expect((await client.query('SELECT id FROM workspace_scope_reviews WHERE id=$1',[preview.id])).rows).toHaveLength(1)
      expect((await client.query("UPDATE workspace_scope_reviews SET status='complete' WHERE id=$1 RETURNING id",[preview.id])).rows).toEqual([])
    }finally{await client.query('ROLLBACK');client.release()}
  })
})
