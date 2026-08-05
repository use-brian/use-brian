import type {
  DocumentFlowNode,
  DocumentSnapshot,
  OfficeArtifactSnapshot,
  OfficeRichTextRun,
  PresentationObject,
  PresentationSnapshot,
} from '@use-brian/office-model'

export type OfficeDisplayPrimitive = {
  id: string
  kind: 'text' | 'image' | 'rect' | 'line' | 'table' | 'chart' | 'video'
  xPt: number
  yPt: number
  widthPt: number
  heightPt: number
  text?: string
  resourceId?: string
  sourceKind?: string
  z: number
}

export type OfficeDisplayPage = {
  id: string
  widthPt: number
  heightPt: number
  primitives: OfficeDisplayPrimitive[]
}

export type OfficeLayoutIssue = {
  code: 'overflow' | 'collision' | 'readability' | 'missing-resource'
  objectId: string
  message: string
}

export type OfficeLayoutResult = {
  family: 'document' | 'presentation'
  pages: OfficeDisplayPage[]
  issues: OfficeLayoutIssue[]
  serialization: string
}

export type OfficeFitBudget = {
  maxPages?: number
  maxSlides?: number
  maxTextCharsByObject?: Record<string, number>
  minimumFontSizePt?: number
}

export type OfficeFitResult = {
  ok: boolean
  attempts: number
  result: OfficeLayoutResult
  issues: OfficeLayoutIssue[]
}

function textOf(runs: readonly OfficeRichTextRun[]): string {
  return runs.map((run) => run.text).join('')
}

function characterWidthFactor(character: string): number {
  if (/\s/.test(character)) return 0.28
  if (/[ilI1|.,'`:;]/.test(character)) return 0.28
  if (/[mwMW@%&]/.test(character)) return 0.82
  if (/[A-Z0-9]/.test(character)) return 0.6
  return 0.5
}

function lineWidth(runs: readonly OfficeRichTextRun[]): number {
  return runs.reduce((width, run) => width + [...run.text].reduce((sum, character) => sum + run.style.fontSizePt * characterWidthFactor(character), 0), 0)
}

function textLines(runs: readonly OfficeRichTextRun[]): OfficeRichTextRun[][] {
  const lines: OfficeRichTextRun[][] = [[]]
  for (const run of runs) {
    const parts = run.text.split('\n')
    for (const [index, text] of parts.entries()) {
      if (index > 0) lines.push([])
      if (text) lines[lines.length - 1].push({ ...run, text })
    }
  }
  return lines
}

function textMetrics(runs: readonly OfficeRichTextRun[], widthPt: number): { widthPt: number; heightPt: number } {
  const lines = textLines(runs)
  const widths = lines.map(lineWidth)
  const heightPt = lines.reduce((height, line, index) => {
    const font = Math.max(8, ...line.map((run) => run.style.fontSizePt))
    const wraps = Math.max(1, Math.ceil(widths[index] / Math.max(1, widthPt)))
    return height + wraps * font * 1.15
  }, 0)
  return { widthPt: Math.min(widthPt, Math.max(0, ...widths)), heightPt }
}

function textHeight(runs: readonly OfficeRichTextRun[], widthPt: number): number {
  return textMetrics(runs, widthPt).heightPt
}

function textInkBounds(object: Extract<PresentationObject, { kind: 'text' }>): OfficeDisplayPrimitive {
  const metrics = textMetrics(object.runs, object.geometry.widthPt)
  const xPt = object.alignment === 'center'
    ? object.geometry.xPt + (object.geometry.widthPt - metrics.widthPt) / 2
    : object.alignment === 'end'
      ? object.geometry.xPt + object.geometry.widthPt - metrics.widthPt
      : object.geometry.xPt
  const yPt = object.verticalAlignment === 'middle'
    ? object.geometry.yPt + (object.geometry.heightPt - metrics.heightPt) / 2
    : object.verticalAlignment === 'bottom'
      ? object.geometry.yPt + object.geometry.heightPt - metrics.heightPt
      : object.geometry.yPt
  return { id: object.id, kind: 'text', xPt, yPt, widthPt: metrics.widthPt, heightPt: metrics.heightPt, z: 0 }
}

function documentNodeHeight(node: DocumentFlowNode, widthPt: number): number {
  if (node.kind === 'paragraph' || node.kind === 'heading') return textHeight(node.runs, widthPt) + 8
  if (node.kind === 'list') return node.items.reduce((height, item) => height + textHeight(item.runs, widthPt - 24), 0) + 8
  if (node.kind === 'table') return Math.max(36, node.rows.length * 28)
  if (node.kind === 'image') return node.heightPt
  if (node.kind === 'chart') return 240
  if (node.kind === 'video') return 270
  return 0
}

function nodePrimitive(node: DocumentFlowNode, xPt: number, yPt: number, widthPt: number, heightPt: number, z: number): OfficeDisplayPrimitive | null {
  if (node.kind === 'pageBreak' || node.kind === 'sectionBreak') return null
  if (node.kind === 'paragraph' || node.kind === 'heading') return { id: node.id, kind: 'text', xPt, yPt, widthPt, heightPt, text: textOf(node.runs), sourceKind: node.kind, z }
  if (node.kind === 'list') return { id: node.id, kind: 'text', xPt, yPt, widthPt, heightPt, text: node.items.map((item, index) => `${node.ordered ? `${index + 1}.` : '•'} ${textOf(item.runs)}`).join('\n'), sourceKind: node.kind, z }
  if (node.kind === 'image') return { id: node.id, kind: 'image', xPt, yPt, widthPt: Math.min(widthPt, node.widthPt), heightPt, resourceId: node.resourceId, sourceKind: node.kind, z }
  if (node.kind === 'table') return { id: node.id, kind: 'table', xPt, yPt, widthPt, heightPt, sourceKind: node.kind, z }
  if (node.kind === 'chart') return { id: node.id, kind: 'chart', xPt, yPt, widthPt, heightPt, text: node.title, sourceKind: node.kind, z }
  return { id: node.id, kind: 'video', xPt, yPt, widthPt, heightPt, resourceId: node.resourceId, sourceKind: node.kind, z }
}

function layoutDocument(snapshot: DocumentSnapshot): OfficeLayoutResult {
  const pages: OfficeDisplayPage[] = []
  const issues: OfficeLayoutIssue[] = []
  for (const section of snapshot.sections) {
    const width = section.page.widthPt
    const height = section.page.heightPt
    const bodyWidth = width - section.page.marginLeftPt - section.page.marginRightPt
    const bottom = height - section.page.marginBottomPt
    let page: OfficeDisplayPage = { id: `${section.id}:${pages.length}`, widthPt: width, heightPt: height, primitives: [] }
    pages.push(page)
    let y = section.page.marginTopPt
    for (const node of section.nodes) {
      if (node.kind === 'pageBreak' || (node.kind === 'sectionBreak' && page.primitives.length > 0)) {
        page = { id: `${section.id}:${pages.length}`, widthPt: width, heightPt: height, primitives: [] }
        pages.push(page)
        y = section.page.marginTopPt
        continue
      }
      const nodeHeight = documentNodeHeight(node, bodyWidth)
      if (y + nodeHeight > bottom && page.primitives.length > 0) {
        page = { id: `${section.id}:${pages.length}`, widthPt: width, heightPt: height, primitives: [] }
        pages.push(page)
        y = section.page.marginTopPt
      }
      if (nodeHeight > bottom - section.page.marginTopPt) issues.push({ code: 'overflow', objectId: node.id, message: 'Object is taller than the printable page body' })
      const primitive = nodePrimitive(node, section.page.marginLeftPt, y, bodyWidth, nodeHeight, page.primitives.length)
      if (primitive) page.primitives.push(primitive)
      y += nodeHeight
    }
  }
  const serialization = JSON.stringify(pages)
  return { family: 'document', pages, issues, serialization }
}

function slidePrimitive(object: PresentationObject, z: number): OfficeDisplayPrimitive {
  const geometry = object.geometry
  const common = { id: object.id, xPt: geometry.xPt, yPt: geometry.yPt, widthPt: geometry.widthPt, heightPt: geometry.heightPt, sourceKind: object.kind, z }
  if (object.kind === 'text') return { ...common, kind: 'text', text: textOf(object.runs) }
  if (object.kind === 'image') return { ...common, kind: 'image', resourceId: object.resourceId }
  if (object.kind === 'shape') return { ...common, kind: object.shape === 'line' ? 'line' : 'rect', text: textOf(object.text) }
  if (object.kind === 'connector') return { ...common, kind: 'line' }
  if (object.kind === 'table') return { ...common, kind: 'table' }
  if (object.kind === 'chart') return { ...common, kind: 'chart', text: object.title }
  return { ...common, kind: 'video', resourceId: object.resourceId }
}

function overlaps(left: OfficeDisplayPrimitive, right: OfficeDisplayPrimitive): boolean {
  return left.xPt < right.xPt + right.widthPt && left.xPt + left.widthPt > right.xPt && left.yPt < right.yPt + right.heightPt && left.yPt + left.heightPt > right.yPt
}

function layoutPresentation(snapshot: PresentationSnapshot): OfficeLayoutResult {
  const issues: OfficeLayoutIssue[] = []
  const pages = snapshot.slides.map((slide) => {
    const primitives = slide.objects.map(slidePrimitive)
    for (const primitive of primitives) {
      if (primitive.xPt < 0 || primitive.yPt < 0 || primitive.xPt + primitive.widthPt > snapshot.slideSize.widthPt || primitive.yPt + primitive.heightPt > snapshot.slideSize.heightPt) {
        issues.push({ code: 'overflow', objectId: primitive.id, message: 'Object extends outside the slide boundary' })
      }
      if (primitive.kind === 'text') {
        const object = slide.objects.find((candidate) => candidate.id === primitive.id)
        if (object?.kind === 'text' && textHeight(object.runs, primitive.widthPt) > primitive.heightPt) issues.push({ code: 'overflow', objectId: primitive.id, message: 'Text does not fit its box at the readability floor' })
      }
    }
    for (let left = 0; left < primitives.length; left += 1) {
      for (let right = left + 1; right < primitives.length; right += 1) {
        if (primitives[left].kind === 'text' && primitives[right].kind === 'text') {
          const leftObject = slide.objects[left]
          const rightObject = slide.objects[right]
          if (leftObject?.kind === 'text' && rightObject?.kind === 'text' && overlaps(textInkBounds(leftObject), textInkBounds(rightObject))) issues.push({ code: 'collision', objectId: primitives[right].id, message: `Text overlaps ${primitives[left].id}` })
        }
      }
    }
    return { id: slide.id, widthPt: snapshot.slideSize.widthPt, heightPt: snapshot.slideSize.heightPt, primitives }
  })
  const serialization = JSON.stringify(pages)
  return { family: 'presentation', pages, issues, serialization }
}

export function layoutOfficeArtifact(snapshot: OfficeArtifactSnapshot): OfficeLayoutResult {
  return snapshot.family === 'document' ? layoutDocument(snapshot) : layoutPresentation(snapshot)
}

/** D16's deterministic fit gate. It validates; it never silently truncates,
 * shrinks, hides, or invents a layout. Generation may repair the named issues
 * and call again within its own bounded loop. */
export function fitOfficeArtifact(snapshot: OfficeArtifactSnapshot, budget: OfficeFitBudget = {}): OfficeFitResult {
  const result = layoutOfficeArtifact(snapshot)
  const issues = [...result.issues]
  const pageLimit = snapshot.family === 'document' ? budget.maxPages : budget.maxSlides
  if (pageLimit !== undefined && result.pages.length > pageLimit) {
    issues.push({ code: 'overflow', objectId: snapshot.rootId, message: `${snapshot.family === 'document' ? 'Page' : 'Slide'} count ${result.pages.length} exceeds the admitted limit ${pageLimit}` })
  }
  const floor = budget.minimumFontSizePt ?? 8
  const visitRuns = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (!Array.isArray(value)) {
      const object = value as Record<string, unknown>
      const style = object.style as Record<string, unknown> | undefined
      if (style && typeof style.fontSizePt === 'number' && style.fontSizePt < floor) {
        issues.push({ code: 'readability', objectId: typeof object.id === 'string' ? object.id : snapshot.rootId, message: `Font size ${style.fontSizePt}pt is below the ${floor}pt readability floor` })
      }
      const max = typeof object.id === 'string' ? budget.maxTextCharsByObject?.[object.id] : undefined
      if (max !== undefined && typeof object.text === 'string' && object.text.length > max) {
        issues.push({ code: 'overflow', objectId: object.id as string, message: `Text length ${object.text.length} exceeds the admitted field budget ${max}` })
      }
    }
    for (const child of Object.values(value)) visitRuns(child)
  }
  visitRuns(snapshot)
  return { ok: issues.length === 0, attempts: 1, result, issues }
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** Browser/server preview input over the exact display-list coordinates used
 * by export validation. The UI may mount this SVG directly or translate the
 * same primitives to DOM nodes. */
export function renderOfficePreviewSvg(page: OfficeDisplayPage): string {
  const primitives = [...page.primitives].sort((left, right) => left.z - right.z).map((primitive) => {
    const common = `data-office-object="${escapeXml(primitive.id)}" x="${primitive.xPt}" y="${primitive.yPt}" width="${primitive.widthPt}" height="${primitive.heightPt}"`
    if (primitive.kind === 'text') return `<foreignObject ${common}><div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(primitive.text ?? '')}</div></foreignObject>`
    if (primitive.kind === 'line') return `<line data-office-object="${escapeXml(primitive.id)}" x1="${primitive.xPt}" y1="${primitive.yPt}" x2="${primitive.xPt + primitive.widthPt}" y2="${primitive.yPt + primitive.heightPt}"/>`
    if (primitive.kind === 'rect') return `<rect ${common}/>`
    const label = primitive.kind === 'image' ? 'Image' : primitive.kind === 'table' ? 'Table' : primitive.kind === 'chart' ? `Chart: ${primitive.text ?? ''}` : 'Video'
    return `<g data-office-object="${escapeXml(primitive.id)}"><rect x="${primitive.xPt}" y="${primitive.yPt}" width="${primitive.widthPt}" height="${primitive.heightPt}"/><text x="${primitive.xPt + 4}" y="${primitive.yPt + 16}">${escapeXml(label)}</text></g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.widthPt} ${page.heightPt}" role="img">${primitives}</svg>`
}

export function officeGoldenSerialization(snapshot: OfficeArtifactSnapshot): string {
  const layout = layoutOfficeArtifact(snapshot)
  return JSON.stringify({ family: layout.family, pages: layout.pages, previews: layout.pages.map(renderOfficePreviewSvg), issues: layout.issues })
}
