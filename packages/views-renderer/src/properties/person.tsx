/**
 * Person property — workspace member reference. Server bindings emit a
 * PersonWidget pre-resolved to `{ id, name, avatarUrl?, initials? }` so
 * the renderer never holds a directory. Renders as an avatar pill.
 *
 * Phase-2 editor: native `<select>` over `hints.members`. The host
 * passes in the pre-fetched workspace member list; without hints the
 * editor renders a no-op (falls back to read-only).
 *
 * TODO: replace with a typeahead popover (`/api/workspaces/:wid/members?q=`).
 *
 * [COMP:views/property-person]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
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

function Editor(props: PropertyEditorProps): JSX.Element | null {
  // Bail before any hooks so the "not editable" branch returns null
  // without violating Rules of Hooks. The host treats null as
  // "not yet editable" and falls back to the read-only Cell.
  const members = props.hints?.members ?? []
  if (members.length === 0) return null
  return <PersonEditor {...props} members={members} />
}

function PersonEditor(
  props: PropertyEditorProps & { members: readonly import('../types.js').PersonWidget[] },
): JSX.Element {
  const initial = asPerson(props.value)
  const { members } = props
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
    const match = members.find((m) => m.id === id)
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
      {members.map((m) => (
        <option key={m.id} value={m.id}>{m.name}</option>
      ))}
    </select>
  )
}

function Icon(props: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.5c0-2.5 2.5-4 5-4s5 1.5 5 4" strokeLinecap="round" />
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

export const PersonProperty: PropertyModule = {
  kind: 'person',
  Cell,
  Editor,
  Icon,
  sortFn,
}
