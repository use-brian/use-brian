/**
 * [COMP:api/discord-route] `reactToMessage` failure copy.
 *
 * Discord's reaction endpoint fails in four ways that need four different
 * responses from the model, and the old copy (`Failed to react with 👍`)
 * collapsed all of them: a missing bot permission (an admin has to act — never
 * retryable), an unknown message or emoji (the argument is wrong — retrying
 * the same one is pointless), and a 429 (genuinely transient — retry once).
 * Discord distinguishes them by its numeric `code`, not by status alone: a 404
 * is "message gone" OR "emoji not a thing".
 *
 * These pin the D6 contract (docs/architecture/engine/tool-executor.md →
 * "Failure copy"): name the message id + channel, say the message is still
 * unreacted, translate the Discord code, and give the retry verdict.
 */

import { describe, expect, it, vi } from 'vitest'
import { DiscordApiError } from '@use-brian/channels'
import type { ToolContext } from '@use-brian/core'
import { createDiscordReactToMessageTool } from '../discord.js'

const ctx = { userId: 'u1', sessionId: 's1', channelType: 'discord' } as ToolContext
const CHANNEL = '1122334455667788'
const MESSAGE = '9988776655443322'

function toolWith(reactToMessage?: ReturnType<typeof vi.fn>) {
  return createDiscordReactToMessageTool({
    adapter: reactToMessage ? { reactToMessage } : {},
    channelId: CHANNEL,
    messageId: MESSAGE,
  })
}

function throwing(status: number, body: { message?: string; code?: number }) {
  return vi.fn(async () => {
    throw new DiscordApiError('PUT /channels/x/messages/y/reactions/z/@me', status, body)
  })
}

describe('[COMP:api/discord-route] reactToMessage failure copy', () => {
  it('reports a successful reaction plainly', async () => {
    const react = vi.fn(async () => {})
    const result = await toolWith(react).execute({ emoji: '👍' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(react).toHaveBeenCalledWith(CHANNEL, MESSAGE, '👍')
  })

  it('a turn with no message id says the tool cannot work here at all', async () => {
    const tool = createDiscordReactToMessageTool({
      adapter: { reactToMessage: vi.fn() },
      channelId: CHANNEL,
      messageId: undefined,
    })
    const data = String((await tool.execute({ emoji: '👀' }, ctx)).data)
    expect(data).toMatch(/did not arrive with a Discord message id/i)
    expect(data).toMatch(/Acknowledge in text instead/i)
    expect(data).toMatch(/however it is called/i)
  })

  // `adapter.reactToMessage?.()` used to make a missing capability look like a
  // successful reaction.
  it('an adapter with no reaction capability is a failure, not a silent success', async () => {
    const result = await toolWith(undefined).execute({ emoji: '🔥' }, ctx)
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toContain(MESSAGE)
    expect(data).toContain(CHANNEL)
    expect(data).toMatch(/exposes no reaction capability/i)
    expect(data).toMatch(/fail the same way/i)
  })

  it('names the missing permission on a 50013, and rules the retry out', async () => {
    const react = throwing(403, { message: 'Missing Permissions', code: 50013 })
    const result = await toolWith(react).execute({ emoji: '👍' }, ctx)
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toContain(MESSAGE)
    expect(data).toContain(CHANNEL)
    expect(data).toMatch(/still unreacted/i)
    expect(data).toContain('Add Reactions')
    expect(data).toContain('Read Message History')
    expect(data).toMatch(/server admin must grant/i)
    expect(data).toMatch(/retrying will not help/i)
    expect(data).toMatch(/do not tell the user you reacted/i)
  })

  it('separates an unknown MESSAGE from an unknown EMOJI on the same 404 status', async () => {
    const gone = String(
      (await toolWith(throwing(404, { message: 'Unknown Message', code: 10008 })).execute(
        { emoji: '👍' },
        ctx,
      )).data,
    )
    expect(gone).toMatch(/Unknown Message, code 10008/)
    expect(gone).toMatch(/deleted, or the message id does not belong to that channel/i)
    expect(gone).toMatch(/keep failing/i)

    const emoji = String(
      (await toolWith(throwing(404, { message: 'Unknown Emoji', code: 10014 })).execute(
        { emoji: ':party_blob:' },
        ctx,
      )).data,
    )
    expect(emoji).toMatch(/Unknown Emoji, code 10014/)
    expect(emoji).toMatch(/single standard unicode emoji/i)
    expect(emoji).toMatch(/`name:id`/)
    expect(emoji).toMatch(/keep failing/i)
  })

  it('marks a 429 transient — the one Discord failure a retry can clear', async () => {
    const data = String(
      (await toolWith(throwing(429, { message: 'You are being rate limited.' })).execute(
        { emoji: '👍' },
        ctx,
      )).data,
    )
    expect(data).toMatch(/rate-limited/i)
    expect(data).toMatch(/transient/i)
    expect(data).toMatch(/retry once/i)
    expect(data).toMatch(/Do not loop/i)
  })

  it('marks a 5xx server-side rather than blaming the arguments', async () => {
    const data = String(
      (await toolWith(throwing(503, { message: 'Service Unavailable' })).execute(
        { emoji: '👍' },
        ctx,
      )).data,
    )
    expect(data).toMatch(/failed server-side/i)
    expect(data).toMatch(/Nothing about the request is wrong/i)
    expect(data).toMatch(/retry once/i)
  })

  it('a non-Discord throw still produces a framed failure with the target', async () => {
    const react = vi.fn(async () => {
      throw new Error('fetch failed')
    })
    const data = String((await toolWith(react).execute({ emoji: '❤️' }, ctx)).data)
    expect(data).toContain('fetch failed')
    expect(data).toContain(MESSAGE)
    expect(data).toMatch(/still unreacted/i)
    expect(data).toMatch(/fail the same way/i)
  })
})
