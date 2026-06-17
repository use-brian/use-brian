/**
 * Text property — the default kind for a column with no explicit
 * `kind`. Accepts a primitive `string`/`number` cell value (numbers are
 * coerced via String). Empty cells render as an em-dash.
 *
 * Phase-2 editor: an auto-growing multi-line `<textarea>` seeded from the
 * current value. It wraps and grows to show the *whole* title while
 * editing — the Notion database-cell feel — instead of cramming a long
 * title onto one scrolling line. Enter commits the trimmed string (titles
 * are single-value, so Enter never inserts a newline); Escape cancels;
 * blur also commits — Notion-style "click outside to save."
 *
 * [COMP:views/property-text]
 */

import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const v = props.value
  if (v === null || v === undefined) return <Empty />
  if (typeof v === 'string') {
    if (v.length === 0) return <Empty />
    return <span className="text-sm">{v}</span>
  }
  if (typeof v === 'number') {
    return <span className="text-sm">{String(v)}</span>
  }
  // Unexpected widget in a text cell — render its `type` for debug.
  return <span className="text-xs text-muted-foreground">[{v.type}]</span>
}

function asString(v: A2UIRowValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return ''
}

function Editor(props: PropertyEditorProps): JSX.Element {
  const initial = asString(props.value)
  const [draft, setDraft] = useState(initial)
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  // Auto-grow to fit the wrapped content so the whole title shows while
  // editing (Notion cell feel). Reset to 0 first so `scrollHeight` reports
  // the true content height free of the previous measurement, then snap to it.
  // Mirrors `apps/app-web/src/lib/use-auto-grow-textarea.ts`, inlined here
  // because this renderer package can't depend on the app.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  function commit(): void {
    const next = draft.trim()
    if (next === initial.trim()) {
      props.onCancel()
      return
    }
    props.onCommit(next.length === 0 ? null : next)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Titles are single-value: Enter commits rather than inserting a newline.
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      props.onCancel()
    }
  }

  return (
    <textarea
      ref={ref}
      rows={1}
      className="block w-full resize-none overflow-hidden rounded-sm border border-border bg-background px-2 py-1 text-sm leading-snug outline-none focus:border-primary focus:ring-1 focus:ring-primary/40"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={commit}
    />
  )
}

function Icon(props: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <path d="M3 4h10M5.5 4v8M10.5 4v8M3.5 12h4M8.5 12h4" strokeLinecap="round" />
    </svg>
  )
}

function sortKey(v: A2UIRowValue): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (v.type === 'text' || v.type === 'heading' || v.type === 'badge' || v.type === 'button') {
    return v.text
  }
  return v.type
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const ak = sortKey(a)
  const bk = sortKey(b)
  if (ak === bk) return 0
  if (ak === null) return 1
  if (bk === null) return -1
  return ak.localeCompare(bk)
}

export const TextProperty: PropertyModule = {
  kind: 'text',
  Cell,
  Editor,
  Icon,
  sortFn,
}
