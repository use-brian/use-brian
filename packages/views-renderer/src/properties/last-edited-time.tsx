/**
 * Last-edited-time property — auto-stamped row metadata surfaced as a
 * column. Server bindings emit either a bare ISO string, a wrapped
 * `DateWidget`, or `null` for rows that have never been edited
 * (`entity_instances.last_edited_at` is NOT NULL — defaults to
 * `created_at` on insert).
 *
 * Behaviour is identical to `created-time.tsx` — same Intl helpers,
 * same relative-default-with-absolute-hover treatment, same read-only
 * Editor. The two modules are intentionally separate (rather than one
 * parametrised module) so the property registry keeps a 1:1 mapping
 * between `PropertyKind` and module file — easier for grep, easier for
 * the component map.
 *
 * [COMP:views/property-last-edited-time]
 */

import type { JSX } from 'react'
import type { A2UIRowValue, DateWidget } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'
import { __test as createdTimeHelpers } from './created-time.js'

const { formatRelative, formatAbsolute, formatDatetime } = createdTimeHelpers

function asTime(v: A2UIRowValue): { iso: string; format?: DateWidget['format'] } | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.length > 0) return { iso: v }
  if (typeof v === 'object' && v.type === 'date' && v.iso) {
    return { iso: v.iso, format: v.format }
  }
  return null
}

function display(iso: string, format: DateWidget['format']): string {
  if (format === 'absolute') return formatAbsolute(iso)
  if (format === 'datetime') return formatDatetime(iso)
  return formatRelative(iso, new Date())
}

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const t = asTime(props.value)
  if (!t) return <Empty />
  return (
    <span className="text-sm tabular-nums text-muted-foreground" title={formatDatetime(t.iso)}>
      {display(t.iso, t.format)}
    </span>
  )
}

/**
 * Read-only Editor — auto-metadata is never user-editable. Returns the
 * same JSX as the Cell so the table's edit affordance is a no-op.
 */
function Editor(props: PropertyEditorProps): JSX.Element {
  return <Cell value={props.value} />
}

function Icon(props: { className?: string }): JSX.Element {
  // Lucide ClockEdit-style — clock face with a small pencil notch to
  // distinguish "last edited" from the plain "created" clock.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <path d="M13.5 8a5.5 5.5 0 1 1-3-4.9" />
      <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 3.5l1.5 1.5-3 3-1.5-1.5 3-3z" strokeLinejoin="round" />
    </svg>
  )
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const at = asTime(a)
  const bt = asTime(b)
  const an = at ? Date.parse(at.iso) : null
  const bn = bt ? Date.parse(bt.iso) : null
  if (an === bn) return 0
  if (an === null || Number.isNaN(an)) return 1
  if (bn === null || Number.isNaN(bn)) return -1
  return an < bn ? -1 : 1
}

export const LastEditedTimeProperty: PropertyModule = {
  kind: 'last_edited_time',
  Cell,
  Editor,
  Icon,
  sortFn,
}

export const __test = { asTime }
