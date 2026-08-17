import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(),
  addSessionMessage: vi.fn(),
}))

// Adapters mocked, Slack error translation real — the failure copy under test
// is `describeSlackError`'s actual output.
vi.mock('@use-brian/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@use-brian/channels')>()),
  createSlackAdapter: vi.fn(),
  createTelegramAdapter: vi.fn(),
}))

import { deliverToChannel } from '../deliver.js'
import { findOrCreateSession, addSessionMessage } from '../../db/sessions.js'
import { createSlackAdapter, createTelegramAdapter, SlackApiError } from '@use-brian/channels'

const mockFindOrCreateSession = vi.mocked(findOrCreateSession)
const mockAddSessionMessage = vi.mocked(addSessionMessage)
const mockCreateTelegramAdapter = vi.mocked(createTelegramAdapter)
const mockCreateSlackAdapter = vi.mocked(createSlackAdapter)

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

  it('a Slack push failure is reported with the diagnosis, not the bare code', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockFindOrCreateSession.mockResolvedValue({ id: 'ses_notif_1' } as never)
    mockCreateSlackAdapter.mockReturnValue({
      sendMessage: vi.fn(async () => {
        throw new SlackApiError({
          method: 'chat.postMessage',
          code: 'not_in_channel',
          target: { channel: 'C0BB4AK5BHB' },
        })
      }),
    } as never)

    const integrationStore = {
      getCredentialsForAssistantSystem: vi.fn().mockResolvedValue({
        id: 'int_1',
        credentials: { bot_token: 'xoxb-tok' },
        botUserId: 'U1',
      }),
    } as never

    const result = await deliverToChannel({
      assistantId: 'a_1',
      userId: 'u_1',
      text: 'Relayed answer',
      channelType: 'slack',
      channelId: 'C0BB4AK5BHB',
      integrationStore,
    })

    expect(result.delivered).toBe(false)
    expect(result.reason).toContain('NOT posted to Slack channel `C0BB4AK5BHB`')
    expect(result.reason).toMatch(/not a member of `C0BB4AK5BHB`/)
    expect(result.reason).toContain('/invite @<bot>')
    expect(result.reason).toMatch(/do not tell them it was sent to slack/)
    // The salvage claim is only made because the notification fallback landed.
    expect(mockAddSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_notif_1' }),
    )
    errSpy.mockRestore()
  })

  it('a Slack target with no connected workspace does not look like a sent message', async () => {
    const integrationStore = {
      getCredentialsForAssistantSystem: vi.fn().mockResolvedValue(null),
    } as never

    const result = await deliverToChannel({
      assistantId: 'a_1',
      userId: 'u_1',
      text: 'Relayed answer',
      channelType: 'slack',
      channelId: 'C0BB4AK5BHB',
      integrationStore,
    })

    expect(result).toMatchObject({ delivered: false, channelType: 'slack' })
    expect(result.reason).toMatch(/no connected Slack workspace/)
    expect(result.reason).toMatch(/the message was not delivered/)
    expect(result.reason).toMatch(/Studio → Channels → Slack/)
    expect(mockCreateSlackAdapter).not.toHaveBeenCalled()
  })

  it('a successful web delivery reports delivered: true', async () => {
    mockFindOrCreateSession.mockResolvedValue({ id: 'ses_notif_1' } as never)
    await expect(
      deliverToChannel({ assistantId: 'a_1', userId: 'u_1', text: 'hi', channelType: 'web' }),
    ).resolves.toEqual({ delivered: true, channelType: 'web' })
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
