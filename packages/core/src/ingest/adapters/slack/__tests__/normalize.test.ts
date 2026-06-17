import { describe, it, expect } from 'vitest'

import { episodeEnvelopeSchema } from '../../../index.js'
import { normalizeSlackThread } from '../normalize.js'
import type {
  SlackIngestContext,
  SlackMessageInput,
  SlackThreadInput,
} from '../types.js'

function makeMessage(partial: Partial<SlackMessageInput> & { ts: string }): SlackMessageInput {
  return partial
}

function makeCtx(partial: Partial<SlackIngestContext> = {}): SlackIngestContext {
  return {
    workspace_id: 'ws-1',
    user_id: 'u-1',
    assistant_id: null,
    created_by_user_id: 'u-1',
    created_by_assistant_id: null,
    ...partial,
  }
}

const TEAM = 'T123'
const CHANNEL = 'C456'
const THREAD = '1700000000.000100'

function makeInput(overrides: Partial<SlackThreadInput> = {}): SlackThreadInput {
  return {
    team_id: TEAM,
    channel_id: CHANNEL,
    thread_ts: THREAD,
    messages: [],
    ...overrides,
  }
}

describe('[COMP:brain/source-adapters/slack] Slack thread normalizer', () => {
  it('round-trips a basic 3-message thread through the envelope schema', () => {
    const input = makeInput({
      messages: [
        makeMessage({ ts: '1700000000.000100', user: 'U1', text: 'hi' }),
        makeMessage({ ts: '1700000010.000200', user: 'U2', text: 'hello' }),
        makeMessage({ ts: '1700000020.000300', user: 'U1', text: 'thanks' }),
      ],
    })

    const env = normalizeSlackThread(input, makeCtx())

    expect(env.source_kind).toBe('slack_thread')
    expect(env.source_ref).toEqual({
      source_kind: 'slack_thread',
      slack_workspace_id: TEAM,
      channel_id: CHANNEL,
      thread_ts: THREAD,
      message_count: 3,
    })
    expect(env.occurred_at).toBeInstanceOf(Date)
    expect(env.occurred_at.toISOString()).toBe(
      new Date(parseFloat('1700000000.000100') * 1000).toISOString(),
    )
    expect(env.content.raw).toEqual({ ref: `slack:${TEAM}/${CHANNEL}/${THREAD}` })

    // End-to-end Zod validation at the Pipeline B trust boundary.
    expect(() => episodeEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('deduplicates actors and preserves first-seen order', () => {
    const input = makeInput({
      messages: [
        makeMessage({ ts: '1700000000.000100', user: 'U1' }),
        makeMessage({ ts: '1700000010.000200', user: 'U2' }),
        makeMessage({ ts: '1700000020.000300', user: 'U1' }),
      ],
    })

    const env = normalizeSlackThread(input, makeCtx())

    expect(env.actors).toEqual([
      { role: 'sender', external_id: 'U1' },
      { role: 'sender', external_id: 'U2' },
    ])
  })

  it('skips bot-only messages from actors but counts them in message_count', () => {
    const input = makeInput({
      messages: [
        makeMessage({ ts: '1700000000.000100', user: 'U1', text: 'hi' }),
        makeMessage({ ts: '1700000010.000200', bot_id: 'B1', text: '[bot ping]' }),
      ],
    })

    const env = normalizeSlackThread(input, makeCtx())

    expect(env.actors).toEqual([{ role: 'sender', external_id: 'U1' }])
    const ref = env.source_ref as { message_count: number }
    expect(ref.message_count).toBe(2)
  })

  it('handles a single-message thread', () => {
    const input = makeInput({
      messages: [makeMessage({ ts: THREAD, user: 'U1', text: 'kickoff' })],
    })

    const env = normalizeSlackThread(input, makeCtx())

    const ref = env.source_ref as { message_count: number }
    expect(ref.message_count).toBe(1)
    expect(env.actors).toEqual([{ role: 'sender', external_id: 'U1' }])
    expect(() => episodeEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('handles an empty thread by falling back to thread_ts for occurred_at', () => {
    const input = makeInput({ messages: [] })

    const env = normalizeSlackThread(input, makeCtx())

    const ref = env.source_ref as { message_count: number }
    expect(ref.message_count).toBe(0)
    expect(env.actors).toEqual([])
    expect(env.occurred_at.toISOString()).toBe(
      new Date(parseFloat(THREAD) * 1000).toISOString(),
    )
    expect(() => episodeEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('flattens attachments across messages with mime/size defaults', () => {
    const input = makeInput({
      messages: [
        makeMessage({
          ts: '1700000000.000100',
          user: 'U1',
          files: [
            {
              id: 'F1',
              mimetype: 'image/png',
              size: 1024,
              url_private: 'https://files.slack.com/F1',
            },
          ],
        }),
        makeMessage({
          ts: '1700000010.000200',
          user: 'U2',
          files: [{ id: 'F2' }],
        }),
      ],
    })

    const env = normalizeSlackThread(input, makeCtx())

    expect(env.content.attachments).toEqual([
      {
        kind: 'file',
        ref: 'https://files.slack.com/F1',
        mime: 'image/png',
        size: 1024,
      },
      {
        kind: 'file',
        ref: 'F2',
        mime: 'application/octet-stream',
        size: 0,
      },
    ])
    expect(() => episodeEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('passes through user-only visibility', () => {
    const env = normalizeSlackThread(
      makeInput({ messages: [makeMessage({ ts: THREAD, user: 'U1' })] }),
      makeCtx({ user_id: 'u-1', assistant_id: null }),
    )
    expect(env.user_id).toBe('u-1')
    expect(env.assistant_id).toBeNull()
    expect(() => episodeEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('passes through assistant-only visibility', () => {
    const env = normalizeSlackThread(
      makeInput({ messages: [makeMessage({ ts: THREAD, user: 'U1' })] }),
      makeCtx({ user_id: null, assistant_id: 'a-1' }),
    )
    expect(env.user_id).toBeNull()
    expect(env.assistant_id).toBe('a-1')
    expect(() => episodeEnvelopeSchema.parse(env)).not.toThrow()
  })

  it('schema rejects when both visibility ids are null — adapter does not pre-validate', () => {
    const env = normalizeSlackThread(
      makeInput({ messages: [makeMessage({ ts: THREAD, user: 'U1' })] }),
      makeCtx({ user_id: null, assistant_id: null }),
    )
    expect(env.user_id).toBeNull()
    expect(env.assistant_id).toBeNull()
    expect(() => episodeEnvelopeSchema.parse(env)).toThrow(/visibility/)
  })

  it("defaults sensitivity to 'internal' regardless of context shape", () => {
    const env = normalizeSlackThread(
      makeInput({ messages: [makeMessage({ ts: THREAD, user: 'U1' })] }),
      makeCtx(),
    )
    expect(env.sensitivity).toBe('internal')
  })
})
