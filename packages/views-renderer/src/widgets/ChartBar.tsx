'use client'

import type { JSX } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { BarChartWidget } from '../types.js'

/**
 * A2UI bar chart — Recharts wrapper. Renders a single dataset of
 * (label, value) pairs; horizontal orientation flips the axes.
 *
 * The chart sits in a ResponsiveContainer so the host can size the
 * surrounding box; we pin the height to keep stacked charts on a
 * page predictable.
 *
 * [COMP:views/chart-bar]
 */
export function ChartBar(props: { widget: BarChartWidget }): JSX.Element {
  const { widget } = props
  const fill = toneFill(widget.tone)
  const horizontal = widget.orientation === 'horizontal'

  return (
    <figure className="flex w-full flex-col gap-2">
      {widget.title && (
        <h3 className="text-lg font-medium text-foreground">{widget.title}</h3>
      )}
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={widget.data}
            layout={horizontal ? 'vertical' : 'horizontal'}
            margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            {horizontal ? (
              <>
                <XAxis type="number" stroke="var(--muted-foreground)" fontSize={12} />
                <YAxis
                  type="category"
                  dataKey="label"
                  stroke="var(--muted-foreground)"
                  fontSize={12}
                  width={96}
                />
              </>
            ) : (
              <>
                <XAxis
                  dataKey="label"
                  stroke="var(--muted-foreground)"
                  fontSize={12}
                />
                <YAxis stroke="var(--muted-foreground)" fontSize={12} />
              </>
            )}
            <Tooltip
              cursor={{ fill: 'var(--muted)' }}
              contentStyle={{
                background: 'var(--background)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: 12,
              }}
            />
            <Bar dataKey="value" fill={fill} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  )
}

function toneFill(tone: BarChartWidget['tone']): string {
  switch (tone) {
    case 'success':
      return 'var(--chart-2, #10b981)'
    case 'warning':
      return 'var(--chart-4, #f59e0b)'
    case 'danger':
      return 'var(--chart-5, #ef4444)'
    case 'default':
    case undefined:
      return 'var(--chart-1, #6366f1)'
  }
}
