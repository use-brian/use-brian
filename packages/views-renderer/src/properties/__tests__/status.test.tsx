/**
 * [COMP:views/property-status] Status property — Cell render shape per
 * group tone, Editor `<optgroup>` structure, sortFn (pending →
 * in_progress → done → unknown → null), empty-state, and schema-aware
 * `validateStatusValue` against the groups schema.
 *
 * Test strategy mirrors `__tests__/properties.test.tsx`:
 *   * Cells are pure functions of value — invoke directly and inspect
 *     the returned React element.
 *   * Editors use hooks — drive them through `renderToStaticMarkup` and
 *     grep the resulting HTML for the expected tags / attributes.
 */

import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { A2UIRowValue } from '../../types.js'
import { PROPERTIES } from '../index.js'
import { StatusProperty, validateStatusValue } from '../status.js'
import type {
  PropertyEditorProps,
  StatusGroupHint,
} from '../types.js'

function elName(el: ReactElement): string {
  if (typeof el.type === 'string') return el.type
  if (typeof el.type === 'function') return (el.type as { name?: string }).name ?? 'anonymous'
  return String(el.type)
}

function isEmptyMarker(el: ReactElement): boolean {
  if (typeof el.type === 'function') {
    return (el.type as { name?: string }).name === 'Empty'
  }
  return false
}

function renderEditorHtml(
  Editor: (props: PropertyEditorProps) => ReactElement | null,
  props: PropertyEditorProps,
): string {
  const el = React.createElement(Editor as React.FC<typeof props>, props)
  return renderToStaticMarkup(el)
}

// ── Fixture schemas ─────────────────────────────────────────────────

const GROUPS: readonly StatusGroupHint[] = [
  {
    id: 'pending',
    label: 'To-do',
    options: [
      { id: 'todo', name: 'Todo' },
      { id: 'backlog', name: 'Backlog' },
    ],
  },
  {
    id: 'in_progress',
    label: 'In progress',
    options: [
      { id: 'doing', name: 'Doing' },
      { id: 'review', name: 'Review' },
    ],
  },
  {
    id: 'done',
    label: 'Done',
    options: [
      { id: 'done', name: 'Done' },
      { id: 'cancelled', name: 'Cancelled' },
    ],
  },
]

// ── Module registration ─────────────────────────────────────────────

describe('[COMP:views/property-status] status property — registry', () => {
  it('is registered in PROPERTIES under "status"', () => {
    expect(PROPERTIES.status).toBe(StatusProperty)
  })

  it('declares kind="status"', () => {
    expect(StatusProperty.kind).toBe('status')
  })
})

// ── Cell ────────────────────────────────────────────────────────────

describe('[COMP:views/property-status] status property — Cell', () => {
  const { Cell } = StatusProperty

  it('renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('renders Empty when widget has null optionId', () => {
    expect(isEmptyMarker(Cell({ value: { type: 'status', optionId: null } }))).toBe(true)
  })

  it('renders a pending-toned pill for pending group', () => {
    const el = Cell({
      value: { type: 'status', optionId: 'todo', groupId: 'pending', label: 'Todo' },
    }) as ReactElement & { props: { style?: { backgroundColor?: string } } }
    expect(elName(el)).toBe('span')
    // Pending uses the muted token.
    expect(el.props.style?.backgroundColor ?? '').toContain('--muted')
  })

  it('renders an in_progress-toned pill (chart-1)', () => {
    const el = Cell({
      value: { type: 'status', optionId: 'doing', groupId: 'in_progress', label: 'Doing' },
    }) as ReactElement & { props: { style?: { backgroundColor?: string } } }
    expect(elName(el)).toBe('span')
    expect(el.props.style?.backgroundColor ?? '').toContain('--chart-1')
  })

  it('renders a done-toned pill (chart-2)', () => {
    const el = Cell({
      value: { type: 'status', optionId: 'done', groupId: 'done', label: 'Done' },
    }) as ReactElement & { props: { style?: { backgroundColor?: string } } }
    expect(elName(el)).toBe('span')
    expect(el.props.style?.backgroundColor ?? '').toContain('--chart-2')
  })

  it('renders a muted placeholder when groupId is missing', () => {
    const el = Cell({
      value: { type: 'status', optionId: 'orphan' },
    }) as ReactElement & { props: { className?: string } }
    expect(elName(el)).toBe('span')
    // No inline style means the unknown-group branch (uses className-only muted token).
    expect(el.props.className ?? '').toContain('muted')
  })

  it('falls back to optionId when label is missing', () => {
    const html = renderToStaticMarkup(
      Cell({ value: { type: 'status', optionId: 'todo', groupId: 'pending' } }),
    )
    expect(html).toContain('todo')
  })

  it('coerces a bare string into the unknown-group placeholder', () => {
    // Bare strings have no resolved groupId — Cell falls through to the
    // muted "unknown" branch and displays the string as the label.
    const html = renderToStaticMarkup(Cell({ value: 'todo' }))
    expect(html).toContain('todo')
  })
})

// ── Editor ──────────────────────────────────────────────────────────

describe('[COMP:views/property-status] status property — Editor', () => {
  const { Editor } = StatusProperty

  it('returns null when no statusGroups hint is supplied', () => {
    const el = Editor!({
      value: { type: 'status', optionId: 'todo' },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    expect(el).toBeNull()
  })

  it('renders a <select> with one <optgroup> per status group', () => {
    const html = renderEditorHtml(Editor!, {
      value: { type: 'status', optionId: 'todo' },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      hints: { statusGroups: GROUPS },
    })
    expect(html).toMatch(/<select[^>]*>/)
    // Each group label appears as an <optgroup label="..."> header.
    expect(html).toMatch(/<optgroup label="To-do"/)
    expect(html).toMatch(/<optgroup label="In progress"/)
    expect(html).toMatch(/<optgroup label="Done"/)
  })

  it('renders each group option as an <option>', () => {
    const html = renderEditorHtml(Editor!, {
      value: null,
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      hints: { statusGroups: GROUPS },
    })
    // Pending group options.
    expect(html).toMatch(/<option value="todo"[^>]*>Todo<\/option>/)
    expect(html).toMatch(/<option value="backlog"[^>]*>Backlog<\/option>/)
    // In-progress group options.
    expect(html).toMatch(/<option value="doing"[^>]*>Doing<\/option>/)
    expect(html).toMatch(/<option value="review"[^>]*>Review<\/option>/)
    // Done group options.
    expect(html).toMatch(/<option value="done"[^>]*>Done<\/option>/)
    expect(html).toMatch(/<option value="cancelled"[^>]*>Cancelled<\/option>/)
  })

  it('includes an empty-value option for clearing', () => {
    const html = renderEditorHtml(Editor!, {
      value: { type: 'status', optionId: 'todo' },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      hints: { statusGroups: GROUPS },
    })
    expect(html).toMatch(/<option value=""/)
  })
})

// ── Icon ────────────────────────────────────────────────────────────

describe('[COMP:views/property-status] status property — Icon', () => {
  it('renders an svg', () => {
    expect(elName(StatusProperty.Icon({}))).toBe('svg')
  })
})

// ── sortFn ──────────────────────────────────────────────────────────

describe('[COMP:views/property-status] status property — sortFn', () => {
  const { sortFn } = StatusProperty

  it('orders pending → in_progress → done', () => {
    const v: A2UIRowValue[] = [
      { type: 'status', optionId: 'done', groupId: 'done' },
      { type: 'status', optionId: 'todo', groupId: 'pending' },
      { type: 'status', optionId: 'doing', groupId: 'in_progress' },
    ]
    v.sort(sortFn)
    expect((v[0] as { groupId: string }).groupId).toBe('pending')
    expect((v[1] as { groupId: string }).groupId).toBe('in_progress')
    expect((v[2] as { groupId: string }).groupId).toBe('done')
  })

  it('breaks group ties by option id (lexical)', () => {
    const v: A2UIRowValue[] = [
      { type: 'status', optionId: 'review', groupId: 'in_progress' },
      { type: 'status', optionId: 'doing', groupId: 'in_progress' },
    ]
    v.sort(sortFn)
    expect((v[0] as { optionId: string }).optionId).toBe('doing')
    expect((v[1] as { optionId: string }).optionId).toBe('review')
  })

  it('sorts unknown-group entries after known-group entries', () => {
    const v: A2UIRowValue[] = [
      { type: 'status', optionId: 'orphan' },
      { type: 'status', optionId: 'doing', groupId: 'in_progress' },
    ]
    v.sort(sortFn)
    expect((v[0] as { groupId?: string }).groupId).toBe('in_progress')
    expect((v[1] as { groupId?: string }).groupId).toBeUndefined()
  })

  it('sorts nulls last', () => {
    const v: A2UIRowValue[] = [
      null,
      { type: 'status', optionId: 'todo', groupId: 'pending' },
      { type: 'status', optionId: null },
    ]
    v.sort(sortFn)
    expect((v[0] as { optionId: string }).optionId).toBe('todo')
    // Both trailing slots represent "no status" — either a bare null or
    // a null-optionId widget. Verify neither has a usable optionId.
    const tailIds = [v[1], v[2]].map((x) => {
      if (x === null) return null
      return typeof x === 'object' && x.type === 'status' ? x.optionId : 'unexpected'
    })
    expect(tailIds.every((x) => x === null)).toBe(true)
  })
})

// ── validate (structural) ────────────────────────────────────────────

describe('[COMP:views/property-status] status property — validate (structural)', () => {
  const validate = StatusProperty.validate!

  it('accepts null', () => {
    expect(validate(null)).toBe(true)
  })

  it('accepts a StatusWidget', () => {
    expect(validate({ type: 'status', optionId: 'todo', groupId: 'pending' })).toBe(true)
  })

  it('accepts a bare string (schema-less fallback)', () => {
    expect(validate('todo')).toBe(true)
  })

  it('rejects unrelated widgets', () => {
    expect(validate({ type: 'badge', text: 'todo' })).toBe(false)
    expect(validate({ type: 'date', iso: '2026-05-28T00:00:00Z' })).toBe(false)
  })
})

// ── validateStatusValue (schema-aware) ───────────────────────────────

describe('[COMP:views/property-status] status property — validateStatusValue', () => {
  it('accepts null', () => {
    expect(validateStatusValue(null, GROUPS)).toBe(true)
  })

  it('accepts a widget with null optionId', () => {
    expect(validateStatusValue({ type: 'status', optionId: null }, GROUPS)).toBe(true)
  })

  it('accepts a widget whose optionId is in one of the groups', () => {
    expect(
      validateStatusValue({ type: 'status', optionId: 'doing', groupId: 'in_progress' }, GROUPS),
    ).toBe(true)
  })

  it('rejects a widget whose optionId is not in any group', () => {
    expect(
      validateStatusValue({ type: 'status', optionId: 'ghost' }, GROUPS),
    ).toBe(false)
  })
})
