/**
 * [COMP:views/properties] Property-module dispatch — Cell shape, Icon
 * presence, sortFn ordering, and (Phase 2) Editor render shape + commit
 * semantics.
 *
 * No DOM is installed in this workspace; we inspect React element trees
 * (shallow) for the Cell + Icon tests and use `react-dom/server`'s
 * `renderToStaticMarkup` to assert the Editor's rendered tag/value when
 * we need to walk through hooks.
 */

import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { A2UIRowValue } from '../types.js'
import { PROPERTIES } from '../properties/index.js'

function isEmptyMarker(el: ReactElement): boolean {
  // Empty component is the `<span>—</span>` wrapper.
  if (typeof el.type === 'function') {
    return (el.type as { name?: string }).name === 'Empty'
  }
  return false
}

function elName(el: ReactElement): string {
  if (typeof el.type === 'string') return el.type
  if (typeof el.type === 'function') return (el.type as { name?: string }).name ?? 'anonymous'
  return String(el.type)
}

/**
 * Pluck the first tag occurrence out of a static-markup string. The
 * Editors all render a single input/select rooted at the top level (the
 * tags Editor wraps in a div — we still pluck its inner input
 * separately when needed). Returns `null` when the tag isn't present.
 */
function pluckTag(html: string, tag: 'input' | 'select' | 'textarea'): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>`))
  return m ? m[0] : null
}

/**
 * Extract a `<textarea>`'s rendered value. React renders a controlled
 * textarea's value as its text *content* (`<textarea>…</textarea>`), not a
 * `value="…"` attribute — so the input-style `pluckAttr(tag, 'value')` won't
 * find it. Returns `null` when no textarea is present.
 */
function pluckTextareaValue(html: string): string | null {
  const m = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)
  return m ? m[1] : null
}

function pluckAttr(tagHtml: string, attr: string): string | null {
  const m = tagHtml.match(new RegExp(`${attr}="([^"]*)"`))
  return m ? m[1] : null
}

/**
 * Render an Editor to its initial-paint HTML using React 19's server
 * renderer. Hooks fire on the server pass — `useState` initial values
 * land in the markup; `useEffect` does NOT (acceptable: focus/select
 * are post-mount side effects we don't assert on).
 */
function renderEditorHtml(
  Editor: (props: import('../properties/types.js').PropertyEditorProps) => ReactElement | null,
  props: import('../properties/types.js').PropertyEditorProps,
): string {
  const el = React.createElement(Editor as React.FC<typeof props>, props)
  return renderToStaticMarkup(el)
}

// ── text ────────────────────────────────────────────────────────────

describe('[COMP:views/property-text] text property', () => {
  const { Cell, sortFn, Icon } = PROPERTIES.text!

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders Empty for empty string', () => {
    expect(isEmptyMarker(Cell({ value: '' }))).toBe(true)
  })

  it('Cell renders a span for a string value', () => {
    expect(elName(Cell({ value: 'Buy milk' }))).toBe('span')
  })

  it('Cell coerces numbers to text', () => {
    expect(elName(Cell({ value: 42 }))).toBe('span')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn sorts strings lexically with nulls last', () => {
    const v: A2UIRowValue[] = ['banana', null, 'apple', 'cherry']
    v.sort(sortFn)
    expect(v).toEqual(['apple', 'banana', 'cherry', null])
  })
})

// ── select ──────────────────────────────────────────────────────────

describe('[COMP:views/property-select] select property', () => {
  const { Cell, sortFn, Icon } = PROPERTIES.select!

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders a Badge for a BadgeWidget', () => {
    const el = Cell({ value: { type: 'badge', text: 'todo', tone: 'default' } })
    expect(elName(el)).toBe('Badge')
  })

  it('Cell renders a Badge for a bare string', () => {
    const el = Cell({ value: 'done' })
    expect(elName(el)).toBe('Badge')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders by badge text, nulls last', () => {
    const v: A2UIRowValue[] = [
      { type: 'badge', text: 'done' },
      null,
      { type: 'badge', text: 'blocked' },
    ]
    v.sort(sortFn)
    expect((v[0] as { text: string }).text).toBe('blocked')
    expect(v[2]).toBeNull()
  })
})

// ── tags ────────────────────────────────────────────────────────────

describe('[COMP:views/property-tags] tags property', () => {
  const { Cell, sortFn, Icon } = PROPERTIES.tags!

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders Empty for an empty Container', () => {
    const el = Cell({ value: { type: 'container', direction: 'row', children: [] } })
    expect(isEmptyMarker(el)).toBe(true)
  })

  it('Cell renders a wrapper span with Badge children for a tag list', () => {
    const el = Cell({
      value: {
        type: 'container',
        direction: 'row',
        children: [
          { type: 'badge', text: 'urgent' },
          { type: 'badge', text: 'design' },
        ],
      },
    })
    expect(elName(el)).toBe('span')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders by tag count then alphabetically', () => {
    const a: A2UIRowValue = {
      type: 'container', direction: 'row',
      children: [{ type: 'badge', text: 'a' }, { type: 'badge', text: 'b' }],
    }
    const b: A2UIRowValue = {
      type: 'container', direction: 'row',
      children: [{ type: 'badge', text: 'a' }],
    }
    expect(sortFn(a, b)).toBeGreaterThan(0)
    expect(sortFn(b, a)).toBeLessThan(0)
  })
})

// ── person ──────────────────────────────────────────────────────────

describe('[COMP:views/property-person] person property', () => {
  const { Cell, sortFn, Icon } = PROPERTIES.person!

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders a span wrapping avatar + name for a PersonWidget', () => {
    const el = Cell({
      value: { type: 'person', id: 'wm_1', name: 'Alice', initials: 'A' },
    })
    expect(elName(el)).toBe('span')
  })

  it('Cell falls back to initials wrapper when no avatarUrl', () => {
    const el = Cell({
      value: { type: 'person', id: 'wm_1', name: 'Alice', initials: 'A' },
    })
    // The avatar slot should be a styled <span> (initials), not <img>.
    const wrapper = el as ReactElement & { props: { children?: unknown } }
    const children = wrapper.props.children as ReactElement[]
    expect(elName(children[0])).toBe('span')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders by name with nulls last', () => {
    const v: A2UIRowValue[] = [
      { type: 'person', id: '2', name: 'Bob' },
      null,
      { type: 'person', id: '1', name: 'Alice' },
    ]
    v.sort(sortFn)
    expect((v[0] as { name: string }).name).toBe('Alice')
    expect(v[2]).toBeNull()
  })
})

// ── relation ────────────────────────────────────────────────────────

describe('[COMP:views/property-relation] relation property', () => {
  const { Cell, sortFn, Icon } = PROPERTIES.relation!

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders a button for a RelationWidget', () => {
    const el = Cell({
      value: { type: 'relation', entityType: 'company', id: 'co_1', label: 'Acme' },
    })
    expect(elName(el)).toBe('button')
  })

  it('Cell button is disabled when no onAction supplied', () => {
    const el = Cell({
      value: { type: 'relation', entityType: 'company', id: 'co_1', label: 'Acme' },
    })
    const btn = el as ReactElement & { props: { disabled?: boolean } }
    expect(btn.props.disabled).toBe(true)
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders by label with nulls last', () => {
    const v: A2UIRowValue[] = [
      { type: 'relation', entityType: 'company', id: '2', label: 'Beta' },
      null,
      { type: 'relation', entityType: 'company', id: '1', label: 'Alpha' },
    ]
    v.sort(sortFn)
    expect((v[0] as { label: string }).label).toBe('Alpha')
    expect(v[2]).toBeNull()
  })
})

// ── date ────────────────────────────────────────────────────────────

describe('[COMP:views/property-date] date property', () => {
  const { Cell, sortFn, Icon } = PROPERTIES.date!

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders Empty for DateWidget with null iso', () => {
    expect(isEmptyMarker(Cell({ value: { type: 'date', iso: null } }))).toBe(true)
  })

  it('Cell renders a span for a valid DateWidget', () => {
    const el = Cell({ value: { type: 'date', iso: '2026-05-26T00:00:00Z', format: 'absolute' } })
    expect(elName(el)).toBe('span')
  })

  it('Cell wraps a bare ISO string into a DateWidget', () => {
    const el = Cell({ value: '2026-05-26T00:00:00Z' })
    expect(elName(el)).toBe('span')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders by ISO with nulls last', () => {
    const v: A2UIRowValue[] = [
      { type: 'date', iso: '2026-06-01T00:00:00Z' },
      null,
      { type: 'date', iso: '2026-05-01T00:00:00Z' },
      { type: 'date', iso: null },
    ]
    v.sort(sortFn)
    expect((v[0] as { iso: string }).iso).toBe('2026-05-01T00:00:00Z')
    expect((v[1] as { iso: string }).iso).toBe('2026-06-01T00:00:00Z')
    // Trailing slots both represent "no date" — either the bare null or
    // the null-iso widget. Just check neither has a usable iso.
    const tailIsos = [v[2], v[3]].map((x) => {
      if (x === null) return null
      return typeof x === 'object' && x.type === 'date' ? x.iso : 'unexpected'
    })
    expect(tailIsos.every((x) => x === null)).toBe(true)
  })
})

// ── number ──────────────────────────────────────────────────────────

describe('[COMP:views/property-number] number property', () => {
  const { Cell, sortFn, Icon } = PROPERTIES.number!

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders Empty for NumberWidget with null value', () => {
    expect(isEmptyMarker(Cell({ value: { type: 'number', value: null } }))).toBe(true)
  })

  it('Cell renders a span for a valid NumberWidget', () => {
    expect(elName(Cell({ value: { type: 'number', value: 1234.5 } }))).toBe('span')
  })

  it('Cell wraps a bare finite number into a NumberWidget', () => {
    expect(elName(Cell({ value: 42 }))).toBe('span')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders numerically with nulls last', () => {
    const v: A2UIRowValue[] = [
      { type: 'number', value: 100 },
      null,
      { type: 'number', value: 10 },
      { type: 'number', value: null },
    ]
    v.sort(sortFn)
    expect((v[0] as { value: number }).value).toBe(10)
    expect((v[1] as { value: number }).value).toBe(100)
  })
})

// ── Editor tests (Phase 2) ──────────────────────────────────────────
//
// The Editors use React hooks (`useState`, `useEffect`, `useRef`) — we
// cannot invoke them as plain functions. Instead we rely on the React
// 19 server renderer (`renderToStaticMarkup`) to drive the initial
// hook pass and emit a static HTML string we can grep for the rendered
// tag + initial value. Event handlers are not present in the output;
// commit/cancel behaviour is exercised via the helpers each Editor
// exports for pure-logic testing where applicable.

describe('[COMP:views/property-text] text Editor', () => {
  const { Editor } = PROPERTIES.text!

  it('renders an auto-growing <textarea> seeded from the value', () => {
    const html = renderEditorHtml(Editor!, {
      value: 'Buy milk',
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    // Whole-title editing (Notion cell feel) renders a multi-line textarea,
    // not a single-line <input>.
    expect(pluckTag(html, 'textarea')).not.toBeNull()
    expect(pluckTag(html, 'input')).toBeNull()
    expect(pluckTextareaValue(html)).toBe('Buy milk')
  })

  it('renders an empty textarea when the value is null', () => {
    const html = renderEditorHtml(Editor!, {
      value: null,
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    expect(pluckTag(html, 'textarea')).not.toBeNull()
    expect(pluckTextareaValue(html)).toBe('')
  })
})

describe('[COMP:views/property-select] select Editor', () => {
  const { Editor } = PROPERTIES.select!

  it('renders a <select> when hints.options are supplied', () => {
    const html = renderEditorHtml(Editor!, {
      value: 'todo',
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      hints: { options: ['todo', 'in_progress', 'done'] },
    })
    const select = pluckTag(html, 'select')
    expect(select).not.toBeNull()
    // Each option appears (React 19 server may add a `selected` attr on
    // the matching one — don't pin on the closing-tag boundary).
    expect(html).toMatch(/<option value="todo"[^>]*>todo<\/option>/)
    expect(html).toMatch(/<option value="done"[^>]*>done<\/option>/)
    expect(html).toMatch(/<option value="in_progress"[^>]*>in_progress<\/option>/)
  })

  it('falls back to <input> when no options hint is supplied', () => {
    const html = renderEditorHtml(Editor!, {
      value: 'whatever',
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    const input = pluckTag(html, 'input')
    expect(input).not.toBeNull()
    expect(pluckAttr(input!, 'value')).toBe('whatever')
  })
})

describe('[COMP:views/property-tags] tags Editor', () => {
  const { Editor } = PROPERTIES.tags!

  it('renders existing tags as removable chips', () => {
    const value: A2UIRowValue = {
      type: 'container',
      direction: 'row',
      children: [
        { type: 'badge', text: 'urgent' },
        { type: 'badge', text: 'design' },
      ],
    }
    const html = renderEditorHtml(Editor!, {
      value,
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    expect(html).toContain('urgent')
    expect(html).toContain('design')
    // Remove buttons (`×`) per chip.
    expect((html.match(/×/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // Underlying input is present for typing new tags.
    expect(pluckTag(html, 'input')).not.toBeNull()
  })

  it('renders just an input when value is null', () => {
    const html = renderEditorHtml(Editor!, {
      value: null,
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    expect(pluckTag(html, 'input')).not.toBeNull()
  })
})

describe('[COMP:views/property-person] person Editor', () => {
  const { Editor } = PROPERTIES.person!

  it('returns null when no members hint is supplied', () => {
    const el = Editor!({
      value: { type: 'person', id: 'wm_1', name: 'Alice' },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    expect(el).toBeNull()
  })

  it('renders a <select> over hint.members when supplied', () => {
    const html = renderEditorHtml(Editor!, {
      value: { type: 'person', id: 'wm_1', name: 'Alice' },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      hints: {
        members: [
          { type: 'person', id: 'wm_1', name: 'Alice' },
          { type: 'person', id: 'wm_2', name: 'Bob' },
        ],
      },
    })
    const select = pluckTag(html, 'select')
    expect(select).not.toBeNull()
    expect(html).toContain('Alice')
    expect(html).toContain('Bob')
  })
})

describe('[COMP:views/property-relation] relation Editor', () => {
  const { Editor } = PROPERTIES.relation!

  it('returns null when no relationOptions hint is supplied', () => {
    const el = Editor!({
      value: { type: 'relation', entityType: 'company', id: 'co_1', label: 'Acme' },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    expect(el).toBeNull()
  })

  it('renders a <select> over hint.relationOptions', () => {
    const html = renderEditorHtml(Editor!, {
      value: { type: 'relation', entityType: 'company', id: 'co_1', label: 'Acme' },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      hints: {
        relationOptions: [
          { type: 'relation', entityType: 'company', id: 'co_1', label: 'Acme' },
          { type: 'relation', entityType: 'company', id: 'co_2', label: 'Beta' },
        ],
      },
    })
    expect(pluckTag(html, 'select')).not.toBeNull()
    expect(html).toContain('Acme')
    expect(html).toContain('Beta')
  })
})

describe('[COMP:views/property-date] date Editor', () => {
  const { Editor } = PROPERTIES.date!

  it('renders <input type="date"> for absolute format', () => {
    const html = renderEditorHtml(Editor!, {
      value: { type: 'date', iso: '2026-05-26T00:00:00Z', format: 'absolute' },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      hints: { dateFormat: 'absolute' },
    })
    const input = pluckTag(html, 'input')
    expect(pluckAttr(input!, 'type')).toBe('date')
    const v = pluckAttr(input!, 'value') ?? ''
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('renders <input type="datetime-local"> for datetime hint', () => {
    const html = renderEditorHtml(Editor!, {
      value: { type: 'date', iso: '2026-05-26T10:30:00Z', format: 'datetime' },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      hints: { dateFormat: 'datetime' },
    })
    const input = pluckTag(html, 'input')
    expect(pluckAttr(input!, 'type')).toBe('datetime-local')
    const v = pluckAttr(input!, 'value') ?? ''
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })

  it('renders an empty input when the iso is null', () => {
    const html = renderEditorHtml(Editor!, {
      value: { type: 'date', iso: null },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    const input = pluckTag(html, 'input')
    expect(pluckAttr(input!, 'value')).toBe('')
  })
})

describe('[COMP:views/property-number] number Editor', () => {
  const { Editor } = PROPERTIES.number!

  it('renders <input type="number"> seeded from the widget value', () => {
    const html = renderEditorHtml(Editor!, {
      value: { type: 'number', value: 1234.5 },
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    const input = pluckTag(html, 'input')
    expect(pluckAttr(input!, 'type')).toBe('number')
    expect(pluckAttr(input!, 'value')).toBe('1234.5')
  })

  it('handles bare numeric values via the widget coercion path', () => {
    const html = renderEditorHtml(Editor!, {
      value: 42,
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    const input = pluckTag(html, 'input')
    expect(pluckAttr(input!, 'value')).toBe('42')
  })

  it('renders empty when the value is null', () => {
    const html = renderEditorHtml(Editor!, {
      value: null,
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    const input = pluckTag(html, 'input')
    expect(pluckAttr(input!, 'value')).toBe('')
  })
})
