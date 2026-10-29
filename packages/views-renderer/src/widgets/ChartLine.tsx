'use client'

import { type JSX, useMemo } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { LineChartWidget } from '../types.js'

const PALETTE = [
  'var(--chart-1, #6366f1)',
  'var(--chart-2, #10b981)',
  'var(--chart-3, #06b6d4)',
  'var(--chart-4, #f59e0b)',
  'var(--chart-5, #ef4444)',
]

type FlatRow = { x: string | number } & Record<string, string | number>

/**
 * A2UI line chart — Recharts wrapper. Each `series` becomes a <Line>;
 * the x-axis is shared (categorical).
 *
 * We collapse the per-series points into a single wide-table dataset
 * (each row = { x, series_0: y1, series_1: y2, … }) because
 * that's the shape Recharts expects for multi-line charts. The union
 * of x values from every series is sorted by first-occurrence to
 * preserve the order the resolver intended.
 *
 * [COMP:views/chart-line]
 */
export function ChartLine(props: { widget: LineChartWidget }): JSX.Element {
  const { widget } = props
  const { data, seriesEntries } = useMemo(() => flattenSeries(widget.series), [widget.series])
  const multiSeries = seriesEntries.length > 1
  const labelForKey = (key: unknown): string => seriesEntries.find((entry) => entry.key === key)?.name ?? ''

  return (
    <figure className="flex w-full flex-col gap-2">
      {widget.title && (
        <h3 className="text-lg font-medium text-foreground">{widget.title}</h3>
      )}
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="x"
              stroke="var(--muted-foreground)"
              fontSize={12}
              label={
                widget.xAxisLabel
                  ? { value: widget.xAxisLabel, position: 'insideBottom', offset: -2, fontSize: 12 }
                  : undefined
              }
            />
            <YAxis
              stroke="var(--muted-foreground)"
              fontSize={12}
              label={
                widget.yAxisLabel
                  ? { value: widget.yAxisLabel, angle: -90, position: 'insideLeft', fontSize: 12 }
                  : undefined
              }
            />
            <Tooltip
              formatter={(value, _name, item) => [value, labelForKey(item.dataKey)]}
              contentStyle={{
                background: 'var(--background)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 12,
              }}
            />
            {multiSeries && <Legend formatter={(_value, entry) => labelForKey(entry.dataKey)} wrapperStyle={{ fontSize: 12 }} />}
            {seriesEntries.map(({ key, name }, idx) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                name={name}
                stroke={PALETTE[idx % PALETTE.length]}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  )
}

function flattenSeries(series: LineChartWidget['series']): {
  data: FlatRow[]
  seriesEntries: { key: string; name: string }[]
} {
  const seriesEntries = series.map((s, index) => ({ key: `series_${index}`, name: s.name }))
  const xOrder: (string | number)[] = []
  const seen = new Set<string>()
  const byX = new Map<string, FlatRow>()
  for (const [index, s] of series.entries()) {
    for (const p of s.points) {
      const xKey = String(p.x)
      if (!seen.has(xKey)) {
        seen.add(xKey)
        xOrder.push(p.x)
      }
      const row = byX.get(xKey) ?? { x: p.x }
      row[seriesEntries[index]!.key] = p.y
      byX.set(xKey, row)
    }
  }
  const data = xOrder.map((x) => byX.get(String(x))!)
  return { data, seriesEntries }
}
