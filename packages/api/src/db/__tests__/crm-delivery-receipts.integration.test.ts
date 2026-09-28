import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { CrmOperationsCommandSchema, SendCrmMessageCommandSchema, crmOperationsSha256, type CrmOperationsContext } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { encryptCredentials } from '../credential-crypto.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createSoftDeleteStore } from '../soft-delete-store.js'
import { flushWorkspaceData } from '../workspace-flush.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createCrmDeliveryService, type PrepareCrmDelivery } from '../../crm-operations/delivery-service.js'
import {acquireCrmPrivacyAdmission} from '../../crm-operations/privacy-admission.js'
import { createCrmDeliveryProvider } from '../../crm-operations/delivery-providers.js'
import { exportCrmOperationsPrivacy } from '../../crm-operations/privacy.js'
import { crmOperationsRoutes } from '../../routes/crm-operations.js'
import { crmIntegrationContext, crmIntegrationRoutes } from '../../routes/crm-integration.js'
import { packGoogleRefreshCredential } from '../../google/client.js'
import { createAgentmailClient } from '../../agentmail/client.js'
import { createAgentmailEmailProvider } from '../../agentmail/provider.js'

const smtp=vi.hoisted(()=>({sendMail:vi.fn(async()=>({rejected:[]})),close:vi.fn()}))
vi.mock('nodemailer',()=>({default:{createTransport:()=>smtp},createTransport:()=>smtp}))
const { assertLocalFixture }=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool(),key=Buffer.alloc(32,29)
const keys=createCrmIntegrationStore()
const config=createCrmOperationsService(createDbCrmOperationsStore())
const production=createCrmDeliveryProvider({encryptionKey:key,emailProvider:()=>createAgentmailEmailProvider(createAgentmailClient({apiKey:'fixture-token'}))})
const recipient='person@example.com'
function deferred() {
  let resolve!:()=>void
  const promise=new Promise<void>(r=>{resolve=r})
  return {promise,resolve}
}
async function fixture(provider:'gmail'|'imap'|'agentmail'='gmail') {
  const workspaceId=randomUUID(),userId=randomUUID(),connectorInstanceId=randomUUID(),contactId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Delivery fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  const credentials=provider==='gmail'?{type:'oauth',client_id:'fixture-app',client_secret:packGoogleRefreshCredential({
    refreshToken:'fixture-refresh',appClientId:'fixture-app',appClientSecret:'fixture-secret',
  })}:provider==='imap'?{type:'imap',email:'sender@example.com',appPassword:'fixture-password',imapHost:'imap.example.com',imapPort:993,smtpHost:'smtp.gmail.com',smtpPort:465}:{type:'none'}
  await pool.query("INSERT INTO connector_instance(id,scope,workspace_id,provider,label,connected,connected_email,credentials) VALUES($1,'workspace',$2,$3,'Fixture mailbox',true,'sender@example.com',$4)",[connectorInstanceId,workspaceId,provider,encryptCredentials(credentials,key)])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source) VALUES($1,$2,'person','Fixture person',$3,$4,'manual')",[contactId,workspaceId,recipient,userId])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}}
  const run=(raw:unknown)=>config.execute(context,CrmOperationsCommandSchema.parse(raw))
  await run({kind:'save_consent_purpose',purposeKey:'updates',label:'Updates',wordingVersion:'1',wording:'Fixture wording',applicableChannels:['email']})
  await run({kind:'save_managed_mailbox_policy',connectorInstanceId,providerKey:'outreach',expectedVersion:0,confirmed:true,managed:true,purposeKeys:['updates']})
  const consent=(action='granted')=>run({kind:'record_consent',contactId,purposeKey:'updates',action,source:'fixture'})
  await consent()
  const command=SendCrmMessageCommandSchema.parse({kind:'send_message',deliveryId:randomUUID(),connectorInstanceId,purposeKey:'updates',to:[recipient],subject:'Fixture subject',body:'Fixture **message**',attachments:[{filename:'fixture.txt',mime:'text/plain',contentBase64:'QQ=='}]})
  const erase=async()=>{
    const store=createSoftDeleteStore(),snapshot=await store.readForSoftDelete('contact',workspaceId,contactId)
    await store.applyHardPurge({primitive:'contact',workspaceId,rowId:contactId,actorUserId:userId,reason:'Fixture erasure',ticketReference:null,snapshot:snapshot!,now:new Date()})
  }
  const grant=async(credentialId:string,enabled=true,expectedVersion=0)=>run({kind:'save_mailbox_integration_grant',credentialId,connectorInstanceId,enabled,expectedVersion,confirmed:true})
  return {workspaceId,userId,connectorInstanceId,contactId,context,command,run,consent,erase,grant}
}
const make=(prepare:PrepareCrmDelivery=production)=>{
  const deliveries=createCrmDeliveryService(prepare)
  return {deliveries,service:createCrmOperationsService(createDbCrmOperationsStore(),{deliveries})}
}
const response=(status=200,body:unknown={id:'sent-id',threadId:'thread-id',message_id:'sent-id',thread_id:'thread-id'})=>new Response(JSON.stringify(body),{status})
function transport(send=async()=>response()) {
  const invoke=vi.fn(send)
  vi.stubGlobal('fetch',vi.fn(async(url:unknown)=>String(url).includes('oauth2.googleapis.com/token')?response(200,{access_token:'fixture-token'}):invoke()))
  return invoke
}
const auditCount=async(workspaceId:string)=>(await pool.query("SELECT count(*)::int n FROM association_audit_log WHERE workspace_id=$1 AND action='crm.delivery.accepted'",[workspaceId])).rows[0].n

afterAll(async()=>{await pool.end();await appPool.end()})

describe('[COMP:crm/delivery-receipts] Durable email acceptance and replay',()=>{
  afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();smtp.sendMail.mockResolvedValue({rejected:[]})})

  it.each(['gmail','imap','agentmail'] as const)('uses the actual %s gate, records acceptance once and returns a content-free replay',async provider=>{
    const f=await fixture(provider),{deliveries,service}=make(),send=transport()
    const result=await service.execute(f.context,f.command)
    expect(result).toMatchObject({created:true,duplicate:false,record:{deliveryId:f.command.deliveryId,status:'sent',confirmedAt:null}})
    expect(result.record.acceptedAt).toBeTruthy()
    expect(result.record.providerReceipt).toMatchObject({evidence:provider==='imap'?'smtp_accepted':'provider_accepted'})
    const duplicate=await deliveries.send(f.context,f.command)
    expect(duplicate).toMatchObject({duplicate:true,receipt:{status:'sent'}})
    expect(provider==='imap'?smtp.sendMail.mock.calls.length:send.mock.calls.length).toBe(1)
    expect(await auditCount(f.workspaceId)).toBe(1)
    const read=await deliveries.get(f.context,f.command.deliveryId)
    expect(JSON.stringify(read)).not.toContain(recipient)
    expect(JSON.stringify(read)).not.toContain('Fixture subject')
    expect(read).not.toHaveProperty('claimToken')
  })
  it('serializes concurrent calls without a second provider invocation or duplicate contact audit',async()=>{
    const f=await fixture(),{deliveries}=make(),entered=deferred(),release=deferred()
    const send=transport(async()=>{entered.resolve();await release.promise;return response()})
    const first=deliveries.send(f.context,f.command)
    await entered.promise
    const second=await deliveries.send(f.context,f.command)
    expect(second).toMatchObject({duplicate:true,receipt:{status:'dispatching'}})
    release.resolve()
    expect((await first).receipt.status).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
    expect(await auditCount(f.workspaceId)).toBe(1)
    await expect(deliveries.send(f.context,{...f.command,body:'Changed'})).rejects.toMatchObject({code:'idempotency_conflict'})
  })
  it.each(['rejection','timeout','malformed'] as const)('preserves %s outcomes without retrying or claiming delivery',async kind=>{
    const f=await fixture(),{deliveries}=make()
    const send=transport(async()=>{
      if(kind==='timeout') throw new Error('Secret provider response must not escape')
      return kind==='rejection'?response(400,{error:'Sensitive provider body'}):response(200,{})
    })
    const result=await deliveries.send(f.context,f.command)
    expect(result.receipt).toMatchObject({status:kind==='rejection'?'failed':'needs_reconciliation',acceptedAt:null,confirmedAt:null})
    expect(JSON.stringify(result)).not.toMatch(/Sensitive|Secret/)
    expect((await deliveries.send(f.context,f.command)).duplicate).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(await auditCount(f.workspaceId)).toBe(0)
  })
  it('treats partial SMTP acceptance as uncertain',async()=>{
    const f=await fixture('imap'),{deliveries}=make()
    smtp.sendMail.mockResolvedValueOnce({rejected:[recipient]} as never)
    expect((await deliveries.send(f.context,f.command)).receipt.status).toBe('needs_reconciliation')
    expect(await auditCount(f.workspaceId)).toBe(0)
  })
  it.each(['withdraw','account_change'] as const)('rechecks %s after preparation before the real transport',async change=>{
    const f=await fixture(),send=transport()
    const {deliveries}=make(async(admission,command)=>{
      const prepared=await production(admission,command)
      if(change==='withdraw') await f.consent('withdrawn')
      else await pool.query("UPDATE connector_instance SET connected_email='changed@example.com' WHERE id=$1",[f.connectorInstanceId])
      return prepared
    })
    const result=await deliveries.send(f.context,f.command)
    expect(result.receipt.status).toBe('blocked')
    expect(result.receipt.errorCode).toBe(change==='withdraw'?'delivery_recipient_not_allowed':'delivery_account_changed')
    expect(send).not.toHaveBeenCalled()
  })
  it('erases a claimed message before invocation and preserves its terminal replay identity',async()=>{
    const f=await fixture(),send=transport()
    const {deliveries}=make(async(admission,command)=>{const prepared=await production(admission,command);await f.erase();return prepared})
    expect((await deliveries.send(f.context,f.command)).receipt).toMatchObject({status:'needs_reconciliation',errorCode:'delivery_erased_during_dispatch'})
    expect(send).not.toHaveBeenCalled()
    expect((await deliveries.send(f.context,f.command)).duplicate).toBe(true)
    const row=(await pool.query('SELECT envelope,provider_receipt,request_hash,redacted_at FROM crm_delivery_receipts WHERE workspace_id=$1',[f.workspaceId])).rows[0]
    expect(row.envelope).toBeNull();expect(row.provider_receipt).toBeNull();expect(row.redacted_at).toBeTruthy()
    expect(row.request_hash).toBe(crmOperationsSha256(f.command))
    await expect(pool.query('UPDATE crm_delivery_receipts SET provider_receipt=$2::jsonb WHERE workspace_id=$1',
      [f.workspaceId,JSON.stringify({messageId:'repopulated'})])).rejects.toMatchObject({code:'23514'})
  })
  it('redacts accepted envelope and links through erasure and data reset without reopening delivery ids',async()=>{
    const f=await fixture(),{deliveries}=make(),send=transport()
    await deliveries.send(f.context,f.command)
    const exported=await exportCrmOperationsPrivacy(f.workspaceId)
    expect(exported.tables.crm_delivery_receipts).toHaveLength(1)
    expect(exported.tables.crm_delivery_receipts![0]).not.toHaveProperty('claim_token')
    await f.erase()
    expect((await deliveries.get(f.context,f.command.deliveryId))).toMatchObject({status:'sent',providerReceipt:null})
    expect((await pool.query('SELECT * FROM crm_delivery_receipt_contacts WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
    await flushWorkspaceData(f.userId,f.workspaceId)
    expect((await deliveries.send(f.context,f.command))).toMatchObject({duplicate:true,receipt:{status:'sent',providerReceipt:null}})
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('preserves an abandoned claim, expires it to uncertainty, and forbids resetting immutable state',async()=>{
    const f=await fixture(),{deliveries}=make(),send=transport()
    await pool.query("INSERT INTO crm_delivery_receipts(workspace_id,delivery_id,request_hash,connector_instance_id,provider_key,purpose_key,actor_kind,actor_credential_id,acting_user_id,envelope,status,claim_token,claim_deadline) VALUES($1,$2,$3,$4,'outreach','updates','user',$5::text,$5::uuid,$6::jsonb,'dispatching',$7,clock_timestamp()-interval '1 second')",
      [f.workspaceId,f.command.deliveryId,crmOperationsSha256(f.command),f.connectorInstanceId,f.userId,JSON.stringify(f.command),randomUUID()])
    expect(await deliveries.get(f.context,f.command.deliveryId)).toMatchObject({status:'needs_reconciliation',errorCode:'delivery_claim_expired'})
    expect((await deliveries.send(f.context,f.command)).duplicate).toBe(true)
    expect(send).not.toHaveBeenCalled()
    await expect(pool.query("UPDATE crm_delivery_receipts SET status='dispatching' WHERE workspace_id=$1",[f.workspaceId])).rejects.toMatchObject({code:'23514'})
    await expect(pool.query("UPDATE crm_delivery_receipts SET request_hash=repeat('0',64) WHERE workspace_id=$1",[f.workspaceId])).rejects.toMatchObject({code:'23514'})
  })
  it('does not lose the committed attempt when acceptance persistence fails',async()=>{
    const f=await fixture(),{deliveries}=make(),send=transport()
    await pool.query(`CREATE FUNCTION fixture_reject_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='crm.delivery.accepted' THEN RAISE EXCEPTION 'Fixture receipt transaction failure'; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE TRIGGER fixture_delivery_audit_failure BEFORE INSERT ON association_audit_log FOR EACH ROW EXECUTE FUNCTION fixture_reject_delivery_audit()')
    try {
      const result=await deliveries.send(f.context,f.command)
      expect(result.receipt).toMatchObject({status:'needs_reconciliation',acceptedAt:null,errorCode:'provider_outcome_unknown'})
      expect((await deliveries.send(f.context,f.command)).duplicate).toBe(true)
      expect(send).toHaveBeenCalledTimes(1)
      expect(await auditCount(f.workspaceId)).toBe(0)
    } finally {
      await pool.query('DROP TRIGGER fixture_delivery_audit_failure ON association_audit_log')
      await pool.query('DROP FUNCTION fixture_reject_delivery_audit()')
    }
  })
  it('allows erasure to follow a live send without leaving a newly inserted personal audit',async()=>{
    const f=await fixture(),{deliveries}=make(),entered=deferred(),release=deferred()
    transport(async()=>{entered.resolve();await release.promise;return response()})
    const send=deliveries.send(f.context,f.command)
    await entered.promise
    // Receipt reads must return the committed claim while the provider holds
    // its row lock. They neither wait for the send nor steal the attempt.
    expect(await deliveries.get(f.context,f.command.deliveryId)).toMatchObject({status:'dispatching'})
    // Privacy admission refuses a live writer; it does not queue an erase
    // behind an external provider call. Retry only after acceptance commits.
    await expect(f.erase()).rejects.toMatchObject({code:'conflict',details:{reason:'privacy_operation_busy'}})
    release.resolve()
    await send;await f.erase()
    const audit=(await pool.query("SELECT metadata FROM association_audit_log WHERE workspace_id=$1 AND action='crm.delivery.accepted'",[f.workspaceId])).rows
    expect(audit).toEqual([{metadata:{erased:true}}])
    expect(await deliveries.get(f.context,f.command.deliveryId)).toMatchObject({status:'sent',providerReceipt:null})
  })
  it('leaves sending unavailable in an ordinary service until its port is explicitly bound',async()=>{
    const f=await fixture(),send=transport()
    await expect(config.execute(f.context,f.command)).rejects.toMatchObject({details:{reason:'delivery_unavailable'}})
    expect(send).not.toHaveBeenCalled()
    expect((await pool.query('SELECT * FROM crm_delivery_receipts WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
  })
  it('requires a separate exact mailbox grant and independent receipt-read authority for integrations',async()=>{
    const f=await fixture(),{deliveries,service}=make(),send=transport()
    const credential=await keys.create(f.workspaceId,f.userId,{label:'Delivery fixture',expiresAt:'2099-01-01T00:00:00Z',
      grants:[{operation:'crm.delivery.dispatch',selectors:{purposeKeys:['updates'],providerKeys:['outreach']}}]})
    const principal=(await keys.authenticate(credential.oneTimeSecret))!
    const ctx=crmIntegrationContext(principal)
    await expect(deliveries.send(ctx,f.command)).rejects.toMatchObject({code:'not_authorized'})
    await f.grant(credential.id)
    expect((await service.execute(ctx,f.command)).record.status).toBe('sent')
    await expect(deliveries.get(ctx,f.command.deliveryId)).rejects.toMatchObject({code:'integration_scope_denied'})
    expect(send).toHaveBeenCalledTimes(1)
    const row=(await pool.query('SELECT actor_kind,actor_credential_id,acting_user_id FROM crm_delivery_receipts WHERE workspace_id=$1',[f.workspaceId])).rows[0]
    expect(row).toEqual({actor_kind:'integration_key',actor_credential_id:credential.id,acting_user_id:null})
    await expect(deliveries.send(f.context,f.command)).rejects.toMatchObject({code:'idempotency_conflict'})
    await pool.query("UPDATE crm_integration_credentials SET revoked_at=clock_timestamp() WHERE id=$1",[credential.id])
    expect((await f.grant(credential.id,false,1)).record.enabled).toBe(false)
  })
  it.each(['revoke_grant','expire_credential'] as const)('rechecks %s between receipt commit and invocation',async change=>{
    const f=await fixture(),send=transport()
    const credential=await keys.create(f.workspaceId,f.userId,{label:'Delivery fixture',expiresAt:'2099-01-01T00:00:00Z',
      grants:[{operation:'crm.delivery.dispatch',selectors:{purposeKeys:['updates'],providerKeys:['outreach']}}]})
    const ctx=crmIntegrationContext((await keys.authenticate(credential.oneTimeSecret))!)
    await f.grant(credential.id)
    const {deliveries}=make(async(admission,command)=>{
      const prepared=await production(admission,command)
      if(change==='revoke_grant') await f.grant(credential.id,false,1)
      else await pool.query("UPDATE crm_integration_credentials SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[credential.id])
      return prepared
    })
    expect((await deliveries.send(ctx,f.command)).receipt.status).toBe('blocked')
    expect(send).not.toHaveBeenCalled()
  })
  it('isolates receipt reads under app RLS and actual member/integration routes',async()=>{
    const f=await fixture(),other=await fixture(),{deliveries,service}=make()
    transport()
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=f.userId;next()})
    app.use('/api/crm',crmOperationsRoutes({service,deliveries,workspaceStore:createWorkspaceStore(),readStore:createDbCrmIntakeReadStore()}))
    const {kind:_,...body}=f.command,path='/api/crm/'+f.workspaceId+'/operations/deliveries'
    expect((await request(app).post(path).send(body)).status).toBe(201)
    expect((await request(app).get(path+'/'+f.command.deliveryId)).body.receipt.status).toBe('sent')
    expect((await request(app).post(path).send({...body,actor:{kind:'user',userId:other.userId}})).status).toBe(400)
    const credential=await keys.create(f.workspaceId,f.userId,{label:'Read fixture',expiresAt:'2099-01-01T00:00:00Z',
      grants:[{operation:'crm.delivery.read',selectors:{purposeKeys:['updates'],providerKeys:['outreach']}}]})
    const integration=express();integration.use(express.json())
    integration.use('/api/crm/integration',crmIntegrationRoutes({credentials:keys,service,deliveries,association:{} as never}))
    const read=await request(integration).get('/api/crm/integration/operations/deliveries/'+f.command.deliveryId).set('Authorization','Bearer '+credential.oneTimeSecret)
    expect(read.status).toBe(200)
    const client=await appPool.connect()
    try {await client.query('BEGIN');await client.query("SELECT set_config('app.current_user_id',$1,true)",[other.userId])
      expect((await client.query('SELECT * FROM crm_delivery_receipts WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
      expect((await client.query('SELECT * FROM crm_delivery_receipt_contacts WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
    } finally {await client.query('ROLLBACK');client.release()}
  })
  it('refuses dispatch before a provider call when privacy owns workspace write admission, then admits a safe retry',async()=>{
    const f=await fixture(),{deliveries}=make(),send=transport(),privacy=await pool.connect()
    try {
      await privacy.query('BEGIN');await acquireCrmPrivacyAdmission(privacy,f.workspaceId)
      await expect(deliveries.send(f.context,f.command)).rejects.toMatchObject({details:{reason:'privacy_operation_busy'}})
      expect(send).not.toHaveBeenCalled()
      expect((await pool.query('SELECT delivery_id FROM crm_delivery_receipts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
      await privacy.query('ROLLBACK')
      expect((await deliveries.send(f.context,f.command)).receipt.status).toBe('sent')
      expect(send).toHaveBeenCalledTimes(1)
    }finally{await privacy.query('ROLLBACK');privacy.release()}
  })

})

async function nativeFixture(provider:'gmail'|'imap'|'agentmail'='gmail') {
  const f=await fixture(provider),assistantId=randomUUID()
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Fixture assistant','primary')",[assistantId,f.workspaceId,f.userId])
  for(const capability of ['crm','home_app:crm:read','home_app:crm:write']) await pool.query(`INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[assistantId,capability,f.userId])
  const governance=provider==='gmail'?provider:`${provider}:${f.connectorInstanceId}`
  await pool.query('INSERT INTO assistant_connector_grants(assistant_id,connector_id,allowed_actions,granted_by_user_id) VALUES($1,$2,$3,$4)',[assistantId,governance,[`${provider}SendMessage`],f.userId])
  if(provider==='agentmail') {
    const channelId=randomUUID()
    await pool.query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'email','Fixture mailbox')",[channelId,f.workspaceId])
    await pool.query("INSERT INTO channel_integrations(channel_id,channel_type,credentials,connector_instance_id) VALUES($1,'email',$2,$3)",[channelId,Buffer.alloc(1),f.connectorInstanceId])
    await pool.query('INSERT INTO channel_assistants(channel_id,assistant_id) VALUES($1,$2)',[channelId,assistantId])
  }
  const context:CrmOperationsContext={workspaceId:f.workspaceId,actor:{kind:'assistant',assistantId,userId:f.userId,sessionId:randomUUID()},authority:{role:'member',canWrite:true,canConfigure:false,trustedIdentitySources:[],nativeDelivery:{assistantId,compartments:null,mutationCompartments:null,projectIds:null}}}
  return {...f,assistantId,governance,nativeContext:context}
}

describe('[COMP:crm/delivery-policy] Native dispatch authority at the real provider boundary',()=>{
  afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();smtp.sendMail.mockResolvedValue({rejected:[]})})
  it.each(['gmail','imap','agentmail'] as const)('sends through %s once with the actual assistant audit identity',async provider=>{
    const f=await nativeFixture(provider),{deliveries}=make(),send=transport()
    expect(await deliveries.send(f.nativeContext,f.command)).toMatchObject({receipt:{status:'sent'},duplicate:false})
    expect(await deliveries.send(f.nativeContext,f.command)).toMatchObject({receipt:{status:'sent'},duplicate:true})
    const audit=(await pool.query("SELECT actor_kind,actor_credential_id FROM association_audit_log WHERE workspace_id=$1 AND action='crm.delivery.accepted'",[f.workspaceId])).rows
    expect(audit).toEqual([{actor_kind:'assistant',actor_credential_id:f.assistantId}])
    expect(provider==='imap'?smtp.sendMail:send).toHaveBeenCalledTimes(1)
  })
  it.each(['empty', 'missing'] as const)('refuses a native mailbox with %s mutation authority before provider preparation', async mutation => {
    const f=await nativeFixture(),prepare=vi.fn(production),{deliveries}=make(prepare)
    const team=await createDbWorkspaceGroupStore().createTeam(f.userId,f.workspaceId,{name:'Product fixture',key:'product-fixture'})
    await pool.query('UPDATE connector_instance SET compartments=$2 WHERE id=$1',[f.connectorInstanceId,[team.compartmentKey!]])
    f.nativeContext.authority.nativeDelivery!.compartments=[team.compartmentKey!]
    f.nativeContext.authority.nativeDelivery!.mutationCompartments=[]
    if(mutation==='missing') delete (f.nativeContext.authority.nativeDelivery as unknown as Record<string,unknown>).mutationCompartments
    await expect(deliveries.send(f.nativeContext,f.command)).rejects.toMatchObject({code:'not_authorized'})
    expect(prepare).not.toHaveBeenCalled()
    expect((await pool.query('SELECT delivery_id FROM crm_delivery_receipts WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
    f.nativeContext.authority.nativeDelivery!.mutationCompartments=[team.compartmentKey!]
    const send=transport()
    expect(await deliveries.send(f.nativeContext,f.command)).toMatchObject({receipt:{status:'sent'}})
    expect(send).toHaveBeenCalledTimes(1)
  })
  it.each(['capability','action','setting','membership','exposure','policy','context'] as const)('refuses changed %s authority before any provider preparation',async changed=>{
    const f=await nativeFixture(),prepare=vi.fn(production),{deliveries}=make(prepare)
    if(changed==='capability') await pool.query("UPDATE assistant_capabilities SET revoked_at=now() WHERE assistant_id=$1 AND capability='home_app:crm:write'",[f.assistantId])
    if(changed==='action') await pool.query('DELETE FROM assistant_connector_grants WHERE assistant_id=$1',[f.assistantId])
    if(changed==='setting') await pool.query('INSERT INTO assistant_connector_settings(assistant_id,connector_id,enabled) VALUES($1,$2,false)',[f.assistantId,`gmail:${f.connectorInstanceId}`])
    if(changed==='membership') await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    if(changed==='exposure') await pool.query("UPDATE connector_instance SET scope='user',workspace_id=NULL,user_id=$2 WHERE id=$1",[f.connectorInstanceId,f.userId])
    if(changed==='policy') await pool.query("INSERT INTO workspace_tool_policy(workspace_id,server_name,tool_name,policy) VALUES($1,'gmail','gmailSendMessage','block')",[f.workspaceId])
    if(changed==='context') f.nativeContext.authority.nativeDelivery!.compartments=[]
    await expect(deliveries.send(f.nativeContext,f.command)).rejects.toMatchObject({code:'not_authorized'})
    expect(prepare).not.toHaveBeenCalled()
  })
  it('rechecks mailbox action grants after a durable claim and preparation',async()=>{
    const f=await nativeFixture(),send=transport()
    const prepare:PrepareCrmDelivery=async(admission,command)=>{
      const ready=await production(admission,command)
      await pool.query('DELETE FROM assistant_connector_grants WHERE assistant_id=$1',[f.assistantId])
      return ready
    }
    const {deliveries}=make(prepare)
    expect(await deliveries.send(f.nativeContext,f.command)).toMatchObject({receipt:{status:'blocked',errorCode:'not_authorized'}})
    expect(send).not.toHaveBeenCalled()
    expect(await deliveries.get(f.nativeContext,f.command.deliveryId)).toMatchObject({status:'blocked'})
  })
  it('does not extend a primary Gmail grant to another account',async()=>{
    const f=await nativeFixture(),extra=randomUUID()
    await pool.query(`INSERT INTO connector_instance(id,scope,workspace_id,provider,label,connected,connected_email,credentials,created_at)
      SELECT $2,scope,workspace_id,provider,'Extra mailbox',connected,'extra@example.com',credentials,created_at+interval '1 hour' FROM connector_instance WHERE id=$1`,[f.connectorInstanceId,extra])
    await f.run({kind:'save_managed_mailbox_policy',connectorInstanceId:extra,providerKey:'outreach_extra',expectedVersion:0,confirmed:true,managed:true,purposeKeys:['updates']})
    const prepare=vi.fn(production),{deliveries}=make(prepare)
    await expect(deliveries.send(f.nativeContext,{...f.command,connectorInstanceId:extra})).rejects.toMatchObject({code:'not_authorized'})
    expect(prepare).not.toHaveBeenCalled()
    await pool.query('INSERT INTO assistant_connector_grants(assistant_id,connector_id,allowed_actions,granted_by_user_id) VALUES($1,$2,$3,$4)',[f.assistantId,`gmail:${extra}`,['gmailSendMessage'],f.userId])
    const send=transport()
    expect(await deliveries.send(f.nativeContext,{...f.command,connectorInstanceId:extra})).toMatchObject({receipt:{status:'sent'}})
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('requires the current AgentMail channel handler even with an exact send grant',async()=>{
    const f=await nativeFixture('agentmail'),prepare=vi.fn(production),{deliveries}=make(prepare)
    await pool.query('DELETE FROM channel_assistants WHERE assistant_id=$1',[f.assistantId])
    await expect(deliveries.send(f.nativeContext,f.command)).rejects.toMatchObject({code:'not_authorized'})
    expect(prepare).not.toHaveBeenCalled()
  })
  it('refuses a revoked AgentMail channel even if its handler and send grant remain',async()=>{
    const f=await nativeFixture('agentmail'),prepare=vi.fn(production),{deliveries}=make(prepare)
    await pool.query("UPDATE channels SET status='revoked' WHERE workspace_id=$1",[f.workspaceId])
    await expect(deliveries.send(f.nativeContext,f.command)).rejects.toMatchObject({code:'not_authorized'})
    expect(prepare).not.toHaveBeenCalled()
  })
  it.each(['brain_key','oauth_token','home_app'] as const)('retains and rechecks a %s principal rather than impersonating the owner',async kind=>{
    const f=await nativeFixture(),credentialId=randomUUID(),{deliveries}=make(),send=transport()
    if(kind==='brain_key') await pool.query("INSERT INTO brain_keys(id,workspace_id,name,key_hash,key_prefix,scope) VALUES($1,$2,'Fixture','fixture','fixture','read_write')",[credentialId,f.workspaceId])
    if(kind==='oauth_token') {
      await pool.query("INSERT INTO oauth_clients(client_id,redirect_uris) VALUES($1,ARRAY['https://example.com/callback'])",[credentialId])
      await pool.query("INSERT INTO oauth_authorizations(id,workspace_id,user_id,client_id,scope,access_token_hash,access_token_expires_at) VALUES($1::uuid,$2,$3,$1::text,'read_write','fixture',now()+interval '1 hour')",[credentialId,f.workspaceId,f.userId])
    }
    if(kind==='home_app') await pool.query(`INSERT INTO workspace_home_apps(id,workspace_id,kind,name,status,granted_scopes) VALUES($1,$2,'assistant','Fixture','active','{"data":"read_write"}')`,[credentialId,f.workspaceId])
    const context:CrmOperationsContext={...f.nativeContext,actor:{kind,credentialId}}
    expect(await deliveries.send(context,f.command)).toMatchObject({receipt:{status:'sent'}})
    const audit=(await pool.query("SELECT actor_kind,actor_credential_id FROM association_audit_log WHERE workspace_id=$1 AND action='crm.delivery.accepted'",[f.workspaceId])).rows[0]
    expect(audit).toEqual({actor_kind:kind,actor_credential_id:credentialId})
    if(kind==='brain_key') await pool.query("UPDATE brain_keys SET scope='read' WHERE id=$1",[credentialId])
    if(kind==='oauth_token') await pool.query("UPDATE oauth_authorizations SET scope='read' WHERE id=$1",[credentialId])
    if(kind==='home_app') await pool.query(`UPDATE workspace_home_apps SET granted_scopes='{"data":"read"}' WHERE id=$1`,[credentialId])
    await expect(deliveries.send(context,f.command)).rejects.toMatchObject({code:'not_authorized'})
    expect(await deliveries.get(context,f.command.deliveryId)).toMatchObject({status:'sent'})
    if(kind==='brain_key') await pool.query("UPDATE brain_keys SET status='revoked' WHERE id=$1",[credentialId])
    if(kind==='oauth_token') await pool.query("UPDATE oauth_authorizations SET revoked_at=now() WHERE id=$1",[credentialId])
    if(kind==='home_app') await pool.query("UPDATE workspace_home_apps SET status='disabled' WHERE id=$1",[credentialId])
    await expect(deliveries.get(context,f.command.deliveryId)).rejects.toMatchObject({code:'not_authorized'})
    expect(send).toHaveBeenCalledTimes(1)
  })
})
