/**
 * Date property — typed widget carrying nullable ISO + display format.
 *
 *   * format 'relative' → "today", "in 2 days", "3 weeks ago"
 *   * format 'absolute' → "May 26, 2026"
 *   * format 'datetime' → "May 26, 2026, 10:30 AM"
 *
 * Cell renders as plain text (no chip); empty cells render an em-dash.
 *
 * Phase-2 editor: native `<input type="date">` (absolute) or
 * `<input type="datetime-local">` (datetime). The host picks the
 * variant via `hints.dateFormat`; absent hints default to `'absolute'`.
 * Commit returns an ISO string; clearing commits `null`.
 *
 * [COMP:views/property-date]
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue, DateWidget } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

function asDate(v: A2UIRowValue): DateWidget | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && v.type === 'date') return v
  // String fallback — bindings emitted a plain ISO string. Wrap it.
  if (typeof v === 'string' && v.length > 0) {
    return { type: 'date', iso: v }
  }
  return null
}

const DAY_MS = 24 * 60 * 60 * 1000

function formatRelative(iso: string, now: Date): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const target = new Date(t)
  // Compare calendar days, not millisecond deltas.
  const aDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime()
  const bDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const days = Math.round((aDay - bDay) / DAY_MS)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days > 0 && days < 7) return `in ${days} days`
  if (days < 0 && days > -7) return `${-days} days ago`
  if (days >= 7 && days < 30) return `in ${Math.round(days / 7)} weeks`
  if (days <= -7 && days > -30) return `${Math.round(-days / 7)} weeks ago`
  return formatAbsolute(iso)
}

function formatAbsolute(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

function formatDatetime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  })
}

function display(d: DateWidget, now: Date): string {
  if (d.iso === null) return ''
  const fmt = d.format ?? 'relative'
  if (fmt === 'relative') return formatRelative(d.iso, now)
  if (fmt === 'datetime') return formatDatetime(d.iso)
  return formatAbsolute(d.iso)
}

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const d = asDate(props.value)
  if (!d || d.iso === null) return <Empty />
  return <span className="text-sm tabular-nums">{display(d, new Date())}</span>
}

/**
 * Convert an ISO timestamp into the value HTML date inputs accept.
 * `<input type="date">` wants `YYYY-MM-DD`; `<input type="datetime-local">`
 * wants `YYYY-MM-DDTHH:mm`. Empty string when the ISO is unparseable.
 */
function isoToInputValue(iso: string | null, mode: 'absolute' | 'datetime'): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const y = d.getFullYear().toString().padStart(4, '0')
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  if (mode === 'absolute') return `${y}-${m}-${day}`
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${day}T${hh}:${mm}`
}

function inputValueToIso(value: string, mode: 'absolute' | 'datetime'): string | null {
  if (value.length === 0) return null
  const t = Date.parse(mode === 'absolute' ? `${value}T00:00:00` : value)
  if (!Number.isFinite(t)) return null
  return new Date(t).toISOString()
}

function Editor(props: PropertyEditorProps): JSX.Element {
  const initial = asDate(props.value)
  const initialIso = initial?.iso ?? null
  // Editor mode comes from explicit hints, then the widget's own format
  // ('datetime' inputs need second-level precision; 'absolute'/'relative'
  // collapse to a date-only field).
  const mode: 'absolute' | 'datetime' = useMemo(() => {
    const hint = props.hints?.dateFormat
    if (hint) return hint
    return initial?.format === 'datetime' ? 'datetime' : 'absolute'
  }, [props.hints?.dateFormat, initial?.format])

  const [draft, setDraft] = useState<string>(isoToInputValue(initialIso, mode))
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  function commit(value: string): void {
    const nextIso = inputValueToIso(value, mode)
    if (nextIso === initialIso) {
      props.onCancel()
      return
    }
    if (nextIso === null) {
      props.onCommit(null)
      return
    }
    props.onCommit(nextIso)
  }

  return (
    <input
      ref={ref}
      type={mode === 'datetime' ? 'datetime-local' : 'date'}
      className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/40 tabular-nums"
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
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" strokeLinecap="round" />
    </svg>
  )
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const ad = asDate(a)
  const bd = asDate(b)
  const an = ad?.iso ? Date.parse(ad.iso) : null
  const bn = bd?.iso ? Date.parse(bd.iso) : null
  if (an === bn) return 0
  if (an === null || Number.isNaN(an)) return 1
  if (bn === null || Number.isNaN(bn)) return -1
  return an < bn ? -1 : 1
}

export const DateProperty: PropertyModule = {
  kind: 'date',
  Cell,
  Editor,
  Icon,
  sortFn,
}
