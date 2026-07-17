/**
 * Unit tests for composeRecoveryMessage.
 *
 * Covers the four shapes the helper must distinguish:
 *   - empty buffer → null (caller should keep its generic message)
 *   - all tool_results errored → null (same reason — retry is safe)
 *   - successful tool_use+tool_result pair → calls Flash, returns text
 *   - Flash throws → null (best-effort; never escalate Flash flake)
 */

import { describe, it, expect, vi } from 'vitest'
import { composeRecoveryMessage, type RecoveryPendingTurn } from '../_recovery-message.js'
import type { LLMProvider, ContentBlock } from '@use-brian/core'

// ── Helpers ──────────────────────────────────────────────────────

/** Build a fake LLMProvider whose stream yields the given text + a
 * synthetic message_end carrying usage. */
function makeFakeProvider(streamedText: string): LLMProvider {
  async function* fakeStream() {
    if (streamedText) yield { type: 'text_delta', text: streamedText }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
    }
  }
  return {
    stream: vi.fn(() => fakeStream()),
    createSession: vi.fn(),
  } as unknown as LLMProvider
}

/** Provider whose stream throws — simulates a Flash hiccup. */
function makeThrowingProvider(): LLMProvider {
  async function* throwingStream() {
    throw new Error('flash unreachable')
    yield { type: 'text_delta', text: '' } // unreachable, satisfies generator
  }
  return {
    stream: vi.fn(() => throwingStream()),
    createSession: vi.fn(),
  } as unknown as LLMProvider
}

function turn(content: ContentBlock[], toolResults: ContentBlock[] = []): RecoveryPendingTurn {
  return { content, toolResults }
}

const successfulCalendarTurn: RecoveryPendingTurn = turn(
  [
    {
      type: 'tool_use',
      id: 'call_1',
      name: 'googleCalendarUpdateEvent',
      input: { eventId: 'evt-1', start: '2026-05-11T12:00:00+08:00', end: '2026-05-11T14:00:00+08:00' },
    },
  ],
  [
    {
      type: 'tool_result',
      toolUseId: 'call_1',
      name: 'googleCalendarUpdateEvent',
      content: '{"id":"evt-1","summary":"Lunch with Ray","start":{"dateTime":"2026-05-11T12:00:00+08:00"}}',
    },
  ],
)

// ── Tests ────────────────────────────────────────────────────────

describe('[COMP:api/recovery-message] composeRecoveryMessage', () => {
  it('returns null when no turns are buffered (no tools ran — generic message is safe)', async () => {
    const result = await composeRecoveryMessage({
      provider: makeFakeProvider('should not be called'),
      pendingAssistantTurns: [],
      userText: 'change my appointment',
      channelType: 'telegram',
    })
    expect(result).toBeNull()
  })

  it('returns null when buffered turns have no tool_use blocks', async () => {
    // Only text content — no side effects to narrate.
    const turns: RecoveryPendingTurn[] = [turn([{ type: 'text', text: 'thinking…' }], [])]
    const result = await composeRecoveryMessage({
      provider: makeFakeProvider('should not be called'),
      pendingAssistantTurns: turns,
      userText: 'hi',
      channelType: 'telegram',
    })
    expect(result).toBeNull()
  })

  it('returns null when every tool_result is an error (retry is safe — keep generic)', async () => {
    const turns: RecoveryPendingTurn[] = [
      turn(
        [
          { type: 'tool_use', id: 'call_1', name: 'googleCalendarUpdateEvent', input: {} },
        ],
        [
          {
            type: 'tool_result',
            toolUseId: 'call_1',
            name: 'googleCalendarUpdateEvent',
            content: 'ERROR: invalid eventId',
            isError: true,
          },
        ],
      ),
    ]
    const provider = makeFakeProvider('should not be called')
    const result = await composeRecoveryMessage({
      provider,
      pendingAssistantTurns: turns,
      userText: 'change it',
      channelType: 'telegram',
    })
    expect(result).toBeNull()
    // The provider must NOT have been called — no Flash spend on a
    // turn where the user is safe to retry.
    expect(provider.stream).not.toHaveBeenCalled()
  })

  it('synthesizes a recovery via Flash when at least one tool succeeded', async () => {
    const provider = makeFakeProvider(
      '幫你改咗做 12:00–14:00 喇，但我未嚟得切寫齊個答覆。可以問我「改好未」確認，唔好再叫我改一次。',
    )
    const result = await composeRecoveryMessage({
      provider,
      pendingAssistantTurns: [successfulCalendarTurn],
      userText: '改做兩個鐘 12-2',
      channelType: 'telegram',
    })
    expect(result).not.toBeNull()
    expect(result!.model).toBe('gemini-flash')
    expect(result!.text).toContain('12:00')
    expect(result!.usage).toEqual({ inputTokens: 100, outputTokens: 50 })
    // Verify the helper sent the right model + a structured payload.
    const call = (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.model).toBe('gemini-flash')
    const payload = JSON.parse(call.messages[0].content)
    expect(payload.userMessage).toBe('改做兩個鐘 12-2')
    expect(payload.successfulActions).toHaveLength(1)
    expect(payload.successfulActions[0].tool).toBe('googleCalendarUpdateEvent')
  })

  it('returns null when Flash throws (best-effort; never escalate the failure)', async () => {
    const result = await composeRecoveryMessage({
      provider: makeThrowingProvider(),
      pendingAssistantTurns: [successfulCalendarTurn],
      userText: '改做兩個鐘 12-2',
      channelType: 'telegram',
    })
    expect(result).toBeNull()
  })

  it('returns null when Flash returns empty text', async () => {
    const result = await composeRecoveryMessage({
      provider: makeFakeProvider(''),
      pendingAssistantTurns: [successfulCalendarTurn],
      userText: 'do it',
      channelType: 'telegram',
    })
    // Empty model output is indistinguishable from a Flash hiccup —
    // surfacing an empty assistant message would be worse than the
    // generic fallback, so we treat it as a synthesis failure.
    expect(result).toBeNull()
  })

  it('skips error tool_results but narrates successful ones in the same turn', async () => {
    // Mixed turn: one tool succeeded, one failed. The successful one
    // shipped a side effect — that's what the user needs to be told
    // about. The failed one is silent (no fake "I tried but failed"
    // promises that the helper can't actually verify).
    const provider = makeFakeProvider('Updated the calendar.')
    const turns: RecoveryPendingTurn[] = [
      turn(
        [
          { type: 'tool_use', id: 'call_1', name: 'googleCalendarUpdateEvent', input: {} },
          { type: 'tool_use', id: 'call_2', name: 'googleCalendarDeleteEvent', input: {} },
        ],
        [
          {
            type: 'tool_result',
            toolUseId: 'call_1',
            name: 'googleCalendarUpdateEvent',
            content: '{"id":"evt-1","summary":"Lunch"}',
          },
          {
            type: 'tool_result',
            toolUseId: 'call_2',
            name: 'googleCalendarDeleteEvent',
            content: 'ERROR: not found',
            isError: true,
          },
        ],
      ),
    ]
    const result = await composeRecoveryMessage({
      provider,
      pendingAssistantTurns: turns,
      userText: 'edit my calendar',
      channelType: 'telegram',
    })
    expect(result).not.toBeNull()
    const call = (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const payload = JSON.parse(call.messages[0].content)
    expect(payload.successfulActions).toHaveLength(1)
    expect(payload.successfulActions[0].tool).toBe('googleCalendarUpdateEvent')
  })

  it('handles tool_results across multiple buffered turns', async () => {
    // The buffer can hold multiple turns when the loop iterates
    // tool_use → tool_result → assistant text → tool_use → … and bails
    // mid-second-turn. All successful actions across turns should be
    // narrated, not just the most recent.
    const provider = makeFakeProvider('Did A and B.')
    const turns: RecoveryPendingTurn[] = [
      turn(
        [{ type: 'tool_use', id: 'call_a', name: 'toolA', input: {} }],
        [{ type: 'tool_result', toolUseId: 'call_a', name: 'toolA', content: 'A done' }],
      ),
      turn(
        [{ type: 'tool_use', id: 'call_b', name: 'toolB', input: {} }],
        [{ type: 'tool_result', toolUseId: 'call_b', name: 'toolB', content: 'B done' }],
      ),
    ]
    await composeRecoveryMessage({
      provider,
      pendingAssistantTurns: turns,
      userText: 'do A and B',
      channelType: 'telegram',
    })
    const call = (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const payload = JSON.parse(call.messages[0].content)
    expect(payload.successfulActions.map((a: { tool: string }) => a.tool)).toEqual(['toolA', 'toolB'])
  })
})
