/**
 * A2UI Timeline — Gantt-style horizontal bars across a time axis.
 *
 * Each row is one record; the bar spans the row's start date to its
 * end date. The axis at the top is rendered at one of four zoom
 * levels (day / week / month / quarter), each with its own tick density
 * and label format. The first column (row name) is sticky on the left;
 * everything to the right scrolls horizontally.
 *
 * Bar positioning is pure math against `pxPerDay` (a zoom-derived
 * constant) and the visible range's `start` day. `getBarPlacement` is
 * exported so the test suite can verify the px-from-start computation
 * without rendering.
 *
 * Bar colors cycle through `var(--chart-1..5)` keyed by row index —
 * mirrors `ChartBar.toneFill` for theme-token continuity. Clicking
 * a bar fires `onAction(rowAction.id, { rowId })`.
 *
 * [COMP:views/timeline]
 */

import { type JSX, useMemo, useRef, useState } from 'react'
import type {
  A2UIRow,
  A2UIRowValue,
  A2UIColumn,
  ActionRef,
  DateWidget,
  OnActionHandler,
} from '../types.js'

export type TimelineZoom = 'day' | 'week' | 'month' | 'quarter'

export type TimelineProps = {
  rows: A2UIRow[]
  columns: A2UIColumn[]
  startColumnId: string
  endColumnId: string
  rowAction?: ActionRef
  onAction?: OnActionHandler
  emptyMessage?: string
  zoomLevel?: TimelineZoom
  /** Test seam — fixes "today" for deterministic axis math. */
  today?: Date
}

const DAY_MS = 24 * 60 * 60 * 1000
const ROW_LABEL_WIDTH = 200
const ROW_HEIGHT = 36
const HEADER_HEIGHT = 32
/** Movement under this many px counts as a click, not a drag. */
const DRAG_THRESHOLD_PX = 3
const CHART_PALETTE = [
  'var(--chart-1, #6366f1)',
  'var(--chart-2, #10b981)',
  'var(--chart-3, #8b5cf6)',
  'var(--chart-4, #f59e0b)',
  'var(--chart-5, #ef4444)',
] as const

/** Pixels per calendar day at each zoom level. */
export const ZOOM_PX_PER_DAY: Record<TimelineZoom, number> = {
  day: 48,
  week: 16,
  month: 6,
  quarter: 3,
}

/** Optimistic reschedule overlay: `rowId → shifted { start, end }`. */
type RescheduleOverlay = Record<string, { start: string; end: string }>

export function Timeline(props: TimelineProps): JSX.Element {
  const [zoom, setZoom] = useState<TimelineZoom>(props.zoomLevel ?? 'week')
  const today = props.today ?? new Date()
  const range = useMemo(() => defaultRange(today, zoom), [today, zoom])

  // Optimistic-move overlay — mirrors Board/Calendar: a drag shows the
  // bar at its new range immediately; `onAction('reschedule', …)` tells
  // the host to persist; the next payload re-render clears the overlay.
  // Dropped when the incoming row identities change (refetch).
  const [optimistic, setOptimistic] = useState<RescheduleOverlay>({})
  const rowsSignature = useMemo(() => rowIdSignature(props.rows), [props.rows])
  const lastSignature = useRef(rowsSignature)
  if (lastSignature.current !== rowsSignature) {
    lastSignature.current = rowsSignature
    if (Object.keys(optimistic).length > 0) setOptimistic({})
  }

  const handleReschedule = (
    rowId: string,
    next: { start: string; end: string },
  ): void => {
    setOptimistic((prev) => ({ ...prev, [rowId]: next }))
    props.onAction?.('reschedule', { rowId, start: next.start, end: next.end })
  }

  return renderTimeline({
    rows: applyTimelineOptimistic(
      props.rows,
      props.startColumnId,
      props.endColumnId,
      optimistic,
    ),
    columns: props.columns,
    startColumnId: props.startColumnId,
    endColumnId: props.endColumnId,
    rowAction: props.rowAction,
    onAction: props.onAction,
    emptyMessage: props.emptyMessage,
    zoom,
    onZoom: setZoom,
    range,
    onReschedule: handleReschedule,
  })
}

/**
 * Pure render function — accepts already-resolved state (`zoom`,
 * `range`, `onZoom`). Exported for tests so component-level assertions
 * about bar placement, palette, sticky classes, and click handlers can
 * run without a React DOM (no hooks invoked).
 */
export function renderTimeline(input: {
  rows: A2UIRow[]
  columns: A2UIColumn[]
  startColumnId: string
  endColumnId: string
  rowAction?: ActionRef
  onAction?: OnActionHandler
  emptyMessage?: string
  zoom: TimelineZoom
  onZoom: (z: TimelineZoom) => void
  range: { start: Date; end: Date }
  /**
   * Fired when a bar is dragged to a new range. Receives the row id and
   * the duration-preserving shifted `{ start, end }` ISO days. Omitted ⇒
   * bars are click-only (not draggable).
   */
  onReschedule?: (rowId: string, next: { start: string; end: string }) => void
}): JSX.Element {
  const pxPerDay = ZOOM_PX_PER_DAY[input.zoom]
  const totalDays = daysBetween(input.range.start, input.range.end) + 1
  const axisWidth = totalDays * pxPerDay
  const ticks = buildAxisTicks(input.range.start, totalDays, input.zoom)
  const draggable = Boolean(input.onReschedule)

  // Row name column — first column whose field !== start/end works as a
  // label fallback. The wire schema doesn't pin a "label column"; we
  // mirror Table's "first column is the title" convention.
  const labelColumn = input.columns.find(
    (c) => c.field !== input.startColumnId && c.field !== input.endColumnId,
  ) ?? input.columns[0]

  const handleBarClick = (rowId: string): void => {
    if (!input.rowAction || !input.onAction) return
    input.onAction(input.rowAction.id, { ...input.rowAction.params, rowId })
  }

  // Whole-bar horizontal drag → duration-preserving reschedule. Kept
  // hook-free so `renderTimeline` stays a pure function the tests can
  // call directly: gesture state lives in a per-bar closure and the
  // live preview mutates `style.transform` straight on the element
  // (reverted on drop; React re-renders with the committed/optimistic
  // placement). `pxDeltaToDays` + `shiftRange` carry the snap + duration
  // math and are unit-tested in isolation.
  //
  // TODO(doc-v1 §7.2): edge-resize. Dragging a bar's left/right edge
  // should move only `start` or `end` (changing the duration). Deferred
  // — it needs separate left/right grab-zone hit-testing, a min-1-day
  // clamp, and its own resize math, roughly doubling this surface. The
  // whole-bar move below covers the primary reschedule gesture; resize
  // is the follow-up.
  const makeBarDrag = (
    rowId: string,
    startIso: string | null,
    endIso: string | null,
  ): {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void
    onClickCapture: (e: React.MouseEvent<HTMLButtonElement>) => void
  } => {
    let originX = 0
    let dragged = false
    let moveHandler: ((ev: PointerEvent) => void) | null = null
    let upHandler: ((ev: PointerEvent) => void) | null = null

    const cleanup = (el: HTMLButtonElement): void => {
      if (moveHandler) el.removeEventListener('pointermove', moveHandler)
      if (upHandler) el.removeEventListener('pointerup', upHandler)
      moveHandler = null
      upHandler = null
    }

    return {
      onPointerDown: (e) => {
        if (!input.onReschedule) return
        const el = e.currentTarget
        originX = e.clientX
        dragged = false
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // jsdom / non-DOM env — capture unsupported; drag still works.
        }
        moveHandler = (ev: PointerEvent) => {
          const dx = ev.clientX - originX
          if (Math.abs(dx) > DRAG_THRESHOLD_PX) dragged = true
          el.style.transform = `translateX(${dx}px)`
        }
        upHandler = (ev: PointerEvent) => {
          const dx = ev.clientX - originX
          el.style.transform = ''
          cleanup(el)
          if (Math.abs(dx) <= DRAG_THRESHOLD_PX) return
          const dayDelta = pxDeltaToDays(dx, pxPerDay)
          if (dayDelta === 0) return
          const next = shiftRange(startIso, endIso, dayDelta)
          if (next) input.onReschedule?.(rowId, next)
        }
        el.addEventListener('pointermove', moveHandler)
        el.addEventListener('pointerup', upHandler)
      },
      // Swallow the click that follows a real drag so a reschedule
      // doesn't also fire the row-open action.
      onClickCapture: (e) => {
        if (dragged) {
          e.preventDefault()
          e.stopPropagation()
          dragged = false
        }
      },
    }
  }

  if (input.rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        {input.emptyMessage ?? 'No items to plot.'}
      </div>
    )
  }

  return (
    <div className="flex w-full flex-col gap-2" data-a2ui-widget="timeline">
      <ZoomBar zoom={input.zoom} onZoom={input.onZoom} />
      <div className="relative w-full overflow-x-auto rounded-md border border-border">
        <div
          className="flex flex-col"
          style={{ minWidth: ROW_LABEL_WIDTH + axisWidth }}
        >
          {/* Axis */}
          <div className="flex border-b border-border bg-muted/30">
            <div
              className="sticky left-0 z-20 shrink-0 border-r border-border bg-muted/30"
              style={{ width: ROW_LABEL_WIDTH, height: HEADER_HEIGHT }}
              aria-hidden
            />
            <div
              className="relative"
              style={{ width: axisWidth, height: HEADER_HEIGHT }}
              data-a2ui-axis={input.zoom}
            >
              {ticks.map((t) => (
                <div
                  key={t.day}
                  className="absolute top-0 flex h-full items-center border-l border-border/60 px-1 text-[11px] tabular-nums text-muted-foreground"
                  style={{ left: t.day * pxPerDay, minWidth: t.widthDays * pxPerDay }}
                  data-a2ui-tick={t.day}
                >
                  {t.label}
                </div>
              ))}
            </div>
          </div>

          {/* Rows */}
          {input.rows.map((row, idx) => {
            const rowId = stringId(row.id)
            const startIso = isoFromRowValue(row[input.startColumnId])
            const endIso = isoFromRowValue(row[input.endColumnId])
            const placement = getBarPlacement({
              startIso,
              endIso,
              rangeStart: input.range.start,
              rangeEnd: input.range.end,
              pxPerDay,
            })
            const color = CHART_PALETTE[idx % CHART_PALETTE.length]
            const label = labelText(row, labelColumn)
            // Dragging needs a stable row id to map the move back to a
            // record; bars without one stay click-only.
            const barDrag = draggable && rowId
              ? makeBarDrag(rowId, startIso, endIso)
              : null
            const clickable = Boolean(rowId && input.rowAction && input.onAction)
            return (
              <div
                key={rowId ?? `row-${idx}`}
                className="flex border-b border-border last:border-0 hover:bg-muted/20"
                data-a2ui-row={rowId ?? idx}
              >
                <div
                  className="sticky left-0 z-10 shrink-0 border-r border-border bg-background px-3 py-2 text-sm font-medium"
                  style={{ width: ROW_LABEL_WIDTH, height: ROW_HEIGHT }}
                  data-a2ui-row-label
                >
                  <span className="truncate">{label}</span>
                </div>
                <div
                  className="relative"
                  style={{ width: axisWidth, height: ROW_HEIGHT }}
                >
                  {placement.visible ? (
                    <button
                      type="button"
                      onClick={() => rowId && handleBarClick(rowId)}
                      onClickCapture={barDrag?.onClickCapture}
                      onPointerDown={barDrag?.onPointerDown}
                      disabled={!clickable && !barDrag}
                      className={`absolute top-1.5 flex h-6 touch-none items-center overflow-hidden rounded px-2 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:cursor-default ${
                        barDrag ? 'cursor-grab active:cursor-grabbing' : ''
                      }`}
                      style={{
                        left: placement.leftPx,
                        width: placement.widthPx,
                        backgroundColor: color,
                      }}
                      data-a2ui-bar={rowId ?? idx}
                      data-a2ui-bar-draggable={barDrag ? 'true' : undefined}
                      title={label}
                    >
                      <span className="truncate">{label}</span>
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Zoom bar ──────────────────────────────────────────────────────────

function ZoomBar(props: {
  zoom: TimelineZoom
  onZoom: (z: TimelineZoom) => void
}): JSX.Element {
  const opts: TimelineZoom[] = ['day', 'week', 'month', 'quarter']
  return (
    <div className="flex items-center gap-1" data-a2ui-zoom-bar>
      {opts.map((z) => (
        <button
          key={z}
          type="button"
          onClick={() => props.onZoom(z)}
          aria-pressed={props.zoom === z}
          className={[
            'rounded-sm border px-2 py-1 text-xs capitalize transition-colors',
            props.zoom === z
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-background text-muted-foreground hover:bg-muted',
          ].join(' ')}
          data-a2ui-zoom-option={z}
        >
          {z}
        </button>
      ))}
    </div>
  )
}

// ── Math helpers ──────────────────────────────────────────────────────

/**
 * Compute a bar's `{ leftPx, widthPx, visible }` placement on the time
 * axis. Clips against the visible range; returns `visible: false` when
 * the bar would be entirely off-screen. Exported for tests.
 */
export function getBarPlacement(input: {
  startIso: string | null
  endIso: string | null
  rangeStart: Date
  rangeEnd: Date
  pxPerDay: number
}): { leftPx: number; widthPx: number; visible: boolean } {
  if (!input.startIso || !input.endIso) {
    return { leftPx: 0, widthPx: 0, visible: false }
  }
  const startDay = dayDelta(input.rangeStart, input.startIso)
  const endDay = dayDelta(input.rangeStart, input.endIso)
  if (startDay === null || endDay === null) {
    return { leftPx: 0, widthPx: 0, visible: false }
  }
  const rangeDays = daysBetween(input.rangeStart, input.rangeEnd)
  // Reject cleanly off-screen bars.
  if (endDay < 0 || startDay > rangeDays) {
    return { leftPx: 0, widthPx: 0, visible: false }
  }
  // Clip to visible window. Bar covers [startDay, endDay] (inclusive),
  // so its width is `endDay - startDay + 1` calendar days.
  const lo = Math.max(0, startDay)
  const hi = Math.min(rangeDays, endDay)
  const leftPx = lo * input.pxPerDay
  const widthPx = Math.max(input.pxPerDay, (hi - lo + 1) * input.pxPerDay)
  return { leftPx, widthPx, visible: true }
}

/**
 * Convert a horizontal pixel delta to a whole-day delta at the active
 * zoom, snapping to the nearest day. The inverse of the `day * pxPerDay`
 * placement math in `getBarPlacement`. Pure + exported for tests.
 *
 * e.g. at week zoom (16px/day) a 40px drag → round(2.5) → 3 days;
 * a 20px drag → round(1.25) → 1 day; a -28px drag → round(-1.75) → -2.
 */
export function pxDeltaToDays(dxPx: number, pxPerDay: number): number {
  if (pxPerDay <= 0) return 0
  return Math.round(dxPx / pxPerDay)
}

/**
 * Shift a bar's `[startIso, endIso]` range by `dayDelta` whole days,
 * preserving its duration. Returns date-only `YYYY-MM-DD` strings in
 * local time (the day granularity the calendar/timeline operate at — v1
 * is all-day). Returns null when either endpoint is null/unparseable so
 * the caller can decline the reschedule. Pure + exported for tests.
 */
export function shiftRange(
  startIso: string | null,
  endIso: string | null,
  dayDelta: number,
): { start: string; end: string } | null {
  if (!startIso || !endIso) return null
  const s = parseToLocalDay(startIso)
  const e = parseToLocalDay(endIso)
  if (!s || !e) return null
  return {
    start: toIsoDay(addDays(s, dayDelta)),
    end: toIsoDay(addDays(e, dayDelta)),
  }
}

/**
 * Parse an ISO value to a local-midnight Date. Bare `YYYY-MM-DD` is read
 * as a local calendar day (not UTC) so a date-only binding value doesn't
 * shift a day under `Date.parse`'s UTC interpretation; timestamps with a
 * time/zone component are parsed normally and reduced to their local
 * day — the same "local day key" normalization `groupRowsByDay` uses on
 * the Calendar side. Returns null on unparseable input.
 */
function parseToLocalDay(iso: string): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
  }
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** YYYY-MM-DD in local time. Mirrors Calendar's `toIsoDate`. */
function toIsoDay(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, '0')
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Build axis tick descriptors for the given zoom. Each tick carries a
 * `day` offset from `start`, a column `widthDays`, and a `label`.
 * Exported for tests.
 */
export function buildAxisTicks(
  start: Date,
  totalDays: number,
  zoom: TimelineZoom,
): { day: number; widthDays: number; label: string }[] {
  const out: { day: number; widthDays: number; label: string }[] = []
  if (zoom === 'day') {
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(start, i)
      out.push({ day: i, widthDays: 1, label: dayLabel(d) })
    }
    return out
  }
  if (zoom === 'week') {
    // One tick per day, two-letter weekday names ("Mo", "Tu", ...).
    for (let i = 0; i < totalDays; i++) {
      const d = addDays(start, i)
      out.push({ day: i, widthDays: 1, label: weekdayLabel(d) })
    }
    return out
  }
  if (zoom === 'month') {
    // One tick per calendar month inside the window.
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
    while (true) {
      const dayOffset = daysBetween(start, cursor)
      if (dayOffset >= totalDays) break
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0)
      const widthDays = Math.min(
        daysBetween(cursor, monthEnd) + 1,
        totalDays - Math.max(0, dayOffset),
      )
      out.push({
        day: Math.max(0, dayOffset),
        widthDays,
        label: monthLabel(cursor),
      })
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
    return out
  }
  // quarter
  let cursor = startOfQuarter(start)
  while (true) {
    const dayOffset = daysBetween(start, cursor)
    if (dayOffset >= totalDays) break
    const quarterEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 0)
    const widthDays = Math.min(
      daysBetween(cursor, quarterEnd) + 1,
      totalDays - Math.max(0, dayOffset),
    )
    out.push({
      day: Math.max(0, dayOffset),
      widthDays,
      label: quarterLabel(cursor),
    })
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 1)
  }
  return out
}

/**
 * Default visible range per zoom: month at day/month/quarter, 4 weeks
 * centered on today at week. Exported for tests.
 */
export function defaultRange(today: Date, zoom: TimelineZoom): { start: Date; end: Date } {
  const t = stripTime(today)
  if (zoom === 'week') {
    // 4 weeks (28 days) centered on today.
    return { start: addDays(t, -14), end: addDays(t, 13) }
  }
  if (zoom === 'day') {
    return { start: addDays(t, -7), end: addDays(t, 13) }
  }
  if (zoom === 'month') {
    // 3 months centered on current month.
    const start = new Date(t.getFullYear(), t.getMonth() - 1, 1)
    const end = new Date(t.getFullYear(), t.getMonth() + 2, 0)
    return { start, end }
  }
  // quarter — current year (4 quarters)
  const qStart = startOfQuarter(t)
  const start = new Date(qStart.getFullYear(), qStart.getMonth() - 3, 1)
  const end = new Date(qStart.getFullYear(), qStart.getMonth() + 9, 0)
  return { start, end }
}

function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  out.setDate(out.getDate() + days)
  return out
}

function daysBetween(a: Date, b: Date): number {
  const aDay = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()
  const bDay = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime()
  return Math.round((bDay - aDay) / DAY_MS)
}

function dayDelta(rangeStart: Date, iso: string): number | null {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return daysBetween(rangeStart, new Date(t))
}

function startOfQuarter(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3)
  return new Date(d.getFullYear(), q * 3, 1)
}

function dayLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function weekdayLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2)
}

function monthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

function quarterLabel(d: Date): string {
  const q = Math.floor(d.getMonth() / 3) + 1
  return `Q${q} ${d.getFullYear()}`
}

// ── Row helpers ───────────────────────────────────────────────────────

function isoFromRowValue(v: A2UIRowValue | undefined): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number') return null
  if (v.type === 'date') return (v as DateWidget).iso
  return null
}

function stringId(v: A2UIRowValue | undefined): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return null
}

function labelText(row: A2UIRow, column: A2UIColumn | undefined): string {
  if (!column) {
    const id = stringId(row.id)
    return id ?? ''
  }
  const v = row[column.field]
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (v.type === 'text' || v.type === 'badge' || v.type === 'heading' || v.type === 'button') {
    return v.text
  }
  if (v.type === 'person') return v.name
  if (v.type === 'relation') return v.label
  if (v.type === 'date') return v.iso ?? ''
  return ''
}

/**
 * Cheap signature of the row set's identities — the ordered list of
 * `row.id`s (positional fallback for id-less rows). Drives the
 * optimistic-overlay reset on refetch, the same way Board's
 * `columnSignature` does. Exported for tests.
 */
export function rowIdSignature(rows: A2UIRow[]): string {
  return rows.map((r, i) => stringId(r.id) ?? `row-${i}`).join('|')
}

/**
 * Apply the optimistic-reschedule overlay to a row set: for each row
 * whose id is in `overlay`, rewrite its start + end date cells to the
 * shifted ISO days so the bar renders at its new range immediately.
 * Pure — fresh array, never mutates. Rows not in the overlay pass
 * through by reference. Exported for tests.
 */
export function applyTimelineOptimistic(
  rows: A2UIRow[],
  startColumnId: string,
  endColumnId: string,
  overlay: Record<string, { start: string; end: string }>,
): A2UIRow[] {
  if (Object.keys(overlay).length === 0) return rows
  return rows.map((row, idx) => {
    const id = stringId(row.id) ?? `row-${idx}`
    const next = overlay[id]
    if (!next) return row
    return { ...row, [startColumnId]: next.start, [endColumnId]: next.end }
  })
}
