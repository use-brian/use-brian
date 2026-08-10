/**
 * [COMP:api/room-mechanics] — multiplayer room turn semantics (pure seams).
 *
 * The room model (docs/plans/multiplayer-chat.md P1): posting is free, the
 * assistant speaks only when addressed, an addressed message runs exactly one
 * coalesced sender-attributed turn, and a mention landing mid-turn arms
 * exactly one follow-up. Each rule lives behind an exported pure function so
 * the invariant is testable without a database or provider:
 *
 *   - `detectRoomAddress` (T3) — server-side turn-vs-post decision.
 *   - `roomTurnAdmission` (T5) — queue-depth-one.
 *   - `mayResolveRoomConfirmation` (T11/D8) — addresser-or-admin write gate.
 *   - `sharedTurnRejection` (D2) — rooms are no longer busy-rejected.
 *   - `coalesceConsecutiveUserMessages` (T4) — many posts, one labeled user
 *     turn, strict (user, assistant) alternation restored.
 *
 * Spec: docs/architecture/features/chat-app.md → "The room model".
 */

import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import {
  buildRoomResponseCoordinationBlock,
  detectRoomAddress,
  mayAssistantAnswerInRoom,
  mayResolveRoomConfirmation,
  publishRoomTurnActivity,
  roomTurnAdmission,
  sharedTurnRejection,
  turnStopOutcome,
} from '../chat.js'
import {
  COALESCE_MAX_MERGED_ROWS,
  coalesceConsecutiveUserMessages,
  toStampedMessages,
  type SessionMessage,
} from '../../db/sessions.js'

describe('[COMP:api/room-mechanics] shared live activity (T13)', () => {
  it('attributes research and worker activity to the room turn sender', () => {
    const publishSessionEvent = vi.fn()

    publishRoomTurnActivity({
      isRoomSession: true,
      sessionId: 'room-1',
      senderUserId: 'user-1',
      event: 'status',
      data: { phase: 'research_starting' },
      publishSessionEvent,
    })
    publishRoomTurnActivity({
      isRoomSession: true,
      sessionId: 'room-1',
      senderUserId: 'user-1',
      event: 'worker_start',
      data: { workerId: 'worker-2', description: 'Check valuation multiples' },
      publishSessionEvent,
    })

    expect(publishSessionEvent).toHaveBeenNthCalledWith(1, {
      kind: 'turn_activity',
      sessionId: 'room-1',
      payload: {
        event: 'status',
        senderUserId: 'user-1',
        phase: 'research_starting',
      },
    })
    expect(publishSessionEvent).toHaveBeenNthCalledWith(2, {
      kind: 'turn_activity',
      sessionId: 'room-1',
      payload: {
        event: 'worker_start',
        senderUserId: 'user-1',
        workerId: 'worker-2',
        description: 'Check valuation multiples',
      },
    })
  })

  it('caps mirrored inputs without truncating the sender direct stream', () => {
    const publishSessionEvent = vi.fn()

    publishRoomTurnActivity({
      isRoomSession: true,
      sessionId: 'room-1',
      senderUserId: 'user-1',
      event: 'tool_input',
      data: { id: 'tool-1', name: 'webSearch', input: { query: 'x'.repeat(5_000) } },
      publishSessionEvent,
    })

    expect(publishSessionEvent).toHaveBeenCalledWith({
      kind: 'turn_activity',
      sessionId: 'room-1',
      payload: {
        event: 'tool_input',
        senderUserId: 'user-1',
        id: 'tool-1',
        name: 'webSearch',
        input: {},
      },
    })
  })

  it('does not put personal-chat activity on the shared bus', () => {
    const publishSessionEvent = vi.fn()

    publishRoomTurnActivity({
      isRoomSession: false,
      sessionId: 'private-1',
      senderUserId: 'user-1',
      event: 'status',
      data: { phase: 'research_starting' },
      publishSessionEvent,
    })

    expect(publishSessionEvent).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/room-mechanics] detectRoomAddress (T3)', () => {
  const name = 'Brian'

  it('matches a typed @mention, case-insensitively', () => {
    expect(detectRoomAddress({ message: 'hey @Brian what do you think?', assistantName: name })).toBe(true)
    expect(detectRoomAddress({ message: 'hey @brian?', assistantName: name })).toBe(true)
    expect(detectRoomAddress({ message: '@BRIAN summarize this', assistantName: name })).toBe(true)
  })

  it('matches a multi-word assistant name as inserted by autocomplete', () => {
    expect(
      detectRoomAddress({
        message: 'ok @Acme Primary Assistant take it from here',
        assistantName: 'Acme Primary Assistant',
      }),
    ).toBe(true)
  })

  it('does NOT address on a bare name without @ (talking ABOUT is not talking TO)', () => {
    expect(detectRoomAddress({ message: 'brian should handle this later', assistantName: name })).toBe(false)
  })

  it('honors the Ask affordance and reply-to-assistant triggers', () => {
    expect(detectRoomAddress({ message: 'what is our runway?', assistantName: name, ask: true })).toBe(true)
    expect(
      detectRoomAddress({ message: 'can you expand on that?', assistantName: name, replyToAssistant: true }),
    ).toBe(true)
  })

  it('a plain message addresses nobody', () => {
    expect(detectRoomAddress({ message: 'shipping friday then?', assistantName: name })).toBe(false)
  })

  it('never addresses on an empty assistant name (defensive)', () => {
    expect(detectRoomAddress({ message: '@ hello', assistantName: '' })).toBe(false)
  })
})

describe('[COMP:api/room-mechanics] roomTurnAdmission — queue depth one (T5)', () => {
  it('runs immediately when no turn is in flight', () => {
    expect(roomTurnAdmission({ status: 'idle', waiterArmed: false })).toBe('run')
    expect(roomTurnAdmission({ status: 'timeout', waiterArmed: false })).toBe('run')
  })

  it('a mention landing mid-turn arms THE follow-up turn', () => {
    expect(roomTurnAdmission({ status: 'running', waiterArmed: false })).toBe('wait')
  })

  it('further mentions fold into the armed follow-up — exactly one runs', () => {
    expect(roomTurnAdmission({ status: 'running', waiterArmed: true })).toBe('fold')
  })
})

describe('[COMP:api/room-mechanics] mayResolveRoomConfirmation (T11/D8)', () => {
  it('the addresser may resolve', () => {
    expect(
      mayResolveRoomConfirmation({ jwtUserId: 'u-1', addresserUserId: 'u-1', workspaceRole: 'member' }),
    ).toBe(true)
  })

  it('a workspace admin or owner may resolve', () => {
    expect(
      mayResolveRoomConfirmation({ jwtUserId: 'u-2', addresserUserId: 'u-1', workspaceRole: 'admin' }),
    ).toBe(true)
    expect(
      mayResolveRoomConfirmation({ jwtUserId: 'u-2', addresserUserId: 'u-1', workspaceRole: 'owner' }),
    ).toBe(true)
  })

  it('a non-addresser member is refused — even the room starter', () => {
    expect(
      mayResolveRoomConfirmation({ jwtUserId: 'u-2', addresserUserId: 'u-1', workspaceRole: 'member' }),
    ).toBe(false)
    expect(
      mayResolveRoomConfirmation({ jwtUserId: 'u-2', addresserUserId: 'u-1', workspaceRole: null }),
    ).toBe(false)
  })

  it('an unknown addresser (restarted process) falls back to admin-only', () => {
    expect(
      mayResolveRoomConfirmation({ jwtUserId: 'u-1', addresserUserId: undefined, workspaceRole: 'member' }),
    ).toBe(false)
    expect(
      mayResolveRoomConfirmation({ jwtUserId: 'u-1', addresserUserId: undefined, workspaceRole: 'admin' }),
    ).toBe(true)
  })
})

describe('[COMP:api/room-mechanics] busy gate leaves the human path (D2)', () => {
  const runningRoom = {
    status: 'running',
    visibility: 'workspace',
    channelType: 'web',
    appOrigin: 'chat',
    mode: null,
  }

  it('a running room session is NOT rejected (serialization is internal now)', () => {
    expect(sharedTurnRejection(runningRoom)).toBeNull()
  })

  it('draft sessions keep their distinct busy code', () => {
    expect(
      sharedTurnRejection({ ...runningRoom, mode: 'draft', appOrigin: null })?.code,
    ).toBe('draft_session_busy')
  })
})

// ── Coalesced assembly (T4) ──────────────────────────────────────

function userRow(
  text: string,
  senderUserId: string | null,
  at: string,
): SessionMessage {
  return {
    id: `m-${text.slice(0, 8)}-${at}`,
    sessionId: 's-1',
    role: 'user',
    content: [{ type: 'text', text }],
    sequenceNum: 0,
    createdAt: new Date(at),
    replyToText: null,
    topicLabel: null,
    topicConfidence: null,
    channelMessageId: null,
    senderUserId,
    senderAssistantId: null,
    attachments: [],
  }
}

function assistantRow(text: string): SessionMessage {
  return { ...userRow(text, null, '2026-07-31T10:00:00Z'), role: 'assistant' }
}

const NAMES = new Map([
  ['u-alice', 'Alice'],
  ['u-bob', 'Bob'],
  ['u-caro', 'Caro'],
])

describe('[COMP:api/room-mechanics] coalesceConsecutiveUserMessages (T4)', () => {
  it('N posts + one addressed message assemble into ONE user turn carrying every stamped Name: line', () => {
    const rows = [
      assistantRow('sure — anything else?'),
      userRow('shipping friday then?', 'u-alice', '2026-07-31T10:01:00Z'),
      userRow('yes, pending the QA pass', 'u-bob', '2026-07-31T10:02:00Z'),
      userRow('@Brian summarize the decision', 'u-caro', '2026-07-31T10:03:00Z'),
    ]
    const stamped = toStampedMessages(rows, 'UTC', NAMES)
    const out = coalesceConsecutiveUserMessages(stamped)

    // Strict alternation restored: [assistant, user].
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user'])

    const blocks = out[1].content as Array<{ type: string; text: string }>
    const joined = blocks.map((b) => b.text).join('\n')
    expect(joined).toContain('Alice: shipping friday then?')
    expect(joined).toContain('Bob: yes, pending the QA pass')
    expect(joined).toContain('Caro: @Brian summarize the decision')
    // Attribution order is chronological — the backlog reads as the jam
    // happened.
    expect(joined.indexOf('Alice:')).toBeLessThan(joined.indexOf('Bob:'))
    expect(joined.indexOf('Bob:')).toBeLessThan(joined.indexOf('Caro:'))
  })

  it('fixes the pre-existing aborted-turn edge in a personal session (no sender names)', () => {
    const rows = [
      userRow('first try (turn aborted)', null, '2026-07-31T10:01:00Z'),
      userRow('second try', null, '2026-07-31T10:02:00Z'),
    ]
    const out = coalesceConsecutiveUserMessages(toStampedMessages(rows, 'UTC'))
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
  })

  it('never merges a tool_result-bearing user message (pairing invariant)', () => {
    const toolResultRow: SessionMessage = {
      ...userRow('x', null, '2026-07-31T10:01:00Z'),
      content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }],
    }
    const rows = [
      assistantRow('calling a tool'),
      toolResultRow,
      userRow('a post that landed mid-turn', 'u-alice', '2026-07-31T10:02:00Z'),
      userRow('another post', 'u-bob', '2026-07-31T10:03:00Z'),
    ]
    const out = coalesceConsecutiveUserMessages(rows)
    // The tool_result row stays its own message; only the two plain posts
    // merge.
    expect(out).toHaveLength(3)
    expect(
      (out[1].content as Array<{ type: string }>)[0].type,
    ).toBe('tool_result')
    expect(out[2].content as Array<{ type: string }>).toHaveLength(2)
  })

  it('caps a merge group at the most recent 100 rows with one omission note (T12)', () => {
    const rows = Array.from({ length: COALESCE_MAX_MERGED_ROWS + 5 }, (_, i) =>
      userRow(`post ${i}`, 'u-alice', '2026-07-31T10:01:00Z'),
    )
    const out = coalesceConsecutiveUserMessages(rows)
    expect(out).toHaveLength(1)
    const blocks = out[0].content as Array<{ type: string; text: string }>
    // 1 omission note + the most recent 100 rows.
    expect(blocks).toHaveLength(COALESCE_MAX_MERGED_ROWS + 1)
    expect(blocks[0].text).toContain('omitted')
    expect(blocks[1].text).toContain('post 5')
    expect(blocks[blocks.length - 1].text).toContain(`post ${COALESCE_MAX_MERGED_ROWS + 4}`)
  })

  it('leaves an already-alternating history untouched', () => {
    const rows = [
      userRow('hi', null, '2026-07-31T10:01:00Z'),
      assistantRow('hello'),
      userRow('bye', null, '2026-07-31T10:02:00Z'),
    ]
    const out = coalesceConsecutiveUserMessages(rows)
    expect(out).toHaveLength(3)
    expect(out[0]).toBe(rows[0])
  })

  it('merges multiple separate groups independently', () => {
    const rows = [
      userRow('a1', 'u-alice', '2026-07-31T10:01:00Z'),
      userRow('a2', 'u-bob', '2026-07-31T10:02:00Z'),
      assistantRow('reply'),
      userRow('b1', 'u-alice', '2026-07-31T10:03:00Z'),
      userRow('b2', 'u-bob', '2026-07-31T10:04:00Z'),
    ]
    const out = coalesceConsecutiveUserMessages(rows)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })
})

describe('[COMP:api/room-mechanics] multi-assistant rooms (T9)', () => {
  it('gives each responder a separate, complementary coordination role', () => {
    const assistants = [
      { id: 'a-brian', name: 'Brian' },
      { id: 'a-hinson', name: 'Hinson' },
    ]
    const first = buildRoomResponseCoordinationBlock({
      assistants,
      currentAssistantId: 'a-brian',
    })
    const second = buildRoomResponseCoordinationBlock({
      assistants,
      currentAssistantId: 'a-hinson',
    })

    expect(first).toContain('responder 1 of 2')
    expect(first).toContain('will answer separately')
    expect(first).toContain('do not speak for them')
    expect(second).toContain('responder 2 of 2')
    expect(second).toContain('have already replied')
    expect(second).toContain('add distinct knowledge instead of repeating')
  })

  it('an assistant may answer at or below the room clearance, never above', () => {
    expect(mayAssistantAnswerInRoom({ assistantClearance: 'internal', roomClearance: 'internal' })).toBe(true)
    expect(mayAssistantAnswerInRoom({ assistantClearance: 'public', roomClearance: 'internal' })).toBe(true)
    expect(mayAssistantAnswerInRoom({ assistantClearance: 'internal', roomClearance: 'confidential' })).toBe(true)
    // A confidential-cleared assistant answering an internal room would draw
    // on data the room's readers may not see — refused.
    expect(mayAssistantAnswerInRoom({ assistantClearance: 'confidential', roomClearance: 'internal' })).toBe(false)
    // NULLs collapse to 'internal' (the create-path default).
    expect(mayAssistantAnswerInRoom({ assistantClearance: null, roomClearance: null })).toBe(true)
    expect(mayAssistantAnswerInRoom({ assistantClearance: 'confidential', roomClearance: null })).toBe(false)
  })

  it('labels FOREIGN assistant turns at assembly; the answering assistant keeps its own words unlabeled', () => {
    const gmRow: SessionMessage = {
      ...assistantRow('I checked the deck - looks ready.'),
      senderAssistantId: 'a-gm',
    }
    const salesRow: SessionMessage = {
      ...assistantRow('Pipeline says the deal closes Friday.'),
      senderAssistantId: 'a-sales',
    }
    const legacyRow = assistantRow('An older reply with no voice stamp.')
    const stamped = toStampedMessages(
      [gmRow, userRow('thanks both', 'u-alice', '2026-07-31T10:04:00Z'), salesRow, legacyRow],
      'UTC',
      NAMES,
      { names: new Map([['a-gm', 'Gm']]), currentAssistantId: 'a-sales' },
    )
    const text = (i: number) =>
      (stamped[i].content as Array<{ text: string }>)[0].text
    // Gm's turn is a foreign voice for the Sales-run turn - labeled.
    expect(text(0)).toBe('[Gm]: I checked the deck - looks ready.')
    // Sales' own prior turn stays unlabeled (its own words).
    expect(text(2)).toBe('Pipeline says the deal closes Friday.')
    // Pre-390 rows (no stamp) are left untouched.
    expect(text(3)).toBe('An older reply with no voice stamp.')
  })
})

/**
 * [COMP:api/turn-stop] — what `POST /api/chat/stop` decides.
 *
 * The human half of turn recovery (2026-08-08). A member looking at a spinning
 * Live card cannot tell a working turn from a dead one, so Stop is offered the
 * whole time and the SERVER resolves which of four situations it is in. Getting
 * that branch wrong is expensive in both directions: forcing the lock on a live
 * turn lets a second turn claim a session the first is mid-reply on, and NOT
 * releasing a phantom leaves the room exactly as stuck as before.
 */
describe('[COMP:api/turn-stop] turnStopOutcome', () => {
  it('is a no-op when the turn already ended', () => {
    // Idempotent: two members hitting Stop on the same stuck card both get a
    // calm answer rather than one of them racing into an error.
    expect(turnStopOutcome({ status: 'idle', abortedLocally: false, reclaimedStale: false }))
      .toBe('not_running')
    expect(turnStopOutcome({ status: 'timeout', abortedLocally: true, reclaimedStale: true }))
      .toBe('not_running')
  })

  it('aborts a live turn running in this process', () => {
    expect(turnStopOutcome({ status: 'running', abortedLocally: true, reclaimedStale: false }))
      .toBe('aborted')
  })

  it('reclaims a phantom whose lease already expired', () => {
    expect(turnStopOutcome({ status: 'running', abortedLocally: false, reclaimedStale: true }))
      .toBe('reclaimed')
  })

  it('prefers reclaim over abort when a stale lease and a local handle disagree', () => {
    // A handle we still hold for an expired lease belongs to a turn that is
    // already gone. Reporting `aborted` would claim we stopped something live.
    expect(turnStopOutcome({ status: 'running', abortedLocally: true, reclaimedStale: true }))
      .toBe('reclaimed')
  })

  it('only requests a cancel for a live turn in another process', () => {
    // Deliberately does NOT release the lock: that turn is still writing, and
    // freeing the slot early would let a second turn claim the session.
    expect(turnStopOutcome({ status: 'running', abortedLocally: false, reclaimedStale: false }))
      .toBe('cancel_requested')
  })
})

/**
 * [COMP:api/room-mechanics] — every assistant row the chat route writes is
 * attributed to the assistant that produced it.
 *
 * Source guard, because the writes live inside the SSE handler and cannot be
 * reached without a provider, a database and a live stream. The happy-path
 * write has carried `senderAssistantId` since migration 390; the FALLBACK
 * writes (empty-turn synthesis, error recovery) did not, and nothing caught
 * it — both typecheck, both unit-test green, and the column is nullable
 * because pre-390 rows legitimately have no stamp.
 *
 * The 2026-08-09 Snapio room is what an unstamped fallback costs. A `@CFO`
 * turn thought-burnt in research mode; the synthesised reply persisted with
 * no stamp, so the room rendered it under the session's bound assistant and
 * the founder read the PRIMARY as refusing a question the CFO answered three
 * minutes later. The quieter half is worse: `toStampedMessages` only prefixes
 * `[Name]:` when a row IS stamped, so on the next turn the primary read
 * "I would need access to ... NetSuite or QuickBooks" as its OWN prior
 * position and inherited a refusal it never made.
 */
describe('[COMP:api/room-mechanics] Assistant-row attribution (source guard)', () => {
  const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')

  /** Every `addSessionMessage({ … })` call, brace-balanced from the literal. */
  function addSessionMessageCalls(src: string): string[] {
    const calls: string[] = []
    const OPEN = 'addSessionMessage({'
    let from = 0
    for (;;) {
      const start = src.indexOf(OPEN, from)
      if (start === -1) return calls
      let depth = 0
      let i = start + OPEN.length - 1
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}') {
          depth--
          if (depth === 0) break
        }
      }
      calls.push(src.slice(start, i + 1))
      from = i + 1
    }
  }

  it('finds the call sites it means to guard', () => {
    // A parser that silently matches nothing would make every assertion
    // below vacuously pass — the failure mode this whole guard exists to
    // prevent. Pin a floor instead of trusting the scan.
    const calls = addSessionMessageCalls(source)
    expect(calls.length).toBeGreaterThanOrEqual(5)
    expect(calls.filter((c) => /role: 'assistant'/.test(c)).length).toBeGreaterThanOrEqual(3)
  })

  it('stamps senderAssistantId on every assistant-role write', () => {
    const unstamped = addSessionMessageCalls(source)
      .filter((call) => /role: 'assistant'/.test(call))
      .filter((call) => !/senderAssistantId/.test(call))
    // Name the offenders — a bare count tells the next session nothing.
    expect(unstamped.map((c) => c.replace(/\s+/g, ' ').slice(0, 120))).toEqual([])
  })
})
