/**
 * [COMP:views/list] List widget — compact one-line row dispatch,
 * empty-state copy, primary/secondary cell layout, row-click action.
 *
 * Mirrors the testing style of `table.test.tsx` + `table.sticky.test.tsx`:
 * we lean on React's element tree for dispatch/prop wiring and on
 * `react-dom/server`'s `renderToStaticMarkup` for class-name / DOM-
 * shape assertions (no DOM is installed in this workspace).
 */

import { describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderWidget } from '../render.js'
import { List } from '../widgets/List.js'
import type { A2UIColumn, A2UIRow, ListWidget } from '../types.js'

function elementType(el: ReactElement): string {
  const t = el.type
  if (typeof t === 'string') return t
  if (typeof t === 'function') return (t as { name?: string }).name ?? 'anonymous'
  return String(t)
}

function htmlFor(props: Parameters<typeof List>[0]): string {
  return renderToStaticMarkup(<List {...props} />)
}

const COLUMNS: A2UIColumn[] = [
  { field: 'title', header: 'Title' },
  { field: 'owner', header: 'Owner' },
  { field: 'due', header: 'Due' },
]

const ROWS: A2UIRow[] = [
  { id: 't1', title: 'Design review', owner: 'alice', due: '2026-05-20' },
  { id: 't2', title: 'Sprint planning', owner: 'bob', due: '2026-05-21' },
  { id: 't3', title: 'All hands', owner: 'cara', due: null },
]

const SAMPLE_LIST: ListWidget = {
  type: 'list',
  columns: COLUMNS,
  rows: ROWS,
  rowAction: { id: 'open-entity', params: { entity: 'tasks' } },
}

describe('[COMP:views/list] List dispatch', () => {
  it('dispatches List component for type=list', () => {
    const el = renderWidget(SAMPLE_LIST)
    expect(elementType(el)).toBe('List')
  })

  it('forwards columns, rows, rowAction, emptyMessage, and onAction', () => {
    const onAction = () => undefined
    const withEmpty: ListWidget = { ...SAMPLE_LIST, emptyMessage: 'Nothing yet.' }
    const el = renderWidget(withEmpty, onAction)
    const props = el.props as {
      columns: typeof COLUMNS
      rows: typeof ROWS
      rowAction?: typeof SAMPLE_LIST.rowAction
      emptyMessage?: string
      onAction?: typeof onAction
    }
    expect(props.columns).toEqual(COLUMNS)
    expect(props.rows).toEqual(ROWS)
    expect(props.rowAction).toEqual(SAMPLE_LIST.rowAction)
    expect(props.emptyMessage).toBe('Nothing yet.')
    expect(props.onAction).toBe(onAction)
  })
})

describe('[COMP:views/list] Empty state', () => {
  it('renders the default "No rows." copy when rows is empty', () => {
    const html = htmlFor({ columns: COLUMNS, rows: [] })
    expect(html).toMatch(/No rows\./)
    expect(html).toMatch(/data-a2ui-list-empty/)
    expect(html).not.toMatch(/<ul[^>]*data-a2ui-list[^>]*>/)
  })

  it('honors a custom emptyMessage', () => {
    const html = htmlFor({
      columns: COLUMNS,
      rows: [],
      emptyMessage: 'Add a task to get started',
    })
    expect(html).toMatch(/Add a task to get started/)
    expect(html).not.toMatch(/No rows\./)
  })
})

describe('[COMP:views/list] Row rendering', () => {
  it('renders a single row as a list item', () => {
    const html = htmlFor({
      columns: COLUMNS,
      rows: [ROWS[0]!],
    })
    expect(html).toMatch(/<ul[^>]*data-a2ui-list/)
    // One <li> per row, no more.
    const liMatches = html.match(/<li\b/g) ?? []
    expect(liMatches).toHaveLength(1)
    expect(html).toMatch(/data-a2ui-list-row="t1"/)
    expect(html).toMatch(/Design review/)
  })

  it('renders one <li> per row for a multi-row payload', () => {
    const html = htmlFor({ columns: COLUMNS, rows: ROWS })
    const liMatches = html.match(/<li\b/g) ?? []
    expect(liMatches).toHaveLength(ROWS.length)
    expect(html).toMatch(/Design review/)
    expect(html).toMatch(/Sprint planning/)
    expect(html).toMatch(/All hands/)
  })

  it('marks the primary column with medium font weight + truncate', () => {
    const html = htmlFor({ columns: COLUMNS, rows: [ROWS[0]!] })
    // Primary span wraps the title; classes carry font-medium + truncate.
    expect(html).toMatch(/<span[^>]*class="[^"]*\bfont-medium\b[^"]*"/)
    expect(html).toMatch(/<span[^>]*class="[^"]*\btruncate\b[^"]*"/)
  })

  it('renders secondary columns with muted text + data attribute per field', () => {
    const html = htmlFor({ columns: COLUMNS, rows: [ROWS[0]!] })
    // Each secondary column gets a data-attribute marker.
    expect(html).toMatch(/data-a2ui-list-secondary="owner"/)
    expect(html).toMatch(/data-a2ui-list-secondary="due"/)
    // The wrapper carries muted-foreground.
    expect(html).toMatch(/text-muted-foreground/)
  })

  it('separates multiple secondary columns with a comma', () => {
    const html = htmlFor({ columns: COLUMNS, rows: [ROWS[0]!] })
    // The literal "," appears between owner + due (3 cols → 1 comma).
    const commaMatches = html.match(/>,</g) ?? []
    expect(commaMatches.length).toBeGreaterThanOrEqual(1)
  })

  it('renders no secondary wrapper when only one column is supplied', () => {
    const html = htmlFor({
      columns: [{ field: 'title', header: 'Title' }],
      rows: [{ id: 't1', title: 'Only the title' }],
    })
    expect(html).toMatch(/Only the title/)
    expect(html).not.toMatch(/data-a2ui-list-secondary/)
  })

  it('falls back to the array index when row.id is missing', () => {
    const html = htmlFor({
      columns: COLUMNS,
      rows: [{ title: 'No id row' }],
    })
    expect(html).toMatch(/data-a2ui-list-row="0"/)
  })

  it('uses bg-accent/40 for hover tint via Tailwind class', () => {
    const html = htmlFor({ columns: COLUMNS, rows: ROWS })
    expect(html).toMatch(/hover:bg-accent\/40/)
  })
})

describe('[COMP:views/list] Row click action', () => {
  it('fires onAction with rowAction.id + merged params + rowId when row clicked', () => {
    const onAction = vi.fn()
    // Walk the rendered element tree to pluck the row's onClick handler.
    const el = (
      <List
        columns={COLUMNS}
        rows={[ROWS[0]!]}
        rowAction={{ id: 'open-entity', params: { entity: 'tasks' } }}
        onAction={onAction}
      />
    )
    type ListReturn = ReactElement & {
      props: { children: ReactElement[] }
    }
    // The List component returns a <ul> directly; its children are the
    // mapped <li> elements. Invoke the first li's onClick.
    const ul = (el.type as (props: typeof el.props) => ListReturn)(el.props)
    const firstRow = ul.props.children[0] as ReactElement & {
      props: { onClick?: () => void }
    }
    firstRow.props.onClick?.()
    expect(onAction).toHaveBeenCalledWith('open-entity', {
      entity: 'tasks',
      rowId: 't1',
    })
  })

  it('does not attach an onClick when rowAction is omitted', () => {
    const html = htmlFor({
      columns: COLUMNS,
      rows: ROWS,
    })
    // Without rowAction, the row should not be marked cursor-pointer.
    expect(html).not.toMatch(/cursor-pointer/)
  })

  it('does not attach an onClick when onAction is omitted (even with rowAction)', () => {
    const html = htmlFor({
      columns: COLUMNS,
      rows: ROWS,
      rowAction: { id: 'open-entity' },
    })
    // onAction is the wiring; without it, the click is a no-op so we
    // do not mark the row as clickable.
    expect(html).not.toMatch(/cursor-pointer/)
  })
})

describe('[COMP:views/list] Secondary column truncation', () => {
  it('every secondary cell carries the truncate class', () => {
    const html = htmlFor({ columns: COLUMNS, rows: [ROWS[0]!] })
    // Walk the secondary spans — each should carry the truncate class.
    // React serializes attributes in source order; class comes before
    // data-a2ui-list-secondary so we match the full opening tag and
    // assert both attrs land together.
    const secondaryMatches = html.match(
      /<span[^>]*data-a2ui-list-secondary="[^"]*"[^>]*>/g,
    ) ?? []
    expect(secondaryMatches.length).toBeGreaterThan(0)
    for (const m of secondaryMatches) {
      expect(m).toMatch(/truncate/)
    }
  })
})
