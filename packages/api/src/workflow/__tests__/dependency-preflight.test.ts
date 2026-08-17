import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWorkflowDependencyPreflight } from '../dependency-preflight.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'
import type { AssistantIntegrationRoutingDiagnostic } from '../../db/channel-integrations.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../../db/connector-grant-store.js'

const ASSISTANT_ID = 'a1'
const USER_ID = 'u1'
const WORKSPACE_ID = 'w1'

function integrationStoreWith(
  creds: Record<string, { credentials: Record<string, unknown>; botUserId?: string | null } | null>,
): ChannelIntegrationStore {
  return {
    getCredentialsForAssistantSystem: async (_assistantId: string, channelType: string) =>
      creds[channelType] ?? null,
    getCredentialsForAssistantIntegrationSystem: async (
      _workspaceId: string,
      _assistantId: string,
      _integrationId: string,
      channelType: string,
      _channelId: string,
    ) => creds[channelType] ?? null,
    diagnoseAssistantIntegrationRoutingSystem: async () => ({
      status: 'integration_unavailable',
      channelLabel: null,
    }),
  } as unknown as ChannelIntegrationStore
}

function integrationStoreWithDiagnostic(
  diagnostic: AssistantIntegrationRoutingDiagnostic,
): ChannelIntegrationStore {
  return {
    getCredentialsForAssistantSystem: vi.fn(async () => null),
    getCredentialsForAssistantIntegrationSystem: vi.fn(async () => null),
    diagnoseAssistantIntegrationRoutingSystem: vi.fn(async () => diagnostic),
  } as unknown as ChannelIntegrationStore
}

function connectorStoreWith(creds: Record<string, { client_secret?: string } | null>): ConnectorStore {
  return {
    getCredentials: async (_userId: string, connectorId: string) => creds[connectorId] ?? null,
  } as unknown as ConnectorStore
}

/**
 * Team-native + team-grant credential sources — the runtime overlays the
 * preflight must now mirror. `instances` are `scope='workspace'` rows keyed by
 * instance id; `credsById` are what `getCredentialsSystem(id)` returns. Both
 * team stores share the same instance-credential reader (grants read the
 * granted instance's credentials through the instance store), matching
 * `mcp/inject.ts`.
 */
function connectorInstanceStoreWith(
  instances: Array<{ id: string; provider: string; connected: boolean }>,
  credsById: Record<string, { client_secret?: string } | null>,
): ConnectorInstanceStore {
  return {
    listByWorkspaceSystem: async (_workspaceId: string) => instances,
    getCredentialsSystem: async (id: string) => credsById[id] ?? null,
  } as unknown as ConnectorInstanceStore
}

function connectorGrantStoreWith(
  grants: Array<{ instance: { id: string; provider: string; connected: boolean }; grantedByUserId: string }>,
): ConnectorGrantStore {
  return {
    listForTargetSystem: async (_targetType: string, _targetId: string) => grants,
  } as unknown as ConnectorGrantStore
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

  it('accepts Telegram when the shared default bot can see the chat; rejects when no bot exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { id: 42, type: 'private' } }), { status: 200 })),
    )
    const withDefault = createWorkflowDependencyPreflight({ defaultTelegramBotToken: 'bot-token' })
    expect((await withDefault.validateDeliveryTarget({ assistantId: ASSISTANT_ID, channelType: 'telegram', channelId: '42' })).ok).toBe(true)

    const without = createWorkflowDependencyPreflight({ integrationStore: integrationStoreWith({}) })
    const r = await without.validateDeliveryTarget({ assistantId: ASSISTANT_ID, channelType: 'telegram', channelId: '42' })
    expect(r.ok).toBe(false)
  })

  it('checks a Telegram topic against its base chat and falls back from BYO to the shared bot', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body)) as { chat_id: string }
      expect(body.chat_id).toBe('-100555')
      return url.includes('botbyo-token/')
        ? new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), { status: 400 })
        : new Response(JSON.stringify({ ok: true, result: { id: -100555, type: 'supergroup' } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({ telegram: { credentials: { bot_token: 'byo-token' } } }),
      defaultTelegramBotToken: 'shared-token',
    })

    const result = await validateDeliveryTarget({
      workspaceId: WORKSPACE_ID,
      assistantId: ASSISTANT_ID,
      channelType: 'telegram',
      channelId: '-100555:topic:42',
    })

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects a Telegram target that no configured bot can see', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(
        JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
        { status: 400 },
      )),
    )
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({ telegram: { credentials: { bot_token: 'byo-token' } } }),
      defaultTelegramBotToken: 'shared-token',
    })

    const result = await validateDeliveryTarget({
      workspaceId: WORKSPACE_ID,
      assistantId: ASSISTANT_ID,
      channelType: 'telegram',
      channelId: '-100555:topic:42',
    })

    expect(result).toEqual({ ok: false, reason: 'Telegram: chat not found (-100555)' })
  })

  it('probes only the explicitly selected Telegram integration', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('botselected-token/getChat')
      return new Response(JSON.stringify({ ok: true, result: { id: -100555, type: 'supergroup' } }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({ telegram: { credentials: { bot_token: 'selected-token' } } }),
      defaultTelegramBotToken: 'shared-token',
    })

    const result = await validateDeliveryTarget({
      workspaceId: WORKSPACE_ID,
      assistantId: ASSISTANT_ID,
      channelType: 'telegram',
      channelId: '-100555:topic:42',
      channelIntegrationId: '00000000-0000-4000-8000-000000000001',
    })

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('explains when the destination is routed to a different assistant', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const store = integrationStoreWithDiagnostic({
      status: 'assistant_mismatch',
      channelLabel: '@operations_bot',
      requestedAssistantName: 'Research Assistant',
      routedAssistantName: 'Operations Assistant',
    })
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: store,
      defaultTelegramBotToken: 'shared-token',
    })

    const result = await validateDeliveryTarget({
      workspaceId: WORKSPACE_ID,
      assistantId: ASSISTANT_ID,
      channelType: 'telegram',
      channelId: '-100555:topic:42',
      channelIntegrationId: '00000000-0000-4000-8000-000000000001',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('routes this destination to assistant "Operations Assistant"')
    expect(result.reason).toContain('workflow step uses assistant "Research Assistant"')
    expect(result.reason).toContain('Studio > Channels')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('explains when the selected channel has no route for the destination', async () => {
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWithDiagnostic({
        status: 'destination_unassigned',
        channelLabel: '@project_bot',
        requestedAssistantName: 'Research Assistant',
      }),
    })

    const result = await validateDeliveryTarget({
      workspaceId: WORKSPACE_ID,
      assistantId: ASSISTANT_ID,
      channelType: 'telegram',
      channelId: '-100555:topic:42',
      channelIntegrationId: '00000000-0000-4000-8000-000000000001',
    })

    expect(result.reason).toContain('has no assistant assigned')
    expect(result.reason).toContain('set "Research Assistant" as the channel default')
  })

  it('explains when the selected Telegram integration is inactive', async () => {
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWithDiagnostic({
        status: 'integration_unavailable',
        channelLabel: '@retired_bot',
      }),
    })

    const result = await validateDeliveryTarget({
      workspaceId: WORKSPACE_ID,
      assistantId: ASSISTANT_ID,
      channelType: 'telegram',
      channelId: '-100555',
      channelIntegrationId: '00000000-0000-4000-8000-000000000001',
    })

    expect(result.reason).toContain('"@retired_bot" is disconnected, inactive, or no longer available')
    expect(result.reason).toContain('Reconnect it in Studio > Channels')
  })

  it('does not suggest routing a missing or foreign assistant', async () => {
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWithDiagnostic({
        status: 'assistant_unavailable',
        channelLabel: '@project_bot',
      }),
    })

    const result = await validateDeliveryTarget({
      workspaceId: WORKSPACE_ID,
      assistantId: ASSISTANT_ID,
      channelType: 'telegram',
      channelId: '-100555',
      channelIntegrationId: '00000000-0000-4000-8000-000000000001',
    })

    expect(result.reason).toContain('workflow step assistant is not available in this workspace')
    expect(result.reason).not.toContain(ASSISTANT_ID)
  })

  it('does not block Telegram authoring on a transient getChat failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network unavailable') }))
    const { validateDeliveryTarget } = createWorkflowDependencyPreflight({
      defaultTelegramBotToken: 'shared-token',
    })

    const result = await validateDeliveryTarget({
      assistantId: ASSISTANT_ID,
      channelType: 'telegram',
      channelId: '-100555:topic:42',
    })

    expect(result.ok).toBe(true)
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
    expect(r).toEqual({
      ok: false,
      provider: 'GitHub',
      reason: expect.stringMatching(/not connected/i),
      policy: 'allow',
    })
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
    expect(r).toEqual({ ok: true, provider: 'Notion', policy: 'allow' })
  })

  // Policy resolution (2026-07-07 send-step incident): an `ask`-policy tool
  // pinned on an `assistant_call` step can never execute — authoring reads
  // this `policy` answer and errors, steering to a `tool_call` step (which
  // pauses in the unified Approvals queue).
  it('reports the registry defaultPolicy without a settings store (gmailSendMessage = ask)', async () => {
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({ gmail: { client_secret: 'tok' } }),
    })
    const r = await preflightConnectorTool({ userId: USER_ID, toolName: 'gmailSendMessage' })
    expect(r).toEqual({ ok: true, provider: 'Gmail', policy: 'ask' })
  })

  it('tightens the default with L1/L2 rows (strictest wins) and threads assistantId to L2', async () => {
    const calls: Array<{ assistantId: string; toolName: string; serverName: string }> = []
    const settingsStore = {
      getPolicy: async (p: { assistantId: string; userId: string; serverName: string; toolName: string }) => {
        calls.push({ assistantId: p.assistantId, toolName: p.toolName, serverName: p.serverName })
        // L2 row for our assistant blocks the (default-allow) read tool.
        return p.assistantId === ASSISTANT_ID ? { policy: 'block' } : null
      },
    }
    // Notion, not Gmail: `gmailListMessages` used to stand in for the
    // default-allow read tool here, but it was a phantom registry row for a
    // connector scoped `gmail.send` only and is now commented out
    // (integrations/gmail.md → "Why the two read rows are commented out").
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({ notion: { client_secret: 'tok' } }),
      mcpSettingsStore: settingsStore,
    })
    const r = await preflightConnectorTool({
      userId: USER_ID,
      toolName: 'notionSearch',
      assistantId: ASSISTANT_ID,
    })
    expect(r?.policy).toBe('block')
    // L1 (app-level) + L2 (per-assistant) both consulted, against the provider server name.
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual({ assistantId: ASSISTANT_ID, toolName: 'notionSearch', serverName: 'notion' })
  })

  it('mirrors the runtime rule: L1 allow alone does not loosen an ask default; L1+L2 allow does', async () => {
    // L1-only allow: the L2 arm falls back to the ask default → strictest = ask.
    const l1Only = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({ gmail: { client_secret: 'tok' } }),
      mcpSettingsStore: {
        getPolicy: async (p: { assistantId: string }) =>
          p.assistantId === ASSISTANT_ID ? null : { policy: 'allow' },
      },
    })
    const partial = await l1Only.preflightConnectorTool({
      userId: USER_ID,
      toolName: 'gmailSendMessage',
      assistantId: ASSISTANT_ID,
    })
    expect(partial?.policy).toBe('ask')

    // Explicit allow on BOTH levels loosens — exactly what dispatch would do
    // (`resolveEffectivePolicy`), so authoring must accept it too.
    const both = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({ gmail: { client_secret: 'tok' } }),
      mcpSettingsStore: { getPolicy: async () => ({ policy: 'allow' }) },
    })
    const loosened = await both.preflightConnectorTool({
      userId: USER_ID,
      toolName: 'gmailSendMessage',
      assistantId: ASSISTANT_ID,
    })
    expect(loosened?.policy).toBe('allow')
  })

  // Team credential resolution (prod 2026-07-13): the preflight must resolve
  // credentials with the SAME precedence the runtime uses (team-native
  // instance → member grant → per-user), or it rejects a workflow the executor
  // would run. The per-user store below is EMPTY in these cases — the only
  // credential lives in a team-owned / team-granted instance.
  it('accepts GitHub when the credential is a team-native (scope=workspace) instance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ login: 'octocat' }), { status: 200 })))
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({}), // no per-user GitHub
      connectorInstanceStore: connectorInstanceStoreWith(
        [{ id: 'inst-team', provider: 'github', connected: true }],
        { 'inst-team': { client_secret: 'ghp_team' } },
      ),
    })
    const r = await preflightConnectorTool({
      userId: USER_ID,
      toolName: 'githubListPullRequests',
      workspaceId: WORKSPACE_ID,
    })
    expect(r).toEqual({ ok: true, provider: 'GitHub', policy: 'allow' })
  })

  it('probes the team-native token — a revoked team PAT is blocked (not silently accepted)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad credentials', { status: 401 })))
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({}),
      connectorInstanceStore: connectorInstanceStoreWith(
        [{ id: 'inst-team', provider: 'github', connected: true }],
        { 'inst-team': { client_secret: 'ghp_team_revoked' } },
      ),
    })
    const r = await preflightConnectorTool({
      userId: USER_ID,
      toolName: 'githubGetRepository',
      workspaceId: WORKSPACE_ID,
    })
    expect(r?.ok).toBe(false)
    expect(r?.reason).toMatch(/invalid or revoked/i)
  })

  it('accepts GitHub when the credential is a member-exposure grant (team-grant)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ login: 'octocat' }), { status: 200 })))
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({}), // no per-user GitHub
      // No team-native instance for github; only a grant of a user instance.
      connectorInstanceStore: connectorInstanceStoreWith([], { 'inst-granted': { client_secret: 'ghp_granted' } }),
      connectorGrantStore: connectorGrantStoreWith([
        { instance: { id: 'inst-granted', provider: 'github', connected: true }, grantedByUserId: 'u2' },
      ]),
    })
    const r = await preflightConnectorTool({
      userId: USER_ID,
      toolName: 'githubListPullRequests',
      workspaceId: WORKSPACE_ID,
    })
    expect(r).toEqual({ ok: true, provider: 'GitHub', policy: 'allow' })
  })

  it('accepts a non-GitHub connector on presence of a team-grant credential', async () => {
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({}),
      connectorInstanceStore: connectorInstanceStoreWith([], { 'inst-notion': { client_secret: 'tok' } }),
      connectorGrantStore: connectorGrantStoreWith([
        { instance: { id: 'inst-notion', provider: 'notion', connected: true }, grantedByUserId: 'u2' },
      ]),
    })
    const r = await preflightConnectorTool({
      userId: USER_ID,
      toolName: 'notionSearch',
      workspaceId: WORKSPACE_ID,
    })
    expect(r).toEqual({ ok: true, provider: 'Notion', policy: 'allow' })
  })

  it('team-native precedence: a disconnected team instance falls through to the per-user credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ login: 'octocat' }), { status: 200 })))
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({ github: { client_secret: 'ghp_personal' } }),
      // Team instance exists but is NOT connected → skipped; per-user wins.
      connectorInstanceStore: connectorInstanceStoreWith(
        [{ id: 'inst-team', provider: 'github', connected: false }],
        { 'inst-team': { client_secret: 'ghp_team' } },
      ),
    })
    const r = await preflightConnectorTool({
      userId: USER_ID,
      toolName: 'githubGetRepository',
      workspaceId: WORKSPACE_ID,
    })
    expect(r?.ok).toBe(true)
  })

  it('reports not-connected only when NO source (team-native, team-grant, per-user) has a credential', async () => {
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({}),
      connectorInstanceStore: connectorInstanceStoreWith([], {}),
      connectorGrantStore: connectorGrantStoreWith([]),
    })
    const r = await preflightConnectorTool({
      userId: USER_ID,
      toolName: 'githubListPullRequests',
      workspaceId: WORKSPACE_ID,
    })
    expect(r).toEqual({
      ok: false,
      provider: 'GitHub',
      reason: expect.stringMatching(/not connected/i),
      policy: 'allow',
    })
  })

  it('a team store that throws is fail-open — falls through to the per-user credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ login: 'octocat' }), { status: 200 })))
    const throwingInstanceStore = {
      listByWorkspaceSystem: async () => {
        throw new Error('db down')
      },
      getCredentialsSystem: async () => null,
    } as unknown as ConnectorInstanceStore
    const { preflightConnectorTool } = createWorkflowDependencyPreflight({
      connectorStore: connectorStoreWith({ github: { client_secret: 'ghp_personal' } }),
      connectorInstanceStore: throwingInstanceStore,
    })
    const r = await preflightConnectorTool({
      userId: USER_ID,
      toolName: 'githubGetRepository',
      workspaceId: WORKSPACE_ID,
    })
    expect(r?.ok).toBe(true)
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

  it('looks up a supplied private channel id directly instead of trusting list absence', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          ok: true,
          channel: { id: 'C0PRIVATE1', name: 'engineering-private', is_private: true, is_member: true },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { listSlackChannels } = createWorkflowDependencyPreflight({
      integrationStore: integrationStoreWith({ slack: { credentials: { bot_token: 'xoxb-1' } } }),
    })

    const r = await listSlackChannels({ assistantId: ASSISTANT_ID, channelId: 'C0PRIVATE1' })

    expect(r).toEqual({
      ok: true,
      channels: [{ id: 'C0PRIVATE1', name: 'engineering-private', isMember: true }],
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/conversations.info')
    // `conversations.info` is form-encoded (a JSON body is ignored by Slack).
    expect(new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body)).get('channel')).toBe('C0PRIVATE1')
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
