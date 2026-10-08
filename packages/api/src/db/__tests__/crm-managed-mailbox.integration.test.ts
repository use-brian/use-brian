import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { crmOperationsRoutes } from '../../routes/crm-operations.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsContext } from '@use-brian/core'
import { createEmailAdapter } from '@use-brian/channels'
import { getPool, getAppPool } from '../client.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { withCrmMailAdmission } from '../../crm-operations/delivery-policy.js'
import { sendGmailMessage } from '../../google/client.js'
import { createAgentmailClient } from '../../agentmail/client.js'
import { composeMailboxMessage, sendComposedMessage } from '../../mailbox/smtp.js'
import type { MailboxAccountSettings } from '../../mailbox/types.js'

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(async () => ({})), close: vi.fn() }))
vi.mock('nodemailer', () => ({ default: { createTransport: () => smtp }, createTransport: () => smtp }))
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool=getPool(), appPool=getAppPool(), service=createCrmOperationsService(createDbCrmOperationsStore())
const recipient='person@example.com'
async function fixture(provider:'gmail'|'imap'|'agentmail'='gmail') {
  const userId=randomUUID(),workspaceId=randomUUID(),connectorInstanceId=randomUUID(),contactId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id,is_personal) VALUES($1,'Mail admission fixture',$2,true)`,[workspaceId,userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`,[workspaceId,userId])
  await pool.query(`INSERT INTO connector_instance(id,scope,workspace_id,provider,label,connected) VALUES($1,'workspace',$2,$3,'Fixture inbox',true)`,[connectorInstanceId,workspaceId,provider])
  await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source)
    VALUES($1,$2,'person','Fixture person',$3,$4,'manual')`,[contactId,workspaceId,recipient,userId])
  const context:CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}}
  const run=(input:unknown)=>service.execute(context,CrmOperationsCommandSchema.parse(input))
  await run({kind:'save_consent_purpose',purposeKey:'updates',label:'Updates',wordingVersion:'1',wording:'Fixture wording',applicableChannels:['email']})
  const consent=(action='granted')=>run({kind:'record_consent',contactId,purposeKey:'updates',action,source:'fixture'})
  const policy=(expectedVersion=0,extra={})=>run({kind:'save_managed_mailbox_policy',connectorInstanceId,providerKey:'outreach',expectedVersion,confirmed:true,managed:true,purposeKeys:['updates'],...extra})
  const scope={userId,workspaceId,connectorInstanceId}
  return {userId,workspaceId,connectorInstanceId,contactId,context,run,consent,policy,scope}
}
const ok=()=>new Response(JSON.stringify({id:'sent',threadId:'thread',message_id:'sent',thread_id:'thread'}),{status:200})
const denied=(reason:string)=>({details:{reason}})
const intent={crmPurposeKey:'updates'}

describe('[COMP:crm/delivery-policy] Final managed mailbox admission',()=>{
  afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks()})
  afterAll(async()=>{await pool.end();await appPool.end()})
  it('requires current human owner policy approval, stable binding, version and purpose mapping',async()=>{
    const f=await fixture()
    expect((await f.policy()).duplicate).toBe(false)
    expect((await f.policy(1)).duplicate).toBe(true)
    await expect(f.policy()).rejects.toMatchObject(denied('stale_mailbox_policy_version'))
    await expect(f.policy(1,{providerKey:'renamed'})).rejects.toMatchObject(denied('mailbox_provider_key_immutable'))
    await expect(f.policy(1,{purposeKeys:['missing']})).rejects.toMatchObject(denied('mailbox_purpose_unavailable'))
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1`,[f.workspaceId])
    await expect(f.policy(1)).rejects.toMatchObject({code:'not_authorized'})
    expect((await pool.query(`SELECT count(*)::int n FROM association_audit_log WHERE workspace_id=$1 AND action='crm.mailbox_policy.approved'`,[f.workspaceId])).rows[0].n).toBe(1)
  })
  it('exposes owner policy configuration through the actual member route and isolates app-role reads',async()=>{
    const f=await fixture(),other=await fixture()
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=f.userId;next()})
    app.use('/api/crm',crmOperationsRoutes({service,readStore:createDbCrmIntakeReadStore(),workspaceStore:createWorkspaceStore()}))
    const path=`/api/crm/${f.workspaceId}/operations/mailbox-policies/${f.connectorInstanceId}`
    expect((await request(app).get(path)).body).toEqual({policy:null})
    const body={providerKey:'outreach',expectedVersion:0,confirmed:true,managed:true,purposeKeys:['updates']}
    expect((await request(app).post(path).send(body)).status).toBe(200)
    expect((await request(app).get(path)).body.policy).toMatchObject({version:1,managed:true})
    expect((await request(app).post(path).send(body)).status).toBe(409)
    expect((await request(app).get(`/api/crm/${other.workspaceId}/operations/mailbox-policies/${other.connectorInstanceId}`)).status).toBe(404)
    const client=await appPool.connect()
    try {await client.query('BEGIN');await client.query(`SELECT set_config('app.current_user_id',$1,true)`,[other.userId])
      expect((await client.query('SELECT id FROM crm_managed_mailbox_policies WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
    } finally {await client.query('ROLLBACK');client.release()}
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1`,[f.workspaceId])
    expect((await request(app).get(path)).status).toBe(403)
    expect((await request(app).post(path).send({...body,expectedVersion:1,managed:false})).status).toBe(403)
  })
  it('keeps unconfigured ordinary mail, but refuses missing scope and unconfigured CRM intent',async()=>{
    const f=await fixture(), fetch=vi.fn(async()=>ok());vi.stubGlobal('fetch',fetch)
    await sendGmailMessage('fixture-token',{to:recipient,subject:'Fixture',body:'Text'},f.scope)
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(sendGmailMessage('fixture-token',{to:recipient,subject:'Fixture',body:'Text',...intent},f.scope)).rejects.toMatchObject(denied('mailbox_management_unconfigured'))
    await expect(sendGmailMessage('fixture-token',{to:recipient,subject:'Fixture',body:'Text'})).rejects.toMatchObject(denied('delivery_context_required'))
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([false,true])('guards both Gmail HTTP boundaries (attachments=%s), after approval',async attachments=>{
    const f=await fixture();await f.policy();await f.consent()
    const fetch=vi.fn(async()=>ok());vi.stubGlobal('fetch',fetch)
    const message={to:recipient,subject:'Fixture',body:'Text',...intent,...(attachments?{attachments:[{filename:'fixture.txt',mime:'text/plain',data:new Uint8Array([65])}]}:{})}
    await sendGmailMessage('fixture-token',message,f.scope)
    expect(fetch).toHaveBeenCalledTimes(1)
    await f.consent('withdrawn')
    await expect(sendGmailMessage('fixture-token',message,f.scope)).rejects.toMatchObject(denied('delivery_recipient_not_allowed'))
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['cc','bcc'] as const)('refuses unknown %s without partially sending to an allowed To',async field=>{
    const f=await fixture();await f.policy();await f.consent();const invoke=vi.fn()
    await expect(withCrmMailAdmission(f.scope,'gmail',{to:recipient,[field]:['unresolved@example.com'],...intent},invoke)).rejects.toMatchObject({details:{reason:'delivery_identity_unresolved',recipientIndex:1}})
    expect(invoke).not.toHaveBeenCalled()
  })
  it('rejects unknown consent, missing purpose, template mismatch and ambiguous identity',async()=>{
    const f=await fixture();await f.policy();const invoke=vi.fn()
    await expect(withCrmMailAdmission(f.scope,'gmail',{to:recipient},invoke)).rejects.toMatchObject(denied('delivery_purpose_required'))
    await expect(withCrmMailAdmission(f.scope,'gmail',{to:recipient,...intent,crmTemplateKey:'other'},invoke)).rejects.toMatchObject(denied('delivery_template_purpose_mismatch'))
    await expect(withCrmMailAdmission(f.scope,'gmail',{to:recipient,...intent},invoke)).rejects.toMatchObject({details:{verdict:'unknown'}})
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,attributes,created_by_user_id,source)
      VALUES($1,$2,'person','Second fixture','second@example.com',$3::jsonb,$4,'manual')`,[randomUUID(),f.workspaceId,JSON.stringify({email:recipient}),f.userId])
    await expect(withCrmMailAdmission(f.scope,'gmail',{to:recipient,...intent},invoke)).rejects.toMatchObject(denied('delivery_identity_ambiguous'))
    expect(invoke).not.toHaveBeenCalled()
  })
  it('checks final SMTP envelope including blind recipients before constructing a transport',async()=>{
    const f=await fixture('imap');await f.policy();await f.consent()
    const settings={smtpHost:'smtp.example.com',smtpPort:465,email:'sender@example.com',appPassword:'fixture'} as MailboxAccountSettings
    const compose=(bcc:string[]=[])=>composeMailboxMessage({from:'sender@example.com',to:[recipient],bcc,subject:'Fixture',body:'Text'})
    await sendComposedMessage(settings,await compose(),f.scope,intent)
    expect(smtp.sendMail).toHaveBeenCalledTimes(1)
    await expect(sendComposedMessage(settings,await compose(['other@example.com']),f.scope,intent)).rejects.toMatchObject(denied('delivery_identity_unresolved'))
    expect(smtp.sendMail).toHaveBeenCalledTimes(1)
  })
  it('guards raw AgentMail sends and refuses mutable or scheduled managed provider drafts',async()=>{
    const f=await fixture('agentmail');await f.policy();await f.consent()
    const fetch=vi.fn(async(_url:string,_init?:RequestInit)=>ok()),api=createAgentmailClient({apiKey:'fixture',fetchImpl:fetch})
    await api.sendMessage('sender@example.com',{to:[recipient],text:'Fixture'},f.scope,intent)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({to:[recipient],text:'Fixture'})
    await api.replyToMessage('sender@example.com','incoming',{to:[recipient],text:'Reply'},f.scope,intent)
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({to:[recipient],cc:[],bcc:[],reply_all:false,text:'Reply'})
    await expect(api.createDraft('sender@example.com',{to:[recipient],send_at:'2030-01-01T00:00:00Z'},f.scope,intent)).rejects.toMatchObject(denied('managed_provider_scheduling_unavailable'))
    await expect(api.sendDraft('sender@example.com','draft',f.scope,intent)).rejects.toMatchObject(denied('managed_recipient_snapshot_required'))
    await expect(api.replyToMessage('sender@example.com','incoming',{text:'Fixture'},f.scope,intent)).rejects.toMatchObject(denied('managed_recipient_snapshot_required'))
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('preserves only exact interactive replies and never leaks that privilege beyond the adapter call',async()=>{
    const fetch=vi.fn(async(_url:string,_init?:RequestInit)=>ok()),api=createAgentmailClient({apiKey:'fixture',fetchImpl:fetch})
    const inboxId='sender@example.com',messageId='incoming'
    const adapter=createEmailAdapter({inboxAddress:inboxId,replyToMessageId:messageId,sanitizeDeliveryText:text=>text,
      send:{reply:async p=>{
        await expect(api.replyToMessage(inboxId,'other',{text:p.text})).rejects.toMatchObject(denied('delivery_context_required'))
        await expect(api.replyToMessage(inboxId,messageId,{text:p.text,to:[recipient]})).rejects.toMatchObject(denied('delivery_context_required'))
        const result=await api.replyToMessage(inboxId,messageId,{text:p.text});return {messageId:result.message_id,threadId:result.thread_id}
      }}})
    await adapter.sendMessage('thread',{text:'Fixture reply'})
    await expect(api.replyToMessage(inboxId,messageId,{text:'Outside adapter'})).rejects.toMatchObject(denied('delivery_context_required'))
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('blocks current disconnection and cross-workspace instance use',async()=>{
    const f=await fixture(),other=await fixture();await f.policy();await f.consent();const invoke=vi.fn()
    await expect(withCrmMailAdmission({...f.scope,connectorInstanceId:other.connectorInstanceId},'gmail',{to:recipient,...intent},invoke)).rejects.toMatchObject({code:'not_authorized'})
    await pool.query('UPDATE connector_instance SET connected=false WHERE id=$1',[f.connectorInstanceId])
    await expect(withCrmMailAdmission(f.scope,'gmail',{to:recipient,...intent},invoke)).rejects.toMatchObject(denied('delivery_connector_unavailable'))
    expect(invoke).not.toHaveBeenCalled()
  })
  it('reports ambiguous provider outcomes without content or a false not-sent claim',async()=>{
    const f=await fixture();await f.policy();await f.consent()
    await expect(withCrmMailAdmission(f.scope,'gmail',{to:recipient,...intent},async()=>{throw new Error('private message bytes')})).rejects.toMatchObject(denied('provider_outcome_unknown'))
    await expect(withCrmMailAdmission(f.scope,'gmail',{to:recipient,...intent},async()=>{throw Object.assign(new Error('private'),{status:400})})).rejects.toMatchObject(denied('provider_rejected'))
  })
  it('serializes a later withdrawal through the actual provider invocation',async()=>{
    const f=await fixture();await f.policy();await f.consent()
    let release!:()=>void, started!:()=>void, providerPid=0
    const hold=new Promise<void>(r=>{release=r}),entered=new Promise<void>(r=>{started=r})
    const sending=withCrmMailAdmission(f.scope,'gmail',{to:recipient,...intent},async(_admission,client)=>{providerPid=Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);started();await hold})
    await entered
    let withdrawn=false
    const withdrawal=f.consent('withdrawn').then(()=>{withdrawn=true})
    try {
      const deadline=Date.now()+5000;let waiting=false
      while(Date.now()<deadline) {
        const result=await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))`,[providerPid])
        if(result.rowCount){waiting=true;break}
      }
      expect(waiting).toBe(true);expect(withdrawn).toBe(false)
    } finally {release();await sending;await withdrawal}
    await expect(withCrmMailAdmission(f.scope,'gmail',{to:recipient,...intent},vi.fn())).rejects.toMatchObject(denied('delivery_recipient_not_allowed'))
  })
})
