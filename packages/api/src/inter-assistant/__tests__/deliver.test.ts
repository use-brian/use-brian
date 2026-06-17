import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(),
  addSessionMessage: vi.fn(),
}))

vi.mock('@sidanclaw/channels', () => ({
  createSlackAdapter: vi.fn(),
  createTelegramAdapter: vi.fn(),
}))

import { deliverToChannel } from '../deliver.js'
import { findOrCreateSession, addSessionMessage } from '../../db/sessions.js'
import { createTelegramAdapter } from '@sidanclaw/channels'

const mockFindOrCreateSession = vi.mocked(findOrCreateSession)
const mockAddSessionMessage = vi.mocked(addSessionMessage)
const mockCreateTelegramAdapter = vi.mocked(createTelegramAdapter)

describe('[COMP:api/inter-assistant-deliver] deliverToChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAddSessionMessage.mockResolvedValue(undefined as never)
  })

  it('web delivery: creates notification session and adds message', async () => {
    mockFindOrCreateSession.mockResolvedValue({ id: 'ses_notif_1' } as never)

    await deliverToChannel({
      assistantId: 'a_1',
      userId: 'u_1',
      text: 'Hello from another assistant',
      channelType: 'web',
      channelId: 'default',
    })

    expect(mockFindOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: 'notification', channelId: 'notifications' }),
    )
    expect(mockAddSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'ses_notif_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from another assistant' }],
      }),
    )
  })

  it('strips model scaffolding / meta before persisting (leak regression)', async () => {
    mockFindOrCreateSession.mockResolvedValue({ id: 'ses_notif_1' } as never)

    await deliverToChannel({
      assistantId: 'a_1',
      userId: 'u_1',
      text: [
        "(This summary isn't shown to the user).",
        'Message body:',
        'You have a clear schedule today.',
      ].join('\n'),
      channelType: 'web',
      channelId: 'default',
    })

    const persisted = mockAddSessionMessage.mock.calls[0]![0] as {
      content: { type: string; text: string }[]
    }
    const text = persisted.content[0]!.text
    expect(text).toBe('You have a clear schedule today.')
    expect(text).not.toMatch(/isn't shown to the user/i)
    expect(text).not.toMatch(/Message body:/i)
  })

  it('session-based delivery persists to given sessionId', async () => {
    mockFindOrCreateSession.mockResolvedValue({ id: 'ses_notif_1' } as never)

    await deliverToChannel({
      assistantId: 'a_1',
      userId: 'u_1',
      text: 'Direct session message',
      sessionId: 'ses_existing_1',
      channelType: 'web',
      channelId: 'default',
    })

    // Persisted to both the notification session AND the original session
    expect(mockAddSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_existing_1' }),
    )
  })

  it('telegram delivery: sends via adapter when channelType is telegram', async () => {
    const mockSendMessage = vi.fn().mockResolvedValue('tg_msg_1')
    mockCreateTelegramAdapter.mockReturnValue({ sendMessage: mockSendMessage } as never)

    const integrationStore = {
      getCredentialsForAssistantSystem: vi.fn().mockResolvedValue({
        id: 'int_1',
        credentials: { bot_token: 'tok_123' },
      }),
    } as never

    await deliverToChannel({
      assistantId: 'a_1',
      userId: 'u_1',
      text: 'Telegram notification',
      channelType: 'telegram',
      channelId: 'chat_123',
      integrationStore,
    })

    expect(mockCreateTelegramAdapter).toHaveBeenCalled()
    expect(mockSendMessage).toHaveBeenCalledWith(
      'chat_123',
      expect.objectContaining({ text: 'Telegram notification' }),
    )
  })

  it('channel push failure is non-fatal — message still persisted', async () => {
    const mockSendMessage = vi.fn().mockRejectedValue(new Error('Telegram API down'))
    mockCreateTelegramAdapter.mockReturnValue({ sendMessage: mockSendMessage } as never)

    const integrationStore = {
      getCredentialsForAssistantSystem: vi.fn().mockResolvedValue({
        id: 'int_1',
        credentials: { bot_token: 'tok_456' },
      }),
    } as never

    // Should not throw despite adapter failure
    await expect(
      deliverToChannel({
        assistantId: 'a_1',
        userId: 'u_1',
        text: 'Should still persist',
        channelType: 'telegram',
        channelId: 'chat_456',
        integrationStore,
      }),
    ).resolves.not.toThrow()
  })

  it('no explicit channel: defaults to web notification, no outbound push', async () => {
    mockFindOrCreateSession.mockResolvedValue({ id: 'ses_web' } as never)

    await deliverToChannel({
      assistantId: 'a_1',
      userId: 'u_1',
      text: 'Auto-resolved delivery',
    })

    // channelType defaults to 'web' — persist to the notification session only.
    expect(mockFindOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: 'notification', channelId: 'notifications' }),
    )
    expect(mockAddSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_web', role: 'assistant' }),
    )
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
  })

  it('telegram delivery: falls back to default shared bot when assistant has no BYO integration', async () => {
    const mockSendMessage = vi.fn().mockResolvedValue('tg_msg_2')
    mockCreateTelegramAdapter.mockReturnValue({ sendMessage: mockSendMessage } as never)

    const integrationStore = {
      getCredentialsForAssistantSystem: vi.fn().mockResolvedValue(null),
    } as never

    await deliverToChannel({
      assistantId: 'a_1',
      userId: 'u_1',
      text: 'Default-bot notification',
      channelType: 'telegram',
      channelId: 'chat_999',
      integrationStore,
      defaultTelegramBotToken: 'shared_token',
    })

    expect(mockCreateTelegramAdapter).toHaveBeenCalledWith({ token: 'shared_token' })
    expect(mockSendMessage).toHaveBeenCalledWith(
      'chat_999',
      expect.objectContaining({ text: 'Default-bot notification' }),
    )
  })
})
