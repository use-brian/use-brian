import { describe, it, expect } from 'vitest'

import {
  composeFilters,
  universalFilters,
  type FilterFn,
  type FilterRegistry,
  type IngestEvent,
} from '../filters.js'

function evt(normalized: Record<string, unknown>, source = 'gmail'): IngestEvent {
  return { source, normalized }
}

describe('[COMP:brain/filter-library] Universal filters', () => {
  describe('always', () => {
    const always = universalFilters.always

    it('returns true on an empty normalized record', () => {
      expect(always(evt({}), {})).toBe(true)
    })

    it('returns true regardless of params', () => {
      expect(always(evt({ text: 'anything' }), { foo: 'bar' })).toBe(true)
    })
  })

  describe('keyword_match', () => {
    const fn = universalFilters.keyword_match

    it('substring-matches against normalized.text (case-insensitive)', () => {
      expect(fn(evt({ text: 'Quarterly Strategy URGENT' }), { keywords: ['urgent'] })).toBe(true)
    })

    it('matches any of the supplied keywords (OR semantics)', () => {
      const params = { keywords: ['foo', 'bar', 'baz'] }
      expect(fn(evt({ text: 'we need this by EOD bar tonight' }), params)).toBe(true)
    })

    it('returns false when no keyword matches', () => {
      expect(fn(evt({ text: 'routine update' }), { keywords: ['urgent', 'asap'] })).toBe(false)
    })

    it('returns false when normalized.text is missing', () => {
      expect(fn(evt({}), { keywords: ['urgent'] })).toBe(false)
    })

    it('returns false when normalized.text is not a string', () => {
      expect(fn(evt({ text: 123 }), { keywords: ['urgent'] })).toBe(false)
    })

    it('returns false on empty keywords list', () => {
      expect(fn(evt({ text: 'anything' }), { keywords: [] })).toBe(false)
    })

    it('returns false when keywords param is missing', () => {
      expect(fn(evt({ text: 'urgent' }), {})).toBe(false)
    })

    it('ignores empty-string keywords (does not match every event)', () => {
      expect(fn(evt({ text: 'hello' }), { keywords: [''] })).toBe(false)
    })
  })

  describe('actor_match', () => {
    const fn = universalFilters.actor_match

    it('matches on normalized.actor_id', () => {
      expect(fn(evt({ actor_id: 'dependabot[bot]' }), { values: ['dependabot[bot]'] })).toBe(true)
    })

    it('falls back to normalized.sender when actor_id is missing', () => {
      expect(fn(evt({ sender: 'alice@acme.com' }), { values: ['alice@acme.com'] })).toBe(true)
    })

    it('prefers actor_id over sender when both are present', () => {
      const event = evt({ actor_id: 'bot', sender: 'alice@acme.com' })
      expect(fn(event, { values: ['alice@acme.com'] })).toBe(false)
      expect(fn(event, { values: ['bot'] })).toBe(true)
    })

    it('returns false when neither actor_id nor sender is present', () => {
      expect(fn(evt({}), { values: ['alice@acme.com'] })).toBe(false)
    })

    it('returns false on empty values list', () => {
      expect(fn(evt({ actor_id: 'a' }), { values: [] })).toBe(false)
    })
  })

  describe('sender_match', () => {
    const fn = universalFilters.sender_match

    it('matches on normalized.sender', () => {
      expect(fn(evt({ sender: 'alice@acme.com' }), { values: ['alice@acme.com'] })).toBe(true)
    })

    it('does NOT fall back to actor_id', () => {
      expect(fn(evt({ actor_id: 'alice@acme.com' }), { values: ['alice@acme.com'] })).toBe(false)
    })

    it('returns false when sender is missing', () => {
      expect(fn(evt({}), { values: ['alice@acme.com'] })).toBe(false)
    })

    it('returns false when sender is not a string', () => {
      expect(fn(evt({ sender: 42 }), { values: ['alice@acme.com'] })).toBe(false)
    })
  })

  describe('mention_of', () => {
    const fn = universalFilters.mention_of

    it('matches when normalized.mentions has any overlap', () => {
      expect(fn(evt({ mentions: ['@alice', '@brain'] }), { values: ['@brain'] })).toBe(true)
    })

    it('returns false on no overlap', () => {
      expect(fn(evt({ mentions: ['@alice'] }), { values: ['@brain'] })).toBe(false)
    })

    it('returns false when mentions is missing', () => {
      expect(fn(evt({}), { values: ['@brain'] })).toBe(false)
    })

    it('returns false when mentions is not an array of strings', () => {
      expect(fn(evt({ mentions: 'oops' }), { values: ['@brain'] })).toBe(false)
      expect(fn(evt({ mentions: [1, 2, 3] }), { values: ['@brain'] })).toBe(false)
    })

    it('returns false on empty values list', () => {
      expect(fn(evt({ mentions: ['@brain'] }), { values: [] })).toBe(false)
    })
  })

  describe('user_flag', () => {
    const fn = universalFilters.user_flag

    it('matches when normalized.user_flags has any overlap', () => {
      expect(fn(evt({ user_flags: ['⭐', ':bookmark:'] }), { values: ['/save', '⭐'] })).toBe(true)
    })

    it('returns false on no overlap', () => {
      expect(fn(evt({ user_flags: ['⭐'] }), { values: ['/save'] })).toBe(false)
    })

    it('returns false when user_flags is missing', () => {
      expect(fn(evt({}), { values: ['⭐'] })).toBe(false)
    })

    it('returns false when user_flags is not an array of strings', () => {
      expect(fn(evt({ user_flags: { '⭐': true } }), { values: ['⭐'] })).toBe(false)
    })
  })
})

describe('[COMP:brain/filter-library] composeFilters', () => {
  it('produces a registry containing all keys from inputs', () => {
    const a: FilterRegistry = { foo: () => true }
    const b: FilterRegistry = { bar: () => false }
    const merged = composeFilters(a, b)

    expect(Object.keys(merged).sort()).toEqual(['bar', 'foo'])
  })

  it('preserves universal filters when no override is supplied', () => {
    const sourceSpecific: FilterRegistry = { sender_domain: () => true }
    const merged = composeFilters(universalFilters, sourceSpecific)

    expect(merged.always).toBe(universalFilters.always)
    expect(merged.keyword_match).toBe(universalFilters.keyword_match)
    expect(merged.sender_domain).toBe(sourceSpecific.sender_domain)
  })

  it('lets later registries shadow earlier ones on key collision', () => {
    const override: FilterFn = () => false
    const merged = composeFilters(universalFilters, { always: override })

    expect(merged.always).toBe(override)
    expect(merged.always({ source: 's', normalized: {} }, {})).toBe(false)
  })

  it('returns a frozen registry', () => {
    const merged = composeFilters(universalFilters)
    expect(Object.isFrozen(merged)).toBe(true)
  })

  it('returns an empty frozen registry when no inputs are supplied', () => {
    const merged = composeFilters()
    expect(Object.keys(merged)).toHaveLength(0)
    expect(Object.isFrozen(merged)).toBe(true)
  })
})
