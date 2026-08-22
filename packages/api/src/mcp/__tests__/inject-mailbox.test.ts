/**
 * Injection-level tests for the company-mailbox (imap) connector:
 * Layer-1/Layer-2 gating, the unavailable[] notice, and the send governance
 * chain — `ask` classification in the registry, connector_actions
 * `send_email` audit, and advisory classifier preflight after app policy
 * admits the exact email payload (plan §10 "Governance" row).
 *
 * [COMP:tools/mailbox-imap]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Keep the Gmail OAuth connector available to the deployment but disconnected
// in this fixture. That reproduces the home-linux prompt composition: Gmail's
// unavailable notice sits beside a live IMAP/SMTP tool set.
vi.mock('../../connector-config.js', () => ({
  getConnectorConfig: (provider: string) => provider === 'google'
    ? { clientId: 'gmail-client', clientSecret: 'gmail-secret' }
    : undefined,
}))

const mailboxSendMessage = vi.fn(async (_params: unknown) => ({ messageId: '<sent@harborlane.example>' }))
const createMailboxApiMock = vi.fn((opts: {
  getSettings: () => Promise<typeof IMAP_CREDS>
}) => ({
  searchMessages: vi.fn(),
  getMessage: vi.fn(),
  getAttachment: vi.fn(async () => {
    await opts.getSettings()
    return {
      filename: 'proposal.pdf',
      mime: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    }
  }),
  resolveSender: vi.fn(async (p: { from?: string }) => {
    const settings = await opts.getSettings()
    return { from: p.from ?? settings.email, allowed: [settings.email] }
  }),
  sendMessage: vi.fn(async (p: { from?: string }) => {
    const settings = await opts.getSettings()
    await mailboxSendMessage(p)
    return { messageId: '<sent@harborlane.example>', from: p.from ?? settings.email }
  }),
}))
vi.mock('../../mailbox/mailbox-api.js', () => ({
  createMailboxApi: (opts: never) => createMailboxApiMock(opts),
}))

import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import { injectMcpTools } from '../inject.js'
import type { ConnectorActionAudit, ConnectorActionPreflight } from '../../connector-action-port.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { Tool } from '@use-brian/core'

const IMAP_CREDS = {
  type: 'imap' as const,
  email: 'maya@harborlane.example',
  appPassword: 'pw',
  imapHost: 'imap.qiye.aliyun.com',
  imapPort: 993,
  smtpHost: 'smtp.qiye.aliyun.com',
  smtpPort: 465,
}

function imapConnectorRow() {
  return {
    id: 'inst-imap-1',
    userId: 'u-1',
    connectorId: 'imap',
    name: 'maya@harborlane.example',
    url: null,
    custom: false,
    connected: true,
    credentialsType: 'imap',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  }
}

function settingsStoreStub() {
  return new Proxy({}, { get: () => vi.fn().mockResolvedValue(undefined) })
}

function instanceStoreStub(): ConnectorInstanceStore {
  return {
    getAuthCredentialsSystem: vi.fn(async () => IMAP_CREDS),
    getCredentialsSystem: vi.fn(async () => null),
    markHealth: vi.fn(async () => false),
  } as unknown as ConnectorInstanceStore
}

function preflightResult(over: Partial<ConnectorActionPreflight> = {}): ConnectorActionPreflight {
  return {
    responseCeiling: 'public',
    retrievalMax: 'public',
    classifierDetected: 'public',
    classifierMatches: [],
    shouldDeny: false,
    shadowOnly: false,
    ...over,
  }
}

/** Workspace-file primitive — present = `imapSaveAttachment` is built (D17). */
function filesApiStub() {
  const file = {
    id: 'file-1',
    workspaceId: 'ws-1',
    path: '/uploads/proposal.pdf',
    name: 'proposal.pdf',
    sizeBytes: 3,
    mime: 'application/pdf',
    sensitivity: 'internal',
  }
  return {
    writeBytes: vi.fn(async () => ({
      ok: true as const,
      value: { id: 'file-1', path: '/uploads/email/x.pdf', sizeBytes: 3, mime: 'application/pdf' },
    })),
    stat: vi.fn(async () => ({ ok: true as const, value: file })),
    readBytes: vi.fn(async () => ({
      ok: true as const,
      value: { file, bytes: new Uint8Array([1, 2, 3]) },
    })),
  } as never
}

async function injectImap(
  over: {
    audit?: ConnectorActionAudit
    instanceStore?: ConnectorInstanceStore
    withFiles?: boolean
    settingsStore?: Record<string, unknown>
    assistantConnectorStore?: Record<string, unknown>
    assistantConnectorGrantsStore?: Record<string, unknown>
  } = {},
) {
  const tools = new Map<string, Tool>()
  const result = await injectMcpTools({
    userId: 'u-1',
    assistantId: 'a-1',
    tools,
    connectorStore: { list: vi.fn().mockResolvedValue([imapConnectorRow()]) } as never,
    settingsStore: (over.settingsStore ?? settingsStoreStub()) as never,
    ...(over.assistantConnectorStore ? { assistantConnectorStore: over.assistantConnectorStore as never } : {}),
    ...(over.assistantConnectorGrantsStore ? { assistantConnectorGrantsStore: over.assistantConnectorGrantsStore as never } : {}),
    connectorInstanceStore: over.instanceStore ?? instanceStoreStub(),
    keepBuiltinsDirect: true,
    ...(over.withFiles ? { filesApi: filesApiStub() } : {}),
    ...(over.audit ? { connectorActionAudit: over.audit } : {}),
  })
  return { tools, result }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  mailboxSendMessage.mockClear()
  createMailboxApiMock.mockClear()
})

describe('[COMP:tools/mailbox-imap] imap injection', () => {
  it('registry classifies imapSendMessage write/ask (the write-grant gate + approval chain key off this)', () => {
    const rows = OFFICIAL_CONNECTOR_TOOLS.imap
    expect(rows).toBeDefined()
    const send = rows.find((t) => t.name === 'imapSendMessage')
    expect(send).toMatchObject({ classification: 'write', defaultPolicy: 'ask' })
    expect(send?.description).toMatch(/^Send email.*connected email account/i)
    expect(send?.description).not.toMatch(/company mailbox/i)
    const search = rows.find((t) => t.name === 'imapSearchMessages')
    expect(search).toMatchObject({ classification: 'read', defaultPolicy: 'allow' })
    expect(search?.description).toMatch(/^Summarize, check, or search email/i)
    expect(search?.description).not.toMatch(/company mailbox/i)
    expect(rows.find((t) => t.name === 'imapGetMessage')).toMatchObject({ classification: 'read', defaultPolicy: 'allow' })
  })

  it('injects the three mailbox tools when a connected imap instance exists', async () => {
    const { tools, result } = await injectImap()
    expect(tools.has('imapSearchMessages')).toBe(true)
    expect(tools.has('imapGetMessage')).toBe(true)
    expect(tools.has('imapSendMessage')).toBe(true)
    expect(tools.get('imapSendMessage')?.requiresConfirmation).toBe(true)
    expect(tools.get('imapSearchMessages')?.description).toMatch(/summarize email, check recent email/i)
    expect(tools.get('imapSendMessage')?.description).toMatch(/ordinary email sending/i)

    // Gmail OAuth is absent in this fixture, but email is available through
    // the injected IMAP/SMTP mailbox. The connector entry stays a compact fact;
    // the shared prompt wrapper carries the use-another-available-tool policy.
    const gmailNotice = result.unavailable.find((line) => line.startsWith('Gmail: not connected'))
    expect(gmailNotice).toBeDefined()
    expect(gmailNotice).toBe('Gmail: not connected for this assistant (sending and reading email)')
    expect(gmailNotice).not.toMatch(/unavailable this turn/i)
  })

  it('announces the capability as unavailable when no mailbox is connected', async () => {
    const tools = new Map<string, Tool>()
    const { unavailable } = await injectMcpTools({
      userId: 'u-1',
      assistantId: 'a-1',
      tools,
      connectorStore: { list: vi.fn().mockResolvedValue([]) } as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: instanceStoreStub(),
      keepBuiltinsDirect: true,
    })
    expect(tools.has('imapSearchMessages')).toBe(false)
    expect(unavailable.join('\n')).toMatch(/Company email \(IMAP\)/)
  })

  it('multi-account: each mailbox gets an account-bound tool set with stable variant names', async () => {
    const primary = imapConnectorRow()  // inst-imap-1, maya@…, createdAt 07-01 → primary
    const second = {
      ...imapConnectorRow(),
      id: 'inst-imap-2',
      name: 'ops@harborlane.example',
      createdAt: new Date('2026-07-05T00:00:00Z'),
    }
    const credsById: Record<string, typeof IMAP_CREDS> = {
      'inst-imap-1': IMAP_CREDS,
      'inst-imap-2': { ...IMAP_CREDS, email: 'ops@harborlane.example' },
    }
    const instanceStore = {
      getAuthCredentialsSystem: vi.fn(async (id: string) => credsById[id]),
      getCredentialsSystem: vi.fn(async () => null),
    } as unknown as ConnectorInstanceStore

    const emit = vi.fn(async (_idCtx: unknown, _params: { payload: Record<string, unknown> }) => ({ status: 'executed' as const }))
    const audit = {
      preflight: vi.fn(() => preflightResult({ shouldDeny: true, classifierMatches: ['x'] })),
      emit,
    } as unknown as ConnectorActionAudit

    const tools = new Map<string, Tool>()
    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: { list: vi.fn().mockResolvedValue([primary, second]) } as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: instanceStore,
      keepBuiltinsDirect: true,
      connectorActionAudit: audit,
    })

    const sendNames = [...tools.keys()].filter((name) => name === 'imapSendMessage' || name.startsWith('imapSendMessage__'))
    expect(sendNames).toHaveLength(2)
    const primarySend = tools.get('imapSendMessage')!
    const opsSendName = sendNames.find((name) => name !== 'imapSendMessage')!
    const opsSend = tools.get(opsSendName)!
    expect(opsSendName).toMatch(/^imapSendMessage__opsharborlane/)
    expect(opsSend.description).toMatch(/^\[ops@harborlane\.example\]/)

    // The variant itself fixes the sender; no account router input is needed.
    await opsSend.execute({ to: ['x@y.z'], subject: 's', body: 'b' }, {} as never)
    expect(emit).toHaveBeenLastCalledWith(
      { userId: 'u-1', assistantId: 'a-1' },
      expect.objectContaining({ status: 'executed', payload: expect.objectContaining({ from: 'ops@harborlane.example' }) }),
    )

    // The primary retains canonical names for compatibility and is bound too.
    await primarySend.execute({ to: ['x@y.z'], subject: 's', body: 'b' }, {} as never)
    expect(emit).toHaveBeenLastCalledWith(
      { userId: 'u-1', assistantId: 'a-1' },
      expect.objectContaining({ status: 'executed', payload: expect.objectContaining({ from: 'maya@harborlane.example' }) }),
    )
  })

  it('multi-account: enablement and L2 policy resolve independently per mailbox governance id', async () => {
    const primary = imapConnectorRow()
    const second = {
      ...imapConnectorRow(),
      id: 'inst-imap-2',
      name: 'ops@harborlane.example',
      createdAt: new Date('2026-07-05T00:00:00Z'),
    }
    const credsById: Record<string, typeof IMAP_CREDS> = {
      'inst-imap-1': IMAP_CREDS,
      'inst-imap-2': { ...IMAP_CREDS, email: 'ops@harborlane.example' },
    }
    const instanceStore = {
      getAuthCredentialsSystem: vi.fn(async (id: string) => credsById[id]),
      getCredentialsSystem: vi.fn(async () => null),
    } as unknown as ConnectorInstanceStore
    const isEnabled = vi.fn(async (_assistantId: string, governanceId: string) => governanceId !== 'imap:inst-imap-2')
    const tools = new Map<string, Tool>()

    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: { list: vi.fn().mockResolvedValue([primary, second]) } as never,
      settingsStore: settingsStoreStub() as never,
      assistantConnectorStore: { isEnabled } as never,
      connectorInstanceStore: instanceStore,
      keepBuiltinsDirect: true,
    })

    expect(isEnabled).toHaveBeenCalledWith('a-1', 'imap:inst-imap-1', 'imap')
    expect(isEnabled).toHaveBeenCalledWith('a-1', 'imap:inst-imap-2', 'imap')
    expect([...tools.keys()].filter((name) => name === 'imapSearchMessages' || name.startsWith('imapSearchMessages__'))).toEqual([
      'imapSearchMessages',
    ])

    const getPolicy = vi.fn(async ({ assistantId, serverName, toolName }: {
      assistantId: string; serverName: string; toolName: string
    }) => (
      assistantId === 'a-1'
      && serverName === 'imap:inst-imap-2'
      && toolName === 'imapSendMessage'
        ? { policy: 'block' }
        : null
    ))
    const policyTools = new Map<string, Tool>()
    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools: policyTools,
      connectorStore: { list: vi.fn().mockResolvedValue([primary, second]) } as never,
      settingsStore: { getPolicy, setPolicy: vi.fn(), recordUsage: vi.fn(), recordUsageAndGetCount: vi.fn() } as never,
      connectorInstanceStore: instanceStore,
      keepBuiltinsDirect: true,
    })

    expect(policyTools.has('imapSendMessage')).toBe(true)
    expect([...policyTools.keys()].some((name) => name.startsWith('imapSendMessage__'))).toBe(false)
    expect(getPolicy).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: 'a-1', serverName: 'imap:inst-imap-2', toolName: 'imapSendMessage',
    }))
  })

  it('multi-account: only explicitly granted mailbox writes are discoverable', async () => {
    const primary = imapConnectorRow()
    const second = {
      ...imapConnectorRow(), id: 'inst-imap-2', name: 'ops@harborlane.example',
      createdAt: new Date('2026-07-05T00:00:00Z'),
    }
    const credsById: Record<string, typeof IMAP_CREDS> = {
      'inst-imap-1': IMAP_CREDS,
      'inst-imap-2': { ...IMAP_CREDS, email: 'ops@harborlane.example' },
    }
    const instanceStore = {
      getAuthCredentialsSystem: vi.fn(async (id: string) => credsById[id]),
      getCredentialsSystem: vi.fn(async () => null),
    } as unknown as ConnectorInstanceStore
    const getForAssistantSystem = vi.fn(async (_assistantId: string, governanceId: string) => ({
      allowedActions: governanceId === 'imap:inst-imap-1' ? ['imapSendMessage'] : [],
    }))
    const audit = {
      preflight: vi.fn(() => preflightResult({ shouldDeny: true, classifierMatches: ['test'] })),
      emit: vi.fn(async () => ({ status: 'executed' as const })),
    } as unknown as ConnectorActionAudit
    const tools = new Map<string, Tool>()
    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      connectorStore: { list: vi.fn().mockResolvedValue([primary, second]) } as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: instanceStore,
      assistantConnectorGrantsStore: { getForAssistantSystem } as never,
      connectorActionAudit: audit,
      keepBuiltinsDirect: true,
    })

    const sends = [...tools.entries()].filter(([name]) => name === 'imapSendMessage' || name.startsWith('imapSendMessage__'))
    const searches = [...tools.keys()].filter((name) => name === 'imapSearchMessages' || name.startsWith('imapSearchMessages__'))
    expect(sends).toHaveLength(1)
    expect(searches).toHaveLength(2)
    await sends[0][1].execute({ to: ['x@y.z'], subject: 's', body: 'b' }, {} as never)
    expect(getForAssistantSystem).toHaveBeenCalledWith('a-1', 'imap:inst-imap-1')
    expect(getForAssistantSystem).toHaveBeenCalledWith('a-1', 'imap:inst-imap-2')
    expect(getForAssistantSystem).not.toHaveBeenCalledWith('a-1', 'imap')
  })

  it('workspace grant overlay binds a tool set for every exposed mailbox from the winning grantor and no others', async () => {
    const credsById: Record<string, typeof IMAP_CREDS> = {
      'imap-primary': IMAP_CREDS,
      'imap-ops': { ...IMAP_CREDS, email: 'ops@harborlane.example' },
      'imap-teammate': { ...IMAP_CREDS, email: 'teammate@harborlane.example' },
      'imap-unexposed': { ...IMAP_CREDS, email: 'private@harborlane.example' },
    }
    const instanceStore = {
      getAuthCredentialsSystem: vi.fn(async (id: string) => credsById[id]),
      getCredentialsSystem: vi.fn(async () => null),
      listByWorkspaceSystem: vi.fn(async () => []),
    } as unknown as ConnectorInstanceStore
    const grant = (
      id: string,
      email: string,
      grantedByUserId: string,
      createdAt: string,
    ) => ({
      grantedByUserId,
      instance: {
        id,
        provider: 'imap',
        label: email,
        connected: true,
        healthStatus: 'ok',
        createdAt: new Date(createdAt),
      },
    })
    const connectorGrantStore = {
      listForTargetSystem: vi.fn(async () => [
        grant('imap-primary', IMAP_CREDS.email, 'u-1', '2026-07-01T00:00:00Z'),
        grant('imap-ops', 'ops@harborlane.example', 'u-1', '2026-07-02T00:00:00Z'),
        grant('imap-teammate', 'teammate@harborlane.example', 'u-2', '2026-07-03T00:00:00Z'),
      ]),
    }
    const emit = vi.fn(async (_idCtx: unknown, _params: { payload: Record<string, unknown> }) => ({ status: 'executed' as const }))
    const audit = {
      preflight: vi.fn(() => preflightResult({ shouldDeny: true, classifierMatches: ['test'] })),
      emit,
    } as unknown as ConnectorActionAudit
    const connectorStore = {
      // The same owner has another personal mailbox, but it was not exposed.
      // The overlay must never load this provider-wide list.
      list: vi.fn(async () => [{
        ...imapConnectorRow(), id: 'imap-unexposed', name: 'private@harborlane.example',
      }]),
    }
    const tools = new Map<string, Tool>()

    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', assistantTeamId: 'ws-1', tools,
      connectorStore: connectorStore as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: instanceStore,
      connectorGrantStore: connectorGrantStore as never,
      connectorActionAudit: audit,
      keepBuiltinsDirect: true,
    })

    expect(connectorStore.list).not.toHaveBeenCalled()
    expect(instanceStore.getAuthCredentialsSystem).toHaveBeenCalledWith('imap-primary')
    expect(instanceStore.getAuthCredentialsSystem).toHaveBeenCalledWith('imap-ops')
    expect(instanceStore.getAuthCredentialsSystem).not.toHaveBeenCalledWith('imap-teammate')
    expect(instanceStore.getAuthCredentialsSystem).not.toHaveBeenCalledWith('imap-unexposed')

    const sendNames = [...tools.keys()].filter((name) => name === 'imapSendMessage' || name.startsWith('imapSendMessage__'))
    expect(sendNames).toHaveLength(2)
    const opsSendName = sendNames.find((name) => name !== 'imapSendMessage')!
    const opsSend = tools.get(opsSendName)!
    await opsSend.execute({ to: ['x@y.z'], subject: 's', body: 'b' }, {} as never)
    expect(emit).toHaveBeenLastCalledWith(
      { userId: 'u-1', assistantId: 'a-1' },
      expect.objectContaining({ payload: expect.objectContaining({ from: 'ops@harborlane.example' }) }),
    )
    const descriptions = sendNames.map((name) => tools.get(name)?.description ?? '').join('\n')
    expect(descriptions).not.toContain('teammate@harborlane.example')
    expect(descriptions).not.toContain('private@harborlane.example')
  })

  it('injects every workspace-owned mailbox with independent workspace policy (team-native overlay)', async () => {
    // `POST /api/connector-instances/:id/transfer` moves a personal mailbox to
    // `scope='workspace'` AND DELETES its grants — a workspace-owned instance is
    // visible by scope, so it needs none. That leaves the team-native overlay as
    // the mailbox's only route to a workspace assistant (the base pass is
    // suppressed by the connector-scoping gate), so a missing branch there means
    // transferring your mailbox to the workspace makes it vanish from the
    // assistant while Studio still shows it connected.
    const tools = new Map<string, Tool>()
    const instanceStore = {
      getAuthCredentialsSystem: vi.fn(async (id: string) => id === 'inst-imap-team-2'
        ? { ...IMAP_CREDS, email: 'ops@harborlane.example' }
        : IMAP_CREDS),
      getCredentialsSystem: vi.fn(async () => null),
      listByWorkspaceSystem: vi.fn(async () => [
        {
          id: 'inst-imap-team', scope: 'workspace', userId: null, workspaceId: 'ws-1',
          provider: 'imap', label: 'team@harborlane.example', url: null, custom: false,
          connected: true, healthStatus: 'ok', config: {}, sensitivity: 'internal',
          createdAt: new Date('2026-07-01T00:00:00Z'),
          updatedAt: new Date('2026-07-01T00:00:00Z'),
        },
        {
          id: 'inst-imap-team-2', scope: 'workspace', userId: null, workspaceId: 'ws-1',
          provider: 'imap', label: 'ops@harborlane.example', url: null, custom: false,
          connected: true, healthStatus: 'ok', config: {}, sensitivity: 'internal',
          createdAt: new Date('2026-07-02T00:00:00Z'),
          updatedAt: new Date('2026-07-02T00:00:00Z'),
        },
      ]),
    } as unknown as ConnectorInstanceStore
    const getPolicy = vi.fn(async (_workspaceId: string, serverName: string, toolName: string) => {
      if (toolName !== 'imapSendMessage') return null
      if (serverName === 'imap') return { policy: 'block', classification: 'write' }
      if (serverName === 'imap:inst-imap-team-2') return { policy: 'allow', classification: 'write' }
      return null
    })

    await injectMcpTools({
      userId: 'u-1', assistantId: 'a-1', tools,
      // Empty: a workspace assistant never base-loads the owner's personal set.
      connectorStore: { list: vi.fn().mockResolvedValue([]) } as never,
      settingsStore: settingsStoreStub() as never,
      connectorInstanceStore: instanceStore,
      connectorGrantStore: { listForTargetSystem: vi.fn().mockResolvedValue([]) } as never,
      workspaceToolPolicyStore: { getPolicy } as never,
      assistantTeamId: 'ws-1',
      keepBuiltinsDirect: true,
    })

    expect(tools.has('imapSearchMessages')).toBe(true)
    expect(tools.has('imapGetMessage')).toBe(true)
    // Primary inherits the legacy provider block; the second account's exact
    // allow row wins instead of being clamped by its sibling/provider policy.
    expect(tools.has('imapSendMessage')).toBe(false)
    expect([...tools.keys()].filter((name) => name.startsWith('imapSendMessage__'))).toHaveLength(1)
    expect(getPolicy).toHaveBeenCalledWith('ws-1', 'imap:inst-imap-team-2', 'imapSendMessage')
    // Bound to the team-owned row, not to whatever the acting user owns.
    expect(instanceStore.getAuthCredentialsSystem).toHaveBeenCalledWith('inst-imap-team')
    expect(instanceStore.getAuthCredentialsSystem).toHaveBeenCalledWith('inst-imap-team-2')
  })

  it('classifier detection is advisory after policy admission and cannot veto the send', async () => {
    const emit = vi.fn(async (_idCtx: unknown, _params: { payload: Record<string, unknown> }) => ({ status: 'executed' as const }))
    const preflight = vi.fn(() => preflightResult({ shouldDeny: true, classifierMatches: ['credential'] }))
    const audit = {
      preflight,
      emit,
    } as unknown as ConnectorActionAudit
    const { tools } = await injectImap({ audit })
    const send = tools.get('imapSendMessage')!
    const result = await send.execute(
      { to: ['recipient@example.com'], subject: 's', body: 'sk_live_secret' },
      {} as never,
    )
    expect(result.isError, JSON.stringify(result)).toBeFalsy()
    expect(mailboxSendMessage).toHaveBeenCalledTimes(1)
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({
      enforcement: 'advisory',
      payload: expect.objectContaining({ body: 'sk_live_secret' }),
    }))
    expect(emit).toHaveBeenCalledWith(
      { userId: 'u-1', assistantId: 'a-1' },
      expect.objectContaining({
        connectorId: 'imap', actionKind: 'send_email', status: 'executed',
        payload: expect.not.objectContaining({ body: expect.anything() }),
      }),
    )
  })

  it('includes attachment metadata, never bytes or body text, in the executed audit', async () => {
    const emit = vi.fn(async (_idCtx: unknown, _params: { payload: Record<string, unknown> }) => ({ status: 'executed' as const }))
    const preflight = vi.fn((_input: unknown) => preflightResult({
      shouldDeny: true,
      classifierMatches: ['proposal.pdf'],
    }))
    const audit = { preflight, emit } as unknown as ConnectorActionAudit
    const { tools } = await injectImap({ audit, withFiles: true })
    const send = tools.get('imapSendMessage')!

    const result = await send.execute(
      {
        to: ['recipient@example.com'],
        subject: 'Proposal',
        body: 'Attached.',
        attachments: ['file-1'],
      },
      { workspaceId: 'ws-1', userId: 'u-1', assistantId: 'a-1' } as never,
    )

    expect(result.isError, JSON.stringify(result)).toBeFalsy()
    const expectedAttachments = [{
      name: 'proposal.pdf',
      mime: 'application/pdf',
      size_bytes: 3,
    }]
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({
      enforcement: 'advisory',
      payload: expect.objectContaining({
        body: 'Attached.',
        attachment_count: 1,
        attachments: expectedAttachments,
      }),
    }))
    expect(emit).toHaveBeenCalledWith(
      { userId: 'u-1', assistantId: 'a-1' },
      expect.objectContaining({
        status: 'executed',
        payload: expect.objectContaining({ attachments: expectedAttachments }),
      }),
    )
    const emittedPayload = emit.mock.calls[0][1].payload
    expect(emittedPayload).not.toHaveProperty('body')
    expect(JSON.stringify(preflight.mock.calls[0][0])).not.toContain('data')
  })
})

describe('[COMP:tools/imap-attachments] imapSaveAttachment injection', () => {
  it('registry classifies it read/allow — the write lands inside the workspace, sendFile gates egress', () => {
    const row = OFFICIAL_CONNECTOR_TOOLS.imap.find((t) => t.name === 'imapSaveAttachment')
    expect(row).toMatchObject({ classification: 'read', defaultPolicy: 'allow' })
  })

  it('is injected only when the workspace-file primitive is wired', async () => {
    const withoutFiles = await injectImap()
    expect(withoutFiles.tools.has('imapGetMessage')).toBe(true)
    expect(withoutFiles.tools.has('imapSaveAttachment')).toBe(false)

    const withFiles = await injectImap({ withFiles: true })
    expect(withFiles.tools.has('imapSaveAttachment')).toBe(true)
    expect(withFiles.tools.get('imapSaveAttachment')?.requiresConfirmation).toBeFalsy()
  })

  it('routes an auth failure inside getAttachment to the health probe (auth_failed)', async () => {
    // The credential dies after binding: the injector resolved the mailbox
    // email, then the per-call `getSettings` is refused the way imapflow
    // refuses a revoked app password (structural flag, not HTTP prose).
    const authError = Object.assign(new Error('Invalid credentials'), { authenticationFailed: true })
    let calls = 0
    const markHealth = vi.fn(async () => {})
    const instanceStore = {
      getAuthCredentialsSystem: vi.fn(async () => {
        calls += 1
        if (calls === 1) return IMAP_CREDS
        throw authError
      }),
      getCredentialsSystem: vi.fn(async () => null),
      markHealth,
    } as unknown as ConnectorInstanceStore

    const { tools } = await injectImap({ instanceStore, withFiles: true })
    const save = tools.get('imapSaveAttachment')!
    const result = await save.execute(
      { messageId: 'INBOX:7', partId: '2' },
      { workspaceId: 'ws-1', userId: 'u-1', assistantId: 'a-1' } as never,
    )

    expect(result.isError).toBe(true)
    // markHealth is fire-and-forget inside the reporter — let the microtask run.
    await new Promise((r) => setTimeout(r, 0))
    expect(markHealth).toHaveBeenCalledWith('inst-imap-1', 'auth_failed', expect.stringContaining('Invalid credentials'))
  })
})
