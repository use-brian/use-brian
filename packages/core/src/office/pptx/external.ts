import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import type JSZip from 'jszip'
import { DOMParser } from 'linkedom'
import type {
  OfficeRichTextRun,
  OfficeTextStyleSchema,
  PresentationObject,
  PresentationSnapshot,
} from '@use-brian/office-model'
import { stableOfficeUuid, type ExtractedOfficeResource, type OfficeImportContext } from '../package.js'

type TextStyle = typeof OfficeTextStyleSchema._output
type XmlParent = { getElementsByTagName(tagName: string): Iterable<XmlElement> }
type XmlElement = XmlParent & {
  tagName: string
  children: Iterable<XmlElement>
  getAttribute(name: string): string | null
  textContent: string | null
}
type XmlDocument = XmlParent

const EMUS_PER_POINT = 12_700
const DEFAULT_THEME: Record<string, string> = {
  dk1: '#000000', lt1: '#FFFFFF', dk2: '#1F497D', lt2: '#EEECE1',
  accent1: '#4F81BD', accent2: '#C0504D', accent3: '#9BBB59', accent4: '#8064A2',
  accent5: '#4BACC6', accent6: '#F79646', hlink: '#0000FF', folHlink: '#800080',
  tx1: '#000000', bg1: '#FFFFFF', tx2: '#1F497D', bg2: '#EEECE1',
}

function parseXml(xml: string): XmlDocument {
  return new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ''), 'text/xml') as unknown as XmlDocument
}

function elements(parent: XmlParent, tagName: string): XmlElement[] {
  return Array.from(parent.getElementsByTagName(tagName))
}

function first(parent: XmlParent, tagName: string): XmlElement | undefined {
  return elements(parent, tagName)[0]
}

function child(parent: XmlElement, tagName: string): XmlElement | undefined {
  return Array.from(parent.children).find((candidate) => candidate.tagName === tagName) as XmlElement | undefined
}

function directChildren(parent: XmlElement, tagName: string): XmlElement[] {
  return Array.from(parent.children).filter((candidate) => candidate.tagName === tagName) as XmlElement[]
}

function point(value: string | null | undefined, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed / EMUS_PER_POINT : fallback
}

function boundedFontSize(value: string | null | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(144, Math.max(8, parsed / 100)) : fallback
}

function colorFrom(parent: XmlParent | undefined, theme: Record<string, string>, fallback?: string): string | undefined {
  if (!parent) return fallback
  const rgb = first(parent, 'a:srgbClr')?.getAttribute('val')
  if (rgb && /^[0-9A-Fa-f]{6}$/.test(rgb)) return `#${rgb.toUpperCase()}`
  const system = first(parent, 'a:sysClr')?.getAttribute('lastClr')
  if (system && /^[0-9A-Fa-f]{6}$/.test(system)) return `#${system.toUpperCase()}`
  const scheme = first(parent, 'a:schemeClr')?.getAttribute('val')
  return scheme ? theme[scheme] ?? fallback : fallback
}

function readTheme(xml: string | undefined): Record<string, string> {
  if (!xml) return { ...DEFAULT_THEME }
  const document = parseXml(xml)
  const scheme = first(document, 'a:clrScheme')
  if (!scheme) return { ...DEFAULT_THEME }
  const theme = { ...DEFAULT_THEME }
  for (const entry of Array.from(scheme.children) as XmlElement[]) {
    const name = entry.tagName.replace(/^a:/, '')
    const value = colorFrom(entry, theme)
    if (value) theme[name] = value
  }
  theme.tx1 = theme.dk1
  theme.bg1 = theme.lt1
  theme.tx2 = theme.dk2
  theme.bg2 = theme.lt2
  return theme
}

function textStyle(properties: XmlElement | undefined, fallback: TextStyle, theme: Record<string, string>): TextStyle {
  return {
    fontFamily: (properties ? first(properties, 'a:latin')?.getAttribute('typeface') : undefined) || fallback.fontFamily,
    fontSizePt: boundedFontSize(properties?.getAttribute('sz'), fallback.fontSizePt),
    bold: properties?.getAttribute('b') === '1' || properties?.getAttribute('b') === 'true' || fallback.bold,
    italic: properties?.getAttribute('i') === '1' || properties?.getAttribute('i') === 'true' || fallback.italic,
    underline: Boolean(properties?.getAttribute('u') && properties?.getAttribute('u') !== 'none') || fallback.underline,
    strike: Boolean(properties?.getAttribute('strike') && properties?.getAttribute('strike') !== 'noStrike') || fallback.strike,
    color: colorFrom(properties, theme, fallback.color) ?? fallback.color,
  }
}

function defaultStyle(size = 20): TextStyle {
  return { fontFamily: 'Arial', fontSizePt: size, bold: false, italic: false, underline: false, strike: false, color: '#111111' }
}

function textRuns(owner: XmlElement, seed: string, theme: Record<string, string>): OfficeRichTextRun[] {
  const runs: OfficeRichTextRun[] = []
  const fontScale = Math.min(1, Math.max(0.01, Number(first(owner, 'a:normAutofit')?.getAttribute('fontScale') ?? 100_000) / 100_000))
  const paragraphs = elements(owner, 'a:p')
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const rawParagraphDefault = textStyle(first(paragraph, 'a:defRPr'), defaultStyle(), theme)
    const paragraphDefault = { ...rawParagraphDefault, fontSizePt: Math.max(8, rawParagraphDefault.fontSizePt * fontScale) }
    if (paragraphIndex > 0) {
      runs.push({ id: stableOfficeUuid(`${seed}:paragraph:${paragraphIndex}:break`), text: '\n', style: paragraphDefault })
    }
    let runIndex = 0
    for (const node of Array.from(paragraph.children) as XmlElement[]) {
      if (node.tagName === 'a:br') {
        runs.push({ id: stableOfficeUuid(`${seed}:paragraph:${paragraphIndex}:run:${runIndex}`), text: '\n', style: paragraphDefault })
        runIndex += 1
        continue
      }
      if (node.tagName !== 'a:r' && node.tagName !== 'a:fld') continue
      const text = first(node, 'a:t')?.textContent ?? ''
      if (!text) continue
      runs.push({
        id: stableOfficeUuid(`${seed}:paragraph:${paragraphIndex}:run:${runIndex}`),
        text,
        style: (() => {
          const style = textStyle(first(node, 'a:rPr'), rawParagraphDefault, theme)
          return { ...style, fontSizePt: Math.max(8, style.fontSizePt * fontScale) }
        })(),
      })
      runIndex += 1
    }
    if (runIndex === 0) {
      const text = elements(paragraph, 'a:t').map((entry) => entry.textContent ?? '').join('')
      if (text) runs.push({ id: stableOfficeUuid(`${seed}:paragraph:${paragraphIndex}:run:0`), text, style: paragraphDefault })
    }
  }
  return runs
}

function geometry(owner: XmlElement, partPath: string) {
  const transform = first(owner, 'a:xfrm') ?? first(owner, 'p:xfrm')
  const offset = transform && first(transform, 'a:off')
  const extent = transform && first(transform, 'a:ext')
  if (!offset || !extent) throw new Error(`${partPath}: supported object has no resolvable transform`)
  const widthPt = point(extent.getAttribute('cx'))
  const heightPt = point(extent.getAttribute('cy'))
  if (widthPt <= 0 || heightPt <= 0) throw new Error(`${partPath}: supported object has an empty transform`)
  return {
    xPt: point(offset.getAttribute('x')),
    yPt: point(offset.getAttribute('y')),
    widthPt,
    heightPt,
    rotationDeg: Number(transform.getAttribute('rot') ?? 0) / 60_000,
  }
}

function alignment(owner: XmlElement): 'start' | 'center' | 'end' | 'justify' {
  const value = first(owner, 'a:pPr')?.getAttribute('algn')
  return value === 'ctr' ? 'center' : value === 'r' ? 'end' : value === 'just' || value === 'dist' ? 'justify' : 'start'
}

function verticalAlignment(owner: XmlElement): 'top' | 'middle' | 'bottom' {
  const value = first(owner, 'a:bodyPr')?.getAttribute('anchor')
  return value === 'ctr' ? 'middle' : value === 'b' ? 'bottom' : 'top'
}

function relationshipMap(xml: string | undefined): Map<string, { target: string; type: string }> {
  if (!xml) return new Map()
  return new Map(elements(parseXml(xml), 'Relationship').map((entry) => [entry.getAttribute('Id') ?? '', {
    target: entry.getAttribute('Target') ?? '',
    type: entry.getAttribute('Type') ?? '',
  }]))
}

function relationshipPath(sourcePart: string, target: string): string {
  const normalized = target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(posix.dirname(sourcePart), target))
  if (!normalized.startsWith('ppt/') || normalized.split('/').includes('..')) throw new Error(`${sourcePart}: relationship target escapes the presentation package`)
  return normalized
}

function nonVisualProperties(owner: XmlElement): XmlElement | undefined {
  return first(owner, 'p:cNvPr')
}

function shapeObject(owner: XmlElement, seed: string, partPath: string, theme: Record<string, string>): PresentationObject {
  const objectGeometry = geometry(owner, partPath)
  const shapeProperties = first(owner, 'p:spPr')
  const shapeType = first(shapeProperties ?? owner, 'a:prstGeom')?.getAttribute('prst')
  const fillElement = shapeProperties && child(shapeProperties, 'a:solidFill')
  const line = shapeProperties && child(shapeProperties, 'a:ln')
  const fill = colorFrom(fillElement, theme)
  const stroke = line && !child(line, 'a:noFill') ? colorFrom(child(line, 'a:solidFill'), theme) : undefined
  const runs = textRuns(owner, seed, theme)
  const name = nonVisualProperties(owner)?.getAttribute('name') ?? ''
  const description = nonVisualProperties(owner)?.getAttribute('descr') ?? ''
  if (runs.length > 0 && !fill && !stroke) {
    return { id: stableOfficeUuid(seed), kind: 'text', geometry: objectGeometry, locked: false, alignment: alignment(owner), verticalAlignment: verticalAlignment(owner), runs }
  }
  const shape = shapeType === 'roundRect' ? 'roundedRectangle' : shapeType === 'ellipse' ? 'ellipse' : shapeType?.includes('triangle') ? 'triangle' : shapeType === 'line' ? 'line' : 'rectangle'
  return {
    id: stableOfficeUuid(seed), kind: 'shape', geometry: objectGeometry, locked: false, shape,
    fill, stroke, strokeWidthPt: line ? Math.max(0, point(line.getAttribute('w'), 1)) : 0,
    text: runs, altText: description || name || undefined,
  }
}

function mimeForPath(path: string): string | null {
  const extension = posix.extname(path).toLowerCase()
  return extension === '.png' ? 'image/png' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.svg' ? 'image/svg+xml' : null
}

async function pictureObject(params: {
  owner: XmlElement
  seed: string
  partPath: string
  relationships: Map<string, { target: string; type: string }>
  zip: JSZip
  resourcesByHash: Map<string, ExtractedOfficeResource>
}): Promise<PresentationObject> {
  const relationshipId = first(params.owner, 'a:blip')?.getAttribute('r:embed')
  const relationship = relationshipId ? params.relationships.get(relationshipId) : undefined
  if (!relationship || !relationship.type.endsWith('/image')) throw new Error(`${params.partPath}: picture relationship is missing or unsupported`)
  const sourcePart = relationshipPath(params.partPath, relationship.target)
  const entry = params.zip.file(sourcePart)
  const mime = mimeForPath(sourcePart)
  if (!entry || !mime) throw new Error(`${params.partPath}: picture ${sourcePart} is missing or uses an unsupported format`)
  const bytes = new Uint8Array(await entry.async('uint8array'))
  const hash = createHash('sha256').update(bytes).digest('hex')
  let resource = params.resourcesByHash.get(hash)
  if (!resource) {
    const id = stableOfficeUuid(`pptx-resource:${hash}`)
    resource = { ref: { id, kind: 'image', hash, mime, sensitivity: 'internal' }, bytes, sourcePart }
    params.resourcesByHash.set(hash, resource)
  }
  const properties = nonVisualProperties(params.owner)
  const description = properties?.getAttribute('descr') ?? ''
  const title = properties?.getAttribute('title') ?? properties?.getAttribute('name') ?? ''
  return {
    id: stableOfficeUuid(params.seed), kind: 'image', geometry: geometry(params.owner, params.partPath), locked: false,
    resourceId: resource.ref.id, altText: description || title, decorative: !description,
  }
}

function tableObject(owner: XmlElement, seed: string, partPath: string, theme: Record<string, string>): PresentationObject {
  const table = first(owner, 'a:tbl')
  if (!table) throw new Error(`${partPath}: table frame has no table payload`)
  const rows = directChildren(table, 'a:tr').map((row, rowIndex) => ({
    id: stableOfficeUuid(`${seed}:row:${rowIndex}`),
    cells: directChildren(row, 'a:tc').map((cell, cellIndex) => ({
      id: stableOfficeUuid(`${seed}:row:${rowIndex}:cell:${cellIndex}`),
      runs: textRuns(cell, `${seed}:row:${rowIndex}:cell:${cellIndex}`, theme),
      rowSpan: Math.max(1, Number(cell.getAttribute('rowSpan') ?? 1)),
      colSpan: Math.max(1, Number(cell.getAttribute('gridSpan') ?? 1)),
    })),
  }))
  if (rows.length === 0 || rows.some((row) => row.cells.length === 0)) throw new Error(`${partPath}: table has no canonical rows or cells`)
  return { id: stableOfficeUuid(seed), kind: 'table', geometry: geometry(owner, partPath), locked: false, headerRows: 1, rows }
}

function pointValues(parent: XmlElement | undefined): string[] {
  if (!parent) return []
  return elements(parent, 'c:pt')
    .sort((left, right) => Number(left.getAttribute('idx') ?? 0) - Number(right.getAttribute('idx') ?? 0))
    .map((entry) => first(entry, 'c:v')?.textContent ?? '')
}

async function chartObject(params: {
  owner: XmlElement
  seed: string
  partPath: string
  relationships: Map<string, { target: string; type: string }>
  zip: JSZip
}): Promise<PresentationObject> {
  const relationshipId = first(params.owner, 'c:chart')?.getAttribute('r:id')
  const relationship = relationshipId ? params.relationships.get(relationshipId) : undefined
  if (!relationship || !relationship.type.endsWith('/chart')) throw new Error(`${params.partPath}: chart relationship is missing or unsupported`)
  const chartPath = relationshipPath(params.partPath, relationship.target)
  const xml = await params.zip.file(chartPath)?.async('string')
  if (!xml) throw new Error(`${params.partPath}: chart payload ${chartPath} is missing`)
  const document = parseXml(xml)
  const chartElement = first(document, 'c:barChart') ?? first(document, 'c:lineChart') ?? first(document, 'c:pieChart') ?? first(document, 'c:doughnutChart') ?? first(document, 'c:scatterChart')
  if (!chartElement) throw new Error(`${chartPath}: chart type is outside the supported subset`)
  const chartType = chartElement.tagName === 'c:lineChart' ? 'line' : chartElement.tagName === 'c:pieChart' ? 'pie' : chartElement.tagName === 'c:doughnutChart' ? 'doughnut' : chartElement.tagName === 'c:scatterChart' ? 'scatter' : 'bar'
  const sourceSeries = directChildren(chartElement, 'c:ser')
  const categories = pointValues(first(sourceSeries[0], chartType === 'scatter' ? 'c:xVal' : 'c:cat'))
  const series = sourceSeries.map((entry, index) => ({
    name: first(first(entry, 'c:tx') ?? entry, 'c:v')?.textContent || `Series ${index + 1}`,
    values: pointValues(first(entry, chartType === 'scatter' ? 'c:yVal' : 'c:val')).map((value) => Number(value)),
  }))
  if (categories.length === 0 || series.length === 0 || series.some((entry) => entry.values.length !== categories.length || entry.values.some((value) => !Number.isFinite(value)))) {
    throw new Error(`${chartPath}: chart caches are incomplete or inconsistent`)
  }
  const properties = nonVisualProperties(params.owner)
  const titleText = elements(first(document, 'c:title') ?? document, 'a:t').map((entry) => entry.textContent ?? '').join(' ').trim()
  const name = properties?.getAttribute('name') || 'Chart'
  const title = titleText || name
  const description = properties?.getAttribute('descr') || `${title}. ${series.length} data series across ${categories.length} categories.`
  return { id: stableOfficeUuid(params.seed), kind: 'chart', geometry: geometry(params.owner, params.partPath), locked: false, chartType, title, categories, series, altText: description }
}

async function graphicFrameObject(params: {
  owner: XmlElement
  seed: string
  partPath: string
  relationships: Map<string, { target: string; type: string }>
  zip: JSZip
  theme: Record<string, string>
}): Promise<PresentationObject> {
  const data = first(params.owner, 'a:graphicData')
  const uri = data?.getAttribute('uri') ?? ''
  if (uri.endsWith('/table')) return tableObject(params.owner, params.seed, params.partPath, params.theme)
  if (uri.endsWith('/chart')) return chartObject(params)
  throw new Error(`${params.partPath}: graphic frame ${uri || 'without a type'} is outside the supported subset`)
}

function slideBackground(document: XmlDocument, seed: string, widthPt: number, heightPt: number, theme: Record<string, string>): PresentationObject | null {
  const background = first(document, 'p:bg')
  const fill = colorFrom(background, theme)
  if (!fill) return null
  return {
    id: stableOfficeUuid(seed), kind: 'shape', geometry: { xPt: 0, yPt: 0, widthPt, heightPt, rotationDeg: 0 },
    locked: true, shape: 'rectangle', fill, strokeWidthPt: 0, text: [], altText: 'Slide background',
  }
}

export async function importExternalPresentation(zip: JSZip, context: OfficeImportContext): Promise<{ snapshot: PresentationSnapshot; resources: ExtractedOfficeResource[] }> {
  const presentationXml = await zip.file('ppt/presentation.xml')?.async('string')
  if (!presentationXml) throw new Error('ppt/presentation.xml: presentation part is missing')
  const presentation = parseXml(presentationXml)
  const slideSize = first(presentation, 'p:sldSz')
  const widthPt = point(slideSize?.getAttribute('cx'), 960)
  const heightPt = point(slideSize?.getAttribute('cy'), 540)
  const themeXml = await zip.file('ppt/theme/theme1.xml')?.async('string')
  const theme = readTheme(themeXml)
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((left, right) => Number(left.match(/slide(\d+)/)?.[1] ?? 0) - Number(right.match(/slide(\d+)/)?.[1] ?? 0))
  const masterId = stableOfficeUuid(`${context.artifactId}:master`)
  const layoutId = stableOfficeUuid(`${context.artifactId}:layout`)
  const resourcesByHash = new Map<string, ExtractedOfficeResource>()
  const slides = []
  for (const [slideIndex, partPath] of slidePaths.entries()) {
    const xml = await zip.file(partPath)!.async('string')
    const document = parseXml(xml)
    const relationshipPart = `${posix.dirname(partPath)}/_rels/${posix.basename(partPath)}.rels`
    const relationships = relationshipMap(await zip.file(relationshipPart)?.async('string'))
    const seed = `${context.artifactId}:slide:${slideIndex}`
    const objects: PresentationObject[] = []
    const background = slideBackground(document, `${seed}:background`, widthPt, heightPt, theme)
    if (background) objects.push(background)
    const tree = first(document, 'p:spTree')
    if (!tree) throw new Error(`${partPath}: slide object tree is missing`)
    let objectIndex = 0
    for (const owner of Array.from(tree.children) as XmlElement[]) {
      if (owner.tagName === 'p:nvGrpSpPr' || owner.tagName === 'p:grpSpPr') continue
      const objectSeed = `${seed}:object:${objectIndex}`
      if (owner.tagName === 'p:sp') objects.push(shapeObject(owner, objectSeed, partPath, theme))
      else if (owner.tagName === 'p:pic') objects.push(await pictureObject({ owner, seed: objectSeed, partPath, relationships, zip, resourcesByHash }))
      else if (owner.tagName === 'p:graphicFrame') objects.push(await graphicFrameObject({ owner, seed: objectSeed, partPath, relationships, zip, theme }))
      else if (owner.tagName === 'p:cxnSp' || owner.tagName === 'p:grpSp') throw new Error(`${partPath}: ${owner.tagName} is not yet supported for lossless import`)
      else continue
      objectIndex += 1
    }
    const title = objects.flatMap((object) => object.kind === 'text' ? object.runs : object.kind === 'shape' ? object.text : []).map((run) => run.text).join('').trim().slice(0, 500) || `Slide ${slideIndex + 1}`
    slides.push({ id: stableOfficeUuid(seed), title, masterId, layoutId, objects, readingOrder: objects.map((object) => object.id), notes: [] })
  }
  if (slides.length === 0) throw new Error('ppt/slides: presentation contains no slides')
  const resources = [...resourcesByHash.values()]
  return {
    snapshot: {
      schemaVersion: 1, capabilityVersion: 1, artifactId: context.artifactId, workspaceId: context.workspaceId,
      family: 'presentation', locale: context.locale, defaultLanguage: context.defaultLanguage,
      templateVersionId: context.templateVersionId, rootId: stableOfficeUuid(`${context.artifactId}:root`), title: context.title,
      resources: resources.map((resource) => resource.ref), accessibility: { title: context.title },
      slideSize: { widthPt, heightPt }, themeId: stableOfficeUuid(`${context.artifactId}:theme`),
      masters: [{ id: masterId, name: 'Imported master', lockedObjectIds: [] }],
      layouts: [{ id: layoutId, masterId, name: 'Imported layout', placeholderIds: [] }], slides,
    },
    resources,
  }
}
