'use client'

import type { JSX } from 'react'
import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import type { PieChartWidget } from '../types.js'

const PALETTE = [
  'var(--chart-1, #6366f1)',
  'var(--chart-2, #10b981)',
  'var(--chart-3, #06b6d4)',
  'var(--chart-4, #f59e0b)',
  'var(--chart-5, #ef4444)',
]

/**
 * A2UI pie chart — Recharts wrapper. Each slice gets a color from the
 * shared workspace chart palette unless the resolver pinned one.
 *
 * Legend renders below the chart for readability; we deliberately do
 * NOT label slices in the chart itself (clutter on small charts).
 *
 * [COMP:views/chart-pie]
 */
export function ChartPie(props: { widget: PieChartWidget }): JSX.Element {
  const { widget } = props

  return (
    <figure className="flex w-full flex-col gap-2">
      {widget.title && (
        <h3 className="text-lg font-medium text-foreground">{widget.title}</h3>
      )}
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
            <Pie
              data={widget.slices}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              outerRadius={80}
              innerRadius={40}
              paddingAngle={1}
              stroke="var(--background)"
            >
              {widget.slices.map((slice, idx) => (
                <Cell
                  key={`${slice.label}-${idx}`}
                  fill={slice.color ?? PALETTE[idx % PALETTE.length]}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: 'var(--background)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </figure>
  )
}
