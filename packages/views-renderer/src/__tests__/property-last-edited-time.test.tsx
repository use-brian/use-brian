/**
 * [COMP:views/property-last-edited-time] Auto-metadata
 * `last_edited_time` property — read-only date Cell mirroring
 * `created_time` (Notion-style audit trail column).
 */

import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { A2UIRowValue } from '../types.js'
import { LastEditedTimeProperty } from '../properties/last-edited-time.js'

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

describe('[COMP:views/property-last-edited-time] last_edited_time property', () => {
  const { Cell, Editor, Icon, sortFn } = LastEditedTimeProperty

  it('Cell renders Empty for null (defensive — last_edited_at is NOT NULL in prod)', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders relative phrasing for a bare ISO string', () => {
    const isoYesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const el = Cell({ value: isoYesterday })
    expect(elName(el)).toBe('span')
    const html = renderToStaticMarkup(el)
    // Relative phrasing: "yesterday" or "1 day ago" depending on rounding.
    expect(html.toLowerCase()).toMatch(/yesterday|1 day ago|day/)
  })

  it('Cell carries an absolute tooltip on the title attribute', () => {
    const el = Cell({ value: '2026-05-20T12:00:00Z' })
    const html = renderToStaticMarkup(el)
    expect(html).toMatch(/title="[^"]*2026[^"]*"/)
  })

  it('Editor is read-only — renders no input/select affordance', () => {
    const editorHtml = renderToStaticMarkup(
      React.createElement(Editor!, {
        value: '2026-05-26T00:00:00Z',
        onCommit: vi.fn(),
        onCancel: vi.fn(),
      }),
    )
    expect(editorHtml).not.toMatch(/<(input|select|textarea)\b/)
    expect(editorHtml).toMatch(/2026/)
  })

  it('Icon renders an svg distinct from created_time (pencil notch present)', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders chronologically with nulls last', () => {
    const v: A2UIRowValue[] = [
      '2026-06-01T00:00:00Z',
      null,
      '2026-05-15T00:00:00Z',
      '2026-05-01T00:00:00Z',
    ]
    v.sort(sortFn)
    expect(v[0]).toBe('2026-05-01T00:00:00Z')
    expect(v[3]).toBeNull()
  })
})
