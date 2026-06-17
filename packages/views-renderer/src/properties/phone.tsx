/**
 * Phone property — clickable tel: cell. Server bindings emit a bare
 * `string` (the phone number) or `null`. Empty cells render an em-dash.
 *
 * Cell: an `<a href="tel:value">` with a small phone glyph + the raw
 * number. Phone numbers are intentionally stored as the user typed them
 * (no E.164 normalisation) — different jurisdictions format phone
 * numbers very differently and round-tripping through a normaliser
 * destroys local readability.
 *
 * Phase-2 editor: `<input type="tel">` with onBlur / Enter commit.
 *
 * Validation: must contain at least 5 characters drawn from the
 * dialable set (digits, `+`, `-`, `(`, `)`, space, `.`). Looser than
 * E.164 on purpose. Empty input commits `null` to clear.
 *
 * [COMP:views/property-phone]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

/**
 * Accept-list: at least 5 characters from the dial-pad set. We avoid an
 * E.164 strict check (`^\+\d{8,15}$`) because (a) sales-rep phone lists
 * have a mix of formats, (b) the cell renders a `tel:` link — the OS
 * dialer parses the rest. We DO require length-5 minimum to reject
 * accidental key presses landing in the cell.
 */
const PHONE_RE = /^[\d+\-() .]{5,}$/

function isValidPhone(s: string): boolean {
  return PHONE_RE.test(s)
}

function asPhone(v: A2UIRowValue): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    if (v.length === 0) return null
    return v
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

/**
 * `tel:` URIs accept the raw user-entered string but reject characters
 * outside the dial-pad set. Strip everything but digits, `+`, `-`, `(`,
 * `)` so `<a href>` doesn't carry stray characters into the OS dialer.
 */
function telHref(s: string): string {
  return `tel:${s.replace(/[^\d+\-()]/g, '')}`
}

function PhoneGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className="h-3 w-3 shrink-0 text-muted-foreground">
      <path
        d="M3.5 3.5l2.5-1 1.5 3-1.5 1.5a8 8 0 0 0 3 3l1.5-1.5 3 1.5-1 2.5a2 2 0 0 1-2 1.3A11 11 0 0 1 2.2 5.5a2 2 0 0 1 1.3-2z"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const phone = asPhone(props.value)
  if (!phone) return <Empty />
  return (
    <a
      href={telHref(phone)}
      className="inline-flex max-w-full items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline"
    >
      <PhoneGlyph />
      <span className="truncate tabular-nums">{phone}</span>
    </a>
  )
}

function Editor(props: PropertyEditorProps): JSX.Element {
  const initial = asPhone(props.value) ?? ''
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
    if (!isValidPhone(next)) {
      props.onCancel()
      return
    }
    props.onCommit(next)
  }

  return (
    <input
      ref={ref}
      type="tel"
      inputMode="tel"
      autoComplete="tel"
      className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm tabular-nums outline-none focus:border-primary focus:ring-1 focus:ring-primary/40"
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
  // Lucide Phone-style handset, hand-rolled inline SVG.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <path
        d="M3.5 3.5l2.5-1 1.5 3-1.5 1.5a8 8 0 0 0 3 3l1.5-1.5 3 1.5-1 2.5a2 2 0 0 1-2 1.3A11 11 0 0 1 2.2 5.5a2 2 0 0 1 1.3-2z"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function sortKey(v: A2UIRowValue): string | null {
  const p = asPhone(v)
  if (!p) return null
  // Compare on the dialable substring so "+1 (555)…" and "1-555-…"
  // collate together.
  return p.replace(/[^\d+]/g, '')
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const ak = sortKey(a)
  const bk = sortKey(b)
  if (ak === bk) return 0
  if (ak === null) return 1
  if (bk === null) return -1
  return ak.localeCompare(bk)
}

export const PhoneProperty: PropertyModule = {
  kind: 'phone',
  Cell,
  Editor,
  Icon,
  sortFn,
}

// Re-export pure helpers for unit tests.
export const __test = { isValidPhone, telHref }
