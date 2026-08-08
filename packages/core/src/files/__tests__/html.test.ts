import { describe, it, expect } from 'vitest'
import { parseHtmlToMarkdown, isHtmlFile } from '../html.js'
import { parseFileContent } from '../parsers.js'

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="description" content="Technical implementation plan for visibility improvements.">
<title>Friso Hong Kong &mdash; GEO Plan</title>
<style>
:root{ --lk-bg:#ECE7DF; --lk-ink:#1A1A1A }
h1,h2,h3{font-family:var(--font-serif)}
.sr{position:absolute;width:1px;height:1px;clip:rect(0 0 0 0)}
</style>
<script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)}</script>
</head>
<body>
<nav><a href="/">Home</a></nav>
<h2>Stage 1</h2>
<p>Replace the generic product statement with a canonical safety dossier.</p>
<ul><li>Publish the dossier</li><li>Verify CDN behavior</li></ul>
<table><thead><tr><th>Batch</th><th>Status</th></tr></thead>
<tbody><tr><td>1W07KPJ</td><td>Recalled</td></tr></tbody></table>
<noscript>Enable JavaScript.</noscript>
</body>
</html>`

describe('[COMP:files/html-extract] HTML → Markdown extraction', () => {
  it('drops stylesheet and script bodies instead of indexing them as text', () => {
    const md = parseHtmlToMarkdown(PAGE)

    // The 2026-08-05 incident: these strings were segments 0 and 1 in the brain.
    expect(md).not.toContain('--lk-bg')
    expect(md).not.toContain('font-family')
    expect(md).not.toContain('dataLayer')
    expect(md).not.toContain('<!doctype html>')
    expect(md).not.toContain('Enable JavaScript.')
  })

  it('keeps the document text and its structure as Markdown', () => {
    const md = parseHtmlToMarkdown(PAGE)

    expect(md).toContain('## Stage 1')
    expect(md).toContain('Replace the generic product statement with a canonical safety dossier.')
    expect(md).toMatch(/^-\s+Publish the dossier$/m)
    expect(md).toMatch(/^-\s+Verify CDN behavior$/m)
    expect(md).toContain('1W07KPJ')
    // GFM tables survive the conversion.
    expect(md).toMatch(/\|\s*Batch\s*\|/)
  })

  it('lifts the <title> and meta description above the body', () => {
    const md = parseHtmlToMarkdown(PAGE)

    expect(md.startsWith('# Friso Hong Kong')).toBe(true)
    expect(md).toContain('Technical implementation plan for visibility improvements.')
  })

  it('does not repeat a title the body already opens with', () => {
    const md = parseHtmlToMarkdown(
      '<html><head><title>Q3 Review</title></head><body><h1>Q3 Review</h1><p>Body.</p></body></html>',
    )

    expect(md.match(/Q3 Review/g)).toHaveLength(1)
  })

  it('decodes entities rather than leaking them into the brain', () => {
    const md = parseHtmlToMarkdown('<html><body><p>Tea &amp; Co &mdash; 5 &lt; 6</p></body></html>')

    expect(md).toContain('Tea & Co')
    expect(md).toContain('5 < 6')
  })

  it('strips inline base64 payloads but keeps the alt text', () => {
    // The incident's report embedded 43 screenshots this way; Turndown copies a
    // data URI into `![alt](…)` verbatim, so the payload became 98% of the
    // extracted "document" and pushed the real content past the segment cap.
    const payload = 'A'.repeat(50_000)
    const md = parseHtmlToMarkdown(
      `<html><body><p>Before.</p><img alt="ChatGPT result" src="data:image/jpeg;base64,${payload}"><p>After.</p></body></html>`,
    )

    expect(md).not.toContain(payload)
    expect(md).not.toContain('base64,')
    expect(md).toContain('ChatGPT result')
    expect(md).toContain('Before.')
    expect(md).toContain('After.')
    expect(md.length).toBeLessThan(200)
  })

  it('leaves ordinary image URLs alone', () => {
    const md = parseHtmlToMarkdown(
      '<html><body><img alt="Chart" src="https://example.com/chart.png"></body></html>',
    )

    expect(md).toContain('https://example.com/chart.png')
  })

  it('shrinks a stylesheet-heavy document to its actual content', () => {
    const bulky = `<html><head><style>${'.a{color:#fff}'.repeat(20_000)}</style></head><body><p>One sentence.</p></body></html>`
    const md = parseHtmlToMarkdown(bulky)

    expect(md).toBe('One sentence.')
  })

  it('degrades to flattened text instead of throwing on an oversized document', () => {
    // Past DOM_MAX_CHARS the DOM path is skipped; text must still come through.
    const huge = `<html><body>${'<p>Paragraph body.</p>'.repeat(500_000)}</body></html>`
    const md = parseHtmlToMarkdown(huge)

    expect(md.length).toBeGreaterThan(0)
    expect(md).toContain('Paragraph body.')
    expect(md).not.toContain('<p>')
  })

  it('returns empty for a document with no readable text', () => {
    expect(parseHtmlToMarkdown('<html><head><script>x=1</script></head><body></body></html>')).toBe('')
  })

  it('drops form chrome but keeps the document around it', () => {
    const md = parseHtmlToMarkdown(
      '<body><form><input value="x"><select><option>All regions</option></select><button>Submit</button></form><p>Real text</p></body>',
    )
    expect(md).toContain('Real text')
    expect(md).not.toContain('Submit')
    expect(md).not.toContain('All regions')
  })
})

describe('[COMP:files/html-extract] shape guards', () => {
  // DOM_MAX_CHARS bounds memory; these bound CPU. Turndown recurses per element
  // and is superlinear in node count, so both inputs below are far under the
  // 8 MB character ceiling and still cost seconds-to-minutes without a guard
  // (50k nesting levels measured at 273 s before overflowing the stack). The
  // degraded path keeps every word — a ceiling may shape what reaches the model,
  // never what reaches storage.

  it('degrades deep nesting to flattened text instead of recursing into it', () => {
    const deep = `${'<div>'.repeat(1_200)}buried treasure${'</div>'.repeat(1_200)}`
    const md = parseHtmlToMarkdown(deep)
    expect(md).toContain('buried treasure')
  })

  it('degrades a node-dense document without losing a single word', () => {
    const wide = '<p>alpha</p>'.repeat(20_001) // 40,002 '<' occurrences
    const md = parseHtmlToMarkdown(wide)
    expect(md.split('alpha').length - 1).toBe(20_001)
  })

  it('still drops stylesheets on the degraded path', () => {
    const wide = `<style>.x{color:red}</style><h2>Section</h2>${'<p>body</p>'.repeat(20_001)}`
    const md = parseHtmlToMarkdown(wide)
    expect(md).toContain('Section')
    expect(md).not.toContain('color:red')
  })

  it('keeps an ordinary large document on the Markdown path', () => {
    const big = `<body>${'<p>A sentence of perfectly normal prose.</p>'.repeat(500)}</body>`
    expect(parseHtmlToMarkdown(big)).toContain('A sentence of perfectly normal prose.')
  })
})

describe('[COMP:files/html-extract] HTML detection', () => {
  it('matches the MIME types and extensions browsers actually send', () => {
    expect(isHtmlFile('text/html', 'report.html')).toBe(true)
    expect(isHtmlFile('text/html; charset=utf-8', 'report.html')).toBe(true)
    expect(isHtmlFile('application/xhtml+xml', 'report.xhtml')).toBe(true)
    // Some platforms report a bare text/plain for a saved page.
    expect(isHtmlFile('text/plain', 'report.htm')).toBe(true)
  })

  it('leaves plain text and markdown on the generic text path', () => {
    expect(isHtmlFile('text/plain', 'notes.txt')).toBe(false)
    expect(isHtmlFile('text/markdown', 'notes.md')).toBe(false)
    expect(isHtmlFile('application/json', 'data.json')).toBe(false)
  })
})

describe('[COMP:files/parsers] parseFileContent HTML routing', () => {
  it('routes text/html through the extractor, not the raw text/* branch', async () => {
    const parsed = await parseFileContent(Buffer.from(PAGE, 'utf-8'), 'text/html', 'plan.html')

    expect(parsed.text).not.toContain('<style>')
    expect(parsed.text).toContain('## Stage 1')
    expect(parsed.summary).toContain('Web page: plan.html')
  })

  it('reports a page that renders entirely through scripts instead of returning nothing', async () => {
    const shell = '<html><head><title>App</title></head><body><div id="root"></div><script>boot()</script></body></html>'
    const parsed = await parseFileContent(Buffer.from(shell, 'utf-8'), 'text/html', 'app.html')

    // A bare title is still text, so the honest signal is the short body — what
    // must never happen is `boot()` landing in the brain as knowledge.
    expect(parsed.text).not.toContain('boot()')
  })
})
