import { describe, it, expect } from 'vitest'

import { resolveSlackMentions, extractMentionIds } from '../mentions.js'

describe('[COMP:brain/source-adapters/slack] Slack mention resolution', () => {
  describe('resolveSlackMentions', () => {
    it('rewrites a bare <@U…> token to the directory name', () => {
      const dir = new Map([['U0AQT24KHEV', 'Dustin Green']])
      const out = resolveSlackMentions('hey <@U0AQT24KHEV> please review', dir)
      expect(out.text).toBe('hey Dustin Green please review')
      expect(out.resolved).toEqual([{ id: 'U0AQT24KHEV', name: 'Dustin Green' }])
    })

    it('rewrites multiple distinct mentions and dedups resolved by id', () => {
      const dir = new Map([
        ['U0AQT24KHEV', 'Dustin Green'],
        ['U0AQAV7M1NZ', 'Alice Wong'],
      ])
      const out = resolveSlackMentions(
        '<@U0AQT24KHEV> and <@U0AQAV7M1NZ>, also <@U0AQT24KHEV> again',
        dir,
      )
      expect(out.text).toBe('Dustin Green and Alice Wong, also Dustin Green again')
      expect(out.resolved).toEqual([
        { id: 'U0AQT24KHEV', name: 'Dustin Green' },
        { id: 'U0AQAV7M1NZ', name: 'Alice Wong' },
      ])
    })

    it('falls back to the embedded |label when the directory misses', () => {
      const out = resolveSlackMentions('ping <@U0AQT24KHEV|dustin_gmat>', new Map())
      expect(out.text).toBe('ping dustin_gmat')
      expect(out.resolved).toEqual([{ id: 'U0AQT24KHEV', name: 'dustin_gmat' }])
    })

    it('prefers the directory name over the embedded label', () => {
      const dir = new Map([['U0AQT24KHEV', 'Dustin Green']])
      const out = resolveSlackMentions('<@U0AQT24KHEV|dustin_gmat>', dir)
      expect(out.text).toBe('Dustin Green')
      expect(out.resolved).toEqual([{ id: 'U0AQT24KHEV', name: 'Dustin Green' }])
    })

    it('leaves an unresolvable token untouched and reports nothing resolved', () => {
      const out = resolveSlackMentions('who is <@U0AQT24KHEV>?', new Map())
      expect(out.text).toBe('who is <@U0AQT24KHEV>?')
      expect(out.resolved).toEqual([])
    })

    it('resolves W-prefixed (enterprise) user ids', () => {
      const dir = new Map([['W012ANROLE', 'Org Admin']])
      const out = resolveSlackMentions('cc <@W012ANROLE>', dir)
      expect(out.text).toBe('cc Org Admin')
    })

    it('is a no-op on text with no mentions', () => {
      const out = resolveSlackMentions('no mentions here', new Map())
      expect(out.text).toBe('no mentions here')
      expect(out.resolved).toEqual([])
    })
  })

  describe('extractMentionIds', () => {
    it('returns unique ids preserving first-seen order', () => {
      expect(
        extractMentionIds('<@U0AQAV7M1NZ> <@U0AQT24KHEV> <@U0AQAV7M1NZ>'),
      ).toEqual(['U0AQAV7M1NZ', 'U0AQT24KHEV'])
    })

    it('captures ids from labelled tokens', () => {
      expect(extractMentionIds('<@U0AQT24KHEV|dustin_gmat>')).toEqual(['U0AQT24KHEV'])
    })

    it('returns empty for no mentions', () => {
      expect(extractMentionIds('plain text')).toEqual([])
    })
  })
})
