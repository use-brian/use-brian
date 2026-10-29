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
import { PersonProperty } from '../properties/person.js'

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

  it.each([
    {
      label: 'avatar and escaped display name',
      value: { type: 'person', id: 'member_avatar', name: 'Ada & Co', initials: 'ZZ', avatarUrl: 'https://avatar.example/member.png' },
      expected: ['<img src="https://avatar.example/member.png" alt=""', '>Ada &amp; Co</span>'],
      absent: ['>ZZ</span>'],
    },
    {
      label: 'explicit initials instead of the name prefix',
      value: { type: 'person', id: 'member_initials', name: 'Ada', initials: 'ZZ' },
      expected: ['>ZZ</span>', '>Ada</span>'],
      absent: ['<img', '>A</span>'],
    },
    {
      label: 'uppercase name prefix without explicit initials',
      value: { type: 'person', id: 'member_fallback', name: 'dana' },
      expected: ['>D</span>', '>dana</span>'],
      absent: ['<img'],
    },
    {
      label: 'explicit empty initials without inventing a prefix',
      value: { type: 'person', id: 'member_empty_initials', name: 'Ada', initials: '' },
      expected: ['aria-hidden="true"', '>Ada</span>'],
      absent: ['<img', '>A</span>'],
    },
  ] satisfies { label: string; value: A2UIRowValue; expected: string[]; absent: string[] }[])(
    'renders $label in the actual Cell markup',
    ({ value, expected, absent }) => {
      const html = renderToStaticMarkup(Cell({ value }))
      for (const text of expected) expect(html).toContain(text)
      for (const text of absent) expect(html).not.toContain(text)
    },
  )

  it.each([
    { label: 'null', value: null },
    { label: 'unresolved member id', value: 'member_unresolved' },
    { label: 'another widget kind', value: { type: 'text', text: 'Not a member' } },
  ] satisfies { label: string; value: A2UIRowValue }[])(
    'renders only the empty marker for $label',
    ({ value }) => {
      expect(renderToStaticMarkup(Cell({ value }))).toBe('<span class="text-muted-foreground/60">\u2014</span>')
    },
  )

  it('keeps metadata read-only with member hints while Person offers the picker', () => {
    const member = { type: 'person' as const, id: 'member_current', name: 'Current Member', initials: 'CM' }
    const other = { type: 'person' as const, id: 'member_other', name: 'Other Member' }
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const props = { value: member, hints: { members: [member, other] }, onCommit, onCancel }
    const metadataHtml = renderToStaticMarkup(React.createElement(Editor, props))
    expect(metadataHtml).toContain('>CM</span>')
    expect(metadataHtml).toContain('>Current Member</span>')
    expect(metadataHtml).not.toMatch(/<(input|select|textarea|button)\b/)
    expect(metadataHtml).not.toContain('Other Member')

    const personHtml = renderToStaticMarkup(React.createElement(PersonProperty.Editor, props))
    expect(personHtml).toContain('<select')
    expect(personHtml).toContain('<option value="member_current" selected="">Current Member</option>')
    expect(personHtml).toContain('<option value="member_other">Other Member</option>')
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('retains its metadata kind and distinct icon alongside the Person control', () => {
    expect(CreatedByProperty.kind).toBe('created_by')
    expect(PersonProperty.kind).toBe('person')
    const html = renderToStaticMarkup(Icon({ className: 'metadata-icon' }))
    expect(html).toContain('class="metadata-icon"')
    expect(html).toContain('d="M12.5 4v4M10.5 6h4"')
    expect(html).not.toBe(renderToStaticMarkup(PersonProperty.Icon({ className: 'metadata-icon' })))
  })

  it('keeps equal names and unresolved values tied while sorting resolved names first', () => {
    const first = { type: 'person' as const, id: 'member_first', name: 'Alex' }
    const sameName = { type: 'person' as const, id: 'member_second', name: 'Alex', initials: 'AX' }
    const last = { type: 'person' as const, id: 'member_last', name: 'Zoe' }
    const otherWidget: A2UIRowValue = { type: 'text', text: 'Aardvark' }
    expect(sortFn(first, first)).toBe(0)
    expect(sortFn(first, sameName)).toBe(0)
    expect(sortFn(null, 'member_unresolved')).toBe(0)
    expect(sortFn(otherWidget, null)).toBe(0)
    expect(sortFn(first, otherWidget)).toBeLessThan(0)
    expect(sortFn(otherWidget, first)).toBeGreaterThan(0)
    const values: A2UIRowValue[] = [null, sameName, 'member_unresolved', last, first, otherWidget]
    values.sort(sortFn)
    expect(values).toEqual([sameName, first, last, null, 'member_unresolved', otherWidget])
  })
})
