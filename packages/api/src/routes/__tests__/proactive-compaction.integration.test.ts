import { describe, it, expect, vi } from 'vitest'
import dotenv from 'dotenv'
import { resolve } from 'node:path'

// Mock DB writes so the test doesn't need Postgres. `toStampedMessages`
// stays real — it's a pure function exercised by runProactiveCompaction
// end-to-end. `vi.hoisted` keeps mock refs reachable across vi.mock's
// top-of-file hoisting.
const { mockSetCompactSummaryAndBoundary, mockFindSessionById } = vi.hoisted(() => ({
  mockSetCompactSummaryAndBoundary: vi.fn(async () => true),
  mockFindSessionById: vi.fn(),
}))

vi.mock('../../db/sessions.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/sessions.js')>('../../db/sessions.js')
  return {
    ...actual,
    setCompactSummaryAndBoundary: mockSetCompactSummaryAndBoundary,
    findSessionById: mockFindSessionById,
  }
})

import { createGeminiProvider } from '@use-brian/core'
import type { MemoryStore } from '@use-brian/core'
import { runProactiveCompaction } from '../proactive-compaction.js'
import type { Session, SessionMessage } from '../../db/sessions.js'

dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '..', '..', '.env') })

const apiKey = process.env.GEMINI_API_KEY
const describeIf = apiKey ? describe : describe.skip

function msg(seq: number, role: SessionMessage['role'], content: SessionMessage['content']): SessionMessage {
  return {
    id: `m_${seq}`,
    sessionId: 'sess_hinson',
    sequenceNum: seq,
    role,
    content,
    createdAt: new Date('2026-04-19T04:35:17Z'),
    replyToText: null,
    topicLabel: null,
    topicConfidence: null,
    channelMessageId: null,
    senderUserId: null,
    attachments: [],
  }
}

function session(partial: Partial<Session> = {}): Session {
  return {
    id: 'sess_hinson',
    assistantId: 'a_lobster',
    userId: 'u_hinson',
    channelType: 'telegram',
    channelId: '880211324',
    appId: 'Use Brian',
    appOrigin: null,
    status: 'idle',
    compactSummary: null,
    compactionCount: 0,
    compactBoundarySequence: null,
    title: null,
    downgradeNoticeSent: false,
    downgradeNoticePinMessageId: null,
    mode: null,
    visibility: 'owner',
    effectiveClearance: null,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    ...partial,
  }
}

describeIf('[COMP:api/proactive-compaction] Fix 1a integration — no Gemini 400 post-compaction', () => {
  it('produces a history Gemini accepts after a mid-turn-race session state (Hinson repro)', async () => {
    // Reproduce the prod DB state that bricked Hinson's session on
    // 2026-04-19. Only rows >= compactBoundarySequence (571) are loaded
    // into sessionMessages — the loader's natural filter.
    //
    //   seq 570  user "今日幾多度"         ← compacted-away (not in load)
    //   seq 571  system [compacted marker]  ← the old boundary; cursor points here
    //   seq 572  assistant tool_use         ← orphan from the race
    //   seq 573  user tool_result
    //   seq 574  assistant "GM Hinson…"
    //   seq 575  user "天文台講幾多度?"    ← new turn (current)
    //
    // The old path kept `compactBoundarySequence = 571`, so the next
    // load handed Gemini `[system@571, tool_use@572, ...]` — Gemini
    // 400 because the first content after dropping system is a bare
    // functionCall. Fix 1a must re-anchor by writing a fresh summary
    // to sessions.compact_summary and moving the cursor past the
    // orphan rows onto a plain-user-text row.
    const sessionMessages: SessionMessage[] = [
      msg(571, 'system', '[Conversation compacted at 2026-04-19T04:35:07Z. earlier weather question summarized.]'),
      msg(572, 'assistant', [{ type: 'tool_use', id: 'call_93', name: 'weather', input: { location: 'Hong Kong' } }]),
      msg(573, 'user', [{ type: 'tool_result', toolUseId: 'call_93', name: 'weather', content: '{"temp":"28.2°C"}' }]),
      msg(574, 'assistant', [{ type: 'text', text: 'GM Hinson. 28 度, Partly cloudy.' }]),
      msg(575, 'user', [{ type: 'text', text: '天文台講幾多度?' }]),
    ]

    const provider = createGeminiProvider(apiKey!)
    const memoryStore = {
      getIndex: vi.fn(async () => []),
      create: vi.fn(),
    } as unknown as MemoryStore

    // Unconditional so we don't rely on the token threshold firing on
    // a 5-row history.
    const result = await runProactiveCompaction({
      sessionMessages,
      timezone: 'Asia/Hong_Kong',
      session: session({ compactBoundarySequence: 571 }),
      tier: 'standard',
      channelClass: 'messaging',
      profile: 'linear',
      unconditional: true,
      provider,
      systemPrompt: 'You are a helpful test assistant. Reply in ≤ 20 words.',
      assistantId: 'a_lobster',
      userId: 'u_hinson',
      ownerId: 'u_hinson',
      channelType: 'telegram',
      memoryStore,
    })

    expect(result.compacted).toBe(true)
    expect(mockSetCompactSummaryAndBoundary).toHaveBeenCalled()

    // Persistence invariant: the winning UPDATE passed the OLD cursor
    // (571) as the expected value for the concurrency guard.
    const setCall = mockSetCompactSummaryAndBoundary.mock.calls[0] as unknown as [string, string, number, number | null]
    const newCursor = setCall[2]
    const expectedCursor = setCall[3]
    expect(expectedCursor).toBe(571)
    // The new cursor must land on a real DB row seq — specifically one
    // that keeps a plain-user-text turn on the recent side. With this
    // history shape, that's seq 575 (the current user message).
    expect(newCursor).toBe(575)

    // Head invariant: after the big refactor prepends a fresh summary
    // as a system message and lays down the recent tail, the first
    // non-system entry must be a user turn carrying text/image.
    const firstNonSystem = result.messages.find((m) => m.role !== 'system')
    expect(firstNonSystem?.role).toBe('user')

    // End-to-end: send the returned messages through real Gemini.
    // A 400 "function call turn …" would throw from provider.stream()
    // before we collect any text. A non-empty response proves the
    // request shape is valid.
    const chunks: string[] = []
    for await (const chunk of provider.stream({
      model: 'gemini-flash',
      messages: result.messages,
      systemPrompt: 'You are a helpful test assistant. Reply in ≤ 20 words.',
    })) {
      if (chunk.type === 'text_delta') chunks.push(chunk.text)
    }
    expect(chunks.join('').length).toBeGreaterThan(0)
  }, 30_000)
})
