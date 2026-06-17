/**
 * [COMP:views/gallery] Gallery widget — card grid dispatch + cover-image
 * resolution + click action + responsive grid breakpoints.
 *
 * Following the package convention (`board.test.tsx`, `table.test.tsx`):
 *   * Dispatch + prop-forwarding assertions inspect React.createElement
 *     output directly — no DOM.
 *   * Layout / cover-image / class-string assertions go through
 *     `renderToStaticMarkup` so the test can match on rendered HTML
 *     (mirrors the property-files test approach).
 */

import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { A2UIColumn, A2UIRow, GalleryWidget } from '@sidanclaw/core'
import type { FileRef } from '../types.js'
import { renderWidget } from '../render.js'
import { Gallery, GRID_CLASSES } from '../widgets/Gallery.js'

function elementType(el: ReactElement): string {
  const t = el.type
  if (typeof t === 'string') return t
  if (typeof t === 'function') return (t as { name?: string }).name ?? 'anonymous'
  return String(t)
}

// ── Fixtures ──────────────────────────────────────────────────────────

function img(name: string): FileRef {
  return {
    bucket: 'file_cache',
    path: `img-${name}`,
    mimeType: 'image/png',
    sizeBytes: 4096,
    name,
  }
}

function pdf(name: string): FileRef {
  return {
    bucket: 'file_cache',
    path: `pdf-${name}`,
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    name,
  }
}

const TITLE_COL: A2UIColumn = { field: 'title', header: 'Title' }
const STATUS_COL: A2UIColumn = { field: 'status', header: 'Status' }
const DUE_COL: A2UIColumn = { field: 'due', header: 'Due', kind: 'date' }
const COVER_COL: A2UIColumn = { field: 'files', header: 'Files', kind: 'files' }

function row(overrides: Partial<A2UIRow>): A2UIRow {
  return {
    id: 'r1',
    title: 'Acme deck',
    status: { type: 'badge', text: 'todo' },
    due: { type: 'date', iso: '2026-06-01' },
    files: { type: 'files', files: [img('cover.png')] },
    ...overrides,
  }
}

const SAMPLE: GalleryWidget = {
  type: 'gallery',
  rows: [row({})],
  columns: [TITLE_COL, COVER_COL, STATUS_COL, DUE_COL],
  rowAction: { id: 'open-entity', params: { entity: 'assets' } },
}

// ── Dispatch ──────────────────────────────────────────────────────────

describe('[COMP:views/gallery] Gallery dispatch', () => {
  it('dispatches Gallery for type=gallery', () => {
    const el = renderWidget(SAMPLE)
    expect(elementType(el)).toBe('Gallery')
  })

  it('forwards rows, columns, coverColumnId, rowAction, emptyMessage, onAction', () => {
    const onAction = () => undefined
    const widget: GalleryWidget = {
      ...SAMPLE,
      coverColumnId: 'files',
      emptyMessage: 'Nothing yet.',
    }
    const el = renderWidget(widget, onAction)
    const props = el.props as {
      rows: typeof widget.rows
      columns: typeof widget.columns
      coverColumnId?: string
      rowAction?: typeof widget.rowAction
      emptyMessage?: string
      onAction?: typeof onAction
    }
    expect(props.rows).toEqual(widget.rows)
    expect(props.columns).toEqual(widget.columns)
    expect(props.coverColumnId).toBe('files')
    expect(props.rowAction).toEqual(widget.rowAction)
    expect(props.emptyMessage).toBe('Nothing yet.')
    expect(props.onAction).toBe(onAction)
  })
})

// ── Empty state ───────────────────────────────────────────────────────

describe('[COMP:views/gallery] empty state', () => {
  it('renders the default empty message when rows is empty', () => {
    const html = renderToStaticMarkup(
      Gallery({ rows: [], columns: [TITLE_COL] }) as ReactElement,
    )
    expect(html).toContain('No items.')
    expect(html).toContain('role="status"')
  })

  it('renders a custom empty message when supplied', () => {
    const html = renderToStaticMarkup(
      Gallery({
        rows: [],
        columns: [TITLE_COL],
        emptyMessage: 'No assets yet — drop one to get started.',
      }) as ReactElement,
    )
    expect(html).toContain('No assets yet — drop one to get started.')
  })
})

// ── Cover image ───────────────────────────────────────────────────────

describe('[COMP:views/gallery] cover image', () => {
  it('renders an <img> from a kind="files" column when present', () => {
    const html = renderToStaticMarkup(
      Gallery({
        rows: [row({})],
        columns: [TITLE_COL, COVER_COL, STATUS_COL],
      }) as ReactElement,
    )
    expect(html).toMatch(/<img[^>]+src="[^"]*\/api\/files\/img-cover\.png\/preview"/)
    expect(html).toMatch(/loading="lazy"/)
    expect(html).toMatch(/aspect-\[16\/9\]/)
  })

  it('renders the placeholder gradient when no image is present', () => {
    const html = renderToStaticMarkup(
      Gallery({
        rows: [row({ files: { type: 'files', files: [pdf('only.pdf')] } })],
        columns: [TITLE_COL, COVER_COL],
      }) as ReactElement,
    )
    // No <img> tag for the cover, and the gradient utility class shows up.
    expect(html).not.toMatch(/<img[^>]+\/api\/files\/img-/)
    expect(html).toMatch(/bg-gradient-to-br/)
  })

  it('renders the placeholder gradient when no files column exists', () => {
    const html = renderToStaticMarkup(
      Gallery({
        rows: [{ id: 'r1', title: 'No cover row' }],
        columns: [TITLE_COL, STATUS_COL],
      }) as ReactElement,
    )
    expect(html).not.toMatch(/<img/)
    expect(html).toMatch(/bg-gradient-to-br/)
  })

  it('respects coverColumnId override over kind="files" auto-pick', () => {
    const extraFilesCol: A2UIColumn = { field: 'other', header: 'Other', kind: 'files' }
    const html = renderToStaticMarkup(
      Gallery({
        rows: [
          {
            id: 'r1',
            title: 'pick the second',
            files: { type: 'files', files: [img('first.png')] },
            other: { type: 'files', files: [img('second.png')] },
          },
        ],
        columns: [TITLE_COL, COVER_COL, extraFilesCol],
        coverColumnId: 'other',
      }) as ReactElement,
    )
    // Only the override column's image is rendered as the cover.
    expect(html).toMatch(/img-second\.png/)
  })

  it('respects a column.cover=true flag when no kind="files" wins first', () => {
    const flagged: A2UIColumn = {
      field: 'hero',
      header: 'Hero',
      kind: 'files',
      cover: true,
    }
    const html = renderToStaticMarkup(
      Gallery({
        rows: [
          {
            id: 'r1',
            title: 't',
            hero: { type: 'files', files: [img('hero.png')] },
          },
        ],
        columns: [TITLE_COL, flagged],
      }) as ReactElement,
    )
    expect(html).toMatch(/img-hero\.png/)
  })
})

// ── Grid breakpoints ──────────────────────────────────────────────────

describe('[COMP:views/gallery] responsive grid classes', () => {
  it('emits 1 / 2 / 3 / 4 column Tailwind classes', () => {
    expect(GRID_CLASSES).toContain('grid-cols-1')
    expect(GRID_CLASSES).toContain('md:grid-cols-2')
    expect(GRID_CLASSES).toContain('lg:grid-cols-3')
    expect(GRID_CLASSES).toContain('xl:grid-cols-4')
  })

  it('renders the grid wrapper with the breakpoint classes', () => {
    const html = renderToStaticMarkup(
      Gallery({ rows: [row({})], columns: [TITLE_COL] }) as ReactElement,
    )
    expect(html).toContain('grid-cols-1')
    expect(html).toContain('md:grid-cols-2')
    expect(html).toContain('lg:grid-cols-3')
    expect(html).toContain('xl:grid-cols-4')
  })
})

// ── Click action ─────────────────────────────────────────────────────

/**
 * Invoke the inner GalleryCard component by walking the React element
 * tree: Gallery returns a grid <div> whose children are GalleryCard
 * function-element references. We invoke the GalleryCard with its
 * captured props to inspect the rendered card div's onClick wiring.
 */
function invokeFirstCard(galleryEl: ReactElement): ReactElement {
  const grid = galleryEl.props as { children: ReactElement[] }
  const card = grid.children[0]
  // Each child is a React element whose `.type` is the GalleryCard
  // function — invoke it to render the actual card div.
  const Component = card.type as (props: unknown) => ReactElement
  return Component(card.props)
}

describe('[COMP:views/gallery] card click action', () => {
  it('fires rowAction.id with { rowId } when a card is clicked', () => {
    const onAction = vi.fn()
    const el = Gallery({
      rows: [row({ id: 'asset-42' })],
      columns: [TITLE_COL, COVER_COL],
      rowAction: { id: 'open-entity', params: { entity: 'assets' } },
      onAction,
    }) as ReactElement
    const cardDiv = invokeFirstCard(el)
    const onClick = (cardDiv.props as { onClick?: () => void }).onClick
    expect(typeof onClick).toBe('function')
    onClick?.()
    expect(onAction).toHaveBeenCalledWith('open-entity', {
      entity: 'assets',
      rowId: 'asset-42',
    })
  })

  it('falls back to row index when row.id is not a string', () => {
    const onAction = vi.fn()
    const el = Gallery({
      // No `id` on the row → renderer uses `row-0` as the fallback.
      rows: [{ title: 'unkeyed' }],
      columns: [TITLE_COL],
      rowAction: { id: 'open-entity' },
      onAction,
    }) as ReactElement
    const cardDiv = invokeFirstCard(el)
    ;(cardDiv.props as { onClick: () => void }).onClick()
    expect(onAction).toHaveBeenCalledWith('open-entity', { rowId: 'row-0' })
  })

  it('does not wire onClick when rowAction is omitted', () => {
    const el = Gallery({
      rows: [row({})],
      columns: [TITLE_COL],
    }) as ReactElement
    const cardDiv = invokeFirstCard(el)
    const onClick = (cardDiv.props as { onClick?: () => void }).onClick
    expect(onClick).toBeUndefined()
  })

  it('does not wire onClick when onAction is omitted', () => {
    const el = Gallery({
      rows: [row({})],
      columns: [TITLE_COL],
      rowAction: { id: 'open-entity' },
    }) as ReactElement
    const cardDiv = invokeFirstCard(el)
    const onClick = (cardDiv.props as { onClick?: () => void }).onClick
    expect(onClick).toBeUndefined()
  })

  it('marks clickable cards with role="button" and tabIndex=0', () => {
    const html = renderToStaticMarkup(
      Gallery({
        rows: [row({})],
        columns: [TITLE_COL],
        rowAction: { id: 'open-entity' },
        onAction: () => undefined,
      }) as ReactElement,
    )
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })
})

// ── Multi-row / secondary fields ──────────────────────────────────────

describe('[COMP:views/gallery] multi-row + secondary fields', () => {
  it('renders one card per row', () => {
    const el = Gallery({
      rows: [
        row({ id: 'r1', title: 'Alpha' }),
        row({ id: 'r2', title: 'Beta' }),
        row({ id: 'r3', title: 'Gamma' }),
      ],
      columns: [TITLE_COL, COVER_COL, STATUS_COL],
    }) as ReactElement
    const grid = el.props as { children: ReactElement[] }
    expect(grid.children).toHaveLength(3)
  })

  it('renders the title with line-clamp-2 for long values', () => {
    const html = renderToStaticMarkup(
      Gallery({
        rows: [row({ title: 'A very long title that should clamp to two lines on most screens' })],
        columns: [TITLE_COL],
      }) as ReactElement,
    )
    expect(html).toContain('line-clamp-2')
    expect(html).toContain('A very long title')
  })

  it('emits a data-row-id attribute matching the row id', () => {
    const html = renderToStaticMarkup(
      Gallery({
        rows: [row({ id: 'asset-99' })],
        columns: [TITLE_COL],
      }) as ReactElement,
    )
    expect(html).toContain('data-row-id="asset-99"')
  })

  it('caps secondary fields at 3 even when more columns are provided', () => {
    // Three extra columns past title + cover.
    const extras: A2UIColumn[] = [
      { field: 'a', header: 'A' },
      { field: 'b', header: 'B' },
      { field: 'c', header: 'C' },
      { field: 'd', header: 'D' },
      { field: 'e', header: 'E' },
    ]
    const html = renderToStaticMarkup(
      Gallery({
        rows: [
          {
            id: 'r1',
            title: 'long row',
            a: 'A-value',
            b: 'B-value',
            c: 'C-value',
            d: 'D-value',
            e: 'E-value',
          },
        ],
        columns: [TITLE_COL, ...extras],
      }) as ReactElement,
    )
    expect(html).toContain('A-value')
    expect(html).toContain('B-value')
    expect(html).toContain('C-value')
    // D and E exceed the secondary cap and are dropped from card chrome.
    expect(html).not.toContain('D-value')
    expect(html).not.toContain('E-value')
  })

  it('excludes the cover column from the secondary fields list', () => {
    // The "files" column is the cover; it should not appear as a secondary
    // muted line under the title even though it isn't the first column.
    // The FilesProperty's Cell renders file-name pills with the
    // `bg-muted/60` chrome — that chrome must NOT show up in the body,
    // only the bare cover <img> (which carries `alt="cover.png"`).
    const html = renderToStaticMarkup(
      Gallery({
        rows: [row({})],
        columns: [TITLE_COL, COVER_COL, STATUS_COL, DUE_COL],
      }) as ReactElement,
    )
    // FilePill chrome (`bg-muted/60`) is the structural fingerprint of
    // a secondary-rendered files cell. Its absence proves the cover
    // column was filtered out.
    expect(html).not.toContain('bg-muted/60')
    // Status badge text and the date kind both appear as secondary.
    expect(html).toContain('todo')
  })
})
