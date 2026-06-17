/**
 * Last-edited-by property — auto-stamped row metadata pointing at the
 * workspace member who most recently edited the row. Server bindings
 * pre-resolve `entity_instances.last_edited_by` → a `PersonWidget`
 * (matching the `person` property's wire shape).
 *
 * Behaviour is identical to `created-by.tsx` — same Cell render, same
 * read-only Editor, same alphabetical sortFn. Kept as a distinct
 * module so the registry has a 1:1 mapping between `PropertyKind` and
 * source file.
 *
 * [COMP:views/property-last-edited-by]
 */

import type { JSX } from 'react'
import type { A2UIRowValue, PersonWidget } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

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
 * Read-only Editor — auto-metadata is stamped by the server on every
 * write; the user never picks a value. Returns the same JSX as Cell.
 */
function Editor(props: PropertyEditorProps): JSX.Element {
  return <Cell value={props.value} />
}

function Icon(props: { className?: string }): JSX.Element {
  // Lucide UserPen — head + shoulders with a small pencil glyph to
  // distinguish "last edited by" from "created by" (which carries `+`).
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M2 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" strokeLinecap="round" />
      <path d="M11 3l2 2-3 3-2 .5.5-2 3-3z" strokeLinejoin="round" />
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

export const LastEditedByProperty: PropertyModule = {
  kind: 'last_edited_by',
  Cell,
  Editor,
  Icon,
  sortFn,
}

export const __test = { asPerson }
