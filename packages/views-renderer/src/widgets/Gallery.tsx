/**
 * A2UI Gallery — card-grid surface for Files-heavy entities.
 *
 * Same `rows + columns` shape as Table — the difference is purely
 * presentational: each row becomes a card with a 16:9 cover image
 * (resolved through the Files property's `getCoverImageRef` so the
 * "first image wins" policy lives in one place), a title (first
 * column), and up to three secondary muted fields (remaining columns
 * in order). Cards are clickable when `rowAction` is wired.
 *
 * Cover-column resolution order (first match wins):
 *   1. `coverColumnId` (explicit override on the GalleryWidget)
 *   2. The first column with `cover: true`
 *   3. The first column with `kind: 'files'`
 *   4. None → every card renders the placeholder gradient
 *
 * Grid breakpoints (Tailwind, theme tokens only):
 *   `< 640px` (default) → 1 column
 *   `md (>= 768px)`     → 2 columns
 *   `lg (>= 1024px)`    → 3 columns
 *   `xl (>= 1280px)`    → 4 columns
 *
 * Card chrome:
 *   - 16:9 cover (lazy-loaded `<img>` via `getCoverImageRef`) or a
 *     placeholder gradient. The image element itself sets
 *     `loading="lazy"` so off-screen rows defer fetch.
 *   - Title: medium font weight, 2-line truncate (`line-clamp-2`).
 *   - Up to three secondary fields: small, muted, single-line truncate
 *     each — extra columns are silently dropped from card chrome (the
 *     full row data still ships in the payload).
 *   - Hover: subtle elevation + scale-105 transition.
 *
 * Click handling: when `rowAction` is set and `onAction` is wired, a
 * click fires `onAction(rowAction.id, { ...rowAction.params, rowId })`.
 * The `rowId` comes from the row's `id` field (mirrors Table's row id
 * resolution — server bindings emit a stable `id` per row).
 *
 * [COMP:views/gallery]
 */

import { type JSX } from 'react'
import type {
  A2UIColumn,
  A2UIRow,
  A2UIRowValue,
  ActionRef,
  FileRef,
  OnActionHandler,
} from '../types.js'
import { renderRowValue } from '../render.js'
import { getCoverImageRef, PROPERTIES } from '../properties/index.js'

export type GalleryProps = {
  rows: A2UIRow[]
  columns: A2UIColumn[]
  coverColumnId?: string
  rowAction?: ActionRef
  emptyMessage?: string
  onAction?: OnActionHandler
}

const DEFAULT_EMPTY = 'No items.'
const MAX_SECONDARY_FIELDS = 3

/**
 * Responsive grid breakpoints. Pulled out so the test suite can assert
 * the exact class string — drift here means card grids stop reflowing
 * correctly across screen sizes.
 */
export const GRID_CLASSES =
  'grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

export function Gallery(props: GalleryProps): JSX.Element {
  const coverColumn = resolveCoverColumn(props.columns, props.coverColumnId)

  // Title is the first column by convention. The remaining columns
  // (minus the cover column, which is rendered as the cover image)
  // are the secondary fields, capped to MAX_SECONDARY_FIELDS.
  const titleColumn: A2UIColumn | undefined = props.columns[0]
  const secondaryColumns: A2UIColumn[] = props.columns
    .slice(1)
    .filter((c) => c.field !== coverColumn?.field)
    .slice(0, MAX_SECONDARY_FIELDS)

  if (props.rows.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-border bg-muted/20 px-6 py-10 text-center text-sm text-muted-foreground"
        role="status"
      >
        {props.emptyMessage ?? DEFAULT_EMPTY}
      </div>
    )
  }

  return (
    <div className={GRID_CLASSES}>
      {props.rows.map((row, idx) => {
        const rowId = resolveRowId(row, idx)
        return (
          <GalleryCard
            key={rowId}
            row={row}
            rowId={rowId}
            titleColumn={titleColumn}
            coverColumn={coverColumn}
            secondaryColumns={secondaryColumns}
            rowAction={props.rowAction}
            onAction={props.onAction}
          />
        )
      })}
    </div>
  )
}

// ── Card ──────────────────────────────────────────────────────────────

type GalleryCardProps = {
  row: A2UIRow
  rowId: string
  titleColumn: A2UIColumn | undefined
  coverColumn: A2UIColumn | undefined
  secondaryColumns: A2UIColumn[]
  rowAction?: ActionRef
  onAction?: OnActionHandler
}

function GalleryCard(props: GalleryCardProps): JSX.Element {
  const coverRef = props.coverColumn
    ? getCoverImageRef(props.row[props.coverColumn.field] ?? null)
    : null
  const clickable = Boolean(props.rowAction && props.onAction)

  const handleClick = (): void => {
    if (!props.rowAction || !props.onAction) return
    props.onAction(props.rowAction.id, {
      ...props.rowAction.params,
      rowId: props.rowId,
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!clickable) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleClick()
    }
  }

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? handleClick : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      className={[
        'group flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-sm',
        'transition-transform duration-150 ease-out',
        clickable
          ? 'cursor-pointer hover:scale-105 hover:shadow-md focus-visible:scale-105 focus-visible:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
          : '',
      ]
        .join(' ')
        .trim()}
      data-row-id={props.rowId}
    >
      <GalleryCover refValue={coverRef} />
      <div className="flex flex-col gap-1 px-3 py-2.5">
        {props.titleColumn ? (
          <GalleryTitle value={props.row[props.titleColumn.field] ?? null} />
        ) : null}
        {props.secondaryColumns.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {props.secondaryColumns.map((col) => (
              <GallerySecondary
                key={col.field}
                column={col}
                value={props.row[col.field] ?? null}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── Cover ─────────────────────────────────────────────────────────────

/**
 * Resolve a `FileRef` to a browser-loadable preview URL. Mirrors the
 * `previewUrlFor` policy in `properties/files.tsx` — kept private to
 * this widget so the property module stays untouched (per task
 * constraint). The legacy `file_cache` bucket streams via the existing
 * `/api/files/:id/preview` route; true GCS refs return `null` until
 * the signed-URL endpoint lands.
 */
function previewUrlFor(ref: FileRef): string | null {
  const env =
    (typeof process !== 'undefined'
      ? (process as { env?: Record<string, string | undefined> }).env
      : undefined) ?? {}
  const base = env.NEXT_PUBLIC_API_URL ?? ''
  if (ref.bucket === 'file_cache') {
    const prefix = base.length > 0 ? base.replace(/\/+$/, '') : ''
    return `${prefix}/api/files/${encodeURIComponent(ref.path)}/preview`
  }
  return null
}

function GalleryCover(props: { refValue: FileRef | null }): JSX.Element {
  if (!props.refValue) {
    return (
      <div
        aria-hidden
        className="block aspect-[16/9] w-full bg-gradient-to-br from-muted via-muted/70 to-muted/40"
      />
    )
  }
  const url = previewUrlFor(props.refValue)
  if (!url) {
    return (
      <div
        aria-label={props.refValue.name}
        className="block aspect-[16/9] w-full bg-gradient-to-br from-muted via-muted/70 to-muted/40"
      />
    )
  }
  return (
    <img
      src={url}
      alt={props.refValue.name}
      loading="lazy"
      className="block aspect-[16/9] w-full bg-muted object-cover"
    />
  )
}

// ── Title / secondary fields ─────────────────────────────────────────

function GalleryTitle(props: { value: A2UIRowValue }): JSX.Element {
  // Pull a flat title string when possible so we can apply
  // `line-clamp-2`. Widget values (badge/relation/etc.) keep their
  // native rendering — they're rare in column 0 but supported.
  const flat = flattenForTitle(props.value)
  if (flat !== null) {
    return (
      <h3 className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
        {flat}
      </h3>
    )
  }
  return (
    <h3 className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
      {renderRowValue(props.value)}
    </h3>
  )
}

function GallerySecondary(props: {
  column: A2UIColumn
  value: A2UIRowValue
}): JSX.Element {
  const property = props.column.kind ? PROPERTIES[props.column.kind] ?? null : null
  return (
    <div className="truncate text-xs text-muted-foreground">
      {property ? (
        <property.Cell value={props.value} />
      ) : (
        renderRowValue(props.value)
      )}
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Pick the cover column in resolution order (see file header).
 */
function resolveCoverColumn(
  columns: A2UIColumn[],
  coverColumnId: string | undefined,
): A2UIColumn | undefined {
  if (coverColumnId) {
    const explicit = columns.find((c) => c.field === coverColumnId)
    if (explicit) return explicit
  }
  const flagged = columns.find((c) => c.cover === true)
  if (flagged) return flagged
  return columns.find((c) => c.kind === 'files')
}

/**
 * Stable row identity. Mirrors Table's `getRowId` — `row.id` when it's
 * a string, falls through to the array index otherwise so React keys
 * stay stable across re-renders on rows missing an `id`.
 */
function resolveRowId(row: A2UIRow, idx: number): string {
  const raw = row['id']
  if (typeof raw === 'string') return raw
  return `row-${idx}`
}

/**
 * Reduce a row value to a flat string for the title slot. Returns
 * `null` when the value is a widget that should keep its native
 * rendering (e.g. relation pills, which carry click affordances). The
 * cover-image case lands here for non-files columns; the actual cover
 * comes from `getCoverImageRef`.
 */
function flattenForTitle(value: A2UIRowValue): string | null {
  if (value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  switch (value.type) {
    case 'text':
    case 'heading':
    case 'badge':
    case 'button':
      return value.text
    case 'relation':
      return value.label
    case 'person':
      return value.name
    case 'date':
      return value.iso ?? ''
    case 'number':
      return value.value === null ? '' : String(value.value)
    default:
      return null
  }
}
