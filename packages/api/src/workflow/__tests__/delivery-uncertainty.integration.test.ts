import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { advanceWorkflowRun } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbWorkflowRunStore, createDbWorkflowStore } from '../../db/workflow-store.js'
import { findOrCreateSession } from '../../db/sessions.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
import { createWorkflowChannelDelivery } from '../channel-delivery.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

describe('[COMP:api/application-lifecycle] durable Slack delivery outcomes', () => {
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it.each(['partial', 'unknown', 'none', 'complete'] as const)('saves %s receipt and never repeats a terminal workflow delivery', async effect => {
    const workspaceId = randomUUID(), ownerId = randomUUID(), userId = randomUUID(), assistantId = randomUUID()
    for (const id of [ownerId, userId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic delivery workspace',$2,false)", [workspaceId, ownerId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',NULL)", [workspaceId, ownerId, userId])
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments) VALUES($1,'Synthetic delivery assistant',$2,$3,'primary','confidential',NULL)", [assistantId, ownerId, workspaceId])
    const channelId = 'D00000001'
    await findOrCreateSession({ assistantId, userId, channelType: 'slack', channelId })
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
    await advanceWorkflowRun(deps, run.id)
    expect(posts).toBe(expectedPosts)
    expect(consult).toHaveBeenCalledTimes(1)
    expect((await runs.listStepRuns(userId, run.id))[0].output).toEqual(steps[0].output)
    // A non-member does not obtain the saved outcome through the canonical store.
    expect(await runs.listStepRuns(randomUUID(), run.id)).toEqual([])
  })
})
