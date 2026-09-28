/**
 * Item-level edits of a website content draft, so an assistant changes one
 * entry (a speaker, a partner, a reply time) without resending the whole
 * collection. Pure: the store applies the operations to the current draft
 * inside its version-checked transaction and validates the result with the
 * collection schema. [COMP:crm/site-content]
 */
import { z } from 'zod'
import { AssociationError } from './domain.js'
import { SiteImageSchema, LocalizedTextSchema, EventSectionSchema, type SiteContentCollection } from './site-content.js'

/**
 * A path addresses a value from the document root, segments separated by `/`.
 * An array segment matches an entry by its reference (`id`, `key`, `event` or
 * `slug`), or by zero-based position for entries without one.
 * e.g. `pages/space-night/sections/speakers/people/0/title/zh-Hant`.
 */
const path = z.string().trim().min(1).max(400).regex(/^[^/](?:.*[^/])?$/, 'No leading or trailing slash')
export const SiteContentOperationSchema = z.discriminatedUnion('op', [
  /** Replace or create the value at `path`. */
  z.object({ op: z.literal('set'), path, value: z.unknown() }).strict(),
  /** Add an entry to the list at `path`, at `index` or the end. */
  z.object({ op: z.literal('insert'), path, value: z.unknown(), index: z.number().int().min(0).optional() }).strict(),
  /** Remove the value or list entry at `path`. */
  z.object({ op: z.literal('remove'), path }).strict(),
  /** Move the list entry at `path` to `index` within its list. */
  z.object({ op: z.literal('move'), path, index: z.number().int().min(0) }).strict(),
])
export type SiteContentOperation = z.infer<typeof SiteContentOperationSchema>
export const SiteContentOperationsSchema = z.array(SiteContentOperationSchema).min(1).max(50)

const IDENTITY = ['id', 'key', 'event', 'slug'] as const
type Json = unknown
type Container = Record<string, Json> | Json[]

function fail(message: string): never { throw new AssociationError('invalid_edit', message) }
const isObject = (value: Json): value is Record<string, Json> => !!value && typeof value === 'object' && !Array.isArray(value)
const identity = (value: Json) => isObject(value) ? IDENTITY.map(field => value[field]).find(entry => typeof entry === 'string') as string | undefined : undefined
function indexIn(list: Json[], segment: string): number {
  const byReference = list.findIndex(entry => identity(entry) === segment)
  if (byReference >= 0) return byReference
  return /^\d+$/.test(segment) && Number(segment) < list.length && identity(list[Number(segment)]) === undefined ? Number(segment) : -1
}
const segments = (value: string) => value.split('/').map(segment => segment.trim())

function child(container: Json, segment: string, at: string): Json {
  if (Array.isArray(container)) {
    const index = indexIn(container, segment)
    if (index < 0) fail(`Nothing at ${at}`)
    return container[index]
  }
  if (isObject(container)) return container[segment]
  return fail(`Nothing at ${at}`)
}

/** The value at `path`, or undefined. */
export function siteContentValueAt(document: Json, target: string): Json {
  let current: Json = document
  for (const segment of segments(target)) {
    if (Array.isArray(current)) { const index = indexIn(current, segment); if (index < 0) return undefined; current = current[index] }
    else if (isObject(current)) current = current[segment]
    else return undefined
  }
  return current
}

/** Walk to the container holding the last segment, creating missing objects on the way when `create`. */
function parentOf(document: Record<string, Json>, target: string, create: boolean): { container: Container; last: string } {
  const parts = segments(target)
  let current: Json = document
  for (let i = 0; i < parts.length - 1; i++) {
    const at = parts.slice(0, i + 1).join('/')
    let next = child(current, parts[i]!, at)
    if (next === undefined && create && isObject(current)) { next = {}; current[parts[i]!] = next }
    if (!next || typeof next !== 'object') fail(`Nothing at ${at}`)
    current = next
  }
  if (!current || typeof current !== 'object') fail(`Nothing at ${target}`)
  return { container: current as Container, last: parts[parts.length - 1]! }
}

function listAt(document: Record<string, Json>, target: string): Json[] {
  const list = siteContentValueAt(document, target)
  if (!Array.isArray(list)) fail(`${target} is not a list`)
  return list
}

/**
 * Tool schemas reach some model providers with free-form values typed as text, so a model may send
 * `{"en":"Hello"}`, `3` or `true` as a string. Decode it when the value it replaces is not text, or when a
 * new value is clearly an object or list; genuine text (a name, a link) stays text.
 */
function decode(value: Json, replaces: Json): Json {
  if (typeof value !== 'string') return value
  const text = value.trim()
  const shaped = text.startsWith('{') || text.startsWith('[')
  if (!(replaces !== undefined && typeof replaces !== 'string') && !shaped) return value
  try { return JSON.parse(text) } catch { return value }
}

/**
 * Apply operations to a copy of the draft (or the collection's empty document).
 * Returns the edited document and the paths that changed; the caller validates it.
 */
export function applySiteContentOperations(collection: SiteContentCollection, draft: Json, operations: readonly SiteContentOperation[]) {
  const base = draft ?? emptySiteContentDocument(collection)
  if (!base) fail(`${collection} has no draft yet. Save the whole page first.`)
  const document = structuredClone(base) as Record<string, Json>
  const changed: string[] = []
  for (const operation of operations) {
    switch (operation.op) {
      case 'set': {
        const { container, last } = parentOf(document, operation.path, true)
        if (Array.isArray(container)) {
          const index = indexIn(container, last)
          if (index < 0) fail(`Nothing at ${operation.path}; use insert to add an entry`)
          container[index] = decode(operation.value, container[index])
        } else container[last] = decode(operation.value, container[last])
        break
      }
      case 'insert': {
        const list = listAt(document, operation.path)
        const value = decode(operation.value, list[0])
        const reference = identity(value)
        if (reference !== undefined && list.some(entry => identity(entry) === reference)) fail(`${operation.path} already has ${reference}; use set to change it`)
        list.splice(Math.min(operation.index ?? list.length, list.length), 0, value)
        break
      }
      case 'remove': {
        const { container, last } = parentOf(document, operation.path, false)
        if (Array.isArray(container)) {
          const index = indexIn(container, last)
          if (index < 0) fail(`Nothing at ${operation.path}`)
          container.splice(index, 1)
        } else {
          if (!(last in container)) fail(`Nothing at ${operation.path}`)
          delete container[last]
        }
        break
      }
      case 'move': {
        const { container, last } = parentOf(document, operation.path, false)
        if (!Array.isArray(container)) fail(`${operation.path} is not a list entry`)
        const index = indexIn(container, last)
        if (index < 0) fail(`Nothing at ${operation.path}`)
        const [entry] = container.splice(index, 1)
        container.splice(Math.min(operation.index, container.length), 0, entry)
        break
      }
    }
    changed.push(`${operation.op} ${operation.path}`)
  }
  return { document, changed }
}

/** The empty document for list-shaped collections; a home page has no sensible empty form. */
export function emptySiteContentDocument(collection: SiteContentCollection): Record<string, Json> | null {
  switch (collection) {
    case 'people': return { schemaVersion: 1, groups: [] }
    case 'partners': return { schemaVersion: 1, partners: [] }
    case 'news': return { schemaVersion: 1, items: [] }
    case 'settings': return { schemaVersion: 1, sites: {} }
    case 'event-pages': return { schemaVersion: 1, pages: [] }
    default: return null
  }
}

// ── event pages ────────────────────────────────────────────────────────────
const sectionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
// No nullable or defaulted fields: some providers' tool schemas would show them to the model as text.
export const EventPageEditSchema = z.object({
  eventSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/, 'Use the event reference (slug)'),
  expectedVersion: z.number().int().nonnegative(),
  cover: SiteImageSchema.optional(),
  summary: LocalizedTextSchema.optional(),
  clear: z.array(z.enum(['cover', 'summary'])).max(2).optional().describe('Remove the cover and/or summary.'),
  sections: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('add'), section: EventSectionSchema, after: z.string().max(40).optional().describe('Section id to add after; "start" puts it first; omit to add at the end.') }).strict(),
    z.object({ op: z.literal('replace'), section: EventSectionSchema }).strict(),
    z.object({ op: z.literal('remove'), id: sectionId }).strict(),
    z.object({ op: z.literal('move'), id: sectionId, index: z.number().int().min(0) }).strict(),
    z.object({ op: z.literal('hide'), id: sectionId, hidden: z.boolean() }).strict(),
  ])).max(40).optional(),
}).strict()
export type EventPageEdit = z.infer<typeof EventPageEditSchema>

/** Translate an event page edit into collection operations, creating the page when it has none yet. */
export function eventPageOperations(draft: Json, edit: EventPageEdit): SiteContentOperation[] {
  const page = `pages/${edit.eventSlug}`
  const operations: SiteContentOperation[] = []
  if (siteContentValueAt(draft ?? emptySiteContentDocument('event-pages'), page) === undefined) {
    operations.push({ op: 'insert', path: 'pages', value: { event: edit.eventSlug, sections: [] } })
  }
  for (const field of edit.clear ?? []) if (siteContentValueAt(draft, `${page}/${field}`) !== undefined) operations.push({ op: 'remove', path: `${page}/${field}` })
  if (edit.cover) operations.push({ op: 'set', path: `${page}/cover`, value: edit.cover })
  if (edit.summary) operations.push({ op: 'set', path: `${page}/summary`, value: edit.summary })
  // Section positions as the operations will see them, so `after` resolves against earlier changes in the same edit.
  const order: string[] = ((siteContentValueAt(draft, `${page}/sections`) as Array<{ id: string }> | undefined) ?? []).map(section => section.id)
  const drop = (id: string) => { const index = order.indexOf(id); if (index >= 0) order.splice(index, 1) }
  for (const change of edit.sections ?? []) {
    switch (change.op) {
      case 'add': {
        const index = change.after === 'start' ? 0 : change.after ? order.indexOf(change.after) + 1 : order.length
        if (change.after && change.after !== 'start' && index === 0) fail(`No section ${change.after} on ${edit.eventSlug}`)
        operations.push({ op: 'insert', path: `${page}/sections`, value: change.section, index })
        order.splice(index, 0, change.section.id)
        break
      }
      case 'replace': operations.push({ op: 'set', path: `${page}/sections/${change.section.id}`, value: change.section }); break
      case 'remove': operations.push({ op: 'remove', path: `${page}/sections/${change.id}` }); drop(change.id); break
      case 'move': operations.push({ op: 'move', path: `${page}/sections/${change.id}`, index: change.index }); drop(change.id); order.splice(change.index, 0, change.id); break
      case 'hide': operations.push({ op: 'set', path: `${page}/sections/${change.id}/hidden`, value: change.hidden }); break
    }
  }
  if (!operations.length) fail('Nothing to change')
  return operations
}

/** Every website media id a document refers to (images and news files). */
export function siteContentMediaIds(document: Json): string[] {
  const ids = new Set<string>()
  const visit = (value: Json) => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!isObject(value)) return
    for (const [key, entry] of Object.entries(value)) {
      if ((key === 'mediaId' || key === 'fileId') && typeof entry === 'string') ids.add(entry)
      else visit(entry)
    }
  }
  visit(document)
  return [...ids]
}

const stable = (value: Json): string => JSON.stringify(value, (_key, entry) => isObject(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)
const label = (entry: Json, index: number) => identity(entry) ?? `#${index + 1}`

/**
 * What publishing would change, entry by entry, for the confirmation a person sees:
 * `added|removed|changed <list>/<reference>` or `changed <field>`. Order-only moves report as `reordered <list>`.
 */
export function siteContentChanges(published: Json, draft: Json, limit = 20): string[] {
  const lines: string[] = []
  const before = isObject(published) ? published : {}, after = isObject(draft) ? draft : {}
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])]) {
    const a = before[key], b = after[key]
    if (stable(a) === stable(b)) continue
    if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(entry => identity(entry) !== undefined)) {
      const old = new Map(a.map(entry => [identity(entry)!, entry])), next = new Map(b.map(entry => [identity(entry)!, entry]))
      for (const [id, entry] of next) if (!old.has(id)) lines.push(`added ${key}/${id}`); else if (stable(old.get(id)) !== stable(entry)) lines.push(`changed ${key}/${id}`)
      for (const id of old.keys()) if (!next.has(id)) lines.push(`removed ${key}/${id}`)
      const common = (list: Json[]) => list.map(entry => identity(entry)!).filter(id => old.has(id) && next.has(id)).join('/')
      if (common(a) !== common(b)) lines.push(`reordered ${key}`)
    } else if (isObject(a) && isObject(b)) {
      for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])]) if (stable(a[field]) !== stable(b[field])) lines.push(`changed ${key}/${field}`)
    } else lines.push(a === undefined ? `added ${key}` : b === undefined ? `removed ${key}` : `changed ${key}`)
  }
  return lines.length > limit ? [...lines.slice(0, limit), `…and ${lines.length - limit} more`] : lines
}

/** A compact map of a large document: each list becomes its entry references, so a reader can ask for one path. */
export function siteContentOutline(document: Json): Json {
  if (!isObject(document)) return document
  return Object.fromEntries(Object.entries(document).map(([key, value]) => [key,
    Array.isArray(value) ? value.map((entry, index) => {
      const sections = isObject(entry) && Array.isArray(entry.sections) ? { sections: entry.sections.map((section, i) => `${label(section, i)}${isObject(section) && typeof section.kind === 'string' ? ` (${section.kind})` : ''}`) } : {}
      return { ref: label(entry, index), ...sections }
    })
      : isObject(value) ? Object.keys(value) : value]))
}
