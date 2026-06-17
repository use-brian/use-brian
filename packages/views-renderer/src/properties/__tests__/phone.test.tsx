/**
 * [COMP:views/property-phone] Phone property — Cell render (empty vs
 * tel anchor), Editor renders <input type="tel">, Icon presence,
 * sortFn ordering, validation accept/reject.
 */

import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { A2UIRowValue } from '../../types.js'
import { PhoneProperty, __test } from '../phone.js'
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
  return renderToStaticMarkup(React.createElement(PhoneProperty.Editor as React.FC<PropertyEditorProps>, props))
}

describe('[COMP:views/property-phone] phone property', () => {
  const { Cell, sortFn, Icon } = PhoneProperty

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders Empty for empty string', () => {
    expect(isEmptyMarker(Cell({ value: '' }))).toBe(true)
  })

  it('Cell renders an <a href="tel:..."> for a populated value', () => {
    const el = Cell({ value: '+1 (555) 123-4567' })
    expect(elName(el)).toBe('a')
    const a = el as ReactElement & { props: { href: string } }
    // Dial-pad-only characters survive into the href.
    expect(a.props.href).toBe('tel:+1(555)123-4567')
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders by dialable digits with nulls last', () => {
    const v: A2UIRowValue[] = [
      '+1 555-987-6543',
      null,
      '+1 (555) 123-4567',
      '+44 20 7946 0958',
    ]
    v.sort(sortFn)
    expect(v[0]).toBe('+1 (555) 123-4567')
    expect(v[1]).toBe('+1 555-987-6543')
    expect(v[2]).toBe('+44 20 7946 0958')
    expect(v[3]).toBeNull()
  })

  it('isValidPhone accepts dial-pad strings of length >= 5', () => {
    expect(__test.isValidPhone('+15551234567')).toBe(true)
    expect(__test.isValidPhone('555-1234')).toBe(true)
    expect(__test.isValidPhone('+1 (555) 123-4567')).toBe(true)
    expect(__test.isValidPhone('12345')).toBe(true)
  })

  it('isValidPhone rejects too-short or non-dial input', () => {
    expect(__test.isValidPhone('1234')).toBe(false)
    expect(__test.isValidPhone('phone')).toBe(false)
    expect(__test.isValidPhone('call me')).toBe(false)
    expect(__test.isValidPhone('')).toBe(false)
  })

  it('telHref strips characters outside the dial-pad set', () => {
    expect(__test.telHref('+1 (555) 123-4567')).toBe('tel:+1(555)123-4567')
    expect(__test.telHref('555.123.4567')).toBe('tel:5551234567')
  })

  it('Editor renders <input type="tel"> seeded from the value', () => {
    const html = renderEditorHtml({
      value: '+15551234567',
      onCommit: vi.fn(),
      onCancel: vi.fn(),
    })
    const input = pluckTag(html, 'input')
    expect(input).not.toBeNull()
    expect(pluckAttr(input!, 'type')).toBe('tel')
    expect(pluckAttr(input!, 'value')).toBe('+15551234567')
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
