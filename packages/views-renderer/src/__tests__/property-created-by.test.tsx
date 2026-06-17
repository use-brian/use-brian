/**
 * [COMP:views/property-created-by] Auto-metadata `created_by` property —
 * read-only workspace-member pill mirroring the `person` property's
 * Cell shape (server pre-resolves the PersonWidget; the renderer never
 * holds a directory).
 */

import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { A2UIRowValue } from '../types.js'
import { CreatedByProperty } from '../properties/created-by.js'

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

describe('[COMP:views/property-created-by] created_by property', () => {
  const { Cell, Editor, Icon, sortFn } = CreatedByProperty

  it('Cell renders Empty for null (system-seeded rows where created_by IS NULL)', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders a span wrapping avatar + name for a PersonWidget', () => {
    const el = Cell({
      value: { type: 'person', id: 'wm_1', name: 'Alice', initials: 'A' },
    })
    expect(elName(el)).toBe('span')
  })

  it('Cell falls back to initials wrapper when no avatarUrl is supplied', () => {
    const el = Cell({
      value: { type: 'person', id: 'wm_1', name: 'Alice', initials: 'A' },
    })
    const wrapper = el as ReactElement & { props: { children?: unknown } }
    const children = wrapper.props.children as ReactElement[]
    // First slot is the avatar — an `img` when avatarUrl is set, a styled
    // `span` (initials) when it isn't.
    expect(elName(children[0])).toBe('span')
  })

  it('Editor is read-only — same JSX as Cell (no input/select affordance)', () => {
    const editorHtml = renderToStaticMarkup(
      React.createElement(Editor!, {
        value: { type: 'person', id: 'wm_1', name: 'Alice', initials: 'A' },
        onCommit: vi.fn(),
        onCancel: vi.fn(),
      }),
    )
    expect(editorHtml).not.toMatch(/<(input|select|textarea)\b/)
    expect(editorHtml).toContain('Alice')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders alphabetically by name with nulls last', () => {
    const v: A2UIRowValue[] = [
      { type: 'person', id: '2', name: 'Bob' },
      null,
      { type: 'person', id: '1', name: 'Alice' },
    ]
    v.sort(sortFn)
    expect((v[0] as { name: string }).name).toBe('Alice')
    expect((v[1] as { name: string }).name).toBe('Bob')
    expect(v[2]).toBeNull()
  })
})
