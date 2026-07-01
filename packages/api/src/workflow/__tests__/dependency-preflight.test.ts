import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWorkflowDependencyPreflight } from '../dependency-preflight.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'
import type { ConnectorStore } from '../../db/connector-store.js'

const ASSISTANT_ID = 'a1'
const USER_ID = 'u1'

function integrationStoreWith(
  creds: Record<string, { credentials: Record<string, unknown>; botUserId?: string | null } | null>,
): ChannelIntegrationStore {
  return {
    getCredentialsForAssistantSystem: async (_assistantId: string, channelType: string) =>
      creds[channelType] ?? null,
  } as unknown as ChannelIntegrationStore
}

function connectorStoreWith(creds: Record<string, { client_secret?: string } | null>): ConnectorStore {
  return {
    getCredentials: async (_userId: string, connectorId: string) => creds[connectorId] ?? null,
  } as unknown as ConnectorStore
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('[COMP:workflow/dependency-preflight] validateDeliveryTarget', () => {
  it('rejects Slack when the assistant has no Slack integration', async () => {
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({}),
    })
    const r = await validateDeliveryTarget({ assistantId: ASSISTANT_ID, channelType: 'slack', channelId: 'C123' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not connected/i)
  })

  it('rejects a Slack channel that resolves to channel_not_found (the incident)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 })),
    )
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({ slack: { credentials: { bot_token: 'xoxb-1' }, botUserId: 'U1' } }),
    })
    const r = await validateDeliveryTarget({ assistantId: ASSISTANT_ID, channelType: 'slack', channelId: 'web-session-id' })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/channel_not_found/)
  })

  it('accepts a Slack channel the bot can see', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, channel: { id: 'C123', name: 'dev' } }), { status: 200 })),
    )
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({ slack: { credentials: { bot_token: 'xoxb-1' } } }),
    })
    const r = await validateDeliveryTarget({ assistantId: ASSISTANT_ID, channelType: 'slack', channelId: 'C123' })
    expect(r.ok).toBe(true)
  })

  it('does not block Slack on a transient (non-reachability) error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), { status: 200 })),
    )
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({ slack: { credentials: { bot_token: 'xoxb-1' } } }),
    })
    const r = await validateDeliveryTarget({ assistantId: ASSISTANT_ID, channelType: 'slack', channelId: 'C123' })
    expect(r.ok).toBe(true)
  })

  it('accepts Telegram with the shared default bot token; rejects when neither BYO nor default exists', async () => {
    const withDefault = createWorkflowDependencyPreflight({ defaultTelegramBotToken: 'bot-token' })
    expect((await withDefault.validateDeliveryTarget({ assistantId: ASSISTANT_ID, channelType: 'telegram', channelId: '42' })).ok).toBe(true)

    const without = createWorkflowDependencyPreflight({ integrationStore: integrationStoreWith({}) })
    const r = await without.validateDeliveryTarget({ assistantId: ASSISTANT_ID, channelType: 'telegram', channelId: '42' })
    expect(r.ok).toBe(false)
  })

  it('accepts WhatsApp only when the connector is configured', async () => {
    const on = createWorkflowDependencyPreflight({ waConnectorUrl: 'http://wa', waConnectorSecret: 's' })
    expect((await on.validateDeliveryTarget({ assistantId: ASSISTANT_ID, channelType: 'whatsapp', channelId: 'x@s' })).ok).toBe(true)
    const off = createWorkflowDependencyPreflight({})
    expect((await off.validateDeliveryTarget({ assistantId: ASSISTANT_ID, channelType: 'whatsapp', channelId: 'x@s' })).ok).toBe(false)
  })
})

describe('[COMP:workflow/dependency-preflight] preflightConnectorTool', () => {
  it('returns null for a tool that is not a built-in connector tool', async () => {
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({ connectorStore: connectorStoreWith({}) })
    expect(await preflightConnectorTool({ userId: USER_ID, toolName: 'searchBrain' })).toBeNull()
    expect(await preflightConnectorTool({ userId: USER_ID, toolName: 'fileRead' })).toBeNull() // files: not probeable
  })

  it('maps a connector tool to its provider and rejects when the connector is not connected', async () => {
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({ connectorStore: connectorStoreWith({}) })
    const r = await preflightConnectorTool({ userId: USER_ID, toolName: 'githubListPullRequests' })
    expect(r).toEqual({ ok: false, provider: 'GitHub', reason: expect.stringMatching(/not connected/i) })
  })

  it('rejects GitHub when the stored PAT is revoked (401 / Bad credentials)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad credentials', { status: 401 })))
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({ github: { client_secret: 'ghp_revoked' } }),
    })
    const r = await preflightConnectorTool({ userId: USER_ID, toolName: 'githubGetRepository' })
    expect(r?.ok).toBe(false)
    expect(r?.reason).toMatch(/invalid or revoked/i)
  })

  it('accepts GitHub when the PAT is valid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ login: 'octocat' }), { status: 200 })))
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({ github: { client_secret: 'ghp_good' } }),
    })
    expect((await preflightConnectorTool({ userId: USER_ID, toolName: 'githubGetRepository' }))?.ok).toBe(true)
  })

  it('recognizes a non-GitHub connector and accepts it on credential presence (no probe yet)', async () => {
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({ notion: { client_secret: 'tok' } }),
    })
    const r = await preflightConnectorTool({ userId: USER_ID, toolName: 'notionSearch' })
    expect(r).toEqual({ ok: true, provider: 'Notion' })
  })
})

describe('[COMP:workflow/dependency-preflight] listSlackChannels', () => {
  it('rejects when the assistant has no Slack integration', async () => {
    const { listSlackChannels } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({}),
    })
    const r = await listSlackChannels({ assistantId: ASSISTANT_ID })
    expect(r.ok).toBe(false)
  })

  it('returns member channels first, then by name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            channels: [
              { id: 'C_ZED', name: 'zed', is_member: false },
              { id: 'C_DEV', name: 'deltadefi-dev', is_member: true },
              { id: 'C_ARCH', name: 'archived', is_member: true, is_archived: true },
            ],
            response_metadata: { next_cursor: '' },
          }),
          { status: 200 },
        ),
      ),
    )
    const { listSlackChannels } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({ slack: { credentials: { bot_token: 'xoxb-1' } } }),
    })
    const r = await listSlackChannels({ assistantId: ASSISTANT_ID })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Archived dropped; member channel first.
    expect(r.channels).toEqual([
      { id: 'C_DEV', name: 'deltadefi-dev', isMember: true },
      { id: 'C_ZED', name: 'zed', isMember: false },
    ])
  })

  it('surfaces a missing_scope error instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'missing_scope' }), { status: 200 })),
    )
    const { listSlackChannels } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({ slack: { credentials: { bot_token: 'xoxb-1' } } }),
    })
    const r = await listSlackChannels({ assistantId: ASSISTANT_ID })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/missing_scope/)
  })
})
