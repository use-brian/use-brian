/** Safe Brian-owned DOCX import/export/reparse adapter. [COMP:office/docx-engine] */
import sharp from 'sharp'
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import {
  assertOfficeArtifactSnapshot,
  preflightOfficeCandidate,
  type DocumentFlowNode,
  type DocumentSnapshot,
  type OfficePreflightDiagnostic,
  type OfficeRichTextRun,
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

function tableFromNode(node: Extract<DocumentFlowNode, { kind: 'table' }>): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: node.rows.map((row, rowIndex) => new TableRow({
      tableHeader: rowIndex < node.headerRows,
      children: row.cells.map((cell) => new TableCell({
        columnSpan: cell.colSpan,
        children: [new Paragraph({ children: richChildren(cell.runs) })],
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
    return [new Paragraph({ alignment, style: node.styleName, children: richChildren(node.runs) })]
  }
  if (node.kind === 'heading') return [new Paragraph({ heading: headingLevels[node.level as keyof typeof headingLevels], children: richChildren(node.runs) })]
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
    sections.push({
      properties: {
        page: {
          size: { width: Math.round(section.page.widthPt * 20), height: Math.round(section.page.heightPt * 20) },
          margin: { top: Math.round(section.page.marginTopPt * 20), right: Math.round(section.page.marginRightPt * 20), bottom: Math.round(section.page.marginBottomPt * 20), left: Math.round(section.page.marginLeftPt * 20) },
        },
      },
      headers: section.header.length ? { default: new Header({ children: [new Paragraph({ children: richChildren(section.header) })] }) } : undefined,
      footers: section.footer.length || section.showPageNumber ? { default: new Footer({ children: [new Paragraph({ children: [...richChildren(section.footer), ...(section.showPageNumber ? [new TextRun(' '), new TextRun({ children: [PageNumber.CURRENT] })] : [])] })] }) } : undefined,
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

function externalDocumentSnapshot(xml: string, context: OfficeImportContext): DocumentSnapshot {
  const body = xml.match(/<w:body(?:\s[^>]*)?>([\s\S]*?)<\/w:body>/)?.[1] ?? ''
  const nodes: DocumentFlowNode[] = []
  let ordinal = 0
  for (const match of body.matchAll(/<(w:p|w:tbl)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g)) {
    const fragment = match[0]
    const id = stableOfficeUuid(`${context.artifactId}:docx:${ordinal}`)
    ordinal += 1
    if (match[1] === 'w:tbl') {
      const rows = [...fragment.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map((rowMatch, rowIndex) => ({
        id: stableOfficeUuid(`${id}:row:${rowIndex}`),
        cells: [...rowMatch[1].matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].map((cellMatch, cellIndex) => ({
          id: stableOfficeUuid(`${id}:row:${rowIndex}:cell:${cellIndex}`),
          runs: [{ id: stableOfficeUuid(`${id}:row:${rowIndex}:cell:${cellIndex}:run`), text: textFromWordXml(cellMatch[1]), style: defaultStyle() }],
          rowSpan: 1,
          colSpan: Number(cellMatch[1].match(/<w:gridSpan[^>]*w:val="(\d+)"/)?.[1] ?? 1),
        })),
      })).filter((row) => row.cells.length > 0)
      if (rows.length > 0) nodes.push({ id, kind: 'table', headerRows: 1, rows })
      continue
    }
    if (/<w:br[^>]*w:type="page"/.test(fragment)) {
      nodes.push({ id, kind: 'pageBreak' })
      continue
    }
    const text = textFromWordXml(fragment)
    if (!text && !/<w:p\b/.test(fragment)) continue
    const heading = fragment.match(/<w:pStyle[^>]*w:val="Heading([1-6])"/i)
    const runs = [{ id: stableOfficeUuid(`${id}:run`), text, style: defaultStyle() }]
    nodes.push(heading ? { id, kind: 'heading', level: Number(heading[1]), styleName: `Heading ${heading[1]}`, runs } : { id, kind: 'paragraph', styleName: 'Body', alignment: 'start', runs })
  }
  return {
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
    resources: [],
    accessibility: { title: context.title },
    sections: [{ id: stableOfficeUuid(`${context.artifactId}:section:0`), page: { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72, orientation: 'portrait' }, header: [], footer: [], showPageNumber: false, nodes }],
  }
}

export async function importOfficeDocument(bytes: Uint8Array, context: OfficeImportContext): Promise<OfficeImportResult> {
  const packageResult = await preflightOfficePackage(bytes, 'document')
  if (!packageResult.ok || !packageResult.zip) return { ok: false, diagnostics: packageResult.diagnostics, resources: [] }
  try {
    const canonical = await readCanonicalOfficePart(packageResult.zip, 'document')
    const snapshot = canonical ?? externalDocumentSnapshot(await packageResult.zip.file('word/document.xml')!.async('string'), context)
    const model = preflightOfficeCandidate(snapshot)
    const diagnostics = [...packageResult.diagnostics, ...model.diagnostics]
    return { ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), snapshot, resources: [], diagnostics }
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
