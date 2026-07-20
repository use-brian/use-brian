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

vi.mock('@use-brian/channels', () => ({
  createSlackAdapter: vi.fn(),
  createTelegramAdapter: vi.fn(),
  createWhatsAppAdapter: vi.fn(),
}))

import { createTelegramAdapter } from '@use-brian/channels'
import type { ToolConfirmationRequest } from '@use-brian/core'

import { resolveTelegramBotToken, sendConfirmationPrompt } from '../confirmation-prompt.js'
import type { ChannelIntegrationStore } from '../../db/channel-integrations.js'

const mockCreateTelegramAdapter = vi.mocked(createTelegramAdapter)

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

  it('does not build an adapter for a telegram target with no resolvable token', async () => {
    await sendConfirmationPrompt(
      { assistantId: 'a_1', channelType: 'telegram', channelId: 'c_1' },
      req,
      {},
    )
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
  })

  it('is a no-op for a web target (persist-only)', async () => {
    await expect(
      sendConfirmationPrompt(
        { assistantId: 'a_1', channelType: 'web', channelId: 'c_1' },
        req,
        { defaultTelegramBotToken: 'shared-tok' },
      ),
    ).resolves.toBeUndefined()
    expect(mockCreateTelegramAdapter).not.toHaveBeenCalled()
  })

  it('swallows a delivery failure — best-effort, never throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockCreateTelegramAdapter.mockReturnValue({
      sendMessage: vi.fn(async () => {
        throw new Error('telegram 500')
      }),
    } as never)

    await expect(
      sendConfirmationPrompt(
        { assistantId: 'a_1', channelType: 'telegram', channelId: 'c_1' },
        req,
        { defaultTelegramBotToken: 'shared-tok' },
      ),
    ).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
