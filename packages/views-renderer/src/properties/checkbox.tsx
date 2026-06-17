/**
 * Checkbox property — boolean cell. Server bindings emit either a bare
 * `boolean`, a `'true'`/`'false'` string, or `null` (empty). Empty cells
 * render the unchecked box (not an em-dash — checkbox cells always show
 * a state, matching Notion's checkbox column behavior).
 *
 * Cell: a disabled `<input type="checkbox">` so the Cell is decorative
 * — the Editor is the interactive surface (Phase 2 cell-update flow).
 *
 * Phase-2 editor: an enabled `<input type="checkbox">` that commits on
 * change. Unlike text/number, there's no "draft + Enter" — clicking the
 * box IS the commit.
 *
 * sortFn: false < true, nulls last.
 *
 * [COMP:views/property-checkbox]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'

/**
 * Coerce an A2UIRowValue to a tri-state: `true`, `false`, or `null` when
 * the cell has no decided value. Strings `'true'`/`'false'` are honored
 * so server bindings that round-trip JSONB don't need a typed widget.
 */
function asBool(v: A2UIRowValue): boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    if (v === 'true') return true
    if (v === 'false') return false
    return null
  }
  return null
}

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const b = asBool(props.value)
  // Empty checkbox = unchecked. Notion treats null as "not yet ticked"
  // visually, not as a separate empty state.
  const checked = b === true
  return (
    <input
      type="checkbox"
      disabled
      checked={checked}
      readOnly
      className="h-3.5 w-3.5 cursor-default rounded-sm border border-border bg-background accent-primary disabled:opacity-100"
    />
  )
}

function Editor(props: PropertyEditorProps): JSX.Element {
  const initial = asBool(props.value) ?? false
  const [draft, setDraft] = useState<boolean>(initial)
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  function commit(next: boolean): void {
    if (next === initial) {
      props.onCancel()
      return
    }
    // A2UIRowValue is `string | number | null | A2UIWidget` — booleans
    // ride as `'true'` / `'false'` strings (the same shape `asBool`
    // reads back on render). Server bindings coerce to a JSONB boolean.
    props.onCommit(next ? 'true' : 'false')
  }

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={draft}
      onChange={(e) => {
        const next = e.target.checked
        setDraft(next)
        commit(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          props.onCancel()
        }
      }}
      className="h-3.5 w-3.5 cursor-pointer rounded-sm border border-border bg-background accent-primary"
    />
  )
}

function Icon(props: { className?: string }): JSX.Element {
  // Lucide CheckSquare-style square with check mark, hand-rolled to keep
  // the renderer free of an external icon-library dep.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5.5 8.5l2 2 3-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const ab = asBool(a)
  const bb = asBool(b)
  if (ab === bb) return 0
  if (ab === null) return 1
  if (bb === null) return -1
  // false < true.
  return ab === false ? -1 : 1
}

export const CheckboxProperty: PropertyModule = {
  kind: 'checkbox',
  Cell,
  Editor,
  Icon,
  sortFn,
}
