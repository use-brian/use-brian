import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createConfirmationResolver, type ScopeEvidence, type ScopeSource, type ToolConfirmationRequest } from '@use-brian/core'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { createDbChannelIntegrationStore, type ChannelIntegrationStore, type DeliveryAudienceBinding } from '../../db/channel-integrations.js'
import { encryptCredentials } from '../../db/credential-crypto.js'
import { createDeliveryAudienceAuthorizer } from '../../context-scope/delivery-authority.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { sendConfirmationPrompt } from '../confirmation-prompt.js'
import { findSchedulerChannelConfirmations, registerSchedulerResolver, tryResolveSchedulerConfirmation, unregisterSchedulerResolver } from '../confirmation-registry.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const registered: string[] = []

async function fixture() {
  const workspaceId = randomUUID(), ownerId = randomUUID(), actorId = randomUUID(), approverId = randomUUID()
  const outsiderId = randomUUID(), assistantId = randomUUID(), channelId = randomUUID(), integrationId = randomUUID(), sourceId = randomUUID()
  for (const id of [ownerId, actorId, approverId, outsiderId]) {
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  }
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic confirmation workspace',$2,false)", [workspaceId, ownerId])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'product','Product'),($1,'finance','Finance')", [workspaceId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments) VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',ARRAY['product']),($1,$4,'admin','confidential',NULL)", [workspaceId, ownerId, actorId, approverId])
  await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments) VALUES($1,'Synthetic confirmation assistant',$2,$3,'primary','confidential',NULL)", [assistantId, ownerId, workspaceId])
  const payload = `SYNTHETIC_CONFIRMATION_CONTENT_${randomUUID()}`
  await pool.query("INSERT INTO knowledge_entries(id,workspace_id,path,title,content,created_by,sensitivity,compartments) VALUES($1,$2,'synthetic-confirmation.md','Synthetic reference',$3,$4,'internal',ARRAY['product'])", [sourceId, workspaceId, payload, actorId])
  const { executionContext } = await resolveExecutionContextSystem({ userId: actorId, workspaceId,
    assistant: { id: assistantId, workspaceId, kind: 'primary', clearance: 'confidential', compartments: null },
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: actorId, authenticationKind: 'verified_channel' } },
    ownership: { kind: 'workspace', workspaceId },
    lifecycle: { sessionId: randomUUID(), channelType: 'slack', channelId: 'C00000001', abortSignal: new AbortController().signal },
  })
  const nativeRead = await executionContext.security.authority.execute(() => queryWithRLS(actorId,
    'SELECT content FROM knowledge_entries WHERE id=$1', [sourceId]))
  expect(nativeRead.rows.length).toBe(1)
  expect(nativeRead.rows[0].content === payload).toBe(true)
  expect((await queryWithRLS(outsiderId, 'SELECT id FROM knowledge_entries WHERE id=$1', [sourceId])).rows.length).toBe(0)
  const role = (await queryWithRLS(actorId,
    "SELECT r.rolsuper,r.rolbypassrls,row_security_active('knowledge_entries'::regclass) AS active FROM pg_roles r WHERE r.rolname=current_user")).rows[0]
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false, active: true })
  const source = (await pool.query<{ source: ScopeSource }>("SELECT read_scope_source($1,'knowledge_entry',$2) AS source", [workspaceId, sourceId])).rows[0].source
  expect(source.userId === null && source.assistantId === null).toBe(true)
  const evidence: ScopeEvidence = { sources: [source] }
  const destination = 'C00000001'
  const binding: DeliveryAudienceBinding = { version: 1, channelId: destination, audienceType: 'group', clearance: 'internal',
    compartments: ['product'], projectIds: [], recipientUserId: null, expiresAt: null,
    approvedByUserId: approverId, approvedAt: new Date().toISOString() }
  const key = randomBytes(32)
  await pool.query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'slack','Synthetic confirmation channel')", [channelId, workspaceId])
  await pool.query("INSERT INTO channel_integrations(id,channel_type,channel_id,credentials,config) VALUES($1,'slack',$2,$3,$4)",
    [integrationId, channelId, encryptCredentials({ bot_token: 'synthetic-confirmation-token', signing_secret: 'synthetic-unused-secret' }, key), { deliveryAudienceBindings: [binding] }])
  await pool.query('INSERT INTO channel_assistants(channel_id,assistant_id) VALUES($1,$2)', [channelId, assistantId])
  const store = createDbChannelIntegrationStore(key)
  const toolCallId = randomUUID(), resolver = createConfirmationResolver()
  const resumed = vi.spyOn(resolver, 'resolve')
  registered.push(toolCallId)
  registerSchedulerResolver(toolCallId, resolver, { userId: actorId, workspaceId, assistantId, channelType: 'slack', channelId: destination })
  const scope = { workspaceId, assistantId, userId: actorId, integrationId, channelType: 'slack', channelId: destination }
  const request: ToolConfirmationRequest = { toolCallId, toolName: 'syntheticProtectedOperation', serverName: 'synthetic',
    input: { value: payload }, displayLines: [payload], classification: null, description: 'Synthetic action' }
  const texts: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/users.list')) return Response.json({ ok: true, members: [] })
    if (!String(url).endsWith('/chat.postMessage')) throw new Error('Unexpected synthetic provider call')
    const body = JSON.parse(String(init?.body))
    expect(body.channel === destination).toBe(true)
    texts.push(body.text)
    return Response.json({ ok: true, ts: '1700000000.000001' })
  }))
  const deliver = async (afterCredentials?: () => Promise<unknown>) => {
    let first = true
    const transportStore: ChannelIntegrationStore = { ...store,
      async getCredentialsForAssistantIntegrationSystem(...args) {
        const selected = await store.getCredentialsForAssistantIntegrationSystem(...args)
        expect(selected?.id === integrationId).toBe(true)
        if (first && afterCredentials) { first = false; await afterCredentials() }
        return selected
      },
    }
    return sendConfirmationPrompt({ workspaceId, assistantId, channelType: 'slack', channelId: destination, channelIntegrationId: integrationId }, request,
      { integrationStore: transportStore, userId: actorId, scopeEvidence: evidence,
        authorizeDeliveryAudience: createDeliveryAudienceAuthorizer({ integrationStore: store }) })
  }
  return { workspaceId, approverId, integrationId, sourceId, payload, texts, scope, toolCallId, resolver, resumed, deliver }
}

describe('[COMP:scheduling/confirmation-prompt] [COMP:api/application-lifecycle] native outbound confirmation audience', () => {
  afterEach(() => { vi.unstubAllGlobals(); for (const id of registered.splice(0)) unregisterSchedulerResolver(id) })
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('sends protected details to an unchanged approved group and binds one current reply', async () => {
    const f = await fixture()
    expect(await f.deliver()).toMatchObject({ delivered: true, channelType: 'slack' })
    expect(f.texts.length).toBe(1)
    expect(f.texts[0].includes(f.payload)).toBe(true)
    expect(findSchedulerChannelConfirmations(f.scope).length).toBe(1)
    expect(tryResolveSchedulerConfirmation(f.toolCallId, 'allow', f.scope)).toBe(true)
    expect(tryResolveSchedulerConfirmation(f.toolCallId, 'allow', f.scope)).toBe(false)
    expect(f.resumed).toHaveBeenCalledExactlyOnceWith(f.toolCallId, 'allow')
    expect(await f.resolver.waitForDecision(f.toolCallId, 1_000)).toEqual({ decision: 'allow' })
  })

  it.each(['clearance', 'compartment', 'hold', 'audience', 'approver', 'integration'] as const)(
    'refuses a current %s contraction after credential lookup before sending protected details or binding a reply', async change => {
      const f = await fixture()
      const result = await f.deliver(async () => {
        if (change === 'clearance') await pool.query("UPDATE knowledge_entries SET sensitivity='confidential' WHERE id=$1", [f.sourceId])
        if (change === 'compartment') await pool.query("UPDATE knowledge_entries SET compartments=ARRAY['finance'] WHERE id=$1", [f.sourceId])
        if (change === 'hold') await pool.query('UPDATE knowledge_entries SET scope_held=true WHERE id=$1', [f.sourceId])
        if (change === 'audience') await pool.query("UPDATE channel_integrations SET config='{}'::jsonb WHERE id=$1", [f.integrationId])
        if (change === 'approver') await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.approverId])
        if (change === 'integration') await pool.query("UPDATE channel_integrations SET status='revoked' WHERE id=$1", [f.integrationId])
      })
      expect(result.delivered).toBe(false)
      expect(result.reason?.includes(f.payload)).toBe(false)
      expect(f.texts.length).toBe(0)
      expect(findSchedulerChannelConfirmations(f.scope).length).toBe(0)
      expect(tryResolveSchedulerConfirmation(f.toolCallId, 'allow', f.scope)).toBe(false)
      expect(f.resumed).not.toHaveBeenCalled()
    },
  )
})
