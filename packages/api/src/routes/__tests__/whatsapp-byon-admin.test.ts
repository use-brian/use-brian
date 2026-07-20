/**
 * [COMP:api/whatsapp-ingest-admin] WhatsApp ingest connect + group enable.
 *
 * Covers the control plane the Studio UI drives: the connected-number
 * eligibility gate (only seenChats groups enable), group_match rule writes
 * (realtime / weekday-digest scheduled), disable, the status + inventory
 * read, and the owner/admin gate. The connect SSE proxy's wa-connector I/O
 * is mocked away — only its guards (config + role) are asserted here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// Module-level helpers the connect path reaches — mocked so no DB/connector.
vi.mock('../../db/channels-store.js', () => ({
  findOrCreateChannelForWorkspaceConnect: vi.fn(),
  updateChannel: vi.fn(),
}))
vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../ingest/whatsapp-connector-instance.js', () => ({
  ensureWhatsappConnectorInstance: vi.fn(),
}))

import { whatsappIngestAdminRoutes } from '../whatsapp-byon-admin.js'
import { query } from '../../db/client.js'
import type { IngestRuleEditorStore, IngestRuleSummary } from '@use-brian/core'

const mockQuery = vi.mocked(query)
import type { ChannelIntegration, ChannelIntegrationStore } from '../../db/channel-integrations.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'

const USER = 'u_owner'
const WS = 'ws_1'
const CI = 'ci_wa_1'
const CHANNEL = 'chan_wa_1'
const INTEGRATION = 'cint_wa_1'
const GROUP = '120363000000000000@g.us'
const UNSEEN = '120363999999999999@g.us'

function fakeIntegration(seenJids: string[] = [GROUP]): ChannelIntegration {
  return {
    id: INTEGRATION,
    channelId: CHANNEL,
    channelType: 'whatsapp',
    teamId: null,
    teamName: '+15551234567',
    botUserId: null,
    botUsername: null,
    config: {
      seenChats: seenJids.map((jid) => ({
        chatId: jid,
        chatTitle: 'Team Ops',
        isForum: false,
        topics: [],
        lastSeenAt: '2026-06-20T00:00:00.000Z',
      })),
    },
    status: 'active',
    connectorInstanceId: CI,
  } as unknown as ChannelIntegration
}

function fakeRule(over: Partial<IngestRuleSummary> = {}): IngestRuleSummary {
  return {
    id: 'rule_1',
    connectorInstanceId: CI,
    source: 'whatsapp',
    ruleOrder: 0,
    filterType: 'group_match',
    filterParams: { values: [GROUP] },
    routingMode: 'scheduled',
    routingSchedule: '0 9 * * 1-5',
    routingTimezone: 'UTC',
    alert: false,
    episodeSensitivity: null,
    ...over,
  }
}

function makeApp(opts: {
  role?: 'owner' | 'admin' | 'member' | null
  integration?: ChannelIntegration | null
  rules?: IngestRuleSummary[]
  cis?: Array<{ id: string }>
  waConfigured?: boolean
}) {
  const workspaceStore = {
    getRole: vi.fn(async () => (opts.role === undefined ? 'owner' : opts.role)),
  } as unknown as WorkspaceStore

  const integrationStore = {
    listForWorkspace: vi.fn(async () =>
      opts.integration === undefined ? [fakeIntegration()] : opts.integration ? [opts.integration] : [],
    ),
    upsert: vi.fn(async () => fakeIntegration()),
  } as unknown as ChannelIntegrationStore

  const ruleEditor = {
    listConnectorInstances: vi.fn(async () => opts.cis ?? [{ id: CI }]),
    listRules: vi.fn(async () => opts.rules ?? []),
    addRule: vi.fn(async () => fakeRule({ id: 'rule_new' })),
    updateRule: vi.fn(async () => fakeRule()),
    deleteRule: vi.fn(async () => {}),
  } as unknown as IngestRuleEditorStore

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as unknown as { userId: string }).userId = USER
    next()
  })
  app.use(
    '/api',
    whatsappIngestAdminRoutes({
      workspaceStore,
      integrationStore,
      ruleEditor,
      waConnectorUrl: opts.waConfigured === false ? undefined : 'http://wa-connector',
      waConnectorSecret: opts.waConfigured === false ? undefined : 'secret',
      scheduledBatching: true,
    }),
  )
  return { app, workspaceStore, integrationStore, ruleEditor }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The GET/enable handlers fetch the live group roster from the connector;
  // stub it so tests stay hermetic and fall back to the seenChats inventory.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
})

describe('[COMP:api/whatsapp-ingest-admin] GET status + inventory', () => {
  it('reports not-connected when no WhatsApp integration exists', async () => {
    const { app } = makeApp({ integration: null })
    const res = await request(app).get(`/api/workspaces/${WS}/whatsapp`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ connected: false, groups: [] })
  })

  it('lists seen groups with their enable state', async () => {
    const { app } = makeApp({ rules: [fakeRule()] }) // GROUP is enabled (scheduled)
    const res = await request(app).get(`/api/workspaces/${WS}/whatsapp`)
    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(true)
    expect(res.body.groups).toEqual([
      { chatJid: GROUP, title: 'Team Ops', enabled: true, routing: 'scheduled', ruleId: 'rule_1' },
    ])
  })

  it('shows a seen-but-unenabled group as disabled', async () => {
    const { app } = makeApp({ rules: [] })
    const res = await request(app).get(`/api/workspaces/${WS}/whatsapp`)
    expect(res.body.groups[0]).toMatchObject({ chatJid: GROUP, enabled: false, routing: null })
  })

  it('403s a non-member', async () => {
    const { app } = makeApp({ role: null })
    const res = await request(app).get(`/api/workspaces/${WS}/whatsapp`)
    expect(res.status).toBe(403)
  })
})

describe('[COMP:api/whatsapp-ingest-admin] enable group', () => {
  it('writes a group_match rule for an eligible group (scheduled digest)', async () => {
    const { app, ruleEditor } = makeApp({ rules: [] })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/groups/enable`)
      .send({ chatJid: GROUP, routing: 'scheduled' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ chatJid: GROUP, enabled: true, routing: 'scheduled' })
    expect(ruleEditor.addRule).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        connectorInstanceId: CI,
        filterType: 'group_match',
        filterParams: { values: [GROUP] },
        routingMode: 'scheduled',
        routingSchedule: '0 9 * * 1-5',
      }),
    )
  })

  it('coerces a realtime request to the weekday-digest rule (realtime soft-disabled)', async () => {
    // Realtime ingest is soft-disabled to cap token cost: even when the caller
    // asks for realtime, the enable always writes a scheduled (digest) rule.
    const { app, ruleEditor } = makeApp({ rules: [] })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/groups/enable`)
      .send({ chatJid: GROUP, routing: 'realtime' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ routing: 'scheduled' })
    expect(ruleEditor.addRule).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ routingMode: 'scheduled', routingSchedule: '0 9 * * 1-5' }),
    )
  })

  it('rejects a group not in seenChats (eligibility gate)', async () => {
    const { app, ruleEditor } = makeApp({ rules: [] })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/groups/enable`)
      .send({ chatJid: UNSEEN, routing: 'scheduled' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('group_not_eligible')
    expect(ruleEditor.addRule).not.toHaveBeenCalled()
  })

  it('updates an already-enabled group in place (and still coerces to digest)', async () => {
    const { app, ruleEditor } = makeApp({ rules: [fakeRule()] }) // already scheduled
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/groups/enable`)
      .send({ chatJid: GROUP, routing: 'realtime' })
    expect(res.status).toBe(200)
    expect(ruleEditor.updateRule).toHaveBeenCalledWith(USER, {
      ruleId: 'rule_1',
      patch: { routingMode: 'scheduled', routingSchedule: '0 9 * * 1-5' },
    })
    expect(ruleEditor.addRule).not.toHaveBeenCalled()
  })

  it('409s when WhatsApp is not connected', async () => {
    const { app } = makeApp({ integration: null, cis: [] })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/groups/enable`)
      .send({ chatJid: GROUP, routing: 'scheduled' })
    expect(res.status).toBe(409)
  })

  it('403s a non-admin member', async () => {
    const { app } = makeApp({ role: 'member' })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/groups/enable`)
      .send({ chatJid: GROUP, routing: 'scheduled' })
    expect(res.status).toBe(403)
  })

  it('400s on a bad routing value', async () => {
    const { app } = makeApp({})
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/groups/enable`)
      .send({ chatJid: GROUP, routing: 'hourly' })
    expect(res.status).toBe(400)
  })
})

describe('[COMP:api/whatsapp-ingest-admin] disable group', () => {
  it('deletes the matching group_match rule', async () => {
    const { app, ruleEditor } = makeApp({ rules: [fakeRule()] })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/groups/disable`)
      .send({ chatJid: GROUP })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ chatJid: GROUP, enabled: false })
    expect(ruleEditor.deleteRule).toHaveBeenCalledWith(USER, 'rule_1')
  })

  it('is a no-op (still 200) when no rule exists for the group', async () => {
    const { app, ruleEditor } = makeApp({ rules: [] })
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/groups/disable`)
      .send({ chatJid: GROUP })
    expect(res.status).toBe(200)
    expect(ruleEditor.deleteRule).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/whatsapp-ingest-admin] bot config', () => {
  it('GET reports chat-enabled + send scope + reply triggers', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ chatEnabled: true, sendScope: 'dm_and_groups' }] } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 'r_1', filterType: 'is_dm', filterParams: {} }],
      } as never)
    const { app } = makeApp({})
    const res = await request(app).get(`/api/workspaces/${WS}/whatsapp/bot`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      connected: true,
      chatEnabled: true,
      sendScope: 'dm_and_groups',
      triggers: [{ id: 'r_1', filterType: 'is_dm' }],
    })
  })

  it('enable adds the chat capability + send scope', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never)
    const { app } = makeApp({})
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/bot/enable`)
      .send({ sendScope: 'dm_and_groups' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ chatEnabled: true, sendScope: 'dm_and_groups' })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('array_append(enabled_capabilities'),
      [CHANNEL, 'dm_and_groups'],
    )
  })

  it('enable 400s on a bad send scope', async () => {
    const { app } = makeApp({})
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/bot/enable`)
      .send({ sendScope: 'everyone' })
    expect(res.status).toBe(400)
  })

  it('disable removes the chat capability', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never)
    const { app } = makeApp({})
    const res = await request(app).post(`/api/workspaces/${WS}/whatsapp/bot/disable`).send({})
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ chatEnabled: false })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("array_remove(enabled_capabilities, 'chat')"),
      [CHANNEL],
    )
  })

  it('adds a reply trigger with routing_mode reply', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'r_new' }] } as never)
    const { app } = makeApp({})
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/bot/triggers`)
      .send({ filterType: 'keyword_match', filterParams: { keywords: ['help'] } })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ id: 'r_new', filterType: 'keyword_match' })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("'reply'"),
      [CI, 'keyword_match', JSON.stringify({ keywords: ['help'] })],
    )
  })

  it('rejects an unknown trigger filter type', async () => {
    const { app } = makeApp({})
    const res = await request(app)
      .post(`/api/workspaces/${WS}/whatsapp/bot/triggers`)
      .send({ filterType: 'rm_-rf', filterParams: {} })
    expect(res.status).toBe(400)
  })

  it('deletes a reply trigger scoped to reply rules', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never)
    const { app } = makeApp({})
    const res = await request(app).delete(`/api/workspaces/${WS}/whatsapp/bot/triggers/r_1`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 'r_1', deleted: true })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("routing_mode = 'reply'"),
      ['r_1', CI],
    )
  })

  it('403s a non-admin member', async () => {
    const { app } = makeApp({ role: 'member' })
    const res = await request(app).post(`/api/workspaces/${WS}/whatsapp/bot/enable`).send({})
    expect(res.status).toBe(403)
  })
})

describe('[COMP:api/whatsapp-ingest-admin] connect guards', () => {
  it('503s when the wa-connector is not configured', async () => {
    const { app } = makeApp({ waConfigured: false })
    const res = await request(app).post(`/api/workspaces/${WS}/whatsapp/connect`)
    expect(res.status).toBe(503)
  })

  it('403s a non-admin', async () => {
    const { app } = makeApp({ role: 'member' })
    const res = await request(app).post(`/api/workspaces/${WS}/whatsapp/connect`)
    expect(res.status).toBe(403)
  })
})
