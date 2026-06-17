/**
 * [COMP:views/property-url] URL property — Cell render (empty vs
 * clickable anchor), Editor onCommit semantics, Icon presence, sortFn
 * ordering, validation accept/reject.
 *
 * Same inspection style as `__tests__/properties.test.tsx`.
 */

import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { A2UIRowValue } from '../../types.js'
import { UrlProperty, __test } from '../url.js'
import type { PropertyEditorProps } from '../types.js'

function isEmptyMarker(el: ReactElement): boolean {
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

function pluckTag(html: string, tag: 'input'): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>`))
  return m ? m[0] : null
}

function pluckAttr(tagHtml: string, attr: string): string | null {
  const m = tagHtml.match(new RegExp(`${attr}="([^"]*)"`))
  return m ? m[1] : null
}

function renderEditorHtml(props: PropertyEditorProps): string {
  return renderToStaticMarkup(React.createElement(UrlProperty.Editor as React.FC<PropertyEditorProps>, props))
}

describe('[COMP:views/property-url] url property', () => {
  const { Cell, sortFn, Icon } = UrlProperty

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders Empty for empty string', () => {
    expect(isEmptyMarker(Cell({ value: '' }))).toBe(true)
  })

  it('Cell renders Empty when the scheme is missing (security: only http/https)', () => {
    expect(isEmptyMarker(Cell({ value: 'javascript:alert(1)' }))).toBe(true)
    expect(isEmptyMarker(Cell({ value: 'not a url at all' }))).toBe(true)
  })

  it('Cell renders an <a> for an https URL', () => {
    const el = Cell({ value: 'https://example.com/foo' })
    expect(elName(el)).toBe('a')
    const a = el as ReactElement & { props: { href: string; target?: string; rel?: string } }
    expect(a.props.href).toBe('https://example.com/foo')
    expect(a.props.target).toBe('_blank')
    expect(a.props.rel).toBe('noopener noreferrer')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders URLs alphabetically with nulls last', () => {
    const v: A2UIRowValue[] = [
      'https://github.com/repo',
      null,
      'https://anthropic.com',
      'https://example.com',
    ]
    v.sort(sortFn)
    expect(v[0]).toBe('https://anthropic.com')
    expect(v[3]).toBeNull()
  })

  it('isValidUrl accepts http and https schemes', () => {
    expect(__test.isValidUrl('http://example.com')).toBe(true)
    expect(__test.isValidUrl('https://example.com/x?y=1')).toBe(true)
  })

  it('isValidUrl rejects other schemes and malformed input', () => {
    expect(__test.isValidUrl('javascript:alert(1)')).toBe(false)
    expect(__test.isValidUrl('mailto:a@b.com')).toBe(false)
    expect(__test.isValidUrl('example.com')).toBe(false)
    expect(__test.isValidUrl('')).toBe(false)
  })

  it('shortLabel strips scheme + www', () => {
    expect(__test.shortLabel('https://www.example.com/path')).toBe('example.com/path')
    expect(__test.shortLabel('https://github.com/')).toBe('github.com')
  })

  it('Editor renders <input type="url"> seeded from the value', () => {
    const html = renderEditorHtml({
      value: 'https://example.com',
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    const input = pluckTag(html, 'input')
    expect(input).not.toBeNull()
    expect(pluckAttr(input!, 'type')).toBe('url')
    expect(pluckAttr(input!, 'value')).toBe('https://example.com')
  })

  it('Editor renders an empty input for null value', () => {
    const html = renderEditorHtml({
      value: null,
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    const input = pluckTag(html, 'input')
    expect(pluckAttr(input!, 'value')).toBe('')
  })
})
