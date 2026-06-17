/**
 * Relation property — reference to another brain entity (company,
 * contact, deal, task). Server bindings emit a RelationWidget pre-
 * resolved to `{ entityType, id, label }`. Renders as a pill; clicking
 * fires `onAction('open-entity', { entity, rowId })`.
 *
 * Phase-2 editor: native `<select>` over `hints.relationOptions`. The
 * host pre-fetches candidate relations matching the cell's
 * `entityType`. Without hints, the editor renders `null` (host falls
 * back to read-only).
 *
 * TODO: replace with a typeahead popover hitting per-entity search.
 *
 * [COMP:views/property-relation]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue, OnActionHandler, RelationWidget } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

function asRelation(v: A2UIRowValue): RelationWidget | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && v.type === 'relation') return v
  return null
}

function Cell(props: { value: A2UIRowValue; onAction?: OnActionHandler }): JSX.Element {
  const r = asRelation(props.value)
  if (!r) return <Empty />
  const handleClick = props.onAction
    ? () => props.onAction!('open-entity', { entity: r.entityType, rowId: r.id })
    : undefined
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-xs text-foreground/85 hover:bg-muted disabled:cursor-default"
      onClick={handleClick}
      disabled={!handleClick}
    >
      <RelationGlyph />
      {r.label}
    </button>
  )
}

function RelationGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className="h-2.5 w-2.5 opacity-60">
      <path d="M6 10l4-4M5 6h-1.5a2 2 0 0 0 0 4H5M11 10h1.5a2 2 0 0 0 0-4H11" strokeLinecap="round" />
    </svg>
  )
}

function Editor(props: PropertyEditorProps): JSX.Element | null {
  // Bail before hooks — host treats null as "not editable", falling
  // back to the read-only Cell. Hooks must run unconditionally below.
  const options = props.hints?.relationOptions ?? []
  if (options.length === 0) return null
  return <RelationEditor {...props} options={options} />
}

function RelationEditor(
  props: PropertyEditorProps & { options: readonly RelationWidget[] },
): JSX.Element {
  const initial = asRelation(props.value)
  const { options } = props
  const [draftId, setDraftId] = useState<string>(initial?.id ?? '')
  const ref = useRef<HTMLSelectElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  function commit(id: string): void {
    if (id === (initial?.id ?? '')) {
      props.onCancel()
      return
    }
    if (id === '') {
      props.onCommit(null)
      return
    }
    const match = options.find((opt) => opt.id === id)
    if (!match) {
      props.onCancel()
      return
    }
    props.onCommit(match)
  }

  return (
    <select
      ref={ref}
      className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/40"
      value={draftId}
      onChange={(e) => {
        setDraftId(e.target.value)
        commit(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          props.onCancel()
        }
      }}
      onBlur={() => {
        if (draftId === (initial?.id ?? '')) props.onCancel()
      }}
    >
      <option value="">—</option>
      {options.map((opt) => (
        <option key={opt.id} value={opt.id}>{opt.label}</option>
      ))}
    </select>
  )
}

function Icon(props: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <path d="M6.5 9.5l3-3M5 7H3.5a2.5 2.5 0 0 0 0 5H5M11 9h1.5a2.5 2.5 0 0 0 0-5H11" strokeLinecap="round" />
    </svg>
  )
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const ar = asRelation(a)
  const br = asRelation(b)
  if (ar === br) return 0
  if (!ar) return 1
  if (!br) return -1
  return ar.label.localeCompare(br.label)
}

export const RelationProperty: PropertyModule = {
  kind: 'relation',
  Cell,
  Editor,
  Icon,
  sortFn,
}
