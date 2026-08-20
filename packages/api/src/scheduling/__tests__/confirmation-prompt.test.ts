/**
 * Unit tests for the deferred-confirmation prompt delivery module
 * (Phase 2 cutover §E). Component tag: [COMP:scheduling/confirmation-prompt].
 *
 * Pure unit tests — the `@use-brian/channels` adapters are mocked, so no
 * network. Covers the BYO → shared-bot token resolution order and the
 * best-effort delivery contract: a send failure is logged and swallowed,
 * never thrown (the confirmation still times out gracefully).
 *
 * Spec: docs/architecture/engine/scheduled-jobs.md → "Deferred confirmations".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The adapters are mocked; the Slack ERROR translator is not — the point of
// these tests is that a real `SlackApiError` renders as model-actionable copy.
vi.mock('@use-brian/channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@use-brian/channels')>()),
  createSlackAdapter: vi.fn(),
  createTelegramAdapter: vi.fn(),
  createWhatsAppAdapter: vi.fn(),
  createCustomAdapter: vi.fn(),
}))

import { createCustomAdapter, createSlackAdapter, createTelegramAdapter, SlackApiError } from '@use-brian/channels'
import type { ToolConfirmationRequest } from '@use-brian/core'

import { resolveTelegramBotToken, sendConfirmationPrompt } from '../confirmation-prompt.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'

const mockCreateTelegramAdapter = vi.mocked(createTelegramAdapter)
const mockCreateSlackAdapter = vi.mocked(createSlackAdapter)
const mockCreateCustomAdapter = vi.mocked(createCustomAdapter)

/** The slice of the channel adapter's `sendMessage` this module exercises. */
type SendMessage = (
  channelId: string,
  msg: { text: string; actions?: { id: string; label: string; data: string }[] },
) => Promise<void>

/** Minimal `ChannelIntegrationStore` — only the one method this module reads. */
function fakeIntegrationStore(botToken: string | null): ChannelIntegrationStore {
  return {
    getCredentialsForAssistantSystem: vi.fn(async () =>
      botToken === null
        ? null
        : ({ credentials: { bot_token: botToken }, botUserId: 'U1' } as never),
    ),
    getCredentialsForAssistantIntegrationSystem: vi.fn(async () =>
      botToken === null
        ? null
        : ({ credentials: { bot_token: botToken }, botUserId: 'U1' } as never),
    ),
  } as unknown as ChannelIntegrationStore
}

const req: ToolConfirmationRequest = {
  toolCallId: 'tc_1',
  toolName: 'gmailSendMessage',
  serverName: 'gmail',
  input: { to: 'a@b.com' },
  classification: null,
  description: 'Send an email',
}

describe('[COMP:scheduling/confirmation-prompt] resolveTelegramBotToken', () => {
  it('returns the BYO bot token when a telegram integration exists', async () => {
    const token = await resolveTelegramBotToken('a_1', {
      integrationStore: fakeIntegrationStore('byo-tok'),
      defaultTelegramBotToken: 'shared-tok',
    })
    expect(token).toBe('byo-tok')
  })

  it('falls back to the shared bot token when no integration exists', async () => {
    const token = await resolveTelegramBotToken('a_1', {
      integrationStore: fakeIntegrationStore(null),
      defaultTelegramBotToken: 'shared-tok',
    })
    expect(token).toBe('shared-tok')
  })

  it('falls back to the shared token when no integration store is wired', async () => {
    const token = await resolveTelegramBotToken('a_1', {
      defaultTelegramBotToken: 'shared-tok',
    })
    expect(token).toBe('shared-tok')
  })

  it('returns undefined when neither BYO nor shared token is configured', async () => {
    const token = await resolveTelegramBotToken('a_1', {
      integrationStore: fakeIntegrationStore(null),
    })
    expect(token).toBeUndefined()
  })

  it('resolves an explicitly selected integration without shared-bot fallback', async () => {
    const store = fakeIntegrationStore('selected-tok')
    const token = await resolveTelegramBotToken(
      'a_1',
      { integrationStore: store, defaultTelegramBotToken: 'shared-tok' },
      '00000000-0000-4000-8000-000000000001',
      '-100555:topic:42',
      'ws-1',
    )

    expect(token).toBe('selected-tok')
    expect(store.getCredentialsForAssistantIntegrationSystem).toHaveBeenCalledWith(
      'ws-1',
      'a_1',
      '00000000-0000-4000-8000-000000000001',
      'telegram',
      '-100555:topic:42',
    )
  })

  it('fails closed when an explicit integration has no authoritative workspace scope', async () => {
    const store = fakeIntegrationStore('foreign-tok')
    const token = await resolveTelegramBotToken(
      'a_1',
      { integrationStore: store, defaultTelegramBotToken: 'shared-tok' },
      '00000000-0000-4000-8000-000000000001',
      '-100555',
    )
    expect(token).toBeUndefined()
    expect(store.getCredentialsForAssistantSystem).not.toHaveBeenCalled()
    expect(store.getCredentialsForAssistantIntegrationSystem).not.toHaveBeenCalled()
  })
})

describe('[COMP:scheduling/confirmation-prompt] sendConfirmationPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends a telegram prompt with Allow / Deny actions', async () => {
    const sendMessage = vi.fn<SendMessage>(async () => {})
    mockCreateTelegramAdapter.mockReturnValue({ sendMessage } as never)

    await sendConfirmationPrompt(
      { assistantId: 'a_1', channelType: 'telegram', channelId: 'c_1' },
      req,
      { defaultTelegramBotToken: 'shared-tok' },
    )

    expect(sendMessage).toHaveBeenCalledOnce()
    const msg = sendMessage.mock.calls[0][1]
    expect(msg.actions?.map((a) => a.id)).toEqual(['allow', 'deny'])
  })

  it('adds Always Allow / Always Deny when allowPersistentApproval is set', async () => {
    const sendMessage = vi.fn<SendMessage>(async () => {})
    mockCreateTelegramAdapter.mockReturnValue({ sendMessage } as never)

    await sendConfirmationPrompt(
      { assistantId: 'a_1', channelType: 'telegram', channelId: 'c_1' },
      { ...req, allowPersistentApproval: true },
      { defaultTelegramBotToken: 'shared-tok' },
    )

    const msg = sendMessage.mock.calls[0][1]
    expect(msg.actions?.map((a) => a.id)).toEqual(['allow', 'deny', 'always', 'never'])
  })

  it('enqueues a text confirmation on the selected custom-channel bridge', async () => {
    const sendMessage = vi.fn<SendMessage>(async () => {})
    mockCreateCustomAdapter.mockReturnValue({ sendMessage } as never)
    const integrationStore = fakeIntegrationStore('unused')
    vi.mocked(integrationStore.getCredentialsForAssistantIntegrationSystem).mockResolvedValueOnce({
      channelId: 'bridge-channel-1',
      credentials: {},
    } as never)
    const enqueue = vi.fn(async () => 'outbox-1')

    const result = await sendConfirmationPrompt(
      {
        workspaceId: 'ws-1',
        assistantId: 'a_1',
        channelType: 'custom',
        channelId: 'peer-1',
        channelIntegrationId: 'integration-1',
      },
      { ...req, allowPersistentApproval: true },
      {
        integrationStore,
        customChannelStore: { enqueue },
      },
    )

    expect(result).toEqual({ delivered: true, channelType: 'custom' })
    expect(integrationStore.getCredentialsForAssistantIntegrationSystem).toHaveBeenCalledWith(
      'ws-1', 'a_1', 'integration-1', 'custom', 'peer-1',
    )
    expect(mockCreateCustomAdapter).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith('peer-1', {
      text: expect.stringContaining('Reply: yes / no / always / never'),
    })
  })

  it('does not build an adapter for a telegram target with no resolvable token', async () => {
    await sendConfirmationPrompt(
      { assistantId: 'a_1', channelType: 'telegram', channelId: 'c_1' },
      req,
      {},
    )
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
  })

  it('is a no-op for a web target (persist-only) and reports it delivered', async () => {
    await expect(
      sendConfirmationPrompt(
        { assistantId: 'a_1', channelType: 'web', channelId: 'c_1' },
        req,
        { defaultTelegramBotToken: 'shared-tok' },
      ),
    ).resolves.toEqual({ delivered: true, channelType: 'web' })
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
  })

  it('swallows a delivery failure — best-effort, never throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockCreateTelegramAdapter.mockReturnValue({
      sendMessage: vi.fn(async () => {
        throw new Error('telegram 500')
      }),
    } as never)

    const result = await sendConfirmationPrompt(
      { assistantId: 'a_1', channelType: 'telegram', channelId: 'c_1' },
      req,
      { defaultTelegramBotToken: 'shared-tok' },
    )

    expect(result.delivered).toBe(false)
    // WHAT did not happen + the consequence, not just the raw provider text.
    expect(result.reason).toContain('was NOT delivered to telegram `c_1`')
    expect(result.reason).toContain('telegram 500')
    expect(result.reason).toMatch(/time out unanswered/)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('a Slack push failure is translated, not passed through as the bare code', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockCreateSlackAdapter.mockReturnValue({
      sendMessage: vi.fn(async () => {
        throw new SlackApiError({
          method: 'chat.postMessage',
          code: 'channel_not_found',
          target: { channel: 'C0BB4AK5BHB' },
        })
      }),
    } as never)

    const result = await sendConfirmationPrompt(
      { assistantId: 'a_1', channelType: 'slack', channelId: 'C0BB4AK5BHB' },
      req,
      { integrationStore: fakeIntegrationStore('xoxb-tok') },
    )

    expect(result.delivered).toBe(false)
    expect(result.reason).toContain('confirmation prompt for `gmailSendMessage` was NOT delivered to slack `C0BB4AK5BHB`')
    // describeSlackError's diagnosis + discovery pointer, not `channel_not_found` alone.
    expect(result.reason).toMatch(/no conversation .* that this bot can see/)
    expect(result.reason).toContain('`listSlackChannels`')
    expect(result.reason).toMatch(/time out unanswered/)
    errSpy.mockRestore()
  })

  it('a Slack target with no connected workspace names the missing surface and the remedy', async () => {
    const result = await sendConfirmationPrompt(
      { assistantId: 'a_1', channelType: 'slack', channelId: 'C0BB4AK5BHB' },
      req,
      { integrationStore: fakeIntegrationStore(null) },
    )

    expect(result).toMatchObject({ delivered: false, channelType: 'slack' })
    expect(result.reason).toMatch(/no connected Slack workspace/)
    expect(result.reason).toMatch(/Studio → Channels → Slack/)
    expect(result.reason).toMatch(/time out unanswered/)
    expect(mockCreateSlackAdapter).not.toHaveBeenCalled()
  })

  it('a telegram target with no resolvable bot says the user was never asked', async () => {
    const result = await sendConfirmationPrompt(
      { assistantId: 'a_1', channelType: 'telegram', channelId: 'c_1' },
      req,
      {},
    )

    expect(result).toMatchObject({ delivered: false, channelType: 'telegram' })
    expect(result.reason).toMatch(/no connected Telegram bot/)
    expect(result.reason).toMatch(/the user was never asked/)
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
  })
})
