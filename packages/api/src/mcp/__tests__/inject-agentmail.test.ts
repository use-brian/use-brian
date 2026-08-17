/**
 * [COMP:tools/agentmail] AgentMail injection follows Channel handler scope
 * and exact per-inbox outbound action grants.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from '@use-brian/core'

vi.mock('../../connector-config.js', () => ({
  getConnectorConfig: () => undefined,
}))

const listHandledInstances = vi.hoisted(() => vi.fn())
vi.mock('../../db/channels-store.js', () => ({
  listAgentmailConnectorInstanceIdsForAssistantSystem: (...args: unknown[]) =>
    listHandledInstances(...args),
}))

import { injectMcpTools } from '../inject.js'

function settingsStoreStub() {
  return new Proxy({}, { get: () => vi.fn().mockResolvedValue(undefined) })
}

const INSTANCES = [
  {
    id: 'inbox-primary', provider: 'agentmail', label: 'brian@agentmail.to',
    connectedEmail: 'brian@agentmail.to', connected: true, healthStatus: 'ok',
    custom: false, url: null, createdAt: new Date('2026-08-01T00:00:00Z'),
  },
  {
    id: 'inbox-ops', provider: 'agentmail', label: 'ops@agentmail.to',
    connectedEmail: 'ops@agentmail.to', connected: true, healthStatus: 'ok',
    custom: false, url: null, createdAt: new Date('2026-08-02T00:00:00Z'),
  },
]

function providerStub() {
  return {
    kind: 'agentmail',
    sendMessage: vi.fn(async () => ({ messageId: 'message-1', threadId: 'thread-1' })),
    listThreads: vi.fn(async () => ({
      threads: [{
        threadId: 'thread-1', inboxId: 'brian@agentmail.to', subject: 'Hello',
        preview: 'Hi', senders: ['contact@example.com'], timestamp: '2026-08-14T00:00:00Z',
        messageCount: 1,
      }],
    })),
    createDraft: vi.fn(async () => ({ draftId: 'draft-1', sendAt: null })),
  }
}

async function injectAgentmail(over: {
  handled?: string[]
  getGrant?: ReturnType<typeof vi.fn>
} = {}) {
  const provider = providerStub()
  const tools = new Map<string, Tool>()
  listHandledInstances.mockResolvedValue(over.handled ?? ['inbox-primary'])
  const getForAssistantSystem = over.getGrant ?? vi.fn(async () => ({
    allowedActions: ['agentmailSendMessage'],
  }))
  const connectorInstanceStore = {
    listByWorkspaceSystem: vi.fn(async () => INSTANCES),
    getCredentialsSystem: vi.fn(async () => null),
    getAuthCredentialsSystem: vi.fn(async () => null),
  }

  const result = await injectMcpTools({
    userId: 'user-1',
    assistantId: 'assistant-1',
    assistantTeamId: 'workspace-1',
    tools,
    connectorStore: { list: vi.fn(async () => []) } as never,
    settingsStore: settingsStoreStub() as never,
    connectorInstanceStore: connectorInstanceStore as never,
    assistantConnectorGrantsStore: { getForAssistantSystem } as never,
    emailInboxProvider: provider as never,
    keepBuiltinsDirect: true,
  })

  return { tools, provider, result, getForAssistantSystem }
}

beforeEach(() => {
  listHandledInstances.mockReset()
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:tools/agentmail] Channel-owned mailbox injection', () => {
  it('exposes only handled inboxes and only exact-granted outbound actions', async () => {
    const { tools, provider, getForAssistantSystem } = await injectAgentmail()

    expect(listHandledInstances).toHaveBeenCalledWith('workspace-1', 'assistant-1')
    expect(tools.has('agentmailSearchThreads')).toBe(true)
    expect(tools.has('agentmailSendMessage')).toBe(true)
    expect(tools.has('agentmailCreateDraft')).toBe(false)
    expect(getForAssistantSystem).toHaveBeenCalledWith(
      'assistant-1',
      'agentmail:inbox-primary',
    )
    expect(getForAssistantSystem).not.toHaveBeenCalledWith(
      'assistant-1',
      'agentmail:inbox-ops',
    )

    const unavailableInbox = await tools.get('agentmailSearchThreads')!.execute(
      { fromInbox: 'ops@agentmail.to' },
      {} as never,
    )
    expect(unavailableInbox.isError).toBe(true)
    expect(provider.listThreads).not.toHaveBeenCalled()
  })

  it('rechecks the exact inbox grant before sending', async () => {
    const getGrant = vi.fn()
      .mockResolvedValueOnce({ allowedActions: ['agentmailSendMessage'] })
      .mockResolvedValueOnce({ allowedActions: [] })
    const { tools, provider } = await injectAgentmail({ getGrant })

    const result = await tools.get('agentmailSendMessage')!.execute(
      {
        to: ['contact@example.com'],
        subject: 'Hello',
        body: 'Checking in.',
      },
      {} as never,
    )

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('Studio → Channels')
    expect(provider.sendMessage).not.toHaveBeenCalled()
    expect(getGrant).toHaveBeenNthCalledWith(
      2,
      'assistant-1',
      'agentmail:inbox-primary',
    )
  })

  it('injects no mailbox tools when the assistant handles no inbox', async () => {
    const { tools, result } = await injectAgentmail({ handled: [] })

    expect(tools.has('agentmailSearchThreads')).toBe(false)
    expect(tools.has('agentmailSendMessage')).toBe(false)
    expect(result.unavailable.join('\n')).toContain(
      'this assistant does not handle an inbox',
    )
  })
})
