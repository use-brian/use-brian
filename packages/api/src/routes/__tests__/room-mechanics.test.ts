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

import { describe, it, expect } from 'vitest'
import {
  detectRoomAddress,
  mayResolveRoomConfirmation,
  roomTurnAdmission,
  sharedTurnRejection,
} from '../chat.js'
import {
  COALESCE_MAX_MERGED_ROWS,
  coalesceConsecutiveUserMessages,
  toStampedMessages,
  type SessionMessage,
} from '../../db/sessions.js'

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
