import { describe, it, expect } from 'vitest'
import { EvidenceAccumulator } from '../evidence.js'

function acc(gated: string[] = ['saveContact']) {
  return new EvidenceAccumulator({ gatedTools: gated })
}

describe('[COMP:security/evidence-gate] Identifier-evidence accumulator', () => {
  describe('shouldGate', () => {
    it('gates only the configured tools', () => {
      const a = acc(['saveContact', 'saveCompany'])
      expect(a.shouldGate('saveContact')).toBe(true)
      expect(a.shouldGate('saveCompany')).toBe(true)
      expect(a.shouldGate('webSearch')).toBe(false)
    })

    it('gates nothing when constructed without gatedTools', () => {
      const a = new EvidenceAccumulator()
      expect(a.shouldGate('saveContact')).toBe(false)
    })
  })

  describe('emails', () => {
    it('flags an email never observed', () => {
      const a = acc()
      const out = a.findUnverified('{"email":"vicky.chen@slowood.hk"}')
      expect(out).toEqual([{ kind: 'email', value: 'vicky.chen@slowood.hk' }])
    })

    it('passes an email observed in a noted tool result (case-insensitive)', () => {
      const a = acc()
      a.noteToolResult('Contact page lists Vicky.Chen@Slowood.hk for orders', '{"url":"https://slowood.hk/contact"}')
      expect(a.findUnverified('{"email":"vicky.chen@slowood.hk"}')).toEqual([])
    })

    it('passes an email seeded from the caller instruction', () => {
      const a = acc()
      a.note('Reach out to ops@fls.com.hk about middle mile.')
      expect(a.findUnverified('{"email":"ops@fls.com.hk"}')).toEqual([])
    })
  })

  describe('input-echo laundering', () => {
    it('does not count a search-result query echo as evidence', () => {
      const a = acc()
      // webSearch returns { query, results } — the fabricated email comes
      // back in the echoed query even with zero hits.
      a.noteToolResult(
        '{"query":"vicky.chen@slowood.hk","results":[]}',
        '{"query":"vicky.chen@slowood.hk"}',
      )
      expect(a.findUnverified('{"email":"vicky.chen@slowood.hk"}')).toHaveLength(1)
    })

    it('still counts third-party identifiers found beyond the echo', () => {
      const a = acc()
      a.noteToolResult(
        '{"query":"slowood contact","results":[{"snippet":"email hello@slowood.hk"}]}',
        '{"query":"slowood contact"}',
      )
      expect(a.findUnverified('{"email":"hello@slowood.hk"}')).toEqual([])
    })
  })

  describe('urls', () => {
    it('flags a fabricated store URL', () => {
      const a = acc()
      const out = a.findUnverified('{"website":"https://www.hktvmall.com/store/slowood"}')
      expect(out).toEqual([{ kind: 'url', value: 'https://www.hktvmall.com/store/slowood' }])
    })

    it('matches across scheme/www/trailing-slash variants', () => {
      const a = acc()
      a.noteToolResult('Found store: http://hktvmall.com/store/slowood/', '{}')
      expect(a.findUnverified('{"website":"https://www.hktvmall.com/store/slowood"}')).toEqual([])
    })

    it('flags a bare-domain fabrication with a common TLD', () => {
      const a = acc()
      expect(a.findUnverified('{"domain":"slowood.hk"}')).toEqual([
        { kind: 'url', value: 'slowood.hk' },
      ])
    })

    it('never flags code-ish dotted tokens (uncommon TLD, no path)', () => {
      const a = acc()
      expect(a.findUnverified('{"note":"see component-map.md and executor.ts"}')).toEqual([])
    })

    it('accepts a social profile URL when the page showed the handle', () => {
      const a = acc()
      a.noteToolResult('About us — follow @slowood for updates', '{}')
      expect(a.findUnverified('{"instagram":"https://instagram.com/slowood"}')).toEqual([])
    })

    it('flags a linkedin slug never observed', () => {
      const a = acc()
      const out = a.findUnverified('{"linkedin":"https://linkedin.com/in/vicky-chen-8931"}')
      expect(out).toEqual([{ kind: 'url', value: 'https://linkedin.com/in/vicky-chen-8931' }])
    })
  })

  describe('handles', () => {
    it('flags an @handle never observed', () => {
      const a = acc()
      expect(a.findUnverified('{"ig":"@slowoodhk"}')).toEqual([
        { kind: 'handle', value: '@slowoodhk' },
      ])
    })

    it('accepts a handle observed via a social URL in evidence', () => {
      const a = acc()
      a.noteToolResult('profile: https://instagram.com/slowoodhk', '{}')
      expect(a.findUnverified('{"ig":"@slowoodhk"}')).toEqual([])
    })

    it('does not treat email local-parts as handles', () => {
      const a = acc()
      a.note('write to hello@slowood.hk')
      expect(a.findUnverified('{"email":"hello@slowood.hk"}')).toEqual([])
    })
  })

  describe('phones', () => {
    it('flags a separated phone number never observed', () => {
      const a = acc()
      expect(a.findUnverified('{"phone":"+852 9123 4567"}')).toEqual([
        { kind: 'phone', value: '+852 9123 4567' },
      ])
    })

    it('matches a phone across formatting differences', () => {
      const a = acc()
      a.noteToolResult('Call us: +852-9123-4567', '{}')
      expect(a.findUnverified('{"phone":"+852 9123 4567"}')).toEqual([])
    })

    it('matches a local number against an observed international form', () => {
      const a = acc()
      a.noteToolResult('Hotline +852 9123 4567', '{}')
      expect(a.findUnverified('{"phone":"9123 4567"}')).toEqual([])
    })

    it('never flags dates or bare digit runs', () => {
      const a = acc()
      expect(a.findUnverified('{"due":"2026-07-14","order":"20260714","qty":12345678}')).toEqual(
        [],
      )
    })
  })

  describe('mixed record writes', () => {
    it('reports every unverified identifier once, verified ones not at all', () => {
      const a = acc()
      a.noteToolResult('Slowood — hello@slowood.hk — https://slowood.hk/about', '{}')
      const out = a.findUnverified(
        JSON.stringify({
          name: 'Vicky Chen',
          email: 'hello@slowood.hk',
          alt_email: 'vicky.chen@slowood.hk',
          website: 'slowood.hk/about',
          ig: '@slowoodx',
        }),
      )
      expect(out).toEqual([
        { kind: 'email', value: 'vicky.chen@slowood.hk' },
        { kind: 'handle', value: '@slowoodx' },
      ])
    })
  })
})
