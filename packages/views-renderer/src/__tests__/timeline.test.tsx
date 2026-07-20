/**
 * [COMP:views/timeline] Timeline widget — dispatch + bar positioning.
 *
 * No DOM environment yet — we inspect React element trees and exercise
 * the pure-math helpers directly. Bar math is tested via the exported
 * `getBarPlacement` / `defaultRange` / `buildAxisTicks` helpers so we
 * don't need a layout engine.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { renderWidget } from '../render.js'
import {
  ZOOM_PX_PER_DAY,
  applyTimelineOptimistic,
  buildAxisTicks,
  defaultRange,
  getBarPlacement,
  pxDeltaToDays,
  renderTimeline,
  rowIdSignature,
  shiftRange,
} from '../widgets/Timeline.js'
import type { TimelineWidget } from '@use-brian/core'

function elementType(el: ReactElement): string {
  const t = el.type
  if (typeof t === 'string') return t
  if (typeof t === 'function') return (t as { name?: string }).name ?? 'anonymous'
  return String(t)
}

const FIXED_TODAY = new Date(2026, 4, 15) // 2026-05-15
const FIXED_RANGE = { start: new Date(2026, 4, 1), end: new Date(2026, 4, 28) }

function renderTimelineFor(
  widget: TimelineWidget,
  zoom: 'day' | 'week' | 'month' | 'quarter' = 'week',
  onAction?: (id: string, params?: Record<string, unknown>) => void,
  onReschedule?: (rowId: string, next: { start: string; end: string }) => void,
): ReactElement {
  return renderTimeline({
    rows: widget.rows,
    columns: widget.columns,
    startColumnId: widget.startColumnId,
    endColumnId: widget.endColumnId,
    rowAction: widget.rowAction,
    onAction,
    emptyMessage: widget.emptyMessage,
    zoom,
    onZoom: () => undefined,
    range: zoom === 'week' ? FIXED_RANGE : defaultRange(FIXED_TODAY, zoom),
    onReschedule,
  })
}

const SAMPLE_TIMELINE: TimelineWidget = {
  type: 'timeline',
  startColumnId: 'start',
  endColumnId: 'end',
  columns: [
    { field: 'name', header: 'Project', kind: 'text' },
    { field: 'start', header: 'Start', kind: 'date' },
    { field: 'end', header: 'End', kind: 'date' },
  ],
  rows: [
    {
      id: 'p1',
      name: 'Apollo',
      start: { type: 'date', iso: '2026-05-10T00:00:00.000Z' },
      end: { type: 'date', iso: '2026-05-16T00:00:00.000Z' },
    },
    {
      id: 'p2',
      name: 'Beacon',
      start: { type: 'date', iso: '2026-05-18T00:00:00.000Z' },
      end: { type: 'date', iso: '2026-05-22T00:00:00.000Z' },
    },
  ],
  rowAction: { id: 'open-row' },
}

describe('[COMP:views/timeline] Timeline dispatch', () => {
  it('dispatches Timeline for type=timeline', () => {
    const el = renderWidget(SAMPLE_TIMELINE)
    expect(elementType(el)).toBe('Timeline')
  })

  it('forwards rows / columns / start+end / rowAction / onAction', () => {
    const onAction = () => undefined
    const el = renderWidget(SAMPLE_TIMELINE, onAction)
    const props = el.props as {
      rows: typeof SAMPLE_TIMELINE.rows
      columns: typeof SAMPLE_TIMELINE.columns
      startColumnId: string
      endColumnId: string
      rowAction?: typeof SAMPLE_TIMELINE.rowAction
      onAction?: typeof onAction
    }
    expect(props.rows).toEqual(SAMPLE_TIMELINE.rows)
    expect(props.columns).toEqual(SAMPLE_TIMELINE.columns)
    expect(props.startColumnId).toBe('start')
    expect(props.endColumnId).toBe('end')
    expect(props.rowAction).toEqual(SAMPLE_TIMELINE.rowAction)
    expect(props.onAction).toBe(onAction)
  })

  it('renders an empty-state surface when rows is empty', () => {
    const empty: TimelineWidget = {
      ...SAMPLE_TIMELINE,
      rows: [],
      emptyMessage: 'Nothing scheduled.',
    }
    const el = renderTimelineFor(empty)
    // Empty-state path is a div with the message text.
    expect(elementType(el)).toBe('div')
    const text = JSON.stringify(el.props)
    expect(text).toContain('Nothing scheduled.')
  })
})

describe('[COMP:views/timeline] Bar placement math', () => {
  const rangeStart = new Date(2026, 4, 1) // 2026-05-01
  const rangeEnd = new Date(2026, 4, 28) // 2026-05-28 (28-day window)

  it('places a bar starting on rangeStart at left=0', () => {
    const placement = getBarPlacement({
      startIso: '2026-05-01T00:00:00.000Z',
      endIso: '2026-05-03T00:00:00.000Z',
      rangeStart,
      rangeEnd,
      pxPerDay: 16,
    })
    expect(placement.visible).toBe(true)
    expect(placement.leftPx).toBe(0)
    // 3-day span @ 16px/day = 48px
    expect(placement.widthPx).toBe(48)
  })

  it('places a bar starting 5 days into the range at left = 5 * pxPerDay', () => {
    const placement = getBarPlacement({
      startIso: '2026-05-06T00:00:00.000Z',
      endIso: '2026-05-08T00:00:00.000Z',
      rangeStart,
      rangeEnd,
      pxPerDay: 16,
    })
    expect(placement.visible).toBe(true)
    expect(placement.leftPx).toBe(80) // 5 * 16
    expect(placement.widthPx).toBe(48) // 3-day span
  })

  it('uses a minimum width of pxPerDay even for same-day ranges', () => {
    const placement = getBarPlacement({
      startIso: '2026-05-10T00:00:00.000Z',
      endIso: '2026-05-10T00:00:00.000Z',
      rangeStart,
      rangeEnd,
      pxPerDay: 16,
    })
    expect(placement.visible).toBe(true)
    expect(placement.widthPx).toBeGreaterThanOrEqual(16)
  })

  it('clips a bar that starts before the range', () => {
    const placement = getBarPlacement({
      startIso: '2026-04-25T00:00:00.000Z', // 6 days before range start
      endIso: '2026-05-05T00:00:00.000Z',
      rangeStart,
      rangeEnd,
      pxPerDay: 16,
    })
    expect(placement.visible).toBe(true)
    expect(placement.leftPx).toBe(0) // clipped to range start
  })

  it('returns visible:false for null start/end ISOs', () => {
    expect(
      getBarPlacement({
        startIso: null,
        endIso: '2026-05-10',
        rangeStart,
        rangeEnd,
        pxPerDay: 16,
      }).visible,
    ).toBe(false)
    expect(
      getBarPlacement({
        startIso: '2026-05-10',
        endIso: null,
        rangeStart,
        rangeEnd,
        pxPerDay: 16,
      }).visible,
    ).toBe(false)
  })

  it('returns visible:false for bars entirely outside the range', () => {
    const past = getBarPlacement({
      startIso: '2025-12-01T00:00:00.000Z',
      endIso: '2025-12-31T00:00:00.000Z',
      rangeStart,
      rangeEnd,
      pxPerDay: 16,
    })
    expect(past.visible).toBe(false)

    const future = getBarPlacement({
      startIso: '2027-01-01T00:00:00.000Z',
      endIso: '2027-01-15T00:00:00.000Z',
      rangeStart,
      rangeEnd,
      pxPerDay: 16,
    })
    expect(future.visible).toBe(false)
  })

  it('respects zoom-level pxPerDay constant', () => {
    expect(ZOOM_PX_PER_DAY.day).toBeGreaterThan(ZOOM_PX_PER_DAY.week)
    expect(ZOOM_PX_PER_DAY.week).toBeGreaterThan(ZOOM_PX_PER_DAY.month)
    expect(ZOOM_PX_PER_DAY.month).toBeGreaterThan(ZOOM_PX_PER_DAY.quarter)
  })
})

describe('[COMP:views/timeline] Drag-to-reschedule math', () => {
  it('pxDeltaToDays snaps a px drag to the nearest whole day', () => {
    // week zoom = 16px/day.
    expect(pxDeltaToDays(16, 16)).toBe(1)
    expect(pxDeltaToDays(40, 16)).toBe(3) // round(2.5)
    expect(pxDeltaToDays(20, 16)).toBe(1) // round(1.25)
    expect(pxDeltaToDays(-28, 16)).toBe(-2) // round(-1.75)
    expect(pxDeltaToDays(7, 16)).toBe(0) // sub-half-day → no move
  })

  it('pxDeltaToDays is the inverse of the day*pxPerDay placement math', () => {
    // day zoom = 48px/day; a 3-day drag is 144px → back to 3 days.
    expect(pxDeltaToDays(3 * 48, 48)).toBe(3)
  })

  it('pxDeltaToDays guards a zero/negative pxPerDay', () => {
    expect(pxDeltaToDays(100, 0)).toBe(0)
  })

  it('shiftRange moves both endpoints, preserving duration', () => {
    // 6-day span (10th→16th); shift +4 days → 14th→20th (still 6 days).
    const out = shiftRange('2026-05-10', '2026-05-16', 4)
    expect(out).toEqual({ start: '2026-05-14', end: '2026-05-20' })
  })

  it('shiftRange preserves duration across a month boundary', () => {
    // 28th→31st (3-day span), shift +5 → Jun 2nd→5th.
    const out = shiftRange('2026-05-28', '2026-05-31', 5)
    expect(out).toEqual({ start: '2026-06-02', end: '2026-06-05' })
  })

  it('shiftRange accepts Z-suffixed timestamps and emits local day keys', () => {
    const out = shiftRange(
      '2026-05-10T00:00:00.000Z',
      '2026-05-16T00:00:00.000Z',
      -3,
    )
    // Day-level math; both endpoints shift by the same delta.
    expect(out).not.toBeNull()
    const days = (a: string, b: string): number =>
      Math.round(
        (Date.parse(`${b}T00:00:00`) - Date.parse(`${a}T00:00:00`)) / 86400000,
      )
    expect(days(out!.start, out!.end)).toBe(6) // duration unchanged
  })

  it('shiftRange returns null for null / unparseable endpoints', () => {
    expect(shiftRange(null, '2026-05-16', 1)).toBeNull()
    expect(shiftRange('2026-05-10', null, 1)).toBeNull()
    expect(shiftRange('nonsense', '2026-05-16', 1)).toBeNull()
  })
})

describe('[COMP:views/timeline] Optimistic overlay helpers', () => {
  it('rowIdSignature joins ids in order', () => {
    expect(rowIdSignature(SAMPLE_TIMELINE.rows)).toBe('p1|p2')
  })

  it('applyTimelineOptimistic rewrites only overlaid rows start+end', () => {
    const out = applyTimelineOptimistic(
      SAMPLE_TIMELINE.rows,
      'start',
      'end',
      { p1: { start: '2026-05-20', end: '2026-05-26' } },
    )
    expect(out.find((r) => r.id === 'p1')?.start).toBe('2026-05-20')
    expect(out.find((r) => r.id === 'p1')?.end).toBe('2026-05-26')
    // p2 untouched (same reference).
    expect(out[1]).toBe(SAMPLE_TIMELINE.rows[1])
  })

  it('applyTimelineOptimistic with empty overlay returns the same array', () => {
    const out = applyTimelineOptimistic(SAMPLE_TIMELINE.rows, 'start', 'end', {})
    expect(out).toBe(SAMPLE_TIMELINE.rows)
  })
})

describe('[COMP:views/timeline] Axis ticks per zoom level', () => {
  const start = new Date(2026, 4, 1) // 2026-05-01 (Friday)

  it('emits one tick per day at zoom=day', () => {
    const ticks = buildAxisTicks(start, 7, 'day')
    expect(ticks).toHaveLength(7)
    expect(ticks.every((t) => t.widthDays === 1)).toBe(true)
  })

  it('emits two-letter weekday labels at zoom=week', () => {
    const ticks = buildAxisTicks(start, 7, 'week')
    expect(ticks).toHaveLength(7)
    // 2026-05-01 is Friday → "Fr" in the default locale.
    expect(ticks[0].label.length).toBeLessThanOrEqual(3)
    expect(ticks.every((t) => t.widthDays === 1)).toBe(true)
  })

  it('emits one tick per calendar month at zoom=month', () => {
    // 90-day window spanning May/Jun/Jul should yield 3 monthly ticks.
    const ticks = buildAxisTicks(start, 90, 'month')
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    expect(ticks.length).toBeLessThanOrEqual(4)
    // First tick is May; label contains "May".
    expect(ticks[0].label.toLowerCase()).toContain('may')
  })

  it('emits Q-style labels at zoom=quarter', () => {
    const ticks = buildAxisTicks(start, 365, 'quarter')
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    // Q labels always start with "Q".
    expect(ticks.every((t) => /^Q\d /.test(t.label))).toBe(true)
  })
})

describe('[COMP:views/timeline] Default visible range', () => {
  it('uses 4 weeks centered on today at zoom=week', () => {
    const { start, end } = defaultRange(FIXED_TODAY, 'week')
    const days = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
    expect(days).toBe(27) // 28-day window, inclusive endpoints
  })

  it('uses a 3-month span at zoom=month', () => {
    const { start, end } = defaultRange(FIXED_TODAY, 'month')
    // April + May + June 2026 = 91 days
    const days = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
    expect(days).toBeGreaterThanOrEqual(89)
    expect(days).toBeLessThanOrEqual(92)
  })

  it('uses a 4-quarter span at zoom=quarter', () => {
    const { start, end } = defaultRange(FIXED_TODAY, 'quarter')
    const days = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
    // 4 quarters ≈ 365 days
    expect(days).toBeGreaterThanOrEqual(360)
    expect(days).toBeLessThanOrEqual(370)
  })
})

describe('[COMP:views/timeline] Component rendering', () => {
  it('renders a div container marked with data-a2ui-widget=timeline', () => {
    const el = renderTimelineFor(SAMPLE_TIMELINE)
    expect(elementType(el)).toBe('div')
    // The widget marker is on the outer wrapper.
    expect((el.props as { 'data-a2ui-widget'?: string })['data-a2ui-widget']).toBe('timeline')
  })

  it('cycles bar colors via var(--chart-N) palette across rows', () => {
    // Build a row payload of 7 rows; the palette has 5 entries so the
    // 6th and 7th rows wrap around to chart-1 / chart-2.
    const manyRows: TimelineWidget = {
      ...SAMPLE_TIMELINE,
      rows: Array.from({ length: 7 }, (_, i) => ({
        id: `r${i}`,
        name: `Row ${i}`,
        start: { type: 'date', iso: '2026-05-10T00:00:00.000Z' },
        end: { type: 'date', iso: '2026-05-14T00:00:00.000Z' },
      })),
    }
    const el = renderTimelineFor(manyRows)
    const serialized = JSON.stringify(el)
    // All 5 chart slots should appear at least once across the bars.
    expect(serialized).toContain('--chart-1')
    expect(serialized).toContain('--chart-2')
    expect(serialized).toContain('--chart-3')
    expect(serialized).toContain('--chart-4')
    expect(serialized).toContain('--chart-5')
  })

  it('applies sticky-row CSS classes to row label cells', () => {
    const el = renderTimelineFor(SAMPLE_TIMELINE)
    const serialized = JSON.stringify(el)
    // Sticky left positioning is the load-bearing class.
    expect(serialized).toContain('sticky left-0')
    // Data attribute marks the row-label cell.
    expect(serialized).toContain('data-a2ui-row-label')
  })

  it('renders a button per visible bar that fires onAction with rowId on click', () => {
    const onAction = vi.fn()
    const el = renderTimelineFor(SAMPLE_TIMELINE, 'week', onAction)
    // Walk the tree to find any element with a data-a2ui-bar marker and
    // an onClick handler — react elements expose props directly. Arrays
    // of children are themselves array-typed in the parent's `children`
    // prop, so the walker recurses on arrays too.
    type Node = { type?: unknown; props?: Record<string, unknown> }
    const found: Node[] = []
    function walk(node: unknown): void {
      if (node === null || node === undefined) return
      if (Array.isArray(node)) {
        for (const c of node) walk(c)
        return
      }
      if (typeof node !== 'object') return
      const n = node as Node
      if (n.props) {
        if (typeof n.props['data-a2ui-bar'] !== 'undefined') {
          found.push(n)
        }
        walk(n.props.children)
      }
    }
    walk(el)
    expect(found.length).toBe(2) // two rows with valid date ranges
    // Each bar exposes an onClick that calls onAction.
    const firstBar = found[0]
    if (!firstBar?.props) throw new Error('expected a found bar with props')
    const handler = firstBar.props.onClick as () => void
    handler()
    expect(onAction).toHaveBeenCalledWith('open-row', { rowId: 'p1' })
  })

  it('respects the zoom level when computing the axis', () => {
    const el = renderTimelineFor(SAMPLE_TIMELINE, 'month')
    const serialized = JSON.stringify(el)
    // And tags the axis with the zoom level.
    expect(serialized).toContain('"data-a2ui-axis":"month"')
  })
})

describe('[COMP:views/timeline] Bar drag-to-reschedule', () => {
  type BarNode = { type?: unknown; props?: Record<string, unknown> }

  function findBars(el: ReactElement): BarNode[] {
    const found: BarNode[] = []
    function walk(node: unknown): void {
      if (node === null || node === undefined) return
      if (Array.isArray(node)) {
        for (const c of node) walk(c)
        return
      }
      if (typeof node !== 'object') return
      const n = node as BarNode
      if (n.props) {
        if (typeof n.props['data-a2ui-bar'] !== 'undefined') found.push(n)
        walk(n.props.children)
      }
    }
    walk(el)
    return found
  }

  /**
   * A stub button element capturing the pointermove/pointerup listeners
   * the drag handler registers, so the test can replay a gesture without
   * a DOM. `setPointerCapture` is a no-op; `style` is a plain object.
   */
  function stubBar(): {
    el: HTMLButtonElement
    fire: (type: 'pointermove' | 'pointerup', clientX: number) => void
  } {
    const listeners: Record<string, (ev: PointerEvent) => void> = {}
    const el = {
      style: {} as Record<string, string>,
      setPointerCapture: () => undefined,
      addEventListener: (type: string, fn: (ev: PointerEvent) => void) => {
        listeners[type] = fn
      },
      removeEventListener: (type: string) => {
        delete listeners[type]
      },
    } as unknown as HTMLButtonElement
    return {
      el,
      fire: (type, clientX) => {
        listeners[type]?.({ clientX } as PointerEvent)
      },
    }
  }

  it('dragging a bar right by N days emits reschedule preserving duration', () => {
    const onReschedule = vi.fn()
    // week zoom = 16px/day. Apollo: 2026-05-10 → 2026-05-16 (6-day span).
    const el = renderTimelineFor(SAMPLE_TIMELINE, 'week', undefined, onReschedule)
    const bar = findBars(el)[0]
    expect(bar?.props?.['data-a2ui-bar']).toBe('p1')
    expect(bar?.props?.['data-a2ui-bar-draggable']).toBe('true')

    const { el: stub, fire } = stubBar()
    const onPointerDown = bar!.props!.onPointerDown as (e: unknown) => void
    // pointerdown at x=100, move to x=148 (+48px = +3 days @16px), then up.
    onPointerDown({ currentTarget: stub, clientX: 100, pointerId: 1 })
    fire('pointermove', 148)
    fire('pointerup', 148)

    // Assert against shiftRange's own output (source of truth) so the
    // expectation is timezone-independent — the integration under test
    // is px-drag → pxDeltaToDays(+3) → shiftRange → emit. The renderer
    // unwraps each DateWidget to its .iso before calling shiftRange.
    const startIso = (SAMPLE_TIMELINE.rows[0].start as { iso: string }).iso
    const endIso = (SAMPLE_TIMELINE.rows[0].end as { iso: string }).iso
    const expected = shiftRange(startIso, endIso, 3)
    expect(expected).not.toBeNull()
    expect(onReschedule).toHaveBeenCalledWith('p1', expected)
  })

  it('a sub-threshold drag is treated as a click, not a reschedule', () => {
    const onReschedule = vi.fn()
    const el = renderTimelineFor(SAMPLE_TIMELINE, 'week', undefined, onReschedule)
    const bar = findBars(el)[0]
    const { el: stub, fire } = stubBar()
    const onPointerDown = bar!.props!.onPointerDown as (e: unknown) => void
    onPointerDown({ currentTarget: stub, clientX: 100, pointerId: 1 })
    fire('pointermove', 101) // 1px — under the 3px threshold
    fire('pointerup', 101)
    expect(onReschedule).not.toHaveBeenCalled()
  })

  it('onClickCapture swallows the click that follows a real drag', () => {
    const onReschedule = vi.fn()
    const el = renderTimelineFor(SAMPLE_TIMELINE, 'week', undefined, onReschedule)
    const bar = findBars(el)[0]
    const { el: stub, fire } = stubBar()
    const onPointerDown = bar!.props!.onPointerDown as (e: unknown) => void
    onPointerDown({ currentTarget: stub, clientX: 100, pointerId: 1 })
    fire('pointermove', 200) // big drag
    fire('pointerup', 200)
    // After a drag, the trailing click is suppressed.
    const onClickCapture = bar!.props!.onClickCapture as (e: unknown) => void
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    onClickCapture({ preventDefault, stopPropagation })
    expect(preventDefault).toHaveBeenCalled()
    expect(stopPropagation).toHaveBeenCalled()
  })

  it('bars are not draggable when onReschedule is omitted', () => {
    const el = renderTimelineFor(SAMPLE_TIMELINE, 'week')
    const bar = findBars(el)[0]
    expect(bar?.props?.['data-a2ui-bar-draggable']).toBeUndefined()
    expect(bar?.props?.onPointerDown).toBeUndefined()
  })
})
