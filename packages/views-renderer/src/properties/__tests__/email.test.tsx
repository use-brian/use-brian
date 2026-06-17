/**
 * [COMP:views/property-email] Email property — Cell render (empty vs
 * mailto anchor), Editor renders <input type="email">, Icon presence,
 * sortFn ordering, validation accept/reject.
 */

import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { A2UIRowValue } from '../../types.js'
import { EmailProperty, __test } from '../email.js'
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
  return renderToStaticMarkup(React.createElement(EmailProperty.Editor as React.FC<PropertyEditorProps>, props))
}

describe('[COMP:views/property-email] email property', () => {
  const { Cell, sortFn, Icon } = EmailProperty

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders Empty for an empty string', () => {
    expect(isEmptyMarker(Cell({ value: '' }))).toBe(true)
  })

  it('Cell renders an <a href="mailto:..."> for a populated value', () => {
    const el = Cell({ value: 'alice@example.com' })
    expect(elName(el)).toBe('a')
    const a = el as ReactElement & { props: { href: string } }
    expect(a.props.href).toBe('mailto:alice@example.com')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders alphabetically (case-insensitive) with nulls last', () => {
    const v: A2UIRowValue[] = ['bob@example.com', null, 'Alice@example.com', 'carl@example.com']
    v.sort(sortFn)
    expect(v[0]).toBe('Alice@example.com')
    expect(v[1]).toBe('bob@example.com')
    expect(v[3]).toBeNull()
  })

  it('isValidEmail accepts well-formed addresses', () => {
    expect(__test.isValidEmail('alice@example.com')).toBe(true)
    expect(__test.isValidEmail('a.b+c@sub.example.co')).toBe(true)
    expect(__test.isValidEmail('123@456.789')).toBe(true)
  })

  it('isValidEmail rejects malformed addresses', () => {
    expect(__test.isValidEmail('alice')).toBe(false)
    expect(__test.isValidEmail('alice@')).toBe(false)
    expect(__test.isValidEmail('@example.com')).toBe(false)
    expect(__test.isValidEmail('alice@example')).toBe(false)
    expect(__test.isValidEmail('alice example@example.com')).toBe(false)
    expect(__test.isValidEmail('')).toBe(false)
  })

  it('Editor renders <input type="email"> seeded from the value', () => {
    const html = renderEditorHtml({
      value: 'alice@example.com',
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    const input = pluckTag(html, 'input')
    expect(input).not.toBeNull()
    expect(pluckAttr(input!, 'type')).toBe('email')
    expect(pluckAttr(input!, 'value')).toBe('alice@example.com')
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
