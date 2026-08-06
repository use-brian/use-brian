import { describe, it, expect } from 'vitest'
import { htmlToMarkdown, isHtmlFile } from '../html.js'
import { parseFileContent } from '../parsers.js'

// Every fixture here is invented. The bug this file pins was found in a real
// upload; the shapes are reproduced, the content is not.

/** The shape that caused the incident: a self-contained styled report. */
const SELF_CONTAINED_REPORT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Quarterly Widget Review</title>
<style>
:root{--bg:#ECE7DF;--ink:#1A1A1A}
body{margin:0;background:var(--bg);font-family:system-ui}
.card{border-radius:12px;padding:24px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
</style>
</head>
<body>
<h1>Quarterly Widget Review</h1>
<p>Revenue rose in every region except <b>Northaven</b>.</p>
<img alt="Revenue by region" src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAASABIAADASDASDASDASD">
<h2>Regional detail</h2>
<table>
<thead><tr><th>Region</th><th>Revenue</th></tr></thead>
<tbody><tr><td>Eastmarch</td><td>120</td></tr><tr><td>Northaven</td><td>84</td></tr></tbody>
</table>
<script>window.__INIT__({charts:[1,2,3]})</script>
</body>
</html>`

describe('[COMP:files/html] htmlToMarkdown', () => {
  it('drops stylesheet and script bodies instead of flattening them to prose', () => {
    // The incident: turndown emits the text of any element it has no rule for,
    // so <style>/<script> arrived as document content and got embedded.
    const { text } = htmlToMarkdown(SELF_CONTAINED_REPORT)
    expect(text).not.toContain('--bg:#ECE7DF')
    expect(text).not.toContain('box-shadow')
    expect(text).not.toContain('font-family')
    expect(text).not.toContain('__INIT__')
    expect(text).not.toContain('<style')
    expect(text).not.toContain('<script')
  })

  it('drops inline data: payloads but keeps the alt text', () => {
    // A self-contained export inlines its images; turndown preserves the src
    // verbatim, which is how a 4.1 MB file stays 4.1 MB after conversion.
    const { text } = htmlToMarkdown(SELF_CONTAINED_REPORT)
    expect(text).not.toContain('base64')
    expect(text).not.toContain('/9j/4AAQSkZJRg')
    expect(text).toContain('Revenue by region')
  })

  it('keeps an ordinary image URL', () => {
    const { text } = htmlToMarkdown('<p><img alt="Logo" src="https://example.com/logo.png"></p>')
    expect(text).toContain('![Logo](https://example.com/logo.png)')
  })

  it('drops a link href that is a payload but keeps its anchor text', () => {
    const { text } = htmlToMarkdown('<p><a href="data:text/csv;base64,QUJD">Download CSV</a></p>')
    expect(text).toContain('Download CSV')
    expect(text).not.toContain('base64')
  })

  it('emits ATX headings, which is what the segment chunker reads', () => {
    // chunkFileText builds headingPath from ATX headings; raw <h2> tags are
    // invisible to it, so a converted document is the whole point.
    const { text } = htmlToMarkdown(SELF_CONTAINED_REPORT)
    expect(text).toContain('# Quarterly Widget Review')
    expect(text).toContain('## Regional detail')
  })

  it('emits GFM tables', () => {
    const { text } = htmlToMarkdown(SELF_CONTAINED_REPORT)
    expect(text).toContain('| Region | Revenue |')
    expect(text).toContain('| Eastmarch | 120 |')
  })

  it('reports mode "markdown" for ordinary documents', () => {
    expect(htmlToMarkdown(SELF_CONTAINED_REPORT).mode).toBe('markdown')
  })

  it('re-attaches <title> as an H1 without duplicating an existing one', () => {
    const { text, title } = htmlToMarkdown(SELF_CONTAINED_REPORT)
    expect(title).toBe('Quarterly Widget Review')
    expect(text.match(/^# Quarterly Widget Review$/gm)).toHaveLength(1)
    expect(text.startsWith('# Quarterly Widget Review')).toBe(true)
  })

  it('adds the title when the body has no leading heading', () => {
    const { text } = htmlToMarkdown(
      '<html><head><title>Runbook</title></head><body><p>Step one.</p></body></html>',
    )
    expect(text).toBe('# Runbook\n\nStep one.')
  })

  it('returns just the title when the body has no content', () => {
    const { text } = htmlToMarkdown(
      '<html><head><title>Empty Export</title></head><body></body></html>',
    )
    expect(text).toBe('# Empty Export')
  })

  it('decodes HTML entities', () => {
    const { text } = htmlToMarkdown('<p>Caf&eacute; &amp; bar &mdash; 5&nbsp;stars</p>')
    expect(text).toContain('Café & bar')
    expect(text).not.toContain('&amp;')
    expect(text).not.toContain('&eacute;')
  })

  it('drops form chrome but keeps surrounding text', () => {
    const { text } = htmlToMarkdown(
      '<body><form><input value="x"><button>Submit</button></form><p>Real text</p></body>',
    )
    expect(text).toBe('Real text')
  })

  it('converts a bare fragment with no html/body wrapper', () => {
    const { text } = htmlToMarkdown('<h2>Title</h2><p>Body <b>bold</b>.</p>')
    expect(text).toBe('## Title\n\nBody **bold**.')
  })

  it('returns empty text for empty or whitespace-only input', () => {
    expect(htmlToMarkdown('').text).toBe('')
    expect(htmlToMarkdown('   \n  ').text).toBe('')
    expect(htmlToMarkdown('<html><head><style>.a{color:red}</style></head><body></body></html>').text).toBe('')
  })

  it('survives malformed, unclosed markup', () => {
    const { text } = htmlToMarkdown('<div><p>one<div><p>two')
    expect(text).toContain('one')
    expect(text).toContain('two')
  })
})

describe('[COMP:files/html] htmlToMarkdown shape guards', () => {
  // Turndown recurses per element and is superlinear in node count. Both
  // limits are reachable from a user upload, and the documented rule is that a
  // ceiling may shape what reaches the model, never what reaches storage — so
  // the guard degrades to a complete-text strip, it never drops content.

  it('degrades to a stripped extraction on pathological nesting instead of throwing', () => {
    const deep = `${'<div>'.repeat(1_200)}buried treasure${'</div>'.repeat(1_200)}`
    const result = htmlToMarkdown(deep)
    expect(result.mode).toBe('stripped')
    expect(result.text).toContain('buried treasure')
  })

  it('degrades to a stripped extraction above the tag ceiling, losing no words', () => {
    const wide = '<p>alpha</p>'.repeat(20_001) // 40,002 '<' occurrences
    const result = htmlToMarkdown(wide)
    expect(result.mode).toBe('stripped')
    expect(result.text.split('alpha').length - 1).toBe(20_001)
  })

  it('keeps headings and drops stylesheets on the stripped path too', () => {
    const wide = `<style>.x{color:red}</style><h2>Section</h2>${'<p>body</p>'.repeat(20_001)}`
    const result = htmlToMarkdown(wide)
    expect(result.mode).toBe('stripped')
    expect(result.text).toContain('## Section')
    expect(result.text).not.toContain('color:red')
  })

  it('stays on the markdown path for a document that is large but ordinary', () => {
    const big = `<body>${'<p>A sentence of perfectly normal prose.</p>'.repeat(500)}</body>`
    expect(htmlToMarkdown(big).mode).toBe('markdown')
  })
})

describe('[COMP:files/html] isHtmlFile', () => {
  it('matches HTML mime types', () => {
    expect(isHtmlFile('text/html', 'report')).toBe(true)
    expect(isHtmlFile('TEXT/HTML', 'report')).toBe(true)
    expect(isHtmlFile('application/xhtml+xml', 'report')).toBe(true)
  })

  it('matches by extension when the browser mislabels the mime', () => {
    // A .html handed over as text/plain or octet-stream is still HTML, and
    // missing it reinstates the raw-markup bug.
    expect(isHtmlFile('text/plain', 'report.html')).toBe(true)
    expect(isHtmlFile('application/octet-stream', 'report.HTM')).toBe(true)
    expect(isHtmlFile('text/plain', 'page.xhtml')).toBe(true)
  })

  it('does not match ordinary text files', () => {
    expect(isHtmlFile('text/plain', 'notes.txt')).toBe(false)
    expect(isHtmlFile('text/markdown', 'README.md')).toBe(false)
    expect(isHtmlFile('text/csv', 'rows.csv')).toBe(false)
    expect(isHtmlFile('application/json', 'data.json')).toBe(false)
  })
})

describe('[COMP:files/html] parseFileContent HTML routing', () => {
  it('converts text/html instead of returning raw markup', async () => {
    // text/html matches the generic text/* prefix; falling through to it is
    // exactly the bug. The HTML branch must be checked first.
    const result = await parseFileContent(
      Buffer.from(SELF_CONTAINED_REPORT, 'utf-8'),
      'text/html',
      'review.html',
    )
    expect(result.text).not.toContain('<!doctype html>')
    expect(result.text).not.toContain('box-shadow')
    expect(result.text).toContain('## Regional detail')
    expect(result.summary).toContain('HTML: review.html')
  })

  it('shrinks a data-URI-heavy document by an order of magnitude', async () => {
    const padded = SELF_CONTAINED_REPORT.replace(
      'ASDASDASDASD',
      'A'.repeat(200_000),
    )
    const result = await parseFileContent(Buffer.from(padded, 'utf-8'), 'text/html', 'review.html')
    expect(padded.length).toBeGreaterThan(200_000)
    expect(result.text.length).toBeLessThan(2_000)
  })

  it('still routes a .html file the browser labelled text/plain', async () => {
    const result = await parseFileContent(
      Buffer.from('<h1>Notes</h1><p>Body.</p>', 'utf-8'),
      'text/plain',
      'notes.html',
    )
    expect(result.text).toBe('# Notes\n\nBody.')
  })

  it('returns an honest placeholder when the document has no extractable text', async () => {
    const result = await parseFileContent(
      Buffer.from('<html><body><script>render()</script></body></html>', 'utf-8'),
      'text/html',
      'app.html',
    )
    expect(result.text).toContain('No extractable text')
    expect(result.text).toContain('app.html')
  })

  it('names the degradation in the summary when structure was dropped', async () => {
    const wide = '<p>alpha</p>'.repeat(20_001)
    const result = await parseFileContent(Buffer.from(wide, 'utf-8'), 'text/html', 'huge.html')
    expect(result.summary).toContain('structure dropped')
    expect(result.text).toContain('alpha')
  })

  it('leaves non-HTML text files on the plain UTF-8 path', async () => {
    const result = await parseFileContent(
      Buffer.from('# Just markdown\n\nwith <b>an inline tag</b>.', 'utf-8'),
      'text/markdown',
      'README.md',
    )
    expect(result.text).toBe('# Just markdown\n\nwith <b>an inline tag</b>.')
  })
})
