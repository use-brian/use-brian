import { describe, expect, it } from 'vitest'
import {
  pseudonymize,
  redactDiagnosticText,
  sanitizeDiagnosticArgs,
  scrubCapsuleValue,
} from '../sanitize.js'

describe('[COMP:api/support-diagnostics-capture] diagnostic sanitization', () => {
  const salt = Buffer.alloc(32, 7)

  it('redacts credentials and direct identifiers before persistence', () => {
    const raw = [
      'email alice@example.com',
      'id 550e8400-e29b-41d4-a716-446655440000',
      'ip 192.168.1.4',
      'Authorization=Bearer abcdefghijklmnopqrstuvwxyz',
      'path /Users/alice/project',
    ].join(' ')
    const safe = redactDiagnosticText(raw, salt)

    expect(safe).not.toContain('alice@example.com')
    expect(safe).not.toContain('550e8400-e29b-41d4-a716-446655440000')
    expect(safe).not.toContain('192.168.1.4')
    expect(safe).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(safe).not.toContain('/Users/alice')
    expect(safe).toContain('[email:')
    expect(safe).toContain('[HOME]')
  })

  it('omits content-bearing and credential object fields', () => {
    const safe = sanitizeDiagnosticArgs([
      'tool failed',
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        prompt: 'private customer question',
        token: 'very-secret',
        status: 500,
      },
    ], salt)

    expect(safe.message).toContain('[CONTENT_OMITTED]')
    expect(safe.message).toContain('[REDACTED]')
    expect(safe.message).not.toContain('private customer question')
    expect(safe.message).not.toContain('very-secret')
  })

  it('keeps pseudonyms stable only within one capture', () => {
    expect(pseudonymize('same-id', salt)).toBe(pseudonymize('same-id', salt))
    expect(pseudonymize('same-id', salt)).not.toBe(
      pseudonymize('same-id', Buffer.alloc(32, 8)),
    )
  })

  it('includes content only at an explicit capsule boundary', () => {
    const input = { content: 'hello alice@example.com', apiKey: 'secret' }
    expect(scrubCapsuleValue(input, salt, { allowContent: false })).toEqual({
      content: '[CONTENT_OMITTED]',
      apiKey: '[REDACTED]',
    })
    const included = scrubCapsuleValue(input, salt, { allowContent: true }) as Record<string, unknown>
    expect(included.content).not.toContain('alice@example.com')
    expect(included.apiKey).toBe('[REDACTED]')
  })
})
