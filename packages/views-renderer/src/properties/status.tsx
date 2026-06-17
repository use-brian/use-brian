/**
 * Status property — Notion-style grouped enum. Promotes the existing
 * Select-with-naming-convention into a first-class typed kind. Server
 * bindings emit a `StatusWidget` pre-resolved to
 * `{ optionId, groupId, label }`; the Cell renders a pill tinted by
 * group, the Editor pops a dropdown with `pending` / `in_progress` /
 * `done` headers above their respective option lists, and the sort
 * order is fixed at group-then-option so Board columns and Table sorts
 * agree.
 *
 * Three group tones, theme-driven (the `var(--chart-*)` palette already
 * powers ChartBar/ChartPie):
 *   * pending     → neutral (muted token; "not started")
 *   * in_progress → chart-1 (blue-ish accent; "active")
 *   * done        → chart-2 (green-ish accent; "finished")
 *
 * Phase-2 editor: native `<select>` with `<optgroup>` headers built from
 * `hints.statusGroups`. Selection commits immediately (Notion-style);
 * Escape cancels; the empty option clears the cell.
 *
 * Schema validation. `validateStatusValue(widget, groups)` returns true
 * when the cell's `optionId` is null OR references a known option id
 * across the schema's groups. Bindings can use this to surface stale
 * cell values (e.g. an option was deleted) — the Cell falls back to a
 * muted placeholder when the value is unknown.
 *
 * [COMP:views/property-status]
 */

import { useEffect, useRef, useState, type JSX } from 'react'
import type { A2UIRowValue, StatusWidget } from '../types.js'
import type {
  PropertyEditorProps,
  PropertyModule,
  StatusGroupHint,
  StatusOptionHint,
} from './types.js'
import { Empty } from './empty.js'

// ── Group palette ────────────────────────────────────────────────────
//
// `var(--chart-N, <hex fallback>)` mirrors widgets/ChartBar + ChartPie —
// the same tokens light/dark mode-aware. Pending uses the muted token
// (a neutral grey) to stay visually demoted from the active rows.

type GroupTone = {
  /** CSS color for the pill background tint. */
  bg: string
  /** CSS color for the pill text + the small dot. */
  fg: string
  /** Stable group order — pending < in_progress < done. */
  order: number
}

const GROUP_TONE: Record<NonNullable<StatusWidget['groupId']>, GroupTone> = {
  pending: {
    bg: 'color-mix(in srgb, var(--muted, #e5e5e5) 60%, transparent)',
    fg: 'var(--muted-foreground, #6b7280)',
    order: 0,
  },
  in_progress: {
    bg: 'color-mix(in srgb, var(--chart-1, #6366f1) 18%, transparent)',
    fg: 'var(--chart-1, #6366f1)',
    order: 1,
  },
  done: {
    bg: 'color-mix(in srgb, var(--chart-2, #10b981) 18%, transparent)',
    fg: 'var(--chart-2, #10b981)',
    order: 2,
  },
}

// ── Cell ─────────────────────────────────────────────────────────────

function asStatus(v: A2UIRowValue): StatusWidget | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && v.type === 'status') return v
  // String fallback — bindings emitted a bare option id. Wrap it; group
  // resolution falls to `validate` against the schema hints.
  if (typeof v === 'string' && v.length > 0) {
    return { type: 'status', optionId: v }
  }
  return null
}

function Cell(props: { value: A2UIRowValue }): JSX.Element {
  const s = asStatus(props.value)
  if (!s || s.optionId === null) return <Empty />
  const tone = s.groupId ? GROUP_TONE[s.groupId] : null
  const label = s.label && s.label.length > 0 ? s.label : s.optionId
  if (!tone) {
    // Unknown group — server didn't resolve. Render as a muted
    // placeholder so the user sees the value but can tell it isn't
    // currently mapped to a known group.
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground/80">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
        {label}
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: tone.bg, color: tone.fg }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: tone.fg }}
      />
      {label}
    </span>
  )
}

// ── Editor ───────────────────────────────────────────────────────────

function Editor(props: PropertyEditorProps): JSX.Element | null {
  // Bail before any hooks so the "not editable" branch returns null
  // without violating Rules of Hooks. The host treats null as
  // "not yet editable" and falls back to the read-only Cell.
  const groups = props.hints?.statusGroups ?? []
  if (groups.length === 0) return null
  return <StatusEditor {...props} groups={groups} />
}

function StatusEditor(
  props: PropertyEditorProps & { groups: readonly StatusGroupHint[] },
): JSX.Element {
  const initial = asStatus(props.value)
  const initialId = initial?.optionId ?? ''
  const [draftId, setDraftId] = useState<string>(initialId)
  const ref = useRef<HTMLSelectElement | null>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  function commit(id: string): void {
    if (id === initialId) {
      props.onCancel()
      return
    }
    if (id === '') {
      props.onCommit(null)
      return
    }
    // Resolve the picked option to its group so the widget carries the
    // pre-resolved tone — Cell renders correctly straight after commit
    // without waiting on a server refresh.
    for (const g of props.groups) {
      const match = g.options.find((o) => o.id === id)
      if (match) {
        const widget: StatusWidget = {
          type: 'status',
          optionId: id,
          groupId: g.id,
          label: match.name,
        }
        props.onCommit(widget)
        return
      }
    }
    // Unknown id picked (shouldn't happen — the select is bound to
    // schema options). Cancel rather than commit a dangling value.
    props.onCancel()
  }

  return (
    <select
      ref={ref}
      className="w-full rounded-sm border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/40"
      value={draftId}
      onChange={(e) => {
        setDraftId(e.target.value)
        commit(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          props.onCancel()
        }
      }}
      onBlur={() => {
        if (draftId === initialId) props.onCancel()
      }}
    >
      {/* Allow clearing — empty option submits null. */}
      <option value="">—</option>
      {props.groups.map((g) => (
        <optgroup key={g.id} label={g.label}>
          {g.options.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

// ── Icon ─────────────────────────────────────────────────────────────

function Icon(props: { className?: string }): JSX.Element {
  // Lucide-style CircleDot — outer ring + inner dot, 12px when scaled
  // via the standard `h-3 w-3` className.
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
         className={props.className ?? 'h-3 w-3 text-muted-foreground'}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

// ── sortFn ───────────────────────────────────────────────────────────

function sortFn(a: A2UIRowValue, b: A2UIRowValue): number {
  const as = asStatus(a)
  const bs = asStatus(b)
  // Nulls sort last (matches every other property).
  if ((as === null || as.optionId === null) && (bs === null || bs.optionId === null)) return 0
  if (as === null || as.optionId === null) return 1
  if (bs === null || bs.optionId === null) return -1
  // Group order first — pending → in_progress → done. Missing group
  // sorts last within the non-null bucket.
  const ao = as.groupId ? GROUP_TONE[as.groupId].order : 99
  const bo = bs.groupId ? GROUP_TONE[bs.groupId].order : 99
  if (ao !== bo) return ao - bo
  // Stable tie-break by option id so two cells in the same group land
  // in a deterministic order.
  return as.optionId.localeCompare(bs.optionId)
}

// ── validate ─────────────────────────────────────────────────────────

/**
 * Structural validator — true when the value is null, a `StatusWidget`,
 * or a bare string (the schema-less wire fallback in `asStatus`). The
 * `PropertyModule.validate` hook is structural (no schema context); for
 * schema-aware "is this option-id in one of the groups" validation use
 * `validateStatusValue(value, groups)`.
 */
function validate(value: A2UIRowValue): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return true
  if (typeof value === 'object' && value.type === 'status') return true
  return false
}

/**
 * Schema-aware validator — true when the cell value is null OR its
 * `optionId` references an option in one of the schema's groups. Hosts
 * use this to flag stale values when an option was deleted after rows
 * referenced it.
 */
export function validateStatusValue(
  value: A2UIRowValue,
  groups: readonly StatusGroupHint[],
): boolean {
  const s = asStatus(value)
  if (s === null || s.optionId === null) return true
  for (const g of groups) {
    if (g.options.some((o: StatusOptionHint) => o.id === s.optionId)) return true
  }
  return false
}

export const StatusProperty: PropertyModule = {
  kind: 'status',
  Cell,
  Editor,
  Icon,
  sortFn,
  validate,
}
