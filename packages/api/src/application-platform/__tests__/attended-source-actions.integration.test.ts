import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { ContextScopeAccumulator } from '@use-brian/core'
import { getPool, getAppPool, queryWithRLS } from '../../db/client.js'
import { findAssistantById } from '../../db/users.js'
import { buildConnectorAuthHeaders } from '../../mcp/auth-headers.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { ApplicationPlatformService } from '../service.js'
import { ApplicationManagementService } from '../management.js'
import { sourceServiceFixture } from './fixtures/source-service.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/attended-source-actions] source-owned human command receipts', () => {
  const pool = getPool(), metadataKey = 'source/operation-key'
  let f: Awaited<ReturnType<typeof sourceServiceFixture>>, instanceId: string, profileId: string
  let management: ApplicationManagementService
  const args = (version: number, value: string) => ({ id: 'order-1', expectedVersion: String(version), values: { cost: value } })
  const manage = (command: unknown) => management.executeCommand(f.owner,f.workspace,command,{audience:'human',assistantId:f.assistant})
  async function runtime(userId = f.owner, authenticationKind: 'native_session' | 'verified_channel' = 'native_session') {
    const execution = (await resolveExecutionContextSystem({userId,workspaceId:f.workspace,assistant:(await findAssistantById(f.assistant))!,memberMode:'member',
      identity:{kind:'attended',principal:{kind:'workspace_member',userId,authenticationKind}},ownership:{kind:'workspace',workspaceId:f.workspace},
      lifecycle:{sessionId:randomUUID(),sessionPersisted:false,channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal}})).executionContext
    const accumulator = new ContextScopeAccumulator()
    const value = await f.factory({workspaceId:f.workspace,instanceId,execution,accumulator,
      headers:buildConnectorAuthHeaders(await f.instances.getAuthCredentialsSystem(instanceId)) ?? {}})
    if (!value) throw new Error('Missing attended fixture runtime')
    return {runtime:value,execution,accumulator}
  }
  beforeAll(async () => {
    f = await sourceServiceFixture({attendedActions:{idempotencyMetadataKey:metadataKey}})
    const original = (await pool.query<{connector_instance_id:string;audience:string}>('SELECT connector_instance_id,audience FROM connector_source_profiles WHERE id=$1',[f.profile])).rows[0]
    instanceId = original.connector_instance_id
    await pool.query("UPDATE connector_source_profiles SET status='revoked' WHERE id=$1",[f.profile])
    await f.sourcePool.query("INSERT INTO accounts(kind,id) VALUES('human',$1)",[f.owner])
    await f.sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('human',$1,'order-1',ARRAY['description','cost'],ARRAY['read','context','derive','retain','deliver','mutate'])",[f.owner])
    management = new ApplicationManagementService(new ApplicationPlatformService([]))
    const review = await manage({kind:'connector.source.review',input:{instanceId,tenant:'fixture-tenant',audience:original.audience,sourceBaseUrl:f.source.url,
      probeTool:'readRecord',probeInput:{id:'order-1',fields:['description']},actions:{tools:['updateRecord'],idempotencyMetadataKey:metadataKey}}}) as {reviewId:string;profileId:string}
    profileId = review.profileId
    expect(await manage({kind:'connector.source.apply',reviewId:review.reviewId})).toMatchObject({profile:'attended_governed_actions_v1',state:'qualified'})
    expect((await queryWithRLS(f.owner,"SELECT application_runtime_qualified($1,'connector_source') AS ready",[f.workspace])).rows[0].ready).toBe(false)
  })
  afterAll(async () => { await f?.cleanup(); await getAppPool().end(); await pool.end() })

  it('retains the ordinary source tool while exposing a durable operation envelope', async () => {
    const actor = await runtime(), catalog = await actor.runtime.discover('Fictional actions')
    const tool = catalog.tools.find(tool => tool.name === 'updateRecord')!
    expect(tool.inputSchema).toMatchObject({required:['operationId','mode','input'],properties:{input:{type:'object'}}})
    expect(catalog.tools.find(tool => tool.name === 'readRecord')?.readOnlyHint).toBe(true)
    expect(f.source.counters.effects).toBe(0)
    await expect(queryWithRLS(f.owner,'SELECT * FROM connector_attended_commands')).rejects.toMatchObject({code:'42501'})
  })
  it('executes once, reconciles a concurrent/restarted duplicate, and refuses changed input', async () => {
    const actor = await runtime(), operationId = randomUUID(), input = args(1,'38.00')
    const command = {operationId,mode:'execute',input}
    const results = await Promise.all([actor.runtime.call('updateRecord',command),actor.runtime.call('updateRecord',command)])
    expect(results.some(result => (result as {state:string}).state === 'applied')).toBe(true)
    expect(f.source.counters.effects).toBe(1)
    const restarted = await runtime()
    expect(await restarted.runtime.call('updateRecord',command)).toMatchObject({operationId,state:'applied'})
    expect(await restarted.runtime.call('updateRecord',{...command,mode:'reconcile'})).toMatchObject({state:'applied'})
    await expect(restarted.runtime.call('updateRecord',{...command,input:args(2,'99.00')})).rejects.toMatchObject({code:'source_access_denied'})
    expect(f.source.counters.effects).toBe(1)
    expect(actor.accumulator.evidence.sources).toHaveLength(1)
    expect(JSON.stringify(results)).toContain('38.00')
    const rows = (await pool.query('SELECT actor_id,assistant_id,input_digest,receipt,state FROM connector_attended_commands WHERE profile_id=$1',[profileId])).rows
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({actor_id:f.owner,assistant_id:f.assistant,state:'applied'})
    expect(JSON.stringify(rows)).not.toContain('38.00')
  })
  it('recovers a lost acknowledgement without repeating the committed source effect', async () => {
    f.source.setAfterEffect(async () => { throw new Error('Fictional lost response') })
    try {
      const actor = await runtime(), command = {operationId:randomUUID(),mode:'execute',input:args(2,'39.00')}
      expect(await actor.runtime.call('updateRecord',command)).toMatchObject({state:'applied'})
      expect(await (await runtime()).runtime.call('updateRecord',command)).toMatchObject({state:'applied'})
      expect(f.source.counters.effects).toBe(2)
    } finally { f.source.setAfterEffect() }
  })
  it('reports an authorized committed receipt while withholding a newly forbidden result projection', async () => {
    f.source.setAfterEffect(async () => {await f.sourcePool.query("UPDATE grants SET actions=array_remove(actions,'context') WHERE kind='human' AND account_id=$1",[f.owner])})
    try{
      const actor=await runtime(),result=await actor.runtime.call('updateRecord',{operationId:randomUUID(),mode:'execute',input:args(3,'39.50')})
      expect(result).toMatchObject({state:'applied',retrySafe:false})
      expect(JSON.stringify(result)).not.toContain('39.50')
      expect(actor.accumulator.evidence.sources??[]).toEqual([])
      expect(f.source.counters.effects).toBe(3)
    }finally{
      f.source.setAfterEffect()
      await f.sourcePool.query("UPDATE grants SET actions=array_append(actions,'context') WHERE kind='human' AND account_id=$1",[f.owner])
    }
  })
  it('uses a verified channel member and the source current field/action permissions', async () => {
    await f.sourcePool.query("UPDATE grants SET fields=ARRAY['description'],actions=array_remove(actions,'mutate') WHERE kind='human' AND account_id=$1",[f.reader])
    const actor = await runtime(f.reader,'verified_channel')
    const command = {operationId:randomUUID(),mode:'execute',input:args(4,'40.00')}
    expect(await actor.runtime.call('updateRecord',command)).toMatchObject({state:'uncertain'})
    expect(f.source.counters.effects).toBe(3)
    await f.sourcePool.query("UPDATE grants SET fields=ARRAY['description','cost'],actions=array_append(actions,'mutate') WHERE kind='human' AND account_id=$1",[f.reader])
    // Restoring rights cannot revive a sender for an already-attempted key.
    expect(await (await runtime(f.reader,'verified_channel')).runtime.call('updateRecord',command)).toMatchObject({state:'uncertain'})
    expect(f.source.counters.effects).toBe(3)
    expect(await (await runtime(f.reader,'verified_channel')).runtime.call('updateRecord',{...command,operationId:randomUUID()})).toMatchObject({state:'applied'})
    expect(f.source.counters.effects).toBe(4)
  })
  it('never uses a cached success after source permission loss and revokes live profile closures', async () => {
    const row = (await pool.query<{operation_id:string}>('SELECT operation_id FROM connector_attended_commands WHERE profile_id=$1 AND actor_id=$2 ORDER BY created_at LIMIT 1',[profileId,f.owner])).rows[0]
    await f.sourcePool.query("UPDATE grants SET actions=array_remove(actions,'mutate') WHERE kind='human' AND account_id=$1",[f.owner])
    const actor = await runtime()
    expect(await actor.runtime.call('updateRecord',{operationId:row.operation_id,mode:'reconcile',input:args(1,'38.00')})).toMatchObject({state:'uncertain'})
    expect(await manage({kind:'connector.source.revoke',profileId})).toEqual({revoked:true})
    await expect(actor.runtime.call('updateRecord',{operationId:randomUUID(),mode:'execute',input:args(5,'41.00')})).rejects.toMatchObject({code:'source_unavailable'})
    expect(f.source.counters.effects).toBe(4)
  })
  it('refuses an action capability mismatch and a mutation disguised as a read-only setup probe', async () => {
    await f.sourcePool.query("UPDATE grants SET actions=array_append(actions,'mutate') WHERE kind='human' AND account_id=$1",[f.owner])
    const original=(await pool.query<{audience:string}>('SELECT audience FROM connector_source_profiles WHERE id=$1',[profileId])).rows[0]
    const base={instanceId,tenant:'fixture-tenant',audience:original.audience,sourceBaseUrl:f.source.url,probeTool:'readRecord',probeInput:{id:'order-1',fields:['description']}}
    for(const input of [{...base,actions:{tools:['updateRecord'],idempotencyMetadataKey:'source/unsupported-key'}},
      {...base,probeTool:'updateRecord',probeInput:args(5,'99.00')},
      {...base,actions:{tools:['readRecord'],idempotencyMetadataKey:metadataKey}}]){
      const review=await manage({kind:'connector.source.review',input}) as {reviewId:string;profileId:string}
      await expect(manage({kind:'connector.source.apply',reviewId:review.reviewId})).rejects.toMatchObject({code:'access_unavailable'})
      expect(f.source.counters.effects).toBe(4)
      expect(await manage({kind:'connector.source.revoke',profileId:review.profileId})).toEqual({revoked:true})
    }
  })
  it('does not turn an administrator or a fabricated Brian delivery into a native owner', async () => {
    await pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.workspace,f.reader])
    await expect(management.executeCommand(f.reader,f.workspace,{kind:'connector.identity.prepare'},{audience:'human',assistantId:f.assistant})).rejects.toMatchObject({code:'access_unavailable'})
    await expect(management.executeCommand(f.owner,f.workspace,{kind:'connector.identity.prepare'},{audience:'brian',assistantId:f.assistant})).rejects.toMatchObject({code:'authentication_required'})
  })
  it('does not turn a reconnected profile into a new sender for an old operation',async()=>{
    const original=(await pool.query<{audience:string}>('SELECT audience FROM connector_source_profiles WHERE id=$1',[profileId])).rows[0]
    const operation=(await pool.query<{operation_id:string}>('SELECT operation_id FROM connector_attended_commands WHERE profile_id=$1 AND actor_id=$2 ORDER BY created_at LIMIT 1',[profileId,f.owner])).rows[0]
    const review=await manage({kind:'connector.source.review',input:{instanceId,tenant:'fixture-tenant',audience:original.audience,sourceBaseUrl:f.source.url,
      probeTool:'readRecord',probeInput:{id:'order-1',fields:['description']},actions:{tools:['updateRecord'],idempotencyMetadataKey:metadataKey}}}) as {reviewId:string}
    expect(await manage({kind:'connector.source.apply',reviewId:review.reviewId})).toMatchObject({state:'qualified'})
    const actor=await runtime()
    await expect(actor.runtime.call('updateRecord',{operationId:operation.operation_id,mode:'execute',input:args(1,'38.00')})).rejects.toMatchObject({code:'source_access_denied'})
    expect(f.source.counters.effects).toBe(4)
    expect(await actor.runtime.call('updateRecord',{operationId:randomUUID(),mode:'execute',input:args(5,'41.00')})).toMatchObject({state:'applied'})
    expect(f.source.counters.effects).toBe(5)
  })
})
