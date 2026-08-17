/** Safe Brian-owned DOCX import/export/reparse adapter. [COMP:office/docx-engine] */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type JSZip from 'jszip'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeightRule,
  HeadingLevel,
  ImageRun,
  type IBorderOptions,
  type ITableBordersOptions,
  type ITableCellBorders,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
} from 'docx'
import {
  assertOfficeArtifactSnapshot,
  preflightOfficeCandidate,
  type DocumentFlowNode,
  type DocumentSnapshot,
  type OfficePreflightDiagnostic,
  type OfficeRichTextRun,
  type OfficeResourceRef,
  type OfficeTableBorder,
  type OfficeTableBorders,
  type OfficeTableCellMargins,
} from '@use-brian/office-model'
import { layoutOfficeArtifact } from '@use-brian/office-renderer'
import {
  attachCanonicalOfficePart,
  decodeXmlText,
  officeSemanticHash,
  preflightOfficePackage,
  readCanonicalOfficePart,
  stableOfficeUuid,
  type OfficeImportContext,
  type OfficeImportResult,
  type OfficeResourceResolver,
} from '../package.js'

const headingLevels = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
} as const

function color(value: string): string {
  return value.replace('#', '').slice(0, 6)
}

function richChildren(runs: readonly OfficeRichTextRun[]): Array<TextRun | ExternalHyperlink> {
  if (runs.length === 0) return [new TextRun('')]
  return runs.map((run) => {
    const child = new TextRun({
      text: run.text,
      font: run.style.fontFamily,
      size: Math.round(run.style.fontSizePt * 2),
      bold: run.style.bold || undefined,
      italics: run.style.italic || undefined,
      underline: run.style.underline ? {} : undefined,
      strike: run.style.strike || undefined,
      color: color(run.style.color),
    })
    return run.href ? new ExternalHyperlink({ link: run.href, children: [child] }) : child
  })
}

async function headerImageRun(image: NonNullable<DocumentSnapshot['sections'][number]['headerImage']>, resolveResource: OfficeResourceResolver): Promise<ImageRun> {
  const payload = await resolveResource(image.resourceId)
  if (!payload) throw new Error(`Missing or unsupported header image resource ${image.resourceId}`)
  const normalized = payload.mime === 'image/svg+xml' ? { type: 'png' as const, data: await sharp(payload.bytes).png().toBuffer() } : { type: imageType(payload.mime), data: payload.bytes }
  if (!normalized.type) throw new Error(`Missing or unsupported header image resource ${image.resourceId}`)
  return new ImageRun({
    type: normalized.type,
    data: normalized.data,
    altText: { title: image.altText || 'Header image', description: image.altText, name: image.altText || 'Header image' },
    transformation: { width: Math.round(image.widthPt * 96 / 72), height: Math.round(image.heightPt * 96 / 72) },
  })
}

function paragraphAlignment(value: 'start' | 'center' | 'end' | 'justify' | undefined): typeof AlignmentType.LEFT | typeof AlignmentType.CENTER | typeof AlignmentType.RIGHT | typeof AlignmentType.JUSTIFIED {
  return value === 'center' ? AlignmentType.CENTER : value === 'end' ? AlignmentType.RIGHT : value === 'justify' ? AlignmentType.JUSTIFIED : AlignmentType.LEFT
}

function docxBorderStyle(value: OfficeTableBorder['style']): IBorderOptions['style'] {
  return value === 'none' ? BorderStyle.NONE : value === 'dotted' ? BorderStyle.DOTTED : value === 'dashed' ? BorderStyle.DASHED : value === 'double' ? BorderStyle.DOUBLE : BorderStyle.SINGLE
}

function docxBorder(value: OfficeTableBorder | undefined): IBorderOptions | undefined {
  return value ? { style: docxBorderStyle(value.style), color: color(value.color), size: Math.max(0, Math.round(value.widthPt * 8)) } : undefined
}

function docxTableBorders(value: OfficeTableBorders | undefined): ITableBordersOptions | undefined {
  if (!value) return undefined
  return {
    top: docxBorder(value.top),
    right: docxBorder(value.right),
    bottom: docxBorder(value.bottom),
    left: docxBorder(value.left),
    insideHorizontal: docxBorder(value.insideHorizontal),
    insideVertical: docxBorder(value.insideVertical),
  }
}

function docxCellBorders(value: OfficeTableBorders | undefined): ITableCellBorders | undefined {
  if (!value) return undefined
  return { top: docxBorder(value.top), right: docxBorder(value.right), bottom: docxBorder(value.bottom), left: docxBorder(value.left) }
}

function docxCellMargins(value: OfficeTableCellMargins | undefined): { marginUnitType: typeof WidthType.DXA; top: number; right: number; bottom: number; left: number } | undefined {
  return value ? {
    marginUnitType: WidthType.DXA,
    top: Math.round(value.topPt * 20),
    right: Math.round(value.rightPt * 20),
    bottom: Math.round(value.bottomPt * 20),
    left: Math.round(value.leftPt * 20),
  } : undefined
}

function tableFromNode(node: Extract<DocumentFlowNode, { kind: 'table' }>): Table {
  const widthPt = node.widthPt ?? node.columnWidthsPt?.reduce((sum, width) => sum + width, 0)
  return new Table({
    width: widthPt ? { size: Math.round(widthPt * 20), type: WidthType.DXA } : { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: node.columnWidthsPt?.map((width) => Math.round(width * 20)),
    layout: node.layout === 'autofit' ? TableLayoutType.AUTOFIT : node.layout === 'fixed' || node.columnWidthsPt ? TableLayoutType.FIXED : undefined,
    alignment: paragraphAlignment(node.alignment),
    indent: node.indentPt === undefined ? undefined : { size: Math.round(node.indentPt * 20), type: WidthType.DXA },
    margins: docxCellMargins(node.margins),
    borders: docxTableBorders(node.borders),
    rows: node.rows.map((row, rowIndex) => new TableRow({
      tableHeader: rowIndex < node.headerRows,
      height: row.minHeightPt === undefined ? undefined : { value: Math.round(row.minHeightPt * 20), rule: HeightRule.ATLEAST },
      children: row.cells.map((cell) => new TableCell({
        columnSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
        shading: cell.fill ? { fill: color(cell.fill), type: ShadingType.CLEAR } : undefined,
        margins: docxCellMargins(cell.margins),
        verticalAlign: cell.verticalAlignment === 'middle' ? VerticalAlignTable.CENTER : cell.verticalAlignment === 'bottom' ? VerticalAlignTable.BOTTOM : VerticalAlignTable.TOP,
        borders: docxCellBorders(cell.borders),
        children: [new Paragraph({ alignment: paragraphAlignment(cell.alignment), children: richChildren(cell.runs) })],
      })),
    })),
  })
}

function chartFromNode(node: Extract<DocumentFlowNode, { kind: 'chart' }>): Array<Paragraph | Table> {
  const rows = [
    new TableRow({ tableHeader: true, children: [new TableCell({ children: [new Paragraph('Category')] }), ...node.series.map((series) => new TableCell({ children: [new Paragraph(series.name)] }))] }),
    ...node.categories.map((category, index) => new TableRow({ children: [new TableCell({ children: [new Paragraph(category)] }), ...node.series.map((series) => new TableCell({ children: [new Paragraph(String(series.values[index] ?? ''))] }))] })),
  ]
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(node.title)] }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
  ]
}

function imageType(mime: string): 'png' | 'jpg' | null {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  return null
}

async function nodeChildren(node: DocumentFlowNode, resolveResource: OfficeResourceResolver): Promise<Array<Paragraph | Table>> {
  if (node.kind === 'paragraph') {
    const alignment = node.alignment === 'start' ? AlignmentType.LEFT : node.alignment === 'end' ? AlignmentType.RIGHT : node.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.JUSTIFIED
    return [new Paragraph({ alignment, spacing: paragraphSpacing(node), children: richChildren(node.runs) })]
  }
  if (node.kind === 'heading') return [new Paragraph({ heading: headingLevels[node.level as keyof typeof headingLevels], alignment: paragraphAlignment(node.alignment), spacing: paragraphSpacing(node), children: richChildren(node.runs) })]
  if (node.kind === 'list') return node.items.map((item, index) => new Paragraph({ children: [new TextRun(`${node.ordered ? `${index + 1}.` : '•'}\t`), ...richChildren(item.runs)] }))
  if (node.kind === 'table') return [tableFromNode(node)]
  if (node.kind === 'chart') return chartFromNode(node)
  if (node.kind === 'pageBreak' || node.kind === 'sectionBreak') return [new Paragraph({ children: [new PageBreak()] })]
  if (node.kind === 'image') {
    const payload = await resolveResource(node.resourceId)
    if (!payload) throw new Error(`Missing or unsupported image resource ${node.resourceId}`)
    const normalized = payload.mime === 'image/svg+xml' ? { type: 'png' as const, data: await sharp(payload.bytes).png().toBuffer() } : { type: imageType(payload.mime), data: payload.bytes }
    if (!normalized.type) throw new Error(`Missing or unsupported image resource ${node.resourceId}`)
    return [new Paragraph({ children: [new ImageRun({ type: normalized.type, data: normalized.data, altText: { title: node.altText || 'Decorative image', description: node.altText, name: node.altText || 'Decorative image' }, transformation: { width: Math.round(node.widthPt * 96 / 72), height: Math.round(node.heightPt * 96 / 72) } })] })]
  }
  if (node.kind === 'video') {
    if (!node.recipientAccessibleUrl) throw new Error(`DOCX video ${node.id} requires a recipient-accessible HTTPS link`)
    const poster = await resolveResource(node.posterResourceId)
    if (!poster) throw new Error(`Missing video poster resource ${node.posterResourceId}`)
    const normalizedPoster = poster.mime === 'image/svg+xml' ? { type: 'png' as const, data: await sharp(poster.bytes).png().toBuffer() } : { type: imageType(poster.mime), data: poster.bytes }
    if (!normalizedPoster.type) throw new Error(`Missing video poster resource ${node.posterResourceId}`)
    return [
      new Paragraph({ children: [new ImageRun({ type: normalizedPoster.type, data: normalizedPoster.data, altText: { title: node.altText, description: node.altText, name: node.altText }, transformation: { width: 640, height: 360 } })] }),
      new Paragraph({ children: [new ExternalHyperlink({ link: node.recipientAccessibleUrl, children: [new TextRun({ text: `Watch video: ${node.altText}`, color: '0563C1', underline: {} })] })] }),
    ]
  }
  return []
}

function paragraphSpacing(node: Extract<DocumentFlowNode, { kind: 'paragraph' | 'heading' }>): { before?: number; after?: number; line?: number } {
  return {
    before: Math.round((node.spacingBeforePt ?? 0) * 20),
    after: Math.round((node.spacingAfterPt ?? 8) * 20),
    line: node.lineSpacingPt === undefined ? undefined : Math.round(node.lineSpacingPt * 20),
  }
}

export type OfficeExportReceipt = {
  bytes: Buffer
  semanticHash: string
  layoutSerialization: string
  diagnostics: OfficePreflightDiagnostic[]
}

export async function exportOfficeDocument(
  input: DocumentSnapshot,
  resolveResource: OfficeResourceResolver = async () => null,
): Promise<OfficeExportReceipt> {
  const snapshot = assertOfficeArtifactSnapshot(input)
  if (snapshot.family !== 'document') throw new Error('DOCX export requires a Document snapshot')
  const preflight = preflightOfficeCandidate(snapshot)
  const layout = layoutOfficeArtifact(snapshot)
  const diagnostics = [...preflight.diagnostics, ...layout.issues.map((issue) => ({ severity: 'error' as const, code: `layout.${issue.code}`, path: issue.objectId, message: issue.message }))]
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) throw new Error(`DOCX preflight failed: ${diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join('; ')}`)

  const sections = []
  for (const section of snapshot.sections) {
    const children: Array<Paragraph | Table> = []
    for (const node of section.nodes) children.push(...await nodeChildren(node, resolveResource))
    const headerChildren: Array<TextRun | ExternalHyperlink | ImageRun> = []
    if (section.headerImage) {
      headerChildren.push(await headerImageRun(section.headerImage, resolveResource))
      if (section.header.length) headerChildren.push(new TextRun('\t'))
    }
    headerChildren.push(...richChildren(section.header))
    sections.push({
      properties: {
        page: {
          size: { width: Math.round(section.page.widthPt * 20), height: Math.round(section.page.heightPt * 20) },
          margin: { top: Math.round(section.page.marginTopPt * 20), right: Math.round(section.page.marginRightPt * 20), bottom: Math.round(section.page.marginBottomPt * 20), left: Math.round(section.page.marginLeftPt * 20) },
        },
      },
      headers: headerChildren.length ? { default: new Header({ children: [new Paragraph({
        alignment: paragraphAlignment(section.headerAlignment),
        border: section.headerBorderBottom ? { bottom: { style: BorderStyle.SINGLE, color: color(section.headerBorderBottom.color), size: Math.max(1, Math.round(section.headerBorderBottom.widthPt * 8)), space: 6 } } : undefined,
        children: headerChildren,
      })] }) } : undefined,
      footers: section.footer.length || section.showPageNumber ? { default: new Footer({ children: [new Paragraph({
        alignment: paragraphAlignment(section.footerAlignment),
        border: section.footerBorderTop ? { top: { style: BorderStyle.SINGLE, color: color(section.footerBorderTop.color), size: Math.max(1, Math.round(section.footerBorderTop.widthPt * 8)), space: 6 } } : undefined,
        children: [...richChildren(section.footer), ...(section.showPageNumber ? [new TextRun(' '), new TextRun({ children: [PageNumber.CURRENT] })] : [])],
      })] }) } : undefined,
      children: children.length ? children : [new Paragraph('')],
    })
  }
  const doc = new Document({ title: snapshot.title, description: snapshot.accessibility.description, sections })
  const raw = await Packer.toBuffer(doc)
  return { bytes: await attachCanonicalOfficePart(raw, snapshot), semanticHash: officeSemanticHash(snapshot), layoutSerialization: layout.serialization, diagnostics }
}

function defaultStyle() {
  return { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' }
}

function textFromWordXml(xml: string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXmlText(match[1])).join('')
}

function xmlValue(xml: string, tag: string, attribute = 'w:val'): string | undefined {
  return xml.match(new RegExp(`<${tag}[^>]*${attribute}="([^"]+)"`, 'i'))?.[1]
}

function onOff(xml: string, tag: string): boolean {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?\\/?>(?:<\\/${tag}>)?`, 'i'))
  return Boolean(match) && !/w:val="(?:0|false|off|none)"/i.test(match?.[0] ?? '')
}

function richRunsFromWordXml(xml: string, seed: string): OfficeRichTextRun[] {
  const runs = [...xml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)].flatMap((match, index) => {
    const fragment = match[1]
    const text = textFromWordXml(fragment)
    if (!text) return []
    const fontFamily = xmlValue(fragment, 'w:rFonts', 'w:ascii') ?? 'Arial'
    const sizeHalfPoints = Number(xmlValue(fragment, 'w:sz') ?? 22)
    const rawColor = xmlValue(fragment, 'w:color')
    const colorValue = rawColor && /^[0-9A-Fa-f]{6}$/.test(rawColor) ? `#${rawColor}` : '#111111'
    return [{
      id: stableOfficeUuid(`${seed}:run:${index}`),
      text,
      style: {
        fontFamily,
        fontSizePt: sizeHalfPoints / 2,
        bold: onOff(fragment, 'w:b'),
        italic: onOff(fragment, 'w:i'),
        underline: Boolean(fragment.match(/<w:u\b/i)) && xmlValue(fragment, 'w:u') !== 'none',
        strike: onOff(fragment, 'w:strike'),
        color: colorValue,
      },
    }]
  })
  return runs.length ? runs : [{ id: stableOfficeUuid(`${seed}:run:0`), text: textFromWordXml(xml), style: defaultStyle() }]
}

function alignmentFromWordXml(xml: string): 'start' | 'center' | 'end' | 'justify' {
  const value = xmlValue(xml, 'w:jc')
  return value === 'center' ? 'center' : value === 'right' || value === 'end' ? 'end' : value === 'both' || value === 'distribute' ? 'justify' : 'start'
}

function paragraphProperties(xml: string): string {
  return xml.match(/<w:pPr(?:\s[^>]*)?>([\s\S]*?)<\/w:pPr>/i)?.[1] ?? ''
}

function styleFragments(stylesXml: string): Map<string, string> {
  const styles = new Map<string, string>()
  for (const match of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = match[1].match(/w:styleId="([^"]+)"/)?.[1]
    if (id) styles.set(id, match[2])
  }
  return styles
}

function effectiveParagraphFormat(fragment: string, styleFragment = ''): { alignment: 'start' | 'center' | 'end' | 'justify'; spacingBeforePt: number; spacingAfterPt: number; lineSpacingPt?: number } {
  const direct = paragraphProperties(fragment)
  const inherited = paragraphProperties(styleFragment)
  const twips = (attribute: 'w:before' | 'w:after' | 'w:line', fallback?: number): number | undefined => {
    const value = xmlValue(direct, 'w:spacing', attribute) ?? xmlValue(inherited, 'w:spacing', attribute)
    return value === undefined ? fallback : Number(value) / 20
  }
  const directAlignment = xmlValue(direct, 'w:jc')
  const alignment = directAlignment ? alignmentFromWordXml(direct) : alignmentFromWordXml(inherited)
  return { alignment, spacingBeforePt: twips('w:before', 0) ?? 0, spacingAfterPt: twips('w:after', 8) ?? 8, lineSpacingPt: twips('w:line') }
}

function textParagraphAlignment(xml: string): 'start' | 'center' | 'end' {
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((match) => match[0])
    .filter((paragraph) => textFromWordXml(paragraph).trim())
  const alignment = alignmentFromWordXml(paragraphs.at(-1) ?? xml)
  return alignment === 'center' ? 'center' : alignment === 'end' ? 'end' : 'start'
}

function partTarget(relsXml: string, relationshipId: string, base: string): string | null {
  const relationship = [...relsXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)].find((match) => match[0].includes(`Id="${relationshipId}"`))?.[0]
  const target = relationship?.match(/Target="([^"]+)"/)?.[1]
  if (!target || target.includes('..')) return null
  return target.startsWith('/') ? target.slice(1) : `${base}/${target}`.replaceAll('//', '/')
}

function sectionRelationshipId(xml: string, kind: 'header' | 'footer', type: 'first' | 'default'): string | undefined {
  return [...xml.matchAll(new RegExp(`<w:${kind}Reference\\b[^>]*>`, 'g'))]
    .map((match) => match[0])
    .find((tag) => tag.includes(`w:type="${type}"`))
    ?.match(/r:id="([^"]+)"/)?.[1]
}

function borderFromXml(xml: string, edge: 'top' | 'bottom'): { color: `#${string}`; widthPt: number } | undefined {
  const tag = xml.match(new RegExp(`<w:${edge}\\b[^>]*>`, 'i'))?.[0]
  if (!tag || /w:val="(?:nil|none)"/i.test(tag)) return undefined
  const rawColor = tag.match(/w:color="([0-9A-Fa-f]{6})"/)?.[1]
  if (!rawColor) return undefined
  return { color: `#${rawColor}`, widthPt: Number(tag.match(/w:sz="(\d+)"/)?.[1] ?? 8) / 8 }
}

type DocumentTableNode = Extract<DocumentFlowNode, { kind: 'table' }>
type DocumentTableCell = DocumentTableNode['rows'][number]['cells'][number]

function wordContainer(xml: string, tag: string): string {
  return xml.match(new RegExp(`<w:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/w:${tag}>`, 'i'))?.[1] ?? ''
}

function wordColor(raw: string | undefined): `#${string}` | undefined {
  return raw && /^[0-9A-Fa-f]{6}$/.test(raw) ? `#${raw}` : undefined
}

function wordTableBorder(tag: string | undefined): OfficeTableBorder | undefined {
  if (!tag) return undefined
  const value = tag.match(/w:val="([^"]+)"/i)?.[1] ?? 'single'
  const rawColor = tag.match(/w:color="([^"]+)"/i)?.[1]
  const style: OfficeTableBorder['style'] = value === 'nil' || value === 'none' ? 'none' : value === 'double' ? 'double' : value === 'dotted' ? 'dotted' : /dash/i.test(value) ? 'dashed' : 'solid'
  return { color: wordColor(rawColor) ?? '#000000', widthPt: style === 'none' ? 0 : Number(tag.match(/w:sz="(\d+)"/i)?.[1] ?? 8) / 8, style }
}

function wordTableBorders(xml: string, containerTag: 'tblBorders' | 'tcBorders'): OfficeTableBorders | undefined {
  const container = wordContainer(xml, containerTag)
  if (!container) return undefined
  const edge = (name: string) => wordTableBorder(container.match(new RegExp(`<w:${name}\\b[^>]*\\/?>`, 'i'))?.[0])
  const result: OfficeTableBorders = {
    top: edge('top'),
    right: edge('end') ?? edge('right'),
    bottom: edge('bottom'),
    left: edge('start') ?? edge('left'),
    insideHorizontal: edge('insideH'),
    insideVertical: edge('insideV'),
  }
  return Object.values(result).some(Boolean) ? result : undefined
}

function wordCellMargins(xml: string, containerTag: 'tblCellMar' | 'tcMar', inherited?: OfficeTableCellMargins): OfficeTableCellMargins | undefined {
  const container = wordContainer(xml, containerTag)
  if (!container) return undefined
  const measure = (primary: string, alternate: string | undefined, fallback: number): number => {
    const tag = container.match(new RegExp(`<w:${primary}\\b[^>]*\\/?>`, 'i'))?.[0] ?? (alternate ? container.match(new RegExp(`<w:${alternate}\\b[^>]*\\/?>`, 'i'))?.[0] : undefined)
    const value = Number(tag?.match(/w:w="(-?\d+)"/i)?.[1])
    return Number.isFinite(value) ? Math.max(0, value / 20) : fallback
  }
  return {
    topPt: measure('top', undefined, inherited?.topPt ?? 0),
    rightPt: measure('end', 'right', inherited?.rightPt ?? 5.4),
    bottomPt: measure('bottom', undefined, inherited?.bottomPt ?? 0),
    leftPt: measure('start', 'left', inherited?.leftPt ?? 5.4),
  }
}

function wordVerticalAlignment(xml: string): DocumentTableCell['verticalAlignment'] {
  const value = xmlValue(xml, 'w:vAlign')
  return value === 'center' ? 'middle' : value === 'bottom' ? 'bottom' : value === 'top' ? 'top' : undefined
}

function parseWordTable(fragment: string, id: string): DocumentTableNode {
  if (/<w:tc(?:\s[^>]*)?>[\s\S]*?<w:tbl\b/i.test(fragment)) throw new Error('Nested Word tables are outside the supported Office subset')
  const properties = wordContainer(fragment, 'tblPr')
  const columnWidthsPt = [...wordContainer(fragment, 'tblGrid').matchAll(/<w:gridCol\b[^>]*w:w="(\d+)"[^>]*\/?\s*>/gi)]
    .map((match) => Number(match[1]) / 20)
    .filter((width) => Number.isFinite(width) && width > 0)
  const tableMargins = wordCellMargins(properties, 'tblCellMar')
  const rowFragments = [...fragment.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map((match) => match[1])
  let headerRows = 0
  while (headerRows < rowFragments.length && onOff(wordContainer(rowFragments[headerRows], 'trPr'), 'w:tblHeader')) headerRows += 1

  let activeVerticalMerges = new Map<number, DocumentTableCell>()
  const rows = rowFragments.map((rowFragment, rowIndex) => {
    const cells: DocumentTableCell[] = []
    const nextVerticalMerges = new Map<number, DocumentTableCell>()
    const continued = new Set<string>()
    let column = 0
    for (const [cellIndex, match] of [...rowFragment.matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].entries()) {
      const cellFragment = match[1]
      const cellProperties = wordContainer(cellFragment, 'tcPr')
      const colSpan = Math.max(1, Number(xmlValue(cellProperties, 'w:gridSpan') ?? 1))
      const verticalMergeTag = cellProperties.match(/<w:vMerge\b[^>]*\/?\s*>/i)?.[0]
      const verticalMergeValue = verticalMergeTag?.match(/w:val="([^"]+)"/i)?.[1]
      if (verticalMergeTag && verticalMergeValue !== 'restart') {
        const origin = activeVerticalMerges.get(column)
        if (origin) {
          if (!continued.has(origin.id)) {
            origin.rowSpan += 1
            continued.add(origin.id)
          }
          for (let offset = 0; offset < colSpan; offset += 1) nextVerticalMerges.set(column + offset, origin)
          column += colSpan
          continue
        }
      }
      const fill = wordColor(xmlValue(cellProperties, 'w:shd', 'w:fill'))
      const cell: DocumentTableCell = {
        id: stableOfficeUuid(`${id}:row:${rowIndex}:cell:${cellIndex}`),
        runs: richRunsFromWordXml(cellFragment, `${id}:row:${rowIndex}:cell:${cellIndex}`),
        rowSpan: 1,
        colSpan,
        fill,
        alignment: alignmentFromWordXml(cellFragment),
        verticalAlignment: wordVerticalAlignment(cellProperties),
        margins: wordCellMargins(cellProperties, 'tcMar', tableMargins),
        borders: wordTableBorders(cellProperties, 'tcBorders'),
        wrapText: !/<w:noWrap\b/i.test(cellProperties),
      }
      cells.push(cell)
      if (verticalMergeValue === 'restart') for (let offset = 0; offset < colSpan; offset += 1) nextVerticalMerges.set(column + offset, cell)
      column += colSpan
    }
    activeVerticalMerges = nextVerticalMerges
    const height = Number(xmlValue(wordContainer(rowFragment, 'trPr'), 'w:trHeight')) / 20
    return {
      id: stableOfficeUuid(`${id}:row:${rowIndex}`),
      minHeightPt: Number.isFinite(height) && height > 0 ? height : undefined,
      cells,
    }
  })
  const gridWidthPt = columnWidthsPt.reduce((sum, width) => sum + width, 0)
  const declaredWidth = Number(xmlValue(properties, 'w:tblW', 'w:w')) / 20
  const declaredWidthType = xmlValue(properties, 'w:tblW', 'w:type')
  const widthPt = declaredWidthType === 'dxa' && Number.isFinite(declaredWidth) && declaredWidth > 0 ? declaredWidth : gridWidthPt || undefined
  const alignment = alignmentFromWordXml(properties)
  const indent = Number(xmlValue(properties, 'w:tblInd', 'w:w')) / 20
  return {
    id,
    kind: 'table',
    headerRows,
    columnWidthsPt: columnWidthsPt.length ? columnWidthsPt : undefined,
    widthPt,
    alignment: alignment === 'justify' ? 'start' : alignment,
    indentPt: Number.isFinite(indent) ? indent : undefined,
    layout: xmlValue(properties, 'w:tblLayout', 'w:type') === 'fixed' ? 'fixed' : 'autofit',
    margins: tableMargins,
    borders: wordTableBorders(properties, 'tblBorders'),
    rows,
  }
}

async function headerImageFromWordXml(zip: JSZip, partPath: string, xml: string, context: OfficeImportContext): Promise<{ image?: NonNullable<DocumentSnapshot['sections'][number]['headerImage']>; resource?: OfficeImportResult['resources'][number] }> {
  const relationshipId = xml.match(/<a:blip[^>]*r:embed="([^"]+)"/)?.[1]
  if (!relationshipId) return {}
  const slash = partPath.lastIndexOf('/')
  const folder = partPath.slice(0, slash)
  const name = partPath.slice(slash + 1)
  const relsPath = `${folder}/_rels/${name}.rels`
  const relsXml = await zip.file(relsPath)?.async('string')
  if (!relsXml) return {}
  const target = partTarget(relsXml, relationshipId, folder)
  const entry = target ? zip.file(target) : null
  if (!entry || !target) return {}
  const bytes = new Uint8Array(await entry.async('uint8array'))
  const hash = createHash('sha256').update(bytes).digest('hex')
  const id = stableOfficeUuid(`${context.artifactId}:${target}:${hash}`)
  const extension = target.toLowerCase().split('.').pop()
  const mime = extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'svg' ? 'image/svg+xml' : 'application/octet-stream'
  const extent = xml.match(/<wp:extent[^>]*cx="(\d+)"[^>]*cy="(\d+)"/)
  const altText = xml.match(/<wp:docPr[^>]*(?:descr|title)="([^"]*)"/)?.[1] ?? 'Header image'
  const ref: OfficeResourceRef = { id, kind: 'image', hash, mime, sensitivity: 'internal' }
  return {
    image: { resourceId: id, altText, decorative: !altText, widthPt: Number(extent?.[1] ?? 381_000) / 12_700, heightPt: Number(extent?.[2] ?? 381_000) / 12_700 },
    resource: { ref, bytes, sourcePart: target },
  }
}

async function externalDocumentSnapshot(zip: JSZip, xml: string, context: OfficeImportContext): Promise<{ snapshot: DocumentSnapshot; resources: OfficeImportResult['resources'] }> {
  const body = xml.match(/<w:body(?:\s[^>]*)?>([\s\S]*?)<\/w:body>/)?.[1] ?? ''
  const styles = styleFragments(await zip.file('word/styles.xml')?.async('string') ?? '')
  const nodes: DocumentFlowNode[] = []
  let ordinal = 0
  for (const match of body.matchAll(/<(w:p|w:tbl)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g)) {
    const fragment = match[0]
    const id = stableOfficeUuid(`${context.artifactId}:docx:${ordinal}`)
    ordinal += 1
    if (match[1] === 'w:tbl') {
      nodes.push(parseWordTable(fragment, id))
      continue
    }
    if (/<w:br[^>]*w:type="page"/.test(fragment)) {
      nodes.push({ id, kind: 'pageBreak' })
      continue
    }
    const text = textFromWordXml(fragment)
    if (!text && !/<w:p\b/.test(fragment)) continue
    const styleName = xmlValue(fragment, 'w:pStyle') ?? 'Body'
    const heading = styleName.match(/^Heading\s*([1-6])$/i)
    const runs = richRunsFromWordXml(fragment, id)
    const format = effectiveParagraphFormat(fragment, styles.get(styleName))
    nodes.push(heading ? { id, kind: 'heading', level: Number(heading[1]), styleName, runs, ...format } : { id, kind: 'paragraph', styleName, runs, ...format })
  }
  const documentRels = await zip.file('word/_rels/document.xml.rels')?.async('string') ?? ''
  const hasDistinctFirstPage = /<w:titlePg\b/.test(body)
  const preferredReferenceType = hasDistinctFirstPage ? 'first' : 'default'
  const headerId = sectionRelationshipId(xml, 'header', preferredReferenceType) ?? sectionRelationshipId(xml, 'header', 'default')
  const footerId = sectionRelationshipId(xml, 'footer', preferredReferenceType) ?? sectionRelationshipId(xml, 'footer', 'default')
  const headerPath = headerId ? partTarget(documentRels, headerId, 'word') : null
  const footerPath = footerId ? partTarget(documentRels, footerId, 'word') : null
  const headerXml = headerPath ? await zip.file(headerPath)?.async('string') ?? '' : ''
  const footerXml = footerPath ? await zip.file(footerPath)?.async('string') ?? '' : ''
  const headerImage = headerPath ? await headerImageFromWordXml(zip, headerPath, headerXml, context) : {}
  const sectionProperties = body.match(/<w:sectPr(?:\s[^>]*)?>([\s\S]*?)<\/w:sectPr>/)?.[1] ?? ''
  const widthPt = Number(xmlValue(sectionProperties, 'w:pgSz', 'w:w') ?? 12_240) / 20
  const heightPt = Number(xmlValue(sectionProperties, 'w:pgSz', 'w:h') ?? 15_840) / 20
  const margin = (name: 'top' | 'right' | 'bottom' | 'left', fallback: number) => Number(xmlValue(sectionProperties, 'w:pgMar', `w:${name}`) ?? fallback * 20) / 20
  const snapshot: DocumentSnapshot = {
    schemaVersion: 1,
    capabilityVersion: 1,
    artifactId: context.artifactId,
    workspaceId: context.workspaceId,
    family: 'document',
    locale: context.locale,
    defaultLanguage: context.defaultLanguage,
    templateVersionId: context.templateVersionId,
    rootId: stableOfficeUuid(`${context.artifactId}:root`),
    title: context.title,
    resources: headerImage.resource ? [headerImage.resource.ref] : [],
    accessibility: { title: context.title },
    sections: [{
      id: stableOfficeUuid(`${context.artifactId}:section:0`),
      page: { widthPt, heightPt, marginTopPt: margin('top', 72), marginRightPt: margin('right', 72), marginBottomPt: margin('bottom', 72), marginLeftPt: margin('left', 72), orientation: xmlValue(sectionProperties, 'w:pgSz', 'w:orient') === 'landscape' ? 'landscape' : 'portrait' },
      header: richRunsFromWordXml(headerXml, `${context.artifactId}:header`).filter((run) => run.text),
      footer: richRunsFromWordXml(footerXml, `${context.artifactId}:footer`).filter((run) => run.text),
      headerImage: headerImage.image,
      headerAlignment: textParagraphAlignment(headerXml),
      footerAlignment: textParagraphAlignment(footerXml),
      headerBorderBottom: borderFromXml(headerXml, 'bottom'),
      footerBorderTop: borderFromXml(footerXml, 'top'),
      showPageNumber: /<w:fldSimple[^>]*w:instr="[^"]*PAGE|<w:instrText[^>]*>\s*PAGE\b/i.test(footerXml),
      nodes,
    }],
  }
  return { snapshot, resources: headerImage.resource ? [headerImage.resource] : [] }
}

export async function importOfficeDocument(bytes: Uint8Array, context: OfficeImportContext): Promise<OfficeImportResult> {
  const packageResult = await preflightOfficePackage(bytes, 'document')
  if (!packageResult.ok || !packageResult.zip) return { ok: false, diagnostics: packageResult.diagnostics, resources: [] }
  try {
    const canonical = await readCanonicalOfficePart(packageResult.zip, 'document')
    const external = canonical ? null : await externalDocumentSnapshot(packageResult.zip, await packageResult.zip.file('word/document.xml')!.async('string'), context)
    const snapshot = canonical ?? external!.snapshot
    const model = preflightOfficeCandidate(snapshot)
    const diagnostics = [...packageResult.diagnostics, ...model.diagnostics]
    return { ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), snapshot, resources: external?.resources ?? [], diagnostics }
  } catch (cause) {
    return { ok: false, resources: [], diagnostics: [...packageResult.diagnostics, { severity: 'error', code: 'docx.import_failed', path: 'word/document.xml', message: cause instanceof Error ? cause.message : 'DOCX import failed' }] }
  }
}

export async function reparseOfficeDocument(bytes: Uint8Array): Promise<{ snapshot: DocumentSnapshot; semanticHash: string; layoutSerialization: string }> {
  const packageResult = await preflightOfficePackage(bytes, 'document')
  if (!packageResult.ok || !packageResult.zip) throw new Error(`DOCX reparse failed: ${packageResult.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`)
  const canonical = await readCanonicalOfficePart(packageResult.zip, 'document')
  if (!canonical || canonical.family !== 'document') throw new Error('DOCX reparse requires the Brian canonical part')
  return { snapshot: canonical, semanticHash: officeSemanticHash(canonical), layoutSerialization: layoutOfficeArtifact(canonical).serialization }
}

export function compareOfficeDocumentRoundTrip(source: DocumentSnapshot, reparsed: DocumentSnapshot): OfficePreflightDiagnostic[] {
  return officeSemanticHash(source) === officeSemanticHash(reparsed) ? [] : [{ severity: 'error', code: 'docx.semantic_mismatch', path: '', message: 'DOCX reparse does not match the canonical source snapshot' }]
}

export * from './pdf.js'
