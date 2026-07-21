import { describe, it, expect } from 'vitest'
import { markdownToEmailHtml, renderEmailBody } from '../email/markdown.js'

describe('[COMP:channels/email-markdown] Markdown → email body renderer', () => {
  describe('markdownToEmailHtml', () => {
    it('wraps plain prose in paragraphs and keeps it otherwise unchanged', () => {
      expect(markdownToEmailHtml('Hello Sarah')).toBe('<p>Hello Sarah</p>')
      expect(markdownToEmailHtml('line one\nline two')).toBe('<p>line one<br>\nline two</p>')
      expect(markdownToEmailHtml('para one\n\npara two')).toBe('<p>para one</p>\n<p>para two</p>')
    })

    it('renders a typical model-drafted email into semantic block HTML', () => {
      const html = markdownToEmailHtml(
        '# Weekly update\n\nHi **team**, quick notes:\n\n- shipped the *beta*\n- fixed onboarding\n\n[Full report](https://x.io/report)',
      )
      expect(html).toBe(
        [
          '<h2>Weekly update</h2>',
          '<p>Hi <strong>team</strong>, quick notes:</p>',
          '<ul>',
          '<li>shipped the <em>beta</em></li>',
          '<li>fixed onboarding</li>',
          '</ul>',
          '<p><a href="https://x.io/report">Full report</a></p>',
        ].join('\n'),
      )
    })

    it('renders ordered lists, blockquotes, strikethrough, and horizontal rules', () => {
      expect(markdownToEmailHtml('1. first\n2. second')).toBe('<ol>\n<li>first</li>\n<li>second</li>\n</ol>')
      expect(markdownToEmailHtml('> quoted\n> reply')).toBe('<blockquote>quoted<br>\nreply</blockquote>')
      expect(markdownToEmailHtml('~~old~~ new')).toBe('<p><del>old</del> new</p>')
      expect(markdownToEmailHtml('above\n\n---\n\nbelow')).toBe('<p>above</p>\n<hr>\n<p>below</p>')
    })

    it('caps heading depth for email (# → h2, deeper → h4)', () => {
      expect(markdownToEmailHtml('## Section')).toBe('<h3>Section</h3>')
      expect(markdownToEmailHtml('##### Deep')).toBe('<h4>Deep</h4>')
    })

    it('renders pipe tables as real bordered tables with formatted cells', () => {
      const html = markdownToEmailHtml('| Item | Qty |\n|---|---|\n| **Widget** | 2 |')
      expect(html).toContain('<table style="border-collapse:collapse">')
      expect(html).toContain('>Item</th>')
      expect(html).toContain('><strong>Widget</strong></td>')
      expect(html).toContain('>2</td>')
      expect(html).not.toContain('|')
    })

    it('keeps code content verbatim inside pre/code, protected from other passes', () => {
      expect(markdownToEmailHtml('```\nconst x = **not bold**\n```')).toBe(
        '<pre><code>const x = **not bold**</code></pre>',
      )
      expect(markdownToEmailHtml('run `a<b`')).toBe('<p>run <code>a&lt;b</code></p>')
    })

    it('escapes raw HTML in the source — model-composed text is never passed through as markup', () => {
      expect(markdownToEmailHtml('<script>alert(1)</script> & fries')).toBe(
        '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; fries</p>',
      )
    })

    it('links: http/https/mailto become anchors, other schemes degrade to text', () => {
      expect(markdownToEmailHtml('[mail me](mailto:a@b.co)')).toBe('<p><a href="mailto:a@b.co">mail me</a></p>')
      expect(markdownToEmailHtml('[click](javascript:alert(1))')).toBe('<p>click (javascript:alert(1))</p>')
    })

    it('leaves snake_case and mid-word asterisks alone', () => {
      expect(markdownToEmailHtml('use snake_case and a*b*c')).toBe('<p>use snake_case and a*b*c</p>')
    })
  })

  describe('renderEmailBody', () => {
    it('returns the multipart/alternative pair: stripped text + rendered html', () => {
      const { text, html } = renderEmailBody('# Update\n\nHi **team**,\n\n- one\n- two')
      expect(text).toBe('Update\n\nHi team,\n\n• one\n• two')
      expect(html).toContain('<h2>Update</h2>')
      expect(html).toContain('<strong>team</strong>')
      expect(html).toContain('<li>one</li>')
      expect(text).not.toContain('**')
      expect(html).not.toContain('**')
    })

    it('keeps links reachable in the plain-text part as label (url)', () => {
      const { text } = renderEmailBody('See [the report](https://x.io/r).')
      expect(text).toBe('See the report (https://x.io/r).')
    })
  })
})
