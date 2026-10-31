import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { advanceWorkflowRun, buildTool, type ScopeSource } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDeal } from '../../db/crm.js'
import { createDbWorkflowRunStore, createDbWorkflowStore } from '../../db/workflow-store.js'
import { getGroupAudienceBindingsSystem, type ChannelIntegrationStore } from '../../db/channel-integrations.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
import { persistentContextFixture } from '../../application-platform/__tests__/fixtures/persistent-context.js'
import { createWorkflowChannelDelivery } from '../channel-delivery.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:workflow/tool-delivery] native CRM tool notification', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  afterEach(async () => { vi.unstubAllGlobals(); await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it.each(['internal', 'confidential', 'private'] as const)('enforces the approved General/Internal audience for %s evidence', async label => {
    fixture = await persistentContextFixture()
    const f = fixture, channelId = 'C00000001', channelRowId = randomUUID(), integrationId = randomUUID()
    const entity = await createDeal(f.ownerId, { workspaceId: f.workspaceId,
      sensitivity: label === 'confidential' ? 'confidential' : 'internal' })
    if (label === 'private') await f.pool.query('UPDATE entities SET user_id=$1 WHERE id=$2 AND workspace_id=$3', [f.ownerId, entity.id, f.workspaceId])
    const eventId = randomUUID()
    await f.pool.query(`INSERT INTO crm_domain_event_outbox(id,workspace_id,event_type,event_key,subject_kind,subject_id,payload,actor_kind)
      VALUES($1::uuid,$2,'crm.deal.stage_changed',$1::text,'deal',$3,'{}','user')`, [eventId, f.workspaceId, entity.id])
    const sources = (await f.pool.query<{ source: ScopeSource }>(`SELECT jsonb_build_object(
      'workspaceId',source->'workspaceId','userId',source->'userId','assistantId',source->'assistantId',
      'sensitivity',source->'sensitivity','compartments',source->'compartments','projectIds',source->'projectIds',
      'resourceKind',kind,'resourceId',id,'version',source->'version') AS source
      FROM (SELECT kind,id,read_scope_source($1,kind,id) AS source
        FROM (VALUES('crm_event'::text,$2::uuid),('entity'::text,$3::uuid)) input(kind,id)) snapshots`,
    [f.workspaceId, eventId, entity.id])).rows.map(row => row.source)
    expect(sources).toHaveLength(2)
    expect(sources.every(source => source.version && source.resourceId)).toBe(true)

    const binding = { version: 1, channelId, audienceType: 'group', clearance: 'internal',
      compartments: [], projectIds: [], companyWide: false, recipientUserId: null,
      expiresAt: null, approvedByUserId: f.ownerId, approvedAt: new Date().toISOString() }
    await f.pool.query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'slack','Synthetic SDR')", [channelRowId, f.workspaceId])
    await f.pool.query(`INSERT INTO channel_integrations(id,channel_type,channel_id,credentials,config)
      VALUES($1,'slack',$2,$3,$4)`, [integrationId, channelRowId, Buffer.from('fixture-no-secret'), { deliveryAudienceBindings: [binding] }])
    const integrationStore = { getGroupAudienceBindingsSystem,
      getCredentialsForAssistantSystem: async () => ({ id: integrationId, credentials: { bot_token: 'fixture-not-a-real-token' } }),
    } as unknown as ChannelIntegrationStore
    const authoringAuthority = await captureAuthoringAuthoritySystem({ workspaceId: f.workspaceId, userId: f.ownerId, assistantId: f.assistantId })
    const workflows = createDbWorkflowStore(), runs = createDbWorkflowRunStore()
    const workflow = await workflows.create({ workspaceId: f.workspaceId, userId: f.ownerId,
      name: 'Synthetic deterministic CRM notification', authoringAuthority,
      definition: { startStepId: 'notify', steps: [{ id: 'notify', type: 'tool_call', toolName: 'fixtureReadEnquiry', arguments: {},
        deliver: { channelType: 'slack', channelId }, deliveryText: 'Saved enquiry {{prev.reference}}' }] } })
    const run = await runs.createRun({ workspaceId: f.workspaceId, workflowId: workflow.id, triggeredBy: f.ownerId, triggerKind: 'manual' })
    const tool = buildTool({ name: 'fixtureReadEnquiry', description: 'Read this disposable CRM enquiry', inputSchema: z.object({}),
      async execute() { return { data: { reference: entity.id }, scopeEvidence: { sources } } } })
    const toolCall = vi.spyOn(tool, 'execute'), consult = vi.fn(async () => { throw new Error('A deterministic notification must not consult a model') })
    let providerCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/users.list')) return Response.json({ ok: true, members: [] })
      if (!String(url).endsWith('/chat.postMessage')) throw new Error('Unexpected fixture provider request')
      providerCalls++
      // DB-first means the complete canonical lineage exists before Slack is contacted.
      const saved = (await f.pool.query(`SELECT m.id,m.content FROM session_messages m JOIN sessions s ON s.id=m.session_id
        WHERE s.workspace_id=$1 AND s.channel_type='slack' AND s.channel_id=$2`, [f.workspaceId, channelId])).rows
      expect(saved).toHaveLength(1)
      expect(JSON.stringify(saved[0].content)).toContain(`Saved enquiry ${entity.id}`)
      const edges = (await f.pool.query(`SELECT e.source_kind,e.source_id,e.source_version FROM scope_derivations d
        JOIN scope_derivation_sources e ON e.workspace_id=d.workspace_id AND e.derivation_id=d.id
        WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2`, [f.workspaceId, saved[0].id])).rows
      expect(edges.map(edge => [edge.source_kind, edge.source_id, edge.source_version]).sort())
        .toEqual(sources.map(source => [source.resourceKind, source.resourceId, source.version]).sort())
      return Response.json({ ok: true, ts: '1700000000.000001' })
    }))
    const deps = { workflowStore: workflows, runStore: runs, resolvePrimary: async () => f.assistantId,
      resolveRunScope: resolveWorkflowRunScope, buildToolRegistry: async () => new Map([[tool.name, tool]]),
      consultTransport: { send: consult }, deliverToChannel: createWorkflowChannelDelivery({ integrationStore }) }
    expect(await advanceWorkflowRun(deps, run.id)).toMatchObject({ kind: 'completed' })
    const steps = await runs.listStepRuns(f.ownerId, run.id)
    expect(steps).toHaveLength(1)
    expect((steps[0].output as { __delivery: unknown }).__delivery).toMatchObject(label === 'internal'
      ? { status: 'delivered', messageId: '1700000000.000001' }
      : { status: 'skipped', reason: 'delivery_audience_unverified', detail: 'evidence_exceeds_audience' })
    expect(providerCalls).toBe(label === 'internal' ? 1 : 0)
    if (label !== 'internal') expect((await f.pool.query(`SELECT m.id FROM session_messages m JOIN sessions s ON s.id=m.session_id
      WHERE s.workspace_id=$1 AND s.channel_type='slack' AND s.channel_id=$2`, [f.workspaceId, channelId])).rows).toEqual([])
    await advanceWorkflowRun(deps, run.id)
    expect(toolCall).toHaveBeenCalledTimes(1)
    expect(consult).not.toHaveBeenCalled()
    expect(providerCalls).toBe(label === 'internal' ? 1 : 0)
  })
})
