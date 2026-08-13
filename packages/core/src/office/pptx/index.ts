/** Safe Brian-owned PPTX import/export/reparse adapter. [COMP:office/pptx-engine] */
import PptxGenJSImport from 'pptxgenjs'
import {
  assertOfficeArtifactSnapshot,
  preflightOfficeCandidate,
  type OfficePreflightDiagnostic,
  type OfficeRichTextRun,
  type PresentationObject,
  type PresentationSnapshot,
} from '@use-brian/office-model'
import { layoutOfficeArtifact } from '@use-brian/office-renderer'
import {
  attachCanonicalOfficePart,
  officeSemanticHash,
  preflightOfficePackage,
  readCanonicalOfficePart,
  type OfficeImportContext,
  type OfficeImportResult,
  type OfficeResourceResolver,
} from '../package.js'
import type { OfficeExportReceipt } from '../docx/index.js'
import { importExternalPresentation } from './external.js'

const PptxGenJS = (PptxGenJSImport as { default?: typeof PptxGenJSImport }).default ?? PptxGenJSImport
type Pptx = InstanceType<typeof PptxGenJS>
type Slide = ReturnType<Pptx['addSlide']>
type ShapeName = Parameters<Slide['addShape']>[0]
type ChartName = Parameters<Slide['addChart']>[0]

const inch = (points: number): number => points / 72
const hex = (value: string): string => value.replace('#', '').slice(0, 6)

function dataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

function richText(runs: readonly OfficeRichTextRun[]) {
  return runs.map((run) => ({
    text: run.text,
    options: {
      fontFace: run.style.fontFamily,
      fontSize: run.style.fontSizePt,
      bold: run.style.bold || undefined,
      italic: run.style.italic || undefined,
      underline: run.style.underline ? { color: hex(run.style.color) } : undefined,
      strike: run.style.strike ? 'sngStrike' as const : undefined,
      color: hex(run.style.color),
      hyperlink: run.href ? { url: run.href } : undefined,
    },
  }))
}

async function writeObject(slide: Slide, object: PresentationObject, resolveResource: OfficeResourceResolver): Promise<void> {
  const box = { x: inch(object.geometry.xPt), y: inch(object.geometry.yPt), w: inch(object.geometry.widthPt), h: inch(object.geometry.heightPt), rotate: object.geometry.rotationDeg }
  if (object.kind === 'text') {
    const align = object.alignment === 'start' ? 'left' : object.alignment === 'end' ? 'right' : object.alignment
    slide.addText(richText(object.runs), { ...box, align, valign: object.verticalAlignment, margin: 0, breakLine: false })
    return
  }
  if (object.kind === 'shape') {
    const shape = (object.shape === 'roundedRectangle' ? 'roundRect' : object.shape === 'rectangle' ? 'rect' : object.shape === 'triangle' ? 'triangle' : object.shape === 'ellipse' ? 'ellipse' : 'line') as ShapeName
    slide.addShape(shape, { ...box, fill: object.fill ? { color: hex(object.fill) } : { color: 'FFFFFF', transparency: 100 }, line: object.stroke ? { color: hex(object.stroke), width: object.strokeWidthPt } : { type: 'none' } })
    if (object.text.length) {
      const align = object.alignment === 'start' || !object.alignment ? 'left' : object.alignment === 'end' ? 'right' : object.alignment
      slide.addText(richText(object.text), { ...box, align, valign: object.verticalAlignment ?? 'middle', margin: 0 })
    }
    return
  }
  if (object.kind === 'connector') {
    slide.addShape((object.connector === 'elbow' ? 'bentConnector3' : 'line') as ShapeName, { ...box, line: { color: hex(object.stroke), width: 1 } })
    return
  }
  if (object.kind === 'image') {
    const payload = await resolveResource(object.resourceId)
    if (!payload || !['image/png', 'image/jpeg', 'image/svg+xml'].includes(payload.mime)) throw new Error(`Missing or unsupported image resource ${object.resourceId}`)
    slide.addImage({ data: dataUri(payload.mime, payload.bytes), ...box, altText: object.altText || 'Decorative image' })
    return
  }
  if (object.kind === 'table') {
    slide.addTable(object.rows.map((row) => row.cells.map((cell) => ({ text: richText(cell.runs), options: { fill: cell.fill ? { color: hex(cell.fill) } : undefined, align: cell.alignment === 'start' ? 'left' : cell.alignment === 'end' ? 'right' : cell.alignment, valign: cell.verticalAlignment } }))), { ...box, border: { color: '888888', pt: 1 }, fontSize: 11 })
    return
  }
  if (object.kind === 'chart') {
    const chartType = (object.chartType === 'bar' ? 'bar' : object.chartType === 'line' ? 'line' : object.chartType === 'pie' ? 'pie' : object.chartType === 'scatter' ? 'scatter' : 'doughnut') as ChartName
    slide.addChart(chartType, object.series.map((series) => ({ name: series.name, labels: object.categories, values: series.values })), { ...box, showTitle: true, title: object.title, showLegend: true })
    return
  }
  const video = await resolveResource(object.resourceId)
  const poster = await resolveResource(object.posterResourceId)
  if (!video || video.mime !== 'video/mp4') throw new Error(`Missing or unsupported MP4 resource ${object.resourceId}`)
  if (!poster || !['image/png', 'image/jpeg'].includes(poster.mime)) throw new Error(`Missing video poster resource ${object.posterResourceId}`)
  slide.addMedia({ type: 'video', data: dataUri(video.mime, video.bytes), cover: dataUri(poster.mime, poster.bytes), extn: 'mp4', ...box })
}

export async function exportOfficePresentation(
  input: PresentationSnapshot,
  resolveResource: OfficeResourceResolver = async () => null,
): Promise<OfficeExportReceipt> {
  const snapshot = assertOfficeArtifactSnapshot(input)
  if (snapshot.family !== 'presentation') throw new Error('PPTX export requires a Presentation snapshot')
  const preflight = preflightOfficeCandidate(snapshot)
  const layout = layoutOfficeArtifact(snapshot)
  const diagnostics = [...preflight.diagnostics, ...layout.issues.map((issue) => ({ severity: 'error' as const, code: `layout.${issue.code}`, path: issue.objectId, message: issue.message }))]
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) throw new Error(`PPTX preflight failed: ${diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join('; ')}`)

  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'BRIAN', width: inch(snapshot.slideSize.widthPt), height: inch(snapshot.slideSize.heightPt) })
  pptx.layout = 'BRIAN'
  pptx.title = snapshot.title
  pptx.subject = snapshot.accessibility.description ?? snapshot.accessibility.title
  for (const sourceSlide of snapshot.slides) {
    const slide = pptx.addSlide()
    for (const object of sourceSlide.objects) await writeObject(slide, object, resolveResource)
    if (sourceSlide.notes.length) slide.addNotes(sourceSlide.notes.map((run) => run.text).join(''))
  }
  const raw = await pptx.write({ outputType: 'nodebuffer' }) as Buffer
  return { bytes: await attachCanonicalOfficePart(raw, snapshot), semanticHash: officeSemanticHash(snapshot), layoutSerialization: layout.serialization, diagnostics }
}

export async function importOfficePresentation(bytes: Uint8Array, context: OfficeImportContext): Promise<OfficeImportResult> {
  const packageResult = await preflightOfficePackage(bytes, 'presentation')
  if (!packageResult.ok || !packageResult.zip) return { ok: false, diagnostics: packageResult.diagnostics, resources: [] }
  try {
    const canonical = await readCanonicalOfficePart(packageResult.zip, 'presentation')
    const external = canonical ? null : await importExternalPresentation(packageResult.zip, context)
    const snapshot = canonical ?? external!.snapshot
    const model = preflightOfficeCandidate(snapshot)
    const diagnostics = [...packageResult.diagnostics, ...model.diagnostics]
    return { ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), snapshot, resources: external?.resources ?? [], diagnostics }
  } catch (cause) {
    return { ok: false, resources: [], diagnostics: [...packageResult.diagnostics, { severity: 'error', code: 'pptx.import_failed', path: 'ppt/presentation.xml', message: cause instanceof Error ? cause.message : 'PPTX import failed' }] }
  }
}

export async function reparseOfficePresentation(bytes: Uint8Array): Promise<{ snapshot: PresentationSnapshot; semanticHash: string; layoutSerialization: string }> {
  const packageResult = await preflightOfficePackage(bytes, 'presentation')
  if (!packageResult.ok || !packageResult.zip) throw new Error(`PPTX reparse failed: ${packageResult.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`)
  const canonical = await readCanonicalOfficePart(packageResult.zip, 'presentation')
  if (!canonical || canonical.family !== 'presentation') throw new Error('PPTX reparse requires the Brian canonical part')
  return { snapshot: canonical, semanticHash: officeSemanticHash(canonical), layoutSerialization: layoutOfficeArtifact(canonical).serialization }
}

export function compareOfficePresentationRoundTrip(source: PresentationSnapshot, reparsed: PresentationSnapshot): OfficePreflightDiagnostic[] {
  return officeSemanticHash(source) === officeSemanticHash(reparsed) ? [] : [{ severity: 'error', code: 'pptx.semantic_mismatch', path: '', message: 'PPTX reparse does not match the canonical source snapshot' }]
}
