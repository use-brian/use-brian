import { describe, it, expect } from 'vitest'
import { scrubCredentials, scrubCredentialsText } from '../credential-scrubber.js'

// Fixtures are syntactically-shaped fakes — they match the scrubber's
// regexes but carry no real secret material. The PEM markers are assembled
// from fragments at runtime so no literal key block sits in this source file.
const D5 = '-'.repeat(5)
const PK = `PRIVATE ${'KEY'}`
const pemBlock = (label: string, body: string) =>
  `${D5}BEGIN ${label} ${PK}${D5}\n${body}\n${D5}END ${label} ${PK}${D5}`

describe('[COMP:brain/credential-scrubber] Credential scrubber', () => {
  describe('operational-secret patterns', () => {
    it('redacts a PEM key block', () => {
      const input = `before\n${pemBlock('RSA', 'fake-body-xxxx')}\nafter`
      const r = scrubCredentials(input)
      expect(r.text).toBe('before\n[redacted:private_key]\nafter')
      expect(r.redacted).toBe(true)
      expect(r.counts.private_key).toBe(1)
    })

    it('collapses two adjacent key blocks to two markers (non-greedy body)', () => {
      const key = pemBlock('EC', 'fake-body-yyyy')
      const r = scrubCredentials(`${key}\n${key}`)
      expect(r.text).toBe('[redacted:private_key]\n[redacted:private_key]')
      expect(r.counts.private_key).toBe(2)
    })

    it('redacts an AWS access key id', () => {
      const r = scrubCredentials('key=AKIAIOSFODNN7EXAMPLE done')
      expect(r.text).toBe('key=[redacted:api_token] done')
      expect(r.counts.api_token).toBe(1)
    })

    it('redacts a Google API key', () => {
      expect(scrubCredentialsText('AIza' + 'a'.repeat(35))).toBe('[redacted:api_token]')
    })

    it('redacts a GitHub token', () => {
      expect(scrubCredentialsText('ghp_' + 'a'.repeat(36))).toBe('[redacted:api_token]')
    })

    it('redacts a Slack bot token', () => {
      expect(scrubCredentialsText('xoxb-1234567890abc')).toBe('[redacted:api_token]')
    })

    it('redacts a Stripe secret key', () => {
      expect(scrubCredentialsText('sk_live_' + 'a'.repeat(20))).toBe('[redacted:api_token]')
    })

    it('redacts a Stripe webhook signing secret', () => {
      expect(scrubCredentialsText('whsec_' + 'a'.repeat(24))).toBe('[redacted:api_token]')
    })

    it('redacts an Anthropic-style sk-ant key', () => {
      expect(scrubCredentialsText('sk-ant-' + 'a'.repeat(24))).toBe('[redacted:api_token]')
    })

    it('redacts a JWT-shaped bearer token', () => {
      const jwt = 'eyJabcdefgh.eyJabcdefgh.abcdefgh'
      const r = scrubCredentials(`Authorization: Bearer ${jwt}`)
      expect(r.text).toBe('Authorization: Bearer [redacted:jwt]')
      expect(r.counts.jwt).toBe(1)
    })

    it('reports per-kind counts across mixed content', () => {
      const r = scrubCredentials(
        `ghp_${'a'.repeat(36)} and AKIAIOSFODNN7EXAMPLE and sk_test_${'b'.repeat(20)}`,
      )
      expect(r.counts.api_token).toBe(3)
      expect(r.redacted).toBe(true)
    })
  })

  describe('does not over-redact', () => {
    it('leaves clean text untouched', () => {
      const r = scrubCredentials('The quarterly report is due Friday.')
      expect(r.text).toBe('The quarterly report is due Friday.')
      expect(r.redacted).toBe(false)
      expect(r.counts).toEqual({})
    })

    it('leaves business PII in place — SSN / phone / card are not credentials', () => {
      const pii = 'SSN 123-45-6789, phone +1 415 555 0199, card 4111 1111 1111 1111'
      const r = scrubCredentials(pii)
      expect(r.text).toBe(pii)
      expect(r.redacted).toBe(false)
    })
  })

  describe('idempotency', () => {
    it('scrubbing already-scrubbed text is a no-op', () => {
      const once = scrubCredentialsText('token ghp_' + 'a'.repeat(36))
      expect(scrubCredentialsText(once)).toBe(once)
      expect(scrubCredentials(once).redacted).toBe(false)
    })

    it('resets shared global regexes between calls', () => {
      const input = 'ghp_' + 'a'.repeat(36)
      expect(scrubCredentialsText(input)).toBe('[redacted:api_token]')
      expect(scrubCredentialsText(input)).toBe('[redacted:api_token]')
    })
  })
})
