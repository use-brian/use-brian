/**
 * [COMP:views/calendar] Calendar widget dispatch + month-grid math +
 * row placement + click actions + navigation.
 *
 * The package's test environment is node (no DOM), so DOM-level
 * interaction goes through React's element tree: `renderToStaticMarkup`
 * exposes the rendered HTML for assertions on day cells / chips /
 * overflow pills, and we exercise the click handlers by reaching into
 * the React element prop tree returned by `Calendar()` via a render
 * fixture that mounts the widget with `createElement`.
 *
 * The pure date helpers (`monthGridStart`, `monthGridRows`,
 * `buildGridCells`, `coerceIso`, `groupRowsByDay`) are exported from
 * the widget so we can assert grid math without touching React at all.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderWidget } from '../render.js'
import {
  Calendar,
  applyOptimistic,
  buildGridCells,
  coerceIso,
  currentDayKey,
  dayGridStart,
  groupRowsByDay,
  headerLabel,
  monthGridRows,
  monthGridStart,
  renderCalendar,
  rescheduleAction,
  rowIdSignature,
  startOfDay,
  toIsoDate,
  weekGridStart,
} from '../widgets/Calendar.js'
import type { CalendarWidget } from '../types.js'

function elementType(el: ReactElement): string {
  const t = el.type
  if (typeof t === 'string') return t
  if (typeof t === 'function') return (t as { name?: string }).name ?? 'anonymous'
  return String(t)
}

const SAMPLE_CALENDAR: CalendarWidget = {
  type: 'calendar',
  dateColumnId: 'due',
  columns: [
    { field: 'title', header: 'Title' },
    { field: 'due', header: 'Due', kind: 'date' },
  ],
  rows: [
    { id: 'r1', title: 'Plan demo', due: '2026-05-15' },
    { id: 'r2', title: 'Ship feature', due: { type: 'date', iso: '2026-05-15' } },
    { id: 'r3', title: 'Review PR', due: '2026-05-20' },
  ],
}

// ── Dispatch ──────────────────────────────────────────────────────────

describe('[COMP:views/calendar] dispatch', () => {
  it('dispatches Calendar for type=calendar', () => {
    const el = renderWidget(SAMPLE_CALENDAR)
    expect(elementType(el)).toBe('Calendar')
  })

  it('forwards rows/columns/dateColumnId/onAction', () => {
    const onAction = () => undefined
    const el = renderWidget(SAMPLE_CALENDAR, onAction)
    const props = el.props as {
      rows: typeof SAMPLE_CALENDAR.rows
      columns: typeof SAMPLE_CALENDAR.columns
      dateColumnId: string
      onAction?: typeof onAction
    }
    expect(props.rows).toEqual(SAMPLE_CALENDAR.rows)
    expect(props.columns).toEqual(SAMPLE_CALENDAR.columns)
    expect(props.dateColumnId).toBe('due')
    expect(props.onAction).toBe(onAction)
  })
})

// ── Pure date math ────────────────────────────────────────────────────

describe('[COMP:views/calendar] month grid math', () => {
  it('monthGridStart returns the Mon of the week containing the 1st', () => {
    // May 2026 — 1st is Fri. Mon of that week is Apr 27.
    const cursor = new Date(2026, 4, 15)
    const start = monthGridStart(cursor)
    expect(toIsoDate(start)).toBe('2026-04-27')
  })

  it('monthGridStart for Feb 2026 (1st is Sun) reaches into Jan', () => {
    const cursor = new Date(2026, 1, 15)
    expect(toIsoDate(monthGridStart(cursor))).toBe('2026-01-26')
  })

  it('monthGridRows returns 5 for a month that fits in 5 rows', () => {
    // Feb 2026: 1st = Sun, 28 days → mondayIndex(1st)=6, 6+28=34 → 5 weeks
    expect(monthGridRows(new Date(2026, 1, 1))).toBe(5)
  })

  it('monthGridRows returns 6 for a month that overflows to 6 rows', () => {
    // May 2026: 1st = Fri, 31 days → mondayIndex(1st)=4, 4+31=35 → 5 weeks
    // Pick a month that needs 6 — Aug 2026 (1st = Sat, 31 days): 5+31=36
    expect(monthGridRows(new Date(2026, 7, 1))).toBe(6)
  })

  it('buildGridCells emits 7×rows month cells starting at Monday', () => {
    const cursor = new Date(2026, 4, 15) // May 2026 → 5 rows
    const cells = buildGridCells(cursor, 'month')
    expect(cells).toHaveLength(35)
    expect(toIsoDate(cells[0])).toBe('2026-04-27')
    expect(toIsoDate(cells[6])).toBe('2026-05-03')
    expect(toIsoDate(cells[cells.length - 1])).toBe('2026-05-31')
  })

  it('buildGridCells emits exactly 7 cells for week view', () => {
    const cursor = new Date(2026, 4, 28) // Thu in May 2026
    const cells = buildGridCells(cursor, 'week')
    expect(cells).toHaveLength(7)
    // Mon of the week containing 28 May 2026 is 25 May.
    expect(toIsoDate(weekGridStart(cursor))).toBe('2026-05-25')
    expect(toIsoDate(cells[0])).toBe('2026-05-25')
    expect(toIsoDate(cells[6])).toBe('2026-05-31')
  })

  it('dayGridStart returns local midnight of the cursor day', () => {
    const cursor = new Date(2026, 4, 28, 17, 42) // afternoon
    const start = dayGridStart(cursor)
    expect(toIsoDate(start)).toBe('2026-05-28')
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
  })

  it('buildGridCells emits exactly 1 cell for day view', () => {
    const cursor = new Date(2026, 4, 28)
    const cells = buildGridCells(cursor, 'day')
    expect(cells).toHaveLength(1)
    expect(toIsoDate(cells[0])).toBe('2026-05-28')
  })
})

// ── Header label (per view) ──────────────────────────────────────────

describe('[COMP:views/calendar] header label', () => {
  const cursor = new Date(2026, 4, 28) // 2026-05-28 Thu

  it('month label carries the year', () => {
    expect(headerLabel(cursor, 'month')).toMatch(/2026/)
  })

  it('week label spans Mon–Sun of the cursor week', () => {
    const label = headerLabel(cursor, 'week')
    // Week of 2026-05-28 runs 25–31 May; label carries both bounds.
    expect(label).toMatch(/25/)
    expect(label).toMatch(/31/)
    expect(label).toMatch(/2026/)
  })

  it('day label names the weekday + full date', () => {
    const label = headerLabel(cursor, 'day')
    // Locale-specific weekday/month names, but the numerals are stable.
    expect(label).toMatch(/28/)
    expect(label).toMatch(/2026/)
  })
})

// ── Row date coercion + bucketing ────────────────────────────────────

describe('[COMP:views/calendar] date coercion', () => {
  it('coerceIso reads DateWidget.iso', () => {
    expect(coerceIso({ type: 'date', iso: '2026-05-15' })).toBe('2026-05-15')
    expect(coerceIso({ type: 'date', iso: null })).toBeNull()
  })

  it('coerceIso passes plain ISO strings through', () => {
    expect(coerceIso('2026-05-15')).toBe('2026-05-15')
    expect(coerceIso('')).toBeNull()
  })

  it('coerceIso drops nulls / numbers / unrelated widgets', () => {
    expect(coerceIso(null)).toBeNull()
    expect(coerceIso(42)).toBeNull()
    expect(coerceIso({ type: 'text', text: 'hi' })).toBeNull()
  })

  it('groupRowsByDay buckets rows by YYYY-MM-DD', () => {
    const map = groupRowsByDay(SAMPLE_CALENDAR.rows, 'due')
    expect(map.get('2026-05-15')?.length).toBe(2)
    expect(map.get('2026-05-20')?.length).toBe(1)
    expect(map.get('2026-05-21')).toBeUndefined()
  })
})

// ── Reschedule pure helpers ───────────────────────────────────────────

describe('[COMP:views/calendar] reschedule helpers', () => {
  it('rowIdSignature joins resolved ids in order', () => {
    expect(rowIdSignature(SAMPLE_CALENDAR.rows)).toBe('r1|r2|r3')
    // Re-ordering changes the signature (so a refetch drops the overlay).
    const reordered = [SAMPLE_CALENDAR.rows[2], SAMPLE_CALENDAR.rows[0]]
    expect(rowIdSignature(reordered)).toBe('r3|r1')
  })

  it('applyOptimistic rewrites only the overlaid rows date cell', () => {
    const out = applyOptimistic(SAMPLE_CALENDAR.rows, 'due', { r1: '2026-05-22' })
    // r1 moved to the 22nd…
    expect(out.find((r) => r.id === 'r1')?.due).toBe('2026-05-22')
    // …others pass through by reference (untouched).
    expect(out[1]).toBe(SAMPLE_CALENDAR.rows[1])
    expect(out[2]).toBe(SAMPLE_CALENDAR.rows[2])
  })

  it('applyOptimistic with an empty overlay returns the same array', () => {
    const out = applyOptimistic(SAMPLE_CALENDAR.rows, 'due', {})
    expect(out).toBe(SAMPLE_CALENDAR.rows)
  })

  it('currentDayKey matches groupRowsByDay placement (DateWidget + string)', () => {
    // Assert consistency with the grid's own bucketing rather than an
    // absolute day, so the test is timezone-independent: whatever local
    // day r2/r3 bucket into is the key currentDayKey must return.
    const byDay = groupRowsByDay(SAMPLE_CALENDAR.rows, 'due')
    const keyOf = (rowId: string): string | undefined => {
      for (const [key, rows] of byDay) {
        if (rows.some((r) => r.id === rowId)) return key
      }
      return undefined
    }
    expect(currentDayKey(SAMPLE_CALENDAR.rows, 'due', 'r2')).toBe(keyOf('r2'))
    expect(currentDayKey(SAMPLE_CALENDAR.rows, 'due', 'r3')).toBe(keyOf('r3'))
  })

  it('currentDayKey returns null for an unknown row', () => {
    expect(currentDayKey(SAMPLE_CALENDAR.rows, 'due', 'nope')).toBeNull()
  })
})

// ── Rendered HTML (DOM-shaped via SSR) ────────────────────────────────

const NOW = new Date(2026, 4, 28) // 2026-05-28 Thu

function calendarHtml(opts: {
  rows: CalendarWidget['rows']
  rowAction?: CalendarWidget['rowAction']
  onAction?: (id: string, params?: Record<string, unknown>) => void
  initialView?: CalendarWidget['initialView']
  emptyMessage?: string
}): string {
  return renderToStaticMarkup(createElement(Calendar, {
    rows: opts.rows,
    columns: SAMPLE_CALENDAR.columns,
    dateColumnId: SAMPLE_CALENDAR.dateColumnId,
    rowAction: opts.rowAction,
    onAction: opts.onAction,
    initialView: opts.initialView,
    emptyMessage: opts.emptyMessage,
    now: NOW,
  }))
}

describe('[COMP:views/calendar] month grid rendering', () => {
  it('renders 35 day cells for May 2026 (5-row month)', () => {
    const html = calendarHtml({ rows: SAMPLE_CALENDAR.rows })
    // Count data-calendar-day occurrences.
    const matches = html.match(/data-calendar-day=/g) ?? []
    expect(matches).toHaveLength(35)
  })

  it('highlights today with bg-[var(--accent)]/30', () => {
    const html = calendarHtml({ rows: SAMPLE_CALENDAR.rows })
    expect(html).toMatch(/data-calendar-today="true"/)
    expect(html).toMatch(/bg-\[var\(--accent\)\]\/30/)
  })

  it('places row chips on the day they belong to (15 May → 2 chips)', () => {
    const html = calendarHtml({
      rows: SAMPLE_CALENDAR.rows,
      rowAction: { id: 'open-row' },
      onAction: () => undefined,
    })
    // The cell for 2026-05-15 should carry two chip buttons.
    const cellRe = /<div[^>]*data-calendar-day="2026-05-15"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*data-calendar-day="2026-05-16"/
    const match = cellRe.exec(html)
    expect(match).not.toBeNull()
    const fragment = match![1]
    const chips = fragment.match(/data-calendar-chip=/g) ?? []
    expect(chips.length).toBeGreaterThanOrEqual(2)
  })

  it('renders +N more when a day overflows the chip budget', () => {
    const heavy: CalendarWidget['rows'] = [
      { id: 'a', title: 'A', due: '2026-05-15' },
      { id: 'b', title: 'B', due: '2026-05-15' },
      { id: 'c', title: 'C', due: '2026-05-15' },
      { id: 'd', title: 'D', due: '2026-05-15' },
      { id: 'e', title: 'E', due: '2026-05-15' },
    ]
    const html = calendarHtml({ rows: heavy })
    expect(html).toMatch(/\+2 more/)
    expect(html).toMatch(/data-calendar-overflow/)
  })

  it('renders the empty-state when no row lands in the visible range', () => {
    const offRange: CalendarWidget['rows'] = [
      { id: 'x', title: 'Old', due: '2025-01-01' },
    ]
    const html = calendarHtml({ rows: offRange, emptyMessage: 'Nothing here.' })
    expect(html).toMatch(/Nothing here\./)
  })
})

// ── Click action handlers ─────────────────────────────────────────────

describe('[COMP:views/calendar] click handlers', () => {
  /**
   * The pure-rendering helper `renderCalendar` lets us assert React-tree
   * click handlers without spinning up a reconciler — same pattern the
   * Timeline test suite uses for its stateless `renderTimeline`.
   */
  function renderPure(props: {
    rowAction?: CalendarWidget['rowAction']
    onAction?: (id: string, params?: Record<string, unknown>) => void
    rows?: CalendarWidget['rows']
  }): ReactElement {
    return renderCalendar({
      rows: props.rows ?? SAMPLE_CALENDAR.rows,
      columns: SAMPLE_CALENDAR.columns,
      dateColumnId: SAMPLE_CALENDAR.dateColumnId,
      rowAction: props.rowAction,
      onAction: props.onAction,
      today: NOW,
      view: 'month',
      cursor: startOfDay(NOW),
      onNavigate: () => undefined,
      onToday: () => undefined,
      onSwitchView: () => undefined,
    })
  }

  it('clicking a day cell calls onAction with date-clicked + iso date', () => {
    const onAction = vi.fn()
    const el = renderPure({ onAction })
    const handler = findDayClickHandler(el, '2026-05-15')
    expect(handler).toBeTypeOf('function')
    handler!({} as unknown as React.MouseEvent)
    expect(onAction).toHaveBeenCalledWith('date-clicked', { date: '2026-05-15' })
  })

  it('clicking a row chip calls onAction(rowAction.id, { rowId })', () => {
    const onAction = vi.fn()
    const el = renderPure({
      rowAction: { id: 'open-row', params: { src: 'calendar' } },
      onAction,
    })
    const chipHandler = findChipClickHandler(el, 'r1')
    expect(chipHandler).toBeTypeOf('function')
    const stopProp = vi.fn()
    chipHandler!({ stopPropagation: stopProp } as unknown as React.MouseEvent)
    expect(onAction).toHaveBeenCalledWith('open-row', { src: 'calendar', rowId: 'r1' })
    expect(stopProp).toHaveBeenCalled()
  })

  it('row chip click does nothing when no rowAction wired', () => {
    const onAction = vi.fn()
    const el = renderPure({ onAction })
    const chipHandler = findChipClickHandler(el, 'r1')
    if (chipHandler) {
      const stop = vi.fn()
      chipHandler({ stopPropagation: stop } as unknown as React.MouseEvent)
    }
    // Day-clicked may still fire (the chip button is nested in a day cell),
    // but the rowAction id should never trigger when unwired.
    const rowCalls = onAction.mock.calls.filter((c) => c[0] === 'open-row')
    expect(rowCalls).toHaveLength(0)
  })
})

// ── Drag-to-reschedule (action emission) ─────────────────────────────

describe('[COMP:views/calendar] drag-to-reschedule', () => {
  /** Pure render with an `onReschedule` wired so chips are draggable. */
  function renderDraggable(onReschedule: (rowId: string, iso: string) => void): ReactElement {
    return renderCalendar({
      rows: SAMPLE_CALENDAR.rows,
      columns: SAMPLE_CALENDAR.columns,
      dateColumnId: SAMPLE_CALENDAR.dateColumnId,
      today: NOW,
      view: 'month',
      cursor: startOfDay(NOW),
      onNavigate: () => undefined,
      onToday: () => undefined,
      onSwitchView: () => undefined,
      onReschedule,
    })
  }

  /** Build a fake DragEvent whose dataTransfer returns `rowId`. */
  function dropEventFor(rowId: string): React.DragEvent {
    return {
      preventDefault: () => undefined,
      dataTransfer: {
        getData: (type: string) => (type === 'text/x-calendar-row' ? rowId : ''),
      },
    } as unknown as React.DragEvent
  }

  it('dropping a chip on a different day fires onReschedule(rowId, newIso)', () => {
    const onReschedule = vi.fn()
    const el = renderDraggable(onReschedule)
    // r1 is on 2026-05-15; drop it on the 2026-05-22 cell.
    const drop = findDropHandler(el, '2026-05-22')
    expect(drop).toBeTypeOf('function')
    drop!(dropEventFor('r1'))
    expect(onReschedule).toHaveBeenCalledWith('r1', '2026-05-22')
  })

  it('dropping a chip on its own current day is a no-op', () => {
    const onReschedule = vi.fn()
    const el = renderDraggable(onReschedule)
    // Resolve r1's actual current day key (timezone-independent) and
    // drop it back there — must not fire a reschedule.
    const ownDay = currentDayKey(SAMPLE_CALENDAR.rows, 'due', 'r1')
    expect(ownDay).toBeTypeOf('string')
    const drop = findDropHandler(el, ownDay!)
    expect(drop).toBeTypeOf('function')
    drop!(dropEventFor('r1'))
    expect(onReschedule).not.toHaveBeenCalled()
  })

  it('rescheduleAction builds the onAction payload with the date field', () => {
    // The stateful Calendar wires onReschedule → onAction('reschedule',
    // rescheduleAction(dateColumnId, rowId, iso)). Assert that glue
    // shape directly (the component uses hooks, so it can't be invoked
    // outside a reconciler — but the payload builder is pure).
    expect(rescheduleAction('due', 'r1', '2026-05-22')).toEqual({
      rowId: 'r1',
      date: '2026-05-22',
      dateField: 'due',
    })
  })

  it('the stateful Calendar renders draggable chips (SSR smoke)', () => {
    // The component always wires onReschedule, so its chips carry
    // draggable=true. renderToStaticMarkup runs the hooks.
    const html = renderToStaticMarkup(createElement(Calendar, {
      rows: SAMPLE_CALENDAR.rows,
      columns: SAMPLE_CALENDAR.columns,
      dateColumnId: SAMPLE_CALENDAR.dateColumnId,
      onAction: () => undefined,
      now: NOW,
    }))
    expect(html).toMatch(/draggable="true"/)
    expect(html).toMatch(/data-calendar-chip=/)
  })
})

// ── Navigation arrows ─────────────────────────────────────────────────

describe('[COMP:views/calendar] navigation', () => {
  it('renders ◀ / ▶ navigation arrows + Today button', () => {
    const html = calendarHtml({ rows: SAMPLE_CALENDAR.rows })
    expect(html).toMatch(/aria-label="Previous"/)
    expect(html).toMatch(/aria-label="Next"/)
    expect(html).toMatch(/Today/)
  })

  it('renders Month + Week + Day tabs', () => {
    const html = calendarHtml({ rows: SAMPLE_CALENDAR.rows })
    expect(html).toMatch(/>Month</)
    expect(html).toMatch(/>Week</)
    expect(html).toMatch(/>Day</)
    expect(html).toMatch(/data-calendar-tab="day"/)
  })

  it('week view renders exactly 7 cells', () => {
    const html = calendarHtml({
      rows: SAMPLE_CALENDAR.rows,
      initialView: 'week',
    })
    const matches = html.match(/data-calendar-day=/g) ?? []
    expect(matches).toHaveLength(7)
  })

  it('day view renders exactly 1 cell and no weekday header', () => {
    const html = renderToStaticMarkup(createElement(Calendar, {
      rows: SAMPLE_CALENDAR.rows,
      columns: SAMPLE_CALENDAR.columns,
      dateColumnId: SAMPLE_CALENDAR.dateColumnId,
      now: NOW,
    }))
    // The component seeds month/week only; reach day view by rendering a
    // pure single-day grid through `renderCalendar` instead.
    const dayEl = renderCalendar({
      rows: SAMPLE_CALENDAR.rows,
      columns: SAMPLE_CALENDAR.columns,
      dateColumnId: SAMPLE_CALENDAR.dateColumnId,
      today: NOW,
      view: 'day',
      cursor: new Date(2026, 4, 15),
      onNavigate: () => undefined,
      onToday: () => undefined,
      onSwitchView: () => undefined,
    })
    const dayHtml = renderToStaticMarkup(dayEl)
    const cells = dayHtml.match(/data-calendar-day=/g) ?? []
    expect(cells).toHaveLength(1)
    expect(dayHtml).toMatch(/data-calendar-day="2026-05-15"/)
    expect(dayHtml).toMatch(/data-calendar-grid="day"/)
    // Month grid renders a 7-col weekday strip; day view drops it.
    expect(html).toMatch(/grid-cols-7/)
    expect(dayHtml).toMatch(/grid-cols-1/)
  })

  it('header label shows the cursor month in long form', () => {
    const html = calendarHtml({ rows: SAMPLE_CALENDAR.rows })
    // Intl long-month formatter for May 2026 — exact label varies per
    // locale but always contains "2026". The header label lives inside
    // a `data-calendar-label` div.
    expect(html).toMatch(/data-calendar-label/)
    expect(html).toMatch(/2026/)
  })
})

// ── React-tree walkers (used by click-handler tests) ─────────────────

type AnyEl = ReactElement | string | number | boolean | null | undefined | AnyEl[]

/**
 * React tree walker that finds the onClick handler attached to a
 * descendant matching `predicate`. Descends into function-type
 * sub-components by invoking them with their own props — safe here
 * because `CalendarDayCell` / chip helpers are stateless (no hooks).
 */
function findClickHandler(
  el: AnyEl,
  predicate: (props: Record<string, unknown>) => boolean,
): ((e: React.MouseEvent) => void) | null {
  if (!el || typeof el !== 'object') return null
  if (Array.isArray(el)) {
    for (const child of el) {
      const found = findClickHandler(child, predicate)
      if (found) return found
    }
    return null
  }
  const node = el as ReactElement & { type: unknown; props: Record<string, unknown> }
  const props = node.props
  // Function-type sub-components: invoke to descend.
  if (typeof node.type === 'function') {
    try {
      const rendered = (node.type as (p: Record<string, unknown>) => AnyEl)(props)
      const found = findClickHandler(rendered, predicate)
      if (found) return found
    } catch {
      // Sub-component threw — skip (e.g. a hook-using component we
      // can't drive without a reconciler).
    }
  }
  if (props && predicate(props)) {
    const onClick = props['onClick']
    if (typeof onClick === 'function') {
      return onClick as (e: React.MouseEvent) => void
    }
  }
  const children = props?.['children']
  if (children !== undefined) {
    return findClickHandler(children as AnyEl, predicate)
  }
  return null
}

function findDayClickHandler(
  el: AnyEl,
  isoKey: string,
): ((e: React.MouseEvent) => void) | null {
  return findClickHandler(el, (p) => p['data-calendar-day'] === isoKey)
}

function findChipClickHandler(
  el: AnyEl,
  rowId: string,
): ((e: React.MouseEvent) => void) | null {
  return findClickHandler(el, (p) => p['data-calendar-chip'] === rowId)
}

/**
 * Sibling of `findClickHandler` that pulls an arbitrary handler prop
 * (e.g. `onDrop`) off the first descendant matching `predicate`.
 * Descends into stateless function sub-components the same way.
 */
function findPropHandler<T>(
  el: AnyEl,
  predicate: (props: Record<string, unknown>) => boolean,
  prop: string,
): ((e: T) => void) | null {
  if (!el || typeof el !== 'object') return null
  if (Array.isArray(el)) {
    for (const child of el) {
      const found = findPropHandler<T>(child, predicate, prop)
      if (found) return found
    }
    return null
  }
  const node = el as ReactElement & { type: unknown; props: Record<string, unknown> }
  const props = node.props
  if (typeof node.type === 'function') {
    try {
      const rendered = (node.type as (p: Record<string, unknown>) => AnyEl)(props)
      const found = findPropHandler<T>(rendered, predicate, prop)
      if (found) return found
    } catch {
      // hook-using component we can't drive without a reconciler — skip.
    }
  }
  if (props && predicate(props)) {
    const handler = props[prop]
    if (typeof handler === 'function') return handler as (e: T) => void
  }
  const children = props?.['children']
  if (children !== undefined) {
    return findPropHandler<T>(children as AnyEl, predicate, prop)
  }
  return null
}

function findDropHandler(
  el: AnyEl,
  isoKey: string,
): ((e: React.DragEvent) => void) | null {
  return findPropHandler<React.DragEvent>(
    el,
    (p) => p['data-calendar-day'] === isoKey,
    'onDrop',
  )
}
