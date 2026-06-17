'use client'

import type { JSX } from 'react'
import type { KpiWidget } from '../types.js'

/**
 * A2UI KPI tile — large number + optional delta arrow.
 *
 * Tabular numerals so digits align across stacked KPIs. The delta uses
 * the workspace palette (emerald/rose/muted) via the same Tailwind
 * tokens the Badge widget uses, so the renderer stays internally
 * consistent.
 *
 * [COMP:views/kpi]
 */
export function Kpi(props: { widget: KpiWidget }): JSX.Element {
  const { widget } = props
  const formatted = formatValue(widget.value, widget.format, widget.currency)
  const deltaTone = widget.deltaTone ?? 'neutral'
  const showDelta = typeof widget.delta === 'number' && Number.isFinite(widget.delta)
  const deltaClass = TONE_CLASS[deltaTone]
  const deltaPrefix = deltaTone === 'positive' ? '↑' : deltaTone === 'negative' ? '↓' : '·'

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-background p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {widget.label}
      </div>
      <div className="text-3xl font-semibold tabular-nums text-foreground">
        {formatted}
      </div>
      {showDelta && (
        <div className={`text-xs font-medium tabular-nums ${deltaClass}`}>
          {deltaPrefix} {formatDelta(widget.delta!, widget.format)}
        </div>
      )}
    </div>
  )
}

const TONE_CLASS: Record<'positive' | 'negative' | 'neutral', string> = {
  positive: 'text-emerald-700 dark:text-emerald-300',
  negative: 'text-rose-700 dark:text-rose-300',
  neutral: 'text-muted-foreground',
}

function formatValue(
  value: number | string,
  format: KpiWidget['format'],
  currency?: string,
): string {
  if (typeof value === 'string') return value
  return formatNumber(value, format ?? 'plain', currency)
}

function formatDelta(value: number, format: KpiWidget['format']): string {
  const abs = Math.abs(value)
  return formatNumber(abs, format ?? 'plain')
}

function formatNumber(
  value: number,
  format: NonNullable<KpiWidget['format']>,
  currency?: string,
): string {
  switch (format) {
    case 'currency':
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency ?? 'USD',
        maximumFractionDigits: 0,
      }).format(value)
    case 'percent':
      return new Intl.NumberFormat(undefined, {
        style: 'percent',
        maximumFractionDigits: 1,
      }).format(value)
    case 'integer':
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)
    case 'plain':
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
  }
}
