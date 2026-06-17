/**
 * [COMP:views/table] Table widget — column-def derivation + sort behavior.
 *
 * No DOM yet (no @testing-library/react); we verify the dispatch +
 * payload flow by inspecting React.createElement output. TanStack Table's
 * sort logic is exercised through the dispatch integration test in
 * render.test.tsx via a board fixture in Phase 5.
 */

import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { renderWidget } from '../render.js'
import type { TableWidget } from '@sidanclaw/core'

function elementType(el: ReactElement): string {
  const t = el.type
  if (typeof t === 'string') return t
  if (typeof t === 'function') return (t as { name?: string }).name ?? 'anonymous'
  return String(t)
}

const SAMPLE_TABLE: TableWidget = {
  type: 'table',
  columns: [
    { field: 'title', header: 'Title' },
    { field: 'status', header: 'Status' },
    { field: 'due', header: 'Due', width: 120 },
  ],
  rows: [
    {
      id: 't1',
      title: 'Buy milk',
      status: { type: 'badge', text: 'todo', tone: 'default' },
      due: '2026-05-20',
    },
    {
      id: 't2',
      title: 'Email Acme',
      status: { type: 'badge', text: 'in_progress', tone: 'default' },
      due: null,
    },
  ],
  rowAction: { id: 'open-entity', params: { entity: 'tasks' } },
}

describe('[COMP:views/table] Table dispatch', () => {
  it('dispatches Table component for type=table', () => {
    const el = renderWidget(SAMPLE_TABLE)
    expect(elementType(el)).toBe('Table')
  })

  it('forwards columns, rows, rowAction, and onAction to Table props', () => {
    const onAction = () => undefined
    const el = renderWidget(SAMPLE_TABLE, onAction)
    const props = el.props as {
      columns: typeof SAMPLE_TABLE.columns
      rows: typeof SAMPLE_TABLE.rows
      rowAction?: typeof SAMPLE_TABLE.rowAction
      onAction?: typeof onAction
    }
    expect(props.columns).toEqual(SAMPLE_TABLE.columns)
    expect(props.rows).toEqual(SAMPLE_TABLE.rows)
    expect(props.rowAction).toEqual(SAMPLE_TABLE.rowAction)
    expect(props.onAction).toBe(onAction)
  })

  it('handles empty rows without throwing', () => {
    const el = renderWidget({
      type: 'table',
      columns: [{ field: 'title', header: 'Title' }],
      rows: [],
    })
    expect(elementType(el)).toBe('Table')
    expect((el.props as { rows: unknown[] }).rows).toHaveLength(0)
  })

  it('handles columns with width hints', () => {
    const el = renderWidget(SAMPLE_TABLE)
    const cols = (el.props as { columns: { width?: number }[] }).columns
    expect(cols.find((c) => 'width' in c && c.width === 120)).toBeDefined()
  })

  it('rowAction omitted when not provided', () => {
    const el = renderWidget({
      type: 'table',
      columns: [{ field: 'title', header: 'Title' }],
      rows: [{ id: 't1', title: 'Buy milk' }],
    })
    expect((el.props as { rowAction?: unknown }).rowAction).toBeUndefined()
  })
})
