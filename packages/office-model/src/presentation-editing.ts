import {
  PresentationChartSchema,
  PresentationObjectSchema,
  PresentationSlideSchema,
  PresentationTableSchema,
  type PresentationObject,
  type PresentationSlide,
  type OfficeRichTextRun,
} from './model.js'

export type PresentationIdFactory = () => string
export type PresentationBounds = { xPt: number; yPt: number; widthPt: number; heightPt: number }
export type PresentationArrangeOperation =
  | 'alignLeft'
  | 'alignCenter'
  | 'alignRight'
  | 'alignTop'
  | 'alignMiddle'
  | 'alignBottom'
  | 'distributeHorizontal'
  | 'distributeVertical'
  | 'centerOnSlide'
  | 'centerOnSlideHorizontal'
  | 'centerOnSlideVertical'
export type PresentationZOrderOperation = 'bringForward' | 'sendBackward' | 'bringToFront' | 'sendToBack'
export type PresentationSnapGuide = { axis: 'x' | 'y'; positionPt: number; source: 'slide-center' | 'slide-edge' | 'object-center' | 'object-edge' }
export type PresentationTextFormatting = Partial<{
  fontFamily: string
  fontSizePt: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color: string
  href: string | null
  alignment: 'start' | 'center' | 'end' | 'justify'
  verticalAlignment: 'top' | 'middle' | 'bottom'
}>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function textRuns(object: PresentationObject): OfficeRichTextRun[] | null {
  return object.kind === 'text' ? object.runs : object.kind === 'shape' ? object.text : null
}

/** Whole-object/whole-run formatting with stable run identity. */
export function formatPresentationTextObject(object: PresentationObject, formatting: PresentationTextFormatting): PresentationObject {
  const runs = textRuns(object)
  if (!runs) throw new Error('Presentation object does not support text formatting')
  if (formatting.href !== undefined && formatting.href !== null && !/^(https:|mailto:)/.test(formatting.href)) throw new Error('Presentation links must use HTTPS or mailto')
  const stylePatch = Object.fromEntries(Object.entries(formatting).filter(([key, value]) => !['href', 'alignment', 'verticalAlignment'].includes(key) && value !== undefined))
  const nextRuns = runs.map((run) => ({
    ...run,
    style: { ...run.style, ...stylePatch },
    ...(formatting.href === undefined ? {} : formatting.href === null || formatting.href === '' ? { href: undefined } : { href: formatting.href }),
  }))
  const next = clone(object)
  if (next.kind === 'text') next.runs = nextRuns
  else if (next.kind === 'shape') next.text = nextRuns
  if ((next.kind === 'text' || next.kind === 'shape') && formatting.alignment !== undefined) next.alignment = formatting.alignment
  if ((next.kind === 'text' || next.kind === 'shape') && formatting.verticalAlignment !== undefined) next.verticalAlignment = formatting.verticalAlignment
  return PresentationObjectSchema.parse(next)
}

export function commonPresentationTextFormatting(objects: readonly PresentationObject[]): Partial<Record<keyof PresentationTextFormatting, unknown>> | null {
  if (!objects.length || objects.some((object) => !textRuns(object))) return null
  const values = objects.map((object) => {
    const runs = textRuns(object)!
    const first = runs[0]
    const commonRun = <T>(read: (run: OfficeRichTextRun) => T): T | undefined => first && runs.every((run) => read(run) === read(first)) ? read(first) : undefined
    return {
      fontFamily: commonRun((run) => run.style.fontFamily), fontSizePt: commonRun((run) => run.style.fontSizePt),
      bold: commonRun((run) => run.style.bold), italic: commonRun((run) => run.style.italic), underline: commonRun((run) => run.style.underline),
      strike: commonRun((run) => run.style.strike), color: commonRun((run) => run.style.color), href: commonRun((run) => run.href),
      alignment: object.kind === 'text' || object.kind === 'shape' ? object.alignment : undefined,
      verticalAlignment: object.kind === 'text' || object.kind === 'shape' ? object.verticalAlignment : undefined,
    }
  })
  const keys = Object.keys(values[0]) as Array<keyof PresentationTextFormatting>
  return Object.fromEntries(keys.map((key) => [key, values.every((value) => value[key] === values[0][key]) ? values[0][key] : undefined]))
}

function visitIds(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return
  if (!Array.isArray(value)) visit(value as Record<string, unknown>)
  for (const child of Array.isArray(value) ? value : Object.values(value)) visitIds(child, visit)
}

function remapOwnedIds<T>(value: T, createId: PresentationIdFactory): { value: T; idMap: Map<string, string> } {
  const next = clone(value)
  const idMap = new Map<string, string>()
  visitIds(next, (record) => {
    if (typeof record.id === 'string') idMap.set(record.id, createId())
  })
  visitIds(next, (record) => {
    if (typeof record.id === 'string') record.id = idMap.get(record.id)!
    for (const endpoint of ['fromObjectId', 'toObjectId'] as const) {
      if (typeof record[endpoint] === 'string' && idMap.has(record[endpoint] as string)) record[endpoint] = idMap.get(record[endpoint] as string)!
    }
    if (Array.isArray(record.readingOrder)) record.readingOrder = record.readingOrder.map((id) => typeof id === 'string' ? (idMap.get(id) ?? id) : id)
  })
  return { value: next, idMap }
}

export function clonePresentationObjects(
  objects: readonly PresentationObject[],
  createId: PresentationIdFactory,
  offsetPt = 12,
): { objects: PresentationObject[]; idMap: Map<string, string> } {
  const remapped = remapOwnedIds([...objects], createId)
  for (const object of remapped.value) {
    object.geometry.xPt += offsetPt
    object.geometry.yPt += offsetPt
  }
  return { objects: remapped.value.map((object) => PresentationObjectSchema.parse(object)), idMap: remapped.idMap }
}

export function clonePresentationSlide(slide: PresentationSlide, createId: PresentationIdFactory): { slide: PresentationSlide; idMap: Map<string, string> } {
  const remapped = remapOwnedIds(slide, createId)
  return { slide: PresentationSlideSchema.parse(remapped.value), idMap: remapped.idMap }
}

export function presentationSelectionBounds(objects: readonly PresentationObject[]): PresentationBounds | null {
  if (objects.length === 0) return null
  const left = Math.min(...objects.map((object) => object.geometry.xPt))
  const top = Math.min(...objects.map((object) => object.geometry.yPt))
  const right = Math.max(...objects.map((object) => object.geometry.xPt + object.geometry.widthPt))
  const bottom = Math.max(...objects.map((object) => object.geometry.yPt + object.geometry.heightPt))
  return { xPt: left, yPt: top, widthPt: right - left, heightPt: bottom - top }
}

function movedObject(object: PresentationObject, xPt: number, yPt: number): PresentationObject {
  return { ...object, geometry: { ...object.geometry, xPt, yPt } }
}

export function arrangePresentationObjects(
  objects: readonly PresentationObject[],
  operation: PresentationArrangeOperation,
  slideSize?: { widthPt: number; heightPt: number },
): PresentationObject[] {
  const bounds = presentationSelectionBounds(objects)
  if (!bounds) return []
  if (operation.startsWith('centerOnSlide') && !slideSize) throw new Error('Slide size is required for slide centering')
  if (operation === 'distributeHorizontal' || operation === 'distributeVertical') {
    if (objects.length < 3) return objects.map(clone)
    const horizontal = operation === 'distributeHorizontal'
    const sorted = [...objects].sort((left, right) => {
      const leftValue = horizontal ? left.geometry.xPt : left.geometry.yPt
      const rightValue = horizontal ? right.geometry.xPt : right.geometry.yPt
      return leftValue - rightValue || left.id.localeCompare(right.id)
    })
    const totalSize = sorted.reduce((sum, object) => sum + (horizontal ? object.geometry.widthPt : object.geometry.heightPt), 0)
    const extent = horizontal ? bounds.widthPt : bounds.heightPt
    const gap = (extent - totalSize) / (objects.length - 1)
    let cursor = horizontal ? bounds.xPt : bounds.yPt
    const positions = new Map<string, number>()
    for (const object of sorted) {
      positions.set(object.id, cursor)
      cursor += (horizontal ? object.geometry.widthPt : object.geometry.heightPt) + gap
    }
    return objects.map((object) => horizontal
      ? movedObject(object, positions.get(object.id)!, object.geometry.yPt)
      : movedObject(object, object.geometry.xPt, positions.get(object.id)!))
  }
  return objects.map((object) => {
    const geometry = object.geometry
    let xPt = geometry.xPt
    let yPt = geometry.yPt
    if (operation === 'alignLeft') xPt = bounds.xPt
    else if (operation === 'alignCenter') xPt = bounds.xPt + (bounds.widthPt - geometry.widthPt) / 2
    else if (operation === 'alignRight') xPt = bounds.xPt + bounds.widthPt - geometry.widthPt
    else if (operation === 'alignTop') yPt = bounds.yPt
    else if (operation === 'alignMiddle') yPt = bounds.yPt + (bounds.heightPt - geometry.heightPt) / 2
    else if (operation === 'alignBottom') yPt = bounds.yPt + bounds.heightPt - geometry.heightPt
    else if (operation === 'centerOnSlideHorizontal' || operation === 'centerOnSlide') xPt += slideSize!.widthPt / 2 - (bounds.xPt + bounds.widthPt / 2)
    if (operation === 'centerOnSlideVertical' || operation === 'centerOnSlide') yPt += slideSize!.heightPt / 2 - (bounds.yPt + bounds.heightPt / 2)
    return movedObject(object, xPt, yPt)
  })
}

export function presentationZOrderIndex(length: number, currentIndex: number, operation: PresentationZOrderOperation): number {
  if (length < 1 || currentIndex < 0 || currentIndex >= length) throw new Error('Object index is outside the slide')
  if (operation === 'bringToFront') return length - 1
  if (operation === 'sendToBack') return 0
  if (operation === 'bringForward') return Math.min(length - 1, currentIndex + 1)
  return Math.max(0, currentIndex - 1)
}

type SnapCandidate = { guide: number; delta: number; priority: number; source: PresentationSnapGuide['source']; order: number }

function bestSnap(candidates: SnapCandidate[], thresholdPt: number): SnapCandidate | null {
  return candidates
    .filter((candidate) => Math.abs(candidate.delta) <= thresholdPt)
    .sort((left, right) => left.priority - right.priority || Math.abs(left.delta) - Math.abs(right.delta) || left.order - right.order || left.guide - right.guide)[0] ?? null
}

export function snapPresentationGeometry(
  geometry: PresentationObject['geometry'],
  otherObjects: readonly PresentationObject[],
  slideSize: { widthPt: number; heightPt: number },
  thresholdPt = 4,
): { geometry: PresentationObject['geometry']; guides: PresentationSnapGuide[] } {
  const movingX = [geometry.xPt, geometry.xPt + geometry.widthPt / 2, geometry.xPt + geometry.widthPt]
  const movingY = [geometry.yPt, geometry.yPt + geometry.heightPt / 2, geometry.yPt + geometry.heightPt]
  const xCandidates: SnapCandidate[] = []
  const yCandidates: SnapCandidate[] = []
  const add = (target: SnapCandidate[], guide: number, anchors: number[], priority: number, source: PresentationSnapGuide['source'], order: number) => {
    anchors.forEach((anchor, anchorOrder) => target.push({ guide, delta: guide - anchor, priority, source, order: order * 3 + anchorOrder }))
  }
  add(xCandidates, slideSize.widthPt / 2, movingX, 0, 'slide-center', 0)
  add(yCandidates, slideSize.heightPt / 2, movingY, 0, 'slide-center', 0)
  ;[0, slideSize.widthPt].forEach((guide, order) => add(xCandidates, guide, movingX, 1, 'slide-edge', order))
  ;[0, slideSize.heightPt].forEach((guide, order) => add(yCandidates, guide, movingY, 1, 'slide-edge', order))
  otherObjects.forEach((object, objectOrder) => {
    const x = object.geometry.xPt
    const y = object.geometry.yPt
    add(xCandidates, x + object.geometry.widthPt / 2, movingX, 2, 'object-center', objectOrder)
    add(yCandidates, y + object.geometry.heightPt / 2, movingY, 2, 'object-center', objectOrder)
    ;[x, x + object.geometry.widthPt].forEach((guide, edgeOrder) => add(xCandidates, guide, movingX, 3, 'object-edge', objectOrder * 2 + edgeOrder))
    ;[y, y + object.geometry.heightPt].forEach((guide, edgeOrder) => add(yCandidates, guide, movingY, 3, 'object-edge', objectOrder * 2 + edgeOrder))
  })
  const xSnap = bestSnap(xCandidates, thresholdPt)
  const ySnap = bestSnap(yCandidates, thresholdPt)
  const guides: PresentationSnapGuide[] = []
  if (xSnap) guides.push({ axis: 'x', positionPt: xSnap.guide, source: xSnap.source })
  if (ySnap) guides.push({ axis: 'y', positionPt: ySnap.guide, source: ySnap.source })
  return {
    geometry: { ...geometry, xPt: geometry.xPt + (xSnap?.delta ?? 0), yPt: geometry.yPt + (ySnap?.delta ?? 0) },
    guides,
  }
}

const DEFAULT_TEXT_STYLE = { fontFamily: 'Arial', fontSizePt: 14, bold: false, italic: false, underline: false, strike: false, color: '#111111' }

export function createPresentationTableObject(params: {
  id?: string
  rows: number
  columns: number
  geometry: PresentationObject['geometry']
  createId: PresentationIdFactory
}): Extract<PresentationObject, { kind: 'table' }> {
  if (!Number.isInteger(params.rows) || params.rows < 1 || params.rows > 20 || !Number.isInteger(params.columns) || params.columns < 1 || params.columns > 20) {
    throw new Error('Presentation tables support 1 to 20 rows and columns')
  }
  return PresentationTableSchema.parse({
    id: params.id ?? params.createId(), kind: 'table', geometry: params.geometry, locked: false, headerRows: 1,
    columnWidthsPt: Array.from({ length: params.columns }, () => params.geometry.widthPt / params.columns),
    rows: Array.from({ length: params.rows }, (_, rowIndex) => ({
      id: params.createId(),
      cells: Array.from({ length: params.columns }, () => ({
        id: params.createId(), runs: [{ id: params.createId(), text: '', style: DEFAULT_TEXT_STYLE }], rowSpan: 1, colSpan: 1,
        fill: rowIndex === 0 ? '#E5E7EB' : '#FFFFFF', alignment: 'start', verticalAlignment: 'middle', wrapText: true,
      })),
    })),
  })
}

export function createPresentationChartObject(params: {
  id?: string
  chartType: 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter'
  title: string
  categories: string[]
  series: Array<{ name: string; values: number[] }>
  altText: string
  geometry: PresentationObject['geometry']
  createId: PresentationIdFactory
}): Extract<PresentationObject, { kind: 'chart' }> {
  if (params.categories.length < 1 || params.categories.length > 50 || params.series.length < 1 || params.series.length > 20) throw new Error('Presentation chart data is outside supported bounds')
  if (params.series.some((series) => series.values.length !== params.categories.length || series.values.some((value) => !Number.isFinite(value)))) throw new Error('Every chart series must contain one finite value per category')
  if (params.chartType === 'scatter' && params.categories.some((category) => !Number.isFinite(Number(category)))) throw new Error('Scatter chart categories must be numeric X values')
  return PresentationChartSchema.parse({
    id: params.id ?? params.createId(), kind: 'chart', chartType: params.chartType, title: params.title,
    categories: params.categories, series: params.series, altText: params.altText, geometry: params.geometry, locked: false,
  })
}
