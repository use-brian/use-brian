/** [COMP:views/chart-line] Actual SSR renderer data, identity and library-label boundary. */
import { createRequire } from 'node:module'
import { createElement, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { a2uiWidgetSchema } from '@use-brian/core/dist/views/a2ui.js'
import { ChartLine } from '../widgets/ChartLine.js'
import type { LineChartWidget } from '../types.js'

type Row = Record<string, unknown>
type RecordedProps = Record<string, unknown> & { children?: ReactNode }
type LineProps = RecordedProps & { dataKey: string; name?: string; stroke: string }
const recorded = vi.hoisted(() => ({
  charts: [] as RecordedProps[], lines: [] as LineProps[],
  xAxes: [] as RecordedProps[], legends: [] as RecordedProps[], tooltips: [] as RecordedProps[],
}))

// Only the third-party render boundary is replaced. React hooks, ChartLine and
// its private flattening/admission implementation are actual modules.
vi.mock('recharts', async () => {
  const { createElement } = await import('react')
  const wrap = ({ children }: RecordedProps) => createElement('div', null, children)
  return {
    ResponsiveContainer: wrap,
    LineChart: (props: RecordedProps) => { recorded.charts.push(props); return wrap(props) },
    Line: (props: LineProps) => { recorded.lines.push(props); return null },
    XAxis: (props: RecordedProps) => { recorded.xAxes.push(props); return null },
    Legend: (props: RecordedProps) => { recorded.legends.push(props); return null },
    Tooltip: (props: RecordedProps) => { recorded.tooltips.push(props); return null },
    YAxis: () => null,
    CartesianGrid: () => null,
  }
})

// Use installed Recharts' real payload normalization and default label renderers.
// In particular its name || dataKey fallback must not expose internal keys for ''.
// require accesses the actual CJS library, not Vitest's mocked ESM render entry.
const require = createRequire(import.meta.url)
const actual = require('recharts') as {
  Line: ComponentType<Record<string, unknown>>
  Legend: ComponentType<Record<string, unknown>>
}
const { getTooltipItem } = require('recharts/lib/util/ChartUtils.js') as {
  getTooltipItem: (item: ReactElement, row: Row) => Record<string, unknown>
}
const { getLegendProps } = require('recharts/lib/util/getLegendProps.js') as {
  getLegendProps: (options: Record<string, unknown>) => Record<string, unknown>
}
const { DefaultLegendContent } = require('recharts/lib/component/DefaultLegendContent.js') as {
  DefaultLegendContent: ComponentType<Record<string, unknown>>
}
const { DefaultTooltipContent } = require('recharts/lib/component/DefaultTooltipContent.js') as {
  DefaultTooltipContent: ComponentType<Record<string, unknown>>
}

function renderChart(series: LineChartWidget['series']) {
  recorded.charts.length = recorded.lines.length = recorded.xAxes.length = 0
  recorded.legends.length = recorded.tooltips.length = 0
  const widget: LineChartWidget = { type: 'chart_line', series }
  expect(a2uiWidgetSchema.safeParse(widget).success).toBe(true)
  renderToStaticMarkup(createElement(ChartLine, { widget }))
  expect(recorded.charts).toHaveLength(1)
  expect(recorded.xAxes).toHaveLength(1)
  expect(recorded.xAxes[0]!.dataKey).toBe('x')
  expect(recorded.tooltips).toHaveLength(1)
  const data = recorded.charts[0]!.data as Row[]
  const lines = [...recorded.lines]
  return { data, lines, legends: [...recorded.legends], tooltip: recorded.tooltips[0]! }
}

function renderedLabels(chart: ReturnType<typeof renderChart>) {
  const items = chart.lines.map((line) => createElement(actual.Line, line))
  const tooltipHtml = renderToStaticMarkup(createElement(DefaultTooltipContent, {
    ...chart.tooltip,
    payload: items.map((item) => getTooltipItem(item, chart.data[0]!)),
  }))
  let legendHtml = ''
  if (chart.legends[0]) {
    const legend = createElement(actual.Legend, chart.legends[0])
    const props = getLegendProps({ children: [legend, ...items],
      formattedGraphicalItems: items.map((item) => ({ item })), legendWidth: 600 })
    legendHtml = renderToStaticMarkup(createElement(DefaultLegendContent, props))
  }
  return {
    tooltip: [...tooltipHtml.matchAll(/class="recharts-tooltip-item-name">([^<]*)<\/span>/g)].map((match) => match[1]),
    legend: [...legendHtml.matchAll(/class="recharts-legend-item-text"[^>]*>([^<]*)<\/span>/g)].map((match) => match[1]),
  }
}

const palette = ['var(--chart-1, #6366f1)', 'var(--chart-2, #10b981)', 'var(--chart-3, #06b6d4)']

describe('[COMP:views/chart-line] independent series identity', () => {
  it.each([
    { label: 'x-axis field name', names: ['x'] },
    { label: 'duplicate display names', names: ['Repeated', 'Repeated'] },
    { label: 'repeated empty display names', names: ['', ''] },
    { label: 'prototype-like display names', names: ['__proto__', 'constructor', 'toString'] },
    { label: 'path-like display names', names: ['metric.value', 'metric[0]'] },
  ])('preserves independent values and library labels for $label', ({ names }) => {
    const chart = renderChart(names.map((name, index) => ({ name, points: [
      { x: 'Category A', y: index + 1 }, { x: 'Category B', y: (index + 1) * 10 },
    ] })))
    // Inspect the actual rows and keys received by Recharts, not a copied flattener.
    expect({
      categories: chart.data.map((row) => row.x),
      values: chart.lines.map((line) => chart.data.map((row) => row[line.dataKey])),
    }).toEqual({ categories: ['Category A', 'Category B'],
      values: names.map((_, index) => [index + 1, (index + 1) * 10]) })
    const keys = chart.lines.map((line) => line.dataKey)
    expect(chart.lines).toHaveLength(names.length)
    expect(new Set(keys).size).toBe(names.length)
    expect(keys).not.toContain('x')
    for (const key of keys) expect(names).not.toContain(key)
    expect(chart.lines.map((line) => line.stroke)).toEqual(palette.slice(0, names.length))
    expect(renderedLabels(chart)).toEqual({ tooltip: names, legend: names.length > 1 ? names : [] })
  })

  it('preserves first-occurrence categories, sparse values and numeric/string coercion', () => {
    const chart = renderChart([
      { name: 'First', points: [{ x: 'b', y: 1 }, { x: 1, y: 2 }, { x: 'b', y: 3 }] },
      { name: 'Second', points: [{ x: 'a', y: 4 }, { x: '1', y: 5 }, { x: 'c', y: 6 }] },
    ])
    expect(chart.data.map((row) => row.x)).toEqual(['b', 1, 'a', 'c'])
    expect(chart.lines.map((line) => chart.data.map((row) => row[line.dataKey])))
      .toEqual([[3, 2, undefined, undefined], [undefined, 5, 4, 6]])
    expect(chart.lines.map((line) => line.stroke)).toEqual(palette.slice(0, 2))
    expect(chart.legends).toHaveLength(1)
  })

  it('retains empty charts and empty per-entry point sets without inventing values', () => {
    const empty = renderChart([])
    expect(empty.data).toEqual([])
    expect(empty.lines).toEqual([])
    expect(empty.legends).toEqual([])
    const noPoints = renderChart([{ name: 'First', points: [] }, { name: 'Second', points: [] }])
    expect(noPoints.data).toEqual([])
    expect(noPoints.lines).toHaveLength(2)
    expect(noPoints.legends).toHaveLength(1)
    const single = renderChart([{ name: 'Only', points: [{ x: 'day', y: 4 }] }])
    expect(single.legends).toEqual([])
    expect(renderedLabels(single)).toEqual({ tooltip: ['Only'], legend: [] })
  })

  it('maps labels by actual series entry when display names resemble generated keys', () => {
    const probe = renderChart([
      { name: 'First', points: [{ x: 'day', y: 1 }] },
      { name: 'Second', points: [{ x: 'day', y: 2 }] },
    ])
    const names = [probe.lines[1]!.dataKey, probe.lines[0]!.dataKey]
    const chart = renderChart(names.map((name, index) => ({ name, points: [{ x: 'day', y: index + 1 }] })))
    expect(renderedLabels(chart)).toEqual({ tooltip: names, legend: names })
    expect(chart.lines.map((line) => chart.data[0]![line.dataKey])).toEqual([1, 2])
  })
})
