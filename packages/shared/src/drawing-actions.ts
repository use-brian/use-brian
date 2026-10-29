import { z } from 'zod'
import { drawingSceneSchema, type DrawingScene } from './drawing.js'
import { validateLibraryItems, type DrawingLibraryItem } from './drawing-library.js'

type Element = DrawingScene['elements'][number]
const id = z.string().min(1).max(128)
const coordinate = z.number().finite().min(-10_000_000).max(10_000_000)
const size = z.number().finite().positive().max(10_000_000)
export const drawingActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), elementIds: z.array(id).min(1).max(256), dx: coordinate, dy: coordinate }).strict(),
  z.object({ type: z.literal('resize'), elementId: id, width: size, height: size }).strict(),
  z.object({ type: z.literal('connect'), fromId: id, toId: id }).strict(),
  // Item data is host-resolved, never a model-authored scene. Revalidated below.
  z.object({ type: z.literal('insertLibraryItem'), item: z.custom<DrawingLibraryItem>(), x: coordinate, y: coordinate }).strict(),
])
export const drawingActionsSchema = z.array(drawingActionSchema).max(64)
export type DrawingAction = z.infer<typeof drawingActionSchema>
export type DrawingEditOp = { op: 'drawing'; blockId: string; namespace?: string; actions: DrawingAction[] }

const connectable = new Set(['rectangle', 'diamond', 'ellipse'])
function touch(element: Element) {
  element.version = Number(element.version ?? 0) + 1
  element.versionNonce = Math.floor(Math.random() * 0x7fffffff)
  element.updated = Date.now()
}
function center(element: Element): [number, number] {
  return [element.x + element.width / 2, element.y + element.height / 2]
}
/** Boundary point on a rotated shape, along the ray toward the other endpoint. */
function endpoint(element: Element, toward: [number, number], gap: number): [number, number] {
  const [cx, cy] = center(element), angle = Number(element.angle ?? 0)
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const dx = toward[0] - cx, dy = toward[1] - cy
  const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos
  const w = Math.abs(element.width) / 2, h = Math.abs(element.height) / 2
  if (!w || !h || (!lx && !ly)) throw new Error('Connected shapes need distinct centers and nonzero dimensions')
  const t = element.type === 'ellipse' ? 1 / Math.sqrt((lx / w) ** 2 + (ly / h) ** 2)
    : element.type === 'diamond' ? 1 / (Math.abs(lx) / w + Math.abs(ly) / h)
    : Math.min(lx ? w / Math.abs(lx) : Infinity, ly ? h / Math.abs(ly) : Infinity)
  const length = Math.hypot(dx, dy)
  return [cx + dx * (t + gap / length), cy + dy * (t + gap / length)]
}
function bindingId(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'elementId' in value && typeof value.elementId === 'string' ? value.elementId : undefined
}
function setPoints(element: Extract<Element, { type: 'arrow' | 'line' }>, points: [number, number][]) {
  const [x, y] = points[0]
  element.x = x; element.y = y
  element.points = points.map(([px, py]) => [px - x, py - y])
  element.width = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]))
  element.height = Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]))
  element.angle = 0
}

// Excalidraw uses base-62 fractional indices. For append, incrementing the
// integer part yields a valid key after all its fractional suffixes.
function nextIndex(last: string): string {
  if (!last || /^[A-Z]/.test(last)) return 'a0'
  const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const length = last.charCodeAt(0) - 97 + 2
  const integer = last.slice(0, length)
  if (!/^[a-z][0-9A-Za-z]+$/.test(integer) || integer.length !== length) throw new Error('Invalid drawing order; reopen the editor to repair it')
  const chars = integer.split('')
  for (let i = chars.length - 1; i > 0; i--) {
    const value = digits.indexOf(chars[i])
    if (value < 61) { chars[i] = digits[value + 1]; return chars.join('') }
    chars[i] = '0'
  }
  return chars[0] === 'z' ? `${last}V` : `${String.fromCharCode(chars[0].charCodeAt(0) + 1)}${'0'.repeat(length)}`
}

/** Compute the entire batch without mutating the supplied scene. */
export function applyDrawingActions(source: DrawingScene, input: DrawingAction[], generateId: () => string = () => crypto.randomUUID()): DrawingScene {
  const actions = drawingActionsSchema.parse(input)
  const scene = structuredClone(source)
  const byId = new Map(scene.elements.filter(e => !e.isDeleted).map(e => [e.id, e]))
  if (byId.size !== scene.elements.filter(e => !e.isDeleted).length) throw new Error('Duplicate drawing element IDs')
  const requireShape = (id: string) => {
    const element = byId.get(id)
    if (!element) throw new Error(`Shape not found: ${id}; read the drawing again`)
    if (element.locked) throw new Error(`Shape is locked: ${id}`)
    return element
  }
  let lastIndex = scene.elements.reduce((last, e) => typeof e.index === 'string' && e.index > last ? e.index : last, '')
  const append = (element: Element) => {
    if (byId.has(element.id)) throw new Error('Generated shape ID already exists')
    lastIndex = nextIndex(lastIndex); element.index = lastIndex
    scene.elements.push(element); byId.set(element.id, element)
  }
  const placeLabels = (changed: Set<string>, delta?: [number, number]) => {
    for (const label of scene.elements) if (label.type === 'text' && typeof label.containerId === 'string' && changed.has(label.containerId) && !changed.has(label.id)) {
      requireShape(label.id)
      const container = byId.get(label.containerId)!
      if (delta) { label.x += delta[0]; label.y += delta[1] }
      else { label.x = container.x + (container.width - label.width) / 2; label.y = container.y + (container.height - label.height) / 2 }
      touch(label)
    }
  }
  const updateConnectors = (changed: Set<string>) => {
    for (const arrow of scene.elements) {
      if (arrow.type !== 'arrow' || arrow.isDeleted) continue
      const startId = bindingId(arrow.startBinding), endId = bindingId(arrow.endBinding)
      if (!(startId && changed.has(startId)) && !(endId && changed.has(endId))) continue
      requireShape(arrow.id)
      if (arrow.elbowed || Number(arrow.angle ?? 0) !== 0) throw new Error('Transforming elbow or rotated bound arrows is not supported')
      const points: [number, number][] = arrow.points.map(([x, y]) => [arrow.x + x, arrow.y + y])
      const start = startId ? requireShape(startId) : undefined, end = endId ? requireShape(endId) : undefined
      if ((start && !connectable.has(start.type)) || (end && !connectable.has(end.type))) throw new Error('Unsupported connector target')
      if (start) points[0] = endpoint(start, end ? center(end) : points.at(-1)!, arrow.startBinding?.gap ?? 8)
      if (end) points[points.length - 1] = endpoint(end, start ? center(start) : points[0], arrow.endBinding?.gap ?? 8)
      setPoints(arrow, points)
      // The new endpoints are centered bindings, not the old edge focus.
      if (arrow.startBinding) arrow.startBinding = { elementId: arrow.startBinding.elementId, focus: 0, gap: arrow.startBinding.gap }
      if (arrow.endBinding) arrow.endBinding = { elementId: arrow.endBinding.elementId, focus: 0, gap: arrow.endBinding.gap }
      touch(arrow)
      placeLabels(new Set([arrow.id]))
    }
  }
  for (const action of actions) {
    if (action.type === 'move') {
      const selected = action.elementIds.map(requireShape)
      const groups = new Set(selected.flatMap(e => e.groupIds ?? []))
      const changed = new Set([...selected, ...scene.elements.filter(e => !e.isDeleted && e.groupIds?.some(g => groups.has(g)))].map(e => e.id))
      for (const id of changed) {
        const element = requireShape(id)
        if (element.type === 'text' && element.containerId && !changed.has(String(element.containerId))) throw new Error('Move the text container instead')
        if (element.type === 'arrow' && (element.startBinding || element.endBinding) &&
          ![bindingId(element.startBinding), bindingId(element.endBinding)].filter(Boolean).every(id => changed.has(id!))) throw new Error('Move the endpoint shapes instead of a bound arrow')
        element.x += action.dx; element.y += action.dy; touch(element)
      }
      placeLabels(changed, [action.dx, action.dy]); updateConnectors(changed)
    } else if (action.type === 'resize') {
      const element = requireShape(action.elementId)
      if ((element.type === 'arrow' && (element.startBinding || element.endBinding))) throw new Error('Resize the endpoint shapes instead of a bound arrow or frame')
      if (element.width <= 0 || element.height <= 0) throw new Error('Cannot resize a shape with nonpositive dimensions')
      const sx = action.width / element.width, sy = action.height / element.height
      if (element.type === 'line' || element.type === 'arrow' || element.type === 'freedraw') element.points = element.points.map(([x, y]) => [x * sx, y * sy])
      if (element.type === 'text') {
        if (element.containerId) throw new Error('Resize the text container instead')
        if (Math.abs(sx - sy) > 0.001) throw new Error('Text resizing must preserve its aspect ratio')
        element.fontSize *= sx
      }
      element.width = action.width; element.height = action.height; touch(element)
      const changed = new Set([element.id]); placeLabels(changed); updateConnectors(changed)
    } else if (action.type === 'connect') {
      const from = requireShape(action.fromId), to = requireShape(action.toId)
      if (from.id === to.id || !connectable.has(from.type) || !connectable.has(to.type)) throw new Error('Connect two distinct rectangles, diamonds or ellipses')
      const arrow: Extract<Element, { type: 'arrow' }> = {
        id: generateId(), type: 'arrow', x: 0, y: 0, width: 0, height: 0, points: [[0, 0], [1, 1]],
        angle: 0, strokeColor: typeof from.strokeColor === 'string' && from.strokeColor !== 'transparent' && !/^#[0-9a-f]{6}00$/i.test(from.strokeColor) ? from.strokeColor : '#1b1b1f', backgroundColor: 'transparent',
        fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
        seed: Math.floor(Math.random() * 0x7fffffff), version: 1, versionNonce: 1, updated: Date.now(),
        isDeleted: false, groupIds: [], frameId: null, boundElements: null, link: null, locked: false,
        startArrowhead: null, endArrowhead: 'arrow', elbowed: false,
        startBinding: { elementId: from.id, focus: 0, gap: 8 }, endBinding: { elementId: to.id, focus: 0, gap: 8 },
      }
      setPoints(arrow, [endpoint(from, center(to), 8), endpoint(to, center(from), 8)])
      append(arrow)
      for (const shape of [from, to]) { shape.boundElements = [...(shape.boundElements ?? []), { id: arrow.id, type: 'arrow' }]; touch(shape) }
    } else {
      const item = validateLibraryItems([action.item])[0]
      const elements = structuredClone(item.elements)
      const ids = new Map(elements.map(e => [e.id, generateId()]))
      if (ids.size !== elements.length) throw new Error('Library item has duplicate element IDs')
      const groups = new Map(elements.flatMap(e => e.groupIds ?? []).map(g => [g, generateId()]))
      const minX = Math.min(...elements.map(e => e.x)), minY = Math.min(...elements.map(e => e.y))
      for (const element of elements) {
        element.id = ids.get(element.id)!
        element.x += action.x - minX; element.y += action.y - minY
        element.groupIds = (element.groupIds ?? []).map(g => groups.get(g)!)
        element.frameId = typeof element.frameId === 'string' ? ids.get(element.frameId) ?? null : null
        if ('containerId' in element) element.containerId = typeof element.containerId === 'string' ? ids.get(element.containerId) ?? null : null
        element.boundElements = (element.boundElements ?? []).flatMap(b => ids.has(b.id) ? [{ ...b, id: ids.get(b.id)! }] : [])
        element.boundElementIds = (element.boundElementIds ?? []).flatMap(id => ids.has(id) ? [ids.get(id)!] : [])
        if (element.type === 'arrow' || element.type === 'line') {
          for (const key of ['startBinding', 'endBinding'] as const) {
            const binding = element[key]
            element[key] = binding && ids.has(binding.elementId) ? { ...binding, elementId: ids.get(binding.elementId)! } : null
          }
        }
        // Imported fractional indices belong to the old scene; restore fresh ordering.
        delete element.index
        touch(element); append(element)
      }
    }
    drawingSceneSchema.parse(scene) // Bound each intermediate allocation as well as the final scene.
  }
  return drawingSceneSchema.parse(scene)
}

/** No raster bytes or sprawling style records in model-facing live reads. */
export function describeDrawing(scene: DrawingScene) {
  return scene.elements.filter(e => !e.isDeleted).map(e => ({
    id: e.id, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height,
    angle: e.angle ?? 0, locked: e.locked ?? false, groupIds: e.groupIds ?? [],
    ...(e.type === 'text' ? { text: e.text, containerId: e.containerId ?? null } : {}),
    ...(e.type === 'arrow' || e.type === 'line' ? { startBinding: e.startBinding, endBinding: e.endBinding } : {}),
  }))
}

export type DrawingEditResult = { namespace: string; scene: DrawingScene; title?: string; changedElementIds: string[] }
