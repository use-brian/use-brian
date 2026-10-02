import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from '@use-brian/channels'
import { createWorkflowEventDispatcher } from '../../../core/src/workflow/event-trigger.js'
import type { ChannelType } from '../db/channels-store.js'
import {
  dispatchIncomingMessageEvent,
  normalizeIncomingMessageEvent,
  setMessageEventDispatcher,
} from '../message-events.js'

const channels = {
  telegram: true, slack: true, whatsapp: true, discord: true, email: true,
  msteams: true, wechat: true, custom: true, feishu: true,
} satisfies Record<ChannelType, true>

function incoming(channelType: ChannelType = 'slack'): IncomingMessage & { channelType: string; mentions?: string[] } {
  return {
    channelType, userId: 'actor', channelId: 'room', messageId: 'message',
    text: 'Production alert', isGroupChat: true, timestamp: 1700000000,
    mentions: ['oncall'], raw: { secret: 'never copy transport payloads' },
  }
}
const input = (channel: ChannelType = 'slack') => ({
  workspaceId: 'workspace', integrationId: 'integration', incoming: incoming(channel),
})

afterEach(() => {
  setMessageEventDispatcher(undefined)
  vi.restoreAllMocks()
})

describe('normalized channel workflow events', () => {
  it.each(Object.keys(channels) as ChannelType[])('normalizes and matches %s with the real dispatcher', async channel => {
    const event = normalizeIncomingMessageEvent(input(channel))
    expect(event).toMatchObject({
      source: { type: 'channel', channel: channel, channelIntegrationId: 'integration' },
      actorId: 'actor', channelId: 'room', text: 'Production alert',
      mentions: ['oncall'], isBot: false, isGroupChat: true,
      occurredAt: '2023-11-14T22:13:20.000Z',
      payload: { message_id: 'message', text: 'Production alert', user: 'actor', channel: 'room', channel_id: 'room' },
    })
    expect(event.payload).not.toHaveProperty('raw')
    const startWorkflowRun = vi.fn(async () => {})
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [{
        workflowId: 'workflow', workspaceId: 'workspace', sources: [{
          source: event.source,
          match: { keywords: ['alert'], fromActors: ['actor'], inChannels: ['room'], mentions: ['oncall'] },
        }],
      }],
      startWorkflowRun,
    })
    await dispatchIncomingMessageEvent(input(channel), dispatcher)
    expect(startWorkflowRun).toHaveBeenCalledOnce()
    expect(startWorkflowRun.mock.calls[0]).toEqual([expect.objectContaining({
      workspaceId: 'workspace', workflowId: 'workflow', input: expect.objectContaining({
        trigger: expect.objectContaining({ provider: channel, channelIntegrationId: 'integration' }),
        event: event.payload,
      }),
    })])
    await dispatchIncomingMessageEvent({ ...input(channel), isBot: true }, dispatcher)
    await dispatchIncomingMessageEvent({ ...input(channel), integrationId: 'other' }, dispatcher)
    expect(startWorkflowRun).toHaveBeenCalledOnce()
  })

  it.each(Object.keys(channels) as ChannelType[])('copies safe thread/reply/media metadata for %s', channel => {
    const event = normalizeIncomingMessageEvent({ ...input(channel), incoming: {
      ...incoming(channel), threadId: 'thread', replyToMessageId: 'parent', isEdit: true,
      mediaType: 'document', mediaMime: 'application/pdf', mediaName: 'report.pdf',
      mediaSizeBytes: 42, mediaDurationSec: 3, mediaUrl: 'https://secret-token',
      files: [{ name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 42, url: 'https://secret-file' }],
    } })
    expect(event.payload).toMatchObject({
      thread_id: 'thread', reply_to_message_id: 'parent', is_edit: true,
      media_type: 'document', media_mime: 'application/pdf', media_name: 'report.pdf',
      media_size_bytes: 42, media_duration_sec: 3,
      files: [{ name: 'report.pdf', mime_type: 'application/pdf', size_bytes: 42 }],
    })
    expect(JSON.stringify(event)).not.toContain('secret')
  })

  it('preserves provider payload extensions and trusted account metadata', () => {
    const event = normalizeIncomingMessageEvent({
      ...input(), providerAccountId: 'account', isBot: true,
      payload: { thread_ts: '123.45', text: 'legacy text', is_bot: true },
    })
    expect(event.providerAccountId).toBe('account')
    expect(event.payload).toMatchObject({ thread_ts: '123.45', text: 'legacy text', message_id: 'message', is_bot: true })
    expect(event.text).toBe('Production alert')
  })

  it('normalizes both adapter milliseconds and legacy seconds to the same occurrence time', () => {
    const seconds = normalizeIncomingMessageEvent(input())
    const millis = normalizeIncomingMessageEvent({ ...input(), incoming: { ...incoming(), timestamp: 1700000000000 } })
    expect(millis.occurredAt).toBe(seconds.occurredAt)
    expect(millis.occurredAt).toBe('2023-11-14T22:13:20.000Z')
  })

  it('allows media-only messages and omits invalid occurrence times', () => {
    const event = normalizeIncomingMessageEvent({ ...input(), incoming: {
      ...incoming(), text: '', timestamp: NaN, messageId: undefined, mentions: undefined,
    } })
    expect(event.text).toBeNull()
    expect(event.payload.message_id).toBeNull()
    expect(event.mentions).toEqual([])
    expect(event).not.toHaveProperty('occurredAt')
  })

  it('uses the boot dispatcher unless explicitly overridden, and supports teardown', async () => {
    const global = { dispatch: vi.fn(async () => {}) }
    const explicit = { dispatch: vi.fn(async () => {}) }
    await dispatchIncomingMessageEvent(input())
    setMessageEventDispatcher(global)
    await dispatchIncomingMessageEvent(input())
    await dispatchIncomingMessageEvent(input(), explicit)
    setMessageEventDispatcher(undefined)
    await dispatchIncomingMessageEvent(input())
    expect(global.dispatch).toHaveBeenCalledOnce()
    expect(explicit.dispatch).toHaveBeenCalledOnce()
  })

  it.each(['sync', 'async'])('isolates %s dispatcher failures', async kind => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('unavailable')
    const dispatcher = { dispatch: vi.fn(() => {
      if (kind === 'sync') throw error
      return Promise.reject(error)
    }) }
    await expect(dispatchIncomingMessageEvent(input(), dispatcher)).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(expect.any(String), error)
  })
})
