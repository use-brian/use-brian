import { describe, it, expect } from 'vitest'
import {
  mintApprovalToken,
  verifyApprovalToken,
  hashApprovalText,
} from '../defense/approval-token.js'

const SECRET = 'hmac-secret-test-abcdef'

function baseMint(overrides: Partial<Parameters<typeof mintApprovalToken>[0]> = {}): string {
  return mintApprovalToken({
    assistantId: 'a-1',
    replyToId: 'reply-42',
    text: 'thanks for the feedback!',
    source: 'auto',
    secret: SECRET,
    now: () => 1_000_000,
    ...overrides,
  })
}

describe('[COMP:feed/approval-token] round-trip', () => {
  it('verifies a freshly-minted token', () => {
    const token = baseMint()
    const result = verifyApprovalToken({
      token,
      expectedAssistantId: 'a-1',
      expectedReplyToId: 'reply-42',
      text: 'thanks for the feedback!',
      secret: SECRET,
      now: () => 1_000_000,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.assistantId).toBe('a-1')
      expect(result.payload.replyToId).toBe('reply-42')
      expect(result.payload.source).toBe('auto')
      expect(result.payload.expiresAt).toBeGreaterThan(1_000_000)
    }
  })

  it('binds exact text — text-swap is rejected', () => {
    const token = baseMint()
    const result = verifyApprovalToken({
      token,
      expectedAssistantId: 'a-1',
      expectedReplyToId: 'reply-42',
      text: 'thanks for the feedback!!',  // extra bang
      secret: SECRET,
      now: () => 1_000_000,
    })
    expect(result).toEqual({ ok: false, reason: 'text-mismatch' })
  })

  it('binds assistant id — cross-assistant reuse is rejected', () => {
    const token = baseMint({ assistantId: 'a-1' })
    const result = verifyApprovalToken({
      token,
      expectedAssistantId: 'a-2',
      expectedReplyToId: 'reply-42',
      text: 'thanks for the feedback!',
      secret: SECRET,
      now: () => 1_000_000,
    })
    expect(result).toEqual({ ok: false, reason: 'wrong-assistant' })
  })

  it('binds target reply id — replaying on a different reply is rejected', () => {
    const token = baseMint({ replyToId: 'reply-42' })
    const result = verifyApprovalToken({
      token,
      expectedAssistantId: 'a-1',
      expectedReplyToId: 'reply-99',
      text: 'thanks for the feedback!',
      secret: SECRET,
      now: () => 1_000_000,
    })
    expect(result).toEqual({ ok: false, reason: 'wrong-reply-target' })
  })

  it('rejects tokens signed with a different secret', () => {
    const token = baseMint()
    const result = verifyApprovalToken({
      token,
      expectedAssistantId: 'a-1',
      expectedReplyToId: 'reply-42',
      text: 'thanks for the feedback!',
      secret: 'different-secret',
      now: () => 1_000_000,
    })
    expect(result).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('rejects expired tokens', () => {
    const token = baseMint({ ttlMs: 30_000 })
    // now=1_000_000 + ttl 30s → expiresAt = 1_030_000. Verify at 1_100_000 → expired.
    const result = verifyApprovalToken({
      token,
      expectedAssistantId: 'a-1',
      expectedReplyToId: 'reply-42',
      text: 'thanks for the feedback!',
      secret: SECRET,
      now: () => 1_100_000,
    })
    expect(result).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects malformed tokens with no separator', () => {
    const result = verifyApprovalToken({
      token: 'not-a-real-token',
      expectedAssistantId: 'a-1',
      expectedReplyToId: 'reply-42',
      text: 't',
      secret: SECRET,
    })
    expect(result).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects tampered payload while keeping a valid-looking signature shape', () => {
    const token = baseMint()
    const dot = token.lastIndexOf('.')
    // Flip one character in the encoded payload half.
    const tampered = token.slice(0, dot - 3) + 'X' + token.slice(dot - 2)
    const result = verifyApprovalToken({
      token: tampered,
      expectedAssistantId: 'a-1',
      expectedReplyToId: 'reply-42',
      text: 'thanks for the feedback!',
      secret: SECRET,
    })
    // HMAC invalidates — reason is bad-signature (not malformed, since
    // the .-split still yields two halves of the right length).
    expect(result.ok).toBe(false)
  })

  it('nonce differs across mints so tokens are not replay-equal', () => {
    const a = baseMint()
    const b = baseMint()
    expect(a).not.toBe(b)
  })

  it('hashApprovalText is stable + hex-encoded', () => {
    const h = hashApprovalText('hello')
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it("tracks 'human' source independently from 'auto'", () => {
    const token = baseMint({ source: 'human' })
    const result = verifyApprovalToken({
      token,
      expectedAssistantId: 'a-1',
      expectedReplyToId: 'reply-42',
      text: 'thanks for the feedback!',
      secret: SECRET,
      now: () => 1_000_000,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.source).toBe('human')
  })
})
