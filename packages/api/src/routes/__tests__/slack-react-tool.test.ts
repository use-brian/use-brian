/**
 * [COMP:api/slack-route] `reactToMessage` failure copy.
 *
 * The Slack reaction tool is the one place a channel route hands the model a
 * tool result of its own. It used to answer every failure with
 * `Failed to react with :x:` — no channel, no message ts, no diagnosis, no
 * retry verdict — which is the worst shape available here: the model cannot
 * tell "the bot is not in the channel" (never retryable) from "Slack
 * rate-limited us" (retry once), and a silent miss reads to the user as a
 * dropped acknowledgement.
 *
 * These pin the D6 contract (docs/architecture/engine/tool-executor.md →
 * "Failure copy"): name the message ts + channel, say the message is still
 * unreacted, carry Slack's own diagnosis through `describeSlackError`, and
 * forbid the model from claiming it reacted.
 *
 * Note: this file deliberately does NOT mock `@use-brian/channels` (unlike
 * `slack.test.ts`), because the real `describeSlackError` translation is
 * half of what is under test.
 */

import { describe, expect, it, vi } from 'vitest'
import { SlackApiError } from '@use-brian/channels'
import type { ToolContext } from '@use-brian/core'
import { createSlackReactToMessageTool } from '../slack.js'

const ctx = { userId: 'u1', sessionId: 's1', channelType: 'slack' } as ToolContext
const CHANNEL = 'C0123ABCD'
const TS = '1723800000.000100'

function toolWith(reactToMessage?: ReturnType<typeof vi.fn>) {
  return createSlackReactToMessageTool({
    adapter: reactToMessage ? { reactToMessage } : {},
    channelId: CHANNEL,
    messageId: TS,
  })
}

describe('[COMP:api/slack-route] reactToMessage failure copy', () => {
  it('reports a successful reaction plainly', async () => {
    const react = vi.fn(async () => {})
    const result = await toolWith(react).execute({ emoji: 'thumbsup' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(react).toHaveBeenCalledWith(CHANNEL, TS, 'thumbsup')
  })

  it('a turn with no message ts says the tool cannot work here at all', async () => {
    const tool = createSlackReactToMessageTool({
      adapter: { reactToMessage: vi.fn() },
      channelId: CHANNEL,
      messageId: undefined,
    })
    const result = await tool.execute({ emoji: 'eyes' }, ctx)
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toMatch(/No reaction was added/i)
    expect(data).toMatch(/did not arrive with a Slack message timestamp/i)
    expect(data).toMatch(/Acknowledge in text instead/i)
    expect(data).toMatch(/however it is called/i)
  })

  // The adapter method is optional on the type, and the old code called it
  // through `?.` — so an adapter without it returned "Reacted with :x:" for a
  // reaction that was never sent. The gate now names the missing capability.
  it('an adapter with no reaction capability is a failure, not a silent success', async () => {
    const result = await toolWith(undefined).execute({ emoji: 'fire' }, ctx)
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toContain(TS)
    expect(data).toContain(CHANNEL)
    expect(data).toMatch(/exposes no reaction capability/i)
    expect(data).toMatch(/never sent/i)
    expect(data).toMatch(/do not tell the user you reacted/i)
    expect(data).toMatch(/fail the same way/i)
  })

  it('translates a Slack API code through describeSlackError, keeping the target in the frame', async () => {
    const react = vi.fn(async () => {
      throw new SlackApiError({
        method: 'reactions.add',
        code: 'not_in_channel',
        target: { channel: CHANNEL, ts: TS },
      })
    })
    const result = await toolWith(react).execute({ emoji: 'heart' }, ctx)
    expect(result.isError).toBe(true)
    const data = String(result.data)
    // WHAT — the emoji, the ts, the channel.
    expect(data).toContain(':heart:')
    expect(data).toContain(TS)
    expect(data).toContain(CHANNEL)
    expect(data).toMatch(/still unreacted/i)
    // WHY + NEXT STEP come from the shared Slack translator, not a raw code.
    expect(data).toMatch(/not a member of/i)
    expect(data).toMatch(/\/invite @<bot>/)
    expect(data).not.toMatch(/^Failed to react/)
  })

  it('keeps a transient Slack code retryable and a permission code not', async () => {
    const rateLimited = vi.fn(async () => {
      throw new SlackApiError({
        method: 'reactions.add',
        code: 'ratelimited',
        retryAfterSec: 3,
        target: { channel: CHANNEL, ts: TS },
      })
    })
    const transient = String((await toolWith(rateLimited).execute({ emoji: 'eyes' }, ctx)).data)
    expect(transient).toMatch(/transient/i)
    expect(transient).toMatch(/retry the same call once/i)
    expect(transient).toMatch(/Do not loop/i)

    const missingScope = vi.fn(async () => {
      throw new SlackApiError({
        method: 'reactions.add',
        code: 'missing_scope',
        needed: 'reactions:write',
        target: { channel: CHANNEL, ts: TS },
      })
    })
    const permanent = String((await toolWith(missingScope).execute({ emoji: 'eyes' }, ctx)).data)
    expect(permanent).toContain('reactions:write')
    expect(permanent).toMatch(/retrying will not help/i)
  })

  it('a non-Slack throw still produces a framed failure, never a bare message', async () => {
    const react = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const result = await toolWith(react).execute({ emoji: '100' }, ctx)
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toContain('socket hang up')
    expect(data).toContain(TS)
    expect(data).toMatch(/still unreacted/i)
    expect(data).toMatch(/do not tell the user you reacted/i)
  })
})
