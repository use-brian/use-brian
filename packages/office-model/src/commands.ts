import { z } from 'zod'
import {
  DocumentFlowNodeSchema,
  OfficeArtifactSnapshotSchema,
  OfficeRichTextRunSchema,
  OfficeUuidSchema,
  PresentationObjectSchema,
  PresentationSlideSchema,
  type OfficeArtifactSnapshot,
} from './model.js'

const CommandBaseSchema = z.object({
  commandId: OfficeUuidSchema,
  artifactId: OfficeUuidSchema,
  baseVersion: z.number().int().min(0),
  actor: z.object({ type: z.enum(['user', 'assistant', 'import', 'system']), id: OfficeUuidSchema }).strict(),
  origin: z.enum(['manual', 'ai', 'import', 'offline', 'restore']),
})

export const OfficeCommandSchema = z.discriminatedUnion('kind', [
  CommandBaseSchema.extend({ kind: z.literal('updateText'), targetId: OfficeUuidSchema, runs: z.array(OfficeRichTextRunSchema) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('insertDocumentNode'), sectionId: OfficeUuidSchema, index: z.number().int().min(0), node: DocumentFlowNodeSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('insertSlideObject'), slideId: OfficeUuidSchema, index: z.number().int().min(0), object: PresentationObjectSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('deleteObject'), targetId: OfficeUuidSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('setObjectProperty'), targetId: OfficeUuidSchema, path: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/)).min(1).max(8), value: z.unknown() }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('addSlide'), index: z.number().int().min(0), slide: PresentationSlideSchema }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('reorderSlide'), slideId: OfficeUuidSchema, index: z.number().int().min(0) }).strict(),
  CommandBaseSchema.extend({ kind: z.literal('batch'), commands: z.array(z.unknown()).min(1).max(1_000) }).strict(),
])
export type OfficeCommand = z.infer<typeof OfficeCommandSchema>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function findObject(value: unknown, id: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  if (!Array.isArray(value) && (value as Record<string, unknown>).id === id) return value as Record<string, unknown>
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findObject(child, id)
    if (found) return found
  }
  return null
}

function assertSafePropertyPart(part: string): void {
  if (part === '__proto__' || part === 'constructor' || part === 'prototype') throw new Error('Unsafe property path')
}

function deleteObject(value: unknown, id: string): boolean {
  if (!value || typeof value !== 'object') return false
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (!Array.isArray(child)) continue
    const index = child.findIndex((candidate) => candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).id === id)
    if (index >= 0) {
      child.splice(index, 1)
      return true
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (deleteObject(child, id)) return true
  }
  return false
}

function applySingle(snapshot: OfficeArtifactSnapshot, command: Exclude<OfficeCommand, { kind: 'batch' }>): OfficeArtifactSnapshot {
  const next = clone(snapshot) as OfficeArtifactSnapshot
  if (next.artifactId !== command.artifactId) throw new Error('Command artifact does not match snapshot')

  if (command.kind === 'updateText') {
    const target = findObject(next, command.targetId)
    if (!target || !('runs' in target)) throw new Error(`Text target ${command.targetId} was not found`)
    target.runs = command.runs
  } else if (command.kind === 'insertDocumentNode') {
    if (next.family !== 'document') throw new Error('insertDocumentNode requires a document')
    const section = next.sections.find((candidate) => candidate.id === command.sectionId)
    if (!section) throw new Error(`Section ${command.sectionId} was not found`)
    section.nodes.splice(Math.min(command.index, section.nodes.length), 0, command.node)
  } else if (command.kind === 'insertSlideObject') {
    if (next.family !== 'presentation') throw new Error('insertSlideObject requires a presentation')
    const slide = next.slides.find((candidate) => candidate.id === command.slideId)
    if (!slide) throw new Error(`Slide ${command.slideId} was not found`)
    slide.objects.splice(Math.min(command.index, slide.objects.length), 0, command.object)
    slide.readingOrder.splice(Math.min(command.index, slide.readingOrder.length), 0, command.object.id)
  } else if (command.kind === 'deleteObject') {
    if (!deleteObject(next, command.targetId)) throw new Error(`Object ${command.targetId} was not found`)
    if (next.family === 'presentation') {
      for (const slide of next.slides) slide.readingOrder = slide.readingOrder.filter((id) => id !== command.targetId)
    }
  } else if (command.kind === 'setObjectProperty') {
    const target = command.targetId === next.rootId ? next as unknown as Record<string, unknown> : findObject(next, command.targetId)
    if (!target) throw new Error(`Object ${command.targetId} was not found`)
    let cursor = target
    for (const part of command.path.slice(0, -1)) {
      assertSafePropertyPart(part)
      const child = cursor[part]
      if (!child || typeof child !== 'object' || Array.isArray(child)) throw new Error(`Property path ${command.path.join('.')} was not found`)
      cursor = child as Record<string, unknown>
    }
    const finalPart = command.path.at(-1)!
    assertSafePropertyPart(finalPart)
    cursor[finalPart] = command.value
  } else if (command.kind === 'addSlide') {
    if (next.family !== 'presentation') throw new Error('addSlide requires a presentation')
    next.slides.splice(Math.min(command.index, next.slides.length), 0, command.slide)
  } else if (command.kind === 'reorderSlide') {
    if (next.family !== 'presentation') throw new Error('reorderSlide requires a presentation')
    const from = next.slides.findIndex((slide) => slide.id === command.slideId)
    if (from < 0) throw new Error(`Slide ${command.slideId} was not found`)
    const [slide] = next.slides.splice(from, 1)
    next.slides.splice(Math.min(command.index, next.slides.length), 0, slide)
  }

  return OfficeArtifactSnapshotSchema.parse(next)
}

export function applyOfficeCommand(snapshot: OfficeArtifactSnapshot, input: OfficeCommand): OfficeArtifactSnapshot {
  const command = OfficeCommandSchema.parse(input)
  if (command.kind !== 'batch') return applySingle(snapshot, command)
  let next = snapshot
  for (const child of command.commands) {
    const parsed = OfficeCommandSchema.parse(child)
    if (parsed.kind === 'batch') throw new Error('Nested Office command batches are not supported')
    next = applySingle(next, parsed)
  }
  return next
}
