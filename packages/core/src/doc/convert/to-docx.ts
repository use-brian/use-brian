/**
 * Doc `Block[]` → Microsoft Word `.docx` writer — the high-fidelity export
 * spoke of the conversion hub (docs/architecture/features/doc-conversion.md
 * §4.1). Unlike Markdown, docx is generated **directly** from blocks (not via
 * a Markdown intermediate) because callouts, tables, and toggles have no
 * Markdown form and would be lost through one.
 *
 * Node-only: pulls the `docx` package (a heavy pure-JS writer), so it lives in
 * `core` rather than the browser-safe `doc-model`. Inline emphasis comes from
 * the shared `extractInlineSegments` walker, so docx and Markdown emphasis can
 * never disagree.
 *
 * Snapshot semantics: a live `data` block resolves through `opts.resolveData`
 * (injected at the API layer) or renders an italic placeholder; charts emit a
 * static table of the model's inline numbers; diagrams emit their Mermaid
 * source as a code block (image rendering is a documented follow-up). Lists
 * use manual prefixes ("•" / "1." / checkbox) rather than live Word numbering
 * — robust, config-free, and correct for a snapshot.
 *
 * [COMP:doc/to-docx]
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import type {
  Block,
  ChartBlock,
  DataBlock,
  MediaRef,
  Page,
  RichTextContent,
  TableBlock,
} from '../page-types.js'
import { extractInlineSegments, type InlineSegment } from '../rich-text.js'

export interface BlocksToDocxOptions {
  /** Document title — emitted as the leading Title paragraph when present. */
  title?: string
  /** Resolve a live `data` block to a static grid of cell text (row-major,
   *  row 0 = header). Injected at the API layer; placeholder when omitted. */
  resolveData?: (block: DataBlock) => string[][] | undefined
  /** Resolve a stored media ref to a URL for a hyperlink. */
  resolveMediaUrl?: (ref: MediaRef) => string | undefined
}

type Child = Paragraph | Table

const HEADING_LEVELS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
} as const

// ── Inline runs ────────────────────────────────────────────────────────

/** One inline segment → a docx run (a hyperlink when it carries a link). */
function runFromSegment(seg: InlineSegment): TextRun | ExternalHyperlink {
  const base = {
    text: seg.text,
    bold: seg.bold || undefined,
    italics: seg.italic || undefined,
    strike: seg.strike || undefined,
    ...(seg.code ? { font: 'Courier New' } : {}),
  }
  if (seg.link) {
    return new ExternalHyperlink({
      link: seg.link,
      children: [new TextRun({ ...base, color: '0563C1', underline: {} })],
    })
  }
  return new TextRun(base)
}

function richRuns(rt: RichTextContent | undefined): (TextRun | ExternalHyperlink)[] {
  const segs = extractInlineSegments(rt)
  if (segs.length === 0) return [new TextRun('')]
  return segs.map(runFromSegment)
}

function plainRuns(text: string): TextRun[] {
  return [new TextRun(text)]
}

// ── Tables ───────────────────────────────────────────────────────────

function gridTable(rows: (TextRun | ExternalHyperlink)[][][], hasHeaderRow: boolean): Table {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (cells, r) =>
        new TableRow({
          tableHeader: hasHeaderRow && r === 0,
          children: Array.from(
            { length: width },
            (_u, c) =>
              new TableCell({
                children: [new Paragraph({ children: cells[c] ?? [new TextRun('')] })],
              }),
          ),
        }),
    ),
  })
}

function tableBlockToDocx(block: TableBlock): Table {
  // `hasHeaderColumn` is not separately expressible in docx's row-header model
  // (documented limit); the header ROW is honored via `tableHeader`.
  const rows = block.rows.map((row) => row.map((cell) => richRuns(cell)))
  return gridTable(rows, !!block.hasHeaderRow)
}

/** Plain-text grid (from a resolved data block) → a docx table. */
function textGridToDocx(grid: string[][]): Table {
  const rows = grid.map((row) => row.map((cell) => [new TextRun(cell)]))
  return gridTable(rows, true)
}

function chartToDocx(block: ChartBlock): Child[] {
  const out: Child[] = []
  if (block.title) out.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(block.title)] }))
  const d = block.data
  if (!d) {
    out.push(new Paragraph({ children: [new TextRun({ text: '[Live chart]', italics: true })] }))
    return out
  }
  if (block.chartType === 'kpi' && d.value !== undefined) {
    const delta = d.delta !== undefined ? ` (${d.delta >= 0 ? '+' : ''}${d.delta})` : ''
    out.push(new Paragraph({ children: [new TextRun({ text: `${d.value}${delta}`, bold: true })] }))
  } else if ((block.chartType === 'bar' || block.chartType === 'pie') && d.points?.length) {
    const grid = [['Label', 'Value'], ...d.points.map((p) => [p.label, String(p.value)])]
    out.push(textGridToDocx(grid))
  } else if (block.chartType === 'line' && d.series?.length) {
    const grid = [['Series', 'X', 'Y']]
    for (const s of d.series) for (const pt of s.points) grid.push([s.name, String(pt.x), String(pt.y)])
    out.push(textGridToDocx(grid))
  }
  return out
}

// ── Block → docx element(s) ─────────────────────────────────────────────

function blockToDocx(block: Block, ordinal: number, opts: BlocksToDocxOptions): Child[] {
  switch (block.kind) {
    case 'text':
      return [new Paragraph({ children: plainRuns(block.text ?? '') })]
    case 'heading':
      return [new Paragraph({ heading: HEADING_LEVELS[block.level], children: plainRuns(block.text ?? '') })]
    case 'divider':
      return [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: 'BBBBBB' } },
          children: [],
        }),
      ]
    case 'code':
      return (block.code ?? '').split('\n').map(
        (line) => new Paragraph({ children: [new TextRun({ text: line, font: 'Courier New' })] }),
      )
    case 'quote':
      return [new Paragraph({ indent: { left: 480 }, children: richRuns(block.richText).map((r) => r) })]
    case 'callout':
      return [
        new Paragraph({
          indent: { left: 480 },
          shading: { fill: 'F3F3F1' },
          children: [new TextRun(`${block.icon} `), ...richRuns(block.richText)],
        }),
      ]
    case 'toggle':
      return [new Paragraph({ children: richRuns(block.richText).map((r) => r) })]
    case 'bulleted_list_item':
      return [new Paragraph({ children: [new TextRun('•\t'), ...richRuns(block.richText)] })]
    case 'numbered_list_item':
      return [new Paragraph({ children: [new TextRun(`${ordinal}.\t`), ...richRuns(block.richText)] })]
    case 'to_do':
      return [new Paragraph({ children: [new TextRun(block.checked ? '☑\t' : '☐\t'), ...richRuns(block.richText)] })]
    case 'table':
      return [tableBlockToDocx(block)]
    case 'data': {
      const grid = opts.resolveData?.(block)
      return grid && grid.length
        ? [textGridToDocx(grid)]
        : [new Paragraph({ children: [new TextRun({ text: '[Live data view]', italics: true })] })]
    }
    case 'chart':
      return chartToDocx(block)
    case 'diagram':
      return [
        new Paragraph({ children: [new TextRun({ text: 'Diagram (mermaid)', italics: true })] }),
        ...block.code.split('\n').map(
          (line) => new Paragraph({ children: [new TextRun({ text: line, font: 'Courier New' })] }),
        ),
      ]
    case 'image': {
      const url = block.ref ? opts.resolveMediaUrl?.(block.ref) ?? block.ref.path : undefined
      const label = block.alt || block.ref?.name || 'image'
      return [linkOrPlain(`[Image: ${label}]`, url, label)]
    }
    case 'file': {
      const url = block.ref ? opts.resolveMediaUrl?.(block.ref) ?? block.ref.path : undefined
      const name = block.ref?.name || 'file'
      return [linkOrPlain(`[File: ${name}]`, url, name)]
    }
    case 'bookmark':
      return [linkOrPlain(block.meta?.title || block.url, block.url || undefined, block.meta?.title || block.url)]
    case 'video':
    case 'audio':
      return [linkOrPlain(block.caption || block.url, block.url || undefined, block.caption || block.url)]
    case 'child_page':
      return [linkOrPlain('Sub-page', `/p/${block.childPageId}`, 'Sub-page')]
    default:
      return []
  }
}

/** A hyperlink paragraph when a URL is present, else an italic placeholder. */
function linkOrPlain(placeholder: string, url: string | undefined, label: string): Paragraph {
  if (!url) return new Paragraph({ children: [new TextRun({ text: placeholder, italics: true })] })
  return new Paragraph({
    children: [
      new ExternalHyperlink({ link: url, children: [new TextRun({ text: label, color: '0563C1', underline: {} })] }),
    ],
  })
}

/**
 * Serialize a page (or raw block list) to a `.docx` byte buffer. Consecutive
 * numbered-list items get sequential ordinals; the ordinal resets when a
 * non-numbered block breaks the run.
 */
export async function blocksToDocx(
  page: Page | Block[],
  opts: BlocksToDocxOptions = {},
): Promise<Buffer> {
  const blocks = Array.isArray(page) ? page : page.blocks
  const children: Child[] = []
  if (opts.title?.trim()) {
    children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(opts.title.trim())] }))
  }
  let ordinal = 1
  for (const block of blocks) {
    if (block.kind === 'numbered_list_item') {
      children.push(...blockToDocx(block, ordinal, opts))
      ordinal += 1
    } else {
      // Any non-numbered block breaks the run, so the next list restarts at 1.
      ordinal = 1
      children.push(...blockToDocx(block, 1, opts))
    }
  }
  const doc = new Document({
    sections: [{ children: children.length ? children : [new Paragraph({ children: [] })] }],
  })
  return Packer.toBuffer(doc)
}
