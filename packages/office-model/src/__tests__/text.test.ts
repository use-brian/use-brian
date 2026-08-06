/**
 * [COMP:office/artifact-text] — flattening a snapshot to its readable text.
 *
 * This walker is what the brand claim gate reads, so a node kind it silently
 * skips is a node kind the gate stops covering. The tests that matter are
 * therefore the coverage ones: every text-bearing container appears, and alt
 * text is included (a prohibited claim hidden in an image description still
 * ships to the customer and is still read aloud).
 *
 * Fixture data is invented.
 */

import { describe, it, expect } from 'vitest'
import { collectArtifactText } from '../text.js'
import { documentFixture, presentationFixture, spreadsheetFixture } from './fixtures.js'
import type { DocumentSnapshot, PresentationSnapshot } from '../model.js'

const id = (suffix: number): string => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
const style = { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' }
const run = (n: number, text: string) => ({ id: id(n), text, style })

const texts = (fragments: { text: string }[]) => fragments.map((f) => f.text)

describe('[COMP:office/artifact-text] documents', () => {
  it('includes the title and paragraph runs', () => {
    const out = collectArtifactText(documentFixture())
    expect(texts(out)).toContain('Quarterly update')
    expect(texts(out)).toContain('A grounded update.')
  })

  it('walks headings, lists, tables, headers, footers, charts, and alt text', () => {
    const doc = documentFixture() as DocumentSnapshot
    const section = doc.sections[0]
    section.header = [run(100, 'Header line')]
    section.footer = [run(101, 'Footer line')]
    section.nodes.push(
      { id: id(102), kind: 'heading', level: 1, styleName: 'H1', runs: [run(103, 'A heading')] },
      { id: id(104), kind: 'list', ordered: false, level: 0, items: [{ id: id(105), runs: [run(106, 'A bullet')] }] },
      {
        id: id(107), kind: 'table', headerRows: 1,
        rows: [{ id: id(108), cells: [{ id: id(109), runs: [run(110, 'A cell')], rowSpan: 1, colSpan: 1 }] }],
      },
      { id: id(111), kind: 'image', resourceId: id(112), altText: 'Described image', decorative: false, widthPt: 100, heightPt: 100 },
      { id: id(113), kind: 'chart', chartType: 'bar', title: 'Chart title', categories: ['Q1'], series: [{ name: 'S', values: [1] }], altText: 'Chart alt' },
    )
    const out = texts(collectArtifactText(doc))
    for (const expected of ['Header line', 'Footer line', 'A heading', 'A bullet', 'A cell', 'Described image', 'Chart title', 'Chart alt', 'Q1']) {
      expect(out).toContain(expected)
    }
  })

  it('skips a decorative image, which is announced to nobody', () => {
    const doc = documentFixture() as DocumentSnapshot
    doc.sections[0].nodes.push(
      { id: id(120), kind: 'image', resourceId: id(121), altText: 'ignored', decorative: true, widthPt: 10, heightPt: 10 },
    )
    expect(texts(collectArtifactText(doc))).not.toContain('ignored')
  })

  it('locates a fragment by section', () => {
    const out = collectArtifactText(documentFixture())
    const body = out.find((f) => f.text === 'A grounded update.')
    // "somewhere in this document" is not actionable; "section 1" is.
    expect(body?.locator).toBe('section 1')
  })
})

describe('[COMP:office/artifact-text] presentations', () => {
  it('walks slide text and reports the slide number', () => {
    const out = collectArtifactText(presentationFixture())
    const hit = out.find((f) => f.text === 'Company pitch')
    expect(hit?.locator).toBe('slide 1')
  })

  it('walks shape text and shape alt text', () => {
    const deck = presentationFixture() as PresentationSnapshot
    deck.slides[0].objects.push({
      id: id(200), kind: 'shape', shape: 'rectangle',
      geometry: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
      locked: false, strokeWidthPt: 1,
      text: [run(201, 'Shape label')], altText: 'Shape description',
    })
    deck.slides[0].readingOrder.push(id(200))
    const out = texts(collectArtifactText(deck))
    expect(out).toContain('Shape label')
    expect(out).toContain('Shape description')
  })
})

describe('[COMP:office/artifact-text] spreadsheets', () => {
  it('includes string cell values, addressed by sheet and cell', () => {
    const sheet = spreadsheetFixture()
    sheet.worksheets[0].cells.push({
      id: id(500), address: 'A5', valueType: 'string',
      value: 'The safest crossing available.', style: {}, locked: false,
    })
    const out = collectArtifactText(sheet)
    const hit = out.find((f) => f.text === 'The safest crossing available.')
    expect(hit?.locator).toBe('Invoice!A5')
  })

  it('omits numeric cells, which carry no claim', () => {
    const sheet = spreadsheetFixture()
    const numeric = sheet.worksheets[0].cells.filter((c) => typeof c.value === 'number')
    const out = collectArtifactText(sheet)
    for (const cell of numeric) {
      expect(out.some((f) => f.locator.endsWith(`!${cell.address}`))).toBe(false)
    }
  })
})

describe('[COMP:office/artifact-text] hygiene', () => {
  it('drops empty and whitespace-only fragments', () => {
    const doc = documentFixture() as DocumentSnapshot
    doc.sections[0].nodes.push({ id: id(300), kind: 'paragraph', styleName: 'Body', runs: [run(301, '   ')] })
    expect(collectArtifactText(doc).every((f) => f.text.trim().length > 0)).toBe(true)
  })

  it('joins runs within one block so a claim split across runs is still one string', () => {
    // Bold-ing two words mid-sentence splits the sentence into three runs. If
    // the walker emitted them separately, a phrase matcher would never see the
    // sentence — which is exactly how a claim gate silently stops working.
    const doc = documentFixture() as DocumentSnapshot
    doc.sections[0].nodes.push({
      id: id(400), kind: 'paragraph', styleName: 'Body',
      runs: [run(401, 'We are the '), { ...run(402, 'safest'), style: { ...style, bold: true } }, run(403, ' crossing available.')],
    })
    expect(texts(collectArtifactText(doc))).toContain('We are the safest crossing available.')
  })
})
