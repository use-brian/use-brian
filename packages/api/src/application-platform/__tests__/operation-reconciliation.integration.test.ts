/** Current-authority recovery for an operation whose acknowledgement was lost. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { createApplicationClient } from '@use-brian/brian-app/application'
import { createServiceTransport } from '@use-brian/brian-app/module'
import type { PropertyDef } from '@use-brian/core'
import type { Pool } from 'pg'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { ApplicationPlatformService } from '../service.js'
import { authenticateApplicationCredential } from '../credentials.js'
import { loadApplicationCredentialStateSystem } from '../auth-store.js'
import { resolveApplicationExecutionContext } from '../execution-context.js'
import { ApplicationManagementService } from '../management.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
import { applicationPlatformRoutes } from '../../routes/application-platform.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-records] canonical operation reconciliation', () => {
 const pool=getPool(), workspaceId=randomUUID(), ownerId=randomUUID(), memberId=randomUUID(), assistantId=randomUUID()
 let executeCount = 0, effectCount = 0
 const definition = createCanonicalGenericApplicationModule()
 for (const [key, handler] of Object.entries(definition.commands)) definition.commands = { ...definition.commands, [key]: { ...handler, execute: async (context, input) => {
  executeCount++; const result = await handler.execute(context, input); context.afterCommit(() => { effectCount++ }); return result
 } } }
 const secret='fictional-generic-service-session', service=new ApplicationPlatformService([definition])
 const management=new ApplicationManagementService(service), http=express(), tokens=new Map<string,string>(), serviceIds:string[]=[]
 http.use(express.json());http.use('/api/applications',applicationPlatformRoutes({service,management:{service:management,requireAuth:requireAuth(secret),origins:['https://host.example']}}))
 const server=http.listen(0,'127.0.0.1');let origin:string,appId:string,serviceUserId:string,typeId:string,typeKey:string
 const properties:PropertyDef[]=[{name:'title',config:{kind:'text'},required:true,unique:true},{name:'state',config:{kind:'select',options:[{id:'open',name:'Open'},{id:'closed',name:'Closed'}]}},{name:'quantity',config:{kind:'number',format:'int',minimum:1,maximum:100}}]
 const store=createDbDocEntityStore({actorUserId:ownerId}),base=`/api/applications/workspaces/${workspaceId}`
 beforeAll(async()=>{
  if(!server.listening)await once(server,'listening');origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`
  for(const id of [ownerId,memberId])await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional generic application',$2)",[workspaceId,ownerId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')",[workspaceId,ownerId,memberId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional record assistant',$2,$3,'primary','confidential')",[assistantId,ownerId,workspaceId])
  for(const id of [ownerId,memberId]){const session=await authSessionStore.create(id,{deviceLabel:'Fictional native browser',userAgent:'Fixture',ipAddress:'127.0.0.1'});tokens.set(id,createTokens(id,secret,session!).accessToken)}
  const schema=await store.createEntityType({workspaceId,name:'Fictional work register',properties,createdBy:ownerId});typeId=schema.id;typeKey=`record.${typeId}`
 })
 afterAll(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,memberId,...serviceIds]]);await getAppPool().end();await pool.end()})
 const data=(title:string)=>({title:{kind:'text',value:title},state:{kind:'select',value:'open'},quantity:{kind:'number',value:2}})
 async function command(value:Record<string,unknown>,actor=ownerId){return request(http).post(`${base}/management/commands`).set('Authorization',`Bearer ${tokens.get(actor)}`).set('Origin','https://host.example').send(value)}
 async function checked(value:Record<string,unknown>){const result=await command(value);if(result.status===503)await management.executeCommand(ownerId,workspaceId,value);expect(result.status,JSON.stringify(result.body)).toBe(200);return result.body}
 const client=(token:string)=>createApplicationClient({appId,transport:createServiceTransport({apiOrigin:origin,credential:async()=>({kind:'service',token})})})
 function proposal(extra:Record<string,unknown>={}){return {principal:{kind:'service',userId:serviceUserId},origin:{kind:'generic',entityTypeId:typeId},typeKey,actions:['read','query','history','schema','create','patch','delete','command:record_create','command:record_patch','command:record_delete','command:record_batch'],readFields:['title','state','quantity'],writeFields:['title','state','quantity'],selector:{kind:'self'},parentGrantId:null,expiresAt:null,compartments:[],projectIds:[],clearance:'internal',...extra}}
 async function issue(grantIds:string[]){const review=await checked({kind:'credential.review',appId,input:{name:'Fictional record key',kind:'service',serviceUserId,grantIds,expiresAt:new Date(Date.now()+3600_000).toISOString()}});expect(review.canIssue).toBe(true);return checked({kind:'credential.deliver',appId,reviewId:review.id})}
 async function setup(){
  appId=(await checked({kind:'register',input:{moduleKey:'records',name:'Fictional general records',mode:'api_client',origins:[],redirectUris:[]}})).id
  serviceUserId=(await checked({kind:'service.prepare',appId,input:{name:'Fictional records service',idempotencyKey:randomUUID()}})).serviceUserId;serviceIds.push(serviceUserId)
  const before=await checked({kind:'grant.review',appId,input:proposal()});expect(before.canIssue).toBe(false)
  const review=await checked({kind:'activation.review',appId});expect(review.profile).toBe('canonical_records_service_v1')
  expect((await command({kind:'activation.apply',appId,reviewId:review.id},memberId)).status).toBe(403)
  await checked({kind:'activation.apply',appId,reviewId:review.id})
  const grant=await checked({kind:'grant.review',appId,input:proposal()});expect(grant.canIssue).toBe(true)
  const applied=await checked({kind:'grant.apply',appId,reviewId:grant.id}),credential=await issue([applied.grantId])
  return {sdk:client(credential.secret),credential,grantId:applied.grantId}
 }
 async function rpc(native: boolean, token: string, name: string, args: Record<string, unknown>) {
  const path = native ? `${base}/modules/mcp?moduleKey=records` : `/api/applications/${appId}/mcp`
  const response = await request(http).post(path).set('Authorization', 'Bearer ' + token).set('Accept', 'application/json, text/event-stream')
   .send({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } })
  expect(response.status, response.text).toBe(200)
  const line = response.text.split('\n').find(item => item.startsWith('data: '))
  return JSON.parse(line ? line.slice(6) : response.text).result
 }
 async function stableState() {
  const records = (await pool.query('SELECT id,record_version::text,data FROM entity_instances WHERE entity_type_id=$1 ORDER BY id', [typeId])).rows
  const totals = (await pool.query(`SELECT (SELECT count(*)::int FROM application_operation_receipts WHERE workspace_id=$1) AS receipts,
   (SELECT count(*)::int FROM application_command_audit WHERE workspace_id=$1) AS audit,
   (SELECT count(*)::int FROM application_committed_events WHERE workspace_id=$1) AS events`, [workspaceId])).rows[0]
  return { records, totals, executeCount, effectCount }
 }
 const native = (mode: 'query' | 'command' | 'reconcile', body: Record<string, unknown>, actor = ownerId, workspace = workspaceId) => request(http)
  .post(`/api/applications/workspaces/${workspace}/modules/${mode}`).set('Authorization', 'Bearer ' + tokens.get(actor)).send({ moduleKey: 'records', ...body })
 it('reconciles the exact saved request after a lost acknowledgement without executing again or inferring nonexecution from missing history',async()=>{
  const {credential}=await setup(),key=randomUUID(),envelope={idempotencyKey:key,input:{operation:'create',type:typeKey,data:data('Fictional acknowledged outcome')}}
  const endpoint=`/api/applications/${appId}/commands/record_create`,headers={Authorization:`Bearer ${credential.secret}`}
  const missing=await request(http).post(endpoint+'/reconcile').set(headers).send(envelope)
  expect(missing.status,JSON.stringify(missing.body)).toBe(200);expect(missing.body).toEqual({state:'uncertain'})
  const dispatched=await fetch(origin+endpoint,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(envelope)})
  expect(dispatched.ok).toBe(true)
  // The transport loses its acknowledgement; no caller retries the command.
  await dispatched.body?.cancel()
  const before=(await pool.query('SELECT count(*)::int AS n FROM application_operation_receipts WHERE application_client_id=$1',[appId])).rows[0].n
  const saved=await request(http).post(endpoint+'/reconcile').set(headers).send(envelope)
  expect(saved.status,JSON.stringify(saved.body)).toBe(200);expect(saved.headers['cache-control']).toBe('no-store')
  expect(saved.body).toMatchObject({state:'applied',receipt:{idempotencyKey:key,effect:'committed',resources:[{typeKey,version:'1'}]}})
  expect((await pool.query('SELECT count(*)::int AS n FROM application_operation_receipts WHERE application_client_id=$1',[appId])).rows[0].n).toBe(before)
  expect((await pool.query('SELECT count(*)::int AS n FROM entity_instances WHERE entity_type_id=$1',[typeId])).rows[0].n).toBe(1)
  const stable = await stableState()
  const mcp = await rpc(false, credential.secret, 'applicationReconcile', { commandKey: 'record_create', command: envelope })
  expect(mcp.isError).not.toBe(true); expect(JSON.parse(mcp.content[0].text)).toEqual(saved.body)
  expect(await stableState()).toEqual(stable)
  const mismatch=await request(http).post(endpoint+'/reconcile').set(headers).send({...envelope,input:{...envelope.input,data:data('Fictional changed request')}})
  expect(mismatch.status).toBe(409);expect(mismatch.body.error).toBe('record_version_conflict')
  const another=await request(http).post(endpoint+'/reconcile').set(headers).send({...envelope,idempotencyKey:randomUUID()})
  expect(another.status).toBe(200);expect(another.body).toEqual({state:'uncertain'})
 })
 it('refuses revoked parent authority, another app, forged actors and other credential audiences before revealing a saved receipt',async()=>{
  const {credential,grantId}=await setup(),originalApp=appId,key=randomUUID(),envelope={idempotencyKey:key,input:{operation:'create',type:typeKey,data:data('Fictional protected recovery')}}
  const original=`/api/applications/${originalApp}/commands/record_create`
  const committed=await request(http).post(original).set('Authorization','Bearer '+credential.secret).send(envelope)
  expect(committed.status,JSON.stringify(committed.body)).toBe(200)
  const fake=await request(http).post(original+'/reconcile').set('Authorization','Bearer '+credential.secret).send({...envelope,userId:ownerId})
  expect(fake.status).toBe(400)
  const other=await setup()
  const crossed=await request(http).post(original+'/reconcile').set('Authorization','Bearer '+other.credential.secret).send(envelope)
  expect(crossed.status).toBe(401)
  const native=await request(http).post(original+'/reconcile').set('Authorization','Bearer '+tokens.get(ownerId)).send(envelope)
  expect(native.status).toBe(401)
  appId=originalApp
  await checked({kind:'grant.revoke',appId,grantId})
  const revoked=await request(http).post(original+'/reconcile').set('Authorization','Bearer '+credential.secret).send(envelope)
  expect([401,403]).toContain(revoked.status);expect(revoked.body).not.toHaveProperty('receipt')
 })
 it('exposes native receipt recovery over authenticated HTTP and MCP without executing, scheduling effects or changing canonical history', async () => {
  const envelope = { idempotencyKey: randomUUID(), input: { operation: 'create', type: typeKey, data: data('Fictional native recovery') } }
  const args = { commandKey: 'record_create', command: envelope }
  const missing = await native('reconcile', args)
  expect(missing.status, JSON.stringify(missing.body)).toBe(200); expect(missing.body).toEqual({ state: 'uncertain' })
  const before = { executeCount, effectCount }
  const created = await native('command', args)
  expect(created.status, JSON.stringify(created.body)).toBe(200)
  expect(executeCount).toBe(before.executeCount + 1); expect(effectCount).toBe(before.effectCount + 1)
  // A retained pre-wire fingerprint is a negative receipt fixture. Preserve the
  // immutable original receipt; no trigger or runtime write guard is bypassed.
  const legacyKey = randomUUID()
  await pool.query(`INSERT INTO application_operation_receipts(id,workspace_id,module_key,operation_key,actor_key,actor_user_id,idempotency_key,request_hash,resources)
   SELECT $2,workspace_id,module_key,operation_key,actor_key,actor_user_id,$3,$4,resources FROM application_operation_receipts WHERE id=$1`,
   [created.body.id, randomUUID(), legacyKey, 'a'.repeat(64)])
  const stable = await stableState()
  const expected = { state: 'applied', receipt: created.body }
  const saved = await native('reconcile', args)
  expect(saved.status, JSON.stringify(saved.body)).toBe(200); expect(saved.body).toEqual(expected)
  expect(saved.headers['cache-control']).toBe('no-store')
  const mcp = await rpc(true, tokens.get(ownerId)!, 'nativeModuleReconcile', args)
  expect(mcp.isError).not.toBe(true); expect(JSON.parse(mcp.content[0].text)).toEqual(expected)
  for (const command of [{ ...envelope, input: { ...envelope.input, data: data('Fictional changed native request') } }]) {
   const conflict = await native('reconcile', { commandKey: 'record_create', command })
   expect(conflict.status, JSON.stringify(conflict.body)).toBe(409); expect(conflict.body).toMatchObject({ error: 'record_version_conflict', effect: 'none' })
   const mcpConflict = await rpc(true, tokens.get(ownerId)!, 'nativeModuleReconcile', { commandKey: 'record_create', command })
   expect(mcpConflict.isError).toBe(true); expect(JSON.parse(mcpConflict.content[0].text)).toMatchObject({ error: 'record_version_conflict', effect: 'none' })
  }
  const invalidCreateVersion = await native('reconcile', { ...args, command: { ...envelope, expectedVersion: '9' } })
  expect(invalidCreateVersion.status).toBe(400); expect(invalidCreateVersion.body).toMatchObject({ error: 'invalid_value', effect: 'none' })
  const other = await native('reconcile', args, memberId)
  expect(other.status, JSON.stringify(other.body)).toBe(200); expect(other.body).toEqual({ state: 'uncertain' })
  expect((await native('reconcile', { ...args, assistantId: randomUUID() })).status).toBe(403)
  expect((await native('reconcile', args, ownerId, randomUUID())).status).toBe(403)
  const legacyArgs = { ...args, command: { ...envelope, idempotencyKey: legacyKey } }
  const legacy = await native('reconcile', legacyArgs)
  expect(legacy.status).toBe(200); expect(legacy.body).toEqual({ state: 'uncertain' })
  const legacyMcp = await rpc(true, tokens.get(ownerId)!, 'nativeModuleReconcile', legacyArgs)
  expect(legacyMcp.isError).not.toBe(true); expect(JSON.parse(legacyMcp.content[0].text)).toEqual({ state: 'uncertain' })
  expect(await stableState()).toEqual(stable)
  const temporary = await authSessionStore.create(ownerId, { deviceLabel: 'Fictional revoked recovery session', userAgent: 'Fixture', ipAddress: '127.0.0.1' })
  const token = createTokens(ownerId, secret, temporary!).accessToken
  await authSessionStore.revokeForUser(ownerId, temporary!.id)
  const denied = await request(http).post(`${base}/modules/reconcile`).set('Authorization', 'Bearer ' + token).send({ moduleKey: 'records', ...args })
  expect(denied.status).toBe(401); expect(denied.body).not.toHaveProperty('receipt')
  expect(await stableState()).toEqual(stable)
 })
 it('rejects strict unknown and prototype operation inputs across authenticated HTTP and MCP without effects', async () => {
  const { credential } = await setup(), command = { idempotencyKey: randomUUID(), input: { operation: 'create', type: typeKey, data: data('Fictional refused operation') } }
  const stable = await stableState()
  for (const key of ['missing', 'constructor', 'toString', '__proto__']) {
   for (const mode of ['query', 'command', 'reconcile'] as const) {
    const body = mode === 'query' ? { queryKey: key, input: {} } : { commandKey: key, command }
    const denied = await native(mode, body)
    expect(denied.status, JSON.stringify({ mode, key, body: denied.body })).toBe(404)
    expect(denied.body).toEqual({ error: 'operation_not_available', effect: 'none', retrySafe: true })
   }
   for (const nativeAudience of [false, true]) {
    const rejected = await rpc(nativeAudience, nativeAudience ? tokens.get(ownerId)! : credential.secret,
     nativeAudience ? 'nativeModuleReconcile' : 'applicationReconcile', { commandKey: key, command })
    expect(rejected.isError).toBe(true); expect(JSON.stringify(rejected)).not.toContain('receipt')
   }
   const service = await request(http).post(`/api/applications/${appId}/commands/${key}/reconcile`).set('Authorization', 'Bearer ' + credential.secret).send(command)
   expect(service.status).toBe(403); expect(service.body).toMatchObject({ error: 'access_unavailable', effect: 'none' })
  }
  for (const body of [{ commandKey: 'record_create', command, userId: ownerId }, { commandKey: 'record_create', command: { ...command, operationClass: 'existing_recovery' } }]) {
   const denied = await native('reconcile', body)
   expect(denied.status).toBe(400); expect(denied.body).toEqual({ error: 'invalid_value', effect: 'none', retrySafe: false })
  }
  const wrongAudience = await request(http).post(`${base}/modules/reconcile`).set('Authorization', 'Bearer ' + credential.secret)
   .send({ moduleKey: 'records', commandKey: 'record_create', command })
  expect(wrongAudience.status).toBe(401)
  expect(await stableState()).toEqual(stable)
 })
 it('retains exact patch version preconditions across native reconciliation transports without a second mutation', async () => {
  const create = { idempotencyKey: randomUUID(), input: { operation: 'create', type: typeKey, data: data('Fictional versioned recovery') } }
  const created = await native('command', { commandKey: 'record_create', command: create })
  expect(created.status, JSON.stringify(created.body)).toBe(200)
  const command = { idempotencyKey: randomUUID(), expectedVersion: '1', input: { operation: 'patch', type: typeKey,
   id: created.body.resources[0].id, data: { quantity: { kind: 'number', value: 3 } } } }
  const args = { commandKey: 'record_patch', command }, patched = await native('command', args)
  expect(patched.status, JSON.stringify(patched.body)).toBe(200); expect(patched.body.resources[0].version).toBe('2')
  const stable = await stableState(), expected = { state: 'applied', receipt: patched.body }
  expect((await native('reconcile', args)).body).toEqual(expected)
  const saved = await rpc(true, tokens.get(ownerId)!, 'nativeModuleReconcile', args)
  expect(saved.isError).not.toBe(true); expect(JSON.parse(saved.content[0].text)).toEqual(expected)
  const changed = { ...args, command: { ...command, expectedVersion: '2' } }
  const conflict = await native('reconcile', changed)
  expect(conflict.status).toBe(409); expect(conflict.body).toMatchObject({ error: 'record_version_conflict', effect: 'none' })
  const mcpConflict = await rpc(true, tokens.get(ownerId)!, 'nativeModuleReconcile', changed)
  expect(mcpConflict.isError).toBe(true); expect(JSON.parse(mcpConflict.content[0].text)).toMatchObject({ error: 'record_version_conflict', effect: 'none' })
  expect(await stableState()).toEqual(stable)
 })
 it('recovers a durable canonical command after actual COMMIT succeeds but its client acknowledgement is lost', async () => {
  const { credential, sdk } = await setup()
  const fresh = async () => {
   const authentication = await authenticateApplicationCredential(credential.secret, appId, loadApplicationCredentialStateSystem)
   expect(authentication).not.toBeNull()
   return resolveApplicationExecutionContext({ credential: authentication! })
  }
  let committed = false
  // Only the acknowledgement is faulted after the real non-owner PostgreSQL
  // connection commits. Admission, RLS and receipt/audit/event writes stay real.
  const faultingPool = { connect: async () => {
   const client = await getAppPool().connect()
   return new Proxy(client, { get(target, key) {
    const value = Reflect.get(target, key)
    if (key === 'query') return async (...args: unknown[]) => {
     const result = await Reflect.apply(value, target, args)
     if (args[0] === 'COMMIT' && !committed) { committed = true; throw new Error('Fictional lost command commit acknowledgement') }
     return result
    }
    return typeof value === 'function' ? value.bind(target) : value
   } })
  } } as unknown as Pool
  const canonical = new ApplicationPlatformService([definition], faultingPool)
  const command = { idempotencyKey: randomUUID(), input: { operation: 'create', type: typeKey, data: data('Fictional durable unacknowledged command') } }
  const before = await stableState(), original = await fresh()
  await expect(canonical.command(original, 'records', 'record_create', command)).rejects.toMatchObject({ code: 'outcome_uncertain', effect: 'uncertain', retrySafe: false })
  expect(committed).toBe(true)
  const durable = await stableState()
  expect(durable.records).toHaveLength(before.records.length + 1)
  expect(durable.totals).toEqual({ receipts: before.totals.receipts + 1, audit: before.totals.audit + 1, events: before.totals.events + 1 })
  expect(durable.executeCount).toBe(before.executeCount + 1)
  // Post-commit callbacks are withheld when the acknowledgement is uncertain.
  expect(durable.effectCount).toBe(before.effectCount)
  const current = await fresh(); expect(current).not.toBe(original)
  const recovered = await canonical.reconcile(current, 'records', 'record_create', command)
  expect(recovered).toMatchObject({ state: 'applied', receipt: { idempotencyKey: command.idempotencyKey, effect: 'committed', resources: [{ typeKey, version: '1' }] } })
  expect(await sdk.reconcile('record_create', command)).toEqual(recovered)
  const mcp = await rpc(false, credential.secret, 'applicationReconcile', { commandKey: 'record_create', command })
  expect(mcp.isError).not.toBe(true); expect(JSON.parse(mcp.content[0].text)).toEqual(recovered)
  expect(await stableState()).toEqual(durable)
 })
 it('preserves prototype-named JSON through real HTTP and MCP parsing before canonical handler normalization', async () => {
  const { credential } = await setup(), prototypeKeys = Reflect.ownKeys(Object.prototype)
  for (const nativeAudience of [false, true]) {
   const token = nativeAudience ? tokens.get(ownerId)! : credential.secret
   const commandName = nativeAudience ? 'nativeModuleCommand' : 'applicationCommand'
   const reconcileName = nativeAudience ? 'nativeModuleReconcile' : 'applicationReconcile'
   const mcpPath = nativeAudience ? `${base}/modules/mcp?moduleKey=records` : `/api/applications/${appId}/mcp`
   const listed = await request(http).post(mcpPath).set('Authorization', 'Bearer ' + token).set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list' })
   expect(listed.status, listed.text).toBe(200)
   const line = listed.text.split('\n').find(item => item.startsWith('data: '))
   const schema = JSON.parse(line ? line.slice(6) : listed.text).result.tools.find((tool: { name: string }) => tool.name === commandName).inputSchema
   expect(schema.properties.command.properties.input.allOf[0].anyOf.map((branch: { type: string }) => branch.type))
    .toEqual(['null', 'boolean', 'number', 'string', 'array', 'object'])
   const validate = new AjvJsonSchemaValidator().getValidator(schema)
   const meta = (value: number) => Object.fromEntries([['nested', [Object.fromEntries([['__proto__', { value }], ['constructor', 2], ['prototype', 3]])]]])
   const title = Object.fromEntries([['kind', 'text'], ['value', `Fictional wire-key ${nativeAudience ? 'native' : 'service'}`], ['__proto__', meta(1)]])
   const command = { idempotencyKey: randomUUID(), input: { operation: 'create', type: typeKey, data: { ...data('unused'), title } } }
   const args = { commandKey: 'record_create', command }
   expect(validate(args).valid).toBe(true)
   expect(validate({ ...args, command: { ...command, input: { invalid: () => 1 } } }).valid).toBe(false)
   const endpoint = nativeAudience ? `${base}/modules/command` : `/api/applications/${appId}/commands/record_create`
   const envelope = (value: typeof command) => nativeAudience ? { moduleKey: 'records', commandKey: 'record_create', command: value } : value
   const before = { executeCount, effectCount }
   const created = await request(http).post(endpoint).set('Authorization', 'Bearer ' + token).send(envelope(command))
   expect(created.status, JSON.stringify(created.body)).toBe(200)
   expect(executeCount).toBe(before.executeCount + 1); expect(effectCount).toBe(before.effectCount + 1)
   const stable = await stableState()
   // Canonical CellValue parsing intentionally normalizes unknown cell metadata;
   // wire identity must still distinguish it BEFORE that handler parsing.
   const reordered = { ...command, input: { data: { title: Object.fromEntries(Object.entries(title).reverse()), quantity: command.input.data.quantity, state: command.input.data.state }, type: typeKey, operation: 'create' } }
   const replay = await rpc(nativeAudience, token, commandName, { commandKey: 'record_create', command: reordered })
   expect(replay.isError).not.toBe(true); expect(JSON.parse(replay.content[0].text)).toEqual(created.body)
   const reconcileEndpoint = nativeAudience ? `${base}/modules/reconcile` : endpoint + '/reconcile'
   const saved = await request(http).post(reconcileEndpoint).set('Authorization', 'Bearer ' + token).send(envelope(reordered))
   expect(saved.status).toBe(200); expect(saved.body).toEqual({ state: 'applied', receipt: created.body })
   const confirmed = await rpc(nativeAudience, token, reconcileName, { commandKey: 'record_create', command: reordered })
   expect(confirmed.isError).not.toBe(true); expect(JSON.parse(confirmed.content[0].text)).toEqual(saved.body)
   for (const changedTitle of [Object.fromEntries([['kind', 'text'], ['value', title.value], ['__proto__', meta(2)]]), { kind: 'text', value: title.value }]) {
    const changed = { ...command, input: { ...command.input, data: { ...command.input.data, title: changedTitle } } }
    for (const path of [endpoint, reconcileEndpoint]) {
     const conflict = await request(http).post(path).set('Authorization', 'Bearer ' + token).send(envelope(changed))
     expect(conflict.status).toBe(409); expect(conflict.body).toMatchObject({ error: 'record_version_conflict', effect: 'none' })
    }
    for (const name of [commandName, reconcileName]) {
     const conflict = await rpc(nativeAudience, token, name, { commandKey: 'record_create', command: changed })
     expect(conflict.isError).toBe(true); expect(JSON.parse(conflict.content[0].text)).toMatchObject({ error: 'record_version_conflict', effect: 'none' })
    }
   }
   expect(await stableState()).toEqual(stable)
  }
  expect(Reflect.ownKeys(Object.prototype)).toEqual(prototypeKeys)
  expect(({} as { value?: number }).value).toBeUndefined()
 })
})
