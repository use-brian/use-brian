/**
 * Plain-text rendering of an A2UI ViewPayload for channels that cannot
 * mount the interactive renderer (Slack, Telegram, WhatsApp, Discord,
 * API turns — everything outside the web app's `view_payload` client).
 *
 * `renderView` / `renderChart` attach this as `textRendering` on their
 * out-app results so the model presents the ACTUAL data instead of
 * hand-summarizing it (2026-08-19 Slack incident: the model paraphrased
 * a board it claimed was "embedded in this chat above" while the real
 * render sat as an invisible sidebar draft).
 *
 * Output is channel-portable markdown: tables go in a fenced code block
 * (monospace alignment survives Slack mrkdwn, Telegram HTML <pre>, and
 * Discord), boards/calendars are grouped bullet lists, charts are label:
 * value lines. This text is pasted to end users, so it must never
 * contain an em dash (product-copy rule) — separators are " · " and "-".
 *
 * [COMP:views/text-render]
 */

import type {
  A2UIRow,
  A2UIRowValue,
  A2UIWidget,
  ViewPayload,
} from './a2ui.js'

/** Rows/cards beyond this render as a trailing "(+N more)" line. */
const DEFAULT_MAX_ROWS = 30

/** Cell text beyond this is ellipsized so one long field can't blow up
 *  every row of an aligned table. */
const MAX_CELL_CHARS = 40

export type RenderPayloadTextOptions = {
  maxRows?: number
}

/**
 * Flatten one row/cell value to display text. Widgets carry their
 * server-resolved labels (person name, relation label, status label) —
 * the same strings the visual renderer shows.
 */
export function cellText(value: A2UIRowValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  const w = value as A2UIWidget & Record<string, unknown>
  switch (w.type) {
    case 'text':
    case 'badge':
    case 'button':
    case 'heading':
      return typeof w.text === 'string' ? w.text : ''
    case 'person':
      return typeof w.name === 'string' ? w.name : ''
    case 'relation':
      return typeof w.label === 'string' ? w.label : ''
    case 'date': {
      const iso = typeof w.iso === 'string' ? w.iso : null
      return iso ? iso.slice(0, 10) : ''
    }
    case 'number': {
      if (typeof w.value !== 'number') return ''
      const currency =
        w.format === 'currency' && typeof w.currency === 'string'
          ? `${w.currency} `
          : ''
      return `${currency}${w.value}`
    }
    case 'status': {
      if (typeof w.label === 'string') return w.label
      return typeof w.optionId === 'string' ? w.optionId : ''
    }
    case 'files': {
      const files = Array.isArray(w.files) ? w.files : []
      return files
        .map((f) => (typeof (f as { name?: unknown }).name === 'string' ? (f as { name: string }).name : ''))
        .filter(Boolean)
        .join(', ')
    }
    case 'image':
      return typeof w.alt === 'string' ? w.alt : ''
    default: {
      // Unknown widget: best-effort label so a new widget kind degrades
      // to something readable instead of an empty cell.
      for (const key of ['text', 'label', 'name', 'title', 'value'] as const) {
        const v = w[key]
        if (typeof v === 'string' && v.length > 0) return v
        if (typeof v === 'number') return String(v)
      }
      return ''
    }
  }
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_CELL_CHARS
    ? `${oneLine.slice(0, MAX_CELL_CHARS - 1)}…`
    : oneLine
}

function renderTableText(
  columns: { field: string; header: string }[],
  rows: A2UIRow[],
  maxRows: number,
): string {
  const shown = rows.slice(0, maxRows)
  const cells = shown.map((row) => columns.map((c) => clip(cellText(row[c.field]))))
  const widths = columns.map((c, i) =>
    Math.max(c.header.length, ...cells.map((r) => r[i].length), 1),
  )
  const line = (parts: string[]) =>
    parts.map((p, i) => p.padEnd(widths[i])).join('  ').trimEnd()
  const out = [
    line(columns.map((c) => c.header)),
    line(widths.map((w) => '-'.repeat(w))),
    ...cells.map((r) => line(r)),
  ]
  if (rows.length > shown.length) out.push(`(+${rows.length - shown.length} more)`)
  return '```\n' + out.join('\n') + '\n```'
}

/** First non-id, non-empty field is the card title; the rest trail muted. */
function cardLine(data: Record<string, A2UIRowValue>): string {
  const parts = Object.entries(data)
    .filter(([key]) => key !== 'id')
    .map(([, value]) => clip(cellText(value)))
    .filter(Boolean)
  if (parts.length === 0) return '- (untitled)'
  const [title, ...rest] = parts
  return rest.length > 0 ? `- ${title} (${rest.join(' · ')})` : `- ${title}`
}

/**
 * Render a ViewPayload as channel-portable text. Returns `''` for widget
 * kinds with no sensible text form (diagram, container trees) — callers
 * omit the `textRendering` field then.
 */
export function renderPayloadText(
  payload: ViewPayload,
  options: RenderPayloadTextOptions = {},
): string {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const root = payload.root as A2UIWidget & Record<string, unknown>
  switch (root.type) {
    case 'table':
      return renderTableText(root.columns, root.rows, maxRows)
    case 'board': {
      const lines: string[] = []
      let budget = maxRows
      for (const col of root.columns) {
        lines.push(`*${col.title}* (${col.cards.length})`)
        const shown = col.cards.slice(0, Math.max(budget, 0))
        for (const card of shown) lines.push(cardLine(card.data))
        if (col.cards.length > shown.length) {
          lines.push(`- (+${col.cards.length - shown.length} more)`)
        }
        budget -= shown.length
        lines.push('')
      }
      return lines.join('\n').trimEnd()
    }
    case 'calendar': {
      // Group rows by the date column's day; undated rows are not shown
      // (mirrors the visual calendar, which has no slot for them).
      const dateField = typeof root.dateColumnId === 'string' ? root.dateColumnId : 'due'
      const columns = root.columns as { field: string; header: string; kind?: string }[]
      const titleField = columns.find((c) => c.field !== dateField)?.field ?? columns[0]?.field
      const byDay = new Map<string, string[]>()
      for (const row of root.rows as A2UIRow[]) {
        const day = cellText(row[dateField])
        if (!day) continue
        const title = clip(cellText(titleField ? row[titleField] : null)) || '(untitled)'
        const bucket = byDay.get(day) ?? []
        bucket.push(title)
        byDay.set(day, bucket)
      }
      const days = [...byDay.keys()].sort()
      const lines: string[] = []
      for (const day of days) {
        lines.push(`*${day}*`)
        for (const title of byDay.get(day)!) lines.push(`- ${title}`)
      }
      return lines.join('\n')
    }
    case 'kpi': {
      const label = typeof root.label === 'string' ? root.label : 'Value'
      const delta =
        typeof root.delta === 'number'
          ? ` (${root.delta >= 0 ? '+' : ''}${root.delta})`
          : ''
      return `${label}: ${String(root.value)}${delta}`
    }
    case 'chart_bar': {
      const data = root.data as { label: string; value: number }[]
      const title = typeof root.title === 'string' ? `${root.title}\n` : ''
      return title + data.map((d) => `- ${d.label}: ${d.value}`).join('\n')
    }
    case 'chart_pie': {
      const slices = root.slices as { label: string; value: number }[]
      const total = slices.reduce((sum, s) => sum + s.value, 0)
      const title = typeof root.title === 'string' ? `${root.title}\n` : ''
      return (
        title +
        slices
          .map((s) => {
            const pct = total > 0 ? ` (${Math.round((s.value / total) * 100)}%)` : ''
            return `- ${s.label}: ${s.value}${pct}`
          })
          .join('\n')
      )
    }
    case 'chart_line': {
      const series = root.series as { name: string; points: { x: string | number; y: number }[] }[]
      const title = typeof root.title === 'string' ? `${root.title}\n` : ''
      return (
        title +
        series
          .map((s) => {
            const points = s.points
              .slice(0, maxRows)
              .map((p) => `${p.x}: ${p.y}`)
              .join(', ')
            return `${s.name}: ${points}`
          })
          .join('\n')
      )
    }
    default:
      return ''
  }
}
