/**
 * Injection-level send-as coverage for the company mailbox (imap): the
 * `send_email` audit records the sender the mail actually went out as (an
 * alias resolved by the seam), the confirmation preview reaches the seam's
 * `resolveSender` through both wrappers, and the alias list is read from the
 * instance config at call time (mailbox-imap.md → "Send-as aliases").
 * Isolated from `inject-mailbox.test.ts` because it mocks the seam factory.
 *
 * [COMP:tools/mailbox-imap]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../connector-config.js', () => ({ getConnectorConfig: () => undefined }))
vi.mock('../../db/email-archive-store.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/email-archive-store.js')>(
    '../../db/email-archive-store.js',
  )
  return {
    ...actual,
    countEmailArchiveMessages: vi.fn(async () => ({
      total: 2,
      byFolder: { 'Archived correspondence': 2 },
    })),
  }
})

const sendMessage = vi.fn(async (_p: unknown) => ({ messageId: '<sent@x>', from: 'bd@harborlane.example' }))
const resolveSender = vi.fn(async (_p: unknown) => ({ from: 'bd@harborlane.example', allowed: ['maya@harborlane.example', 'bd@harborlane.example'] }))
const createMailboxApiMock = vi.fn((opts: {
  getSendAsAliases?: () => Promise<string[]>
  getKnownFolderPaths?: () => Promise<string[]>
}) => ({
  searchMessages: vi.fn(),
  getMessage: vi.fn(),
  getAttachment: vi.fn(),
  sendMessage,
  resolveSender,
  __opts: opts,
}))
vi.mock('../../mailbox/mailbox-api.js', () => ({
  createMailboxApi: (opts: never) => createMailboxApiMock(opts),
}))

import { injectMcpTools } from '../inject.js'
import type { ConnectorActionAudit, ConnectorActionPreflight } from '../../connector-action-port.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'
import type { Tool } from '@use-brian/core'

const IMAP_CREDS = {
  type: 'imap' as const,
  email: 'maya@harborlane.example',
  appPassword: 'pw',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
}

function preflightResult(over: Partial<ConnectorActionPreflight> = {}): ConnectorActionPreflight {
  return {
    responseCeiling: 'public', retrievalMax: 'public', classifierDetected: 'public',
    classifierMatches: [], shouldDeny: false, shadowOnly: false, ...over,
  }
}

async function inject(audit?: ConnectorActionAudit) {
  const tools = new Map<string, Tool>()
  const getSystem = vi.fn(async () => ({
    id: 'inst-imap-1',
    config: {
      sendAsAliases: ['bd@harborlane.example'],
      mailboxSync: { folders: { 'Client correspondence': { uidvalidity: '7', lastUid: 4 } } },
    },
  }))
  const instanceStore = {
    getAuthCredentialsSystem: vi.fn(async () => IMAP_CREDS),
    getCredentialsSystem: vi.fn(async () => null),
    getSystem,
    // The health probe reports every successful seam call (`ok`) here.
    markHealth: vi.fn(async () => false),
  } as unknown as ConnectorInstanceStore
  await injectMcpTools({
    userId: 'u-1',
    assistantId: 'a-1',
    tools,
    connectorStore: {
      list: vi.fn().mockResolvedValue([{
        id: 'inst-imap-1', userId: 'u-1', connectorId: 'imap', name: 'maya@harborlane.example', url: null, custom: false,
        connected: true, credentialsType: 'imap', createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'),
      }]),
    } as never,
    settingsStore: new Proxy({}, { get: () => vi.fn().mockResolvedValue(undefined) }) as never,
    connectorInstanceStore: instanceStore,
    keepBuiltinsDirect: true,
    ...(audit ? { connectorActionAudit: audit } : {}),
  })
  return { tools, getSystem }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  sendMessage.mockClear()
  resolveSender.mockClear()
  createMailboxApiMock.mockClear()
})

describe('[COMP:tools/mailbox-imap] send-as aliases at injection', () => {
  it('reads config.sendAsAliases from the instance row at call time (getSystem, never a cached copy)', async () => {
    const { getSystem } = await inject()
    const opts = createMailboxApiMock.mock.calls[0][0]
    expect(typeof opts.getSendAsAliases).toBe('function')
    expect(await opts.getSendAsAliases!()).toEqual(['bd@harborlane.example'])
    expect(getSystem).toHaveBeenCalledWith('inst-imap-1')
  })

  it('gives live search the union of cursor-known and archive-known folder paths', async () => {
    await inject()
    const opts = createMailboxApiMock.mock.calls[0][0]
    expect(await opts.getKnownFolderPaths!()).toEqual([
      'Client correspondence',
      'Archived correspondence',
    ])
  })

  it('the executed send_email audit records the RESOLVED sender, not just the bound account (row 7)', async () => {
    const emit = vi.fn(async () => ({ status: 'executed' as const }))
    const audit = { preflight: vi.fn(() => preflightResult()), emit } as unknown as ConnectorActionAudit
    const { tools } = await inject(audit)
    const send = tools.get('imapSendMessage')!
    const result = await send.execute({ to: ['ken@client.hk'], subject: 'Re', body: 'b', inReplyTo: 'INBOX:7' }, {} as never)
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ from: 'bd@harborlane.example', messageId: '<sent@x>' })
    expect(emit).toHaveBeenCalledWith(
      { userId: 'u-1', assistantId: 'a-1' },
      expect.objectContaining({
        connectorId: 'imap', actionKind: 'send_email', status: 'executed',
        payload: expect.objectContaining({ from: 'bd@harborlane.example', in_reply_to: 'INBOX:7' }),
      }),
    )
  })

  it('the confirmation preview reaches the seam resolveSender through the audit + health wrappers', async () => {
    const { tools } = await inject()
    const send = tools.get('imapSendMessage')!
    const lines = await send.describeConfirmation!({ to: ['ken@client.hk'], subject: 'Re', body: 'b', inReplyTo: 'INBOX:7' }, {} as never)
    expect(lines?.[0]).toBe('• From: bd@harborlane.example')
    expect(resolveSender).toHaveBeenCalledWith({ inReplyTo: 'INBOX:7' })
  })
})
