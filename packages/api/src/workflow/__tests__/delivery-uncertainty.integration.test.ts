import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { advanceWorkflowRun } from '@use-brian/core/workflow/executor.js'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { conversationAnchorWriteAdmissionActive, initializeConversationVisibility } from '../../db/conversation-visibility.js'
import { createDbWorkflowRunStore, createDbWorkflowStore } from '../../db/workflow-store.js'
import { findOrCreateSession } from '../../db/sessions.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
import { createWorkflowChannelDelivery } from '../channel-delivery.js'
import { findOrCreateChannelRoom } from '../../channel-room/room.js'
import { createDbChannelIntegrationStore,encryptCredentials,type ChannelIntegrationStore } from '../../db/channel-integrations.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

describe('[COMP:api/application-lifecycle] durable Slack delivery outcomes', () => {
  beforeAll(async () => {
    await initializeConversationVisibility()
    expect(conversationAnchorWriteAdmissionActive()).toBe(true)
  })
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it.each(['partial', 'unknown', 'none', 'complete'] as const)('saves %s receipt and never repeats a terminal workflow delivery', async effect => {
    const workspaceId = randomUUID(), ownerId = randomUUID(), userId = randomUUID(), assistantId = randomUUID()
    for (const id of [ownerId, userId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic delivery workspace',$2,false)", [workspaceId, ownerId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',NULL)", [workspaceId, ownerId, userId])
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments) VALUES($1,'Synthetic delivery assistant',$2,$3,'primary','confidential',NULL)", [assistantId, ownerId, workspaceId])
    const channelId = 'D00000001'
    const destination = await findOrCreateSession({ assistantId, userId, channelType: 'slack', channelId })
    const authority = await captureAuthoringAuthoritySystem({ workspaceId, userId, assistantId })
    const workflows = createDbWorkflowStore(), runs = createDbWorkflowRunStore()
    const workflow = await workflows.create({ workspaceId, userId, name: 'Synthetic delivery workflow', authoringAuthority: authority,
      definition: { startStepId: 'deliver', steps: [{ id: 'deliver', type: 'assistant_call', target: { assistantId: 'primary' },
        prompt: 'Return synthetic test output', deliver: { channelType: 'slack', channelId } }] },
    })
    const run = await runs.createRun({ workspaceId, workflowId: workflow.id, triggeredBy: userId, triggerKind: 'manual' })
    let posts = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/users.list')) return Response.json({ ok: true, members: [] })
      if (!String(url).endsWith('/chat.postMessage')) throw new Error('Unexpected synthetic HTTP method')
      posts++
      if (effect === 'unknown') throw new Error('Synthetic lost response')
      if (effect === 'none' || effect === 'partial' && posts === 2) return Response.json({ ok: false, error: 'channel_not_found' })
      return Response.json({ ok: true, ts: `1700000000.00000${posts}` })
    }))
    const integrationStore = { getCredentialsForAssistantSystem: async () => ({
      id: randomUUID(), credentials: { bot_token: 'synthetic-delivery-receipt-token' },
    }) } as unknown as ChannelIntegrationStore
    const consult = vi.fn(async () => ({ task: {
      taskId: randomUUID(), contextId: randomUUID(),
      status: { state: 'completed' as const, timestamp: new Date().toISOString() }, artifacts: [],
      history: [{ messageId: randomUUID(), role: 'agent' as const, parts: [{ kind: 'text' as const, text: 'Synthetic chunk. '.repeat(300) }] }],
    } }))
    const deps = { workflowStore: workflows, runStore: runs, resolvePrimary: async () => assistantId,
      resolveRunScope: resolveWorkflowRunScope, buildToolRegistry: async () => new Map(),
      consultTransport: { send: consult }, deliverToChannel: createWorkflowChannelDelivery({ integrationStore }),
    }
    expect(await advanceWorkflowRun(deps, run.id)).toMatchObject({ kind: 'completed' })
    const expectedPosts = effect === 'partial' || effect === 'complete' ? 2 : 1
    expect(posts).toBe(expectedPosts)
    const steps = await runs.listStepRuns(userId, run.id)
    expect(steps).toHaveLength(1)
    const delivery = (steps[0].output as { __delivery: unknown }).__delivery
    expect(delivery).toMatchObject({ status: effect === 'complete' ? 'delivered' : 'failed', receipt: {
      effect, retrySafe: effect === 'none', channelId, attemptedMessages: expectedPosts,
      messageIds: effect === 'partial' ? ['1700000000.000001'] : effect === 'complete' ? ['1700000000.000001', '1700000000.000002'] : [],
    } })
    expect(JSON.stringify((delivery as { receipt: unknown }).receipt)).not.toContain('Synthetic chunk')
    const recorded = await queryWithRLS(userId,'SELECT content,scope_version::int AS version FROM public.session_messages WHERE session_id=$1',[destination.id])
    expect(recorded.rows).toHaveLength(1)
    expect(recorded.rows[0]).toMatchObject({version:1,content:[{type:'text',text:expect.stringContaining('Synthetic chunk.')}]})
    await advanceWorkflowRun(deps, run.id)
    expect(posts).toBe(expectedPosts)
    expect(consult).toHaveBeenCalledTimes(1)
    expect((await runs.listStepRuns(userId, run.id))[0].output).toEqual(steps[0].output)
    // A non-member does not obtain the saved outcome through the canonical store.
    expect(await runs.listStepRuns(randomUUID(), run.id)).toEqual([])
  })

  it('refuses a changed destination after committing its local record and before any provider send', async () => {
    const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), integrationId = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic revocation fixture',$2,false)",[workspaceId,userId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Synthetic assistant',$2,$3,'primary','confidential')",[assistantId,userId,workspaceId])
    const channelId = 'D00000002'
    const destination = await findOrCreateSession({assistantId,userId,channelType:'slack',channelId})
    const provider = vi.fn(async () => { throw new Error('The held destination must never reach Slack') })
    vi.stubGlobal('fetch',provider)
    const getCredentials = vi.fn(async () => {
      const saved = await pool.query('SELECT id FROM public.session_messages WHERE session_id=$1',[destination.id])
      if (saved.rows.length) await pool.query('UPDATE public.sessions SET recording_privacy_held=true WHERE id=$1',[destination.id])
      return {id:integrationId,credentials:{bot_token:'synthetic-credential'}}
    })
    const deliver = createWorkflowChannelDelivery({integrationStore:{getCredentialsForAssistantSystem:getCredentials} as unknown as ChannelIntegrationStore})
    expect(await deliver({workspaceId,assistantId,userId,channelType:'slack',channelId,
      text:'A committed synthetic reply.',scopeEvidence:{}})).toMatchObject({status:'skipped',reason:'delivery_audience_unverified'})
    expect(provider).not.toHaveBeenCalled()
    expect((await pool.query('SELECT content,scope_version::int AS version FROM public.session_messages WHERE session_id=$1',[destination.id])).rows)
      .toEqual([{version:1,content:[{type:'text',text:'A committed synthetic reply.'}]}])
    expect((await queryWithRLS(userId,'SELECT content FROM public.session_messages WHERE session_id=$1',[destination.id])).rows).toEqual([])
    // A fresh attempt while the same destination is held writes no new row.
    expect(await deliver({workspaceId,assistantId,userId,channelType:'slack',channelId,
      text:'This must not be appended.',scopeEvidence:{}})).toMatchObject({status:'skipped',reason:'delivery_audience_unverified'})
    expect((await pool.query('SELECT id FROM public.session_messages WHERE session_id=$1',[destination.id])).rowCount).toBe(1)
  })

  it('persists an approved group delivery in the addressed Slack room and refuses a held room',async()=>{
    const workspaceId=randomUUID(),userId=randomUUID(),assistantId=randomUUID(),integrationId=randomUUID(),channel=randomUUID()
    const key=Buffer.alloc(32,31),channelId='C79226401'
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional group workflow',$2,false)",[workspaceId,userId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional assistant',$2,$3,'primary','internal')",[assistantId,userId,workspaceId])
    await pool.query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'slack','Fictional group')",[channel,workspaceId])
    const binding={version:1,channelId,audienceType:'group',clearance:'internal',compartments:[],projectIds:[],
      recipientUserId:null,expiresAt:null,approvedByUserId:userId,approvedAt:new Date().toISOString()}
    await pool.query("INSERT INTO channel_integrations(id,channel_id,channel_type,credentials,config) VALUES($1,$2,'slack',$3,$4)",
      [integrationId,channel,encryptCredentials({bot_token:'synthetic-group-token',signing_secret:'synthetic-signing-secret'},key),
        JSON.stringify({deliveryAudienceBindings:[binding]})])
    await pool.query('INSERT INTO channel_assistants(channel_id,assistant_id) VALUES($1,$2)',[channel,assistantId])
    const {room}=await findOrCreateChannelRoom({workspaceId,assistantId,channelId,channelType:'slack',
      starterUserId:userId,channelIntegrationId:integrationId})
    let posts=0,withdrawAfterAcknowledgement=false
    const provider=vi.fn(async(url:string|URL|Request)=>{
      if(String(url).endsWith('/users.list'))return Response.json({ok:true,members:[]})
      expect(String(url)).toMatch(/\/chat\.postMessage$/)
      posts++
      if(withdrawAfterAcknowledgement)
        await pool.query('UPDATE public.sessions SET recording_privacy_held=true WHERE id=$1',[room.id])
      return Response.json({ok:true,ts:`1700000000.00000${posts}`})
    })
    vi.stubGlobal('fetch',provider)
    const deliver=createWorkflowChannelDelivery({integrationStore:createDbChannelIntegrationStore(key)})
    const input={workspaceId,assistantId,userId,channelType:'slack' as const,channelId,channelIntegrationId:integrationId,scopeEvidence:{}}
    expect(await deliver({...input,text:'Fictional shared workflow reply.'})).toMatchObject({status:'delivered'})
    expect(await queryWithRLS(userId,'SELECT content,user_id FROM public.session_messages WHERE session_id=$1',[room.id])).toMatchObject({
      rows:[{content:[{type:'text',text:'Fictional shared workflow reply.'}],user_id:null}]})
    withdrawAfterAcknowledgement=true
    expect(await deliver({...input,text:'Fictional multi-message workflow reply. '.repeat(200)})).toMatchObject({status:'failed',
      receipt:{effect:'partial',retrySafe:false,attemptedMessages:1,messageIds:['1700000000.000002']}})
    expect(posts).toBe(2)
    const beforeHold=provider.mock.calls.length
    expect(await deliver({...input,text:'Held shared reply.'})).toMatchObject({status:'skipped',reason:'delivery_audience_unverified'})
    expect(provider.mock.calls).toHaveLength(beforeHold)
    expect((await pool.query('SELECT id FROM public.session_messages WHERE session_id=$1',[room.id])).rowCount).toBe(2)
    expect((await pool.query("SELECT id FROM public.sessions WHERE workspace_id=$1 AND channel_type='slack' AND channel_id=$2",
      [workspaceId,channelId])).rows).toEqual([{id:room.id}])
    expect((await queryWithRLS(userId,'SELECT id FROM public.session_messages WHERE session_id=$1',[room.id])).rows).toEqual([])
  })
})
