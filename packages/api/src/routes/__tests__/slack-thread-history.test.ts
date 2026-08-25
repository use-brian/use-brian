/**
 * [COMP:api/slack-route] Server-scoped Slack thread recovery.
 *
 * A provider thread can remain visibly intact while Brian's session key
 * changes. These tests pin both recovery lanes: the model-visible read tool
 * cannot choose a channel/thread, and a new or empty exact session receives a
 * transient provider snapshot without turning it into authored DB history.
 */

import { describe, expect, it, vi } from 'vitest'
import { SlackApiError } from '@use-brian/channels'
import type { ToolContext } from '@use-brian/core'
import {
  createSlackReadCurrentThreadTool,
  formatSlackThreadSnapshot,
  loadSlackThreadBootstrapContext,
  readBoundSlackThread,
  type SlackCurrentThreadRead,
} from '../slack.js'

const CHANNEL = 'C0THREAD01'
const ROOT_TS = '1723800000.000100'
const CURRENT_TS = '1723800002.000100'
const ctx = { userId: 'user-test', sessionId: 'session-test', channelType: 'slack' } as ToolContext

function fullRead(): SlackCurrentThreadRead {
  return {
    coverage: 'full_thread',
    source: 'slack_replies',
    truncated: false,
    messages: [
      { type: 'message', bot_id: 'B0BOT', text: 'Create a daily summary?', ts: ROOT_TS },
      { type: 'message', user: 'U0USER', text: 'Yes, do that', ts: CURRENT_TS, thread_ts: ROOT_TS },
    ],
  }
}

describe('[COMP:api/slack-route] bound Slack thread reader', () => {
  it('uses the server-provided channel and root for a full provider read', async () => {
    const conversationsReplies = vi.fn(async () => ({
      messages: fullRead().messages,
      truncated: false,
    }))
    const conversationsHistory = vi.fn()
    const result = await readBoundSlackThread({
      api: { conversationsReplies, conversationsHistory } as never,
      channelId: CHANNEL,
      threadTs: ROOT_TS,
      limit: 50,
    })

    expect(conversationsReplies).toHaveBeenCalledWith(CHANNEL, ROOT_TS, { limit: 50 })
    expect(conversationsHistory).not.toHaveBeenCalled()
    expect(result.coverage).toBe('full_thread')
    expect(result.messages).toHaveLength(2)
  })

  it('falls back to the exact provider root when Slack denies full replies to the bot token', async () => {
    const conversationsReplies = vi.fn(async () => {
      throw new SlackApiError({
        method: 'conversations.replies',
        code: 'not_allowed_token_type',
        target: { channel: CHANNEL, ts: ROOT_TS },
      })
    })
    const conversationsHistory = vi.fn(async () => ({
      messages: [
        { type: 'message', bot_id: 'B0BOT', text: 'Create a daily summary?', ts: ROOT_TS },
      ],
    }))

    const result = await readBoundSlackThread({
      api: { conversationsReplies, conversationsHistory } as never,
      channelId: CHANNEL,
      threadTs: ROOT_TS,
    })

    expect(conversationsHistory).toHaveBeenCalledWith(CHANNEL, {
      oldest: ROOT_TS,
      latest: ROOT_TS,
      inclusive: true,
      limit: 1,
    })
    expect(result.coverage).toBe('root_only')
    expect(result.source).toBe('slack_history')
    expect(result.truncated).toBe(true)
    expect(result.providerWarning).toMatch(/full reply-thread read/i)
  })

  it('uses only an exact locally stored root when both provider reads are unavailable', async () => {
    const conversationsReplies = vi.fn(async () => {
      throw new SlackApiError({
        method: 'conversations.replies',
        code: 'not_allowed_token_type',
      })
    })
    const conversationsHistory = vi.fn(async () => {
      throw new SlackApiError({ method: 'conversations.history', code: 'missing_scope' })
    })
    const findStoredRoot = vi.fn(async () => ({
      role: 'assistant',
      content: [{ type: 'text', text: 'Create a daily summary?' }],
    }))

    const result = await readBoundSlackThread({
      api: { conversationsReplies, conversationsHistory } as never,
      channelId: CHANNEL,
      threadTs: ROOT_TS,
      findStoredRoot,
    })

    expect(findStoredRoot).toHaveBeenCalledOnce()
    expect(result.coverage).toBe('root_only')
    expect(result.source).toBe('stored_message')
    expect(result.messages[0]).toMatchObject({
      ts: ROOT_TS,
      text: 'Create a daily summary?',
      authorLabel: 'Assistant (stored visible message)',
    })
  })

  it('does not hide a transient provider failure behind a root-only fallback', async () => {
    const conversationsReplies = vi.fn(async () => {
      throw new SlackApiError({
        method: 'conversations.replies',
        code: 'ratelimited',
        retryAfterSec: 3,
      })
    })
    const conversationsHistory = vi.fn()
    const findStoredRoot = vi.fn()

    await expect(readBoundSlackThread({
      api: { conversationsReplies, conversationsHistory } as never,
      channelId: CHANNEL,
      threadTs: ROOT_TS,
      findStoredRoot,
    })).rejects.toMatchObject({ code: 'ratelimited' })
    expect(conversationsHistory).not.toHaveBeenCalled()
    expect(findStoredRoot).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/slack-route] readCurrentSlackThread tool', () => {
  it('accepts only a bounded limit and has no channel/thread widening input', async () => {
    const readThread = vi.fn(async () => fullRead())
    const tool = createSlackReadCurrentThreadTool({ readThread })
    const parsed = tool.inputSchema.parse({
      limit: 12,
      channelId: 'C0OTHER01',
      threadTs: '999.999',
    })

    expect(parsed).toEqual({ limit: 12 })
    const result = await tool.execute(parsed, ctx)
    expect(readThread).toHaveBeenCalledWith(12)
    expect(result.isError).toBeFalsy()
    expect(String(result.data)).toContain('Create a daily summary?')
  })

  it('returns an explicit error instead of translating a failed read into an empty thread', async () => {
    const tool = createSlackReadCurrentThreadTool({
      readThread: vi.fn(async () => {
        throw new SlackApiError({
          method: 'conversations.replies',
          code: 'missing_scope',
          needed: 'channels:history',
        })
      }),
    })

    const result = await tool.execute({}, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/history is unknown/i)
    expect(String(result.data)).toContain('channels:history')
    expect(String(result.data)).toMatch(/Do not claim the thread is empty/i)
  })
})

describe('[COMP:api/slack-route] empty-session Slack bootstrap', () => {
  it('hydrates a missing exact session and excludes the current inbound message', async () => {
    const readThread = vi.fn(async () => fullRead())
    const result = await loadSlackThreadBootstrapContext({
      findSession: vi.fn(async () => null),
      listSessionMessages: vi.fn(),
      readThread,
      incomingMessageId: CURRENT_TS,
    })

    expect(readThread).toHaveBeenCalledOnce()
    expect(result.context).toContain('# Current Slack thread')
    expect(result.context).toContain('Create a daily summary?')
    expect(result.context).not.toContain('Yes, do that')
  })

  it('hydrates an existing but empty exact session', async () => {
    const readThread = vi.fn(async () => fullRead())
    const result = await loadSlackThreadBootstrapContext({
      findSession: vi.fn(async () => ({ id: 'empty-session' })),
      listSessionMessages: vi.fn(async () => []),
      readThread,
      incomingMessageId: CURRENT_TS,
    })

    expect(readThread).toHaveBeenCalledOnce()
    expect(result.context).toContain('Create a daily summary?')
  })

  it('does not fetch automatically once the exact session has any stored message', async () => {
    const readThread = vi.fn(async () => fullRead())
    const result = await loadSlackThreadBootstrapContext({
      findSession: vi.fn(async () => ({ id: 'established-session' })),
      listSessionMessages: vi.fn(async () => [{ role: 'user' }]),
      readThread,
      incomingMessageId: CURRENT_TS,
    })

    expect(readThread).not.toHaveBeenCalled()
    expect(result).toEqual({ context: null, read: null })
  })

  it('marks a root-only snapshot as partial and keeps it out of the current message', () => {
    const context = formatSlackThreadSnapshot({
      coverage: 'root_only',
      source: 'stored_message',
      truncated: true,
      providerWarning: 'Full provider replies were unavailable.',
      messages: [
        { type: 'message', text: 'Earlier proposal', ts: ROOT_TS, authorLabel: 'Assistant' },
        { type: 'message', text: 'Current reply', ts: CURRENT_TS, user: 'U0USER' },
      ],
    }, { excludeMessageTs: CURRENT_TS })

    expect(context).toMatch(/root message only/i)
    expect(context).toContain('Earlier proposal')
    expect(context).not.toContain('Current reply')
    expect(context).toContain('Provider note:')
  })
})
