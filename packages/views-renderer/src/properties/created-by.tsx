/**
 * Created-by property — auto-stamped row metadata pointing at the
 * workspace member who inserted the row. Server bindings pre-resolve
 * `entity_instances.created_by` → a `PersonWidget` (matching the
 * `person` property's wire shape) so the renderer never holds a
 * directory. Empty cells render an em-dash — rare for this kind but
 * defensible (e.g. system-seeded rows where `created_by IS NULL`).
 *
 * Cell: workspace-member pill — avatar + name. Same render shape as
 * the `person` property; this module is the auto-metadata mirror.
 *
 * Editor: **read-only.** Auto-metadata is never user-editable; the
 * Editor returns the same JSX as the Cell.
 *
 * sortFn: alphabetical by name (server-resolved label is the sort key
 * — there's no member-directory lookup happening at sort time).
 *
 * [COMP:views/property-created-by]
 */

import type { JSX } from 'react'
import type { A2UIRowValue, PersonWidget } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

/**
 * Coerce a cell value into a PersonWidget. Server bindings emit the
 * resolved widget directly. Bare strings (e.g. a raw `users.id`) would
 * surface as the "Unknown user" fallback — we never resolve at render
 * time. See `bindings.ts` and `workspace/directory-batch` for the
 * server-side resolver path.
 */
function asPerson(v: A2UIRowValue): PersonWidget | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && v.type === 'person') return v
  return null
}

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const p = asPerson(props.value)
  if (!p) return <Empty />
  return (
    <span className="inline-flex items-center gap-1.5">
      {p.avatarUrl
        ? <img src={p.avatarUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
        : <span
            aria-hidden
            className="h-5 w-5 rounded-full bg-muted text-[10px] font-medium text-foreground/70 inline-flex items-center justify-center"
          >
            {p.initials ?? p.name.slice(0, 1).toUpperCase()}
          </span>}
      <span className="text-sm">{p.name}</span>
    </span>
  )
}

/**
 * Read-only Editor — returns the same JSX as the Cell. Auto-metadata
 * is stamped by the server on insert; the user never picks a value.
 */
function Editor(props: PropertyEditorProps): JSX.Element {
  return <Cell value={props.value} />
}

function Icon(props: { className?: string }): JSX.Element {
  // Lucide UserPlus — head + shoulders with a small `+` glyph to
  // distinguish "created by" from the plain `person` property.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M2 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" strokeLinecap="round" />
      <path d="M12.5 4v4M10.5 6h4" strokeLinecap="round" />
    </svg>
  )
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const ap = asPerson(a)
  const bp = asPerson(b)
  if (ap === bp) return 0
  if (!ap) return 1
  if (!bp) return -1
  return ap.name.localeCompare(bp.name)
}

export const CreatedByProperty: PropertyModule = {
  kind: 'created_by',
  Cell,
  Editor,
  Icon,
  sortFn,
}

export const __test = { asPerson }
