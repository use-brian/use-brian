/**
 * Created-time property — auto-stamped row metadata surfaced as a
 * column. Server bindings emit either a bare ISO string, a wrapped
 * `DateWidget` carrying the ISO, or `null` for rows that haven't been
 * stamped yet (rare — `entity_instances.created_at` is NOT NULL).
 *
 * Cell: relative format by default ("2h ago", "yesterday", "3 days
 * ago"), with the absolute timestamp surfaced through `title=` for the
 * hover tooltip. The host can pin absolute via the `format` field on a
 * wrapped DateWidget (`absolute` | `datetime`).
 *
 * Editor: **read-only.** Auto-metadata is never user-editable; the
 * Editor returns the same JSX as the Cell so the table's edit affordance
 * is a no-op visual click instead of a focusable input. This keeps the
 * dispatch surface uniform with the rest of the property registry.
 *
 * Time helpers: `Intl.RelativeTimeFormat` for the relative label, with
 * `Intl.DateTimeFormat` underneath for the absolute fallback + tooltip.
 *
 * [COMP:views/property-created-time]
 */

import type { JSX } from 'react'
import type { A2UIRowValue, DateWidget } from '../types.js'
import type { PropertyEditorProps, PropertyModule } from './types.js'
import { Empty } from './empty.js'

/**
 * Coerce a cell value into an ISO + optional display-format pin. Accepts
 * a bare string (the common server shape for `created_at`) or a wrapped
 * DateWidget (server bindings may upgrade to the widget shape to carry
 * a `format` hint). Anything else collapses to `null`.
 */
function asTime(v: A2UIRowValue): { iso: string; format?: DateWidget['format'] } | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.length > 0) return { iso: v }
  if (typeof v === 'object' && v.type === 'date' && v.iso) {
    return { iso: v.iso, format: v.format }
  }
  return null
}

const MINUTE_SEC = 60
const HOUR_SEC = 60 * MINUTE_SEC
const DAY_SEC = 24 * HOUR_SEC
const WEEK_SEC = 7 * DAY_SEC
const MONTH_SEC = 30 * DAY_SEC
const YEAR_SEC = 365 * DAY_SEC

/**
 * Format an ISO timestamp as a relative phrase ("2h ago", "yesterday",
 * "3 days ago"). Uses `Intl.RelativeTimeFormat` so the wording follows
 * the user's locale; the unit cascade matches Notion/Linear's display
 * (seconds → minutes → hours → days → weeks → months → years).
 */
function formatRelative(iso: string, now: Date): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const diffSec = Math.round((t - now.getTime()) / 1000)
  const abs = Math.abs(diffSec)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < MINUTE_SEC) return rtf.format(diffSec, 'second')
  if (abs < HOUR_SEC) return rtf.format(Math.round(diffSec / MINUTE_SEC), 'minute')
  if (abs < DAY_SEC) return rtf.format(Math.round(diffSec / HOUR_SEC), 'hour')
  if (abs < WEEK_SEC) return rtf.format(Math.round(diffSec / DAY_SEC), 'day')
  if (abs < MONTH_SEC) return rtf.format(Math.round(diffSec / WEEK_SEC), 'week')
  if (abs < YEAR_SEC) return rtf.format(Math.round(diffSec / MONTH_SEC), 'month')
  return rtf.format(Math.round(diffSec / YEAR_SEC), 'year')
}

/**
 * Absolute date with month + day + year. Used both for the
 * `format: 'absolute'` display and for the hover tooltip on relative
 * cells (so the user can disambiguate "3 days ago" without thinking).
 */
function formatAbsolute(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  }).format(new Date(t))
}

/**
 * Absolute date + time, used for `format: 'datetime'` cells where the
 * extra precision matters (audit-style displays).
 */
function formatDatetime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(t))
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
 * Read-only Editor — returns the same JSX as the Cell. Auto-metadata is
 * stamped by the server on insert; the user never picks a value. The
 * dispatch surface keeps an `Editor` slot so the table's edit affordance
 * still routes here, but the rendered surface is non-interactive.
 */
function Editor(props: PropertyEditorProps): JSX.Element {
  return <Cell value={props.value} />
}

function Icon(props: { className?: string }): JSX.Element {
  // Lucide Clock — hand-rolled inline so the renderer keeps zero icon-lib deps.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
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

export const CreatedTimeProperty: PropertyModule = {
  kind: 'created_time',
  Cell,
  Editor,
  Icon,
  sortFn,
}

// Re-export pure helpers for unit tests.
export const __test = { asTime, formatRelative, formatAbsolute, formatDatetime }
