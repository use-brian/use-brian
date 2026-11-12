import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ContextScopeAccumulator, createExecutionContext, executionToolContext, type Tool,
} from '@use-brian/core'
import { injectMcpTools } from '../inject.js'
import { createMailboxIdleWatcher, type IdleClientLike } from '../../mailbox/idle-watcher.js'
import { createMailboxSyncWorker, readMailboxSyncState } from '../../mailbox/sync-worker.js'
import type { ConnectorSourceRuntime } from '../../application-platform/source-runtime.js'

const mocks = vi.hoisted(() => ({ read: vi.fn(), current: vi.fn() }))
vi.mock('../../connector-config.js', () => ({
  getConnectorConfig: () => ({ clientId: 'fictional-client', clientSecret: 'fictional-secret' }),
}))
vi.mock('../../google/client.js', async original => ({
  ...await original<typeof import('../../google/client.js')>(),
  refreshGoogleAccessToken: async () => 'fictional-access',
  listCalendarEvents: (...args: unknown[]) => mocks.read(...args),
}))
// Database admission is the external boundary. Keep the injector's exact
// execution/accumulator guard and current-source checks real.
vi.mock('../../application-platform/connector-runtime-authority.js', () => ({
  createConnectorRuntimeAuthority: async () => ({
    cacheKey: 'fixture', allows: () => true, assertCurrent: () => mocks.current(),
    execute: async (operation: () => Promise<unknown>) => { await mocks.current(); return operation() },
  }),
}))

async function setup(options: { config?: Record<string, unknown>; custom?: boolean; provider?: string; granted?: boolean } = {}) {
  const execution = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: 'user-example', authenticationKind: 'verified_channel' } },
    ownership: { kind: 'workspace', workspaceId: 'workspace-example' },
    access: { workspaceId: 'workspace-example', userId: 'user-example', assistantId: 'assistant-example', assistantKind: 'standard',
      clearance: 'internal', compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: ['assistant-example'] },
    writeDefaults: { compartments: [], projectIds: [] },
    authority: { assertCurrent: async () => {}, execute: operation => operation() },
    lifecycle: { sessionId: 'session-example', channelType: 'telegram', channelId: 'chat-example', abortSignal: new AbortController().signal },
  })
  const accumulator = new ContextScopeAccumulator()
  const rows = [
    { id: 'mailbox-example', provider: options.provider ?? 'imap', custom: options.custom ?? false, url: null, label: 'Mailbox' },
    { id: 'calendar-example', provider: 'gcal', custom: false, url: null, label: 'Calendar' },
    { id: 'protected-example', provider: 'custom', custom: true, url: 'https://connector.example/mcp', label: 'Protected source' },
  ].map(row => ({ ...row, scope: 'workspace', workspaceId: 'workspace-example', userId: null,
    connected: true, healthStatus: 'ok', sensitivity: 'internal', compartments: [], projectIds: [], config: row.id === 'mailbox-example' ? options.config ?? {} : {}, createdAt: new Date('2030-01-01') }))
  const mailbox = rows.find(row => row.id === 'mailbox-example')!
  const grants = options.granted ? [{ id: 'grant-example', connectorInstanceId: mailbox.id, targetType: 'workspace', targetId: 'workspace-example', grantedByUserId: 'user-example', compartments: [], projectIds: [], instance: { ...mailbox, scope: 'user', userId: 'user-example', workspaceId: null } }] : []
  if (grants.length) Object.assign(mailbox, grants[0].instance)
  const auth = { value: { type: 'bearer' as const, token: 'fictional-access' } }
  const store = {
    listByWorkspaceSystem: async () => rows.filter(row => row.id !== mailbox.id || !options.granted),
    listByProviderSystem: async () => [mailbox],
    getSystem: async (id: string) => rows.find(row => row.id === id),
    getAuthCredentialsSystem: async (id: string) => id === mailbox.id ? imapCredentials : auth.value,
    getCredentialsSystem: async () => ({ client_id: 'google_refresh', client_secret: 'fictional-refresh' }),
    setConfigSystem: async (id: string, patch: Record<string, unknown>) => {
      const row = rows.find(row => row.id === id)!
      row.config = { ...row.config, ...patch }
    },
    setMailboxSyncStateSystem: async (id: string, mailboxSync: unknown, expected: string | null) => {
      const row = rows.find(row => row.id === id)!
      if ((readMailboxSyncState(row.config).backfill?.requestedAt ?? null) !== expected) return false
      row.config = { ...row.config, mailboxSync }; return true
    },
    markHealth: async (id: string, healthStatus: string) => { rows.find(row => row.id === id)!.healthStatus = healthStatus },
  }
  const source: ConnectorSourceRuntime = {
    execution, accumulator,
    discover: vi.fn(async name => ({ name, url: 'https://connector.example/mcp', tools: [] })),
    call: vi.fn(), assertCurrent: async () => {}, authorize: vi.fn(),
  }
  const tools = new Map<string, Tool>()
  await injectMcpTools({
    userId: 'user-example', assistantId: 'assistant-example', assistantTeamId: 'workspace-example', tools,
    executionContext: execution, scopeAccumulator: accumulator, exposeLocalReadTools: true,
    contextScope: { access: execution.security.access, effectiveCompartments: [], effectiveProjectIds: [] },
    connectorStore: { list: async () => [], getConfig: async () => ({}) } as never,
    settingsStore: { getPolicy: async () => null } as never,
    connectorInstanceStore: store as never,
    connectorGrantStore: { listForTargetSystem: async () => grants } as never,
    connectorSourceRuntimeFactory: async () => source,
  })
  expect(source.discover).toHaveBeenCalled()
  expect(tools.has('googleCalendarListEvents')).toBe(true)
  return { execution, accumulator, tools, rows, mailbox, store, grants, auth, context: { ...executionToolContext(execution, { appId: 'test' }), scopeAccumulator: accumulator, requestTools: tools } }
}

beforeEach(() => {
  mocks.current.mockReset().mockResolvedValue(undefined)
  mocks.read.mockReset().mockResolvedValue({ items: [] })
})


const imapCredentials = { type: 'imap' as const, email: 'maya@example.org', appPassword: 'fictional', imapHost: 'imap.example.org', imapPort: 993, smtpHost: 'smtp.example.org', smtpPort: 465 }

describe('[COMP:api/mcp-inject] mailbox operational state and current authority', () => {
  it.each([false, true])('retains direct and gateway tools after the IDLE writer updates an owned/granted mailbox (granted=%s)', async granted => {
    const { context, tools, store, mailbox, rows } = await setup({ granted })
    const search = () => tools.get('mcp_search')!.execute({ query: 'calendar' }, context)
    expect((await search()).isError).not.toBe(true)
    const before = structuredClone(rows)
    const client: IdleClientLike = { usable: true, capabilities: { has: () => true }, connect: async () => {}, logout: async () => {}, close() {}, mailboxOpen: async () => ({}), on() {} }
    const writes = vi.spyOn(store, 'setConfigSystem')
    const watcher = createMailboxIdleWatcher({
      connectorInstanceStore: store as never,
      syncInstanceById: async () => ({ synced: true, newMessages: 0 }),
      createClient: () => client,
      now: () => new Date('2030-01-01T00:01:00.000Z'),
    })
    try {
      await watcher.watchInstance(mailbox.id)
      expect(writes).toHaveBeenCalledWith(mailbox.id, { mailboxIdle: { status: 'connected', since: '2030-01-01T00:01:00.000Z', lastEventAt: null, lastError: null } })
      expect(rows.map(({ config: _config, ...row }) => row)).toEqual(before.map(({ config: _config, ...row }) => row))
      expect((await search()).isError).not.toBe(true)
      expect((await tools.get('mcp_call')!.execute({ server: 'gcal', tool: 'googleCalendarListEvents', args: {} }, context)).isError).not.toBe(true)
      expect((await tools.get('googleCalendarListEvents')!.execute({}, context)).isError).not.toBe(true)
      expect(mocks.read).toHaveBeenCalledTimes(2)
    } finally { await watcher.stop() }
  })

  it('keeps discovery usable after the sync worker persists a normal failure and degraded health', async () => {
    const { context, tools, store, mailbox } = await setup()
    const persist = vi.spyOn(store, 'setMailboxSyncStateSystem')
    const worker = createMailboxSyncWorker({
      connectorInstanceStore: store as never,
      resolveDefaultWorkspaceId: async () => 'workspace-example',
      sessions: { withClient: async () => { throw new Error('Fictional transport interruption') }, closeAll: async () => {}, size: () => 0 },
      now: () => new Date('2030-01-01T00:02:00.000Z'),
    })
    expect(await worker.syncInstanceById(mailbox.id)).toMatchObject({ synced: false, reason: 'error' })
    expect(persist).toHaveBeenCalledWith(mailbox.id, { folders: {}, lastError: 'Fictional transport interruption', lastFailedSyncAt: '2030-01-01T00:02:00.000Z' }, null)
    expect(mailbox.healthStatus).toBe('degraded')
    expect((await tools.get('mcp_search')!.execute({ query: 'calendar' }, context)).isError).not.toBe(true)
    await store.markHealth(mailbox.id, 'ok')
    expect((await tools.get('mcp_search')!.execute({ query: 'calendar' }, context)).isError).not.toBe(true)
  })

  it.each([
    { sendAsAliases: ['other@example.org'] },
    { sendActorIdentity: true },
    { futureAuthority: { enabled: true } },
    { mailboxIdle: { status: 'connected', since: '2030-01-01', futureAuthority: true } },
    { mailboxSync: { folders: { INBOX: { uidvalidity: '1', lastUid: 2, futureAuthority: true } } } },
    { mailboxSync: { backfill: { scope: 'all', requestedAt: '2030-01-01', status: 'running', futureAuthority: true } } },
    { mailboxSync: { folders: { INBOX: { uidvalidity: '1', lastUid: 2, retryUids: { '1': { attempts: 1, lastError: 'retry', lastAttemptAt: '2030-01-01', futureAuthority: true } } } } } },
    { mailboxSync: { recentSkips: [{ folder: 'INBOX', uid: 1, reason: 'retry', at: '2030-01-01', futureAuthority: true }] } },
    { mailboxSync: { lastError: { unexpected: true } } },
  ])('continues to refuse authority, unknown, and malformed config changes: %j', async config => {
    const { context, tools, mailbox } = await setup()
    mailbox.config = config
    await expect(tools.get('mcp_search')!.execute({ query: 'calendar' }, context)).rejects.toMatchObject({ name: 'AuthorityChangedError', reason: 'authority_changed' })
  })

  it.each([{ custom: true }, { provider: 'custom' }, { provider: 'gcal' }])('does not classify other connector configuration as mailbox telemetry: %j', async options => {
    const { context, tools, mailbox } = await setup(options)
    mailbox.config = { mailboxIdle: { status: 'connected', since: '2030-01-01', lastEventAt: null } }
    await expect(tools.get('mcp_search')!.execute({ query: 'calendar' }, context)).rejects.toMatchObject({ reason: 'authority_changed' })
  })

  it.each([
    { mailboxIdle: null, mailboxSync: null },
    { mailboxIdle: { status: 'unsupported', since: '', lastEventAt: null, lastError: null } },
    { mailboxIdle: { status: 'reconnecting', since: '2030-01-01', lastEventAt: '2030-01-01', lastError: 'Fictional interruption' } },
    { mailboxIdle: { status: 'off', since: '2030-01-01' } },
    { mailboxSync: { folders: { INBOX: { uidvalidity: '1', lastUid: 20, serverMessages: 25, backfillLow: 3, backfillDone: false, consecutiveListMisses: 1, retryUids: { '7': { attempts: 2, lastError: 'Fictional transport interruption', lastAttemptAt: '2030-01-01' } } } }, folderDiscoveryMisses: { Archive: 1 }, backfill: { scope: 'all', requestedAt: '2030-01-01', reconcileVersion: 1, status: 'stalled', totalEstimate: 25, estimateComplete: true, consecutiveFailures: 1, lastError: null, lastProgressAt: '2030-01-01' }, lastSyncAt: '2030-01-01', lastError: null, lastFailedSyncAt: null, skippedCount: 1, recentSkips: [{ folder: 'INBOX', uid: 1, reason: 'Fictional interrupted read', at: '2030-01-01' }] } },
  ])('accepts documented operational DTO variants without modifying stored configuration: %j', async config => {
    const { context, tools, mailbox } = await setup()
    mailbox.config = structuredClone(config)
    const original = structuredClone(mailbox.config)
    expect((await tools.get('mcp_search')!.execute({ query: 'calendar' }, context)).isError).not.toBe(true)
    expect(mailbox.config).toEqual(original)
  })

  it.each(['compartments', 'projectIds', 'sensitivity', 'healthStatus', 'connected'] as const)('still rejects a real %s change', async field => {
    const { context, tools, mailbox } = await setup()
    Object.assign(mailbox, { [field]: ({ compartments: ['team:other'], projectIds: ['project-other'], sensitivity: 'confidential', healthStatus: 'auth_failed', connected: false })[field] })
    await expect(tools.get('mcp_search')!.execute({ query: 'calendar' }, context)).rejects.toMatchObject({ reason: 'authority_changed' })
  })

  it('still rejects revoked exposure and changed remote authentication', async () => {
    const granted = await setup({ granted: true })
    granted.grants.length = 0
    await expect(granted.tools.get('mcp_search')!.execute({ query: 'calendar' }, granted.context)).rejects.toMatchObject({ reason: 'authority_changed' })
    const remote = await setup()
    remote.auth.value = { type: 'bearer', token: 'fictional-replacement' }
    await expect(remote.tools.get('mcp_search')!.execute({ query: 'calendar' }, remote.context)).rejects.toMatchObject({ reason: 'authority_changed' })
  })
})
