/**
 * [COMP:views/property-last-edited-by] Auto-metadata `last_edited_by`
 * property — read-only workspace-member pill mirroring `created_by`
 * (same Cell shape, distinct Icon).
 */

import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { A2UIRowValue } from '../types.js'
import { LastEditedByProperty } from '../properties/last-edited-by.js'

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

describe('[COMP:views/property-last-edited-by] last_edited_by property', () => {
  const { Cell, Editor, Icon, sortFn } = LastEditedByProperty

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders a span wrapping avatar + name for a PersonWidget', () => {
    const el = Cell({
      value: { type: 'person', id: 'wm_2', name: 'Bob', initials: 'B' },
    })
    expect(elName(el)).toBe('span')
  })

  it('Cell uses an <img> avatar when avatarUrl is supplied', () => {
    const el = Cell({
      value: {
        type: 'person',
        id: 'wm_2',
        name: 'Bob',
        avatarUrl: 'https://example.com/bob.png',
      },
    })
    const wrapper = el as ReactElement & { props: { children?: unknown } }
    const children = wrapper.props.children as ReactElement[]
    // With an avatarUrl the first slot is an <img>.
    expect(elName(children[0])).toBe('img')
  })

  it('Editor is read-only — no input/select affordance', () => {
    const editorHtml = renderToStaticMarkup(
      React.createElement(Editor!, {
        value: { type: 'person', id: 'wm_2', name: 'Bob', initials: 'B' },
        onCommit: vi.fn(),
        onCancel: vi.fn(),
      }),
    )
    expect(editorHtml).not.toMatch(/<(input|select|textarea)\b/)
    expect(editorHtml).toContain('Bob')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders alphabetically by name with nulls last', () => {
    const v: A2UIRowValue[] = [
      { type: 'person', id: '3', name: 'Charlie' },
      null,
      { type: 'person', id: '1', name: 'Alice' },
      { type: 'person', id: '2', name: 'Bob' },
    ]
    v.sort(sortFn)
    expect((v[0] as { name: string }).name).toBe('Alice')
    expect((v[1] as { name: string }).name).toBe('Bob')
    expect((v[2] as { name: string }).name).toBe('Charlie')
    expect(v[3]).toBeNull()
  })
})
