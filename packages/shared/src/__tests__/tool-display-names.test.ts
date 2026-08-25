import { describe, it, expect } from 'vitest'
import { humanizeToolName, describeToolInput } from '../tool-display-names.js'

describe('[COMP:shared/tool-display-names] channel tool-status labels', () => {
  describe('describeToolInput names WHICH page for browser tools', () => {
    it('browserNavigate → "Browsing <host>" (www stripped)', () => {
      expect(describeToolInput('browserNavigate', { url: 'https://www.linkedin.com/messaging/' })).toBe(
        'Browsing linkedin.com',
      )
      expect(describeToolInput('browserNavigate', { url: 'https://news.ycombinator.com/' })).toBe(
        'Browsing news.ycombinator.com',
      )
    })

    it('browserReadPage → "Reading <host>" (matches the urlReader posture)', () => {
      expect(describeToolInput('browserReadPage', { url: 'https://en.wikipedia.org/wiki/X' })).toBe(
        'Reading en.wikipedia.org',
      )
    })

    it('returns undefined for a malformed URL or a missing url (falls back to the status label)', () => {
      expect(describeToolInput('browserNavigate', { url: 'not a url' })).toBeUndefined()
      expect(describeToolInput('browserNavigate', {})).toBeUndefined()
    })

    it('does not invent a target for browser tools that carry only element refs', () => {
      // click/type act on the current page — no URL in the input, so the
      // describer declines and the present-participle status label is used.
      expect(describeToolInput('browserClick', { ref: '@e2' })).toBeUndefined()
      expect(describeToolInput('browserType', { ref: '@e1', text: 'hello' })).toBeUndefined()
    })
  })

  describe('humanizeToolName gives browser tools a readable status label, not "Browser Navigate"', () => {
    it('maps the acting browser tools to present-participle phrases', () => {
      expect(humanizeToolName('browserClick')).toBe('Clicking in the browser')
      expect(humanizeToolName('browserType')).toBe('Typing in the browser')
      expect(humanizeToolName('browserNavigate')).toBe('Opening a page')
      expect(humanizeToolName('browserSnapshot')).toBe('Reading the page')
    })

    it('still title-cases an unmapped tool name', () => {
      expect(humanizeToolName('someNewTool')).toBe('Some New Tool')
    })
  })

  it('labels the server-scoped Slack history reader plainly', () => {
    expect(humanizeToolName('readCurrentSlackThread')).toBe('Reading the Slack thread')
  })
})
