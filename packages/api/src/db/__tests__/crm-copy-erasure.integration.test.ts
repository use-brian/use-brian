import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import type {CrmOperationsContext,CrmErasurePreview} from '@use-brian/core'
import {getPool} from '../client.js'
import {createSoftDeleteStore} from '../soft-delete-store.js'
import {createCrmPrivacyService} from '../../crm-operations/privacy-previews.js'
import {streamCrmPrivacyExport} from '../../crm-operations/privacy-export.js'
import {acquireCrmPrivacyAdmission} from '../../crm-operations/privacy-admission.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),privacy=createCrmPrivacyService()
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID(),otherId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Copy fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source)
    VALUES($1,$3,'person','Subject fixture','subject@example.com',$4,'manual'),($2,$3,'person','Other fixture','other@example.com',$4,'manual')`,[contactId,otherId,workspaceId,userId])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}}
  const preview=()=>privacy.preview(context,{kind:'preview_contact_erasure',contactId})
  const erase=(p:CrmErasurePreview)=>privacy.erase(context,{kind:'erase_contact_with_preview',contactId,previewId:p.id,previewHash:p.previewHash,confirmed:true})
  const legacy=async()=>{const repo=createSoftDeleteStore();await repo.applyHardPurge({primitive:'contact',workspaceId,rowId:contactId,actorUserId:userId,reason:'Synthetic privacy request',ticketReference:null,snapshot:(await repo.readForSoftDelete('contact',workspaceId,contactId))!,now:new Date()})}
  const task=async(attributes:Record<string,unknown>={crm_contact_id:contactId},parentId:string|null=null)=>{
    const id=randomUUID();await pool.query("INSERT INTO tasks(id,workspace_id,title,user_id,attributes,parent_id) VALUES($1,$2,'Private task copy',$3,$4,$5)",[id,workspaceId,userId,JSON.stringify(attributes),parentId]);return id
  }
  const draft=async(to:(string|null)[]=['subject@example.com'])=>{
    const id=randomUUID();await pool.query("INSERT INTO crm_email_drafts(id,workspace_id,to_addresses,body) VALUES($1,$2,$3,'Private draft copy')",[id,workspaceId,to]);return id
  }
  return {workspaceId,userId,contactId,otherId,context,preview,erase,legacy,task,draft}
}
async function version(workspaceId:string,draftId:string,revision:number,recipients:(string|null)[]) {
  await pool.query("INSERT INTO crm_email_draft_versions(workspace_id,draft_id,revision,to_addresses,body) VALUES($1,$2,$3,$4,'Private historical draft')",[workspaceId,draftId,revision,recipients])
}
async function link(workspaceId:string,userId:string,sourceKind:string,sourceId:string,targetKind:string,targetId:string) {
  await pool.query("INSERT INTO entity_link_types(edge_type,description) VALUES('copy_fixture','Copy fixture edge') ON CONFLICT DO NOTHING")
  await pool.query("INSERT INTO entity_links(workspace_id,source_kind,source_id,target_kind,target_id,edge_type,source,user_id) VALUES($1,$2,$3,$4,$5,'copy_fixture','manual',$6)",[workspaceId,sourceKind,sourceId,targetKind,targetId,userId])
}
async function exported(context:CrmOperationsContext,contactId?:string) {
  const records:Record<string,Record<string,unknown>[]>={}
  for await(const line of streamCrmPrivacyExport(context,{contactId})) {const row=JSON.parse(line);if(row.type==='record')(records[row.domain]??=[]).push(row.record)}
  return records
}

describe('[COMP:crm/privacy-copies] Canonical draft and task copy erasure',()=>{
  afterAll(async()=>{await pool.end()})
  it('reviews the entire historical draft family and deletes revisions and anchors atomically',async()=>{
    const f=await fixture(),draft=await f.draft([]),unrelated=await f.draft(['other@example.com'])
    for(let n=1;n<=108;n++)await version(f.workspaceId,draft,n,n===1?['subject@example.com']:[])
    const assistantId=randomUUID(),sessionId=randomUUID()
    await pool.query("INSERT INTO assistants(id,name,workspace_id,kind,owner_user_id) VALUES($1,'Fixture assistant',$2,'primary',$3)",[assistantId,f.workspaceId,f.userId])
    await pool.query("INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id) VALUES($1,$2,$3,$4,'web','fixture')",[sessionId,assistantId,f.userId,f.workspaceId])
    await pool.query('INSERT INTO crm_email_draft_session_anchors(session_id,workspace_id,draft_id) VALUES($1,$2,$3)',[sessionId,f.workspaceId,draft])
    const review=await f.preview()
    expect(review.status).toBe('ready')
    expect(review.domains).toContainEqual({domain:'crm_email_drafts',action:'delete',count:1})
    expect(review.domains).toContainEqual({domain:'crm_email_draft_versions',action:'delete',count:108})
    const exportedDrafts=await exported(f.context,f.contactId)
    expect(exportedDrafts.crm_email_draft_versions).toHaveLength(108)
    expect(exportedDrafts.crm_email_drafts[0].body).toBeNull()
    expect(exportedDrafts.crm_email_draft_versions.filter(v=>Array.isArray(v.to_addresses)&&v.to_addresses.length===0).every(v=>v.body===null)).toBe(true)
    await f.erase(review)
    expect((await pool.query('SELECT id FROM crm_email_draft_versions WHERE draft_id=$1',[draft])).rowCount).toBe(0)
    expect((await pool.query('SELECT session_id FROM crm_email_draft_session_anchors WHERE draft_id=$1',[draft])).rowCount).toBe(0)
    expect((await pool.query('SELECT id FROM crm_email_drafts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{id:unrelated}])
  })
  it.each([{recipients:['other@example.com']},{recipients:[null]}])('blocks a shared or ambiguous historical recipient $recipients without modifying copies',async ({recipients})=>{
    const f=await fixture(),draft=await f.draft();await version(f.workspaceId,draft,1,recipients)
    const review=await f.preview()
    expect(review.blockers).toContainEqual({domain:'crm_email_drafts',reason:'shared_or_ambiguous_draft',count:1})
    await expect(f.erase(review)).rejects.toMatchObject({details:{reason:'privacy_preview_blocked'}})
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
    expect((await pool.query('SELECT body FROM crm_email_drafts WHERE id=$1',[draft])).rows[0].body).toBe('Private draft copy')
    expect((await exported(f.context,f.contactId)).crm_email_draft_versions[0].body).toBeNull()
  })
  it('blocks ambiguous recipient ownership when another contact shares the address',async()=>{
    const f=await fixture(),draft=await f.draft();await version(f.workspaceId,draft,1,['subject@example.com'])
    const review=await f.preview();expect(review.status).toBe('ready')
    await pool.query("UPDATE entities SET attributes=jsonb_build_object('email','subject@example.com') WHERE id=$1",[f.otherId])
    await expect(f.erase(review)).rejects.toMatchObject({details:{reason:'privacy_preview_stale'}})
    const blocked=await f.preview();expect(blocked.blockers).toContainEqual({domain:'crm_email_drafts',reason:'shared_or_ambiguous_draft',count:1})
    const result=await exported(f.context,f.contactId)
    expect(result.crm_email_drafts[0].body).toBeNull();expect(result.crm_email_draft_versions[0].body).toBeNull()
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
    expect((await pool.query('SELECT id FROM crm_email_drafts WHERE id=$1',[draft])).rowCount).toBe(1)
  })
  it('captures task descendants and supersession cycles, clears their history, and preserves unrelated tasks',async()=>{
    const f=await fixture(),root=await f.task(),unrelated=await f.task({}),other=await fixture(),otherTask=await other.task()
    const previous=await f.task({}),child=await f.task({},root)
    await pool.query('UPDATE tasks SET superseded_by=$2 WHERE id=$1',[root,previous]);await pool.query('UPDATE tasks SET superseded_by=$2 WHERE id=$1',[previous,root])
    await pool.query(`INSERT INTO tasks(workspace_id,title,user_id,parent_id) SELECT $1,'Private descendant '||n,$2,$3 FROM generate_series(1,106) n`,[f.workspaceId,f.userId,child])
    await link(f.workspaceId,f.userId,'task',root,'entity',f.contactId)
    await pool.query(`INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor,mutation_reason)
      VALUES('task',$1,1,'{"title":"Private before-image"}',now()-interval '1 minute',now(),'human_edit','Private history reason')`,[previous])
    await pool.query(`INSERT INTO correction_audit(workspace_id,action,primitive,row_id,reason,row_snapshot)
      VALUES($1,'soft_delete','task',$2,'Private correction reason','{"title":"Private correction snapshot"}')`,[f.workspaceId,child])
    const review=await f.preview();expect(review.status).toBe('ready')
    expect(review.domains).toContainEqual({domain:'tasks',action:'delete',count:109})
    const before=await exported(f.context,f.contactId);expect(before.tasks).toHaveLength(109)
    const workspace=await exported(f.context);expect(workspace.tasks).toHaveLength(109)
    expect(workspace.tasks.some(t=>t.id===unrelated)).toBe(false)
    await f.erase(review)
    expect((await pool.query('SELECT id FROM tasks WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{id:unrelated}])
    expect((await pool.query('SELECT id FROM tasks WHERE id=$1',[otherTask])).rowCount).toBe(1)
    expect((await pool.query('SELECT id FROM entity_links WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
    const history=(await pool.query('SELECT * FROM brain_row_versions WHERE row_id=$1',[previous])).rows[0]
    expect(history).toMatchObject({workspace_id:f.workspaceId,before_image:null,mutation_reason:'Personal data erased'})
    expect(history.erased_at).toBeInstanceOf(Date)
    const audit=(await pool.query('SELECT * FROM correction_audit WHERE workspace_id=$1 AND row_id=$2',[f.workspaceId,child])).rows[0]
    expect(audit).toMatchObject({reason:'Personal data erased',row_snapshot:{erased:true},detail:{erased:true}})
  })
  it('requires independent ownership for tasks whose submission was removed',async()=>{
    const f=await fixture(),root=await f.task({crm_submission_id:randomUUID()})
    await link(f.workspaceId,f.userId,'task',root,'entity',f.contactId)
    const blocked=await f.preview();expect(blocked.blockers).toContainEqual({domain:'tasks',reason:'shared_or_unresolved_task',count:1})
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
    await pool.query("UPDATE tasks SET attributes=attributes||jsonb_build_object('crm_contact_id',$2::text) WHERE id=$1",[root,f.contactId])
    const ready=await f.preview();expect(ready.status).toBe('ready');await f.erase(ready)
    expect((await pool.query('SELECT id FROM tasks WHERE id=$1',[root])).rowCount).toBe(0)
  })
  it('blocks a shared task instead of deleting another contact dependency',async()=>{
    const f=await fixture(),task=await f.task();await link(f.workspaceId,f.userId,'task',task,'entity',f.otherId)
    const review=await f.preview();expect(review.blockers).toContainEqual({domain:'tasks',reason:'shared_or_unresolved_task',count:1})
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
    expect((await pool.query('SELECT id FROM tasks WHERE id=$1',[task])).rowCount).toBe(1)
  })
  it('redacts shared task descendants while preserving an independent subject task in exports',async()=>{
    const f=await fixture(),own=await f.task(),shared=await f.task(),child=await f.task({},shared)
    await link(f.workspaceId,f.userId,'task',shared,'entity',f.otherId)
    const review=await f.preview()
    expect(review.blockers).toContainEqual({domain:'tasks',reason:'shared_or_unresolved_task',count:2})
    await pool.query(`INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor,mutation_reason)
      VALUES('task',$1,1,'{"title":"Other contact copy"}',now()-interval '1 minute',now(),'human_edit','Other contact reason')`,[child])
    await pool.query(`INSERT INTO correction_audit(workspace_id,action,primitive,row_id,reason,row_snapshot)
      VALUES($1,'soft_delete','task',$2,'Other contact reason','{"title":"Other contact copy"}')`,[f.workspaceId,child])
    const result=await exported(f.context,f.contactId),rows=result.tasks
    expect(result.brain_row_versions[0]).toMatchObject({before_image:null,mutation_reason:null})
    expect(result.correction_audit[0]).toMatchObject({reason:null,row_snapshot:null,detail:null,ticket_reference:null})
    expect(rows.find(t=>t.id===own)?.title).toBe('Private task copy')
    for(const id of [shared,child])expect(rows.find(t=>t.id===id)).toMatchObject({title:null,attributes:null,tags:null})
  })
  it('keeps typed task decision artifacts as dependencies without attributing incidental id text',async()=>{
    const f=await fixture(),task=await f.task(),applicationId=randomUUID()
    for(const [id,kind,artifact] of [[applicationId,'task',task],[randomUUID(),'note','mention '+task]])
      await pool.query(`INSERT INTO decision_applications(id,workspace_id,actor_user_id,operation_kind,operation_id,artifact_refs,visibility,sensitivity)
        VALUES($1,$2,$3,'fixture',$1::uuid::text,$4,'workspace','internal')`,[id,f.workspaceId,f.userId,JSON.stringify([{kind,id:artifact}])])
    const review=await f.preview()
    expect(review.blockers).toContainEqual({domain:'decision_applications',reason:'crm_copy_resolution_required',count:1})
    expect((await exported(f.context,f.contactId)).decision_applications.map(r=>r.id)).toEqual([applicationId])
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
    expect((await pool.query('SELECT id FROM tasks WHERE id=$1',[task])).rowCount).toBe(1)
  })
  it('reviews exact typed segment references and preserves incidental UUID text',async()=>{
    const f=await fixture(),relationship=randomUUID(),email=randomUUID(),incidental=randomUUID()
    const rule=(family:string,field:string,operator:string,value:unknown)=>({type:'rule',family,field,operator,value})
    for(const [id,items] of [
      [relationship,[{type:'group',combinator:'or',items:[rule('relationship','copy_fixture','not_in',[f.contactId,f.otherId])]}]],
      [email,[rule('base','email','eq',' SUBJECT@example.com ')]],
      [incidental,[rule('tag','tags','contains','marker '+f.contactId)]],
    ] as const)await pool.query(`INSERT INTO crm_segments(id,workspace_id,segment_key,name,description,entity_kind,predicate)
      VALUES($1,$2,$3,'Private segment name',$4,'person',$5)`,[id,f.workspaceId,'fixture_'+id,'Incidental '+f.contactId,JSON.stringify({type:'group',combinator:'and',items})])
    const blocked=await f.preview()
    expect(blocked.blockers).toContainEqual({domain:'crm_segments',reason:'crm_copy_resolution_required',count:2})
    const segments=(await exported(f.context,f.contactId)).crm_segments
    expect(segments.map(r=>r.id).sort()).toEqual([relationship,email].sort())
    expect(segments.every(r=>r.name===null&&r.predicate===null&&r.description===null&&r.segment_key===null)).toBe(true)
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
    expect((await pool.query('SELECT id FROM crm_segments WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(3)
    await pool.query('UPDATE crm_segments SET predicate=$2,version=version+1 WHERE id=ANY($1::uuid[])',[[relationship,email],JSON.stringify({type:'group',combinator:'and',items:[rule('base','name','is_not_empty',undefined)]})])
    await expect(f.erase(blocked)).rejects.toMatchObject({details:{reason:'privacy_preview_blocked'}})
    const ready=await f.preview();expect(ready.status).toBe('ready');await f.erase(ready)
    expect((await pool.query('SELECT id FROM crm_segments WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(3)
  })
  it('refuses a cross-workspace cascade caused by a previously moved task',async()=>{
    const f=await fixture(),other=await fixture(),parent=await other.task(),child=await other.task({},parent)
    await pool.query('UPDATE tasks SET workspace_id=$2,attributes=$3 WHERE id=$1',[parent,f.workspaceId,JSON.stringify({crm_contact_id:f.contactId})])
    // Moving a row does not grant access to another user's private task.
    await expect(f.preview()).rejects.toMatchObject({code:'not_authorized'})
    await pool.query('UPDATE tasks SET user_id=$2 WHERE id=$1',[parent,f.userId])
    const review=await f.preview();expect(review.blockers).toContainEqual({domain:'tasks',reason:'cross_workspace_task_dependency',count:1})
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
    expect((await pool.query('SELECT workspace_id FROM tasks WHERE id=$1',[child])).rows[0].workspace_id).toBe(other.workspaceId)
  })
  it.each(['descendant','draft_revision'] as const)('invalidates review when a %s copy is added',async change=>{
    const f=await fixture(),root=await f.task(),draft=await f.draft(),review=await f.preview()
    if(change==='descendant')await f.task({},root);else await version(f.workspaceId,draft,1,['subject@example.com'])
    await expect(f.erase(review)).rejects.toMatchObject({details:{reason:'privacy_preview_stale'}})
    expect((await pool.query('SELECT status FROM crm_privacy_previews WHERE id=$1',[review.id])).rows[0].status).toBe('ready')
  })
  it('keeps linked task and historical draft attachment files as explicit dependencies in export and erasure',async()=>{
    const f=await fixture(),task=await f.task(),draft=await f.draft(),fileId=randomUUID(),historyFileId=randomUUID()
    await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id) VALUES($1,$2,'/private-copy.txt','private-copy.txt','fixture://private-copy',$3)",[fileId,f.workspaceId,f.userId])
    await link(f.workspaceId,f.userId,'task',task,'file',fileId)
    await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id) VALUES($1,$2,'/history-copy.txt','history-copy.txt','fixture://history-copy',$3)",[historyFileId,f.workspaceId,f.userId])
    await version(f.workspaceId,draft,1,['subject@example.com'])
    await pool.query("UPDATE crm_email_draft_versions SET attachment_refs=ARRAY['/history-copy.txt'] WHERE draft_id=$1",[draft])
    const review=await f.preview();expect(review.blockers).toContainEqual({domain:'workspace_files',reason:'crm_copy_resolution_required',count:2})
    expect((await exported(f.context,f.contactId)).workspace_files.map(r=>r.id).sort()).toEqual([fileId,historyFileId].sort())
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
    expect((await pool.query('SELECT id FROM tasks WHERE id=$1',[task])).rowCount).toBe(1)
  })
  it('rolls back copy deletions and redactions if a later canonical parent dependency refuses purge',async()=>{
    const f=await fixture(),task=await f.task(),draft=await f.draft();await version(f.workspaceId,draft,1,['subject@example.com'])
    const review=await f.preview()
    await pool.query('CREATE TABLE fixture_copy_purge_guard(subject_id uuid REFERENCES entities(id) ON DELETE RESTRICT)')
    try {
      await pool.query('INSERT INTO fixture_copy_purge_guard VALUES($1)',[f.contactId])
      await expect(f.erase(review)).rejects.toMatchObject({details:{reason:'privacy_review_failed'}})
      expect((await pool.query('SELECT id FROM tasks WHERE id=$1',[task])).rowCount).toBe(1)
      expect((await pool.query('SELECT id FROM crm_email_drafts WHERE id=$1',[draft])).rowCount).toBe(1)
      expect((await pool.query('SELECT id FROM crm_email_draft_versions WHERE draft_id=$1',[draft])).rowCount).toBe(1)
      expect((await pool.query('SELECT status FROM crm_privacy_previews WHERE id=$1',[review.id])).rows[0].status).toBe('ready')
    }finally{await pool.query('DROP TABLE fixture_copy_purge_guard')}
  })
  it('guards task before-images during erasure and refuses history resurrection after parent deletion',async()=>{
    const f=await fixture(),task=await f.task(),client=await pool.connect()
    const insert=()=>pool.query(`INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor)
      VALUES('task',$1,1,'{"title":"Private task snapshot"}',now()-interval '1 minute',now(),'human_edit')`,[task])
    try {await client.query('BEGIN');await acquireCrmPrivacyAdmission(client,f.workspaceId);await expect(insert()).rejects.toMatchObject({code:'55P03'})}
    finally{await client.query('ROLLBACK');client.release()}
    await f.erase(await f.preview())
    await expect(insert()).rejects.toMatchObject({code:'55P03',message:'crm_privacy_subject_unavailable'})
  })
})
