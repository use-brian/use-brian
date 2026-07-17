/**
 * A2UI Calendar — month/week/day grid placing rows on the day their
 * date column carries.
 *
 * Same `rows + columns` shape as Table — the difference is purely
 * presentational: each row lands on one day cell based on the value of
 * `row[dateColumnId]`. The cell value can be a `DateWidget`
 * (`{ type: 'date', iso, format }`) or a plain ISO string; both flow
 * through `coerceIso` so the renderer stays compatible with whichever
 * shape the bindings emit.
 *
 * Month view (default) renders a Mon-first 7×(5–6) grid containing the
 * navigated cursor's month, padded with the leading/trailing days
 * needed to fill the corners. Week view renders a single 7-column strip
 * of the week containing the cursor. Day view renders a single full-
 * width cell for the cursor's day. v1 is all-day only — no time-of-day
 * grid.
 *
 * Date math is hand-rolled — no date library. The pure helpers
 * (`addDays`, `startOfMonth`, `monthGridStart`, `weekGridStart`,
 * `dayGridStart`, etc.) are exported for tests. `Intl.DateTimeFormat`
 * supplies the month name and short day-of-week headers so the surface
 * respects the user's locale without pulling in a heavier i18n stack.
 *
 * Interactions:
 *   - Click a day cell → `onAction('date-clicked', { date: 'YYYY-MM-DD' })`
 *   - Click a row chip → `onAction(rowAction.id, { ...rowAction.params, rowId })`
 *   - Drag a row chip onto a different day cell → optimistic local move
 *     plus `onAction('reschedule', { rowId, date: '<newIso>', dateField })`.
 *     The host owns persistence; the visual move is reverted on the next
 *     payload re-render if the write fails. Mirrors Board's card-move
 *     shape (optimistic local state + a single action callback; no
 *     backend call from the renderer).
 *   - Navigation arrows (◀ / ▶) move the cursor one month (month view),
 *     one week (week view), or one day (day view). The "Today" button
 *     resets the cursor.
 *
 * Day cells render the day-of-month numeral and up to 3 row chips
 * (title-column text, truncated). When a day holds more rows than the
 * chip budget allows, the surplus is summarised as a "+N more" pill
 * (currently inert — no popover; click goes to the day cell itself).
 *
 * Today is highlighted with `bg-[var(--accent)]/30` per the doc-v1
 * spec. Days outside the cursor's month are tinted muted so the user
 * can still see the leading/trailing-week context without losing focus.
 *
 * [COMP:views/calendar]
 */

import { type JSX, useMemo, useRef, useState } from 'react'
import type {
  A2UIColumn,
  A2UIRow,
  A2UIRowValue,
  ActionRef,
  DateWidget,
  OnActionHandler,
} from '../types.js'

/**
 * The three interactive view modes. The wire schema's `initialView`
 * only seeds `'month' | 'week'` (see `CalendarWidget` in
 * `@use-brian/core`); `'day'` is reached via the in-grid Day tab, so it
 * lives here as renderer-local state rather than as a payload field.
 */
export type CalendarView = 'month' | 'week' | 'day'

export type CalendarProps = {
  rows: A2UIRow[]
  columns: A2UIColumn[]
  dateColumnId: string
  rowAction?: ActionRef
  emptyMessage?: string
  /** Seeds the initial view. Wire-format only seeds month/week. */
  initialView?: 'month' | 'week'
  onAction?: OnActionHandler
  /**
   * Override "today" for deterministic tests. Production renderers omit
   * this — the component reads `new Date()` at mount.
   */
  now?: Date
}

const DEFAULT_EMPTY = 'No items in this range.'
const MAX_CHIPS_PER_DAY = 3

// ── Pure date helpers (exported for tests) ────────────────────────────

/** Local-midnight clone of `d` (drops time-of-day for day-level math). */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Local-midnight Date for the first of the cursor's month. */
function startOfMonth(cursor: Date): Date {
  return new Date(cursor.getFullYear(), cursor.getMonth(), 1)
}

/** Number of days in the cursor's month. */
function daysInMonth(cursor: Date): number {
  return new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
}

/** Returns 0–6 where 0=Mon, 6=Sun. */
function mondayIndex(d: Date): number {
  return (d.getDay() + 6) % 7
}

/** Pure helper: add `n` days (positive or negative) to `d`. */
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

/**
 * The first cell of the month grid — the Monday of the week containing
 * the 1st of the cursor's month. May be in the previous month.
 */
export function monthGridStart(cursor: Date): Date {
  const first = startOfMonth(cursor)
  return addDays(first, -mondayIndex(first))
}

/**
 * Number of week rows the month grid needs — 5 or 6 depending on how
 * the month aligns to the Mon-first week.
 */
export function monthGridRows(cursor: Date): number {
  return Math.ceil((mondayIndex(startOfMonth(cursor)) + daysInMonth(cursor)) / 7)
}

/** Monday of the week containing `cursor`. */
export function weekGridStart(cursor: Date): Date {
  return addDays(startOfDay(cursor), -mondayIndex(cursor))
}

/**
 * First (and only) cell of the day grid — local midnight of the
 * cursor's own day. Trivial, but exported alongside `monthGridStart` /
 * `weekGridStart` so `buildGridCells` reads uniformly across all three
 * view modes and the day math is independently testable.
 */
export function dayGridStart(cursor: Date): Date {
  return startOfDay(cursor)
}

/** YYYY-MM-DD in local time (the day key the host fires on click). */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, '0')
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** True when `a` and `b` share year+month+day (in local time). */
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  )
}

/**
 * Pull a `YYYY-MM-DD` key out of a row's date cell. Accepts the
 * `DateWidget` shape (the bindings' typed cell) and the plain ISO
 * string shape (the legacy column kind that just emits the ISO). Drops
 * unparseable / null values silently — the row simply isn't placed.
 */
export function coerceIso(value: A2UIRowValue): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'number') return null
  // DateWidget — extract the iso field.
  if (value.type === 'date') {
    const dw = value as DateWidget
    return dw.iso
  }
  return null
}

/**
 * Bucket rows by `YYYY-MM-DD` key resolved through `coerceIso`. Rows
 * whose date cell is null/unparseable are dropped. Used by both the
 * month grid (per-cell lookup) and the empty-state check (visible
 * range produced zero placements).
 */
export function groupRowsByDay(
  rows: A2UIRow[],
  dateColumnId: string,
): Map<string, A2UIRow[]> {
  const map = new Map<string, A2UIRow[]>()
  for (const row of rows) {
    const iso = coerceIso(row[dateColumnId] ?? null)
    if (!iso) continue
    // Normalise to a local YYYY-MM-DD key so server-emitted Z-suffixed
    // timestamps land on the right calendar day for the viewer.
    const parsed = Date.parse(iso)
    if (!Number.isFinite(parsed)) continue
    const key = toIsoDate(new Date(parsed))
    const bucket = map.get(key)
    if (bucket) {
      bucket.push(row)
    } else {
      map.set(key, [row])
    }
  }
  return map
}

// ── Component ─────────────────────────────────────────────────────────

/**
 * Stateful entry point — used by the renderer dispatch. State is the
 * `view` (month/week/day), the navigation `cursor`, and an optional
 * optimistic-reschedule overlay (`{ rowId → newIso }`) so a dragged
 * chip lands on its new day immediately. All presentation lives in
 * `renderCalendar()` so the unit tests can exercise click + drop
 * handlers without spinning up a React reconciler (the same
 * hoisted-state pattern Timeline uses).
 *
 * The reschedule overlay mirrors Board's optimistic-move split state:
 * the renderer never writes to a backend — it fires
 * `onAction('reschedule', …)` and lets the host persist, then the next
 * payload re-render replaces the local overlay. We key the overlay off
 * `rowId` and reset it whenever the incoming row identities change so a
 * stale optimistic move can't outlive a refetch.
 */
export function Calendar(props: CalendarProps): JSX.Element {
  const today = props.now ?? new Date()
  const initialView = props.initialView ?? 'month'
  const [view, setView] = useState<CalendarView>(initialView)
  const [cursor, setCursor] = useState<Date>(startOfDay(today))
  const [optimistic, setOptimistic] = useState<Record<string, string>>({})

  // Drop the optimistic overlay when the row set changes (refetch). We
  // compare a cheap id signature rather than deep-equal so identical
  // re-renders don't churn — same approach as Board's `columnSignature`.
  const rowsSignature = useMemo(() => rowIdSignature(props.rows), [props.rows])
  const lastSignature = useRef(rowsSignature)
  if (lastSignature.current !== rowsSignature) {
    lastSignature.current = rowsSignature
    if (Object.keys(optimistic).length > 0) setOptimistic({})
  }

  const handleNavigate = (direction: -1 | 1): void => {
    setCursor((c) => {
      if (view === 'month') return new Date(c.getFullYear(), c.getMonth() + direction, 1)
      if (view === 'week') return addDays(c, direction * 7)
      return addDays(c, direction)
    })
  }
  const handleToday = (): void => setCursor(startOfDay(today))

  const handleReschedule = (rowId: string, isoDate: string): void => {
    // Optimistic local move — record the new day key for this row.
    setOptimistic((prev) => ({ ...prev, [rowId]: isoDate }))
    // Notify host with Board-shaped metadata (single action callback;
    // no backend call from the renderer). `dateField` tells the host
    // which date property to write; the host issues the PATCH and
    // re-renders with fresh payload, which clears the overlay above.
    props.onAction?.('reschedule', rescheduleAction(props.dateColumnId, rowId, isoDate))
  }

  return renderCalendar({
    rows: applyOptimistic(props.rows, props.dateColumnId, optimistic),
    columns: props.columns,
    dateColumnId: props.dateColumnId,
    rowAction: props.rowAction,
    emptyMessage: props.emptyMessage,
    onAction: props.onAction,
    today,
    view,
    cursor,
    onNavigate: handleNavigate,
    onToday: handleToday,
    onSwitchView: setView,
    onReschedule: handleReschedule,
  })
}

/**
 * Pure render. State is supplied via props so unit tests can call this
 * directly (no React reconciler needed) and assert against the React
 * element tree.
 */
export type RenderCalendarProps = {
  rows: A2UIRow[]
  columns: A2UIColumn[]
  dateColumnId: string
  rowAction?: ActionRef
  emptyMessage?: string
  onAction?: OnActionHandler
  today: Date
  view: CalendarView
  cursor: Date
  onNavigate: (direction: -1 | 1) => void
  onToday: () => void
  onSwitchView: (view: CalendarView) => void
  /**
   * Fired when a chip is dropped on a different day. Receives the row id
   * and the target day's ISO key. Omitted ⇒ chips are not draggable.
   */
  onReschedule?: (rowId: string, isoDate: string) => void
}

export function renderCalendar(props: RenderCalendarProps): JSX.Element {
  const titleColumn: A2UIColumn | undefined = props.columns.find(
    (c) => c.field !== props.dateColumnId,
  ) ?? props.columns[0]

  const byDay = groupRowsByDay(props.rows, props.dateColumnId)
  const gridCells = buildGridCells(props.cursor, props.view)

  // Empty-state: zero placements in the visible range.
  let visibleHasPlacements = false
  for (const cell of gridCells) {
    if (byDay.has(toIsoDate(cell))) {
      visibleHasPlacements = true
      break
    }
  }

  const handleDayClick = (cell: Date): void => {
    if (!props.onAction) return
    props.onAction('date-clicked', { date: toIsoDate(cell) })
  }

  const handleChipClick = (rowId: string, e: React.MouseEvent): void => {
    if (!props.rowAction || !props.onAction) return
    e.stopPropagation()
    props.onAction(props.rowAction.id, {
      ...props.rowAction.params,
      rowId,
    })
  }

  const draggable = Boolean(props.onReschedule)

  const handleDropOnDay = (cell: Date, e: React.DragEvent): void => {
    if (!props.onReschedule) return
    e.preventDefault()
    const rowId = e.dataTransfer.getData('text/x-calendar-row')
    if (!rowId) return
    const targetIso = toIsoDate(cell)
    // No-op drop on the row's current day — nothing to reschedule.
    const current = currentDayKey(props.rows, props.dateColumnId, rowId)
    if (current === targetIso) return
    props.onReschedule(rowId, targetIso)
  }

  // Day view is a single full-bleed cell; month/week stay 7-wide.
  const gridColsClass = props.view === 'day' ? 'grid-cols-1' : 'grid-cols-7'

  return (
    <div className="flex flex-col gap-3" data-calendar-view={props.view}>
      <CalendarHeader
        cursor={props.cursor}
        view={props.view}
        onNavigate={props.onNavigate}
        onToday={props.onToday}
        onSwitchView={props.onSwitchView}
      />
      {props.view === 'day' ? null : <CalendarWeekHeader />}
      <div
        className={`grid ${gridColsClass} gap-px overflow-hidden rounded-md border border-border bg-border ${
          props.view === 'month'
            ? 'auto-rows-fr'
            : ''
        }`}
        role="grid"
        data-calendar-grid={props.view}
      >
        {gridCells.map((cell) => {
          const key = toIsoDate(cell)
          const rowsForDay = byDay.get(key) ?? []
          const isToday = sameDay(cell, props.today)
          const inMonth = props.view !== 'month'
            || cell.getMonth() === props.cursor.getMonth()
          return (
            <CalendarDayCell
              key={key}
              cell={cell}
              rowsForDay={rowsForDay}
              isToday={isToday}
              inMonth={inMonth}
              titleColumn={titleColumn}
              onDayClick={handleDayClick}
              onChipClick={handleChipClick}
              chippable={Boolean(props.rowAction && props.onAction)}
              draggable={draggable}
              onDropOnDay={handleDropOnDay}
            />
          )
        })}
      </div>
      {props.rows.length > 0 && !visibleHasPlacements ? (
        <div
          className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-3 text-center text-xs text-muted-foreground"
          role="status"
        >
          {props.emptyMessage ?? DEFAULT_EMPTY}
        </div>
      ) : null}
      {props.rows.length === 0 ? (
        <div
          className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-3 text-center text-xs text-muted-foreground"
          role="status"
          data-calendar-empty
        >
          {props.emptyMessage ?? DEFAULT_EMPTY}
        </div>
      ) : null}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────

function CalendarHeader(props: {
  cursor: Date
  view: CalendarView
  onNavigate: (direction: -1 | 1) => void
  onToday: () => void
  onSwitchView: (view: CalendarView) => void
}): JSX.Element {
  const label = headerLabel(props.cursor, props.view)

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Previous"
          onClick={() => props.onNavigate(-1)}
          className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
        >
          {'◀'}
        </button>
        <button
          type="button"
          onClick={props.onToday}
          className="rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
        >
          Today
        </button>
        <button
          type="button"
          aria-label="Next"
          onClick={() => props.onNavigate(1)}
          className="rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
        >
          {'▶'}
        </button>
      </div>
      <div className="text-sm font-medium text-foreground" data-calendar-label>
        {label}
      </div>
      <div className="flex items-center gap-1" role="tablist" aria-label="View">
        {VIEW_TABS.map((tab) => (
          <button
            key={tab.view}
            type="button"
            role="tab"
            aria-selected={props.view === tab.view}
            data-calendar-tab={tab.view}
            onClick={() => props.onSwitchView(tab.view)}
            className={`rounded-sm border px-2 py-1 text-xs ${
              props.view === tab.view
                ? 'border-primary bg-accent/40 text-foreground'
                : 'border-border bg-background text-muted-foreground hover:bg-accent/40'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function CalendarWeekHeader(): JSX.Element {
  return (
    <div className="grid grid-cols-7 gap-px text-xs font-medium text-muted-foreground">
      {WEEKDAY_LABELS.map((label, idx) => (
        <div key={label + idx} className="px-2 py-1 text-center">
          {label}
        </div>
      ))}
    </div>
  )
}

/**
 * Short-day-of-week labels in Mon-first order. Computed once at module
 * load using a fixed Monday anchor (2026-05-04) so the labels respect
 * the runtime's locale while staying stable across renders + DST.
 */
const WEEKDAY_LABELS: string[] = (() => {
  const labels: string[] = []
  const fmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
  const mon = new Date(2026, 4, 4) // 2026-05-04 Mon
  for (let i = 0; i < 7; i += 1) {
    labels.push(fmt.format(addDays(mon, i)))
  }
  return labels
})()

/**
 * The view-switch tabs, in display order. Labels are hardcoded English
 * (matching the existing "Today" button and the former inline Month /
 * Week buttons) — this package has no i18n layer; host-localized copy
 * is a follow-up that would flow through the same `ViewPayload` seam.
 */
const VIEW_TABS: { view: CalendarView; label: string }[] = [
  { view: 'month', label: 'Month' },
  { view: 'week', label: 'Week' },
  { view: 'day', label: 'Day' },
]

/**
 * Header label for the navigation toolbar — "May 2026" in month view,
 * "May 25 – May 31, 2026" in week view, or "Thursday, May 28, 2026" in
 * day view. Pure for testability; exported so the label math is
 * asserted directly without rendering.
 */
export function headerLabel(cursor: Date, view: CalendarView): string {
  if (view === 'month') {
    return new Intl.DateTimeFormat(undefined, {
      month: 'long',
      year: 'numeric',
    }).format(cursor)
  }
  if (view === 'day') {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(startOfDay(cursor))
  }
  const start = weekGridStart(cursor)
  const end = addDays(start, 6)
  const fmt = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  })
  return `${fmt.format(start)} – ${fmt.format(end)}, ${end.getFullYear()}`
}

function CalendarDayCell(props: {
  cell: Date
  rowsForDay: A2UIRow[]
  isToday: boolean
  inMonth: boolean
  titleColumn: A2UIColumn | undefined
  onDayClick: (cell: Date) => void
  onChipClick: (rowId: string, e: React.MouseEvent) => void
  chippable: boolean
  /** When true, chips are draggable and this cell is a drop target. */
  draggable: boolean
  onDropOnDay: (cell: Date, e: React.DragEvent) => void
}): JSX.Element {
  const visibleChips = props.rowsForDay.slice(0, MAX_CHIPS_PER_DAY)
  const overflow = props.rowsForDay.length - visibleChips.length
  const isoKey = toIsoDate(props.cell)

  // Hook-free on purpose: the unit-test tree walker invokes this
  // component directly to find click handlers, so it must not call
  // useState. Drag-over highlight is left to native browser cues + the
  // optimistic move; a hover ring would force a reconciler.
  const dropProps = props.draggable
    ? {
        onDragOver: (e: React.DragEvent) => {
          // Allow the drop only for our chip payload.
          if (e.dataTransfer.types.includes('text/x-calendar-row')) {
            e.preventDefault()
          }
        },
        onDrop: (e: React.DragEvent) => props.onDropOnDay(props.cell, e),
      }
    : {}

  return (
    <div
      role="gridcell"
      data-calendar-day={isoKey}
      data-calendar-today={props.isToday ? 'true' : undefined}
      onClick={() => props.onDayClick(props.cell)}
      {...dropProps}
      className={[
        'flex min-h-20 flex-col gap-1 bg-background p-1 text-left transition-colors',
        'cursor-pointer hover:bg-accent/40',
        props.isToday ? 'bg-[var(--accent)]/30' : '',
        props.inMonth ? '' : 'text-muted-foreground',
      ]
        .join(' ')
        .trim()}
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-xs ${props.isToday ? 'font-semibold text-foreground' : ''}`}
        >
          {props.cell.getDate()}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {visibleChips.map((row, idx) => {
          const rowId = resolveRowId(row, idx)
          const title = chipTitle(row, props.titleColumn)
          return (
            <button
              type="button"
              key={rowId}
              data-calendar-chip={rowId}
              draggable={props.draggable}
              onDragStart={props.draggable
                ? (e) => {
                    e.dataTransfer.setData('text/x-calendar-row', rowId)
                    e.dataTransfer.effectAllowed = 'move'
                  }
                : undefined}
              onClick={(e) => props.onChipClick(rowId, e)}
              disabled={!props.chippable && !props.draggable}
              className={`truncate rounded-sm border border-border bg-muted/60 px-1.5 py-0.5 text-left text-xs text-foreground ${
                props.draggable ? 'cursor-grab active:cursor-grabbing ' : ''
              }${
                props.chippable ? 'hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40' : props.draggable ? '' : 'cursor-default'
              }`}
              title={title}
            >
              {title || '—'}
            </button>
          )
        })}
        {overflow > 0 ? (
          <div
            data-calendar-overflow
            className="text-[10px] text-muted-foreground"
          >
            +{overflow} more
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Build the visible-cell list for the active view. Month view returns
 * `7 × monthGridRows(cursor)` cells starting at `monthGridStart(cursor)`.
 * Week view returns 7 cells starting at `weekGridStart(cursor)`. Day
 * view returns a single cell at `dayGridStart(cursor)`.
 */
export function buildGridCells(cursor: Date, view: CalendarView): Date[] {
  if (view === 'day') {
    return [dayGridStart(cursor)]
  }
  if (view === 'week') {
    const start = weekGridStart(cursor)
    return Array.from({ length: 7 }, (_, i) => addDays(start, i))
  }
  const start = monthGridStart(cursor)
  const total = monthGridRows(cursor) * 7
  return Array.from({ length: total }, (_, i) => addDays(start, i))
}

/**
 * Cheap signature of the row set's identities — the ordered list of
 * `row.id`s. Used to decide when an incoming refetch should drop the
 * optimistic-reschedule overlay (Board uses the same idea in
 * `columnSignature`). Rows without a string id contribute their index
 * so re-ordering still changes the signature.
 */
export function rowIdSignature(rows: A2UIRow[]): string {
  return rows.map((r, i) => resolveRowId(r, i)).join('|')
}

/**
 * Apply the optimistic-reschedule overlay to a row set: for each row
 * whose id is in `overlay`, rewrite its `dateColumnId` cell to the
 * overlaid ISO day so it renders on the dropped-on cell immediately.
 * Pure — returns a fresh array; never mutates inputs. Rows not in the
 * overlay pass through untouched (same reference).
 */
export function applyOptimistic(
  rows: A2UIRow[],
  dateColumnId: string,
  overlay: Record<string, string>,
): A2UIRow[] {
  if (Object.keys(overlay).length === 0) return rows
  return rows.map((row, idx) => {
    const id = resolveRowId(row, idx)
    const iso = overlay[id]
    if (!iso) return row
    return { ...row, [dateColumnId]: iso }
  })
}

/**
 * Build the `onAction('reschedule', …)` payload — the Board-shaped
 * `{ rowId, date, dateField }` the host persists. `dateField` is the
 * column the new date should be written to (the calendar's
 * `dateColumnId`). Pure so the component's glue is unit-testable
 * without a reconciler.
 */
export function rescheduleAction(
  dateColumnId: string,
  rowId: string,
  isoDate: string,
): { rowId: string; date: string; dateField: string } {
  return { rowId, date: isoDate, dateField: dateColumnId }
}

/**
 * Resolve the normalized `YYYY-MM-DD` day key a given row currently
 * lands on — the same normalization `groupRowsByDay` applies (local
 * day of the parsed ISO). Returns null when the row isn't found or its
 * date is null/unparseable. Used to short-circuit a no-op drop (chip
 * dropped back on its own day). Pure for testability.
 */
export function currentDayKey(
  rows: A2UIRow[],
  dateColumnId: string,
  rowId: string,
): string | null {
  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx]
    if (resolveRowId(row, idx) !== rowId) continue
    const iso = coerceIso(row[dateColumnId] ?? null)
    if (!iso) return null
    const parsed = Date.parse(iso)
    if (!Number.isFinite(parsed)) return null
    return toIsoDate(new Date(parsed))
  }
  return null
}

/**
 * Stable row identity. Mirrors Table's `getRowId` — uses `row.id` when
 * it's a string, otherwise falls back to a positional key so React's
 * reconciler still gets a unique key for chips on the same day.
 */
function resolveRowId(row: A2UIRow, idx: number): string {
  const raw = row['id']
  if (typeof raw === 'string') return raw
  return `row-${idx}`
}

/**
 * Extract a flat title string for the chip surface. Picks the first
 * non-date column (typically the title column) and reduces its widget
 * value to a string the same way Gallery does. Returns the empty
 * string when no meaningful title is available — the cell still
 * renders a clickable em-dash so the row is visible.
 */
function chipTitle(row: A2UIRow, titleColumn: A2UIColumn | undefined): string {
  if (!titleColumn) return ''
  const value = row[titleColumn.field] ?? null
  if (value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  switch (value.type) {
    case 'text':
    case 'heading':
    case 'badge':
    case 'button':
      return value.text
    case 'relation':
      return value.label
    case 'person':
      return value.name
    case 'date':
      return value.iso ?? ''
    case 'number':
      return value.value === null ? '' : String(value.value)
    default:
      return ''
  }
}
