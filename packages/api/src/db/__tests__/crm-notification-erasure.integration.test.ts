import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest'
import type {CrmOperationsContext,CrmErasurePreview} from '@use-brian/core'
import {getPool} from '../client.js'
import {createSoftDeleteStore} from '../soft-delete-store.js'
import {createDbWorkflowRunStore} from '../workflow-store.js'
import {_resetCoalescerForTests} from '../../brain-stream/notify.js'
import {createAssociationStore} from '../association-store.js'
import {createCrmPrivacyService} from '../../crm-operations/privacy-previews.js'
import {streamCrmPrivacyExport} from '../../crm-operations/privacy-export.js'
import {acquireCrmPrivacyAdmission} from '../../crm-operations/privacy-admission.js'
import {pruneCrmOperationsRetention,listCrmEventDelivery} from '../../crm-operations/privacy.js'
import {createDbCrmDomainEventOutboxStore,createCrmDomainEventWorker} from '../../crm-operations/domain-event-worker.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),privacy=createCrmPrivacyService(),outbox=createDbCrmDomainEventOutboxStore()
const workspaces:string[]=[],users:string[]=[]
const nil='00000000-0000-0000-0000-000000000000'
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID(),otherId=randomUUID(),submissionId=randomUUID(),workflowId=randomUUID()
  users.push(userId);workspaces.push(workspaceId)
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Notification fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source)
    VALUES($1,$3,'person','Subject fixture','subject@example.com',$4,'manual'),($2,$3,'person','Other fixture','other@example.com',$4,'manual')`,[contactId,otherId,workspaceId,userId])
  await pool.query(`INSERT INTO association_enquiries(id,workspace_id,contact_id,source,source_submission_id,request_fingerprint,subject,message)
    VALUES($1,$2,$3,'fixture',$1::uuid::text,repeat('a',64),'Fixture','Private submission copy')`,[submissionId,workspaceId,contactId])
  await pool.query("INSERT INTO workflows(id,workspace_id,created_by,name,definition,enabled) VALUES($1,$2,$3,'Fixture','{}',false)",[workflowId,workspaceId,userId])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}}
  const preview=()=>privacy.preview(context,{kind:'preview_contact_erasure',contactId})
  const erase=(p:CrmErasurePreview)=>privacy.erase(context,{kind:'erase_contact_with_preview',contactId,previewId:p.id,previewHash:p.previewHash,confirmed:true})
  const legacy=async()=>{const store=createSoftDeleteStore();await store.applyHardPurge({primitive:'contact',workspaceId,rowId:contactId,actorUserId:userId,reason:'Synthetic privacy request',ticketReference:null,snapshot:(await store.readForSoftDelete('contact',workspaceId,contactId))!,now:new Date()})}
  const event=async(status='pending',subjectId=submissionId,subjectKind='submission')=>{
    // Keep this fixture in the bounded lease batch even when earlier suites
    // have left unrelated due events in the shared disposable database.
    const id=randomUUID();await pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,payload,status,delivered_at,last_error,next_attempt_at)
      VALUES($1,$2,'crm.submission.received',$1::uuid::text,$3,$4,'user','{"status":"original","unsafe":"subject@example.com"}',$5,CASE WHEN $5='delivered' THEN now() END,'subject@example.com','1970-01-01T00:00:00Z')`,[id,workspaceId,subjectKind,subjectId,status]);return id
  }
  const notification=async(status='pending',recipient=contactId)=>{
    const id=randomUUID();await pool.query(`INSERT INTO association_notification_outbox(id,workspace_id,source_kind,source_id,template_key,recipient_kind,recipient_ref,payload,status,provider_message_id,last_error)
      VALUES($1,$2,'enquiry',$3,'fixture_'||$1::uuid::text,'contact',$4,'{"message":"subject@example.com"}',$5,'private-provider-ref','subject@example.com')`,[id,workspaceId,submissionId,recipient,status]);return id
  }
  const lease=async(id:string,worker='fixture_worker')=>{const row=(await outbox.leaseBatch(worker,50,60_000)).find(e=>e.id===id);expect(row).toBeDefined();return row!}
  const input=(id:string)=>({trigger:{sourceType:'crm',provider:'crm',channelId:'crm.submission.received',actorId:null},event:{domainEventId:id,subjectKind:'submission',subjectId:submissionId,contactId}})
  const run=async(id:string)=>{
    const result=await createDbWorkflowRunStore().createWebhookRun!({workflowId,workspaceId,triggeredBy:userId,triggerKind:'event',input:input(id),idempotencyKey:'crm:'+id,bodySha256:'b'.repeat(64)})
    expect(result.kind).toBe('created');if(result.kind==='conflict')throw new Error('Fixture conflict');return result.run.id
  }
  return {workspaceId,userId,contactId,otherId,submissionId,workflowId,context,preview,erase,legacy,event,notification,lease,input,run}
}
async function exported(context:CrmOperationsContext,contactId?:string) {
  const records:Record<string,Record<string,unknown>[]>={}
  for await(const line of streamCrmPrivacyExport(context,{contactId})) {const row=JSON.parse(line);if(row.type==='record')(records[row.domain]??=[]).push(row.record)}
  return records
}
function latch(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}

describe('[COMP:crm/privacy-copies] Notification retirement and workflow dependencies',()=>{
  afterEach(async()=>{_resetCoalescerForTests();
    await pool.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[workspaces.splice(0)])
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users.splice(0)])
  })
  afterAll(async()=>{_resetCoalescerForTests();await pool.end()})
  it('retires more than one page of indirect copies without inventing delivered status',async()=>{
    const f=await fixture(),eventStates=['pending','leased','delivered','failed'],notificationStates=['pending','sending','sent','failed','suppressed']
    for(let i=0;i<108;i++)await f.event(eventStates[i%4])
    for(let i=0;i<105;i++)await f.notification(notificationStates[i%5])
    const unrelated=await f.event('pending',f.otherId,'contact')
    const before=(await pool.query('SELECT id,status,delivered_at FROM crm_domain_event_outbox WHERE workspace_id=$1 AND id<>$2',[f.workspaceId,unrelated])).rows
    const review=await f.preview();expect(review.status).toBe('ready')
    expect(review.domains).toContainEqual({domain:'crm_domain_event_outbox',action:'retire',count:108})
    expect(review.domains).toContainEqual({domain:'association_notification_outbox',action:'retire',count:105})
    await f.erase(review)
    const events=(await pool.query('SELECT * FROM crm_domain_event_outbox WHERE workspace_id=$1 AND id<>$2',[f.workspaceId,unrelated])).rows
    expect(events).toHaveLength(108)
    for(const row of events){const previous=before.find(r=>r.id===row.id)!;expect(row).toMatchObject({status:'retired',retired_from_status:previous.status,subject_id:nil,payload:{erased:true,eventType:'crm.submission.received'},lease_owner:null,leased_until:null,last_error:null,delivered_at:previous.delivered_at});expect(row.retired_at).toBeInstanceOf(Date)}
    const notifications=(await pool.query('SELECT * FROM association_notification_outbox WHERE workspace_id=$1',[f.workspaceId])).rows
    expect(notifications).toHaveLength(105)
    for(const row of notifications){expect(notificationStates).toContain(row.retired_from_status);expect(row).toMatchObject({status:'retired',source_id:nil,recipient_ref:'erased:'+row.id,payload:{erased:true},provider_message_id:null,last_error:null,next_attempt_at:null})}
    expect((await pool.query('SELECT status,payload FROM crm_domain_event_outbox WHERE id=$1',[unrelated])).rows[0]).toMatchObject({status:'pending',payload:{status:'original'}})
    const listed=await createAssociationStore(pool).listNotifications(f.workspaceId,{limit:100,cursor:null,status:'retired'})
    expect(listed.items).toHaveLength(100);expect(listed.nextCursor).toBeTruthy();expect(listed.items[0]).toMatchObject({status:'retired',retiredFromStatus:expect.any(String),retiredAt:expect.any(Date)})
    const delivery=await listCrmEventDelivery(f.context,{limit:100})
    const retiredDelivery=delivery.events.filter((row:Record<string,unknown>)=>row.status==='retired')
    expect(retiredDelivery.length).toBeGreaterThan(0)
    for(const row of retiredDelivery)expect(row).toMatchObject({retiredAt:expect.any(Date),retiredFromStatus:expect.any(String)})
    await pruneCrmOperationsRetention(f.workspaceId,new Date(Date.now()+86400_000))
    expect((await pool.query("SELECT id FROM crm_domain_event_outbox WHERE workspace_id=$1 AND status='retired'",[f.workspaceId])).rowCount).toBe(108)
  })
  it('prunes eligible delivery receipts while keeping workflow-bound sources',async()=>{
    const f=await fixture(),bound=await f.event('delivered'),eligible=await f.event('delivered'),run=await f.run(bound)
    const result=await pruneCrmOperationsRetention(f.workspaceId,new Date(Date.now()+86400_000))
    expect(result.deleted.crm_domain_event_outbox).toBe(1)
    expect((await pool.query('SELECT id FROM crm_domain_event_outbox WHERE id=$1',[eligible])).rowCount).toBe(0)
    expect((await pool.query('SELECT id,event_key,status FROM crm_domain_event_outbox WHERE id=$1',[bound])).rows[0]).toEqual({id:bound,event_key:bound,status:'delivered'})
    expect((await pool.query('SELECT crm_event_id FROM workflow_runs WHERE id=$1',[run])).rows[0]).toEqual({crm_event_id:bound})
  })
  it('skips a held lease after erasure and refuses retired-row mutation',async()=>{
    const f=await fixture(),id=await f.event(),notification=await f.notification(),lease=await f.lease(id)
    expect(Object.keys(lease).sort()).toEqual(['attempts','id','workspaceId'])
    await f.erase(await f.preview())
    const dispatch=vi.fn();expect(await outbox.dispatchLeased(lease,'fixture_worker',dispatch)).toBe('skipped');expect(dispatch).not.toHaveBeenCalled()
    // This worker is global. Other isolated test workspaces can legitimately
    // have pending events; none from the erased fixture may be leased again.
    expect((await outbox.leaseBatch('other_worker',50,60_000)).some(row=>row.workspaceId===f.workspaceId)).toBe(false)
    await expect(pool.query("UPDATE crm_domain_event_outbox SET payload='{}' WHERE id=$1",[id])).rejects.toMatchObject({code:'55000',message:'crm_delivery_retired'})
    await expect(pool.query("UPDATE association_notification_outbox SET status='pending' WHERE id=$1",[notification])).rejects.toMatchObject({code:'55000',message:'crm_delivery_retired'})
  })
  it('keeps shared notifications for another recipient as explicit blockers',async()=>{
    const f=await fixture(),id=await f.notification('pending',f.otherId),review=await f.preview()
    expect(review.blockers).toContainEqual({domain:'association_notification_outbox',reason:'shared_notification_dependency',count:1})
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
    expect((await pool.query('SELECT payload,status FROM association_notification_outbox WHERE id=$1',[id])).rows[0]).toMatchObject({status:'pending',payload:{message:'subject@example.com'}})
  })
  it('rolls back retirement if a later canonical dependency refuses deletion',async()=>{
    const f=await fixture(),id=await f.event(),notification=await f.notification(),review=await f.preview()
    await pool.query('CREATE TABLE fixture_notification_purge_guard(subject_id uuid REFERENCES entities(id) ON DELETE RESTRICT)')
    try {
      await pool.query('INSERT INTO fixture_notification_purge_guard VALUES($1)',[f.contactId])
      await expect(f.erase(review)).rejects.toMatchObject({details:{reason:'privacy_review_failed'}})
      expect((await pool.query('SELECT status,retired_at,payload FROM crm_domain_event_outbox WHERE id=$1',[id])).rows[0]).toMatchObject({status:'pending',retired_at:null,payload:{status:'original'}})
      expect((await pool.query('SELECT status,retired_at FROM association_notification_outbox WHERE id=$1',[notification])).rows[0]).toEqual({status:'pending',retired_at:null})
    }finally{await pool.query('DROP TABLE fixture_notification_purge_guard')}
  })
  it('captures durable workflow lineage and redacts run and step content in both export scopes',async()=>{
    const f=await fixture(),id=await f.event(),run=await f.run(id),step=randomUUID()
    await pool.query("UPDATE workflow_runs SET input='{}',vars=$2::jsonb,outcome=$3::jsonb WHERE id=$1",[run,JSON.stringify({private:"other@example.com"}),JSON.stringify({summary:"private copy"})])
    await pool.query(`INSERT INTO workflow_step_runs(id,run_id,step_id,step_type,input,output,error)
      VALUES($1,$2,'fixture','tool_call','{"argument":"private copy"}','{"result":"other@example.com"}','{"error":"private copy"}')`,[step,run])
    const review=await f.preview();expect(review.blockers).toContainEqual({domain:'workflow_runs',reason:'workflow_artifact_dependency',count:1});expect(review.domains).toContainEqual({domain:'workflow_step_runs',action:'delete',count:1})
    for(const subject of [f.contactId,undefined]){const data=await exported(f.context,subject);expect(data.workflow_runs).toMatchObject([{id:run,crm_event_id:id,input:{},vars:{},outcome:null,error:null}]);expect(data.workflow_step_runs).toMatchObject([{id:step,input:{},output:null,error:null}]);expect(JSON.stringify(data.workflow_runs)).not.toContain('other@example.com')}
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
    await expect(pool.query('UPDATE workflow_runs SET crm_event_id=NULL WHERE id=$1',[run])).rejects.toMatchObject({code:'55000'})
    await expect(pool.query('DELETE FROM crm_domain_event_outbox WHERE id=$1',[id])).rejects.toMatchObject({code:'23503'})
    await pool.query('DELETE FROM workflow_runs WHERE id=$1',[run])
    const ready=await f.preview();expect(ready.status).toBe('ready');await f.erase(ready)
    await expect(f.run(id)).rejects.toMatchObject({code:'55P03',message:'crm_privacy_source_unavailable'})
  })
  it('attributes a legacy orphan through exact typed CRM event fields',async()=>{
    const f=await fixture(),run=randomUUID()
    await pool.query('ALTER TABLE workflow_runs DISABLE TRIGGER crm_privacy_write_admission')
    try {await pool.query(`INSERT INTO workflow_runs(id,workflow_id,workspace_id,trigger_kind,input,privacy_lineage_version)
      VALUES($1,$2,$3,'event',$4,0)`,[run,f.workflowId,f.workspaceId,JSON.stringify(f.input(randomUUID()))])}
    finally{await pool.query('ALTER TABLE workflow_runs ENABLE TRIGGER crm_privacy_write_admission')}
    await expect(pool.query("UPDATE workflow_runs SET input='{}',trigger_kind='manual' WHERE id=$1",[run])).rejects.toMatchObject({code:'55000',message:'crm_workflow_source_immutable'})
    await expect(pool.query("UPDATE workflow_runs SET input=jsonb_set(input,'{event,contactId}',to_jsonb($2::text)) WHERE id=$1",[run,f.otherId])).rejects.toMatchObject({code:'55000',message:'crm_workflow_source_immutable'})
    expect((await f.preview()).blockers).toContainEqual({domain:'workflow_runs',reason:'workflow_legacy_lineage_dependency',count:1})
    await expect(f.legacy()).rejects.toMatchObject({details:{reason:'crm_copy_resolution_required'}})
  })
  it('refuses a new workflow from a retired event even in an older repeatable-read snapshot',async()=>{
    const f=await fixture(),id=await f.event(),client=await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query('SELECT id FROM crm_domain_event_outbox WHERE id=$1',[id])
      await f.erase(await f.preview())
      await expect(client.query(`INSERT INTO workflow_runs(workflow_id,workspace_id,trigger_kind,input)
        VALUES($1,$2,'event',$3)`,[f.workflowId,f.workspaceId,JSON.stringify(f.input(id))])).rejects.toMatchObject({code:'40001'})
    }finally{await client.query('ROLLBACK');client.release()}
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
  })
  it('rechecks current payload and fences an expired attempt even with the same worker id',async()=>{
    const f=await fixture(),id=await f.event(),first=await f.lease(id)
    await pool.query("UPDATE crm_domain_event_outbox SET leased_until=now()-interval '1 second',payload=$2::jsonb WHERE id=$1",[id,JSON.stringify({status:"updated"})])
    const skipped=vi.fn();expect(await outbox.dispatchLeased(first,'fixture_worker',skipped)).toBe('skipped')
    const second=await f.lease(id);expect(second.attempts).toBe(first.attempts+1)
    await outbox.markFailed(first,'fixture_worker',new Date());expect((await pool.query('SELECT status FROM crm_domain_event_outbox WHERE id=$1',[id])).rows[0].status).toBe('leased')
    expect(await outbox.dispatchLeased(first,'fixture_worker',skipped)).toBe('skipped');expect(skipped).not.toHaveBeenCalled()
    const current=vi.fn(async()=>{});expect(await outbox.dispatchLeased(second,'fixture_worker',current)).toBe('delivered')
    expect(current).toHaveBeenCalledWith(expect.objectContaining({payload:{status:'updated'}}))
  })
  it('holds privacy admission through actual workflow enqueue and the delivery receipt',async()=>{
    const f=await fixture(),id=await f.event(),lease=await f.lease(id),entered=latch(),release=latch()
    const dispatch=outbox.dispatchLeased(lease,'fixture_worker',async()=>{entered.resolve();await release.promise;await f.run(id)})
    await entered.promise
    try {await expect(f.legacy()).rejects.toMatchObject({details:{reason:'privacy_operation_busy'}})}finally{release.resolve()}
    expect(await dispatch).toBe('delivered')
    expect((await pool.query('SELECT status,delivered_at FROM crm_domain_event_outbox WHERE id=$1',[id])).rows[0]).toMatchObject({status:'delivered',delivered_at:expect.any(Date)})
    const ready=await f.preview();expect(ready.blockers).toEqual([]);await f.erase(ready)
    expect((await pool.query('SELECT privacy_erased FROM workflow_runs WHERE workspace_id=$1',[f.workspaceId])).rows[0].privacy_erased).toBe(true)
  })
  it('skips a privacy-held workspace while leasing another workspace',async()=>{
    const f=await fixture(),other=await fixture(),held=await f.event(),available=await other.event(),client=await pool.connect()
    try {
      await client.query('BEGIN');await acquireCrmPrivacyAdmission(client,f.workspaceId)
      const leased=await outbox.leaseBatch('scan_worker',50,60_000)
      expect(leased.filter(e=>e.workspaceId===f.workspaceId || e.workspaceId===other.workspaceId).map(e=>e.id)).toEqual([available]);expect(leased.some(e=>e.id===held)).toBe(false)
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('serializes run and step writes during privacy and preserves ordinary workflows afterward',async()=>{
    const f=await fixture(),other=await fixture(),id=await f.event(),foreign=await other.event(),run=await f.run(id),step=randomUUID(),client=await pool.connect()
    await pool.query("INSERT INTO workflow_step_runs(id,run_id,step_id,step_type) VALUES($1,$2,'fixture','tool_call')",[step,run])
    try {
      await client.query('BEGIN');await acquireCrmPrivacyAdmission(client,f.workspaceId)
      await expect(pool.query("UPDATE workflow_runs SET vars='{}' WHERE id=$1",[run])).rejects.toMatchObject({code:'55P03'})
      await expect(pool.query("UPDATE workflow_step_runs SET output='{}' WHERE id=$1",[step])).rejects.toMatchObject({code:'55P03'})
      await expect(pool.query("INSERT INTO workflow_runs(workflow_id,workspace_id,trigger_kind,input) VALUES($1,$2,'manual',$3)",[f.workflowId,f.workspaceId,JSON.stringify(f.input(randomUUID()))])).rejects.toMatchObject({code:'55P03'})
    }finally{await client.query('ROLLBACK');client.release()}
    await pool.query("INSERT INTO workflow_runs(workflow_id,workspace_id,trigger_kind,input) VALUES($1,$2,'manual',$3)",[f.workflowId,f.workspaceId,JSON.stringify(f.input(randomUUID()))])
    await expect(pool.query("INSERT INTO workflow_runs(workflow_id,workspace_id,trigger_kind,input) VALUES($1,$2,'event',$3)",[f.workflowId,f.workspaceId,JSON.stringify(f.input(foreign))])).rejects.toMatchObject({code:'55P03'})
    expect((await pool.query('SELECT id FROM workflow_runs WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(2)
  })
  it('applies the migration backfills only to verified legacy erasure markers and known CRM sources',async()=>{
    const sql=await readFile(new URL('../../../migrations/512_crm_outbox_retirement.sql',import.meta.url),'utf8'),client=await pool.connect()
    const workspace=randomUUID(),erased=randomUUID(),ordinary=randomUUID(),legacyRun=randomUUID(),unknownRun=randomUUID(),retiredRun=randomUUID()
    try {
      await client.query('BEGIN')
      for(const table of ['crm_domain_event_outbox','association_notification_outbox']) {
        await client.query(`CREATE TEMP TABLE ${table}(LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP`)
        await client.query(`ALTER TABLE ${table} DROP COLUMN retired_at CASCADE,DROP COLUMN retired_from_status CASCADE,DROP CONSTRAINT ${table}_status_check`)
        const statuses=table==='crm_domain_event_outbox'?"'pending','leased','delivered','failed'":"'pending','sending','sent','failed','suppressed'"
        await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_status_check CHECK(status IN(${statuses}))`)
      }
      await client.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,payload)
        VALUES($1,$3,'crm.consent.changed',$1::uuid::text,'contact',$4,'user','{"erased":true,"eventType":"crm.consent.changed"}'),
          ($2,$3,'crm.consent.changed',$2::uuid::text,'contact',$4,'user','{"erased":true,"eventType":"crm.consent.changed","other":"not an erasure receipt"}')`,[erased,ordinary,workspace,nil])
      const retirement=sql.slice(sql.indexOf('BEGIN;')+'BEGIN;'.length,sql.indexOf('CREATE FUNCTION public.crm_guard_retired_outbox'))
      await client.query(retirement)
      expect((await client.query('SELECT status,retired_from_status FROM crm_domain_event_outbox WHERE id=$1',[erased])).rows[0]).toEqual({status:'retired',retired_from_status:'pending'})
      expect((await client.query('SELECT status,retired_at FROM crm_domain_event_outbox WHERE id=$1',[ordinary])).rows[0]).toEqual({status:'pending',retired_at:null})
      await client.query('CREATE TEMP TABLE workflow_runs(LIKE public.workflow_runs INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP')
      await client.query('ALTER TABLE workflow_runs DROP COLUMN crm_event_id')
      for(const [run,event] of [[legacyRun,ordinary],[unknownRun,randomUUID()],[retiredRun,erased]])await client.query(`INSERT INTO workflow_runs(id,workflow_id,workspace_id,trigger_kind,input)
        VALUES($1,$1,$2,'event',$3)`,[run,workspace,JSON.stringify({trigger:{sourceType:'crm'},event:{domainEventId:event}})])
      const binding=sql.slice(sql.indexOf('CREATE UNIQUE INDEX crm_domain_event_workspace_id'),sql.indexOf('CREATE FUNCTION public.crm_privacy_guard_workflow_write'))
      await client.query(binding)
      expect((await client.query('SELECT crm_event_id FROM workflow_runs WHERE id=$1',[legacyRun])).rows[0].crm_event_id).toBe(ordinary)
      expect((await client.query('SELECT crm_event_id FROM workflow_runs WHERE id=$1',[unknownRun])).rows[0].crm_event_id).toBeNull()
      for(const id of [unknownRun,retiredRun])expect((await client.query('SELECT status,error FROM workflow_runs WHERE id=$1',[id])).rows[0]).toMatchObject({status:'failed',error:{code:'crm_privacy_source_unavailable'}})
      expect((await client.query('SELECT status FROM workflow_runs WHERE id=$1',[legacyRun])).rows[0].status).toBe('pending')
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('stores only a fixed failure reason and does not log the dispatcher payload',async()=>{
    const f=await fixture(),id=await f.event(),onError=vi.fn(),dispatcher={dispatchStrict:vi.fn(async()=>{throw new Error('Private subject@example.com payload')})}
    await createCrmDomainEventWorker({store:outbox,dispatcher,workerId:'retry_worker',onError}).tick()
    expect((await pool.query('SELECT status,last_error,attempts FROM crm_domain_event_outbox WHERE id=$1',[id])).rows[0]).toEqual({status:'failed',last_error:'CRM workflow dispatch failed',attempts:1})
    expect(onError.mock.calls[0][0].message).toBe('CRM workflow dispatch failed');expect(JSON.stringify(onError.mock.calls)).not.toContain('subject@example.com')
  })
})
