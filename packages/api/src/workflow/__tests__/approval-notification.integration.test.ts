import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbWorkflowStore } from '../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { createApprovalDeliveryDispatcher } from '../approval-deliveries.js'
import { createWorkflowChannelDelivery } from '../channel-delivery.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

describe('[COMP:api/application-lifecycle] approval notification metadata', () => {
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('delivers a useful fixed notice to an unbound group without copying private workflow or operation names', async () => {
    const workspaceId = randomUUID(), ownerId = randomUUID(), actorId = randomUUID(), outsiderId = randomUUID(), assistantId = randomUUID()
    for (const id of [ownerId, actorId, outsiderId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic approval workspace',$2,false)", [workspaceId, ownerId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',NULL)", [workspaceId, ownerId, actorId])
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments) VALUES($1,'Synthetic approval assistant',$2,$3,'primary','confidential',NULL)", [assistantId, ownerId, workspaceId])
    const hiddenName = 'SYNTHETIC_PRIVATE_WORKFLOW_LABEL', hiddenTool = 'syntheticPrivateOperation', hiddenArgument = 'SYNTHETIC_PRIVATE_ARGUMENT'
    const authority = await captureAuthoringAuthoritySystem({ workspaceId, userId: actorId, assistantId })
    const workflows = createDbWorkflowStore()
    const workflow = await workflows.create({ workspaceId, userId: actorId, name: hiddenName, authoringAuthority: authority,
      definition: { startStepId: 'action', steps: [{ id: 'action', type: 'tool_call', toolName: hiddenTool, arguments: { value: hiddenArgument } }] },
    })
    // Real member RLS proves the workflow metadata is not public.
    expect(await workflows.getById(outsiderId, workflow.id)).toBeNull()
    const providerTexts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/users.list')) return Response.json({ ok: true, members: [] })
      if (!String(url).endsWith('/chat.postMessage')) throw new Error('Unexpected synthetic provider call')
      providerTexts.push(JSON.parse(String(init?.body)).text)
      return Response.json({ ok: true, ts: '1700000000.000001' })
    }))
    const integrationId = randomUUID(), channelId = 'C00000001', approvalId = randomUUID()
    const integrationStore = {
      getCredentialsForAssistantIntegrationSystem: async () => ({ id: integrationId,
        credentials: { bot_token: 'synthetic-approval-token' }, config: { deliveryAudienceBindings: [] } }),
    } as unknown as ChannelIntegrationStore
    const deliver = createWorkflowChannelDelivery({ integrationStore })
    const outcomes: string[] = []
    await createApprovalDeliveryDispatcher({ webBaseUrl: 'https://app.example', deliverToChannel: async input => {
      const result = await deliver(input)
      outcomes.push(result.status)
      return result
    } })({
      workspaceId, approverUserId: actorId, assistantId, approvalId, workflowName: workflow.name,
      stepId: 'action', toolName: hiddenTool, arguments: { value: hiddenArgument }, deliveryChannelType: 'slack', deliveryChannelId: channelId,
      recentTarget: { channelType: 'slack', channelId, channelIntegrationId: integrationId },
    })
    expect(outcomes).toEqual(['delivered'])
    expect(providerTexts).toHaveLength(1)
    const stored = (await pool.query<{ content: unknown }>(`SELECT m.content FROM session_messages m JOIN sessions s ON s.id=m.session_id WHERE s.assistant_id=$1 AND s.channel_id=$2`, [assistantId, channelId])).rows
    expect(stored).toHaveLength(1)
    const providerText = providerTexts[0], persisted = JSON.stringify(stored)
    // Boolean assertions prevent a red run from printing protected sentinels.
    for (const hidden of [hiddenName, hiddenTool, hiddenArgument]) {
      expect(providerText.includes(hidden)).toBe(false)
      expect(persisted.includes(hidden)).toBe(false)
    }
    expect(providerText.includes(`/w/${workspaceId}/approvals?focus=${approvalId}`)).toBe(true)
    expect(providerText.includes('Approve or reject on the web:')).toBe(true)
  })
})
