import { describe, it, expect } from 'vitest'
import { buildGroupChatContextPrompt } from '../sessions.js'

/**
 * Guard: the channel identity primitive's structural boundary. Sender
 * identity is a transport-authenticated fact and must never reach the model
 * as content. `buildGroupChatContextPrompt` is the multi-user surface most
 * at risk of leaking a raw userId / JID / display name into model-facing
 * text, so it carries the runtime guard. See
 * docs/architecture/channels/channel-identity-primitive.md.
 */

const D = new Date('2026-06-29T00:00:00Z')

// Transport-shaped ids that must never appear verbatim in the rendered prompt.
const ALICE = 'whatsapp:15551230001@s.whatsapp.net'
const BOB = 'U0SLACKBOB'
const CAROL = 'tg:998877'
const CURRENT = 'web-current-user-uuid'

describe('[COMP:channels/identity-primitive] buildGroupChatContextPrompt', () => {
  it('labels the current user neutrally and never emits their raw id', () => {
    const out = buildGroupChatContextPrompt(
      [{ role: 'user', content: 'hi', userId: CURRENT, createdAt: D }],
      CURRENT,
    )
    expect(out).toContain('Current user: hi')
    expect(out).not.toContain(CURRENT)
  })

  it('assigns each distinct sender a stable neutral label, never the raw id', () => {
    const out = buildGroupChatContextPrompt(
      [
        { role: 'user', content: 'one', userId: ALICE, createdAt: D },
        { role: 'user', content: 'two', userId: BOB, createdAt: D },
        { role: 'user', content: 'three', userId: ALICE, createdAt: D },
        { role: 'assistant', content: 'reply', userId: 'assistant', createdAt: D },
        { role: 'user', content: 'four', userId: CAROL, createdAt: D },
      ],
      CURRENT,
    )

    // Stable labels by first appearance.
    expect(out).toContain('User A: one')
    expect(out).toContain('User B: two')
    expect(out).toContain('User A: three') // Alice stays User A
    expect(out).toContain('You (assistant): reply')
    expect(out).toContain('User C: four')

    // No transport id / JID leaks into the model-facing text.
    for (const id of [ALICE, BOB, CAROL]) {
      expect(out).not.toContain(id)
    }
    // Belt-and-suspenders: no @-JID and no raw Slack id shape survives.
    expect(out).not.toMatch(/@s\.whatsapp\.net/)
    expect(out).not.toMatch(/U0SLACK/)
  })

  it('distinguishes 3+ senders instead of collapsing them to one label', () => {
    const out = buildGroupChatContextPrompt(
      [
        { role: 'user', content: 'a', userId: ALICE, createdAt: D },
        { role: 'user', content: 'b', userId: BOB, createdAt: D },
        { role: 'user', content: 'c', userId: CAROL, createdAt: D },
      ],
      CURRENT,
    )
    const labels = new Set(['User A', 'User B', 'User C'].filter((l) => out.includes(`${l}: `)))
    expect(labels.size).toBe(3)
  })

  it('rolls past Z to AA for very large groups', () => {
    // 27 distinct senders → the 27th is "User AA".
    const messages = Array.from({ length: 27 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
      userId: `sender-${i}`,
      createdAt: D,
    }))
    const out = buildGroupChatContextPrompt(messages, CURRENT)
    expect(out).toContain('User AA: m26')
    expect(out).not.toContain('sender-26')
  })
})
