/**
 * Injection-level tests for the company-mailbox (imap) connector:
 * Layer-1/Layer-2 gating, the unavailable[] notice, and the send governance
 * chain — `ask` classification in the registry, connector_actions
 * `send_email` audit, and the classifier preflight short-circuiting BEFORE
 * any network call (plan §10 "Governance" row).
 *
 * [COMP:tools/mailbox-imap]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
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

async function injectImap(over: { audit?: ConnectorActionAudit } = {}) {
  const tools = new Map<string, Tool>()
  const result = await injectMcpTools({
    userId: 'u-1',
    assistantId: 'a-1',
    tools,
    connectorStore: { list: vi.fn().mockResolvedValue([imapConnectorRow()]) } as never,
    settingsStore: settingsStoreStub() as never,
    connectorInstanceStore: instanceStoreStub(),
    keepBuiltinsDirect: true,
    ...(over.audit ? { connectorActionAudit: over.audit } : {}),
  })
  return { tools, result }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

describe('[COMP:tools/mailbox-imap] imap injection', () => {
  it('registry classifies imapSendMessage write/ask (the write-grant gate + approval chain key off this)', () => {
    const rows = OFFICIAL_CONNECTOR_TOOLS.imap
    expect(rows).toBeDefined()
    const send = rows.find((t) => t.name === 'imapSendMessage')
    expect(send).toMatchObject({ classification: 'write', defaultPolicy: 'ask' })
    expect(rows.find((t) => t.name === 'imapSearchMessages')).toMatchObject({ classification: 'read', defaultPolicy: 'allow' })
    expect(rows.find((t) => t.name === 'imapGetMessage')).toMatchObject({ classification: 'read', defaultPolicy: 'allow' })
  })

  it('injects the three mailbox tools when a connected imap instance exists', async () => {
    const { tools } = await injectImap()
    expect(tools.has('imapSearchMessages')).toBe(true)
    expect(tools.has('imapGetMessage')).toBe(true)
    expect(tools.has('imapSendMessage')).toBe(true)
    expect(tools.get('imapSendMessage')?.requiresConfirmation).toBe(true)
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

  it('multi-account: several mailboxes surface ONE tool set, and `account` routes the send to the right sender', async () => {
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

    // Deny preflight short-circuits the send before any IMAP/SMTP call — we only
    // assert the audited `from`, which the injector sets from the RESOLVED account.
    const emit = vi.fn(async () => ({ status: 'denied' as const }))
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

    // ONE set of tools (same names), not a namespaced set per mailbox.
    expect([...tools.keys()].filter((k) => k.startsWith('imap'))).toEqual(
      expect.arrayContaining(['imapSearchMessages', 'imapGetMessage', 'imapSendMessage']),
    )
    expect(tools.size).toBeGreaterThan(0)
    const send = tools.get('imapSendMessage')!

    // Named non-primary account → audited from = that mailbox.
    await send.execute({ to: 'x@y.z', subject: 's', body: 'b', account: 'ops@harborlane.example' }, {} as never)
    expect(emit).toHaveBeenLastCalledWith(
      { userId: 'u-1', assistantId: 'a-1' },
      expect.objectContaining({ status: 'denied', payload: expect.objectContaining({ from: 'ops@harborlane.example' }) }),
    )

    // Omitted account → audited from = the primary (first-connected) mailbox.
    await send.execute({ to: 'x@y.z', subject: 's', body: 'b' }, {} as never)
    expect(emit).toHaveBeenLastCalledWith(
      { userId: 'u-1', assistantId: 'a-1' },
      expect.objectContaining({ status: 'denied', payload: expect.objectContaining({ from: 'maya@harborlane.example' }) }),
    )
  })

  it('classifier preflight deny short-circuits the send BEFORE any network call and audits status=denied', async () => {
    const emit = vi.fn(async () => ({ status: 'denied' as const }))
    const audit = {
      preflight: vi.fn(() => preflightResult({ shouldDeny: true, classifierMatches: ['credential'] })),
      emit,
    } as unknown as ConnectorActionAudit
    const { tools } = await injectImap({ audit })
    const send = tools.get('imapSendMessage')!
    const result = await send.execute(
      { to: 'x@y.z', subject: 's', body: 'sk_live_secret' },
      {} as never,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/classifier blocked/)
    expect(emit).toHaveBeenCalledWith(
      { userId: 'u-1', assistantId: 'a-1' },
      expect.objectContaining({ connectorId: 'imap', actionKind: 'send_email', status: 'denied' }),
    )
    // The deny threw before createMailboxApi's sendMessage — no IMAP/SMTP
    // connection was ever attempted (nothing here stubs the network; a real
    // attempt would reject with a connection error, not the classifier copy).
  })
})
