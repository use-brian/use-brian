/**
 * Unit tests for composeEmptyTurnSynthesis.
 *
 * Covers the contract the chat route relies on:
 *   - empty buffer / no successful tool results → still calls Flash
 *     in no-evidence mode (caller only falls back to the canned
 *     banner when Flash itself fails)
 *   - all tool_results errored → no-evidence mode, Flash sees empty
 *     toolEvidence
 *   - successful tool_use+tool_result pair → evidence mode, Flash
 *     gets the results
 *   - Flash throws → null (best-effort)
 *   - Flash returns empty text → null
 *   - filters error rows out of the payload before Flash sees it
 */

import { describe, it, expect, vi } from 'vitest'
import {
  composeEmptyTurnSynthesis,
  type EmptyTurnSynthesisInputTurn,
} from '../_empty-turn-synthesis.js'
import type { LLMProvider, ContentBlock } from '@sidanclaw/core'

function makeFakeProvider(streamedText: string): LLMProvider {
  async function* fakeStream() {
    if (streamedText) yield { type: 'text_delta', text: streamedText }
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 120, outputTokens: 80 },
    }
  }
  return {
    stream: vi.fn(() => fakeStream()),
    createSession: vi.fn(),
  } as unknown as LLMProvider
}

function makeThrowingProvider(): LLMProvider {
  async function* throwing() {
    throw new Error('flash unreachable')
    yield { type: 'text_delta', text: '' }
  }
  return {
    stream: vi.fn(() => throwing()),
    createSession: vi.fn(),
  } as unknown as LLMProvider
}

function turn(content: ContentBlock[], toolResults: ContentBlock[] = []): EmptyTurnSynthesisInputTurn {
  return { content, toolResults }
}

const workerFindingsTurn: EmptyTurnSynthesisInputTurn = turn(
  [
    {
      type: 'tool_use',
      id: 'call_w1',
      name: 'spawnWorker',
      input: { prompt: 'Find top TikTok videos this week with URLs' },
    },
  ],
  [
    {
      type: 'tool_result',
      toolUseId: 'call_w1',
      name: 'spawnWorker',
      content:
        '<worker-result workerId="worker_1" status="completed">\n<findings>\n- TEN — Chongqing motorcycle, 2.7M likes. URL: https://www.tiktok.com/@tenlee_1001.official/video/7641092602216959252\n</findings>\n</worker-result>',
    },
  ],
)

describe('[COMP:api/empty-turn-synthesis] composeEmptyTurnSynthesis', () => {
  it('still calls Flash in no-evidence mode when no turns are buffered', async () => {
    const provider = makeFakeProvider(
      "I'd need GitHub connected to pull yesterday's commits by author.",
    )
    const result = await composeEmptyTurnSynthesis({
      provider,
      pendingAssistantTurns: [],
      userText: 'give me a list of which developer contributed how much yesterday',
      channelType: 'web',
    })
    expect(result).not.toBeNull()
    expect(result!.text).toContain('GitHub')
    expect(provider.stream).toHaveBeenCalledOnce()
    const payload = JSON.parse(
      (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[0].content,
    )
    expect(payload.toolEvidence).toEqual([])
  })

  it('calls Flash in no-evidence mode when the buffer has no tool_use blocks', async () => {
    const provider = makeFakeProvider('Share the file and I can break it down.')
    const result = await composeEmptyTurnSynthesis({
      provider,
      pendingAssistantTurns: [turn([{ type: 'text', text: 'thinking…' }], [])],
      userText: 'summarise the doc',
      channelType: 'web',
    })
    expect(result).not.toBeNull()
    expect(provider.stream).toHaveBeenCalledOnce()
    const payload = JSON.parse(
      (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[0].content,
    )
    expect(payload.toolEvidence).toEqual([])
  })

  it('calls Flash in no-evidence mode when every tool_result errored', async () => {
    const provider = makeFakeProvider('Search came back rate-limited — try again in a minute.')
    const result = await composeEmptyTurnSynthesis({
      provider,
      pendingAssistantTurns: [
        turn(
          [{ type: 'tool_use', id: 'call_x', name: 'webSearch', input: { query: 'foo' } }],
          [
            {
              type: 'tool_result',
              toolUseId: 'call_x',
              name: 'webSearch',
              content: 'ERROR: rate limited',
              isError: true,
            },
          ],
        ),
      ],
      userText: 'tell me about foo',
      channelType: 'web',
    })
    expect(result).not.toBeNull()
    expect(provider.stream).toHaveBeenCalledOnce()
    const payload = JSON.parse(
      (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[0].content,
    )
    expect(payload.toolEvidence).toEqual([])
  })

  it('synthesises an answer from the worker findings + emits Flash usage', async () => {
    const provider = makeFakeProvider(
      'Top TikTok this week: TEN — Chongqing motorcycle (2.7M likes). https://www.tiktok.com/@tenlee_1001.official/video/7641092602216959252',
    )
    const result = await composeEmptyTurnSynthesis({
      provider,
      pendingAssistantTurns: [workerFindingsTurn],
      userText: 'give me the links of the video',
      channelType: 'web',
    })
    expect(result).not.toBeNull()
    expect(result!.model).toBe('gemini-flash')
    expect(result!.text).toContain('tiktok.com')
    expect(result!.usage).toEqual({ inputTokens: 120, outputTokens: 80 })

    // Verify Flash got the right model + the worker findings in the payload.
    const call = (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.model).toBe('gemini-flash')
    const payload = JSON.parse(call.messages[0].content)
    expect(payload.userMessage).toBe('give me the links of the video')
    expect(payload.toolEvidence).toHaveLength(1)
    expect(payload.toolEvidence[0].tool).toBe('spawnWorker')
    expect(payload.toolEvidence[0].result).toContain('tenlee_1001.official')
  })

  it('returns null when Flash itself throws — never escalate a model hiccup', async () => {
    const result = await composeEmptyTurnSynthesis({
      provider: makeThrowingProvider(),
      pendingAssistantTurns: [workerFindingsTurn],
      userText: 'give me the links',
      channelType: 'web',
    })
    expect(result).toBeNull()
  })

  it('returns null when Flash produces empty output — keep canned banner over silent message', async () => {
    const result = await composeEmptyTurnSynthesis({
      provider: makeFakeProvider(''),
      pendingAssistantTurns: [workerFindingsTurn],
      userText: 'give me the links',
      channelType: 'web',
    })
    expect(result).toBeNull()
  })

  it('pins thinking LOW and budgets maxTokens for thinking so the reply is not truncated mid-sentence', async () => {
    // Regression: gemini-flash (→ gemini-3-flash-preview) thinks on every turn
    // and Gemini bills thinking against maxOutputTokens. The old maxTokens:600
    // with no thinking cap let thinking eat the budget and truncated the reply
    // ("…telling me your name and", incident 2026-06-04 session 6ca76404).
    const provider = makeFakeProvider('Tell me your name and role and I can start your profile.')
    await composeEmptyTurnSynthesis({
      provider,
      pendingAssistantTurns: [],
      userText: 'Help me build a profile of myself in this brain.',
      channelType: 'web',
    })
    const call = (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.thinkingLevel).toBe('low')
    // Must clear a ≤200-word reply (~270 tokens) PLUS LOW thinking headroom —
    // the 600 cap that caused the truncation must never come back.
    expect(call.maxTokens).toBeGreaterThanOrEqual(1024)
  })

  it('only feeds successful tool_results — error rows are filtered out before Flash sees the payload', async () => {
    const provider = makeFakeProvider('ok')
    await composeEmptyTurnSynthesis({
      provider,
      pendingAssistantTurns: [
        turn(
          [
            { type: 'tool_use', id: 'call_ok', name: 'webSearch', input: {} },
            { type: 'tool_use', id: 'call_err', name: 'webSearch', input: {} },
          ],
          [
            { type: 'tool_result', toolUseId: 'call_ok', name: 'webSearch', content: 'good result' },
            {
              type: 'tool_result',
              toolUseId: 'call_err',
              name: 'webSearch',
              content: 'ERROR',
              isError: true,
            },
          ],
        ),
      ],
      userText: 'find stuff',
      channelType: 'web',
    })
    const payload = JSON.parse(
      (provider.stream as ReturnType<typeof vi.fn>).mock.calls[0][0].messages[0].content,
    )
    expect(payload.toolEvidence).toHaveLength(1)
    expect(payload.toolEvidence[0].result).toBe('good result')
  })
})
