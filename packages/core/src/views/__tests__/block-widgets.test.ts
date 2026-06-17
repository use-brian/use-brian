/**
 * [COMP:views/block-widgets] Static visual-block → A2UI widget mappers.
 *
 * Pure projections — a chart's inline `data` and a diagram's Mermaid `code`
 * become their A2UI widget with no store call. The collab-editor copy at
 * `apps/app-web/.../block-visual.ts` is asserted separately under
 * `[COMP:app-web/block-visual]`; these two must agree.
 */

import { describe, expect, it } from 'vitest'
import {
  chartDataIsRenderable,
  chartWidgetFromData,
  diagramWidgetFromBlock,
} from '../block-widgets.js'
import type { ChartData } from '../blocks.js'

describe('[COMP:views/block-widgets] chartWidgetFromData', () => {
  it('maps bar data → chart_bar (carrying tone + orientation)', () => {
    const data: ChartData = {
      points: [
        { label: 'A', value: 3 },
        { label: 'B', value: 5 },
      ],
      tone: 'success',
      orientation: 'horizontal',
    }
    expect(chartWidgetFromData('bar', data, 'Counts')).toEqual({
      type: 'chart_bar',
      title: 'Counts',
      data: [
        { label: 'A', value: 3 },
        { label: 'B', value: 5 },
      ],
      orientation: 'horizontal',
      tone: 'success',
    })
  })

  it('maps pie data → chart_pie (keeping optional slice colour)', () => {
    expect(
      chartWidgetFromData('pie', { points: [{ label: 'A', value: 1, color: '#f00' }] }),
    ).toEqual({
      type: 'chart_pie',
      slices: [{ label: 'A', value: 1, color: '#f00' }],
    })
  })

  it('maps line data → chart_line', () => {
    const data: ChartData = {
      series: [{ name: 'rev', points: [{ x: 'Q1', y: 2 }, { x: 'Q2', y: 4 }] }],
    }
    expect(chartWidgetFromData('line', data, 'Trend')).toEqual({
      type: 'chart_line',
      title: 'Trend',
      series: [{ name: 'rev', points: [{ x: 'Q1', y: 2 }, { x: 'Q2', y: 4 }] }],
    })
  })

  it('maps kpi data → kpi (with delta + currency format)', () => {
    expect(
      chartWidgetFromData('kpi', { value: 42, delta: -3, format: 'currency', currency: 'USD' }, 'MRR'),
    ).toEqual({ type: 'kpi', label: 'MRR', value: 42, delta: -3, format: 'currency', currency: 'USD' })
  })

  it('tolerates missing points — an empty chart, never a throw', () => {
    expect(chartWidgetFromData('bar', {})).toEqual({ type: 'chart_bar', data: [] })
  })
})

describe('[COMP:views/block-widgets] diagramWidgetFromBlock', () => {
  it('passes mermaid code through to a diagram widget', () => {
    expect(
      diagramWidgetFromBlock({ syntax: 'mermaid', code: 'graph TD; A-->B', title: 'Flow' }),
    ).toEqual({ type: 'diagram', syntax: 'mermaid', code: 'graph TD; A-->B', title: 'Flow' })
  })

  it('omits title when absent', () => {
    expect(diagramWidgetFromBlock({ syntax: 'mermaid', code: 'graph TD; A-->B' })).toEqual({
      type: 'diagram',
      syntax: 'mermaid',
      code: 'graph TD; A-->B',
    })
  })
})

describe('[COMP:views/block-widgets] chartDataIsRenderable', () => {
  // Must match the app-web copy in `block-visual.ts` (asserted under
  // [COMP:app-web/block-visual]) — the placeholder gate for both render paths.
  it('bar/pie need ≥1 point; absent or empty → false', () => {
    expect(chartDataIsRenderable('bar', { points: [{ label: 'A', value: 1 }] })).toBe(true)
    expect(chartDataIsRenderable('bar', { points: [] })).toBe(false)
    expect(chartDataIsRenderable('pie', {})).toBe(false)
    expect(chartDataIsRenderable('pie', undefined)).toBe(false)
  })

  it('line needs ≥1 series carrying ≥1 point', () => {
    expect(
      chartDataIsRenderable('line', { series: [{ name: 'r', points: [{ x: 'Q1', y: 2 }] }] }),
    ).toBe(true)
    expect(chartDataIsRenderable('line', { series: [{ name: 'r', points: [] }] })).toBe(false)
    expect(chartDataIsRenderable('line', { series: [] })).toBe(false)
  })

  it('kpi needs a value — 0 counts, null/undefined does not', () => {
    expect(chartDataIsRenderable('kpi', { value: 0 })).toBe(true)
    expect(chartDataIsRenderable('kpi', { value: undefined })).toBe(false)
    expect(chartDataIsRenderable('kpi', {})).toBe(false)
  })
})
