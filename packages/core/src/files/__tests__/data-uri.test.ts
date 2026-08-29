import { describe, it, expect } from 'vitest'
import { stripDataUris } from '../data-uri.js'

// The two shapes that reach ingest. Inline is what a saved HTML page and an
// ordinary Markdown image produce; reference-style is what Google Docs writes
// when a document is downloaded as Markdown — every image collected into
// definitions at the end of the file, which is how 119 of them became 99.5% of
// the ESN Oulu Survival Guide.
const INLINE = '![Toripolliisi](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC8AAAAG)'
const REFERENCE = '[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC8AAAAG>'

describe('[COMP:files/data-uri] stripDataUris', () => {
  it('drops an inline base64 payload and keeps the alt text', () => {
    const out = stripDataUris(INLINE)
    expect(out).toBe('![Toripolliisi](data:image/png)')
    expect(out).not.toContain('iVBORw0KGgo')
  })

  it('drops a reference-style definition payload', () => {
    expect(stripDataUris(REFERENCE)).toBe('[image1]: <data:image/png>')
  })

  it('strips every payload in a document, not just the first', () => {
    const doc = `# Guide\n\n${INLINE}\n\nProse in between.\n\n${INLINE}\n`
    const out = stripDataUris(doc)
    expect(out).toContain('Prose in between.')
    expect(out).not.toContain('iVBORw0KGgo')
    expect(out.match(/data:image\/png/g)).toHaveLength(2)
  })

  it('is idempotent — a second pass changes nothing', () => {
    const once = stripDataUris(INLINE)
    expect(stripDataUris(once)).toBe(once)
  })

  it('leaves prose, ordinary URLs and code alone', () => {
    const text = [
      'Buses in Oulu: you wave at the driver.',
      'See https://www.vr.fi/en/ for trains.',
      '`const data = "base64"` is not a data URI.',
    ].join('\n')
    expect(stripDataUris(text)).toBe(text)
  })

  it('leaves a non-base64 data URI intact — that payload is readable content', () => {
    const svg = '![chart](data:image/svg+xml,<svg><title>Segments</title></svg>)'
    expect(stripDataUris(svg)).toBe(svg)
  })

  it('collapses a document that is almost entirely image bytes', () => {
    // The incident's shape at 1/1000 scale: prose, then a payload block.
    const prose = '# ESN Oulu Survival Guide\n\nAutumn 2022\n'
    const payload = `[image1]: <data:image/png;base64,${'A'.repeat(50_000)}>`
    const out = stripDataUris(`${prose}\n${payload}`)
    expect(out).toContain('ESN Oulu Survival Guide')
    expect(out.length).toBeLessThan(prose.length + 60)
  })
})
