import {createHash,randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool,queryWithRLS} from '../client.js'
import {runWithAgentAccess} from '../agent-access-context.js'
import {CRM_PRIVACY_COVERAGE,crmPrivacyDomainSql} from '../../crm-operations/privacy-coverage.js'
import {prepareCrmPrivacyCopies} from '../../crm-operations/privacy-copy-resolver.js'

import express from 'express'
import request from 'supertest'
import {CrmOperationsCommandSchema,type CrmOperationsContext,type AssociationServicePort} from '@use-brian/core'
import {loadAssociationOrderScope} from '../../association/source-scope.js'
import {createCrmPrivacyService,readCrmErasureReview} from '../../crm-operations/privacy-previews.js'
import {exportCrmOperationsPrivacy} from '../../crm-operations/privacy.js'
import {streamCrmPrivacyExport} from '../../crm-operations/privacy-export.js'
import {createCrmIntegrationStore} from '../crm-integration-store.js'
import {createCrmOperationsService} from '../../crm-operations/service.js'
import {createDbCrmOperationsStore} from '../crm-operations-store.js'
import {createSoftDeleteStore} from '../soft-delete-store.js'
import {createWorkspaceStore} from '../workspace-store.js'
import {createDbCrmIntakeReadStore} from '../crm-intake-store.js'
import {crmIntegrationContext,crmIntegrationRoutes} from '../../routes/crm-integration.js'
import {crmOperationsRoutes} from '../../routes/crm-operations.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool()
const keys=createCrmIntegrationStore(),operations=createCrmOperationsService(createDbCrmOperationsStore())
const ownEmail='subject@example.com',otherEmail='unrelated@example.com'
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID(),otherId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Privacy fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  for(const [id,name,email] of [[contactId,'Subject person',ownEmail],[otherId,'Unrelated person',otherEmail]])
    await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source,attributes) VALUES($1,$2,'person',$3,$4,$5,'manual',$6)",[id,workspaceId,name,email,userId,JSON.stringify({email,custom_fields:{reference:'subject fixture'}})])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}}
  const issue=async(exportGrant=true)=>{
    const key=await keys.create(workspaceId,userId,{label:'Privacy reader',expiresAt:'2099-01-01T00:00:00Z',grants:[{operation:exportGrant?'crm.privacy.export':'crm.records.read',selectors:{}}]})
    return {key,context:crmIntegrationContext((await keys.authenticate(key.oneTimeSecret))!)}
  }
  return {workspaceId,userId,contactId,otherId,context,issue}
}
type ExportLine={type:string;domain?:string;record?:Record<string,unknown>;[key:string]:unknown}
async function collect(context:CrmOperationsContext,contactId?:string) {
  const lines:string[]=[]
  for await(const line of streamCrmPrivacyExport(context,{contactId}))lines.push(line)
  return {lines,values:lines.map(line=>JSON.parse(line) as ExportLine),text:lines.join('')}
}
const records=(result:{values:ExportLine[]},domain:string)=>result.values.filter(v=>v.type==='record'&&v.domain===domain).map(v=>v.record!)
const hash=(lines:string[])=>createHash('sha256').update(lines.join('')).digest('hex')
async function activity(f:Awaited<ReturnType<typeof fixture>>,count=1) {
  await pool.query("INSERT INTO crm_activities(workspace_id,entity_id,activity_type,summary) SELECT $1,$2,'note','Note '||n FROM generate_series(1,$3::int) n",[f.workspaceId,f.contactId,count])
}
async function receipt(f:Awaited<ReturnType<typeof fixture>>,shared:boolean) {
  const id=randomUUID(),envelope={kind:'send_message',deliveryId:id,connectorInstanceId:randomUUID(),purposeKey:'updates',to:[ownEmail],cc:[],bcc:shared?[otherEmail]:[],subject:shared?'Shared private subject':'Subject message',body:shared?'Unrelated private payload':'Subject private payload',attachments:[]}
  const evidence=await loadAssociationOrderScope(pool,f.workspaceId,shared?[f.contactId,f.otherId]:[f.contactId])
  await pool.query(`INSERT INTO crm_delivery_receipts(workspace_id,delivery_id,request_hash,connector_instance_id,provider_key,purpose_key,actor_kind,actor_credential_id,envelope,status,claim_token,claim_deadline,accepted_at,provider_receipt,scope_snapshot,scope_sources) VALUES($1,$2,$3,$4,'fixture','updates','user',$5,$6,'sent',$7,now(),now(),'{"evidence":"provider_accepted","messageId":"fixture-message"}',$8::jsonb,$9::jsonb)`,[f.workspaceId,id,'a'.repeat(64),envelope.connectorInstanceId,f.userId,JSON.stringify(envelope),randomUUID(),JSON.stringify(evidence.scope),JSON.stringify(evidence.sources)])
  for(const contact of shared?[f.contactId,f.otherId]:[f.contactId])await pool.query('INSERT INTO crm_delivery_receipt_contacts(workspace_id,delivery_id,contact_id) VALUES($1,$2,$3)',[f.workspaceId,id,contact])
  return id
}

describe('[COMP:crm/privacy-export] Actual privacy projection coverage',()=>{
  afterAll(async()=>{await pool.end();await appPool.end()})
  it('executes every declared workspace and contact projection against the actual migrated schema',async()=>{
    const client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('CREATE TEMP TABLE crm_privacy_suppression_matches(channel text,key_version text,address_hmac text) ON COMMIT DROP')
      await prepareCrmPrivacyCopies(client,randomUUID(),null)
      const errors:string[]=[]
      for(const scope of ['workspace','contact'] as const)for(const entry of CRM_PRIVACY_COVERAGE) {
        await client.query('SAVEPOINT projection')
        try {await client.query(crmPrivacyDomainSql(entry,scope),[randomUUID(),randomUUID()])}
        catch(error) {errors.push(entry.domain+' / '+scope+': '+(error instanceof Error?error.message:'Unknown query error'))}
        finally {await client.query('ROLLBACK TO SAVEPOINT projection')}

      }
      expect(errors).toEqual([])
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('classifies every physical CRM/association table column so schema changes cannot silently bypass coverage',async()=>{
    const actual=(await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND (table_name LIKE 'crm_%' OR table_name LIKE 'association_%' OR table_name IN('workflow_runs','workflow_step_runs','workflow_run_copy_sources')) ORDER BY table_name,ordinal_position")).rows
    for(const row of actual) {
      const entry=CRM_PRIVACY_COVERAGE.find(e=>e.domain===row.table_name)
      expect(entry?.columns,'Unclassified '+row.table_name+'.'+row.column_name).toContain(row.column_name)
    }
  })
  it('traverses more than 100 records, preserves custom fields, and verifies every exact-byte checksum',async()=>{
    const f=await fixture()
    await activity(f,135)
    const output=await collect(f.context,f.contactId),manifest=output.values.at(-1)!
    expect(output.values[0]).toMatchObject({type:'header',schema:'crm-privacy-v2',scope:'contact',contactId:f.contactId})
    expect(records(output,'crm_activities')).toHaveLength(135)
    for(const row of records(output,'crm_activities')) {
      for(const column of ['user_id','assistant_id','sensitivity','compartments','project_ids','source_scope_version','scope_origin','scope_held'])
        expect(row).not.toHaveProperty(column)
    }
    expect(records(output,'entities')).toMatchObject([{id:f.contactId,attributes:{custom_fields:{reference:'subject fixture'}}}])
    const recordLines=output.lines.filter(line=>JSON.parse(line).type==='record')
    expect(manifest).toMatchObject({type:'manifest',complete:true,totalRecords:recordLines.length,sha256:hash(recordLines)})
    const coverage=manifest.coverage as {domain:string;count:number;sha256:string;classification:string}[]
    expect(coverage).toHaveLength(CRM_PRIVACY_COVERAGE.length)
    for(const entry of coverage) {
      const lines=recordLines.filter(line=>JSON.parse(line).domain===entry.domain)
      expect(entry).toMatchObject({count:lines.length,sha256:hash(lines)})
    }
    expect(coverage.find(e=>e.domain==='crm_integration_credentials')?.classification).toBe('excluded')
  })
  it('exports submission attachment metadata and digest without bulk-exporting image bytes',async()=>{
    const f=await fixture(),submissionId=randomUUID(),attachmentId=randomUUID()
    const evidence=await loadAssociationOrderScope(pool,f.workspaceId,[f.contactId])
    await pool.query(`INSERT INTO association_enquiries(id,workspace_id,contact_id,source,source_submission_id,request_fingerprint,subject,message,submitted_data,scope_snapshot,scope_sources)
      VALUES($1::uuid,$2,$3,'fixture',$1::uuid::text,repeat('a',64),'Fixture submission','Fixture message','{}',$4::jsonb,$5::jsonb)`,
      [submissionId,f.workspaceId,f.contactId,JSON.stringify(evidence.scope),JSON.stringify(evidence.sources)])
    const bytes=Buffer.from('normalized private image bytes')
    await pool.query(`INSERT INTO association_submission_attachments(
      id,workspace_id,submission_id,attachment_key,original_name,mime_type,content_bytes,size_bytes,sha256)
      VALUES($1,$2,$3,'business_card','card.png','image/png',$4,$5,repeat('b',64))`,
    [attachmentId,f.workspaceId,submissionId,bytes,bytes.length])
    const output=await collect(f.context,f.contactId)
    expect(records(output,'association_submission_attachments')).toMatchObject([{
      id:attachmentId,submission_id:submissionId,attachment_key:'business_card',
      original_name:'card.png',mime_type:'image/png',size_bytes:bytes.length,sha256:'b'.repeat(64),
    }])
    expect(records(output,'association_submission_attachments')[0]).not.toHaveProperty('content_bytes')
    expect(output.text).not.toContain(bytes.toString('base64'))
  })
  it('pins the snapshot before the first byte, including domains fetched after concurrent updates',async()=>{
    const f=await fixture();await activity(f)
    const stream=streamCrmPrivacyExport(f.context,{contactId:f.contactId}),first=await stream.next(),lines=[first.value!]
    const changed=pool.query("UPDATE entities SET display_name='Changed after snapshot' WHERE id=$1",[f.contactId])
    await activity(f,2)
    for await(const line of stream)lines.push(line)
    await changed
    const result={values:lines.map(line=>JSON.parse(line))}
    expect(records(result,'entities')[0]?.display_name).toBe('Subject person')
    expect(records(result,'crm_activities')).toHaveLength(1)
    expect((await collect(f.context,f.contactId)).text).toContain('Changed after snapshot')
  })
  it('retains shared financial context without exposing another attendee or losing bigint precision',async()=>{
    const f=await fixture(),eventId=randomUUID(),ticketId=randomUUID(),orderId=randomUUID(),lineId=randomUUID()
    await pool.query("INSERT INTO association_events(id,workspace_id,slug,title,starts_at,ends_at,timezone,mode) VALUES($1,$2,'fixture','Fixture event',now(),now()+interval '1 hour','UTC','venue')",[eventId,f.workspaceId])
    await pool.query("INSERT INTO association_ticket_types(id,workspace_id,event_id,ticket_key,name,currency,price_minor) VALUES($1,$2,$3,'fixture','Fixture ticket','USD',10)",[ticketId,f.workspaceId,eventId])
    await pool.query("INSERT INTO association_orders(id,workspace_id,contact_id,idempotency_key,request_fingerprint,currency,subtotal_minor,total_minor,metadata) VALUES($1,$2,$3,'fixture',$4,'USD',9007199254740993,9007199254740993,$5)",[orderId,f.workspaceId,f.otherId,'a'.repeat(64),JSON.stringify({name:'Unrelated person',email:otherEmail})])
    await pool.query("INSERT INTO association_order_lines(id,workspace_id,order_id,ticket_id,quantity,unit_price_minor,line_total_minor,pricing_basis) VALUES($1,$2,$3,$4,2,10,20,'public')",[lineId,f.workspaceId,orderId,ticketId])
    for(const [contactId,name,email] of [[f.contactId,'Subject person',ownEmail],[f.otherId,'Unrelated person',otherEmail]])
      await pool.query("INSERT INTO association_registrations(workspace_id,order_id,order_line_id,event_id,ticket_id,attendee_contact_id,attendee_name,attendee_email,source_kind,source_id,request_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'commerce',$3::uuid::text,repeat('a',64))",[f.workspaceId,orderId,lineId,eventId,ticketId,contactId,name,email])
    const evidence=await loadAssociationOrderScope(pool,f.workspaceId,[f.contactId,f.otherId])
    for(const table of ['association_orders','association_registrations'])await pool.query(`UPDATE ${table} SET scope_snapshot=$2::jsonb,scope_sources=$3::jsonb WHERE workspace_id=$1`,[f.workspaceId,JSON.stringify(evidence.scope),JSON.stringify(evidence.sources)])
    const output=await collect(f.context,f.contactId)
    expect(records(output,'association_orders')).toMatchObject([{id:orderId,contact_id:null,metadata:{}}])
    expect(records(output,'association_registrations')).toHaveLength(2)
    expect(output.text).toContain('9007199254740993')
    for(const value of [f.otherId,otherEmail,'Unrelated person'])expect(output.text).not.toContain(value)
    expect((await collect(f.context)).text).toContain(otherEmail)
  })
  it('isolates each draft version and delivery envelope, including Bcc recipients',async()=>{
    const f=await fixture(),draftId=randomUUID()
    await pool.query("INSERT INTO crm_email_drafts(id,workspace_id,to_addresses,bcc_addresses,subject,body,attachment_refs) VALUES($1,$2,$3,$4,'Shared draft','Unrelated private draft',ARRAY['private-file'])",[draftId,f.workspaceId,[ownEmail],[otherEmail]])
    await pool.query("INSERT INTO crm_email_draft_versions(workspace_id,draft_id,revision,to_addresses,body,attachment_refs) VALUES($1,$2,1,$3,'Own historical draft',ARRAY['own-file'])",[f.workspaceId,draftId,[ownEmail.toUpperCase()]])
    const own=await receipt(f,false),shared=await receipt(f,true)
    const output=await collect(f.context,f.contactId)
    expect(records(output,'crm_email_drafts')).toMatchObject([{to_addresses:[ownEmail],bcc_addresses:[],body:null,attachment_refs:[]}])
    expect(records(output,'crm_email_draft_versions')).toMatchObject([{body:'Own historical draft',attachment_refs:['own-file']}])
    expect(records(output,'crm_delivery_receipts').find(r=>r.delivery_id===own)).toMatchObject({envelope:{body:'Subject private payload'}})
    expect(records(output,'crm_delivery_receipts').find(r=>r.delivery_id===shared)).toMatchObject({envelope:{to:[ownEmail],bcc:[],body:null,subject:null,attachments:null},provider_receipt:null,status:'sent'})
    for(const value of [otherEmail,'Unrelated private','private-file'])expect(output.text).not.toContain(value)
    for(const row of records(output,'crm_delivery_receipts')) {expect(row).not.toHaveProperty('request_hash');expect(row).not.toHaveProperty('claim_token')}
  })
  it('includes explicit tasks and redacts shared payloads without treating free-text ids as attribution',async()=>{
    const f=await fixture(),own=randomUUID(),shared=randomUUID(),mention=randomUUID()
    for(const [id,title,attributes] of [[own,'Own task',{crm_contact_id:f.contactId}],[shared,'Unrelated private task',{}],[mention,'Mention '+f.contactId,{}]])
      await pool.query("INSERT INTO tasks(id,workspace_id,title,user_id,attributes) VALUES($1,$2,$3,$4,$5)",[id,f.workspaceId,title,f.userId,JSON.stringify(attributes)])
    await pool.query("INSERT INTO entity_link_types(edge_type,description) VALUES('privacy_fixture','Privacy fixture relationship') ON CONFLICT DO NOTHING")
    for(const contact of [f.contactId,f.otherId])await pool.query("INSERT INTO entity_links(workspace_id,source_kind,source_id,target_kind,target_id,edge_type,source,user_id) VALUES($1,'task',$2,'entity',$3,'privacy_fixture','manual',$4)",[f.workspaceId,shared,contact,f.userId])
    const output=await collect(f.context,f.contactId)
    expect(records(output,'tasks')).toHaveLength(2)
    expect(records(output,'tasks').find(r=>r.id===own)?.title).toBe('Own task')
    expect(records(output,'tasks').find(r=>r.id===shared)).toMatchObject({title:null,attributes:null})
    expect(output.text).not.toContain(mention)
    expect(output.text).not.toContain('Unrelated private task')
    expect(output.text).not.toContain(f.otherId)
  })
  it('refuses a workspace bundle containing a key-sourced raw import bound to a department the exporter lacks',async()=>{
    const f=await fixture(),dept=randomUUID(),custodian=randomUUID(),sourceId=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[custodian])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,custodian])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional export department',$3,'team',$1::text,$4)",[dept,f.workspaceId,custodian,`team:${dept}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional export department','team',$3)",[f.workspaceId,`team:${dept}`,dept])
    const edge=()=>pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING",[f.workspaceId,dept,f.userId])
    // The key is issued bound to the department; its raw source bytes inherit that binding.
    await edge()
    const key=await keys.create(f.workspaceId,f.userId,{label:'Fictional bound importer',expiresAt:'2099-01-01T00:00:00Z',requestId:randomUUID(),
      grants:[{operation:'crm.imports.write',selectors:{}}],departmentBinding:{departmentIds:[dept],cap:'confidential'}})
    await pool.query("INSERT INTO crm_import_sources(id,workspace_id,source_key,content_bytes,source_hash,credential_id,integration_grants) VALUES($1,$2,$3,$4,repeat('c',64),$5,'[]')",
      [sourceId,f.workspaceId,randomUUID(),Buffer.from('Name\nFictional departmental person\n'),key.id])
    await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2 AND department_id=$3',[f.workspaceId,f.userId,dept])
    await expect(collect(f.context)).rejects.toMatchObject({code:'not_authorized'})
    await edge()
    expect(records(await collect(f.context),'crm_import_sources').map(row=>row.id)).toContain(sourceId)
  })
  it('exports attributed import lineage with shared raw source redaction and explicitly excludes unattributed failed rows',async()=>{
    const f=await fixture(),{key}=await f.issue(),sourceId=randomUUID(),jobId=randomUUID(),confirmationKey=randomUUID(),bytes=Buffer.from('Name,Email\nSubject person,subject@example.com\nUnrelated person,unrelated@example.com\n')
    await pool.query("INSERT INTO crm_import_sources(id,workspace_id,source_key,content_bytes,source_hash,credential_id,integration_grants) VALUES($1,$2,$3,$4,$5,$6,'[]')",[sourceId,f.workspaceId,randomUUID(),bytes,hash([bytes.toString()]),key.id])
    await pool.query("INSERT INTO crm_import_jobs(id,workspace_id,source_id,integration_credential_id,integration_grants,entity_kind,mapping,mapping_hash,source_hash,total_rows,confirmation_key) VALUES($1,$2,$3,$4,'[]','contact','{}',$5,$5,3,$6)",[jobId,f.workspaceId,sourceId,key.id,'a'.repeat(64),confirmationKey])
    for(const [row,entity] of [[1,f.contactId],[2,f.otherId],[3,null]])await pool.query("INSERT INTO crm_import_rows(workspace_id,job_id,row_number,input_hash,status,entity_id) VALUES($1,$2,$3,$4,$5,$6)",[f.workspaceId,jobId,row,'a'.repeat(64),entity?'completed':'failed',entity])
    await pool.query("UPDATE crm_import_rows SET result_refs=$1 WHERE workspace_id=$2 AND job_id=$3 AND row_number=1",[JSON.stringify([{kind:'contact',id:f.contactId}]),f.workspaceId,jobId])
    await pool.query("INSERT INTO crm_import_errors(workspace_id,job_id,row_number,error_code,message,row_snapshot) VALUES($1,$2,3,'invalid_input','Unattributed input',$3)",[f.workspaceId,jobId,JSON.stringify({email:otherEmail})])
    const output=await collect(f.context,f.contactId)
    expect(records(output,'crm_import_jobs')).toMatchObject([{id:jobId,confirmation_key:null}])
    expect(records(output,'crm_import_rows')).toMatchObject([{row_number:1,entity_id:f.contactId,result_refs:[{kind:'contact',id:f.contactId}]}])
    expect(records(output,'crm_import_errors')).toEqual([])
    expect(records(output,'crm_import_sources')).toMatchObject([{id:sourceId,content_bytes:null,integration_grants:null}])
    const workspace=await collect(f.context)
    expect(records(workspace,'crm_import_jobs')).toMatchObject([{id:jobId,confirmation_key:confirmationKey}])
    const source=records(workspace,'crm_import_sources')[0]!.content_bytes as {encoding:string;data:string}
    expect(Buffer.from(source.data,'base64')).toEqual(bytes)
    for(const row of records(workspace,'crm_integration_credentials'))expect(row).not.toHaveProperty('secret_hash')
    expect(workspace.text).not.toContain(key.oneTimeSecret)
  })
  it('requires live owner/admin membership and never honors a forged workspace or session role',async()=>{
    const f=await fixture(),other=await fixture()
    await expect(exportCrmOperationsPrivacy({...f.context,workspaceId:other.workspaceId})).rejects.toMatchObject({code:'not_authorized'})
    await expect(collect({...f.context,workspaceId:other.workspaceId})).rejects.toMatchObject({code:'not_authorized'})
    await expect(collect(f.context,other.contactId)).rejects.toMatchObject({code:'not_found'})
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    await expect(collect(f.context)).rejects.toMatchObject({code:'not_authorized'})
  })
  it('checks CRM company roots past the first page before emitting a workspace header',async()=>{
    const f=await fixture(),other=await fixture(),hidden='ffffffff-'+randomUUID().slice(9)
    await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) SELECT ('00000000-'||substring(gen_random_uuid()::text,10))::uuid,$1,'company','Fictional paged company',$2,'manual' FROM generate_series(1,256)",[f.workspaceId,f.userId])
    await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,user_id,created_by_user_id,source) VALUES($1,$2,'company','Fictional private company',$3,$3,'manual')",[hidden,f.workspaceId,other.userId])
    await expect(streamCrmPrivacyExport(f.context).next()).rejects.toMatchObject({code:'not_authorized'})
    await expect(exportCrmOperationsPrivacy(f.context)).rejects.toMatchObject({code:'not_authorized'})
  },60_000)
  it('preserves historical CRM root protection and refuses unresolved held scope',async()=>{
    const f=await fixture(),historical=randomUUID()
    await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,valid_to) VALUES($1,$2,'company','Fictional historical company',$3,'manual',now())",[historical,f.workspaceId,f.userId])
    expect(records(await collect(f.context),'entities').some(row=>row.id===historical)).toBe(true)
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[historical])
    await expect(streamCrmPrivacyExport(f.context).next()).rejects.toMatchObject({code:'not_authorized'})
    await expect(exportCrmOperationsPrivacy(f.context)).rejects.toMatchObject({code:'not_authorized'})
  })
  it('denies a hidden contact before emitting any export header',async()=>{
    const f=await fixture(),departmentId=randomUUID(),departmentOwner=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[departmentOwner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,departmentOwner])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional export department',$3,'team',$1::text,$4)",[departmentId,f.workspaceId,departmentOwner,`team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional export department','team',$3)",[f.workspaceId,`team:${departmentId}`,departmentId])
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[f.contactId,[`team:${departmentId}`]])
    await expect(exportCrmOperationsPrivacy(f.context)).rejects.toMatchObject({code:'not_authorized'})
    for(const contactId of [f.contactId,undefined]) {
      const stream=streamCrmPrivacyExport(f.context,{contactId})
      await expect(stream.next()).rejects.toMatchObject({code:'not_authorized'})
      expect(await stream.next()).toMatchObject({done:true})
    }
  })
  it.each(['workspace_files','entity_links','tasks'] as const)('requires independent %s scope for redacted inventory and erasure review',async table=>{
    const f=await fixture(),departmentId=randomUUID(),departmentOwner=randomUUID(),file=randomUUID(),link=randomUUID(),task=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[departmentOwner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,departmentOwner])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional inventory department',$3,'team',$1::text,$4)",[departmentId,f.workspaceId,departmentOwner,`team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional inventory department','team',$3)",[f.workspaceId,`team:${departmentId}`,departmentId])
    await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id) VALUES($1,$2,'/fixture.txt','fixture.txt','fixture://inventory',$3)",[file,f.workspaceId,f.userId])
    await pool.query("INSERT INTO entity_link_types(edge_type,description) VALUES('privacy_fixture','Privacy fixture relationship') ON CONFLICT DO NOTHING")
    await pool.query("INSERT INTO entity_links(id,workspace_id,source_kind,source_id,target_kind,target_id,edge_type,source,user_id) VALUES($1,$2,'file',$3,'entity',$4,'privacy_fixture','manual',$5)",[link,f.workspaceId,file,f.contactId,f.userId])
    await pool.query("INSERT INTO tasks(id,workspace_id,title,user_id,attributes) VALUES($1,$2,'Fictional inventory task',$3,$4)",[task,f.workspaceId,f.userId,{crm_contact_id:f.contactId}])
    const id=table==='workspace_files'?file:table==='entity_links'?link:task,privacy=createCrmPrivacyService()
    const earlier=await privacy.preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})
    await pool.query(`UPDATE ${table} SET sensitivity='confidential',compartments=$2 WHERE id=$1`,[id,[`team:${departmentId}`]])
    for(const contactId of [f.contactId,undefined])await expect(collect(f.context,contactId)).rejects.toMatchObject({code:'not_authorized'})
    await expect(exportCrmOperationsPrivacy(f.context)).rejects.toMatchObject({code:'not_authorized'})
    await expect(privacy.preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})).rejects.toMatchObject({code:'not_authorized'})
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,departmentId,f.userId])
    await expect(readCrmErasureReview(f.context,earlier.id)).rejects.toMatchObject({code:'conflict',details:{reason:'privacy_preview_stale'}})
    const preview=await privacy.preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})
    expect((await pool.query('SELECT scope_snapshot FROM crm_privacy_previews WHERE id=$1',[preview.id])).rows[0].scope_snapshot.compartments).toEqual([`team:${departmentId}`])
    expect(records(await collect(f.context,f.contactId),table).some(row=>row.id===id)).toBe(true)
    const stream=streamCrmPrivacyExport(f.context,{contactId:f.contactId})
    expect(JSON.parse((await stream.next()).value!).type).toBe('header')
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[departmentId,f.userId])
    await expect(stream.next()).rejects.toMatchObject({code:'not_authorized'})
    await expect(readCrmErasureReview(f.context,preview.id)).rejects.toMatchObject({code:'not_authorized'})
    await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[departmentId,f.userId])
    await pool.query(`UPDATE ${table} SET scope_held=true WHERE id=$1`,[id])
    await expect(collect(f.context,f.contactId)).rejects.toMatchObject({code:'not_authorized'})
    expect((await pool.query('SELECT id FROM entities WHERE id=$1',[f.contactId])).rowCount).toBe(1)
  },60_000)
  it('preserves a linked membership floor and stops streaming after its department grant expires',async()=>{
    const f=await fixture(),departmentId=randomUUID(),departmentOwner=randomUUID(),plan=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[departmentOwner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,departmentOwner])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional saved export department',$3,'team',$1::text,$4)",[departmentId,f.workspaceId,departmentOwner,`team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional saved export department','team',$3)",[f.workspaceId,`team:${departmentId}`,departmentId])
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[f.contactId,[`team:${departmentId}`]])
    const evidence=await loadAssociationOrderScope(pool,f.workspaceId,[f.contactId])
    await pool.query("INSERT INTO association_membership_plans(id,workspace_id,plan_key,name,currency,fee_minor,billing_period) VALUES($1,$2,'export','Fictional export plan','USD',0,'manual')",[plan,f.workspaceId])
    await pool.query("INSERT INTO association_memberships(workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,starts_at,scope_snapshot,scope_sources) VALUES($1,$2,$3,'export',repeat('a',64),now(),$4::jsonb,$5::jsonb)",[f.workspaceId,f.contactId,plan,JSON.stringify(evidence.scope),JSON.stringify(evidence.sources)])
    await pool.query("UPDATE entities SET sensitivity='internal',compartments='{}' WHERE id=$1",[f.contactId])
    await expect(collect(f.context,f.contactId)).rejects.toMatchObject({code:'not_authorized'})
    await expect(collect(f.context)).rejects.toMatchObject({code:'not_authorized'})
    await expect(exportCrmOperationsPrivacy(f.context)).rejects.toMatchObject({code:'not_authorized'})
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,departmentId,f.userId])
    expect((await exportCrmOperationsPrivacy(f.context)).tables.association_memberships).toHaveLength(1)
    for(const contactId of [f.contactId,undefined]) {
      await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[departmentId,f.userId])
      expect((await collect(f.context,contactId)).values.at(-1)?.complete).toBe(true)
      const stream=streamCrmPrivacyExport(f.context,{contactId})
      expect(JSON.parse((await stream.next()).value!).type).toBe('header')
      await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[departmentId,f.userId])
      await expect(stream.next()).rejects.toMatchObject({code:'not_authorized'})
      expect(await stream.next()).toMatchObject({done:true})
    }
    expect((await pool.query('SELECT id FROM entities WHERE id=$1',[f.contactId])).rowCount).toBe(1)
  },60_000)
  it('renews bound assistant Project scope before privacy export and between stream records', async () => {
    const f = await fixture(), project = randomUUID(), assistantId = randomUUID()
    await pool.query('INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$3,lower($3),$4)', [project, f.workspaceId, 'Fictional export project', f.userId])
    await pool.query('UPDATE entities SET project_ids=ARRAY[$2::uuid] WHERE id=$1', [f.contactId, project])
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance,project_scope_mode) VALUES($1,$2,'Fictional export assistant','primary','internal','all')", [assistantId, f.workspaceId])
    const key = await keys.create(f.workspaceId, f.userId, { label: 'Fictional bound export', expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ operation: 'crm.privacy.export', selectors: {} }], departmentBinding: { departmentIds: [], cap: 'internal', assistantId } })
    const context = crmIntegrationContext((await keys.authenticate(key.oneTimeSecret))!)
    expect(records(await collect(context, f.contactId), 'entities')).toMatchObject([{ id: f.contactId }])
    const stream = streamCrmPrivacyExport(context, { contactId: f.contactId })
    try {
      expect(JSON.parse((await stream.next()).value!).type).toBe('header')
      await pool.query("UPDATE assistants SET project_scope_mode='assigned' WHERE id=$1", [assistantId])
      await expect(stream.next()).rejects.toMatchObject({ code: 'not_authorized' })
      expect((await stream.next()).done).toBe(true)
    } finally { await stream.return(undefined) }
    await expect(collect(context, f.contactId)).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query('INSERT INTO assistant_project_grants(assistant_id,project_id,added_by_user_id) VALUES($1,$2,$3)', [assistantId, project, f.userId])
    expect(records(await collect(context, f.contactId), 'entities')).toMatchObject([{ id: f.contactId }])
  })

  it('preserves checkout floors for bound integration exports and renews issuer edges during streaming',async()=>{
    const f=await fixture(),departmentId=randomUUID(),custodian=randomUUID(),plan=randomUUID(),promotion=randomUUID(),checkout=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[custodian])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,custodian])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)",[departmentId,f.workspaceId,custodian,`team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)",[f.workspaceId,`team:${departmentId}`,departmentId])
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[f.contactId,[`team:${departmentId}`]])
    const evidence=await loadAssociationOrderScope(pool,f.workspaceId,[f.contactId])
    await pool.query("INSERT INTO association_membership_plans(id,workspace_id,plan_key,name,currency,fee_minor,billing_period) VALUES($1,$2,'export','Fictional export plan','USD',100,'manual')",[plan,f.workspaceId])
    await pool.query("INSERT INTO association_promotions(id,workspace_id,promotion_key,name,code_digest,discount_type,target_kind,target_ids) VALUES($1,$2,'export','Fictional export promotion',repeat('a',64),'full','plan',$3)",[promotion,f.workspaceId,[plan]])
    await pool.query(`INSERT INTO association_membership_checkouts(id,workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,
      currency,subtotal_minor,discount_minor,total_minor,promotion_id,promotion_snapshot,reservation_expires_at,scope_snapshot,scope_sources)
      VALUES($1,$2,$3,$4,'export',repeat('a',64),'USD',100,100,0,$5,'{}',now()+interval '1 hour',$6::jsonb,$7::jsonb)`,
      [checkout,f.workspaceId,f.contactId,plan,promotion,JSON.stringify(evidence.scope),JSON.stringify(evidence.sources)])
    await pool.query("UPDATE entities SET sensitivity='internal',compartments='{}' WHERE id=$1",[f.contactId])
    const general=await f.issue()
    for(const contactId of [f.contactId,undefined]) {
      await expect(collect(f.context,contactId)).rejects.toMatchObject({code:'not_authorized'})
      await expect(collect(general.context,contactId)).rejects.toMatchObject({code:'not_authorized'})
    }
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,departmentId,f.userId])
    const key=await keys.create(f.workspaceId,f.userId,{label:'Cedar privacy reader',expiresAt:'2099-01-01T00:00:00Z',
      grants:[{operation:'crm.privacy.export',selectors:{}}],departmentBinding:{departmentIds:[departmentId],cap:'confidential'}})
    const context=crmIntegrationContext((await keys.authenticate(key.oneTimeSecret))!)
    await expect(collect(general.context,f.contactId)).rejects.toMatchObject({code:'not_authorized'})
    for(const contactId of [f.contactId,undefined]) {
      await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[departmentId,f.userId])
      const output=await collect(context,contactId)
      expect(records(output,'association_membership_checkouts')).toMatchObject([{id:checkout}])
      expect(records(output,'association_membership_checkouts')[0]).not.toHaveProperty('scope_snapshot')
      expect(records(output,'association_membership_checkouts')[0]).not.toHaveProperty('scope_sources')
      for(const row of records(output,'crm_integration_credentials'))expect(row).not.toHaveProperty('department_binding')
      const stream=streamCrmPrivacyExport(context,{contactId})
      try {
        expect(JSON.parse((await stream.next()).value!).type).toBe('header')
        await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[departmentId,f.userId])
        await expect(stream.next()).rejects.toMatchObject({code:'not_authorized'})
        expect((await stream.next()).done).toBe(true)
      }finally{await stream.return(undefined)}
    }
    await expect(createCrmPrivacyService().preview(context,{kind:'preview_contact_erasure',contactId:f.contactId})).rejects.toMatchObject({code:'not_authorized'})
  })
  it('preserves activity protection across contact reclassification, export revocation and consumed erasure receipts',async()=>{
    const f=await fixture(),departmentId=randomUUID(),departmentOwner=randomUUID(),activityId='ffffffff-'+randomUUID().slice(9)
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[departmentOwner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,departmentOwner])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional saved export department',$3,'team',$1::text,$4)",[departmentId,f.workspaceId,departmentOwner,`team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional saved export department','team',$3)",[f.workspaceId,`team:${departmentId}`,departmentId])
    const privacy=createCrmPrivacyService()
    const earlier=await privacy.preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})
    await pool.query("INSERT INTO crm_activities(id,workspace_id,entity_id,activity_type,summary) SELECT ('00000000-'||substring(gen_random_uuid()::text,10))::uuid,$1,$2,'note','Fictional General history' FROM generate_series(1,256)",[f.workspaceId,f.contactId])
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[f.contactId,[`team:${departmentId}`]])
    await pool.query("INSERT INTO crm_activities(id,workspace_id,entity_id,activity_type,summary) VALUES($1,$2,$3,'note','Fictional protected history')",[activityId,f.workspaceId,f.contactId])
    await pool.query("UPDATE entities SET sensitivity='internal',compartments='{}' WHERE id=$1",[f.contactId])
    await expect(privacy.preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})).rejects.toMatchObject({code:'not_authorized'})
    await expect(collect(f.context,f.contactId)).rejects.toMatchObject({code:'not_authorized'})
    await expect(collect(f.context)).rejects.toMatchObject({code:'not_authorized'})
    await expect(exportCrmOperationsPrivacy(f.context)).rejects.toMatchObject({code:'not_authorized'})
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,departmentId,f.userId])
    await expect(readCrmErasureReview(f.context,earlier.id)).rejects.toMatchObject({code:'conflict',details:{reason:'privacy_preview_stale'}})
    expect((await exportCrmOperationsPrivacy(f.context)).schema).toBe('crm-operations-privacy-v1')
    for(const contactId of [f.contactId,undefined]) {
      await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[departmentId,f.userId])
      expect((await collect(f.context,contactId)).values.at(-1)?.complete).toBe(true)
      const stream=streamCrmPrivacyExport(f.context,{contactId})
      expect(JSON.parse((await stream.next()).value!).type).toBe('header')
      await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[departmentId,f.userId])
      await expect(stream.next()).rejects.toMatchObject({code:'not_authorized'})
      expect(await stream.next()).toMatchObject({done:true})
    }
    await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[departmentId,f.userId])
    const preview=await privacy.preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})
    expect((await pool.query('SELECT scope_snapshot FROM crm_privacy_previews WHERE id=$1',[preview.id])).rows[0].scope_snapshot.compartments).toEqual([`team:${departmentId}`])
    await privacy.erase(f.context,{kind:'erase_contact_with_preview',contactId:f.contactId,previewId:preview.id,previewHash:preview.previewHash,confirmed:true})
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[departmentId,f.userId])
    await expect(readCrmErasureReview(f.context,preview.id)).rejects.toMatchObject({code:'not_authorized'})
    expect((await pool.query('SELECT id FROM entities WHERE id=$1',[f.contactId])).rowCount).toBe(0)

  },60_000)
  it('preserves event audience through reclassification and retirement without retaining source identity',async()=>{
    const f=await fixture(),departmentId=randomUUID(),departmentOwner=randomUUID(),eventId='ffffffff-'+randomUUID().slice(9)
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[departmentOwner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,departmentOwner])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional saved export department',$3,'team',$1::text,$4)",[departmentId,f.workspaceId,departmentOwner,`team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional saved export department','team',$3)",[f.workspaceId,`team:${departmentId}`,departmentId])
    const privacy=createCrmPrivacyService()
    const earlier=await privacy.preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})
    await pool.query("INSERT INTO crm_domain_event_outbox(id,workspace_id,subject_id,event_type,event_key,subject_kind,payload,actor_kind) SELECT ('00000000-'||substring(gen_random_uuid()::text,10))::uuid,$1,$2,'crm.consent.changed','general-'||n,'contact','{}','user' FROM generate_series(1,256) n",[f.workspaceId,f.contactId])
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[f.contactId,[`team:${departmentId}`]])
    await pool.query("INSERT INTO crm_domain_event_outbox(id,workspace_id,subject_id,event_type,event_key,subject_kind,payload,actor_kind) VALUES($1,$2,$3,'crm.consent.changed','protected-event','contact','{}','user')",[eventId,f.workspaceId,f.contactId])
    await pool.query("UPDATE entities SET sensitivity='internal',compartments='{}' WHERE id=$1",[f.contactId])
    await expect(privacy.preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})).rejects.toMatchObject({code:'not_authorized'})
    await expect(collect(f.context,f.contactId)).rejects.toMatchObject({code:'not_authorized'})
    await expect(collect(f.context)).rejects.toMatchObject({code:'not_authorized'})
    await expect(exportCrmOperationsPrivacy(f.context)).rejects.toMatchObject({code:'not_authorized'})
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')",[f.workspaceId,departmentId,f.userId])
    await expect(readCrmErasureReview(f.context,earlier.id)).rejects.toMatchObject({code:'conflict',details:{reason:'privacy_preview_stale'}})
    expect((await exportCrmOperationsPrivacy(f.context)).schema).toBe('crm-operations-privacy-v1')
    for(const contactId of [f.contactId,undefined]) {
      await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[departmentId,f.userId])
      expect((await collect(f.context,contactId)).values.at(-1)?.complete).toBe(true)
      const stream=streamCrmPrivacyExport(f.context,{contactId})
      expect(JSON.parse((await stream.next()).value!).type).toBe('header')
      await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[departmentId,f.userId])
      await expect(stream.next()).rejects.toMatchObject({code:'not_authorized'})
      expect(await stream.next()).toMatchObject({done:true})
    }
    await pool.query('UPDATE department_edges SET expires_at=NULL WHERE department_id=$1 AND user_id=$2',[departmentId,f.userId])
    const preview=await privacy.preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})
    expect((await pool.query('SELECT scope_snapshot FROM crm_privacy_previews WHERE id=$1',[preview.id])).rows[0].scope_snapshot.compartments).toEqual([`team:${departmentId}`])
    await expect(pool.query('UPDATE crm_domain_event_outbox SET privacy_scope=NULL WHERE id=$1',[eventId])).rejects.toThrow('event_scope_release_required')
    await privacy.erase(f.context,{kind:'erase_contact_with_preview',contactId:f.contactId,previewId:preview.id,previewHash:preview.previewHash,confirmed:true})
    const retired=(await pool.query('SELECT privacy_scope,scope_source,subject_id,status FROM crm_domain_event_outbox WHERE id=$1',[eventId])).rows[0]
    expect(retired).toMatchObject({scope_source:null,subject_id:'00000000-0000-0000-0000-000000000000',status:'retired',privacy_scope:{compartments:[`team:${departmentId}`]}})
    expect(retired.privacy_scope).not.toHaveProperty('resourceId')
    expect(JSON.stringify(retired.privacy_scope)).not.toContain(f.contactId)
    expect((await queryWithRLS(f.userId,'SELECT id FROM crm_domain_event_outbox WHERE id=$1',[eventId])).rows).toHaveLength(1)
    const grant={workspaceId:f.workspaceId,userId:f.userId,assistantId:null,base:'confidential' as const,departments:{[departmentId]:'confidential' as const},contextDepartment:null,binding:null,cap:null}
    const access={userId:f.userId,clearance:'confidential' as const,compartments:null,projectIds:null,departmentRead:grant}
    expect((await runWithAgentAccess({...access,departmentRead:{...grant,binding:[]}},()=>queryWithRLS(f.userId,'SELECT id FROM crm_domain_event_outbox WHERE id=$1',[eventId]))).rows).toEqual([])
    expect((await runWithAgentAccess({...access,departmentRead:{...grant,cap:'internal'}},()=>queryWithRLS(f.userId,'SELECT id FROM crm_domain_event_outbox WHERE id=$1',[eventId]))).rows).toEqual([])

    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2",[departmentId,f.userId])
    await expect(readCrmErasureReview(f.context,preview.id)).rejects.toMatchObject({code:'not_authorized'})
    expect((await queryWithRLS(f.userId,'SELECT id FROM crm_domain_event_outbox WHERE id=$1',[eventId])).rows).toEqual([])
    await expect(exportCrmOperationsPrivacy(f.context)).rejects.toMatchObject({code:'not_authorized'})
    expect((await pool.query('SELECT id FROM entities WHERE id=$1',[f.contactId])).rowCount).toBe(0)

  },60_000)
  it.each(['held','unresolved','retired-unresolved'] as const)('refuses %s event evidence without creating an erasure review',async state=>{
    const f=await fixture(),eventId=randomUUID()
    const payload=state==='held'?{}:{batchId:'fictional-unresolved-batch'}
    await pool.query("INSERT INTO crm_domain_event_outbox(id,workspace_id,subject_id,event_type,event_key,subject_kind,payload,actor_kind,privacy_scope) VALUES($1::uuid,$2,$3,'crm.consent.changed',$1::text,'contact',$4,'user',$5)",[eventId,f.workspaceId,f.contactId,payload,{workspaceId:f.workspaceId,userId:null,assistantId:null,sensitivity:'public',compartments:[],projectIds:[]}])
    if(state==='held')await pool.query('UPDATE crm_domain_event_outbox SET scope_held=true WHERE id=$1',[eventId])
    else expect((await pool.query('SELECT privacy_scope FROM crm_domain_event_outbox WHERE id=$1',[eventId])).rows[0].privacy_scope).toBeNull()
    if(state==='retired-unresolved') {
      await pool.query("UPDATE crm_domain_event_outbox SET status='retired',retired_at=now(),retired_from_status='pending',subject_id='00000000-0000-0000-0000-000000000000',payload=jsonb_build_object('erased',true,'eventType',event_type) WHERE id=$1",[eventId])
      expect((await queryWithRLS(f.userId,'SELECT id FROM crm_domain_event_outbox WHERE id=$1',[eventId])).rows).toEqual([])
      await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspaceId])
      expect((await queryWithRLS(f.userId,'SELECT id FROM crm_domain_event_outbox WHERE id=$1',[eventId])).rows).toHaveLength(1)
      await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
    }else {
      await expect(streamCrmPrivacyExport(f.context,{contactId:f.contactId}).next()).rejects.toMatchObject({code:'not_authorized'})
      await expect(createCrmPrivacyService().preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})).rejects.toMatchObject({code:'not_authorized'})
    }
    await expect(streamCrmPrivacyExport(f.context).next()).rejects.toMatchObject({code:'not_authorized'})
    await expect(exportCrmOperationsPrivacy(f.context)).rejects.toMatchObject({code:'not_authorized'})
    expect((await pool.query('SELECT id FROM crm_privacy_previews WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
  })
  it('refuses held activity evidence before export or erasure counts',async()=>{
    const f=await fixture()
    await activity(f)
    await pool.query('UPDATE crm_activities SET scope_held=true WHERE workspace_id=$1',[f.workspaceId])
    await expect(streamCrmPrivacyExport(f.context).next()).rejects.toMatchObject({code:'not_authorized'})
    await expect(streamCrmPrivacyExport(f.context,{contactId:f.contactId}).next()).rejects.toMatchObject({code:'not_authorized'})
    await expect(exportCrmOperationsPrivacy(f.context)).rejects.toMatchObject({code:'not_authorized'})
    await expect(createCrmPrivacyService().preview(f.context,{kind:'preview_contact_erasure',contactId:f.contactId})).rejects.toMatchObject({code:'not_authorized'})
    expect((await pool.query('SELECT id FROM crm_privacy_previews WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
  })
  it('revalidates the integration grant and revocation at snapshot admission',async()=>{
    const f=await fixture(),reader=await f.issue(),narrow=await f.issue(false)
    expect((await collect(reader.context)).values.at(-1)?.complete).toBe(true)
    expect((await collect(reader.context,f.contactId)).values.at(-1)?.complete).toBe(true)
    await expect(collect(narrow.context,f.contactId)).rejects.toMatchObject({code:'integration_scope_denied'})
    await keys.revoke(f.workspaceId,f.userId,reader.key.id)
    await expect(collect(reader.context)).rejects.toMatchObject({code:'credential_revoked'})
  })
  it('allows revocation while an integration stream is paused and withholds the next record',async()=>{
    const f=await fixture(),reader=await f.issue()
    await activity(f)
    const stream=streamCrmPrivacyExport(reader.context,{contactId:f.contactId})
    try {
      expect(JSON.parse((await stream.next()).value!)).toMatchObject({type:'header'})
      // Revocation must complete while the snapshot remains open, not wait for
      // stream consumption to release a credential or membership row lock.
      expect(await keys.revoke(f.workspaceId,f.userId,reader.key.id)).toBe(true)
      await expect(stream.next()).rejects.toMatchObject({code:'credential_revoked'})
      expect((await stream.next()).done).toBe(true)
    }finally{await stream.return(undefined)}
  })
  it('serves actual member and integration v2 routes while preserving the legacy v1 response',async()=>{
    const f=await fixture(),app=express()
    app.use('/api/crm/integration',crmIntegrationRoutes({credentials:keys,service:operations,association:{} as AssociationServicePort}))
    app.use((req,_res,next)=>{req.userId=f.userId;next()})
    app.use('/api/crm',crmOperationsRoutes({service:operations,workspaceStore:createWorkspaceStore(),readStore:createDbCrmIntakeReadStore()}))
    const path='/api/crm/'+f.workspaceId+'/operations/privacy-export'
    const legacy=await request(app).get(path)
    expect(legacy.headers['cache-control']).toBe('no-store')
    expect(legacy.status).toBe(200);expect(legacy.body).toHaveProperty('tables')
    const exported=await request(app).get(path+'?format=crm-privacy-v2')
    expect(exported.status).toBe(200);expect(exported.headers['content-type']).toContain('application/x-ndjson')
    expect(exported.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(exported.text.trim().split('\n').at(-1)!)).toMatchObject({type:'manifest',complete:true})
    expect((await request(app).get(path+'?format=unknown')).status).toBe(400)
    expect((await request(app).get('/api/crm/'+f.workspaceId+'/operations/contacts/'+f.contactId+'/privacy-export')).status).toBe(200)
    const reader=await f.issue(),narrow=await f.issue(false),integration='/api/crm/integration/operations/contacts/'+f.contactId+'/privacy-export'
    expect((await request(app).get(integration).set('Authorization','Bearer '+reader.key.oneTimeSecret)).status).toBe(200)
    expect((await request(app).get(integration).set('Authorization','Bearer '+narrow.key.oneTimeSecret)).status).toBe(403)
  })

  it('includes retained suppression for a recreated address without exposing HMACs and blocks missing retained keys',async()=>{
    const previous=process.env.CRM_SUPPRESSION_HMAC_KEYRING
    const key=Buffer.alloc(32,31).toString('base64')
    process.env.CRM_SUPPRESSION_HMAC_KEYRING=JSON.stringify({activeVersion:'v1',keys:{v1:key}})
    try {
      const f=await fixture(),run=(command:unknown)=>operations.execute(f.context,CrmOperationsCommandSchema.parse(command))
      await run({kind:'save_privacy_policy',expectedVersion:0,confirmed:true,intakeReplay:null,addressSuppression:{retentionSeconds:3600}})
      await run({kind:'save_consent_purpose',purposeKey:'updates',label:'Updates',wordingVersion:'1',wording:'Fixture wording',applicableChannels:['email']})
      await run({kind:'record_consent',contactId:f.contactId,purposeKey:'updates',action:'withdrawn',source:'fixture'})
      const soft=createSoftDeleteStore(),snapshot=await soft.readForSoftDelete('contact',f.workspaceId,f.contactId)
      await soft.applyHardPurge({primitive:'contact',workspaceId:f.workspaceId,rowId:f.contactId,actorUserId:f.userId,reason:'Fixture erasure',ticketReference:null,snapshot:snapshot!,now:new Date()})
      const replacement=randomUUID()
      await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source) VALUES($1,$2,'person','Recreated subject',$3,$4,'manual')",[replacement,f.workspaceId,ownEmail,f.userId])
      const output=await collect(f.context,replacement),tombstones=records(output,'crm_address_suppression_tombstones')
      expect(tombstones).toHaveLength(1)
      expect(tombstones[0]).toMatchObject({reason_code:'consent_withdrawn',channel:'email'})
      expect(tombstones[0]).not.toHaveProperty('address_hmac');expect(tombstones[0]).not.toHaveProperty('key_check')
      expect(records(await collect(f.context,f.otherId),'crm_address_suppression_tombstones')).toEqual([])
      const digest=(await pool.query('SELECT address_hmac FROM crm_address_suppression_tombstones WHERE workspace_id=$1',[f.workspaceId])).rows[0].address_hmac
      expect(output.text).not.toContain(digest)
      process.env.CRM_SUPPRESSION_HMAC_KEYRING=JSON.stringify({activeVersion:'v2',keys:{v2:Buffer.alloc(32,32).toString('base64')}})
      await expect(collect(f.context,replacement)).rejects.toMatchObject({details:{reason:'suppression_retained_key_missing'}})
    }finally {
      if(previous===undefined)delete process.env.CRM_SUPPRESSION_HMAC_KEYRING
      else process.env.CRM_SUPPRESSION_HMAC_KEYRING=previous
    }
  })
  it('limits generic correction history to CRM entities and retains the subject snapshot',async()=>{
    const f=await fixture()
    for(const [id,kind,name] of [[f.contactId,'person','Subject history'],[randomUUID(),'topic','Unrelated brain correction']])
      await pool.query("INSERT INTO correction_audit(workspace_id,action,primitive,row_id,row_snapshot) VALUES($1,'soft_delete','entity',$2,$3)",[f.workspaceId,id,JSON.stringify({kind,display_name:name})])
    const workspace=await collect(f.context),subject=await collect(f.context,f.contactId)
    expect(records(workspace,'correction_audit')).toHaveLength(1)
    expect(records(subject,'correction_audit')).toMatchObject([{row_id:f.contactId,row_snapshot:{display_name:'Subject history'}}])
    expect(workspace.text).not.toContain('Unrelated brain correction')
  })
  it('applies actual app-role RLS even when a projection is called with a foreign workspace id',async()=>{
    const f=await fixture(),other=await fixture(),client=await appPool.connect()
    await activity(other)
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.userId])
      const entry=CRM_PRIVACY_COVERAGE.find(e=>e.domain==='crm_activities')!
      expect((await client.query(crmPrivacyDomainSql(entry,'workspace'),[other.workspaceId,null])).rows).toEqual([])
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('releases a real snapshot and its membership lock when the consumer closes early',async()=>{
    const f=await fixture(),stream=streamCrmPrivacyExport(f.context)
    await stream.next();await stream.return(undefined)
    const client=await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout='500ms'")
      await client.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1",[f.workspaceId])
      await client.query('COMMIT')
    }finally{await client.query('ROLLBACK');client.release()}
  })

  it('keeps an oversized projected row inside PostgreSQL and fails the stream without a manifest',async()=>{
    const f=await fixture()
    await pool.query("INSERT INTO crm_email_drafts(workspace_id,to_addresses,body) VALUES($1,$2,repeat('x',67108865))",[f.workspaceId,[ownEmail]])
    const received:string[]=[]
    await expect((async()=>{
      for await(const line of streamCrmPrivacyExport(f.context,{contactId:f.contactId}))received.push(line)
    })()).rejects.toMatchObject({details:{reason:'privacy_export_row_too_large',domain:'crm_email_drafts'}})
    expect(received.some(line=>JSON.parse(line).type==='manifest')).toBe(false)
    expect(received.every(line=>line.length<100_000)).toBe(true)
  },30_000)
  it('redacts cross-person audit references and notification payloads attributed to the subject',async()=>{
    const f=await fixture(),metadata=JSON.stringify({contactId:f.contactId,otherEmail})
    await pool.query("INSERT INTO association_audit_log(workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,metadata) VALUES($1,'crm.fixture','contact',$2,'user',$3,$4)",[f.workspaceId,f.otherId,f.userId,metadata])
    await pool.query("INSERT INTO crm_domain_event_outbox(workspace_id,event_type,event_key,subject_kind,subject_id,actor_kind,payload) VALUES($1,'crm.consent.changed','fixture','contact',$2,'user',$3)",[f.workspaceId,f.otherId,metadata])
    await pool.query("INSERT INTO workspace_audit_log(workspace_id,event_type,subject_id,details) VALUES($1,'crm.fixture',$2,$3)",[f.workspaceId,f.otherId,metadata])
    const orderScope=await loadAssociationOrderScope(pool,f.workspaceId,[f.contactId])
    const order=(await pool.query(`INSERT INTO association_orders(workspace_id,contact_id,idempotency_key,request_fingerprint,currency,subtotal_minor,total_minor,scope_snapshot,scope_sources)
      VALUES($1,$2,'notification-fixture',repeat('a',64),'USD',0,0,$3::jsonb,$4::jsonb) RETURNING id`,[f.workspaceId,f.contactId,JSON.stringify(orderScope.scope),JSON.stringify(orderScope.sources)])).rows[0]
    await pool.query("INSERT INTO association_notification_outbox(workspace_id,source_kind,source_id,template_key,recipient_kind,recipient_ref,payload) VALUES($1,'order',$2,'fixture','contact',$3,$4)",[f.workspaceId,order.id,f.contactId,metadata])
    const output=await collect(f.context,f.contactId)
    for(const domain of ['association_audit_log','crm_domain_event_outbox','workspace_audit_log'])
      expect(records(output,domain)).toMatchObject([{subject_id:null}])
    expect(records(output,'association_notification_outbox')).toMatchObject([{recipient_ref:f.contactId,payload:{}}])
    expect(output.text).not.toContain(f.otherId);expect(output.text).not.toContain(otherEmail)
  })
  it('redacts a legacy draft with an unidentifiable null recipient instead of treating it as subject-only',async()=>{
    const f=await fixture()
    await pool.query("INSERT INTO crm_email_drafts(workspace_id,to_addresses,bcc_addresses,body) VALUES($1,$2,ARRAY[NULL]::text[],'Unpartitioned message')",[f.workspaceId,[ownEmail]])
    const output=await collect(f.context,f.contactId)
    expect(records(output,'crm_email_drafts')).toMatchObject([{body:null,bcc_addresses:[]}])
    expect(output.text).not.toContain('Unpartitioned message')
  })

})
