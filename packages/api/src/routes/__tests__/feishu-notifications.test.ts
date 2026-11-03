import {createHash,randomUUID,randomBytes} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import type {Server} from 'node:http'
import express from 'express'
import pg from 'pg'
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest'
import {feishuNotificationRoutes} from '../feishu-notifications.js'
import {sendFeishuNotification} from '../../feishu/client.js'
import type {ChannelIntegrationStore} from '../../db/channel-integrations.js'
const database=process.env.NOTIFICATION_TEST_DATABASE_URL

describe.skipIf(!database)('[COMP:channels/feishu-notifications] durable service ingress',()=>{
 const schema='notification_test_'+randomUUID().replaceAll('-',''), admin=new pg.Pool({connectionString:database})
 const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema},public`})
 const clientId=randomUUID(),workspace=randomUUID(),assistant=randomUUID(),integration=randomUUID(),token='bn_'+randomBytes(32).toString('base64url')
 let server:Server,base:string
 const sender=vi.fn(async()=>({status:'delivered' as const,messageId:'om_notification_test'}))
 const integrations={getCredentialsForAssistantIntegrationSystem:vi.fn(async()=>({status:'active',credentials:{app_id:'fixture_app',app_secret:'fixture_secret',brand:'feishu'}}))} as unknown as ChannelIntegrationStore
 const body=()=>({id:randomUUID(),recipientKey:'person_1',title:'待办更新',text:'您的待办有更新。',url:'https://coo.example/my-work'})
 const post=(data:unknown,credential=token)=>fetch(base,{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify(data)})
 beforeAll(async()=>{
  await admin.query(`create schema ${schema}`)
  for(const table of ['workspaces','assistants','channel_integrations'])await pool.query(`create table ${table}(id uuid primary key)`)
  await pool.query(await readFile(new URL('../../../migrations/8181_feishu_application_notifications.sql',import.meta.url),'utf8'))
  for(const [table,id] of [['workspaces',workspace],['assistants',assistant],['channel_integrations',integration]])await pool.query(`insert into ${table}(id) values($1)`,[id])
  const app=express();app.use(express.json({limit:'8kb'}));app.use('/internal/notifications/feishu',feishuNotificationRoutes({pool,integrations,send:sender}))
  server=await new Promise<Server>(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value))});base=`http://127.0.0.1:${(server.address() as {port:number}).port}/internal/notifications/feishu`
 })
 beforeEach(async()=>{
  await pool.query('truncate feishu_notification_clients cascade');sender.mockReset();sender.mockResolvedValue({status:'delivered',messageId:'om_notification_test'})
  await pool.query("insert into feishu_notification_clients(id,token_hash,workspace_id,assistant_id,integration_id,app_origin,approval_evidence,expires_at) values($1,$2,$3,$4,$5,$6,'isolated verified fixture',now()+interval '1 hour')",[clientId,createHash('sha256').update(token).digest('hex'),workspace,assistant,integration,'https://coo.example'])
  await pool.query("insert into feishu_notification_recipients(client_id,recipient_key,open_id) values($1,'person_1','ou_fixture')",[clientId])
 })
 afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();await admin.query(`drop schema ${schema} cascade`);await admin.end()})
 it('pins the approved integration/recipient and persists replay receipts',async()=>{
  const input=body();expect((await post(input)).status).toBe(200);expect((await post(input)).status).toBe(200);expect(sender).toHaveBeenCalledTimes(1)
  expect(integrations.getCredentialsForAssistantIntegrationSystem).toHaveBeenCalledWith(workspace,assistant,integration,'feishu','ou_fixture')
  expect(sender).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:expect.any(String),openId:'ou_fixture'}))
  const receipt=await fetch(base+'/'+input.id,{headers:{authorization:`Bearer ${token}`}});expect(await receipt.json()).toMatchObject({id:input.id,status:'delivered',messageId:'om_notification_test'})
 })
 it('rejects unknown credentials, recipients, external origins and extra destination arguments',async()=>{
  expect((await post(body(),'bn_'+randomBytes(32).toString('base64url'))).status).toBe(401)
  expect((await post({...body(),recipientKey:'unmapped'})).status).toBe(403)
  expect((await post({...body(),url:'https://another.example/my-work'})).status).toBe(403)
  expect((await post({...body(),openId:'ou_foreign'})).status).toBe(400)
  expect(sender).not.toHaveBeenCalled()
 })
 it('serializes concurrent duplicate IDs and rejects changed replay content',async()=>{
  const input=body();await Promise.all([post(input),post(input),post(input)]);expect(sender).toHaveBeenCalledTimes(1)
  expect((await post({...input,text:'different'})).status).toBe(409)
 })
 it('does not resend an uncertain result or an interrupted reservation',async()=>{
  sender.mockRejectedValueOnce(new Error('timeout'));const input=body();expect((await post(input)).status).toBe(503)
  expect(await (await post(input)).json()).toMatchObject({status:'uncertain'});expect(sender).toHaveBeenCalledTimes(1)
  await pool.query("update feishu_notification_receipts set status='sending',updated_at=now()-interval '2 minutes' where id=$1",[input.id]);expect(await (await post(input)).json()).toMatchObject({status:'uncertain'});expect(sender).toHaveBeenCalledTimes(1)
 })
 it('requires current client enablement and keeps receipts client-scoped',async()=>{
  const input=body();await post(input)
  await pool.query('update feishu_notification_clients set enabled=false where id=$1',[clientId])
  expect((await post(body())).status).toBe(401)
  expect((await fetch(base+'/'+input.id,{headers:{authorization:`Bearer ${token}`}})).status).toBe(401)
 })
 it('allows only an explicitly reconciled not-sent receipt to be attempted again',async()=>{
  const input=body();sender.mockRejectedValueOnce(new Error('timeout'));await post(input)
  await pool.query("update feishu_notification_receipts set status='not_sent',reconciliation_evidence='isolated test provider confirmed absence',reconciled_at=now() where id=$1",[input.id])
  expect((await fetch(base+'/'+input.id,{headers:{authorization:`Bearer ${token}`}})).status).toBe(404)
  await post(input);expect(sender).toHaveBeenCalledTimes(2)
 })
})
describe('[COMP:channels/feishu-notifications] provider result classification',()=>{
 it('sends app-scoped recipient and provider dedup ID, distinguishing failure and uncertainty',async()=>{
  const request=vi.fn().mockResolvedValue({code:0,data:{message_id:'om_fixture'}})
  const factory=(()=>({rawClient:{request}})) as any
  const input={id:randomUUID(),openId:'ou_fixture',text:'待办更新'}
  expect(await sendFeishuNotification({appId:'fixture',appSecret:'fixture',brand:'feishu'},input,factory)).toEqual({status:'delivered',messageId:'om_fixture'})
  expect(request).toHaveBeenCalledWith(expect.objectContaining({url:'/open-apis/im/v1/messages?receive_id_type=open_id',data:expect.objectContaining({uuid:input.id,receive_id:'ou_fixture'})}))
  request.mockResolvedValue({code:230013});expect((await sendFeishuNotification({appId:'fixture',appSecret:'fixture',brand:'feishu'},input,factory)).status).toBe('failed')
  request.mockRejectedValue(new Error('timeout'));expect((await sendFeishuNotification({appId:'fixture',appSecret:'fixture',brand:'feishu'},input,factory)).status).toBe('uncertain')
 })
})
