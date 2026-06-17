/**
 * [COMP:views/property-created-time] Auto-metadata `created_time`
 * property — read-only date Cell with relative-by-default formatting,
 * absolute hover tooltip, chronological sortFn.
 */

import React, { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { A2UIRowValue } from '../types.js'
import { CreatedTimeProperty, __test } from '../properties/created-time.js'

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

describe('[COMP:views/property-created-time] created_time property', () => {
  const { Cell, Editor, Icon, sortFn } = CreatedTimeProperty

  it('Cell renders Empty for null', () => {
    expect(isEmptyMarker(Cell({ value: null }))).toBe(true)
  })

  it('Cell renders relative phrasing by default for a bare ISO string', () => {
    // Pin "now" against a real ISO so the assertion stays stable.
    const isoTwoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const el = Cell({ value: isoTwoHoursAgo })
    expect(elName(el)).toBe('span')
    const html = renderToStaticMarkup(el)
    // RelativeTimeFormat output varies by locale but the phrase always
    // contains "hour" (en) — and the absolute tooltip always lands in title=.
    expect(html.toLowerCase()).toMatch(/hour/)
    expect(html).toMatch(/title="[^"]+"/)
  })

  it('Cell honours an explicit absolute format hint on the wrapped widget', () => {
    const el = Cell({
      value: { type: 'date', iso: '2026-05-26T00:00:00Z', format: 'absolute' },
    })
    const html = renderToStaticMarkup(el)
    // Absolute format renders the year + a month abbreviation; never a
    // relative phrase.
    expect(html).toMatch(/2026/)
    expect(html.toLowerCase()).not.toMatch(/ago|in \d/)
  })

  it('Editor is read-only — same JSX as Cell (no input/textarea/select)', () => {
    const initial = '2026-05-26T00:00:00Z'
    const editorHtml = renderToStaticMarkup(
      React.createElement(Editor!, {
        value: initial,
        onCommit: vi.fn(),
        onCancel: vi.fn(),
      }),
    )
    // No edit affordance — no input/select/textarea anywhere in the rendered
    // tree.
    expect(editorHtml).not.toMatch(/<(input|select|textarea)\b/)
    // Still renders the value (the Cell shape).
    expect(editorHtml).toMatch(/2026/)
  })

  it('Icon renders an svg', () => {
    expect(elName(Icon({}))).toBe('svg')
  })

  it('sortFn orders chronologically with nulls last', () => {
    const v: A2UIRowValue[] = [
      '2026-06-01T00:00:00Z',
      null,
      '2026-05-01T00:00:00Z',
      '2026-05-15T00:00:00Z',
    ]
    v.sort(sortFn)
    // Oldest first by default (ASC). Nulls drift to the end.
    expect(v[0]).toBe('2026-05-01T00:00:00Z')
    expect(v[1]).toBe('2026-05-15T00:00:00Z')
    expect(v[2]).toBe('2026-06-01T00:00:00Z')
    expect(v[3]).toBeNull()
  })
})

describe('[COMP:views/property-created-time] helpers', () => {
  it('formatRelative produces an "in"-prefixed phrase for future timestamps', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const out = __test.formatRelative(future, new Date()).toLowerCase()
    expect(out).toMatch(/in 1 hour|in 1 hour|next hour/)
  })

  it('formatAbsolute returns the localized year for a valid ISO', () => {
    expect(__test.formatAbsolute('2026-05-26T00:00:00Z')).toMatch(/2026/)
  })

  it('asTime coerces a bare ISO string into the canonical shape', () => {
    expect(__test.asTime('2026-05-26T00:00:00Z')).toEqual({
      iso: '2026-05-26T00:00:00Z',
    })
  })
})
