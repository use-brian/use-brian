/**
 * A2UI Table — TanStack Table v8 integration.
 *
 * Reads `columns` and `rows` from the payload; column defs are derived
 * once per render. Sort via header click; basic in-memory only (no
 * server-side sort yet — saved-view bindings carry a server `sort`
 * clause for ordering at fetch time).
 *
 * Row click fires `onAction(rowAction.id, { ...rowAction.params, rowId })`.
 *
 * Two interaction tiers, gated by `enableColumnMenu`:
 *
 *   - **Legacy (apps/web chat-inline, `enableColumnMenu` falsy):** sticky
 *     header, single frozen first column, local click-to-sort, live (but
 *     ephemeral) column resize, hover row menu. Untouched by the
 *     doc-database work — no menu, no reorder, no persistence.
 *   - **Notion-database (doc surface, `enableColumnMenu` true):** the
 *     host (`apps/app-web`) seeds view-state from the data block's
 *     persisted `binding.display` and stamps it onto the TableWidget
 *     (`frozenColumnCount`, `sort`, `editableColumns`). The renderer then:
 *       * commits a column resize on pointer-up via
 *         `onAction('column-resize', { field, width })`,
 *       * freezes the first N columns (sticky-left, cumulative offsets),
 *       * opens a per-column header **menu** (sort / filter / hide / freeze,
 *         plus rename / retype / insert / duplicate / delete when
 *         `editableColumns`) that fires `onAction('column-*', …)`,
 *       * drives sort through the menu (rows arrive pre-sorted from the
 *         host; the arrow reads from the `sort` prop), and
 *       * reorders columns by header drag → `onAction('column-reorder',
 *         { order })`.
 *     All persistence lives host-side; the renderer stays pure.
 *
 * [COMP:views/table]
 */

import {
  type ColumnDef,
  type ColumnSizingState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import {
  type DragEvent as ReactDragEvent,
  type JSX,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  A2UIColumn,
  A2UIRow,
  A2UIRowValue,
  ActionRef,
  ColumnMenuLabels,
  OnActionHandler,
  PropertyKind,
} from '../types.js'
import { renderRowValue } from '../render.js'
import { PROPERTIES } from '../properties/index.js'
import type { PropertyEditorHints, PropertyModule } from '../properties/types.js'

// Cell-update is committed through this action id (the host — `block-data.tsx`
// — routes it to `PATCH /api/<entity>/<id>`).
const CELL_UPDATE_ACTION = 'cell-update'

// Notion-database column / row actions (doc surface only — apps/web omits
// `enableColumnMenu`, so none of these fire there). The host
// (`apps/app-web`) persists each into the data block's `binding.display`
// (the display ops) or routes it to an entity tool (the schema-edit ops).
const COLUMN_RESIZE_ACTION = 'column-resize'
const COLUMN_SORT_ACTION = 'column-sort'
const COLUMN_HIDE_ACTION = 'column-hide'
const COLUMN_FREEZE_ACTION = 'column-freeze'
const COLUMN_REORDER_ACTION = 'column-reorder'
const COLUMN_FILTER_ACTION = 'column-filter-request'
const COLUMN_RENAME_ACTION = 'column-rename'
const COLUMN_RETYPE_ACTION = 'column-retype'
const COLUMN_INSERT_ACTION = 'column-insert'
const COLUMN_DUPLICATE_ACTION = 'column-duplicate'
const COLUMN_DELETE_ACTION = 'column-delete'

// Column kinds whose inline `Editor` works from the cell value alone (plus
// optional column-supplied hints). `status` is editable only when the column
// carries `statusGroups`; `person`/`relation`/`files`/auto-stamp kinds have no
// inline editor yet (edit via the row drawer). An untyped column (no `kind`)
// edits as plain text.
const VALUE_EDITABLE_KINDS = new Set<PropertyKind>([
  'text', 'select', 'tags', 'number', 'date', 'checkbox', 'url', 'email', 'phone',
])

/** English fallback menu labels. The doc host passes localized strings via
 *  `labels`; the legacy renderer (apps/web) never shows the menu, so these
 *  defaults only surface if a host enables the menu without supplying copy. */
const DEFAULT_LABELS: ColumnMenuLabels = {
  sortAsc: 'Sort ascending',
  sortDesc: 'Sort descending',
  clearSort: 'Clear sort',
  filter: 'Filter',
  hide: 'Hide column',
  freeze: 'Freeze up to here',
  unfreeze: 'Unfreeze',
  rename: 'Rename',
  editType: 'Edit property type',
  insertLeft: 'Insert left',
  insertRight: 'Insert right',
  duplicateColumn: 'Duplicate column',
  deleteColumn: 'Delete column',
  duplicateRow: 'Duplicate',
  deleteRow: 'Delete',
  openRow: 'Open',
}

export type TableProps = {
  columns: A2UIColumn[]
  rows: A2UIRow[]
  rowAction?: ActionRef
  onAction?: OnActionHandler
  /**
   * Whether to freeze the first column via `position: sticky; left: 0`.
   * Defaults to `true`. Hosts whose first column isn't a meaningful
   * title (e.g. boards with a status badge first) pass `false`. When
   * `frozenColumnCount` is supplied (doc), it takes precedence.
   */
  freezeFirstColumn?: boolean
  /**
   * Freeze the first N columns (doc). Overrides `freezeFirstColumn`.
   * Stamped from `binding.display.frozenCount`.
   */
  frozenColumnCount?: number
  /**
   * Host-controlled active sort (doc). When set, the renderer treats
   * `rows` as already sorted and routes header-menu sort through
   * `onAction('column-sort', …)`; the arrow indicator reads from here.
   */
  sort?: { field: string; direction: 'asc' | 'desc' } | null
  /** When true, the column menu offers schema edits (rename / retype /
   *  insert / duplicate / delete) — user-defined entity tables only. */
  editableColumns?: boolean
  /** Master gate for the Notion-database chrome (menu / resize-persist /
   *  reorder / frozen-N / row numbers). Doc sets it; apps/web omits it. */
  enableColumnMenu?: boolean
  /** Localized menu copy (doc supplies it; defaults to English). */
  labels?: Partial<ColumnMenuLabels>
}

const GUTTER_PX = 24
const ROW_MENU_OPEN_ACTION = 'row-open'
const ROW_MENU_DELETE_ACTION = 'row-delete'
const ROW_MENU_DUPLICATE_ACTION = 'row-duplicate'
const ROW_ADD_ACTION = 'row-add'

export function Table(props: TableProps): JSX.Element {
  const menuEnabled = props.enableColumnMenu === true
  const editable = props.editableColumns === true
  const labels = useMemo<ColumnMenuLabels>(
    () => ({ ...DEFAULT_LABELS, ...(props.labels ?? {}) }),
    [props.labels],
  )
  const freezeFirst = props.freezeFirstColumn ?? true
  const [sorting, setSorting] = useState<SortingState>([])
  // Live column widths during a drag. Seeded empty — TanStack falls back to
  // each column's `size` (`col.width ?? 180`), so a persisted width rehydrates
  // from the payload. The committed width is persisted on pointer-up (doc)
  // via `onAction('column-resize')`; apps/web keeps it ephemeral.
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({})
  const [openMenuRowId, setOpenMenuRowId] = useState<string | null>(null)
  const [openColMenu, setOpenColMenu] = useState<string | null>(null)
  const [dragField, setDragField] = useState<string | null>(null)
  const [dropField, setDropField] = useState<string | null>(null)
  // Inline cell editing (Notion-style: click a cell to edit it in place).
  const [editing, setEditing] = useState<{ rowId: string; field: string } | null>(null)

  // The entity this table edits — carried on `rowAction.params.entity` by the
  // server builders. Required to address a `cell-update` (`PATCH /<entity>/<id>`).
  const rawEntity = props.rowAction?.params?.['entity']
  const editEntity = typeof rawEntity === 'string' ? rawEntity : undefined
  const canEditCells = !!props.onAction && !!editEntity

  const columnByField = useMemo(() => {
    const m = new Map<string, A2UIColumn>()
    for (const c of props.columns) m.set(c.field, c)
    return m
  }, [props.columns])

  // Resolve the inline editor module for a column, or null when the column
  // isn't inline-editable in this context (no commit path, an editor-less
  // kind, or a `status` column missing its option groups).
  function editorFor(col: A2UIColumn | undefined): PropertyModule | null {
    if (!canEditCells || !col) return null
    const kind = col.kind
    if (kind === undefined) return PROPERTIES.text ?? null
    if (kind === 'status') {
      return col.statusGroups && col.statusGroups.length > 0
        ? (PROPERTIES.status ?? null)
        : null
    }
    return VALUE_EDITABLE_KINDS.has(kind) ? (PROPERTIES[kind] ?? null) : null
  }

  function commitCell(rowId: string, field: string, value: A2UIRowValue): void {
    setEditing(null)
    props.onAction?.(CELL_UPDATE_ACTION, { entity: editEntity, rowId, field, value })
  }

  const columnDefs = useMemo<ColumnDef<A2UIRow>[]>(
    () => buildColumnDefs(props.columns, props.onAction),
    [props.columns, props.onAction],
  )

  const table = useReactTable({
    data: props.rows,
    columns: columnDefs,
    state: { sorting, columnSizing },
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    columnResizeMode: 'onChange',
    enableColumnResizing: true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => {
      const id = (row as { id?: unknown }).id
      return typeof id === 'string' ? id : undefined as never
    },
  })

  // Commit a column resize on pointer-up (doc). `columnSizingInfo
  // .isResizingColumn` holds the active column id while dragging and flips to
  // `false` on release — the truthy→false transition is the commit edge, so
  // the binding is written once per drag, not once per pixel.
  const resizingCol = table.getState().columnSizingInfo.isResizingColumn
  const prevResizingCol = useRef<string | false>(false)
  useEffect(() => {
    const prev = prevResizingCol.current
    prevResizingCol.current = resizingCol
    if (prev && !resizingCol && menuEnabled && props.onAction) {
      const size = table.getColumn(prev)?.getSize()
      if (typeof size === 'number') {
        props.onAction(COLUMN_RESIZE_ACTION, { field: prev, width: Math.round(size) })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizingCol])

  // Close any open header / row menu on an outside click. Trigger elements and
  // the menus themselves carry `data-table-menu`, so clicks on them are
  // ignored (the trigger's own onClick toggles; menu items close on action).
  useEffect(() => {
    if (!openColMenu && openMenuRowId === null) return
    function onDocMouseDown(e: MouseEvent): void {
      const target = e.target as HTMLElement | null
      if (target && target.closest('[data-table-menu]')) return
      setOpenColMenu(null)
      setOpenMenuRowId(null)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [openColMenu, openMenuRowId])

  const headerGroups = table.getHeaderGroups()
  const headers = headerGroups[0]?.headers ?? []

  // Frozen-column geometry. `frozenColumnCount` (doc) overrides the legacy
  // single-column `freezeFirstColumn`. `leftOffsets[idx]` is the sticky `left`
  // for the column at `idx` — the gutter width plus the cumulative width of
  // every frozen column before it.
  const frozenCount = menuEnabled
    ? Math.max(0, props.frozenColumnCount ?? (freezeFirst ? 1 : 0))
    : (freezeFirst ? 1 : 0)
  const leftOffsets: number[] = []
  {
    let acc = GUTTER_PX
    for (const h of headers) {
      leftOffsets.push(acc)
      acc += h.getSize()
    }
  }
  const isFrozen = (idx: number): boolean => idx < frozenCount

  // Active sort direction for a field's header arrow. In menu mode the source
  // of truth is the host-supplied `sort` prop (rows are pre-sorted); otherwise
  // the renderer's own local sort state drives it.
  function sortDirFor(field: string, localSorted: false | 'asc' | 'desc'): false | 'asc' | 'desc' {
    if (menuEnabled) return props.sort?.field === field ? props.sort.direction : false
    return localSorted
  }

  function fireColumn(actionId: string, params: Record<string, unknown>): void {
    setOpenColMenu(null)
    props.onAction?.(actionId, params)
  }

  function reorderColumns(targetField: string): void {
    const source = dragField
    setDragField(null)
    setDropField(null)
    if (!source || source === targetField || !props.onAction) return
    const fields = props.columns.map((c) => c.field)
    const from = fields.indexOf(source)
    const to = fields.indexOf(targetField)
    if (from < 0 || to < 0) return
    const next = [...fields]
    next.splice(from, 1)
    next.splice(to, 0, source)
    props.onAction(COLUMN_REORDER_ACTION, { order: next })
  }

  const handleRowMenuAction = (rowId: string, actionId: string): void => {
    setOpenMenuRowId(null)
    if (!props.onAction) return
    props.onAction(actionId, { rowId })
  }

  const handleAddRow = (): void => {
    if (!props.onAction) return
    props.onAction(ROW_ADD_ACTION, { rowId: null })
  }

  const colCount = columnDefs.length + 1 // +1 for the gutter column

  return (
    <div className="relative w-full overflow-x-auto">
      <table className="w-full text-left text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead className="sticky top-0 z-20 bg-background">
          {headerGroups.map((hg) => (
            <tr key={hg.id} className="border-b border-border">
              {/* Left gutter — drag handle + more-menu live in body rows */}
              <th
                className="sticky left-0 z-30 bg-transparent"
                style={{ width: GUTTER_PX, minWidth: GUTTER_PX }}
                aria-hidden
              />
              {hg.headers.map((h, idx) => {
                const localSorted = h.column.getIsSorted()
                const sortDir = sortDirFor(h.column.id, localSorted)
                const canSort = h.column.getCanSort()
                const meta = h.column.columnDef.meta as { width?: number; kind?: A2UIColumn['kind'] } | undefined
                const HeaderIcon = meta?.kind ? PROPERTIES[meta.kind]?.Icon ?? null : null
                const frozen = isFrozen(idx)
                const size = h.getSize()
                const isDropTarget = menuEnabled && dropField === h.column.id && dragField !== h.column.id
                const headerClickable = menuEnabled ? !!props.onAction : canSort
                return (
                  <th
                    key={h.id}
                    className={[
                      'group/header relative border-b border-border bg-background px-3 py-2 font-medium text-muted-foreground',
                      headerClickable ? 'cursor-pointer select-none' : '',
                      frozen ? 'sticky z-20' : '',
                      isDropTarget ? 'bg-primary/10' : '',
                    ].join(' ').trim()}
                    style={{
                      width: size,
                      minWidth: size,
                      ...(frozen ? { left: leftOffsets[idx] } : {}),
                    }}
                    aria-sort={
                      sortDir === 'asc' ? 'ascending'
                      : sortDir === 'desc' ? 'descending'
                      : 'none'
                    }
                    {...(menuEnabled && props.onAction
                      ? {
                          onDragOver: (e: ReactDragEvent) => {
                            if (!dragField) return
                            e.preventDefault()
                            setDropField(h.column.id)
                          },
                          onDrop: (e: ReactDragEvent) => {
                            e.preventDefault()
                            reorderColumns(h.column.id)
                          },
                        }
                      : {})}
                  >
                    <span
                      className="inline-flex max-w-full items-center gap-1.5"
                      {...(menuEnabled ? { 'data-table-menu': 'col-trigger' } : {})}
                      draggable={menuEnabled && !!props.onAction}
                      onDragStart={
                        menuEnabled && props.onAction
                          ? () => setDragField(h.column.id)
                          : undefined
                      }
                      onDragEnd={
                        menuEnabled
                          ? () => { setDragField(null); setDropField(null) }
                          : undefined
                      }
                      onClick={
                        menuEnabled
                          ? (props.onAction
                              ? () => setOpenColMenu((cur) => (cur === h.column.id ? null : h.column.id))
                              : undefined)
                          : (canSort ? h.column.getToggleSortingHandler() : undefined)
                      }
                    >
                      {HeaderIcon ? <HeaderIcon /> : null}
                      <span className="truncate">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </span>
                      {sortDir === 'asc' ? <span aria-hidden> ▲</span>
                        : sortDir === 'desc' ? <span aria-hidden> ▼</span>
                        : null}
                      {menuEnabled && props.onAction ? (
                        <ChevronDownIcon className="opacity-0 transition-opacity group-hover/header:opacity-60" />
                      ) : null}
                    </span>
                    {menuEnabled && props.onAction && openColMenu === h.column.id ? (
                      <ColumnMenu
                        field={h.column.id}
                        index={idx}
                        frozenCount={frozenCount}
                        sorted={sortDir}
                        editable={editable}
                        labels={labels}
                        onAction={fireColumn}
                      />
                    ) : null}
                    {h.column.getCanResize() ? (
                      <ResizeHandle
                        onMouseDown={h.getResizeHandler()}
                        onTouchStart={h.getResizeHandler()}
                        isResizing={h.column.getIsResizing()}
                      />
                    ) : null}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.length === 0 ? (
            <tr>
              <td
                colSpan={colCount}
                className="px-3 py-6 text-center text-muted-foreground"
              >
                No rows.
              </td>
            </tr>
          ) : (
            table.getRowModel().rows.map((row, rowIdx) => (
              <tr
                key={row.id}
                className="group/row border-b border-border last:border-0 hover:bg-muted/30"
              >
                <td
                  className="sticky left-0 z-10 bg-transparent align-top"
                  style={{ width: GUTTER_PX, minWidth: GUTTER_PX }}
                >
                  <RowGutter
                    rowId={row.id}
                    rowNumber={rowIdx + 1}
                    showNumber={menuEnabled}
                    showOpen={!menuEnabled && !!props.rowAction}
                    showDuplicate={menuEnabled}
                    labels={labels}
                    menuOpen={openMenuRowId === row.id}
                    onToggleMenu={() =>
                      setOpenMenuRowId((cur) => (cur === row.id ? null : row.id))
                    }
                    onAction={(actionId) => handleRowMenuAction(row.id, actionId)}
                  />
                </td>
                {row.getVisibleCells().map((cell, idx) => {
                  const frozen = isFrozen(idx)
                  const size = cell.column.getSize()
                  const col = columnByField.get(cell.column.id)
                  const module = editorFor(col)
                  const isEditingThis =
                    editing?.rowId === row.id && editing?.field === cell.column.id
                  const clickToEdit = module !== null && !isEditingThis
                  return (
                    <td
                      key={cell.id}
                      className={[
                        'px-3 py-2 align-top',
                        frozen ? 'sticky bg-background z-10' : '',
                        clickToEdit ? 'cursor-text hover:bg-muted/20' : '',
                      ].join(' ').trim()}
                      style={{
                        width: size,
                        minWidth: size,
                        ...(frozen ? { left: leftOffsets[idx] } : {}),
                      }}
                      onClick={
                        clickToEdit
                          ? () => setEditing({ rowId: row.id, field: cell.column.id })
                          : undefined
                      }
                    >
                      {isEditingThis && module ? (
                        <CellEditor
                          module={module}
                          value={cell.getValue() as A2UIRowValue}
                          hints={hintsFor(col)}
                          onCommit={(next) =>
                            commitCell(row.id, cell.column.id, next)
                          }
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        flexRender(cell.column.columnDef.cell, cell.getContext())
                      )}
                    </td>
                  )
                })}
              </tr>
            ))
          )}
          {props.onAction ? (
            <tr
              className="group/addrow border-t border-border/60 hover:bg-muted/40 cursor-pointer"
              onClick={handleAddRow}
            >
              <td
                className="sticky left-0 z-10 bg-transparent align-top"
                style={{ width: GUTTER_PX, minWidth: GUTTER_PX }}
                aria-hidden
              />
              <td
                colSpan={columnDefs.length}
                className="px-3 py-2 text-sm text-muted-foreground/70 group-hover/addrow:text-muted-foreground"
              >
                <span className="inline-flex items-center gap-1.5">
                  <PlusIcon />
                  <span>Add row</span>
                </span>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

/** Build the inline-editor hints for a column from its option metadata. */
function hintsFor(col: A2UIColumn | undefined): PropertyEditorHints {
  return { options: col?.options, statusGroups: col?.statusGroups }
}

/**
 * Renders a property module's inline `Editor` for the cell being edited.
 * Isolated as its own component so the editor's hooks mount/unmount cleanly
 * each time `editing` toggles (select/status editors autofocus + commit on
 * change; text/tags commit on Enter/blur).
 */
function CellEditor(props: {
  module: PropertyModule
  value: A2UIRowValue
  hints: PropertyEditorHints
  onCommit: (next: A2UIRowValue) => void
  onCancel: () => void
}): JSX.Element {
  const Editor = props.module.Editor
  return (
    <Editor
      value={props.value}
      hints={props.hints}
      onCommit={props.onCommit}
      onCancel={props.onCancel}
    />
  )
}

/**
 * Build TanStack column defs from A2UI columns. Sorting compares values
 * by their primitive form — strings compare lexically, numbers
 * numerically, widgets fall back to their `text`/`field` representation
 * (see `cellSortValue`).
 *
 * Every column is `enableResizing: true`. The initial `size` is the
 * persisted `col.width` (doc stamps it from `binding.display
 * .columnWidths`), falling back to 180px; `minSize`/`maxSize` bound the
 * live drag.
 */
function buildColumnDefs(
  columns: A2UIColumn[],
  onAction?: OnActionHandler,
): ColumnDef<A2UIRow>[] {
  return columns.map<ColumnDef<A2UIRow>>((col) => {
    const property = col.kind ? PROPERTIES[col.kind] ?? null : null
    return {
      id: col.field,
      accessorFn: (row) => row[col.field] ?? null,
      header: col.header,
      cell: (info) => {
        const value = info.getValue() as A2UIRowValue
        if (property) {
          const PropCell = property.Cell
          return <PropCell value={value} onAction={onAction} />
        }
        return renderRowValue(value, onAction)
      },
      meta: { width: col.width, kind: col.kind },
      size: col.width ?? 180,
      minSize: 60,
      maxSize: 800,
      enableResizing: true,
      sortingFn: property
        ? (a, b, columnId) => property.sortFn(
            a.getValue(columnId) as A2UIRowValue,
            b.getValue(columnId) as A2UIRowValue,
          )
        : (a, b, columnId) => {
            const av = a.getValue(columnId) as A2UIRowValue
            const bv = b.getValue(columnId) as A2UIRowValue
            const an = cellSortValue(av)
            const bn = cellSortValue(bv)
            if (an === bn) return 0
            if (an === null) return 1
            if (bn === null) return -1
            return an < bn ? -1 : 1
          },
      enableSorting: true,
    }
  })
}

/**
 * Reduce an A2UI row value to a sort key. Primitives are returned
 * directly; null becomes `null` (sorted last); widgets fall back to
 * their `text` field (Badge, Text) or `alt` (Image), or a string
 * fingerprint of the widget type.
 */
function cellSortValue(v: A2UIRowValue): string | number | null {
  if (v === null) return null
  if (typeof v === 'string' || typeof v === 'number') return v
  if (v.type === 'badge' || v.type === 'text' || v.type === 'heading' || v.type === 'button') {
    return v.text
  }
  if (v.type === 'image') return v.alt
  return v.type
}

/**
 * Per-column header dropdown (doc). A lightweight absolutely-positioned
 * popover — the renderer is a pure package with no dropdown primitive. Every
 * item fires a `column-*` action the host persists (display ops) or routes to
 * an entity tool (schema-edit ops). Outside-click close is owned by the parent
 * `Table` via the `[data-table-menu]` document listener; the schema-edit block
 * (rename / retype / insert / duplicate / delete) shows only when `editable`
 * (user-defined entity tables).
 */
function ColumnMenu(props: {
  field: string
  index: number
  frozenCount: number
  sorted: false | 'asc' | 'desc'
  editable: boolean
  labels: ColumnMenuLabels
  onAction: (actionId: string, params: Record<string, unknown>) => void
}): JSX.Element {
  const { field, index, labels } = props
  const isFrozenHere = index < props.frozenCount
  // "Freeze up to here" sets the boundary just past this column; if the column
  // is already inside the frozen range, the item unfreezes back to its left.
  const freezeCount = isFrozenHere ? index : index + 1
  const Item = (p: { onClick: () => void; danger?: boolean; children: ReactNode }): JSX.Element => (
    <button
      type="button"
      role="menuitem"
      onClick={p.onClick}
      className={[
        'block w-full px-3 py-1.5 text-left text-sm hover:bg-muted',
        p.danger ? 'text-destructive' : 'text-foreground',
      ].join(' ')}
    >
      {p.children}
    </button>
  )
  return (
    <div
      role="menu"
      data-table-menu="column"
      className="absolute left-1 top-full z-50 mt-1 w-48 rounded-md border border-border bg-popover py-1 shadow-md"
    >
      <Item onClick={() => props.onAction(COLUMN_SORT_ACTION, { field, direction: 'asc' })}>
        {labels.sortAsc}
      </Item>
      <Item onClick={() => props.onAction(COLUMN_SORT_ACTION, { field, direction: 'desc' })}>
        {labels.sortDesc}
      </Item>
      {props.sorted ? (
        <Item onClick={() => props.onAction(COLUMN_SORT_ACTION, { field, direction: null })}>
          {labels.clearSort}
        </Item>
      ) : null}
      <div className="my-1 border-t border-border" />
      <Item onClick={() => props.onAction(COLUMN_FILTER_ACTION, { field })}>{labels.filter}</Item>
      <Item onClick={() => props.onAction(COLUMN_FREEZE_ACTION, { field, frozenCount: freezeCount })}>
        {isFrozenHere ? labels.unfreeze : labels.freeze}
      </Item>
      <Item onClick={() => props.onAction(COLUMN_HIDE_ACTION, { field })}>{labels.hide}</Item>
      {props.editable ? (
        <>
          <div className="my-1 border-t border-border" />
          <Item onClick={() => props.onAction(COLUMN_RENAME_ACTION, { field })}>{labels.rename}</Item>
          <Item onClick={() => props.onAction(COLUMN_RETYPE_ACTION, { field })}>{labels.editType}</Item>
          <Item onClick={() => props.onAction(COLUMN_INSERT_ACTION, { field, side: 'left' })}>
            {labels.insertLeft}
          </Item>
          <Item onClick={() => props.onAction(COLUMN_INSERT_ACTION, { field, side: 'right' })}>
            {labels.insertRight}
          </Item>
          <Item onClick={() => props.onAction(COLUMN_DUPLICATE_ACTION, { field })}>
            {labels.duplicateColumn}
          </Item>
          <Item danger onClick={() => props.onAction(COLUMN_DELETE_ACTION, { field })}>
            {labels.deleteColumn}
          </Item>
        </>
      ) : null}
    </div>
  )
}

/**
 * Resize handle — a 4 px-wide grab strip on the right edge of each
 * header. TanStack's `getResizeHandler` returns a single handler that
 * works for both mouse and touch.
 */
function ResizeHandle(props: {
  onMouseDown: (event: unknown) => void
  onTouchStart: (event: unknown) => void
  isResizing: boolean
}): JSX.Element {
  return (
    <span
      onMouseDown={(e) => {
        e.stopPropagation()
        props.onMouseDown(e)
      }}
      onTouchStart={(e) => {
        e.stopPropagation()
        props.onTouchStart(e)
      }}
      onClick={(e) => e.stopPropagation()}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      className={[
        'absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none',
        'opacity-0 transition-opacity group-hover/header:opacity-100',
        props.isResizing ? 'opacity-100 bg-primary/60' : 'bg-border',
      ].join(' ')}
    />
  )
}

/**
 * Hover-revealed left-gutter controls. At rest, doc tables show the row
 * number (`showNumber`); on hover it swaps to the drag handle + more-menu
 * button. The menu's items are host-driven: `Duplicate` (doc) / `Open`
 * (legacy apps/web, when a `rowAction` exists) / `Delete`. Outside-click close
 * is owned by the parent `Table` via the `[data-table-menu]` listener.
 */
function RowGutter(props: {
  rowId: string
  rowNumber: number
  showNumber: boolean
  showOpen: boolean
  showDuplicate: boolean
  labels: ColumnMenuLabels
  menuOpen: boolean
  onToggleMenu: () => void
  onAction: (actionId: string) => void
}): JSX.Element {
  return (
    <div className="relative flex h-full items-start justify-center gap-0.5 px-1 pt-1.5">
      {props.showNumber ? (
        <span
          aria-hidden
          className="absolute left-0 right-0 top-1.5 text-center text-xs tabular-nums text-muted-foreground/50 transition-opacity group-hover/row:opacity-0"
        >
          {props.rowNumber}
        </span>
      ) : null}
      <span
        aria-label="Drag row"
        title="Drag row"
        className="flex h-5 w-4 cursor-grab items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100"
      >
        <GripVerticalIcon />
      </span>
      <button
        type="button"
        aria-label="Row menu"
        aria-haspopup="menu"
        aria-expanded={props.menuOpen}
        onClick={props.onToggleMenu}
        data-table-menu="row-trigger"
        className="flex h-5 w-4 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
      >
        <MoreHorizontalIcon />
      </button>
      {props.menuOpen ? (
        <div
          role="menu"
          data-table-menu="row"
          className="absolute left-6 top-0 z-40 w-32 rounded-md border border-border bg-popover py-1 text-sm shadow-md"
        >
          {props.showOpen ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => props.onAction(ROW_MENU_OPEN_ACTION)}
              className="block w-full px-3 py-1.5 text-left hover:bg-muted"
            >
              {props.labels.openRow}
            </button>
          ) : null}
          {props.showDuplicate ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => props.onAction(ROW_MENU_DUPLICATE_ACTION)}
              className="block w-full px-3 py-1.5 text-left hover:bg-muted"
            >
              {props.labels.duplicateRow}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => props.onAction(ROW_MENU_DELETE_ACTION)}
            className="block w-full px-3 py-1.5 text-left text-destructive hover:bg-muted"
          >
            {props.labels.deleteRow}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function GripVerticalIcon(): JSX.Element {
  // Six-dot grip glyph (2x3), aligned with the Notion-ish handle in
  // app-web's block-shell.
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <circle cx="6" cy="4" r="1" fill="currentColor" />
      <circle cx="6" cy="8" r="1" fill="currentColor" />
      <circle cx="6" cy="12" r="1" fill="currentColor" />
      <circle cx="10" cy="4" r="1" fill="currentColor" />
      <circle cx="10" cy="8" r="1" fill="currentColor" />
      <circle cx="10" cy="12" r="1" fill="currentColor" />
    </svg>
  )
}

function MoreHorizontalIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <circle cx="3" cy="8" r="1.3" fill="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <circle cx="13" cy="8" r="1.3" fill="currentColor" />
    </svg>
  )
}

function ChevronDownIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  )
}

function PlusIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}
