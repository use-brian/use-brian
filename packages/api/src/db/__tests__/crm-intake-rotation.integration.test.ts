import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import type { Server } from 'node:http'
import express from 'express'
import request from 'supertest'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsContext, type CrmOperationsCommand } from '@use-brian/core'
import { currentAgentAccess } from '../agent-access-context.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { crmIntakeRoutes } from '../../routes/crm-intake.js'
import { streamCrmPrivacyExport } from '../../crm-operations/privacy-export.js'
import { createAssociationStore } from '../association-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const store = createDbCrmOperationsStore(pool)
const service = createCrmOperationsService(store)
const servers: Server[] = []
async function fixture() {
  const workspaceId = randomUUID(),userId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)',[userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Rotation fixture',$2)`,[workspaceId,userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`,[workspaceId,userId])
  const context: CrmOperationsContext = { workspaceId,actor: { kind: 'user',userId },authority: { role: 'owner',canConfigure: true,canWrite: true,trustedIdentitySources: [] } }
  await service.execute(context,CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose',purposeKey: 'updates',label: 'Updates',wordingVersion: '1',wording: 'Fixture consent' }))
  const ids: string[] = []
  for (const definitionKey of ['first','second']) {
    const saved = await service.execute(context,CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition',definitionKey,label: definitionKey,definition: {
      identityPolicy: 'new_or_review',fields: [
        { key: 'name',label: 'Name',type: 'text',required: true,mapping: { kind: 'base_field',field: 'name' } },
        { key: 'agree',label: 'Agree',type: 'boolean',required: true,mapping: { kind: 'submission_only' } },
      ],consentMappings: [{ fieldKey: 'agree',grantedValue: true,purposeKey: 'updates' }],
      followUpTaskTemplate: { title: 'Review fixture',priority: 'medium' },followUpDueMinutes: 60,
    } }))
    ids.push(String(saved.record.id))
  }
  const app = express(); app.use('/api',crmIntakeRoutes({ service,readStore: createDbCrmIntakeReadStore() }))
  const server = app.listen(0,'127.0.0.1'); servers.push(server); await once(server,'listening')
  const key = (rotateFromCredentialId?: string,definitionIds=ids,credentialId?: string,
    departmentBinding?: Extract<CrmOperationsCommand,{kind:'create_intake_credential'}>['departmentBinding']) =>
    (credentialId ? createCrmOperationsService(store,{ randomCredentialId: () => credentialId }) : service).execute(context,CrmOperationsCommandSchema.parse({ kind: 'create_intake_credential',label: 'Fixture backend',definitionIds,rotateFromCredentialId,departmentBinding }))
  const submit = (secret: string,definition='first',fields: Record<string,unknown> = { name: 'Fixture person',agree: true }) => request(server)
    .post(`/api/crm/intake/${definition}/submissions`).set('Authorization',`Bearer ${secret}`).set('Idempotency-Key','stable_backend_submission').send({ fields })
  return { workspaceId,userId,context,ids,key,submit }
}
async function counts(workspace: string) {
  return (await pool.query(`SELECT
    (SELECT count(*) FROM entities WHERE workspace_id=$1)::int AS people,
    (SELECT count(*) FROM association_enquiries WHERE workspace_id=$1)::int AS submissions,
    (SELECT count(*) FROM association_consent_events WHERE workspace_id=$1)::int AS consent,
    (SELECT count(*) FROM crm_suppression_events WHERE workspace_id=$1)::int AS suppressions,
    (SELECT count(*) FROM tasks WHERE workspace_id=$1)::int AS tasks,
    (SELECT count(*) FROM crm_intake_idempotency WHERE workspace_id=$1)::int AS receipts,
    (SELECT count(*) FROM association_audit_log WHERE workspace_id=$1)::int AS audit,
    (SELECT count(*) FROM crm_domain_event_outbox WHERE workspace_id=$1)::int AS outbox`,[workspace])).rows[0]
}

describe('[COMP:crm/operations-store] Actual intake rotation replay', () => {
  afterAll(async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve())))); await pool.end() })
  it('serializes intake authentication with definition retirement without recording rejected usage', async () => {
    const f = await fixture(), issued = await f.key(), reads = createDbCrmIntakeReadStore()
    const successful = await Promise.all([reads.authenticate(issued.oneTimeSecret!, 'first'), reads.authenticate(issued.oneTimeSecret!, 'first')])
    expect(successful.every(value => value !== null)).toBe(true)
    const usage = async () => (await pool.query('SELECT last_used_at FROM crm_intake_credentials WHERE id=$1', [issued.record.id])).rows[0].last_used_at
    const lastSuccessfulUse = await usage()
    const mutation = await pool.connect()
    let authentication: ReturnType<typeof reads.authenticate> | undefined
    try {
      await mutation.query('BEGIN')
      await mutation.query('SELECT id FROM crm_intake_definitions WHERE id=$1 FOR UPDATE', [f.ids[0]])
      authentication = reads.authenticate(issued.oneTimeSecret!, 'first')
      let waiting = false
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%FOR SHARE OF c,b,d%') AS waiting`)).rows[0].waiting
        if (!waiting) await setTimeout(20)
      }
      expect(waiting).toBe(true)
      await mutation.query('UPDATE crm_intake_definitions SET active=false WHERE id=$1', [f.ids[0]])
      await mutation.query('COMMIT')
      expect(await authentication).toBeNull()
      expect(await usage()).toEqual(lastSuccessfulUse)
    } finally {
      await mutation.query('ROLLBACK')
      mutation.release()
      await authentication
    }
  })
  it('retains intake issuer scope and denies stale direct submissions after issuer access loss',async()=>{
    const f=await fixture(),department=randomUUID(),custodian=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[custodian])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,custodian])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)",[department,f.workspaceId,custodian,`team:${department}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)",[f.workspaceId,`team:${department}`,department])
    const binding={departmentIds:[department],cap:'internal' as const}
    await expect(f.key(undefined,f.ids,undefined,binding)).rejects.toThrow()
    expect((await pool.query('SELECT id FROM crm_intake_credentials WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')",[f.workspaceId,department,f.userId])
    const issued=await f.key(undefined,f.ids,undefined,binding),reads=createDbCrmIntakeReadStore()
    expect(issued.record.departmentBinding).toMatchObject({userId:f.userId,binding:[department],cap:'internal'})
    const principal=await reads.authenticate(issued.oneTimeSecret!,'first')
    expect(principal?.departmentRead).toMatchObject({userId:f.userId,binding:[department],cap:'internal'})
    const context:CrmOperationsContext={workspaceId:f.workspaceId,actor:{kind:'intake_key',credentialId:String(issued.record.id),definitionId:f.ids[0]},
      authority:{role:'system',canWrite:true,canConfigure:false,trustedIdentitySources:[]}}
    await store.transaction(context,async()=>{
      expect(currentAgentAccess()?.departmentRead).toMatchObject({userId:f.userId,binding:[department]})
    })
    const submitted=await f.submit(issued.oneTimeSecret!)
    expect(submitted.status).toBe(201)
    for(const [table,id] of [['entities',submitted.body.contactId],['tasks',submitted.body.followUpTaskId]]) {
      expect((await pool.query(`SELECT sensitivity,compartments,user_id FROM ${table} WHERE workspace_id=$1 AND id=$2`,[f.workspaceId,id])).rows)
        .toEqual([{sensitivity:'internal',compartments:[`team:${department}`],user_id:null}])
    }
    const submissionId=submitted.body.submissionId
    expect((await pool.query('SELECT scope_snapshot FROM association_enquiries WHERE id=$1',[submissionId])).rows[0].scope_snapshot)
      .toMatchObject({compartments:[`team:${department}`],sensitivity:'internal',userId:null})
    const legacyReads=createAssociationStore(pool),actor={credentialKind:'user' as const,credentialId:f.userId,actingUserId:f.userId}
    await legacyReads.addEnquiryNote(f.workspaceId,submissionId,{body:'Fictional protected note'},actor)
    const contentBytes=Buffer.from('Fictional normalized attachment fixture')
    await store.transaction(f.context,tx=>tx.createSubmissionAttachments(submissionId,[{
      key:'proof',originalName:'fixture.png',mimeType:'image/png',contentBytes,
      sizeBytes:contentBytes.length,sha256:createHash('sha256').update(contentBytes).digest('hex'),
    }]))
    const attachmentId=(await pool.query('SELECT id FROM association_submission_attachments WHERE submission_id=$1',[submissionId])).rows[0].id
    expect(await reads.getSubmissionAttachment(f.workspaceId,submissionId,attachmentId,f.context.actor))
      .toEqual({name:'fixture.png',mimeType:'image/png',contentBytes})
    const suppressionCommand=CrmOperationsCommandSchema.parse({kind:'record_suppression',contactId:submitted.body.contactId,
      channel:'email',action:'suppressed',reasonCode:'manual_do_not_contact',source:'fixture',provider:'fixture',providerEventId:'saved-suppression'})
    const suppression=await service.execute(f.context,suppressionCommand)
    expect((await pool.query('SELECT scope_snapshot FROM crm_suppression_events WHERE id=$1',[suppression.record.id])).rows[0].scope_snapshot)
      .toMatchObject({compartments:[`team:${department}`]})
    expect((await reads.getConsent(f.workspaceId,submitted.body.contactId,f.context.actor)).events).toHaveLength(1)
    expect((await reads.checkSendability(f.workspaceId,submitted.body.contactId,'email','updates',f.context.actor)).reasons).toContain('channel_suppression')
    const beforeScopeLoss=await counts(f.workspaceId)
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1",[submitted.body.contactId])
    await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2',[department,f.userId])
    expect((await reads.listSubmissions(f.workspaceId,{},f.context.actor)).submissions).toEqual([])
    expect(await reads.getSubmission(f.workspaceId,submissionId,f.context.actor)).toBeNull()
    expect(await reads.getSubmissionAttachment(f.workspaceId,submissionId,attachmentId,f.context.actor)).toBeNull()
    expect((await legacyReads.listEnquiries(f.workspaceId,{limit:25,cursor:null},actor)).items).toEqual([])
    await expect(legacyReads.listEnquiryNotes(f.workspaceId,submissionId,actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(reads.listSubmissions(f.workspaceId)).rejects.toMatchObject({code:'not_authorized'})
    await expect(reads.getConsent(f.workspaceId,submitted.body.contactId,f.context.actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(reads.checkSendability(f.workspaceId,submitted.body.contactId,'email','updates',f.context.actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(legacyReads.listConsents(f.workspaceId,submitted.body.contactId,actor)).rejects.toMatchObject({code:'not_authorized'})
    await expect(service.execute(f.context,suppressionCommand)).rejects.toMatchObject({code:'not_authorized'})

    expect((await f.submit(issued.oneTimeSecret!)).status).toBe(401)
    await expect(service.execute(f.context,CrmOperationsCommandSchema.parse({kind:'update_submission',submissionId,status:'resolved',note:'Fictional denied note'}))).rejects.toMatchObject({code:'not_authorized'})
    await expect(streamCrmPrivacyExport(f.context).next()).rejects.toMatchObject({code:'not_authorized'})
    expect(await counts(f.workspaceId)).toEqual(beforeScopeLoss)
    expect((await pool.query('SELECT body FROM association_enquiry_notes WHERE enquiry_id=$1',[submissionId])).rows).toEqual([{body:'Fictional protected note'}])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')",[f.workspaceId,department,f.userId])
    expect((await reads.listSubmissions(f.workspaceId,{},f.context.actor)).submissions.map(row=>row.id)).toEqual([submissionId])
    expect(await reads.getSubmission(f.workspaceId,submissionId,f.context.actor)).toMatchObject({id:submissionId})
    expect(await reads.getSubmissionAttachment(f.workspaceId,submissionId,attachmentId,f.context.actor)).toEqual({name:'fixture.png',mimeType:'image/png',contentBytes})
    expect((await legacyReads.listEnquiries(f.workspaceId,{limit:25,cursor:null},actor)).items.map(row=>row.id)).toEqual([submissionId])
    expect(await legacyReads.listEnquiryNotes(f.workspaceId,submissionId,actor)).toMatchObject([{body:'Fictional protected note'}])
    expect((await reads.getConsent(f.workspaceId,submitted.body.contactId,f.context.actor)).suppressions).toHaveLength(1)
    expect((await service.execute(f.context,suppressionCommand)).duplicate).toBe(true)
    expect((await f.submit(issued.oneTimeSecret!)).status).toBe(200)
    expect(await counts(f.workspaceId)).toEqual(beforeScopeLoss)
    await expect(pool.query('UPDATE crm_intake_credentials SET department_binding=NULL WHERE id=$1',[issued.record.id])).rejects.toThrow(/immutable/)
    const before=await counts(f.workspaceId)
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    expect(await reads.authenticate(issued.oneTimeSecret!,'first')).toBeNull()
    await expect(service.execute(context,CrmOperationsCommandSchema.parse({kind:'record_submission',definitionKey:'first',idempotencyKey:'stale',fields:{name:'Fictional stale person',agree:true}}))).rejects.toMatchObject({code:'not_authorized'})
    expect(await counts(f.workspaceId)).toEqual(before)
  })

  it('renews intake assistant Project limits for direct and HTTP submissions before any effects', async () => {
    const f = await fixture(), contact = randomUUID(), project = randomUUID(), assistantId = randomUUID()
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance,project_scope_mode) VALUES($1,$2,'Fictional intake assistant','primary','internal','all')", [assistantId, f.workspaceId])
    await pool.query('INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$3,lower($3),$4)', [project, f.workspaceId, 'Fictional intake project', f.userId])
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source,project_ids)
      VALUES($1,$2,'person','Fictional project contact','project@example.com',$3,'manual',ARRAY[$4::uuid])`, [contact, f.workspaceId, f.userId, project])
    await service.execute(f.context, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionId: f.ids[0], definitionKey: 'first', label: 'First', expectedVersion: 1,
      definition: { identityPolicy: 'existing_or_new', fields: [
        { key: 'name', label: 'Name', type: 'text', required: true, mapping: { kind: 'base_field', field: 'name' } },
        { key: 'email', label: 'Email', type: 'email', required: true, mapping: { kind: 'base_field', field: 'email' } },
      ], consentMappings: [], followUpTaskTemplate: { title: 'Review project submission', priority: 'medium' }, followUpDueMinutes: 60 } }))
    const key = await f.key(undefined, f.ids, undefined, { departmentIds: [], cap: 'internal', assistantId })
    const reads = createDbCrmIntakeReadStore()
    expect((await reads.authenticate(key.oneTimeSecret!, 'first'))?.executionLimits?.projectIds).toBeNull()
    await pool.query("UPDATE assistants SET project_scope_mode='assigned' WHERE id=$1", [assistantId])
    expect((await reads.authenticate(key.oneTimeSecret!, 'first'))?.executionLimits?.projectIds).toEqual([])
    const fields = { name: 'Fictional submitted name', email: 'project@example.com' }, before = await counts(f.workspaceId)
    const context: CrmOperationsContext = { workspaceId: f.workspaceId,
      actor: { kind: 'intake_key', credentialId: String(key.record.id), definitionId: f.ids[0] },
      authority: { role: 'system', canWrite: true, canConfigure: false, trustedIdentitySources: [] } }
    const command = CrmOperationsCommandSchema.parse({ kind: 'record_submission', definitionKey: 'first', idempotencyKey: 'project_submission', fields })
    await expect(service.execute(context, command)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await f.submit(key.oneTimeSecret!, 'first', fields)).status).toBe(401)
    expect(await counts(f.workspaceId)).toEqual(before)
    await pool.query('INSERT INTO assistant_project_grants(assistant_id,project_id,added_by_user_id) VALUES($1,$2,$3)', [assistantId, project, f.userId])
    const allowed = await f.submit(key.oneTimeSecret!, 'first', fields)
    expect(allowed.status).toBe(201)
    expect(allowed.body.contactId).toBe(contact)
    expect((await pool.query('SELECT project_ids FROM tasks WHERE id=$1', [allowed.body.followUpTaskId])).rows[0].project_ids).toEqual([project])
    expect((await counts(f.workspaceId)).people).toBe(before.people)
  })

  it('refuses hidden email matches without creating duplicates and inherits authorized private contacts into tasks',async()=>{
    const f=await fixture(),contact=randomUUID(),other=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[other])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[f.workspaceId,other])
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,user_id,source)
      VALUES($1,$2,'person','Fictional private contact','hidden@example.com',$3,$3,'manual')`,[contact,f.workspaceId,other])
    await service.execute(f.context,CrmOperationsCommandSchema.parse({kind:'save_intake_definition',definitionId:f.ids[0],definitionKey:'first',label:'First',expectedVersion:1,
      definition:{identityPolicy:'existing_or_new',fields:[
        {key:'name',label:'Name',type:'text',required:true,mapping:{kind:'base_field',field:'name'}},
        {key:'email',label:'Email',type:'email',required:true,mapping:{kind:'base_field',field:'email'}},
      ],consentMappings:[],followUpTaskTemplate:{title:'Review private submission',priority:'medium'},followUpDueMinutes:60}}))
    const key=await f.key(undefined,f.ids,undefined,{departmentIds:[],cap:'internal'})
    const before=await counts(f.workspaceId)
    const fields={name:'Fictional submitted name',email:'hidden@example.com'}
    expect(await createDbCrmIntakeReadStore().authenticate(key.oneTimeSecret!,'first')).not.toBeNull()
    const denied=await f.submit(key.oneTimeSecret!,'first',fields)
    expect(denied.status).toBe(401)
    expect(denied.body.error).toBe('not_authorized')
    expect(await counts(f.workspaceId)).toEqual(before)
    expect((await pool.query('SELECT display_name FROM entities WHERE id=$1',[contact])).rows[0].display_name).toBe('Fictional private contact')
    await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1',[contact,f.userId])
    const allowed=await f.submit(key.oneTimeSecret!,'first',fields)
    expect(allowed.status).toBe(201)
    expect(allowed.body.contactId).toBe(contact)
    expect((await pool.query('SELECT user_id,compartments FROM tasks WHERE id=$1',[allowed.body.followUpTaskId])).rows)
      .toEqual([{user_id:f.userId,compartments:[]}])
    expect((await counts(f.workspaceId)).people).toBe(before.people)
  })

  it('refuses legacy intake evidence after v2 cutover until explicit rotation',async()=>{
    const f=await fixture(),reads=createDbCrmIntakeReadStore()
    await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[f.workspaceId])
    const legacy=await f.key()
    expect(await reads.authenticate(legacy.oneTimeSecret!,'first')).not.toBeNull()
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[f.workspaceId])
    expect(await reads.authenticate(legacy.oneTimeSecret!,'first')).toBeNull()
    const replacement=await f.key(String(legacy.record.id),f.ids,undefined,{departmentIds:[],cap:'internal'})
    expect(replacement.record.departmentBinding).toMatchObject({binding:[],userId:f.userId})
    expect(await reads.authenticate(replacement.oneTimeSecret!,'first')).not.toBeNull()
    expect(await reads.authenticate(legacy.oneTimeSecret!,'first')).toBeNull()
  })
  it('keeps stable results through replacement chains, explicit revocation and identical requests', async () => {
    const f = await fixture()
    // Shared short prefix proves replacement creation no longer has a four-hex collision domain.
    const original = await f.key(undefined,f.ids,'aaaa0000-1111-4111-8111-111111111111')
    const first = await f.submit(original.oneTimeSecret!)
    expect(first.status).toBe(201)
    // An older persisted source id is not rewritten or needed for receipt lookup.
    await pool.query('UPDATE association_enquiries SET source_submission_id=$2 WHERE id=$1',[first.body.submissionId,'legacy_backend_submission'])
    const replacement = await f.key(String(original.record.id),f.ids,'aaaa1111-1111-4111-8111-111111111111')
    const before = await counts(f.workspaceId)
    const replay = await f.submit(replacement.oneTimeSecret!)
    expect(replay.status).toBe(200)
    expect(replay.body).toMatchObject({ ...first.body,duplicate: true })
    expect(await counts(f.workspaceId)).toEqual(before)
    expect((await f.submit(original.oneTimeSecret!)).status).toBe(200)
    expect((await f.submit(replacement.oneTimeSecret!,'first',{ name: 'Changed fixture',agree: true })).status).toBe(409)
    await service.execute(f.context,{ kind: 'revoke_intake_credential',credentialId: String(original.record.id) })
    expect((await f.submit(original.oneTimeSecret!)).status).toBe(401)
    const third = await f.key(String(replacement.record.id))
    expect((await f.submit(third.oneTimeSecret!)).body).toMatchObject({ ...first.body,duplicate: true })
    const receipt = (await pool.query('SELECT actor_scope,credential_id FROM crm_intake_idempotency WHERE workspace_id=$1',[f.workspaceId])).rows
    expect(receipt).toEqual([{ actor_scope: `intake_key:${original.record.id}`,credential_id: original.record.id }])
    expect(await counts(f.workspaceId)).toMatchObject({ people: 1,submissions: 1,consent: 1,tasks: 1,receipts: 1 })
  })

  it('keeps unrelated keys separate and checks the replacement grant before replay', async () => {
    const f = await fixture(), original = await f.key()
    const first = await f.submit(original.oneTimeSecret!)
    const narrowed = await f.key(String(original.record.id),[f.ids[1]!])
    expect((await f.submit(narrowed.oneTimeSecret!)).status).toBe(401)
    const unrelated = await f.key()
    const separate = await f.submit(unrelated.oneTimeSecret!)
    expect(separate.status).toBe(201)
    expect(separate.body.contactId).not.toBe(first.body.contactId)
    const other = await fixture()
    await expect(other.key(String(original.record.id))).rejects.toMatchObject({ code: 'not_found' })
    await expect(pool.query('UPDATE crm_intake_credentials SET replay_scope_id=$2 WHERE id=$1',[unrelated.record.id,original.record.id])).rejects.toMatchObject({ constraint: 'crm_intake_replay_scope_immutable' })
    expect((await pool.query('SELECT count(*)::int AS count FROM crm_intake_credentials WHERE workspace_id=$1',[other.workspaceId])).rows[0].count).toBe(0)
  })

  it('allows recovery from a revoked parent without restoring its authority or widening definition bindings', async () => {
    const f = await fixture(), original = await f.key()
    const first = await f.submit(original.oneTimeSecret!)
    await service.execute(f.context,{ kind: 'revoke_intake_credential',credentialId: String(original.record.id) })
    const recovered = await f.key(String(original.record.id),[f.ids[0]!])
    expect((await f.submit(recovered.oneTimeSecret!)).body).toMatchObject({ ...first.body,duplicate: true })
    expect((await f.submit(recovered.oneTimeSecret!,'second')).status).toBe(401)
    expect((await f.submit(original.oneTimeSecret!)).status).toBe(401)
  })
  it('returns accepted bytes after a definition revision while validating new writes against the latest schema', async () => {
    const f = await fixture(),original = await f.key()
    const first = await f.submit(original.oneTimeSecret!)
    await service.execute(f.context,CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition',definitionId: f.ids[0],definitionKey: 'first',label: 'Revised fixture',expectedVersion: 1,definition: {
      identityPolicy: 'new_or_review',fields: [
        { key: 'name',label: 'Name',type: 'text',required: true,mapping: { kind: 'base_field',field: 'name' } },
        { key: 'agree',label: 'Agree',type: 'boolean',required: true,mapping: { kind: 'submission_only' } },
        { key: 'new_required',label: 'Required',type: 'text',required: true,mapping: { kind: 'submission_only' } },
      ],
    } }))
    const replacement = await f.key(String(original.record.id))
    const before = await counts(f.workspaceId)
    expect((await f.submit(replacement.oneTimeSecret!)).body).toMatchObject({ ...first.body,duplicate: true })
    const unrelated = await f.key()
    expect((await f.submit(unrelated.oneTimeSecret!)).status).toBe(400)
    expect(await counts(f.workspaceId)).toMatchObject({ ...before,audit: before.audit+1 })
  })

  it('serializes revocation with an admitted submission and refuses the next replay', async () => {
    const f = await fixture(), credential = await f.key()
    await f.submit(credential.oneTimeSecret!)
    const admissionClient = await pool.connect()
    await admissionClient.query('BEGIN')
    const admissionPid = (await admissionClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    let entered!: () => void,release!: () => void
    const ready = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const admission = createDbCrmOperationsStore(pool,admissionClient).transaction(f.context,async (tx) => {
      expect(await tx.intakeCredentialReplayScope(String(credential.record.id),f.ids[0]!)).toBe(credential.record.id)
      entered(); await gate
    })
    let revocation: ReturnType<typeof service.execute> | undefined
    try {
      await Promise.race([ready,admission.then(() => { throw new Error('Admission finished before release.') })])
      revocation = service.execute(f.context,{ kind: 'revoke_intake_credential',credentialId: String(credential.record.id) })
      const deadline = Date.now()+5000; let waiting = false
      while (Date.now()<deadline) {
        const result = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND $1=ANY(pg_blocking_pids(pid))`,[admissionPid])
        if (result.rowCount) { waiting = true; break }
        await setTimeout(10)
      }
      expect(waiting).toBe(true)
    } finally {
      release()
      try { await admission; await admissionClient.query('COMMIT') }
      finally { await admissionClient.query('ROLLBACK'); admissionClient.release(); await revocation }
    }
    await revocation
    expect((await f.submit(credential.oneTimeSecret!)).status).toBe(401)
  })

  it('backfills existing scope ids and derives replacement scopes in a populated upgrade', async () => {
    const client = await pool.connect(),schema = `rotation_${randomUUID().replaceAll('-','')}`
    try {
      await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`)
      await client.query(`CREATE TABLE crm_intake_credentials(workspace_id uuid NOT NULL,id uuid PRIMARY KEY,UNIQUE(workspace_id,id))`)
      const workspace = randomUUID(),original = randomUUID(),replacement = randomUUID()
      await client.query('INSERT INTO crm_intake_credentials VALUES($1,$2)',[workspace,original])
      await client.query(await readFile(new URL('../../../migrations/503_crm_intake_rotation_replay.sql',import.meta.url),'utf8'))
      expect((await client.query('SELECT replay_scope_id FROM crm_intake_credentials')).rows).toEqual([{ replay_scope_id: original }])
      await client.query('INSERT INTO crm_intake_credentials(workspace_id,id,rotated_from_credential_id,replay_scope_id) VALUES($1,$2,$3,$4)',[workspace,replacement,original,randomUUID()])
      expect((await client.query('SELECT replay_scope_id FROM crm_intake_credentials WHERE id=$1',[replacement])).rows).toEqual([{ replay_scope_id: original }])
      await client.query('DELETE FROM crm_intake_credentials WHERE id=$1',[original])
      expect((await client.query('SELECT replay_scope_id,rotated_from_credential_id FROM crm_intake_credentials')).rows).toEqual([{ replay_scope_id: original,rotated_from_credential_id: null }])
    } finally { await client.query('ROLLBACK'); await client.query('RESET search_path'); await client.query(`DROP SCHEMA ${schema} CASCADE`); client.release() }
  })

})
