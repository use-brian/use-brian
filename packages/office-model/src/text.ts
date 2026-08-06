/**
 * Flatten an Office artifact snapshot to its human-readable text.
 *
 * Lives in `office-model` because that package owns the snapshot shape: a
 * walker anywhere else silently stops seeing new node kinds the moment one is
 * added here, and "the check quietly stopped covering tables" is not a failure
 * anything would notice.
 *
 * The output is a list of `{ text, locator }` fragments rather than one blob,
 * so a caller that finds something can say WHERE — a release warning that
 * names slide 4 is actionable, one that says "somewhere in this deck" is not.
 *
 * ## What counts as text
 *
 * Everything a reader sees or a screen reader announces: rich-text runs
 * (paragraphs, headings, list items, table cells, slide text and shape
 * labels), section headers and footers, chart titles and category labels, and
 * alt text. Alt text is deliberately included — a prohibited claim hidden in
 * an image description still ships to the customer and is still read aloud.
 *
 * Spreadsheet cells contribute their `value` when it is a string. A numeric
 * cell has no claim in it, and `calculatedValue` is derived, so including
 * either would only add noise.
 *
 * [COMP:office/artifact-text]
 */

import type { OfficeArtifactSnapshot, OfficeRichTextRun } from './model.js'

export type ArtifactTextFragment = {
  /** The visible text. */
  text: string
  /** Where it came from, e.g. `slide 4`, `section 1`, `Sheet1!B7`. */
  locator: string
}

function runsToText(runs: readonly OfficeRichTextRun[] | undefined): string {
  if (!runs || runs.length === 0) return ''
  return runs.map((r) => r.text).join('')
}

function push(out: ArtifactTextFragment[], text: string, locator: string): void {
  const trimmed = text.trim()
  if (trimmed.length > 0) out.push({ text: trimmed, locator })
}

export function collectArtifactText(snapshot: OfficeArtifactSnapshot): ArtifactTextFragment[] {
  const out: ArtifactTextFragment[] = []
  push(out, snapshot.title, 'title')

  if (snapshot.family === 'document') {
    for (const [i, section] of snapshot.sections.entries()) {
      const where = `section ${i + 1}`
      push(out, runsToText(section.header), `${where} header`)
      push(out, runsToText(section.footer), `${where} footer`)
      if (section.headerImage && !section.headerImage.decorative) {
        push(out, section.headerImage.altText, `${where} header image`)
      }
      for (const node of section.nodes) {
        switch (node.kind) {
          case 'paragraph':
          case 'heading':
            push(out, runsToText(node.runs), where)
            break
          case 'list':
            for (const item of node.items) push(out, runsToText(item.runs), `${where} list`)
            break
          case 'table':
            for (const row of node.rows) {
              for (const cell of row.cells) push(out, runsToText(cell.runs), `${where} table`)
            }
            break
          case 'image':
            // A decorative image is announced to nobody; its alt text is empty
            // by contract and carries no claim.
            if (!node.decorative) push(out, node.altText, `${where} image`)
            break
          case 'chart':
            push(out, node.title, `${where} chart`)
            push(out, node.altText, `${where} chart`)
            for (const category of node.categories) push(out, category, `${where} chart`)
            break
          case 'video':
            push(out, node.altText, `${where} video`)
            if (node.transcript) push(out, node.transcript, `${where} video transcript`)
            break
          default:
            // pageBreak / sectionBreak carry no text.
            break
        }
      }
    }
    return out
  }

  if (snapshot.family === 'presentation') {
    for (const [i, slide] of snapshot.slides.entries()) {
      const where = `slide ${i + 1}`
      for (const object of slide.objects) {
        switch (object.kind) {
          case 'text':
            push(out, runsToText(object.runs), where)
            break
          case 'shape':
            push(out, runsToText(object.text), where)
            if (object.altText) push(out, object.altText, `${where} shape`)
            break
          case 'image':
            if (!object.decorative) push(out, object.altText, `${where} image`)
            break
          case 'table':
            for (const row of object.rows) {
              for (const cell of row.cells) push(out, runsToText(cell.runs), `${where} table`)
            }
            break
          case 'chart':
            push(out, object.title, `${where} chart`)
            push(out, object.altText, `${where} chart`)
            for (const category of object.categories) push(out, category, `${where} chart`)
            break
          case 'video':
            push(out, object.altText, `${where} video`)
            if (object.transcript) push(out, object.transcript, `${where} video transcript`)
            break
          default:
            // `connector` is a line between shapes; it carries no text.
            break
        }
      }
    }
    return out
  }

  for (const sheet of snapshot.worksheets) {
    for (const cell of sheet.cells) {
      // Only authored string values. A number carries no claim, and
      // `calculatedValue` is derived from cells already walked.
      if (typeof cell.value === 'string') push(out, cell.value, `${sheet.name}!${cell.address}`)
    }
  }
  return out
}
