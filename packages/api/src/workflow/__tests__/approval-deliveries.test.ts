/**
 * Unit tests for approval prompt deliveries.
 * Component tag: [COMP:channels/approval-deliveries].
 *
 * Mocks `query`, session helpers, and global `fetch`. Verifies
 * createApprovalDeliveryDispatcher: web inbox / personal web chat are no-ops
 * (chat restores the confirmation card via GET /pending), messaging recent
 * targets go through deliverToChannel with Allow/Deny actions, and legacy
 * stubs remain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
vi.mock('../../db/sessions.js', () => ({
  findSessionById: vi.fn(),
  addSessionMessage: vi.fn(),
}))

import { createApprovalDeliveryDispatcher } from '../approval-deliveries.js'
import { query } from '../../db/client.js'
import { addSessionMessage, findSessionById } from '../../db/sessions.js'

const mockQuery = vi.mocked(query)
const mockFindSession = vi.mocked(findSessionById)
const mockAddMessage = vi.mocked(addSessionMessage)
const mockFetch = vi.fn()

type DeliveryParams = Parameters<ReturnType<typeof createApprovalDeliveryDispatcher>>[0]

function params(over: Partial<DeliveryParams> = {}): DeliveryParams {
  return {
    deliveryChannelType: 'web',
    workspaceId: 'ws-1',
    approvalId: 'appr-12345678-rest',
    approverUserId: 'u-1',
    workflowName: 'Nightly report',
    toolName: 'gmailSend',
    arguments: { to: 'a@b.com' },
    ...over,
  } as unknown as DeliveryParams
}

beforeEach(() => {
  mockQuery.mockReset()
  mockFetch.mockReset()
  mockFindSession.mockReset()
  mockAddMessage.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('[COMP:channels/approval-deliveries] createApprovalDeliveryDispatcher', () => {
  it('is a no-op for the web inbox — chat restores confirmations independently', async () => {
    const dispatch = createApprovalDeliveryDispatcher({ webBaseUrl: 'https://app.test' })
    await dispatch(params({ deliveryChannelType: 'web', deliveryChannelId: 'queue' }))
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockAddMessage).not.toHaveBeenCalled()
  })

  it('is a no-op for verified personal web chat — pending restore shows the card', async () => {
    const dispatch = createApprovalDeliveryDispatcher({ webBaseUrl: 'https://app.test' })
    await dispatch(params({
      deliveryChannelType: 'web',
      deliveryChannelId: 'sess-1',
      assistantId: 'assistant',
      externalAction: true,
      prompt: { title: 'Deploy canary', details: 'Ship revision abc' },
      recentTarget: { channelType: 'web', channelId: 'sess-1' },
    }))
    expect(mockAddMessage).not.toHaveBeenCalled()
    expect(mockFindSession).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('preserves native workflow delivery into personal web chat', async () => {
    mockFindSession.mockResolvedValueOnce({ id: 'sess-1', assistantId: 'assistant', userId: 'u-1', channelType: 'web' } as never)
    mockAddMessage.mockResolvedValueOnce({ id: 'message' } as never)
    await createApprovalDeliveryDispatcher({ webBaseUrl: 'https://app.test' })(params({
      deliveryChannelType: 'web', deliveryChannelId: 'sess-1', assistantId: 'assistant',
    }))
    expect(mockAddMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1', content: [{ type: 'text', text: expect.stringContaining('/p?panel=approvals') }],
    }))
  })

  it('skips telegram delivery when no bot token is configured', async () => {
    const dispatch = createApprovalDeliveryDispatcher({ webBaseUrl: 'https://app.test' })
    await dispatch(params({ deliveryChannelType: 'telegram' }))
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('skips telegram delivery when the user has no telegram chat route', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const dispatch = createApprovalDeliveryDispatcher({
      webBaseUrl: 'https://app.test',
      telegramBotToken: 'bot-token',
    })
    await dispatch(params({ deliveryChannelType: 'telegram' }))
    expect(mockQuery).toHaveBeenCalledOnce()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('POSTs the confirmation prompt to Telegram when a chat_id resolves', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ chatId: 'chat-99' }], rowCount: 1 } as never)
    mockFetch.mockResolvedValueOnce({ ok: true })
    const dispatch = createApprovalDeliveryDispatcher({
      webBaseUrl: 'https://app.test',
      telegramBotToken: 'bot-token',
    })
    await dispatch(params({ deliveryChannelType: 'telegram', approvalId: 'appr-abcdef12-rest' }))
    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage')
    const body = JSON.parse((init as { body: string }).body)
    expect(body.chat_id).toBe('chat-99')
    expect(body.text).toContain('approve appr-abc')
    expect(body.text).toContain('Allow this action?')
    expect(body.text.includes('Nightly report')).toBe(false)
    expect(body.text.includes('gmailSend')).toBe(false)
  })

  it('is a stubbed no-op for the slack channel without a recent target', async () => {
    const dispatch = createApprovalDeliveryDispatcher({ webBaseUrl: 'https://app.test' })
    await dispatch(params({ deliveryChannelType: 'slack' }))
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

it.each(['telegram', 'slack', 'whatsapp', 'msteams', 'feishu'] as const)(
  'dispatches resolved recent %s with Allow/Deny actions through the workflow adapter', async (channelType) => {
    const deliverToChannel = vi.fn().mockResolvedValue({ status: 'delivered' })
    const recentTarget = { channelType, channelId: 'destination', channelIntegrationId: 'byo', threadRef: 'thread' }
    await createApprovalDeliveryDispatcher({
      webBaseUrl: 'https://app.test', telegramBotToken: 'official', deliverToChannel,
    })(params({ deliveryChannelType: channelType, assistantId: 'assistant', recentTarget }))
    expect(deliverToChannel).toHaveBeenCalledWith({
      ...recentTarget, workspaceId: 'ws-1', assistantId: 'assistant', userId: 'u-1',
      text: expect.stringContaining('/w/ws-1/p?panel=approvals&approval=appr-12345678-rest'),
      actions: [
        { id: 'allow', label: 'Allow', data: 'approval:appr-12345678-rest:allow', replyText: 'approve appr-123' },
        { id: 'deny', label: 'Deny', data: 'approval:appr-12345678-rest:deny', replyText: 'reject appr-123' },
      ],
      scopeEvidence: { sensitivity: 'public', compartments: [], projectIds: [] },
    })
    const text = deliverToChannel.mock.calls[0][0].text
    expect(text).not.toContain('a@b.com')
    expect(text).not.toContain('Args:')
    expect(text.includes('Nightly report')).toBe(false)
    expect(text.includes('gmailSend')).toBe(false)
    expect(text).toContain('Allow this action?')
    expect(text).toContain('Reply with')
    expect(text).toContain('`approve ')
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  },
)

it('includes external request title and details when provided', async () => {
  const deliverToChannel = vi.fn().mockResolvedValue({ status: 'delivered' })
  await createApprovalDeliveryDispatcher({
    webBaseUrl: 'https://app.test', deliverToChannel,
  })(params({
    deliveryChannelType: 'telegram',
    assistantId: 'assistant',
    externalAction: true,
    prompt: { title: 'Restart gateway', details: 'Affects loopback only' },
    recentTarget: { channelType: 'telegram', channelId: '123', channelIntegrationId: 'byo' },
  }))
  const text = deliverToChannel.mock.calls[0][0].text
  expect(text).toContain('**Restart gateway**')
  expect(text).toContain('Affects loopback only')
  expect(text).toContain('/chat?attention=appr-12345678-rest')
  expect(text).not.toContain('panel=approvals')
})

it.each(['skipped', 'failed'] as const)('warns when recent delivery is %s without falling back to the official bot', async (status) => {
  const outcome = status === 'skipped'
    ? { status, channelType: 'telegram', reason: 'no_integration' }
    : { status, channelType: 'telegram', error: 'unavailable' }
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const deliverToChannel = vi.fn().mockResolvedValue(outcome)
    await createApprovalDeliveryDispatcher({
      webBaseUrl: 'https://app.test', telegramBotToken: 'official', deliverToChannel,
    })(params({ deliveryChannelType: 'telegram', assistantId: 'assistant',
      recentTarget: { channelType: 'telegram', channelId: '123', channelIntegrationId: 'byo' },
    }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`delivery ${status}`), outcome)
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})

it('never sends the reply-to-approve fallback into a Telegram group', async () => {
  mockQuery.mockResolvedValueOnce({ rows: [{ chatId: '-1005550100' }], rowCount: 1 } as never)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await createApprovalDeliveryDispatcher({ webBaseUrl: 'https://app.test', telegramBotToken: 'official' })(
      params({ deliveryChannelType: 'telegram' }),
    )
    expect(mockFetch).not.toHaveBeenCalled()
  } finally {
    warn.mockRestore()
  }
})
