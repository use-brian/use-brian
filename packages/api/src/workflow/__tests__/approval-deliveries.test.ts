/**
 * Unit tests for approval prompt deliveries.
 * Component tag: [COMP:channels/approval-deliveries].
 *
 * Mocks `query` and global `fetch`. Verifies createApprovalDeliveryDispatcher:
 * web is a no-op, telegram with no bot token or no chat route is a no-op,
 * telegram with a resolved chat_id POSTs to the Telegram sendMessage API
 * with the prompt body, and slack/whatsapp are stubbed no-ops.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
}))

import { createApprovalDeliveryDispatcher } from '../approval-deliveries.js'
import { query } from '../../db/client.js'

const mockQuery = vi.mocked(query)
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
  vi.stubGlobal('fetch', mockFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('[COMP:channels/approval-deliveries] createApprovalDeliveryDispatcher', () => {
  it('is a no-op for the web channel — the UI surfaces the row independently', async () => {
    const dispatch = createApprovalDeliveryDispatcher({ webBaseUrl: 'https://app.test' })
    await dispatch(params({ deliveryChannelType: 'web' }))
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
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

  it('POSTs the prompt to the Telegram sendMessage API when a chat_id resolves', async () => {
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
    expect(body.text).toContain('approve appr-abc') // short id in the reply hint
  })

  it('is a stubbed no-op for the slack channel', async () => {
    const dispatch = createApprovalDeliveryDispatcher({ webBaseUrl: 'https://app.test' })
    await dispatch(params({ deliveryChannelType: 'slack' }))
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

it.each(['telegram', 'slack', 'whatsapp', 'msteams', 'feishu'] as const)(
  'dispatches resolved recent %s through the workflow adapter, never the legacy bot', async (channelType) => {
    const deliverToChannel = vi.fn().mockResolvedValue({ status: 'delivered' })
    const recentTarget = { channelType, channelId: 'destination', channelIntegrationId: 'byo', threadRef: 'thread' }
    await createApprovalDeliveryDispatcher({
      webBaseUrl: 'https://app.test', telegramBotToken: 'official', deliverToChannel,
    })(params({ deliveryChannelType: channelType, assistantId: 'assistant', recentTarget }))
    expect(deliverToChannel).toHaveBeenCalledWith({
      ...recentTarget, workspaceId: 'ws-1', assistantId: 'assistant', userId: 'u-1',
      text: expect.stringContaining('/w/ws-1/approvals?focus=appr-12345678-rest'),
      // Evidence is explicit so the destination-audience gate runs.
      scopeEvidence: { sensitivity: 'public', compartments: [], projectIds: [] },
    })
    const text = deliverToChannel.mock.calls[0][0].text
    // Tool arguments are run content; the push never carries them.
    expect(text).not.toContain('a@b.com')
    expect(text).not.toContain('Args:')
    expect(text).toContain('Approve or reject on the web: https://app.test/w/ws-1/approvals')
    expect(text).not.toContain('Reply with')
    expect(text).not.toContain('`approve ')
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockQuery).not.toHaveBeenCalled()
  },
)


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
