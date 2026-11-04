/** Safe Brian-owned DOCX import/export/reparse adapter. [COMP:office/docx-engine] */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type JSZip from 'jszip'
import {
  AlignmentType,
  type IRunOptions,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeightRule,
  LineRuleType,
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
  Tab,
  CarriageReturn,
  VerticalAlignTable,
  WidthType,
  UnderlineType,
} from 'docx'
import {
  assertOfficeArtifactSnapshot,
  officeTableColumnCount,
  officeCellParagraphs,
  documentNumberedParagraphs,
  OfficeNumberingSchema,
  type OfficeNumbering,
  type OfficeParagraphFormat,
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
      children: run.text.split(/(\t|\n)/).filter(Boolean).map((part) => part === '\t' ? new Tab() : part === '\n' ? new CarriageReturn() : part),
      font: { ascii: run.style.fontFamily, hAnsi: run.style.fontFamily, eastAsia: run.style.eastAsianFontFamily ?? run.style.fontFamily },
      size: Math.round(run.style.fontSizePt * 2),
      scale: run.style.widthScalePercent,
      bold: run.style.bold,
      italics: run.style.italic,
      underline: run.style.underline ? {} : { type: UnderlineType.NONE },
      strike: run.style.strike,
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
  return value ? { style: value.widthPt === 0 ? BorderStyle.NONE : docxBorderStyle(value.style), color: color(value.color), size: Math.max(0, Math.round(value.widthPt * 8)) } : undefined
}

function docxTableBorders(value: OfficeTableBorders | undefined): ITableBordersOptions | undefined {
  if (!value) return undefined
  return {
    top: docxBorder(value.top) ?? { style: BorderStyle.NONE },
    right: docxBorder(value.right) ?? { style: BorderStyle.NONE },
    bottom: docxBorder(value.bottom) ?? { style: BorderStyle.NONE },
    left: docxBorder(value.left) ?? { style: BorderStyle.NONE },
    insideHorizontal: docxBorder(value.insideHorizontal) ?? { style: BorderStyle.NONE },
    insideVertical: docxBorder(value.insideVertical) ?? { style: BorderStyle.NONE },
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

/** Even split of the section content width, summing exactly to `totalDxa`. */
function evenColumnsDxa(count: number, totalDxa: number): number[] {
  const base = Math.floor(totalDxa / count)
  return Array.from({ length: count }, (_u, index) => (index === 0 ? totalDxa - base * (count - 1) : base))
}

function tableFromNode(node: Extract<DocumentFlowNode, { kind: 'table' }>, contentWidthDxa: number): Table {
  const widthPt = node.widthPt ?? node.columnWidthsPt?.reduce((sum, width) => sum + width, 0)
  // Widths must stay absolute (DXA): the docx library serializes
  // `WidthType.PERCENTAGE` as the string form (`w:w="100%"`), which older
  // LibreOffice builds parse as fiftieths of a percent, a 2%-wide table.
  return new Table({
    width: { size: widthPt ? Math.round(widthPt * 20) : contentWidthDxa, type: WidthType.DXA },
    columnWidths: node.columnWidthsPt?.map((width) => Math.round(width * 20))
      ?? evenColumnsDxa(officeTableColumnCount(node), widthPt ? Math.round(widthPt * 20) : contentWidthDxa),
    layout: node.layout === 'autofit' ? TableLayoutType.AUTOFIT : node.layout === 'fixed' || node.columnWidthsPt ? TableLayoutType.FIXED : undefined,
    alignment: paragraphAlignment(node.alignment),
    indent: node.indentPt === undefined ? undefined : { size: Math.round(node.indentPt * 20), type: WidthType.DXA },
    margins: docxCellMargins(node.margins),
    borders: docxTableBorders(node.borders ?? (node.rows.some((row) => row.cells.some((cell) => cell.borders)) ? {} : undefined)),
    rows: node.rows.map((row, rowIndex) => new TableRow({
      tableHeader: rowIndex < node.headerRows,
      height: row.minHeightPt === undefined ? undefined : { value: Math.round(row.minHeightPt * 20), rule: row.heightRule === 'exact' ? HeightRule.EXACT : HeightRule.ATLEAST },
      children: row.cells.map((cell) => new TableCell({
        columnSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
        shading: cell.fill ? { fill: color(cell.fill), type: ShadingType.CLEAR } : undefined,
        margins: docxCellMargins(cell.margins),
        verticalAlign: cell.verticalAlignment === 'middle' ? VerticalAlignTable.CENTER : cell.verticalAlignment === 'bottom' ? VerticalAlignTable.BOTTOM : VerticalAlignTable.TOP,
        borders: docxCellBorders(cell.borders),
        children: officeCellParagraphs(cell).map(({ format, runs }) => new Paragraph({ alignment: paragraphAlignment(format.alignment), ...paragraphNumbering(format), spacing: paragraphSpacing({ spacingAfterPt: 0, ...format }), children: richChildren(runs) })),
      })),
    })),
  })
}

function chartFromNode(node: Extract<DocumentFlowNode, { kind: 'chart' }>, contentWidthDxa: number): Array<Paragraph | Table> {
  const rows = [
    new TableRow({ tableHeader: true, children: [new TableCell({ children: [new Paragraph('Category')] }), ...node.series.map((series) => new TableCell({ children: [new Paragraph(series.name)] }))] }),
    ...node.categories.map((category, index) => new TableRow({ children: [new TableCell({ children: [new Paragraph(category)] }), ...node.series.map((series) => new TableCell({ children: [new Paragraph(String(series.values[index] ?? ''))] }))] })),
  ]
  return [
    new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(node.title)] }),
    new Table({
      width: { size: contentWidthDxa, type: WidthType.DXA },
      columnWidths: evenColumnsDxa(node.series.length + 1, contentWidthDxa),
      rows,
    }),
  ]
}

function imageType(mime: string): 'png' | 'jpg' | null {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/jpeg') return 'jpg'
  return null
}

async function nodeChildren(node: DocumentFlowNode, resolveResource: OfficeResourceResolver, contentWidthDxa: number): Promise<Array<Paragraph | Table>> {
  if (node.kind === 'paragraph') {
    const alignment = node.alignment === 'start' ? AlignmentType.LEFT : node.alignment === 'end' ? AlignmentType.RIGHT : node.alignment === 'center' ? AlignmentType.CENTER : AlignmentType.JUSTIFIED
    return [new Paragraph({ alignment, ...paragraphNumbering(node), spacing: paragraphSpacing(node), children: richChildren(node.runs) })]
  }
  if (node.kind === 'heading') return [new Paragraph({ heading: headingLevels[node.level as keyof typeof headingLevels], alignment: paragraphAlignment(node.alignment), ...paragraphNumbering(node), spacing: paragraphSpacing(node), children: richChildren(node.runs) })]
  if (node.kind === 'list') return node.items.map((item, index) => new Paragraph({ children: [new TextRun(`${node.ordered ? `${index + 1}.` : '•'}\t`), ...richChildren(item.runs)] }))
  if (node.kind === 'table') return [tableFromNode(node, contentWidthDxa)]
  if (node.kind === 'chart') return chartFromNode(node, contentWidthDxa)
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

function markerRun(style: OfficeNumbering['markerStyle']): IRunOptions | undefined {
  if (!style) return undefined
  return { font: style.fontFamily || style.eastAsianFontFamily ? { ascii: style.fontFamily, hAnsi: style.fontFamily, eastAsia: style.eastAsianFontFamily } : undefined,
    size: style.fontSizePt === undefined ? undefined : Math.round(style.fontSizePt * 2),
    color: style.color ? color(style.color) : undefined, bold: style.bold, italics: style.italic,
    strike: style.strike, underline: style.underline === undefined ? undefined : style.underline ? {} : { type: UnderlineType.NONE }, scale: style.widthScalePercent }
}

function paragraphNumbering(format: OfficeParagraphFormat) {
  return {
    indent: format.indentLeftPt !== undefined || format.hangingPt !== undefined ? { left: Math.round((format.indentLeftPt ?? 0) * 20), hanging: Math.round((format.hangingPt ?? 0) * 20) } : undefined,
    numbering: format.numbering ? { reference: format.numbering.listId, level: 0 } : undefined,
    run: markerRun(format.numbering?.markerStyle),
  }
}

function paragraphSpacing(node: OfficeParagraphFormat) {
  return {
    before: Math.round((node.spacingBeforePt ?? 0) * 20),
    after: Math.round((node.spacingAfterPt ?? 8) * 20),
    line: node.lineSpacingMultiple !== undefined ? Math.round(node.lineSpacingMultiple * 240) : node.lineSpacingPt === undefined ? undefined : Math.round(node.lineSpacingPt * 20),
    lineRule: node.lineSpacingMultiple !== undefined ? LineRuleType.AUTO : node.lineSpacingPt !== undefined ? node.lineSpacingRule === 'atLeast' ? LineRuleType.AT_LEAST : LineRuleType.EXACT : undefined,
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
    const contentWidthDxa = Math.max(1, Math.round((section.page.widthPt - section.page.marginLeftPt - section.page.marginRightPt) * 20))
    for (const node of section.nodes) children.push(...await nodeChildren(node, resolveResource, contentWidthDxa))
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
          margin: { top: Math.round(section.page.marginTopPt * 20), right: Math.round(section.page.marginRightPt * 20), bottom: Math.round(section.page.marginBottomPt * 20), left: Math.round(section.page.marginLeftPt * 20), header: section.page.headerDistancePt === undefined ? undefined : Math.round(section.page.headerDistancePt * 20), footer: section.page.footerDistancePt === undefined ? undefined : Math.round(section.page.footerDistancePt * 20) },
        },
      },
      headers: headerChildren.length ? { default: new Header({ children: [new Paragraph({
        alignment: paragraphAlignment(section.headerAlignment),
        border: section.headerBorderBottom ? { bottom: { style: BorderStyle.SINGLE, color: color(section.headerBorderBottom.color), size: Math.max(1, Math.round(section.headerBorderBottom.widthPt * 8)), space: 6 } } : undefined,
        children: headerChildren,
      })] }) } : undefined,
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: paragraphAlignment(section.footerAlignment),
        border: section.footerBorderTop ? { top: { style: BorderStyle.SINGLE, color: color(section.footerBorderTop.color), size: Math.max(1, Math.round(section.footerBorderTop.widthPt * 8)), space: 6 } } : undefined,
        children: [...richChildren(section.footer), ...(section.showPageNumber ? [new TextRun(' '), new TextRun({ children: [PageNumber.CURRENT] })] : [])],
      })] }) },
      children: children.length ? children : [new Paragraph('')],
    })
  }
  const definitions = new Map<string, OfficeNumbering>()
  for (const { format } of documentNumberedParagraphs(snapshot)) if (format.numbering && !definitions.has(format.numbering.listId)) definitions.set(format.numbering.listId, format.numbering)
  const doc = new Document({ title: snapshot.title, description: snapshot.accessibility.description, sections,
    numbering: { config: [...definitions.values()].map(definition => ({ reference: definition.listId, levels: [{ level: 0, format: definition.format, text: definition.pattern, start: definition.start }] })) },
  })
  const raw = await Packer.toBuffer(doc)
  return { bytes: await attachCanonicalOfficePart(raw, snapshot), semanticHash: officeSemanticHash(snapshot), layoutSerialization: layout.serialization, diagnostics }
}

function textFromWordXml(xml: string): string {
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/?>/g)].map((match) => match[2] === 'tab' ? '\t' : match[2] ? '\n' : decodeXmlText(match[1])).join('')
}

function xmlValue(xml: string, tag: string, attribute = 'w:val'): string | undefined {
  return xml.match(new RegExp(`<${tag}\\b[^>]*${attribute}="([^"]+)"`, 'i'))?.[1]
}

function onOff(xml: string, tag: string): boolean {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?\\/?>(?:<\\/${tag}>)?`, 'i'))
  return Boolean(match) && !/w:val="(?:0|false|off|none)"/i.test(match?.[0] ?? '')
}

/** In styles, true toggles the inherited value; false leaves it unchanged.
 * Direct run properties are absolute, including explicit false. */
function inheritedToggle(base: boolean, properties: string, tag: 'b' | 'i'): boolean {
  for (const match of properties.matchAll(new RegExp(`<w:${tag}(?:\\s[^>]*)?\\/?>`, 'g'))) {
    if (onOff(match[0], `w:${tag}`)) base = !base
  }
  return base
}

/** Only this allowlist converts font-specific codes. Unknown codes stay visible. */
function symbolText(tag: string): string {
  const font = xmlValue(tag, 'w:sym', 'w:font')
  const code = xmlValue(tag, 'w:sym', 'w:char')?.toUpperCase()
  return /^wingdings ?2$/i.test(font ?? '') && code === 'F0A3' ? '☐' : '�'
}

// PAGE is represented by the section's existing dynamic-footer flag. Preserve
// ordinary text and inert fields, but never retain a recognised PAGE cache.
function normalizeFooterPageFields(xml: string): { xml: string; count: number } {
  const isPage = (instruction: string) => /^PAGE(?:\s|$)/i.test(decodeXmlText(instruction).trim())
  let count = 0
  const simpleNormalized = xml.replace(/<w:fldSimple\b[^>]*>[\s\S]*?<\/w:fldSimple>/g, (field) => {
    if (/<w:fldChar\b|<w:fldSimple\b/.test(field.slice(field.indexOf('>') + 1))) return field
    const instruction = xmlValue(field, 'w:fldSimple', 'w:instr') ?? ''
    if (!isPage(instruction)) return field
    count += 1
    return field.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:(?:tab|br|cr|sym)\b[^>]*\/>/g, '')
  })
  const simpleRanges = [...simpleNormalized.matchAll(/<w:fldSimple\b[^>]*>[\s\S]*?<\/w:fldSimple>/g)].map((match) => [match.index!, match.index! + match[0].length])
  const stack: Array<{ instruction: string; result: boolean; nested: boolean; ranges: Array<[number, number]> }> = []
  const remove: Array<[number, number]> = []
  for (const token of simpleNormalized.matchAll(/<w:fldChar\b[^>]*\/>|<w:fldChar\b[^>]*>[\s\S]*?<\/w:fldChar>|<w:instrText(?:\s[^>]*)?>([\s\S]*?)<\/w:instrText>|<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:(?:tab|br|cr|sym)\b[^>]*\/>/g)) {
    if (simpleRanges.some(([start, end]) => token.index! >= start && token.index! < end)) continue
    if (token[0].startsWith('<w:fldChar')) {
      const kind = xmlValue(token[0], 'w:fldChar', 'w:fldCharType')
      if (kind === 'begin') {
        for (const parent of stack) parent.nested = true
        stack.push({ instruction: '', result: false, nested: stack.length > 0, ranges: [] })
      } else if (kind === 'separate' && stack.length) stack[stack.length - 1].result = true
      else if (kind === 'end' && stack.length) {
        const field = stack.pop()!
        if (!field.nested && field.result && isPage(field.instruction)) { count += 1; remove.push(...field.ranges) }
      }
    } else if (stack.length) {
      const field = stack[stack.length - 1]
      if (token[1] !== undefined && !field.result) field.instruction += token[1]
      else if (field.result && token[1] === undefined) field.ranges.push([token.index!, token.index! + token[0].length])
    }
  }
  let normalized = simpleNormalized
  for (const [start, end] of remove.sort((a, b) => b[0] - a[0])) normalized = normalized.slice(0, start) + normalized.slice(end)
  return { xml: normalized, count }
}

function richRunsFromWordXml(xml: string, seed: string, inherited = '', styles?: WordStyles): OfficeRichTextRun[] {
  let checkboxField = false
  const runs = [...xml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)].flatMap((match, index) => {
    const direct = wordContainer(match[1], 'rPr')
    const characterStyle = styles?.get(xmlValue(direct, 'w:rStyle') ?? styles.defaultCharacter) ?? ''
    const characterProperties = wordContainer(characterStyle, 'rPr')
    const inheritedProperties = wordContainer(inherited, 'rPr')
    const fragment = direct + characterProperties + inheritedProperties
    const toggle = (tag: 'b' | 'i'): boolean => {
      if (new RegExp(`<w:${tag}(?:\\s|\\/?>)`).test(direct)) return onOff(direct, `w:${tag}`)
      const base = onOff(wordContainer(styles?.defaults ?? '', 'rPr'), `w:${tag}`)
      return inheritedToggle(inheritedToggle(base, inheritedProperties, tag), characterProperties, tag)
    }
    let text = ''
    for (const token of match[1].matchAll(/<w:fldChar\b[^>]*\/>|<w:fldChar\b[^>]*>[\s\S]*?<\/w:fldChar>|<w:sym\b[^>]*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/?>/g)) {
      if (token[0].startsWith('<w:fldChar')) {
        const kind = xmlValue(token[0], 'w:fldChar', 'w:fldCharType')
        if (kind === 'end') checkboxField = false
        else if (kind === 'begin' && /<w:checkBox\b/.test(token[0])) {
          const stateTag = /<w:checked\b/.test(token[0]) ? 'w:checked' : 'w:default'
          const rawState = xmlValue(token[0], stateTag)
          const checked = rawState === undefined ? onOff(token[0], stateTag) : /^(?:1|true|on)$/i.test(rawState)
          text += checked ? '☒' : '☐'
          checkboxField = true
        }
      } else if (!checkboxField) text += token[0].startsWith('<w:sym') ? symbolText(token[0]) : token[2] === 'tab' ? '\t' : token[2] ? '\n' : decodeXmlText(token[1])
    }
    const fontFamily = decodeXmlText(xmlValue(fragment, 'w:rFonts', 'w:ascii') ?? xmlValue(fragment, 'w:rFonts', 'w:hAnsi') ?? 'Arial')
    const sizeHalfPoints = Number(xmlValue(fragment, 'w:sz') ?? 22)
    const rawColor = xmlValue(fragment, 'w:color')
    const colorValue = rawColor && /^[0-9A-Fa-f]{6}$/.test(rawColor) ? `#${rawColor}` : '#111111'
    return [{
      id: stableOfficeUuid(`${seed}:run:${index}`),
      text,
      style: {
        fontFamily: /<w:sym\b/.test(match[1]) ? 'Arial' : fontFamily,
        ...(validWidthScale(xmlValue(fragment, 'w:w')) ? { widthScalePercent: Number(xmlValue(fragment, 'w:w')) } : {}),
        ...(xmlValue(fragment, 'w:rFonts', 'w:eastAsia') ? { eastAsianFontFamily: decodeXmlText(xmlValue(fragment, 'w:rFonts', 'w:eastAsia')!) } : {}),
        fontSizePt: sizeHalfPoints / 2,
        bold: toggle('b'),
        italic: toggle('i'),
        underline: Boolean(fragment.match(/<w:u\b/i)) && xmlValue(fragment, 'w:u') !== 'none',
        strike: onOff(fragment, 'w:strike'),
        color: colorValue,
      },
    }]
  })
  return runs.length ? runs : richRunsFromWordXml('<w:r><w:t></w:t></w:r>', seed, inherited, styles)
}

function alignmentFromWordXml(xml: string): 'start' | 'center' | 'end' | 'justify' {
  const value = xmlValue(xml, 'w:jc')
  return value === 'center' ? 'center' : value === 'right' || value === 'end' ? 'end' : value === 'both' || value === 'distribute' ? 'justify' : 'start'
}

function paragraphProperties(xml: string): string {
  return xml.match(/<w:pPr(?:\s[^>]*)?>([\s\S]*?)<\/w:pPr>/i)?.[1] ?? ''
}

// Containers are merged property-by-property: direct attributes precede inherited
// attributes, so explicit zero/off values win without dropping sibling defaults.
function cascadeXml(...layers: string[]): string {
  const containers = ['pPr', 'rPr', 'tblPr', 'tcPr', 'tblBorders', 'tcBorders', 'tblCellMar', 'tcMar']
  let joined = layers.join('')
  for (const tag of containers) {
    const pattern = new RegExp(`<w:${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/w:${tag}>`, 'g')
    const matches = [...joined.matchAll(pattern)]
    if (matches.length > 1) {
      const merged = `<w:${tag}>${cascadeXml(...matches.map((match) => match[1]))}</w:${tag}>`
      joined = joined.replace(pattern, (_match, _body, offset: number) => offset === matches[0].index ? merged : '')
    }
  }
  return joined
}

type WordStyles = { get: (id?: string) => string; defaults: string; defaultParagraph: string; defaultCharacter: string; defaultTable: string }
function styleFragments(stylesXml: string): WordStyles {
  const styles = new Map<string, string>()
  const defaults = wordContainer(stylesXml, 'docDefaults')
  const resolved = new Map<string, string>()
  const defaultIds: Record<string, string> = {}
  for (const match of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = match[1].match(/w:styleId="([^"]+)"/)?.[1]
    if (id) {
      styles.set(id, match[2].replace(/<w:tblStylePr\b[^>]*>[\s\S]*?<\/w:tblStylePr>/g, ''))
      if (/w:default="(?:1|true)"/.test(match[1])) defaultIds[match[1].match(/w:type="([^"]+)"/)?.[1] ?? ''] = id
    }
  }
  return {
    defaults, defaultParagraph: defaultIds.paragraph ?? '', defaultCharacter: defaultIds.character ?? '', defaultTable: defaultIds.table ?? '',
    get(id) {
      if (!id) return ''
      const key = id
      if (resolved.has(key)) return resolved.get(key)!
      const chain: string[] = []
      const visited = new Set<string>()
      while (id && styles.has(id) && !visited.has(id) && chain.length < 32) {
        visited.add(id)
        const fragment = styles.get(id)!
        chain.push(fragment)
        id = xmlValue(fragment, 'w:basedOn')
      }
      const result = cascadeXml(...chain)
      resolved.set(key, result)
      return result
    },
  }
}

function paragraphInheritance(fragment: string, styles: WordStyles, tableStyle = ''): string {
  // Defaults are the absolute starting value, not another style toggle. Run
  // import reads their bold/italic separately; other properties still cascade.
  const defaults = styles.defaults.replace(/<w:(b|i)(?:\s[^>]*)?\/?>(?:<\/w:\1>)?/g, '')
  return cascadeXml(styles.get(xmlValue(paragraphProperties(fragment), 'w:pStyle') ?? styles.defaultParagraph), tableStyle, defaults)
}

function validWidthScale(value: string | undefined): boolean {
  return value !== undefined && /^\d+$/.test(value) && Number(value) >= 10 && Number(value) <= 600
}

type WordNumbering = Map<string, { definition: OfficeNumbering; properties: string }>
function parseWordNumbering(xml: string, seed: string): WordNumbering {
  const abstracts = new Map([...xml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)].map(m => [m[1], m[2]]))
  const result: WordNumbering = new Map()
  for (const match of xml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abstract = abstracts.get(xmlValue(match[2], 'w:abstractNumId') ?? '') ?? ''
    const levels = [...abstract.matchAll(/<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)]
    const overrides = [...match[2].matchAll(/<w:lvlOverride\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/g)].filter(m => m[1] === '0')
    if (overrides.length > 1 || overrides.some(m => /<w:lvl\b/.test(m[2]))) continue
    // Word commonly declares nine levels even for a flat list. Only level
    // zero is projected; unused levels must not veto its admission.
    const roots = levels.filter(m => m[1] === '0')
    if (roots.length !== 1 || /<w:numStyleLink\b|<w:styleLink\b/.test(abstract)) continue
    const level = roots[0][2]
    if (/<w:lvlRestart\b|<w:isLgl\b/.test(level)) continue
    const parsed = OfficeNumberingSchema.safeParse({ listId: stableOfficeUuid(`${seed}:numbering:${match[1]}`), format: xmlValue(level, 'w:numFmt'), start: Number(xmlValue(overrides[0]?.[2] ?? '', 'w:startOverride') ?? xmlValue(level, 'w:start') ?? 1), pattern: decodeXmlText(xmlValue(level, 'w:lvlText') ?? '%1.') })
    if (parsed.success) result.set(match[1], { definition: parsed.data, properties: level })
  }
  return result
}

function effectiveParagraphFormat(fragment: string, styleFragment = '', numbering?: WordNumbering): OfficeParagraphFormat & { alignment: NonNullable<OfficeParagraphFormat['alignment']> } {
  const paragraph = paragraphProperties(fragment) + paragraphProperties(styleFragment)
  const numId = xmlValue(paragraph, 'w:numId')
  const entry = numId !== '0' && Number(xmlValue(paragraph, 'w:ilvl') ?? 0) === 0 ? numbering?.get(numId ?? '') : undefined
  const properties = paragraph + paragraphProperties(entry?.properties ?? '')
  const markerProperties = wordContainer(paragraphProperties(fragment), 'rPr') + wordContainer(paragraphProperties(styleFragment), 'rPr') + wordContainer(entry?.properties ?? '', 'rPr')
  const parsedMarker = richRunsFromWordXml(`<w:r><w:rPr>${markerProperties}</w:rPr><w:t></w:t></w:r>`, 'marker')[0].style
  const markerStyle = Object.fromEntries(([
    ['fontFamily', 'rFonts'], ['eastAsianFontFamily', 'rFonts'], ['fontSizePt', 'sz'], ['widthScalePercent', 'w'], ['color', 'color'], ['bold', 'b'], ['italic', 'i'], ['underline', 'u'], ['strike', 'strike'],
  ] as const).filter(([key, tag]) => parsedMarker[key] !== undefined && new RegExp(`<w:${tag}(?:\\s|/?>)`).test(markerProperties)).map(([key]) => [key, parsedMarker[key]]))
  const left = xmlValue(properties, 'w:ind', 'w:left') ?? xmlValue(properties, 'w:ind', 'w:start')
  const hanging = xmlValue(properties, 'w:ind', 'w:hanging')
  const twips = (attribute: string, fallback = 0): number => Number(xmlValue(properties, 'w:spacing', attribute) ?? fallback * 20) / 20
  const line = xmlValue(properties, 'w:spacing', 'w:line')
  const rule = xmlValue(properties, 'w:spacing', 'w:lineRule') ?? 'auto'
  return {
    ...(entry ? { numbering: { ...entry.definition, ...(Object.keys(markerStyle).length ? { markerStyle } : {}) } } : {}),
    ...(left !== undefined && /^\d+$/.test(left) && Number(left) <= 20000 ? { indentLeftPt: Number(left) / 20 } : {}),
    ...(hanging !== undefined && /^\d+$/.test(hanging) && Number(hanging) <= 20000 ? { hangingPt: Number(hanging) / 20 } : {}),
    alignment: alignmentFromWordXml(properties), spacingBeforePt: twips('w:before'), spacingAfterPt: twips('w:after'),
    ...(line && Number(line) > 0 ? rule === 'auto' ? { lineSpacingMultiple: Number(line) / 240 } : { lineSpacingPt: Number(line) / 20, lineSpacingRule: rule === 'exact' ? 'exact' as const : 'atLeast' as const } : {}),
  }
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

function parseWordTable(fragment: string, id: string, styles: WordStyles, numbering: WordNumbering): DocumentTableNode {
  if (/<w:tc(?:\s[^>]*)?>[\s\S]*?<w:tbl\b/i.test(fragment)) throw new Error('Nested Word tables are outside the supported Office subset')
  const directProperties = wordContainer(fragment, 'tblPr')
  const tableStyle = styles.get(xmlValue(directProperties, 'w:tblStyle') ?? styles.defaultTable)
  const properties = wordContainer(cascadeXml(`<w:tblPr>${directProperties}</w:tblPr>`, tableStyle), 'tblPr')
  const columnWidthsPt = [...wordContainer(fragment, 'tblGrid').matchAll(/<w:gridCol\b[^>]*w:w="(\d+)"[^>]*\/?\s*>/gi)]
    .map((match) => Number(match[1]) / 20)
    .filter((width) => Number.isFinite(width) && width > 0)
  const tableMargins = wordCellMargins(properties, 'tblCellMar') ?? { topPt: 0, rightPt: 5.4, bottomPt: 0, leftPt: 5.4 }
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
      const cellProperties = wordContainer(cascadeXml(cellFragment, tableStyle), 'tcPr')
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
        runs: [...cellFragment.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p\s*\/>/g)].flatMap((paragraph, paragraphIndex) => {
          const inherited = paragraphInheritance(paragraph[0], styles, tableStyle)
          const runs = richRunsFromWordXml(paragraph[0], `${id}:row:${rowIndex}:cell:${cellIndex}:p:${paragraphIndex}`, inherited, styles)
          runs[0].paragraphStart = { id: stableOfficeUuid(`${id}:row:${rowIndex}:cell:${cellIndex}:paragraph:${paragraphIndex}`), ...effectiveParagraphFormat(paragraph[0], inherited, numbering) }
          return runs
        }),
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
    const rowProperties = wordContainer(rowFragment, 'trPr')
    const height = Number(xmlValue(rowProperties, 'w:trHeight')) / 20
    return {
      id: stableOfficeUuid(`${id}:row:${rowIndex}`),
      minHeightPt: Number.isFinite(height) && height > 0 ? height : undefined,
      heightRule: Number.isFinite(height) && height > 0 && xmlValue(rowProperties, 'w:trHeight', 'w:hRule') === 'exact' ? 'exact' as const : undefined,
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
    borders: wordTableBorders(properties, 'tblBorders') ?? {},
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

function malformedCheckboxFields(xml: string): boolean {
  for (const paragraph of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const fields: boolean[] = []
    for (const token of paragraph[1].matchAll(/<w:fldChar\b[^>]*\/>|<w:fldChar\b[^>]*>[\s\S]*?<\/w:fldChar>/g)) {
      const kind = xmlValue(token[0], 'w:fldChar', 'w:fldCharType')
      if (kind === 'begin') {
        const checkbox = /<w:checkBox\b/.test(token[0])
        if (fields.length >= 16 || fields.some(Boolean) || (checkbox && fields.length > 0)) return true
        fields.push(checkbox)
      } else if (kind === 'end') fields.pop()
    }
    if (fields.some(Boolean)) return true
  }
  return false
}

function formattingDiagnostics(xml: string, stylesXml: string): OfficePreflightDiagnostic[] {
  const source = xml + stylesXml
  const checks: Array<[RegExp, string, string]> = [

    [/<w:tab\b/, 'tab_layout', 'Tab characters are retained, but browser tab layout may differ from Word.'],
    [/<w:tabs\b/, 'tab_stops', 'Custom tab stops are not supported; tab characters are retained.'],
    [/<w:tblStylePr\b/, 'conditional_table_style', 'Conditional table style regions are not supported; base table properties are retained.'],
    [/w:(?:asciiTheme|hAnsiTheme|eastAsiaTheme|cstheme)=/, 'theme_font', 'Theme font references are not resolved; explicit font names are retained.'],
    [/<w:rFonts\b[^>]*w:eastAsia=/, 'east_asian_shaping', 'East Asian font names are retained; browser font availability and shaping may differ from Word.'],
  ]
  const diagnostics: OfficePreflightDiagnostic[] = checks.filter(([pattern]) => pattern.test(source)).map(([, code, message]) => ({ severity: 'warning', code: `docx.formatting.${code}`, path: 'word/document.xml', message }))
  if ([...source.matchAll(/<w:w\b[^>]*>/g)].some(m => !validWidthScale(xmlValue(m[0], 'w:w')))) diagnostics.push({ severity: 'warning', code: 'docx.formatting.text_scale', path: 'word/document.xml', message: 'Unsupported horizontal scaling was omitted; supported integer range is 10–600 percent.' })
  if ([...source.matchAll(/<w:sym\b[^>]*>/g)].some(m => symbolText(m[0]) === '�')) diagnostics.push({ severity: 'warning', code: 'docx.formatting.symbol', path: 'word/document.xml', message: 'Unsupported font-specific symbols were replaced with a replacement character.' })
  if (/<w:instrText\b/.test(source)) diagnostics.push({ severity: 'warning', code: 'docx.formatting.inert_fields', path: 'word/document.xml', message: 'Fields are not executed. Supported checkboxes become editable ballot-box text; other field results remain inert.' })
  if ([...source.matchAll(/<w:(?:checked|default)\b[^>]*w:val="([^"]+)"/g)].some(m => !/^(?:0|1|true|false|on|off)$/i.test(m[1]))) diagnostics.push({ severity: 'warning', code: 'docx.formatting.checkbox_state', path: 'word/document.xml', message: 'Unsupported checkbox state values become unchecked ballot boxes.' })
  if ([...stylesXml.matchAll(/<w:(lvlJc|suff)\b[^>]*w:val="([^"]+)"/g)].some(m => m[1] === 'lvlJc' ? !['left', 'start'].includes(m[2]) : m[2] !== 'tab')) diagnostics.push({ severity: 'warning', code: 'docx.formatting.numbering_layout', path: 'word/numbering.xml', message: 'Non-left marker alignment and non-tab numbering suffixes are not supported; marker labels and hanging indents are retained.' })
  if (malformedCheckboxFields(xml)) diagnostics.push({ severity: 'error', code: 'docx.formatting.checkbox_structure', path: 'word/document.xml', message: 'Checkbox fields must be balanced, non-nested and contained in one paragraph.' })
  if (/<w:checkBox\b[\s\S]*?<w:size\b/.test(source)) diagnostics.push({ severity: 'warning', code: 'docx.formatting.checkbox_size', path: 'word/document.xml', message: 'Fixed checkbox sizes are not supported; ballot boxes use the run font size.' })
  if ([...source.matchAll(/<w:ind\b[^>]*>/g)].some(m => /w:(?:firstLine|right|end)=/.test(m[0]) || [...m[0].matchAll(/w:(?:left|start|hanging)="([^"]+)"/g)].some(a => !/^\d+$/.test(a[1]) || Number(a[1]) > 20000))) diagnostics.push({ severity: 'warning', code: 'docx.formatting.indent', path: 'word/document.xml', message: 'Only nonnegative left/hanging indents up to 1000pt are supported.' })
  if (/<w:rFonts\b/.test(source)) diagnostics.push({ severity: 'warning', code: 'docx.formatting.font_availability', path: 'word/document.xml', message: 'Font names are retained, not downloaded; missing local fonts and browser shaping may change glyph metrics.' })
  const bases = new Map([...stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)].map((match) => [match[1].match(/w:styleId="([^"]+)"/)?.[1] ?? '', xmlValue(match[2], 'w:basedOn')]))
  for (const id of bases.keys()) {
    let current: string | undefined = id
    const visited = new Set<string>()
    while (current && bases.has(current) && !visited.has(current) && visited.size < 32) { visited.add(current); current = bases.get(current) }
    if (current && (visited.has(current) || visited.size >= 32)) {
      diagnostics.push({ severity: 'warning', code: 'docx.formatting.style_chain', path: 'word/styles.xml', message: 'A cyclic or over-depth style chain was bounded at 32 styles.' })
      break
    }
  }
  return diagnostics
}

async function externalDocumentSnapshot(zip: JSZip, xml: string, context: OfficeImportContext): Promise<{ snapshot: DocumentSnapshot; resources: OfficeImportResult['resources']; diagnostics: OfficePreflightDiagnostic[] }> {
  const body = xml.match(/<w:body(?:\s[^>]*)?>([\s\S]*?)<\/w:body>/)?.[1] ?? ''
  const stylesXml = await zip.file('word/styles.xml')?.async('string') ?? ''
  const styles = styleFragments(stylesXml)
  const numberingXml = await zip.file('word/numbering.xml')?.async('string') ?? ''
  const numbering = parseWordNumbering(numberingXml, context.artifactId)
  let nodes: DocumentFlowNode[] = []
  const sectionBodies: Array<{ nodes: DocumentFlowNode[]; properties: string }> = []
  let ordinal = 0
  for (const match of body.matchAll(/<(w:p|w:tbl|w:sectPr)(?:\s[^>]*)?>[\s\S]*?<\/\1>|<w:p\s*\/>|<w:sectPr\s*\/>/g)) {
    const fragment = match[0]
    const sectionProperties = match[1] === 'w:tbl' ? undefined : fragment.match(/<w:sectPr\b[^>]*>([\s\S]*?)<\/w:sectPr>|<w:sectPr\s*\/>/)
    const finishSection = () => {
      if (!sectionProperties) return
      sectionBodies.push({ nodes, properties: sectionProperties[0] })
      nodes = []
    }
    if (/^<w:sectPr\b/.test(fragment)) { finishSection(); continue }
    const id = stableOfficeUuid(`${context.artifactId}:docx:${ordinal}`)
    ordinal += 1
    if (match[1] === 'w:tbl') {
      nodes.push(parseWordTable(fragment, id, styles, numbering))
      continue
    }
    if (/<w:br[^>]*w:type="page"/.test(fragment)) {
      nodes.push({ id, kind: 'pageBreak' })
      finishSection()
      continue
    }
    const text = textFromWordXml(fragment)
    if (sectionProperties && !text && !/<w:(?:drawing|pict)\b/.test(fragment)) { finishSection(); continue }
    if (!text && !/<w:p\b/.test(fragment)) continue
    const styleName = xmlValue(paragraphProperties(fragment), 'w:pStyle') ?? (styles.defaultParagraph || 'Body')
    const heading = styleName.match(/^Heading\s*([1-6])$/i)
    const inherited = paragraphInheritance(fragment, styles)
    const runs = richRunsFromWordXml(fragment, id, inherited, styles)
    const format = effectiveParagraphFormat(fragment, inherited, numbering)
    nodes.push(heading ? { id, kind: 'heading', level: Number(heading[1]), styleName, runs, ...format } : { id, kind: 'paragraph', styleName, runs, ...format })
    finishSection()
  }
  if (nodes.length || sectionBodies.length === 0) sectionBodies.push({ nodes, properties: '' })
  const documentRels = await zip.file('word/_rels/document.xml.rels')?.async('string') ?? ''
  const sections: DocumentSnapshot['sections'] = []
  const resources: OfficeImportResult['resources'] = []
  const diagnostics: OfficePreflightDiagnostic[] = []
  const headerPaths: Partial<Record<'first' | 'default', string | null>> = {}
  const footerPaths: Partial<Record<'first' | 'default', string | null>> = {}
  let allPartsXml = xml
  for (const [sectionIndex, sectionBody] of sectionBodies.entries()) {
    const sectionProperties = sectionBody.properties
    const hasDistinctFirstPage = /<w:titlePg\b/.test(sectionProperties)
    const preferredReferenceType = hasDistinctFirstPage ? 'first' : 'default'
    for (const type of ['first', 'default'] as const) {
      const headerId = sectionRelationshipId(sectionProperties, 'header', type)
      const footerId = sectionRelationshipId(sectionProperties, 'footer', type)
      if (headerId) headerPaths[type] = partTarget(documentRels, headerId, 'word')
      if (footerId) footerPaths[type] = partTarget(documentRels, footerId, 'word')
    }
    const headerPath = headerPaths[preferredReferenceType] ?? headerPaths.default ?? null
    const footerPath = footerPaths[preferredReferenceType] ?? footerPaths.default ?? null
    const headerXml = headerPath ? await zip.file(headerPath)?.async('string') ?? '' : ''
    const footerXml = footerPath ? await zip.file(footerPath)?.async('string') ?? '' : ''
    const footerFields = normalizeFooterPageFields(footerXml)
    const headerImage = headerPath ? await headerImageFromWordXml(zip, headerPath, headerXml, context) : {}
    allPartsXml += headerXml + footerXml
    if (headerImage.resource && !resources.some(resource => resource.ref.id === headerImage.resource!.ref.id)) resources.push(headerImage.resource)
    const widthPt = Number(xmlValue(sectionProperties, 'w:pgSz', 'w:w') ?? 12_240) / 20
    const heightPt = Number(xmlValue(sectionProperties, 'w:pgSz', 'w:h') ?? 15_840) / 20
    const margin = (name: 'top' | 'right' | 'bottom' | 'left', fallback: number) => Number(xmlValue(sectionProperties, 'w:pgMar', `w:${name}`) ?? fallback * 20) / 20
    const distance = (name: 'header' | 'footer') => {
      const value = xmlValue(sectionProperties, 'w:pgMar', `w:${name}`)
      return value === undefined ? undefined : Number(value) / 20
    }
    sections.push({
        id: stableOfficeUuid(`${context.artifactId}:section:${sectionIndex}`),
        page: { widthPt, heightPt, marginTopPt: margin('top', 72), marginRightPt: margin('right', 72), marginBottomPt: margin('bottom', 72), marginLeftPt: margin('left', 72), headerDistancePt: distance('header'), footerDistancePt: distance('footer'), orientation: xmlValue(sectionProperties, 'w:pgSz', 'w:orient') === 'landscape' ? 'landscape' : 'portrait' },
        header: richRunsFromWordXml(headerXml, `${context.artifactId}:section:${sectionIndex}:header`).filter((run) => run.text),
        footer: richRunsFromWordXml(footerFields.xml, `${context.artifactId}:section:${sectionIndex}:footer`).filter((run) => run.text),
        headerImage: headerImage.image,
        headerAlignment: textParagraphAlignment(headerXml),
        footerAlignment: textParagraphAlignment(footerXml),
        headerBorderBottom: borderFromXml(headerXml, 'bottom'),
        footerBorderTop: borderFromXml(footerXml, 'top'),
        showPageNumber: footerFields.count > 0,
        nodes: sectionBody.nodes,
    })
    if (footerFields.count) diagnostics.push({ severity: 'warning', code: 'docx.formatting.footer_page_number', path: footerPath ?? 'word/footer.xml', message: 'Footer PAGE fields become one dynamic page number at the footer end; cached values are removed. Original field placement and number formatting are normalized.' })
    const breakType = xmlValue(sectionProperties, 'w:type')
    if (breakType && breakType !== 'nextPage') diagnostics.push({ severity: 'warning', code: 'docx.formatting.section_break', path: `sections.${sectionIndex}`, message: 'This section break is normalized to a new page.' })
  }
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
    resources: resources.map(resource => resource.ref),
    accessibility: { title: context.title },
    sections,
  }
  diagnostics.push(...formattingDiagnostics(allPartsXml, stylesXml + numberingXml))
  const references = [...(xml + stylesXml).matchAll(/<w:numPr\b[^>]*>([\s\S]*?)<\/w:numPr>/g)]
  if (references.some(m => xmlValue(m[1], 'w:numId') !== '0' && (!numbering.has(xmlValue(m[1], 'w:numId') ?? '') || Number(xmlValue(m[1], 'w:ilvl') ?? 0) !== 0))) diagnostics.push({ severity: 'warning', code: 'docx.formatting.numbering', path: 'word/numbering.xml', message: 'Only single-level decimal, Roman and letter numbering without level overrides is supported; unsupported markers were omitted.' })
  return { snapshot, resources, diagnostics }
}

export async function importOfficeDocument(bytes: Uint8Array, context: OfficeImportContext): Promise<OfficeImportResult> {
  const packageResult = await preflightOfficePackage(bytes, 'document')
  if (!packageResult.ok || !packageResult.zip) return { ok: false, diagnostics: packageResult.diagnostics, resources: [] }
  try {
    const canonical = await readCanonicalOfficePart(packageResult.zip, 'document')
    const external = canonical ? null : await externalDocumentSnapshot(packageResult.zip, await packageResult.zip.file('word/document.xml')!.async('string'), context)
    const snapshot = canonical ?? external!.snapshot
    const model = preflightOfficeCandidate(snapshot)
    const diagnostics = [...packageResult.diagnostics, ...(external?.diagnostics ?? []), ...model.diagnostics]
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
