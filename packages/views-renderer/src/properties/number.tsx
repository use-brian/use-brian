/**
 * Number property — typed widget carrying nullable value + display format.
 *
 *   * 'plain'    → "1,234.5"        (locale grouping)
 *   * 'currency' → "$1,234.50"      (Intl.NumberFormat, USD if unset)
 *   * 'percent'  → "12.5%"          (value treated as fraction)
 *   * 'integer'  → "1,235"          (rounded)
 *
 * Cells render right-aligned with tabular numerals so columns of
 * numbers line up. Empty cells render an em-dash.
 *
 * Phase-2 editor: `<input type="number" inputMode="numeric">` seeded
 * from the raw numeric value (NOT the formatted display). Enter commits
 * the parsed number; Escape cancels. Empty input commits `null` so the
 * server can clear the cell.
 *
 * [COMP:views/property-number]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue, NumberWidget } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

function asNumber(v: A2UIRowValue): NumberWidget | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && v.type === 'number') return v
  if (typeof v === 'number' && Number.isFinite(v)) {
    return { type: 'number', value: v }
  }
  return null
}

function format(n: NumberWidget): string {
  if (n.value === null) return ''
  const fmt = n.format ?? 'plain'
  if (fmt === 'currency') {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: n.currency ?? 'USD',
    }).format(n.value)
  }
  if (fmt === 'percent') {
    return new Intl.NumberFormat(undefined, {
      style: 'percent',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n.value)
  }
  if (fmt === 'integer') {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n.value)
  }
  return new Intl.NumberFormat().format(n.value)
}

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const n = asNumber(props.value)
  if (!n || n.value === null) return <Empty />
  return <span className="text-sm tabular-nums">{format(n)}</span>
}

function Editor(props: PropertyEditorProps): JSX.Element {
  const initial = asNumber(props.value)
  const initialValue = initial?.value ?? null
  const [draft, setDraft] = useState<string>(initialValue === null ? '' : String(initialValue))
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  function commit(): void {
    const trimmed = draft.trim()
    if (trimmed.length === 0) {
      if (initialValue === null) {
        props.onCancel()
        return
      }
      props.onCommit(null)
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      // Invalid → cancel (no-op) rather than commit a NaN.
      props.onCancel()
      return
    }
    if (parsed === initialValue) {
      props.onCancel()
      return
    }
    props.onCommit(parsed)
  }

  return (
    <input
      ref={ref}
      type="number"
      inputMode="numeric"
      step="any"
      className="w-full rounded-sm border border-border bg-background px-2 py-1 text-right text-sm tabular-nums outline-none focus:border-primary focus:ring-1 focus:ring-primary/40"
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
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <path d="M5 2.5l-1 11M11 2.5l-1 11M2.5 6h11M2 10h11" strokeLinecap="round" />
    </svg>
  )
}

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const an = asNumber(a)?.value ?? null
  const bn = asNumber(b)?.value ?? null
  if (an === bn) return 0
  if (an === null) return 1
  if (bn === null) return -1
  return an < bn ? -1 : 1
}

export const NumberProperty: PropertyModule = {
  kind: 'number',
  Cell,
  Editor,
  Icon,
  sortFn,
}
