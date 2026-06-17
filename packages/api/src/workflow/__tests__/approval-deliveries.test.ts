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
