import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { advanceWorkflowRun } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbWorkflowRunStore, createDbWorkflowStore } from '../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
import { createWorkflowChannelDelivery } from '../channel-delivery.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

describe('[COMP:api/application-lifecycle] workflow failure notification metadata', () => {
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it.each(['failed', 'timeout'] as const)('keeps a %s run visible to its member without any automatic provider call', async status => {
    const role = (await getAppPool().query<{ rolsuper: boolean; rolbypassrls: boolean; active: boolean }>(
      "SELECT r.rolsuper,r.rolbypassrls,row_security_active('workflow_runs'::regclass) AS active FROM pg_roles r WHERE r.rolname=current_user",
    )).rows[0]
    expect(role.rolsuper).toBe(false)
    expect(role.rolbypassrls).toBe(false)
    expect(role.active).toBe(true)
    const workspaceId = randomUUID(), ownerId = randomUUID(), actorId = randomUUID(), outsiderId = randomUUID(), assistantId = randomUUID()
    for (const id of [ownerId, actorId, outsiderId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic failure notice workspace',$2,false)", [workspaceId, ownerId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',NULL)", [workspaceId, ownerId, actorId])
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments) VALUES($1,'Synthetic failure notice assistant',$2,$3,'primary','confidential',NULL)", [assistantId, ownerId, workspaceId])
    const hiddenName = 'SYNTHETIC_PRIVATE_WORKFLOW_LABEL', hiddenStep = 'synthetic_private_step'
    const hiddenReason = 'synthetic_private_failure_reason', hiddenDetail = 'SYNTHETIC_PRIVATE_FAILURE_DETAIL'
    const authority = await captureAuthoringAuthoritySystem({ workspaceId, userId: actorId, assistantId })
    const workflows = createDbWorkflowStore(), runs = createDbWorkflowRunStore()
    const channelId = 'C00000001', integrationId = randomUUID()
    const workflow = await workflows.create({ workspaceId, userId: actorId, name: hiddenName, authoringAuthority: authority,
      definition: { startStepId: hiddenStep,
        steps: [{ id: hiddenStep, type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'Return synthetic output' }],
        failureDelivery: { channelType: 'slack', channelId, channelIntegrationId: integrationId },
      },
    })
    expect(await workflows.getById(outsiderId, workflow.id)).toBeNull()
    const run = await runs.createRun({ workspaceId, workflowId: workflow.id, triggeredBy: actorId, triggerKind: 'manual' })
    const providerTexts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/users.list')) return Response.json({ ok: true, members: [] })
      if (!String(url).endsWith('/chat.postMessage')) throw new Error('Unexpected synthetic provider call')
      providerTexts.push(JSON.parse(String(init?.body)).text)
      return Response.json({ ok: true, ts: '1700000000.000001' })
    }))
    const integrationStore = {
      getCredentialsForAssistantIntegrationSystem: async () => ({ id: integrationId,
        credentials: { bot_token: 'synthetic-failure-notice-token' }, config: { deliveryAudienceBindings: [] } }),
    } as unknown as ChannelIntegrationStore
    const consult = vi.fn(async () => {
      throw Object.assign(new Error(hiddenDetail), { reason: status === 'timeout' ? 'timeout' : hiddenReason })
    })
    const deps = { workflowStore: workflows, runStore: runs, resolvePrimary: async () => assistantId,
      resolveRunScope: resolveWorkflowRunScope, buildToolRegistry: async () => new Map(),
      consultTransport: { send: consult }, deliverToChannel: createWorkflowChannelDelivery({ integrationStore }),
    }
    await advanceWorkflowRun(deps, run.id)
    await advanceWorkflowRun(deps, run.id)
    expect(consult).toHaveBeenCalledTimes(1)
    expect(providerTexts).toHaveLength(0)
    const messages = (await pool.query<{ content: unknown }>(`SELECT m.content FROM session_messages m JOIN sessions s ON s.id=m.session_id WHERE s.assistant_id=$1 AND s.channel_id=$2`, [assistantId, channelId])).rows
    expect(messages).toHaveLength(0)
    const visible = await runs.getRunById(actorId, run.id)
    expect(visible?.status).toBe(status)
    expect(String(visible?.error?.message).includes(hiddenDetail)).toBe(true)
    expect((await runs.listStepRuns(actorId, run.id)).some(step => step.stepId === hiddenStep && step.status === 'failed')).toBe(true)
    expect(await runs.getRunById(outsiderId, run.id)).toBeNull()
    expect(await runs.listStepRuns(outsiderId, run.id)).toEqual([])
  })
})
