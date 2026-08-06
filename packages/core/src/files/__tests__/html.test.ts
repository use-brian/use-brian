import { describe, it, expect } from 'vitest'
import { htmlToMarkdown, exceedsEstimatedHtmlNestingDepth } from '../html.js'
import { parseFileContent } from '../parsers.js'

/**
 * The regression these cover: an `.html` upload reached `file_segments` as raw
 * markup, so the first segment of a real 4.1 MB report was `<!doctype html>`
 * plus the opening of its stylesheet and the second was pure CSS.
 */
describe('[COMP:files/html] htmlToMarkdown', () => {
  it('converts document structure to Markdown', async () => {
    const { markdown, mode } = await htmlToMarkdown(
      '<html><body><h1>Quarterly report</h1><p>Revenue rose.</p>' +
        '<ul><li>Alpha</li><li>Beta</li></ul></body></html>',
    )
    expect(mode).toBe('dom')
    expect(markdown).toContain('# Quarterly report')
    expect(markdown).toContain('Revenue rose.')
    expect(markdown).toContain('-   Alpha')
  })

  it('drops the stylesheet instead of indexing it as content', async () => {
    const { markdown } = await htmlToMarkdown(
      '<html><head><style>:root{--ink:#1A1A1A}body{margin:0}</style></head>' +
        '<body><p>Real content.</p></body></html>',
    )
    expect(markdown).toBe('Real content.')
    expect(markdown).not.toContain('--ink')
    expect(markdown).not.toContain('margin')
  })

  it('drops scripts, noscript, iframes and inline SVG', async () => {
    const { markdown } = await htmlToMarkdown(
      '<body><script>var x=1;alert(x)</script><noscript>Enable JS</noscript>' +
        '<iframe src="https://example.com"></iframe><svg><path d="M0 0"/></svg>' +
        '<p>Kept.</p></body>',
    )
    expect(markdown).toBe('Kept.')
  })

  it('keeps the title separately rather than as body text', async () => {
    const { title } = await htmlToMarkdown(
      '<html><head><title>  Friso  Briefing </title></head><body><p>Body</p></body></html>',
    )
    expect(title).toBe('Friso Briefing')
  })

  it('converts tables to GFM rather than dropping them', async () => {
    const { markdown } = await htmlToMarkdown(
      '<body><table><thead><tr><th>Batch</th><th>Result</th></tr></thead>' +
        '<tbody><tr><td>1W07KPJ</td><td>Exceeded</td></tr></tbody></table></body>',
    )
    expect(markdown).toContain('| Batch | Result |')
    expect(markdown).toContain('| 1W07KPJ | Exceeded |')
  })

  it('keeps image alt text but never copies a data: URI into the Markdown', async () => {
    const dataUri = `data:image/png;base64,${'A'.repeat(5000)}`
    const { markdown } = await htmlToMarkdown(
      `<body><img alt="Revenue chart" src="${dataUri}"><p>After</p></body>`,
    )
    expect(markdown).toContain('![Revenue chart]')
    expect(markdown).not.toContain('base64')
    expect(markdown.length).toBeLessThan(200)
  })

  it('keeps an ordinary image URL as provenance', async () => {
    const { markdown } = await htmlToMarkdown(
      '<body><img alt="Logo" src="https://example.com/logo.png"></body>',
    )
    expect(markdown).toContain('![Logo](https://example.com/logo.png)')
  })

  it('converts a fragment with no <body>', async () => {
    const { markdown } = await htmlToMarkdown('<h2>Fragment</h2><p>Text</p>')
    expect(markdown).toContain('## Fragment')
    expect(markdown).toContain('Text')
  })

  it('degrades to a textual strip on pathologically nested markup', async () => {
    const html = `${'<div>'.repeat(4000)}Deep content${'</div>'.repeat(4000)}`
    const { markdown, mode } = await htmlToMarkdown(html)
    expect(mode).toBe('stripped')
    expect(markdown).toContain('Deep content')
  })

  it('removes a stylesheet in the stripped path too', async () => {
    const html = `<style>body{color:red}</style>${'<div>'.repeat(4000)}Deep${'</div>'.repeat(4000)}`
    const { markdown, mode } = await htmlToMarkdown(html)
    expect(mode).toBe('stripped')
    expect(markdown).not.toContain('color:red')
    expect(markdown).toContain('Deep')
  })
})

describe('[COMP:files/html] exceedsEstimatedHtmlNestingDepth', () => {
  it('passes ordinary documents', () => {
    expect(exceedsEstimatedHtmlNestingDepth('<div><p>hi</p></div>', 3000)).toBe(false)
  })

  it('catches unbounded nesting', () => {
    expect(exceedsEstimatedHtmlNestingDepth('<div>'.repeat(3001), 3000)).toBe(true)
  })

  it('does not count void elements as depth', () => {
    expect(exceedsEstimatedHtmlNestingDepth('<br>'.repeat(5000), 10)).toBe(false)
  })
})

describe('[COMP:files/html] parseFileContent HTML routing', () => {
  const page =
    '<html><head><title>Implementation plan</title>' +
    '<style>.progress{position:fixed;inset:0 0 auto;height:3px}</style></head>' +
    '<body><h2>Stage 1</h2><p>Ship the safety hub.</p></body></html>'

  it('routes text/html to the Markdown converter, not the raw text branch', async () => {
    const { text, summary } = await parseFileContent(Buffer.from(page), 'text/html', 'plan.html')
    expect(text).not.toContain('<!')
    expect(text).not.toContain('position:fixed')
    expect(text).toContain('## Stage 1')
    expect(text).toContain('Ship the safety hub.')
    expect(summary).toContain('Web page: plan.html')
  })

  it('prepends the document title when the body does not open with a heading', async () => {
    const { text } = await parseFileContent(
      Buffer.from('<html><head><title>Briefing</title></head><body><p>Body</p></body></html>'),
      'text/html',
      'x.html',
    )
    expect(text.startsWith('# Briefing')).toBe(true)
  })

  it('routes by extension when the mime is generic', async () => {
    const { text } = await parseFileContent(
      Buffer.from(page),
      'application/octet-stream',
      'report.HTML',
    )
    expect(text).toContain('## Stage 1')
    expect(text).not.toContain('position:fixed')
  })

  it('routes application/xhtml+xml the same way', async () => {
    const { text } = await parseFileContent(Buffer.from(page), 'application/xhtml+xml', 'p.xhtml')
    expect(text).toContain('## Stage 1')
  })

  it('returns an honest placeholder when a page yields no text', async () => {
    const { text } = await parseFileContent(
      Buffer.from('<html><head><style>a{}</style></head><body><script>1</script></body></html>'),
      'text/html',
      'empty.html',
    )
    expect(text).toContain('No extractable text')
    expect(text).toContain('empty.html')
  })

  it('shrinks a style-heavy document by an order of magnitude', async () => {
    const bloated =
      `<html><head><style>${'.a{color:#000;padding:0}'.repeat(20000)}</style></head>` +
      '<body><h1>Title</h1><p>One short paragraph.</p></body></html>'
    const { text } = await parseFileContent(Buffer.from(bloated), 'text/html', 'bloat.html')
    expect(bloated.length).toBeGreaterThan(400_000)
    expect(text.length).toBeLessThan(200)
  })
})

describe('[COMP:files/parsers] CSV routing', () => {
  const csv = 'name,qty\nwidget,2\ngadget,3\n'

  it('reports rows for a text/csv upload, which the text/ branch used to swallow', async () => {
    const { summary, text } = await parseFileContent(Buffer.from(csv), 'text/csv', 'order.csv')
    expect(summary).toBe('CSV: order.csv (4 rows)')
    expect(text).toBe(csv)
  })

  it('matches the extension case-insensitively', async () => {
    const { summary } = await parseFileContent(
      Buffer.from(csv),
      'application/octet-stream',
      'ORDER.CSV',
    )
    expect(summary).toContain('CSV: ORDER.CSV')
  })
})

describe('[COMP:files/parsers] RTF', () => {
  const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Times;}}\f0\fs24 Hello.\par}`

  it('refuses rather than indexing control words as content', async () => {
    const { text, placeholder } = await parseFileContent(Buffer.from(rtf), 'text/rtf', 'memo.rtf')
    expect(placeholder).toBe(true)
    expect(text).not.toContain('fonttbl')
    expect(text).toContain('re-save as .docx or PDF')
  })

  it('matches application/rtf and the extension too', async () => {
    expect((await parseFileContent(Buffer.from(rtf), 'application/rtf', 'a.rtf')).placeholder).toBe(true)
    expect((await parseFileContent(Buffer.from(rtf), 'application/octet-stream', 'B.RTF')).placeholder).toBe(true)
  })
})
