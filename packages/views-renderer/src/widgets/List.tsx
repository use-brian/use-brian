/**
 * A2UI List — compact one-line rows.
 *
 * Notion-feel list view: a single tall stack of rows where each row is
 * one horizontal flex line. The first column carries the entity title
 * (primary, left-aligned, medium font weight, truncated). The remaining
 * columns render right-aligned as secondary "pills" in muted color,
 * comma-separated.
 *
 * Unlike Table, there is no column header, no sticky chrome, no add-row
 * affordance, no resize. Per the Notion reference (List view) properties
 * are read-only in the list itself — edits happen by opening the row
 * (via `rowAction`). See `docs/research/notion/databases-and-views.md`
 * §2.5 for the source of these decisions.
 *
 * Row-click semantics match Table: when `rowAction` is set, clicking a
 * row fires `onAction(rowAction.id, { ...rowAction.params, rowId })`.
 * Hovering tints the row background via `var(--accent)/40`
 * (`bg-accent/40` Tailwind shorthand).
 *
 * Cell rendering reuses the property registry — each cell renders via
 * `PROPERTIES[col.kind].Cell` when the column declares a kind, and
 * falls back to `renderRowValue` for untagged columns. This matches
 * Table and keeps the property surface uniform across views.
 *
 * [COMP:views/list]
 */

import { Fragment, type JSX } from 'react'
import type { A2UIColumn, A2UIRow, A2UIRowValue, ActionRef, OnActionHandler } from '../types.js'
import { renderRowValue } from '../render.js'
import { PROPERTIES } from '../properties/index.js'

export type ListProps = {
  /**
   * Columns in display order. The first column is the title (primary,
   * left-aligned). The remaining columns render as secondary pills on
   * the right.
   */
  columns: A2UIColumn[]
  rows: A2UIRow[]
  rowAction?: ActionRef
  onAction?: OnActionHandler
  /**
   * Copy shown when `rows` is empty. Defaults to "No rows." to match
   * the Table empty state.
   */
  emptyMessage?: string
}

export function List(props: ListProps): JSX.Element {
  const [primary, ...secondary] = props.columns
  const handleRowClick = (rowId: string) => {
    if (!props.rowAction || !props.onAction) return
    props.onAction(props.rowAction.id, { ...props.rowAction.params, rowId })
  }

  if (props.rows.length === 0) {
    return (
      <div
        className="w-full px-3 py-6 text-center text-sm text-muted-foreground"
        data-a2ui-list-empty
      >
        {props.emptyMessage ?? 'No rows.'}
      </div>
    )
  }

  return (
    <ul className="flex w-full flex-col" data-a2ui-list>
      {props.rows.map((row, idx) => {
        const rowId = typeof row.id === 'string' ? row.id : String(idx)
        const clickable = Boolean(props.rowAction && props.onAction)
        return (
          <li
            key={rowId}
            className={[
              'group/listrow flex w-full items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-0 hover:bg-accent/40',
              clickable ? 'cursor-pointer' : '',
            ].join(' ').trim()}
            onClick={clickable ? () => handleRowClick(rowId) : undefined}
            data-a2ui-list-row={rowId}
          >
            <span className="flex-1 truncate font-medium text-foreground">
              {primary ? renderCell(primary, row[primary.field] ?? null, props.onAction) : null}
            </span>
            {secondary.length > 0 ? (
              <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                {secondary.map((col, secIdx) => (
                  <Fragment key={col.field}>
                    {secIdx > 0 ? <span className="text-muted-foreground/60">,</span> : null}
                    <span className="truncate" data-a2ui-list-secondary={col.field}>
                      {renderCell(col, row[col.field] ?? null, props.onAction)}
                    </span>
                  </Fragment>
                ))}
              </span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Render a single cell. Mirrors the Table cell dispatch: when a column
 * declares a `kind`, route through `PROPERTIES[kind].Cell`; otherwise
 * fall back to legacy `renderRowValue`. Centralised here so the primary
 * and secondary branches stay consistent.
 */
function renderCell(
  col: A2UIColumn,
  value: A2UIRowValue,
  onAction?: OnActionHandler,
): JSX.Element {
  const property = col.kind ? PROPERTIES[col.kind] ?? null : null
  if (property) {
    const PropCell = property.Cell
    return <PropCell value={value} onAction={onAction} />
  }
  return renderRowValue(value, onAction)
}
