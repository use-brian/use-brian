/**
 * Select property — single-value enum, renders as a Badge. Server
 * bindings emit a BadgeWidget cell value (the existing pattern for task
 * status and deal stage). Empty cells render as em-dash.
 *
 * Phase-2 editor: native `<select>` over `hints.options`. When the host
 * does not supply options, falls back to a free-text `<input>` — the
 * commit shape is still a plain string so the server can coerce.
 *
 * [COMP:views/property-select]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Badge } from '../widgets/Badge.js'
import { Empty } from './empty.js'

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const v = props.value
  if (v === null || v === undefined) return <Empty />
  if (typeof v === 'string') {
    if (v.length === 0) return <Empty />
    return <Badge text={v} />
  }
  if (typeof v === 'object' && v.type === 'badge') {
    return <Badge text={v.text} tone={v.tone} />
  }
  return <span className="text-xs text-muted-foreground">[{typeof v === 'object' ? v.type : typeof v}]</span>
}

function asString(v: A2UIRowValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object' && v.type === 'badge') return v.text
  return ''
}

function Editor(props: PropertyEditorProps): JSX.Element {
  const initial = asString(props.value)
  const [draft, setDraft] = useState(initial)
  const options = props.hints?.options ?? null
  const selectRef = useRef<HTMLSelectElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (options) {
      selectRef.current?.focus()
    } else {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [options])

  function commit(value: string): void {
    const next = value.trim()
    if (next === initial.trim()) {
      props.onCancel()
      return
    }
    props.onCommit(next.length === 0 ? null : next)
  }

  if (options) {
    return (
      <select
        ref={selectRef}
        className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/40"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          // Commit immediately on selection — matches Notion select behavior.
          commit(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            props.onCancel()
          }
        }}
        onBlur={() => {
          // Only cancel-on-blur when the value didn't change — otherwise
          // the onChange branch above already committed.
          if (draft === initial) props.onCancel()
        }}
      >
        {/* Allow clearing — empty option submits null. */}
        <option value="">—</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    )
  }

  return (
    <input
      ref={inputRef}
      type="text"
      className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/40"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit(draft)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          props.onCancel()
        }
      }}
      onBlur={() => commit(draft)}
    />
  )
}

function Icon(props: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <path d="M2.5 6.5l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function sortKey(v: A2UIRowValue): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (v.type === 'badge') return v.text
  return null
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const ak = sortKey(a)
  const bk = sortKey(b)
  if (ak === bk) return 0
  if (ak === null) return 1
  if (bk === null) return -1
  return ak.localeCompare(bk)
}

export const SelectProperty: PropertyModule = {
  kind: 'select',
  Cell,
  Editor,
  Icon,
  sortFn,
}
