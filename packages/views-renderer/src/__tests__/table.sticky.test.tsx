/**
 * [COMP:views/table] Phase 3 — sticky header + frozen first column +
 * "+ Add row" affordance assertions.
 *
 * No DOM (matches `table.test.tsx`); we mount `<Table />` to a React
 * element tree and walk it to assert the chrome props made it through
 * the render path. TanStack Table v8 runs synchronously inside
 * `useReactTable`, so renderToStaticMarkup gives us the post-mount HTML
 * for class-name assertions without needing a DOM.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Table } from '../widgets/Table.js'
import type { A2UIColumn, A2UIRow } from '../types.js'

const COLUMNS: A2UIColumn[] = [
  { field: 'title', header: 'Title' },
  { field: 'status', header: 'Status' },
]

const ROWS: A2UIRow[] = [
  { id: 't1', title: 'Buy milk', status: 'todo' },
  { id: 't2', title: 'Email Acme', status: 'doing' },
]

function htmlFor(props: Parameters<typeof Table>[0]): string {
  return renderToStaticMarkup(<Table {...props} />)
}

describe('[COMP:views/table] Phase 3 sticky header', () => {
  it('thead carries the `sticky` class and an opaque background', () => {
    const html = htmlFor({ columns: COLUMNS, rows: ROWS })
    // The thead element should have sticky positioning + opaque bg.
    expect(html).toMatch(/<thead[^>]*class="[^"]*\bsticky\b[^"]*"/)
    expect(html).toMatch(/<thead[^>]*class="[^"]*\bbg-background\b[^"]*"/)
  })

  it('every body row has the group/row hover class', () => {
    const html = htmlFor({ columns: COLUMNS, rows: ROWS })
    // Two data rows + one "add row" → expect at least 2 group/row matches.
    const matches = html.match(/group\/row/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

describe('[COMP:views/table] Phase 3 frozen first column', () => {
  it('first body cell is sticky-left when freezeFirstColumn defaults to true', () => {
    const html = htmlFor({ columns: COLUMNS, rows: ROWS })
    // Look for a td with both `sticky` and a left offset style on its
    // attributes. The exact left value comes from GUTTER_PX (24) — the
    // frozen first column is offset by the drag-handle gutter width.
    expect(html).toMatch(/<td[^>]*class="[^"]*\bsticky\b[^"]*"[^>]*style="[^"]*left:\s*24/)
  })

  it('first body cell is NOT sticky-left when freezeFirstColumn is false', () => {
    const html = htmlFor({
      columns: COLUMNS,
      rows: ROWS,
      freezeFirstColumn: false,
    })
    // The only sticky tds remaining should be the gutter column, which
    // pins via the `left-0` utility class (not an inline `left:` style).
    // Concretely: no data-cell td should carry the GUTTER_PX (24) inline
    // left offset that the frozen first column would otherwise get.
    expect(html).not.toMatch(/<td[^>]*style="[^"]*left:\s*24/)
  })
})

describe('[COMP:views/table] Phase 3 add-row affordance', () => {
  it('renders the "+ Add row" tr only when onAction is provided', () => {
    const withHandler = htmlFor({
      columns: COLUMNS,
      rows: ROWS,
      onAction: () => undefined,
    })
    expect(withHandler).toMatch(/Add row/)

    const withoutHandler = htmlFor({ columns: COLUMNS, rows: ROWS })
    expect(withoutHandler).not.toMatch(/Add row/)
  })
})
