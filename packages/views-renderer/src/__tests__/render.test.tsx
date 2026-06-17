/**
 * [COMP:views/render] Renderer dispatch + soft-fail behavior.
 *
 * No DOM; we inspect React.createElement output by walking element trees.
 * For DOM-level assertions add @testing-library/react and a happy-dom
 * environment in vitest.config.ts (deferred — not blocking v1).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ReactElement } from 'react'
import type { A2UIWidget, ViewPayload } from '@sidanclaw/core'
import { ViewRenderer, renderWidget } from '../render.js'

function elementType(el: ReactElement): string {
  const t = el.type
  if (typeof t === 'string') return t
  if (typeof t === 'function') return (t as { name?: string }).name ?? 'anonymous'
  return String(t)
}

describe('[COMP:views/render] renderWidget dispatch', () => {
  it('renders Container for type=container', () => {
    const w: A2UIWidget = { type: 'container', direction: 'column', children: [] }
    const el = renderWidget(w)
    expect(elementType(el)).toBe('Container')
  })

  it('renders Heading for type=heading', () => {
    const el = renderWidget({ type: 'heading', level: 2, text: 'Hello' })
    expect(elementType(el)).toBe('Heading')
  })

  it('renders Text for type=text', () => {
    const el = renderWidget({ type: 'text', text: 'hi' })
    expect(elementType(el)).toBe('Text')
  })

  it('renders Badge for type=badge', () => {
    const el = renderWidget({ type: 'badge', text: 'todo' })
    expect(elementType(el)).toBe('Badge')
  })

  it('renders Button for type=button', () => {
    const el = renderWidget({
      type: 'button',
      text: 'Open',
      action: { id: 'open-entity' },
    })
    expect(elementType(el)).toBe('Button')
  })

  it('renders Image for type=image', () => {
    const el = renderWidget({ type: 'image', src: '/avatar.png', alt: 'avatar' })
    expect(elementType(el)).toBe('Image')
  })

  it('renders Divider for type=divider', () => {
    const el = renderWidget({ type: 'divider' })
    expect(elementType(el)).toBe('Divider')
  })

  it('renders Table for type=table', () => {
    const el = renderWidget({
      type: 'table',
      columns: [{ field: 'title', header: 'Title' }],
      rows: [],
    })
    expect(elementType(el)).toBe('Table')
  })

  it('renders Board for type=board', () => {
    const el = renderWidget({
      type: 'board',
      groupBy: 'status',
      columns: [],
      cardSchema: { type: 'text', text: '{{title}}' },
    })
    expect(elementType(el)).toBe('Board')
  })

  it('renders Kpi for type=kpi', () => {
    const el = renderWidget({ type: 'kpi', label: 'Total', value: 42 })
    expect(elementType(el)).toBe('Kpi')
  })

  it('renders ChartBar for type=chart_bar', () => {
    const el = renderWidget({
      type: 'chart_bar',
      data: [{ label: 'todo', value: 3 }],
    })
    expect(elementType(el)).toBe('ChartBar')
  })

  it('renders ChartLine for type=chart_line', () => {
    const el = renderWidget({
      type: 'chart_line',
      series: [{ name: 'count', points: [{ x: '2026-05-01', y: 1 }] }],
    })
    expect(elementType(el)).toBe('ChartLine')
  })

  it('renders ChartPie for type=chart_pie', () => {
    const el = renderWidget({
      type: 'chart_pie',
      slices: [{ label: 'a', value: 1 }],
    })
    expect(elementType(el)).toBe('ChartPie')
  })

  it('renders Fallback for unknown widget types', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const el = renderWidget({ type: 'mystery' } as unknown as A2UIWidget)
    expect(elementType(el)).toBe('Fallback')
    expect(warnSpy).toHaveBeenCalled() // Fallback emits a warn
    warnSpy.mockRestore()
  })

  it('passes onAction down to Button', () => {
    const onAction = vi.fn()
    const el = renderWidget({
      type: 'button',
      text: 'Open',
      action: { id: 'open' },
    }, onAction)
    expect((el.props as { onAction?: typeof onAction }).onAction).toBe(onAction)
  })

  it('recursively dispatches container children', () => {
    const el = renderWidget({
      type: 'container',
      direction: 'column',
      children: [
        { type: 'heading', level: 1, text: 'A' },
        { type: 'text', text: 'B' },
      ],
    })
    expect(elementType(el)).toBe('Container')
    const children = (el.props as { children: ReactElement[] }).children
    expect(children).toHaveLength(2)
    expect(elementType(children[0])).toBe('Heading')
    expect(elementType(children[1])).toBe('Text')
  })
})

describe('[COMP:views/render] ViewRenderer payload validation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('accepts a valid v0.8 payload', () => {
    const payload: ViewPayload = {
      a2ui: '0.8',
      root: { type: 'text', text: 'hello' },
    }
    const el = ViewRenderer({ payload })
    expect(elementType(el)).toBe('div')
    const inner = (el.props as { children: ReactElement }).children
    expect(elementType(inner)).toBe('Text')
  })

  it('renders an error marker for invalid payloads instead of throwing', () => {
    const bad = { a2ui: '0.9', root: {} } // wrong version
    const el = ViewRenderer({ payload: bad })
    expect(elementType(el)).toBe('div')
    expect((el.props as { 'data-a2ui-error'?: string })['data-a2ui-error']).toBe('invalid-payload')
  })

  it('skips re-validation when validated:true is passed', () => {
    // Crafted payload that would FAIL validation but is accepted because validated=true
    const sneaky = {
      a2ui: '0.8',
      root: { type: 'container', direction: 'column', children: [] },
    } as unknown
    const el = ViewRenderer({ payload: sneaky, validated: true })
    expect(elementType(el)).toBe('div')
    const inner = (el.props as { children: ReactElement }).children
    expect(elementType(inner)).toBe('Container')
  })

  it('passes className through to the wrapper', () => {
    const payload: ViewPayload = {
      a2ui: '0.8',
      root: { type: 'text', text: 'hi' },
    }
    const el = ViewRenderer({ payload, className: 'custom-cls' })
    expect((el.props as { className?: string }).className).toBe('custom-cls')
  })
})
