/**
 * Email property — clickable mailto cell. Server bindings emit a bare
 * `string` (the address) or `null`. Empty cells render an em-dash.
 *
 * Cell: an `<a href="mailto:value">` with a small envelope glyph + the
 * raw address. Truncates with ellipsis when narrow.
 *
 * Phase-2 editor: `<input type="email">` with onBlur / Enter commit.
 *
 * Validation: lightweight regex — non-empty `local@domain.tld`. Strict
 * RFC 5322 is intentionally out of scope (the address renders as a
 * mailto link; the user's mail client validates on send). Empty input
 * commits `null` to clear.
 *
 * [COMP:views/property-email]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

/**
 * Pragmatic email regex — matches what an HTML5 `<input type="email">`
 * widget accepts: a local part, an @, a domain part with at least one
 * dot. Avoids full RFC 5322 (would reject legitimate addresses the
 * mail-client tier handles).
 */
function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

function asEmail(v: A2UIRowValue): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    if (v.length === 0) return null
    return v
  }
  return null
}

function EnvelopeGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className="h-3 w-3 shrink-0 text-muted-foreground">
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M2.5 4.5l5.5 4 5.5-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const email = asEmail(props.value)
  if (!email) return <Empty />
  return (
    <a
      href={`mailto:${email}`}
      className="inline-flex max-w-full items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline"
    >
      <EnvelopeGlyph />
      <span className="truncate">{email}</span>
    </a>
  )
}

function Editor(props: PropertyEditorProps): JSX.Element {
  const initial = asEmail(props.value) ?? ''
  const [draft, setDraft] = useState<string>(initial)
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  function commit(): void {
    const next = draft.trim()
    if (next === initial.trim()) {
      props.onCancel()
      return
    }
    if (next.length === 0) {
      props.onCommit(null)
      return
    }
    if (!isValidEmail(next)) {
      // Invalid format — refuse to commit. Cancel preserves the cell
      // and lets the user re-edit.
      props.onCancel()
      return
    }
    props.onCommit(next)
  }

  return (
    <input
      ref={ref}
      type="email"
      inputMode="email"
      autoComplete="email"
      className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/40"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          props.onCancel()
        }
      }}
      onBlur={commit}
    />
  )
}

function Icon(props: { className?: string }): JSX.Element {
  // Lucide Mail-style envelope, hand-rolled inline SVG.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M2.5 4.5l5.5 4 5.5-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function sortKey(v: A2UIRowValue): string | null {
  const e = asEmail(v)
  if (!e) return null
  return e.toLowerCase()
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const ak = sortKey(a)
  const bk = sortKey(b)
  if (ak === bk) return 0
  if (ak === null) return 1
  if (bk === null) return -1
  return ak.localeCompare(bk)
}

export const EmailProperty: PropertyModule = {
  kind: 'email',
  Cell,
  Editor,
  Icon,
  sortFn,
}

// Re-export pure helpers for unit tests.
export const __test = { isValidEmail }
