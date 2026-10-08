import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it} from 'vitest'
import {type CrmOperationsContext,type CrmRetentionPolicy,type CrmRetentionReview} from '@use-brian/core'
import {getPool,getAppPool} from '../client.js'
import {pruneCrmOperationsRetention} from '../../crm-operations/privacy.js'
import {createCrmPrivacyService} from '../../crm-operations/privacy-previews.js'
import {createCrmOperationsService} from '../../crm-operations/service.js'
import {createDbCrmOperationsStore} from '../crm-operations-store.js'
import {createCrmRetentionService,runScheduledCrmRetention,listCrmRetentionRuns} from '../../crm-operations/retention-service.js'
import {createWorkspaceStore} from '../workspace-store.js'
import {createDbCrmIntakeReadStore} from '../crm-intake-store.js'
import {crmOperationsRoutes} from '../../routes/crm-operations.js'
import {flushWorkspaceData} from '../workspace-flush.js'
import {streamCrmPrivacyExport} from '../../crm-operations/privacy-export.js'
import {_resetCoalescerForTests} from '../../brain-stream/notify.js'
import {loadAssociationOrderScope} from '../../association/source-scope.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool(),service=createCrmOperationsService(createDbCrmOperationsStore()),retention=createCrmRetentionService()
const BASE:CrmRetentionPolicy={scheduled:false,intervalSeconds:60,resolvedSubmissionsSeconds:60,openSubmissions:null,
  importReceiptsSeconds:null,deliveryReceiptsSeconds:null,auditSeconds:null,financialRecordsSeconds:null,holds:[]}
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Retention fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source) VALUES($1,$2,'person','Fictional contact','retention@example.com',$3,'manual')",[contactId,workspaceId,userId])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canConfigure:true,canWrite:true,trustedIdentitySources:[]}}
  async function policy(config:CrmRetentionPolicy=BASE,expectedVersion=0) {
    return service.execute(context,{kind:'save_privacy_policy',expectedVersion,confirmed:true,intakeReplay:{retentionSeconds:3600},retention:config})
  }
  const preview=()=>retention.preview(context,{kind:'preview_retention',before:new Date().toISOString()})
  const execute=(p:CrmRetentionReview)=>retention.execute(context,{kind:'execute_retention',previewId:p.id,previewHash:p.previewHash,confirmed:true})
  async function submission(status='resolved',id=randomUUID(),contact=contactId) {
    const evidence=await loadAssociationOrderScope(pool,workspaceId,[contact])
    await pool.query(`INSERT INTO association_enquiries(id,workspace_id,contact_id,source,source_submission_id,request_fingerprint,subject,message,submitted_data,status,updated_at,scope_snapshot,scope_sources)
      VALUES($1::uuid,$2,$3,'manual',$1::text,repeat('a',64),'Private subject','Private message','{"sensitive":"Private form value"}',$4,now()-interval '2 days',$5,$6)`,[id,workspaceId,contact,status,JSON.stringify(evidence.scope),JSON.stringify(evidence.sources)])
    return id
  }
  const note=(id:string)=>pool.query(`INSERT INTO association_enquiry_notes(workspace_id,enquiry_id,body,actor_kind,actor_credential_id)
    VALUES($1,$2,'Private note','api_key','fixture')`,[workspaceId,id])
  const attachment=(id:string)=>pool.query(`INSERT INTO association_submission_attachments(
      workspace_id,submission_id,attachment_key,original_name,mime_type,content_bytes,size_bytes,sha256)
    VALUES($1,$2,'business_card','card.png','image/png',$3,$4,repeat('a',64))`,
    [workspaceId,id,Buffer.from('normalized fixture image'),Buffer.byteLength('normalized fixture image')])
  return {workspaceId,userId,contactId,context,policy,preview,execute,submission,note,attachment}
}
async function count(table:string,workspaceId:string) {return Number((await pool.query(`SELECT count(*) count FROM ${table} WHERE workspace_id=$1`,[workspaceId])).rows[0].count)}
describe('[COMP:crm/retention] Actual review and policy execution',()=>{
  afterAll(async()=>{_resetCoalescerForTests();await pool.end();await appPool.end()})
  async function department(f:Awaited<ReturnType<typeof fixture>>) {
    const id=randomUUID(),departmentOwner=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[departmentOwner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,departmentOwner])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional retention department',$3,'team',$1::text,$4)",[id,f.workspaceId,departmentOwner,`team:${id}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional retention department','team',$3)",[f.workspaceId,`team:${id}`,id])
    return id
  }
  it('protects current candidate scope and preserves receipt protection after deletion',async()=>{
    const f=await fixture();await f.policy();await f.submission()
    const old=await f.preview(),dept=await department(f)
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[f.contactId,[`team:${dept}`]])
    await expect(f.preview()).rejects.toMatchObject({code:'not_authorized'})
    await expect(f.execute(old)).rejects.toMatchObject({code:'not_authorized'})
    await expect(pruneCrmOperationsRetention(f.context,new Date())).rejects.toMatchObject({code:'not_authorized'})
    const http=express();http.use(express.json());http.use((req,_res,next)=>{req.userId=f.userId;next()})
    http.use('/crm',crmOperationsRoutes({workspaceStore:createWorkspaceStore(),readStore:createDbCrmIntakeReadStore(),service}))
    expect((await request(http).post(`/crm/${f.workspaceId}/operations/retention`).send({before:new Date().toISOString(),confirmed:true})).status).toBe(403)
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,dept,f.userId])
    await expect(f.execute(old)).rejects.toMatchObject({details:{reason:'retention_preview_stale'}})
    const review=await f.preview()
    expect((await pool.query('SELECT scope_snapshot FROM crm_retention_runs WHERE id=$1',[review.id])).rows[0].scope_snapshot.compartments).toEqual([`team:${dept}`])
    await expect(pool.query("UPDATE crm_retention_runs SET scope_snapshot=jsonb_set(scope_snapshot,'{compartments}','[]') WHERE id=$1",[review.id])).rejects.toMatchObject({code:'23514'})
    expect((await f.execute(review)).receipt.changed).toMatchObject({submissions:1})
    await pool.query("UPDATE entities SET sensitivity='internal',compartments='{}' WHERE id=$1",[f.contactId])
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[dept,f.userId])
    await expect(f.execute(review)).rejects.toMatchObject({code:'not_authorized'})
    expect((await listCrmRetentionRuns(f.context,{})).runs.some(row=>row.id===review.id)).toBe(false)
    await expect((async()=>{for await(const _line of streamCrmPrivacyExport(f.context)){/* exhaust */}})()).rejects.toMatchObject({code:'not_authorized'})
    await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[dept,f.userId])
    expect((await f.execute(review)).duplicate).toBe(true)
    expect((await listCrmRetentionRuns(f.context,{})).runs.some(row=>row.id===review.id)).toBe(true)
  })
  it('retains saved submission protection after contact declassification and rechecks cleanup authority',async()=>{
    const f=await fixture();await f.policy()
    const dept=await department(f)
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[f.contactId,[`team:${dept}`]])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,dept,f.userId])
    await f.submission()
    await pool.query("UPDATE entities SET sensitivity='public',compartments='{}' WHERE id=$1",[f.contactId])
    await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2',[dept,f.userId])
    await expect(f.preview()).rejects.toMatchObject({code:'not_authorized'})
    await expect(pruneCrmOperationsRetention(f.context,new Date())).rejects.toMatchObject({code:'not_authorized'})
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,dept,f.userId])
    const review=await f.preview()
    expect((await pool.query('SELECT scope_snapshot FROM crm_retention_runs WHERE id=$1',[review.id])).rows[0].scope_snapshot)
      .toMatchObject({sensitivity:'confidential',compartments:[`team:${dept}`]})
    await f.execute(review)
    expect(await count('association_enquiries',f.workspaceId)).toBe(0)
  })
  it('checks retained candidates beyond the mutation page and scheduled approver department access',async()=>{
    const f=await fixture();await f.policy({...BASE,scheduled:true})
    for(let i=0;i<501;i++)await f.submission()
    const hidden=randomUUID(),dept=await department(f)
    await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,sensitivity,compartments) VALUES($1,$2,'person','Fictional protected contact',$3,'manual','confidential',$4)",[hidden,f.workspaceId,f.userId,[`team:${dept}`]])
    await f.submission('resolved','ffffffff-ffff-4fff-8fff-ffffffffffff',hidden)
    await f.policy({...BASE,scheduled:true,holds:[{domain:'contact',id:hidden}]},1)
    await expect(f.preview()).rejects.toMatchObject({code:'not_authorized'})
    expect(await runScheduledCrmRetention(f.workspaceId)).toBe('failed')
    expect(await count('association_enquiries',f.workspaceId)).toBe(502)
  })
  it('retains an event audience after the live contact becomes General',async()=>{
    const f=await fixture(),dept=await department(f)
    await f.policy({...BASE,deliveryReceiptsSeconds:60})
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[f.contactId,[`team:${dept}`]])
    const submission=await f.submission(),event=randomUUID()
    await pool.query("INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,status,created_at) VALUES($1::uuid,$2,'crm.submission.received',$1::text,'submission',$3,'user','delivered',now()-interval '2 days')",[event,f.workspaceId,submission])
    await pool.query("UPDATE entities SET sensitivity='internal',compartments='{}' WHERE id=$1",[f.contactId])
    await expect(f.preview()).rejects.toMatchObject({code:'not_authorized'})
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,dept,f.userId])
    const review=await f.preview();expect((await f.execute(review)).receipt.changed).toMatchObject({events:1})
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[dept,f.userId])
    await expect(f.execute(review)).rejects.toMatchObject({code:'not_authorized'})
    expect((await listCrmRetentionRuns(f.context,{})).runs).toEqual([])
  })
  it('checks expired cleanup receipt protection before including it in retention counts',async()=>{
    const f=await fixture(),dept=await department(f);await f.policy()
    const id=randomUUID(),scope={workspaceId:f.workspaceId,userId:null,assistantId:null,sensitivity:'confidential',compartments:[`team:${dept}`],projectIds:[]}
    await pool.query(`INSERT INTO crm_import_file_cleanups(id,workspace_id,owner_user_id,file_id,before_at,policy_version,snapshot_hash,preview_hash,summary,status,created_at,expires_at,scope_snapshot)
      VALUES($1,$2,$3,$4,now()-interval '2 days',1,repeat('a',64),repeat('b',64),'{}','blocked',now()-interval '2 days',now()-interval '1 day',$5::jsonb)`,[id,f.workspaceId,f.userId,randomUUID(),JSON.stringify(scope)])
    await expect(f.preview()).rejects.toMatchObject({code:'not_authorized'})
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,dept,f.userId])
    const review=await f.preview();expect((await f.execute(review)).receipt.changed).toMatchObject({fileCleanups:1})
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[dept,f.userId])
    await expect(f.execute(review)).rejects.toMatchObject({code:'not_authorized'})
  })
  it('requires current owner authority for legacy retention even with a forged context',async()=>{
    const f=await fixture();await f.policy();await f.submission()
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(pruneCrmOperationsRetention(f.context,new Date())).rejects.toMatchObject({code:'not_authorized'})
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
  })
  it('withholds unknown legacy review floors after enabling department reads',async()=>{
    const f=await fixture();await f.policy();await f.submission()
    await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspaceId])
    const review=await f.preview()
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
    await expect(f.execute(review)).rejects.toMatchObject({code:'not_authorized'})
    expect((await listCrmRetentionRuns(f.context,{})).runs).toEqual([])
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
  })
  it('rejects malformed retention policy through the database constraint as well as the command schema',async()=>{
    for(const value of [
      {...BASE,holds:[{domain:null,id:randomUUID()}]},
      {...BASE,openSubmissions:{afterSeconds:60,fields:[null]}},
      {...BASE,resolvedSubmissionsSeconds:0},
      {...BASE,holds:[{domain:'contact',id:'invalid'}]},
    ])expect((await pool.query('SELECT crm_retention_policy_valid($1::jsonb) valid',[JSON.stringify(value)])).rows[0].valid).toBe(false)
  })
  it('leaves an unconfigured workspace untouched and refuses machine approval or foreign holds',async()=>{
    const f=await fixture(),other=await fixture();await f.submission()
    const review=await f.preview();expect(review.status).toBe('blocked')
    await expect(f.execute(review)).rejects.toMatchObject({details:{reason:'retention_preview_blocked'}})
    expect(await runScheduledCrmRetention(f.workspaceId)).toBe('skipped')
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
    await expect(service.execute({...f.context,actor:{kind:'brain_key',credentialId:randomUUID()}},{kind:'save_privacy_policy',expectedVersion:0,confirmed:true,intakeReplay:null,retention:BASE})).rejects.toMatchObject({code:'not_authorized'})
    await expect(f.policy({...BASE,holds:[{domain:'contact',id:other.contactId}]})).rejects.toMatchObject({code:'invalid_input'})
    expect(await count('crm_privacy_policies',f.workspaceId)).toBe(0)
  })
  it('captures over 100 submissions, rejects changed notes, then consumes one transaction and replays its receipt',async()=>{
    const f=await fixture();await f.policy()
    for(let i=0;i<105;i++)await f.submission()
    const id=(await pool.query('SELECT id FROM association_enquiries WHERE workspace_id=$1 LIMIT 1',[f.workspaceId])).rows[0].id
    await f.attachment(id)
    const audit=(await pool.query("INSERT INTO association_audit_log(workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,metadata) VALUES($1,'fixture','submission',$2,'user','fixture','{\"private\":\"Private audit\"}') RETURNING id",[f.workspaceId,id])).rows[0].id
    const first=await f.preview();expect(first.domains).toContainEqual({domain:'association_enquiries',action:'delete',count:105})
    expect(await count('association_enquiries',f.workspaceId)).toBe(105)
    await f.note(id)
    await expect(f.execute(first)).rejects.toMatchObject({details:{reason:'retention_preview_stale'}})
    const auditReview=await f.preview()
    await pool.query("UPDATE association_audit_log SET metadata='{\"private\":\"Changed private audit\"}' WHERE id=$1",[audit])
    await expect(f.execute(auditReview)).rejects.toMatchObject({details:{reason:'retention_preview_stale'}})
    const review=await f.preview(),executed=await f.execute(review)
    expect(review.domains).toContainEqual({domain:'association_submission_attachments',action:'delete',count:1})
    expect(executed.receipt.changed).toMatchObject({submissions:105,submissionAttachments:1});expect(executed.duplicate).toBe(false)
    expect(await count('association_enquiries',f.workspaceId)).toBe(0)
    expect(await count('association_enquiry_notes',f.workspaceId)).toBe(0)
    expect((await pool.query('SELECT metadata FROM association_audit_log WHERE id=$1',[audit])).rows[0].metadata).toEqual({retentionRedacted:true})
    expect(await f.execute(review)).toEqual({receipt:executed.receipt,duplicate:true})
    const runs=(await pool.query('SELECT * FROM crm_retention_runs WHERE workspace_id=$1',[f.workspaceId])).rows
    expect(JSON.stringify(runs)).not.toContain('Private')
  })
  it('binds review to the owner and current policy and refuses membership revocation',async()=>{
    const f=await fixture(),other=await fixture();await f.policy();await f.submission()
    const review=await f.preview()
    await expect(other.execute(review)).rejects.toMatchObject({code:'not_found'})
    await expect(f.execute({...review,previewHash:'f'.repeat(64)})).rejects.toMatchObject({details:{reason:'retention_preview_mismatch'}})
    await f.policy({...BASE,resolvedSubmissionsSeconds:120},1)
    await expect(f.execute(review)).rejects.toMatchObject({details:{reason:'retention_preview_stale'}})
    const fresh=await f.preview()
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(f.execute(fresh)).rejects.toMatchObject({code:'not_authorized'})
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
  })
  it('redacts selected open fields and notes while retaining state and independent copies',async()=>{
    const f=await fixture();await f.policy({...BASE,openSubmissions:{afterSeconds:60,fields:['message','metadata','notes']}})
    const id=await f.submission('in_progress');await f.note(id);await f.attachment(id)
    const review=await f.preview();expect(review.retainedCopies).toContain('independent_task_import_delivery_copies')
    expect(review.domains).toContainEqual({domain:'association_submission_attachments',action:'delete',count:1})
    await f.execute(review)
    const row=(await pool.query('SELECT subject,message,submitted_data,status,contact_id FROM association_enquiries WHERE id=$1',[id])).rows[0]
    expect(row).toEqual({subject:'Private subject',message:'Removed by retention policy',submitted_data:{},status:'in_progress',contact_id:f.contactId})
    expect(await count('association_enquiry_notes',f.workspaceId)).toBe(0)
    expect(await count('association_submission_attachments',f.workspaceId)).toBe(0)
    expect(await count('entities',f.workspaceId)).toBe(1)
  })
  it('supports metadata-only and notes-only policies without changing other submission content',async()=>{
    for(const field of ['metadata','notes'] as const) {
      const f=await fixture();await f.policy({...BASE,openSubmissions:{afterSeconds:60,fields:[field]}})
      const id=await f.submission('new');await f.note(id);await f.attachment(id);await f.execute(await f.preview())
      const row=(await pool.query('SELECT subject,message,submitted_data,status FROM association_enquiries WHERE id=$1',[id])).rows[0]
      expect(row.message).toBe('Private message');expect(row.status).toBe('new')
      expect(row.submitted_data).toEqual(field==='metadata'?{}:{sensitive:'Private form value'})
      expect(await count('association_enquiry_notes',f.workspaceId)).toBe(field==='notes'?0:1)
      expect(await count('association_submission_attachments',f.workspaceId)).toBe(field==='metadata'?0:1)
    }
  })
  it('retains holds and live event attribution without starving eligible submissions beyond a full held page',async()=>{
    const f=await fixture(),held=await f.submission('resolved','00000000-0000-4000-8000-000000000001')
    // Many dependent rows precede the eligible row in id order.
    for(let i=0;i<505;i++) {
      const id=await f.submission()
      await pool.query(`INSERT INTO crm_domain_event_outbox(workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind)
        VALUES($1,'crm.submission.received',$2::text,'submission',$2::uuid,'user')`,[f.workspaceId,id])
    }
    const eligible=await f.submission();await f.policy({...BASE,holds:[{domain:'submission',id:held}]})
    const review=await f.preview()
    expect(review.domains).toContainEqual({domain:'association_enquiries',action:'delete',count:1})
    expect(review.domains).toContainEqual({domain:'association_enquiries',action:'retain',count:506})
    expect(review.hasMore).toBe(false);await f.execute(review)
    expect((await pool.query('SELECT id FROM association_enquiries WHERE id=$1',[eligible])).rowCount).toBe(0)
    expect(await count('association_enquiries',f.workspaceId)).toBe(506)
  })
  it('bounds mutations to 500 and exposes remaining eligible work',async()=>{
    const f=await fixture();await f.policy()
    for(let i=0;i<503;i++)await f.submission()
    const review=await f.preview();expect(review.hasMore).toBe(true)
    expect((await f.execute(review)).receipt.changed).toMatchObject({submissions:500})
    const rest=await f.preview();expect(rest.hasMore).toBe(false)
    expect((await f.execute(rest)).receipt.changed).toMatchObject({submissions:3})
  })
  it('rechecks admission, and a later failure rolls back all earlier selected deletions',async()=>{
    const f=await fixture();await f.policy();await f.submission();const review=await f.preview()
    const writer=await pool.connect()
    try {
      await writer.query('BEGIN');await writer.query("UPDATE entities SET display_name='Pending private edit' WHERE id=$1",[f.contactId])
      await expect(f.execute(review)).rejects.toMatchObject({details:{reason:'privacy_operation_busy'}})
    }finally{await writer.query('ROLLBACK');writer.release()}
    // A test-owned FK forces failure after the selected deletion is attempted.
    const conn=await pool.connect()
    try {
      await conn.query('CREATE TABLE retention_test_block(id uuid PRIMARY KEY, enquiry_id uuid REFERENCES association_enquiries(id))')
      const id=(await pool.query('SELECT id FROM association_enquiries WHERE workspace_id=$1',[f.workspaceId])).rows[0].id
      await conn.query('INSERT INTO retention_test_block VALUES($1,$2)',[randomUUID(),id])
      await expect(f.execute(review)).rejects.toMatchObject({details:{reason:'retention_failed'}})
      expect(await count('association_enquiries',f.workspaceId)).toBe(1)
      expect((await pool.query('SELECT status FROM crm_retention_runs WHERE id=$1',[review.id])).rows[0].status).toBe('ready')
    }finally{await conn.query('DROP TABLE IF EXISTS retention_test_block');conn.release()}
    await f.execute(review)
  })
  it('runs an opted-in policy once across simultaneous workers and a restart, and reacts to a later disable',async()=>{
    const f=await fixture();await f.policy({...BASE,scheduled:true});await f.submission()
    const outcomes=await Promise.all([runScheduledCrmRetention(f.workspaceId),runScheduledCrmRetention(f.workspaceId)])
    expect(outcomes.filter(v=>v==='completed')).toHaveLength(1)
    expect(await runScheduledCrmRetention(f.workspaceId)).toBe('skipped')
    expect(await count('association_enquiries',f.workspaceId)).toBe(0)
    expect(await count('crm_retention_runs',f.workspaceId)).toBe(1)
    await f.policy(BASE,1);await f.submission()
    expect(await runScheduledCrmRetention(f.workspaceId)).toBe('skipped')
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
  })
  it.each(['downgraded','removed'] as const)('refuses scheduled deletion after the approver is %s',async change=>{
    const f=await fixture();await f.policy({...BASE,scheduled:true});await f.submission()
    if(change==='downgraded')await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    else await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    expect(await runScheduledCrmRetention(f.workspaceId)).toBe('failed')
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
    const rows=(await pool.query('SELECT status,error_code,summary,receipt FROM crm_retention_runs WHERE workspace_id=$1',[f.workspaceId])).rows
    expect(rows).toEqual([{status:'failed',error_code:'retention_failed',summary:{},receipt:null}])
    const nextApprover=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[nextApprover])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')",[f.workspaceId,nextApprover])
    const nextContext={...f.context,actor:{kind:'user' as const,userId:nextApprover},authority:{...f.context.authority,role:'admin' as const}}
    const command={kind:'save_privacy_policy' as const,expectedVersion:1,confirmed:true as const,intakeReplay:{retentionSeconds:3600},retention:{...BASE,scheduled:true}}
    expect((await service.execute(nextContext,command)).created).toBe(true)
    expect((await service.execute(nextContext,{...command,expectedVersion:2})).created).toBe(false)
    expect(await runScheduledCrmRetention(f.workspaceId)).toBe('completed')
    expect(await count('association_enquiries',f.workspaceId)).toBe(0)
  })
  it('makes a saved contact hold block canonical contact erasure as well as retention',async()=>{
    const f=await fixture();await f.policy({...BASE,holds:[{domain:'contact',id:f.contactId}]});await f.submission()
    expect((await f.policy({...BASE,holds:[{domain:'contact',id:f.contactId.toUpperCase()}]},1)).created).toBe(false)
    await pruneCrmOperationsRetention(f.context,new Date())
    expect(await count('association_enquiries',f.workspaceId)).toBe(1)
    const review=await f.preview();expect(review.domains).toContainEqual({domain:'association_enquiries',action:'retain',count:1})
    const erasure=await createCrmPrivacyService().preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId.toUpperCase()})
    expect(erasure.status).toBe('blocked');expect(erasure.blockers).toContainEqual({domain:'entities',reason:'retention_hold',count:1})
    await expect(createCrmPrivacyService().erase(f.context,{kind:'erase_contact_with_preview',contactId:f.contactId.toUpperCase(),previewId:erasure.id,previewHash:erasure.previewHash,confirmed:true})).rejects.toMatchObject({details:{reason:'privacy_preview_blocked'}})
  })
  it('refuses a review that would count or remove an import receipt outside the reviewer\'s departments',async()=>{
    const f=await fixture();await f.policy({...BASE,importReceiptsSeconds:60})
    const dept=await department(f),file=randomUUID(),job=randomUUID()
    await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,sensitivity,compartments)
      VALUES($1,$2,$3,'fictional.csv','fixture://local',$4,'confidential',$5)`,[file,f.workspaceId,`/fixture/${file}.csv`,f.userId,[`team:${dept}`]])
    await pool.query(`INSERT INTO crm_import_jobs(id,workspace_id,staged_file_id,entity_kind,status,mapping,mapping_hash,source_hash,total_rows,created_by_user_id,updated_at)
      VALUES($1,$2,$3,'contact','completed','{"columns":{}}'::jsonb,repeat('a',64),repeat('b',64),1,$4,now()-interval '2 days')`,[job,f.workspaceId,file,f.userId])
    await expect(f.preview()).rejects.toMatchObject({code:'not_authorized'})
    expect(await count('crm_import_jobs',f.workspaceId)).toBe(1)
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,dept,f.userId])
    expect((await f.preview()).domains).toContainEqual({domain:'crm_import_jobs',action:'retain',count:1})
  })
  it('renews a saved review read-only and withholds it once its floor leaves the reviewer\'s authority',async()=>{
    const f=await fixture();await f.policy();const dept=await department(f)
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,dept,f.userId])
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[f.contactId,[`team:${dept}`]])
    await f.submission()
    const review=await f.preview()
    const read=await retention.read!(f.context,review.id)
    expect(read).toMatchObject({id:review.id,previewHash:review.previewHash,domains:review.domains})
    await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2 AND department_id=$3',[f.workspaceId,f.userId,dept])
    await expect(retention.read!(f.context,review.id)).rejects.toMatchObject({code:'not_authorized'})
  })
  it('minimizes eligible delivery envelopes and retains ambiguous sends and failed events',async()=>{
    const f=await fixture();await f.policy({...BASE,deliveryReceiptsSeconds:60})
    const ids:Record<string,string>={}
    // Post-700 receipts carry the recipient's saved floor; one unclassified historical receipt is only ever retained.
    const evidence=await loadAssociationOrderScope(pool,f.workspaceId,[f.contactId])
    for(const status of ['sent','failed','needs_reconciliation','legacy']) {
      const id=randomUUID();ids[status]=id
      await pool.query(`INSERT INTO crm_delivery_receipts(workspace_id,delivery_id,request_hash,connector_instance_id,provider_key,purpose_key,
        actor_kind,actor_credential_id,envelope,status,claim_token,claim_deadline,provider_receipt,accepted_at,updated_at,scope_snapshot,scope_sources)
        VALUES($1,$2,repeat('a',64),$3,'fake','updates','user','fixture','{"body":"Private message"}',$4,$5,now(),
          '{"private":"Private provider reply"}',CASE WHEN $4='sent' THEN now()-interval '2 days' ELSE NULL END,now()-interval '2 days',$6::jsonb,$7::jsonb)`,
      [f.workspaceId,id,randomUUID(),status==='legacy'?'sent':status,randomUUID(),
        status==='legacy'?null:JSON.stringify(evidence.scope),status==='legacy'?null:JSON.stringify(evidence.sources)])
    }
    for(const status of ['delivered','failed'])await pool.query(`INSERT INTO crm_domain_event_outbox(workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,status,created_at)
      VALUES($1,'crm.submission.received',$2,'submission',$3,'user',$4,now()-interval '2 days')`,[f.workspaceId,randomUUID(),await f.submission(),status])
    const review=await f.preview()
    expect(review.domains).toContainEqual({domain:'crm_delivery_receipts',action:'redact',count:2})
    expect(review.domains).toContainEqual({domain:'crm_delivery_receipts',action:'retain',count:2})
    await f.execute(review)
    const rows=(await pool.query('SELECT delivery_id,status,envelope,provider_receipt,redacted_at FROM crm_delivery_receipts WHERE workspace_id=$1',[f.workspaceId])).rows
    expect(rows.filter(r=>r.status!=='needs_reconciliation'&&r.delivery_id!==ids.legacy).every(r=>r.envelope===null && r.provider_receipt===null && r.redacted_at instanceof Date)).toBe(true)
    expect(rows.find(r=>r.delivery_id===ids.legacy)).toMatchObject({envelope:{body:'Private message'},redacted_at:null})
    expect(rows.find(r=>r.delivery_id===ids.needs_reconciliation).envelope).toEqual({body:'Private message'})
    expect((await pool.query('SELECT status FROM crm_domain_event_outbox WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{status:'failed'}])
  })
  it('binds receipt expiry to the preview time, and prunes expired replay only on a later review',async()=>{
    const f=await fixture();await f.policy();const submission=await f.submission()
    const def=await service.execute(f.context,{kind:'save_intake_definition',definitionKey:'retention',label:'Retention fixture',active:true,definition:{
      identityPolicy:'new_or_review',fields:[{key:'name',label:'Name',type:'text',required:true,mapping:{kind:'base_field',field:'name'}}],
      consentMappings:[],queueKey:'general',ownerUserId:null,followUpTaskTemplate:null,followUpDueMinutes:null,maxPayloadBytes:32768}})
    const receipt=randomUUID()
    await pool.query(`INSERT INTO crm_intake_idempotency(id,workspace_id,actor_scope,definition_id,idempotency_key,request_hash,status,submission_id,contact_id,
      created_at,committed_at,replay_policy_version,replay_expires_at)
      VALUES($1,$2,'fixture',$3,'fixture',repeat('a',64),'committed',$4,$5,now()-interval '2 days',now()-interval '2 days',1,now()+interval '1 second')`,
      [receipt,f.workspaceId,def.record.id,submission,f.contactId])
    const review=await f.preview();await pool.query('SELECT pg_sleep(1.05)');await f.execute(review)
    expect((await pool.query('SELECT status,replay_expires_at<clock_timestamp() expired FROM crm_intake_idempotency WHERE id=$1',[receipt])).rows).toEqual([{status:'retired',expired:true}])
    await f.execute(await f.preview())
    expect((await pool.query('SELECT id FROM crm_intake_idempotency WHERE id=$1',[receipt])).rowCount).toBe(0)
  })
  it('records scheduled rollback as a fixed failed run without committing partial deletion',async()=>{
    const f=await fixture();await f.policy({...BASE,scheduled:true});const id=await f.submission()
    await pool.query('CREATE TABLE retention_worker_test_block(id uuid PRIMARY KEY, enquiry_id uuid REFERENCES association_enquiries(id))')
    try {
      await pool.query('INSERT INTO retention_worker_test_block VALUES($1,$2)',[randomUUID(),id])
      expect(await runScheduledCrmRetention(f.workspaceId)).toBe('failed')
      expect(await count('association_enquiries',f.workspaceId)).toBe(1)
      const runs=(await pool.query('SELECT status,error_code,summary,receipt FROM crm_retention_runs WHERE workspace_id=$1',[f.workspaceId])).rows
      expect(runs).toEqual([{status:'failed',error_code:'retention_failed',summary:{},receipt:null}])
      expect(await runScheduledCrmRetention(f.workspaceId)).toBe('skipped')
    }finally{await pool.query('DROP TABLE retention_worker_test_block')}
  })
  it('exposes member REST review/execute and paginated run history with no approval hashes in exports',async()=>{
    const f=await fixture();await f.policy();await f.submission()
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=f.userId;next()})
    app.use('/crm',crmOperationsRoutes({workspaceStore:createWorkspaceStore(),readStore:createDbCrmIntakeReadStore(),service}))
    const preview=await request(app).post(`/crm/${f.workspaceId}/operations/retention/dry-run`).send({before:new Date().toISOString()})
    expect(preview.status).toBe(200)
    const execution=await request(app).post(`/crm/${f.workspaceId}/operations/retention/execute`).send({previewId:preview.body.id,previewHash:preview.body.previewHash,confirmed:true})
    expect(execution.status).toBe(200)
    for(let i=0;i<5;i++)await f.preview()
    const first=await listCrmRetentionRuns(f.context,{limit:2});expect(first.runs).toHaveLength(2);expect(first.nextCursor).toEqual(expect.any(String))
    const second=await listCrmRetentionRuns(f.context,{limit:2,cursor:first.nextCursor!});expect(second.runs).toHaveLength(2)
    expect(new Set([...first.runs,...second.runs].map(r=>r.id)).size).toBe(4)
    const exported=[];for await(const line of streamCrmPrivacyExport(f.context))exported.push(line)
    const records=exported.join('').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.type==='record' && row.domain==='crm_retention_runs')
    expect(records).toHaveLength(6)
    expect(records.every(row=>!Object.hasOwn(row.record,'preview_hash') && !Object.hasOwn(row.record,'snapshot_hash'))).toBe(true)
    expect(exported.join('')).not.toContain(preview.body.previewHash)
  })
  it('enforces actual app-role read/write isolation and workspace reset preserves policy',async()=>{
    const f=await fixture(),other=await fixture();await f.policy();const preview=await f.preview()
    const app=await appPool.connect()
    try {
      await app.query('BEGIN');await app.query("SELECT set_config('app.current_user_id',$1,true)",[other.userId])
      expect((await app.query('SELECT id FROM crm_retention_runs WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
      expect((await app.query("UPDATE crm_retention_runs SET status='completed' WHERE id=$1",[preview.id])).rowCount).toBe(0)
      await app.query('ROLLBACK');await app.query('BEGIN');await app.query("SELECT set_config('app.current_user_id',$1,true)",[f.userId])
      expect((await app.query('SELECT id FROM crm_retention_runs WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(1)
      expect((await app.query('DELETE FROM crm_retention_runs WHERE id=$1',[preview.id])).rowCount).toBe(0)
    }finally{await app.query('ROLLBACK');app.release()}
    await flushWorkspaceData(f.userId,f.workspaceId)
    expect(await count('crm_retention_runs',f.workspaceId)).toBe(0)
    expect(await count('crm_privacy_policies',f.workspaceId)).toBe(1)
  })
})
