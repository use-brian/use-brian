import * as Y from 'yjs'
import { blockSchema, type Block } from '@use-brian/core/views/blocks.js'
import { FRAGMENT_FIELD } from './schema.js'
import type { PMNode } from './block-mapping.js'

type Drawing = Extract<Block, { kind: 'drawing' }>
type Scene = Drawing['scene']
type Registers = Pick<Map<string, unknown>, 'get' | 'has'> & { forEach: (fn: (value: unknown, key: string) => void) => void }
const identities = new WeakMap<object, string>()
const parsedBlocks = new WeakMap<Y.XmlElement, { raw: string; block: Drawing }>()
const retainedSizes = new WeakMap<object, number>()
const baseSizes = new WeakMap<Y.XmlElement, { raw: string; bytes: number }>()
export const DRAWING_PROTOCOL = 'brian-drawing-v1:'
export const DRAWING_RETENTION_LIMITS = { bytes: 16 * 1024 * 1024, registers: 50_000, namespaces: 128 } as const

function jsonBytes(value: unknown): number {
  if (value && typeof value === 'object') {
    const cached = retainedSizes.get(value)
    if (cached !== undefined) return cached
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length
    retainedSizes.set(value, bytes)
    return bytes
  }
  return new TextEncoder().encode(JSON.stringify(value) ?? 'null').length
}

export function drawingRetention(doc: Y.Doc, target?: Y.Map<unknown>, changes?: Map<string, unknown>) {
  let bytes = 0, registers = 0, namespaces = 0
  const countBases = (parent: Y.XmlFragment) => {
    for (const node of parent.toArray()) if (node instanceof Y.XmlElement) {
      const raw = node.nodeName === 'embed' ? node.getAttribute('block') : undefined
      if (raw) {
        let cached = baseSizes.get(node)
        if (cached?.raw !== raw) {
          let size = 0
          try { if (JSON.parse(raw)?.kind === 'drawing') size = new TextEncoder().encode(raw).length } catch { /* invalid base is handled by its reader */ }
          cached = { raw, bytes: size }
          baseSizes.set(node, cached)
        }
        bytes += cached.bytes
      }
      countBases(node)
    }
  }
  countBases(doc.getXmlFragment(FRAGMENT_FIELD))
  for (const [name] of doc.share) {
    if (!name.startsWith('drawing:')) continue
    const map = doc.getMap(name)
    const values = new Map<string, unknown>()
    map.forEach((value, key) => values.set(key, value))
    if (map === target) changes?.forEach((value, key) => values.set(key, value))
    if (!values.size) continue
    namespaces++
    registers += values.size
    bytes += jsonBytes(name) + 5 + Math.max(0, values.size - 1)
    values.forEach((value, key) => { bytes += jsonBytes(key) + jsonBytes(value) + 3 })
  }
  return { bytes, registers, namespaces }
}

function checkRetention(doc: Y.Doc, target: Y.Map<unknown>, changes: Map<string, unknown>) {
  const before = drawingRetention(doc), after = drawingRetention(doc, target, changes)
  const deletionOnly = [...changes.keys()].every(key => key.startsWith('deleted:'))
  if (!deletionOnly && (Object.keys(after) as (keyof typeof after)[]).some(key =>
    after[key] > DRAWING_RETENTION_LIMITS[key] && after[key] > before[key])) throw new Error('drawing-retention-limit')
}

// Stable 128-bit content identity, not an authorization token. Object order can
// change through JSONB; array order (including legacy element order) cannot.
function identity(value: unknown): string {
  if (value && typeof value === 'object') {
    const cached = identities.get(value)
    if (cached) return cached
  }
  const text = JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
  let a = 1779033703, b = 3144134277, c = 1013904242, d = 2773480762
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i)
    a = b ^ Math.imul(a ^ k, 597399067)
    b = c ^ Math.imul(b ^ k, 2869860233)
    c = d ^ Math.imul(c ^ k, 951274213)
    d = a ^ Math.imul(d ^ k, 2716044179)
  }
  a = Math.imul(c ^ (a >>> 18), 597399067)
  b = Math.imul(d ^ (b >>> 22), 2869860233)
  c = Math.imul(a ^ (c >>> 17), 951274213)
  d = Math.imul(b ^ (d >>> 19), 2716044179)
  const result = [a ^ b ^ c ^ d, b ^ a, c ^ a, d ^ a].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('')
  if (value && typeof value === 'object') identities.set(value, result)
  return result
}

export function drawingRegisters(doc: Y.Doc, block: Drawing): Y.Map<unknown> {
  return doc.getMap(drawingNamespace(doc, block))
}

export function drawingNamespace(doc: Y.Doc, block: Drawing): string {
  const epoch = findDrawingNode(doc, block.id)?.getAttribute('drawingEpoch') ?? ''
  return `drawing:${block.id}:${epoch}:${identity(block.scene)}`
}

function findDrawingNode(doc: Y.Doc, id: string): Y.XmlElement | undefined {
  const visit = (parent: Y.XmlFragment): Y.XmlElement | undefined => {
    for (const node of parent.toArray()) {
      if (!(node instanceof Y.XmlElement)) continue
      if (node.nodeName === 'embed' && node.getAttribute('blockId') === id) {
        return node
      }
      const found = visit(node)
      if (found) return found
    }
  }
  return visit(doc.getXmlFragment(FRAGMENT_FIELD))
}

export function findDrawing(doc: Y.Doc, id: string): Drawing | undefined {
  const node = findDrawingNode(doc, id)
  if (!node) return
  const raw = node.getAttribute('block') ?? 'null'
  const cached = parsedBlocks.get(node)
  if (cached?.raw === raw) return cached.block
  let value: unknown
  try { value = JSON.parse(raw) } catch { return }
  const parsed = blockSchema.safeParse(value)
  if (parsed.success && parsed.data.kind === 'drawing') {
    parsedBlocks.set(node, { raw, block: parsed.data })
    return parsed.data
  }
}

export function projectDrawing(block: Drawing, registers: Registers): Drawing {
  try { return projectDrawingRegisters(block, registers) }
  catch { return { ...block, preview: undefined, collaborationError: 'invalid-registers' } }
}

function projectDrawingRegisters(block: Drawing, registers: Registers): Drawing {
  let changed = false
  let sceneChanged = false
  registers.forEach((_value, key) => {
    changed = true
    if (key.startsWith('element:') || key.startsWith('deleted:') || key === 'background') sceneChanged = true
  })
  if (!changed) return block
  const elements = new Map(block.scene.elements.map(element => [element.id, element]))
  const deletedInBase = new Set(block.scene.elements.filter(element => element.isDeleted).map(element => element.id))
  registers.forEach((value, key) => {
    if (key.startsWith('element:')) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { id?: unknown }).id !== key.slice(8)) throw new Error('drawing-invalid-element')
      elements.set(key.slice(8), value as Scene['elements'][number])
    }
    if (key.startsWith('deleted:') && typeof value !== 'boolean') throw new Error('drawing-invalid-tombstone')
  })
  const order = new Map(block.scene.elements.map((element, index) => [element.id, index]))
  const sorted = [...elements.values()].filter(element => !element.isDeleted && !deletedInBase.has(element.id) && !registers.get(`deleted:${element.id}`)).sort((a, b) => {
      const ai = typeof a.index === 'string' ? a.index : ''
      const bi = typeof b.index === 'string' ? b.index : ''
      return ai < bi ? -1 : ai > bi ? 1 : (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    })
  const files: Scene['files'] = {}
  for (const element of sorted) if (element.type === 'image' && !element.isDeleted && element.fileId) {
    const file = registers.get(`file:${element.fileId}`) ?? block.scene.files[element.fileId]
    if (file) files[element.fileId] = file as Scene['files'][string]
  }
  const scene: Scene = sceneChanged ? { version: 1, elements: sorted, files,
    appState: { viewBackgroundColor: registers.get('background') as string ?? block.scene.appState.viewBackgroundColor } } : block.scene
  const exported = registers.get('preview') as { key: string; value: Drawing['preview'] } | undefined
  const preview = exported?.key === identity(scene) ? exported.value ?? undefined
    : identity(scene) === identity(block.scene) ? block.preview : undefined
  const projected = { ...block, scene, preview,
    title: registers.has('title') ? registers.get('title') : block.title }
  const parsed = blockSchema.safeParse(projected)
  if (parsed.success) return parsed.data as Drawing
  // Limits constrain authored writes, but an offline union can exceed them.
  // Keep that union durable and repairable; never fail whole-page persistence
  // or truncate content. Structural/asset validation is still mandatory.
  if (parsed.error.issues.every(issue =>
    (issue.code === 'too_big' && issue.path.join('.') === 'scene.elements') ||
    (issue.code === 'custom' && issue.message === 'Drawing exceeds 2 MiB'))) return structuredClone(projected) as Drawing
  throw parsed.error
}

/** Materialize at read/copy boundaries only, never write projections back live. */
export function projectDrawingNodeJSON(doc: Y.Doc, node: PMNode, copy = false): PMNode {
  if (node.type === 'embed' && typeof node.attrs?.block === 'string') {
    const block = JSON.parse(node.attrs.block) as Block
    if (block.kind === 'drawing') {
      const base = findDrawing(doc, block.id) ?? block
      const projected = projectDrawing(base, drawingRegisters(doc, base))
      const id = copy ? crypto.randomUUID() : block.id
      return { ...node, attrs: { ...node.attrs, ...(copy ? { blockId: id, drawingEpoch: null } : {}), block: JSON.stringify({ ...projected, id }) } }
    }
  }
  return node.content ? { ...node, content: node.content.map(child => projectDrawingNodeJSON(doc, child, copy)) } : node
}

/** Local delta writer. No seeds: the immutable embed is the implicit baseline. */
export class DrawingCollaboration {
  readonly registers: Y.Map<unknown>
  readonly origin = {}
  readonly undo: Y.UndoManager
  private active = true
  constructor(readonly doc: Y.Doc, readonly base: Drawing, private allowed: () => boolean) {
    this.registers = drawingRegisters(doc, base)
    this.undo = new Y.UndoManager(this.registers, { trackedOrigins: new Set([this.origin]),
      deleteFilter: item => item.parent !== this.registers || !item.parentSub?.startsWith('file:'),
    })
  }
  valid(): boolean {
    if (!this.active || !this.allowed()) return false
    const current = findDrawing(this.doc, this.base.id)
    return !!current && drawingRegisters(this.doc, current) === this.registers
  }
  read(): Drawing {
    const projected = projectDrawing(findDrawing(this.doc, this.base.id) ?? this.base, this.registers)
    if (projected.collaborationError) throw new Error('drawing-invalid-registers')
    return projected
  }
  write(previous: Scene, next: Scene): boolean {
    if (!this.valid()) return false
    const changes = new Map<string, unknown>()
    const before = new Map(previous.elements.map(element => [element.id, element]))
    const after = new Map(next.elements.map(element => [element.id, element]))
    for (const element of next.elements) {
      if (JSON.stringify(element) === JSON.stringify(before.get(element.id))) continue
      // A geometry edit cannot revive a concurrently deleted element. Explicit
      // local undo is handled by Y.UndoManager, which removes our tombstone only.
      if (element.isDeleted) changes.set(`deleted:${element.id}`, true)
      // Y.Map JSON values must not retain SDK-owned mutable objects.
      changes.set(`element:${element.id}`, structuredClone(element))
    }
    for (const element of previous.elements) if (!after.has(element.id)) changes.set(`deleted:${element.id}`, true)
    for (const [id, file] of Object.entries(next.files)) {
      const existing = this.registers.get(`file:${id}`) ?? this.base.scene.files[id]
      if (existing && (existing as Scene['files'][string]).dataURL !== file.dataURL) throw new Error('drawing-file-id-conflict')
      if (!existing) changes.set(`file:${id}`, structuredClone(file))
    }
    if (next.appState.viewBackgroundColor !== previous.appState.viewBackgroundColor) changes.set('background', next.appState.viewBackgroundColor)
    if (!changes.size) return true
    const candidate = new Map<string, unknown>()
    this.registers.forEach((value, key) => candidate.set(key, value))
    changes.forEach((value, key) => candidate.set(key, value))
    const projected = projectDrawing(this.base, candidate)
    if (projected.collaborationError) throw new Error('drawing-invalid-registers')
    blockSchema.parse(projected) // Validate the merged result before any writes.
    checkRetention(this.doc, this.registers, changes)
    this.doc.transact(() => changes.forEach((value, key) => this.registers.set(key, value)), this.origin)
    return true
  }
  rename(title: string): boolean {
    if (!this.valid()) return false
    const current = this.read()
    const parsed = blockSchema.parse({ ...current, title }) as Drawing
    if ((current.title ?? '') === (parsed.title ?? '')) return true
    checkRetention(this.doc, this.registers, new Map([['title', parsed.title]]))
    this.doc.transact(() => this.registers.set('title', parsed.title), this.origin)
    return true
  }
  preview(scene: Scene, preview: Drawing['preview']): boolean {
    if (!this.valid()) return false
    const current = this.read()
    if (identity(current.scene) !== identity(scene)) return false
    const validated = blockSchema.parse({ ...current, preview }) as Drawing
    checkRetention(this.doc, this.registers, new Map([['preview', { key: identity(scene), value: validated.preview ?? null }]]))
    this.doc.transact(() => this.registers.set('preview', { key: identity(scene), value: validated.preview ?? null }), 'drawing-preview')
    return true
  }
  dispose(): void { this.active = false; this.undo.destroy() }
}
