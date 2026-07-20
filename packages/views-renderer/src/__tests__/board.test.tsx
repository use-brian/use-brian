/**
 * [COMP:views/board] Board widget dispatch + interpolation helper.
 *
 * Drag-drop simulation requires DOM testing (deferred — no testing-
 * library in workspace). For now we cover:
 *   - dispatch from renderWidget
 *   - prop forwarding
 *   - interpolateCardSchema substitution
 */

import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import { interpolateCardSchema } from '../widgets/Board.js'
import { renderWidget } from '../render.js'
import type { A2UIWidget, BoardWidget } from '@use-brian/core'

function elementType(el: ReactElement): string {
  const t = el.type
  if (typeof t === 'string') return t
  if (typeof t === 'function') return (t as { name?: string }).name ?? 'anonymous'
  return String(t)
}

const SAMPLE_BOARD: BoardWidget = {
  type: 'board',
  groupBy: 'stage',
  columns: [
    {
      id: 'lead',
      title: 'lead',
      cards: [
        {
          id: 'd1',
          data: {
            name: 'Acme',
            amount: 5000,
            stage: { type: 'badge', text: 'lead', tone: 'default' },
          },
        },
      ],
    },
    {
      id: 'won',
      title: 'won',
      cards: [],
    },
  ],
  cardSchema: {
    type: 'container',
    direction: 'column',
    children: [
      { type: 'text', text: '{{name}}', variant: 'body' },
      { type: 'text', text: '{{amount}}', variant: 'caption' },
    ],
  },
}

describe('[COMP:views/board] Board dispatch', () => {
  it('dispatches Board for type=board', () => {
    const el = renderWidget(SAMPLE_BOARD)
    expect(elementType(el)).toBe('Board')
  })

  it('forwards groupBy / columns / cardSchema / onAction', () => {
    const onAction = () => undefined
    const el = renderWidget(SAMPLE_BOARD, onAction)
    const props = el.props as {
      groupBy: string
      columns: typeof SAMPLE_BOARD.columns
      cardSchema: typeof SAMPLE_BOARD.cardSchema
      onAction?: typeof onAction
    }
    expect(props.groupBy).toBe('stage')
    expect(props.columns).toEqual(SAMPLE_BOARD.columns)
    expect(props.cardSchema).toEqual(SAMPLE_BOARD.cardSchema)
    expect(props.onAction).toBe(onAction)
  })

  it('handles a board with all empty columns', () => {
    const el = renderWidget({
      type: 'board',
      groupBy: 'status',
      columns: [
        { id: 'todo', title: 'todo', cards: [] },
        { id: 'done', title: 'done', cards: [] },
      ],
      cardSchema: { type: 'text', text: '{{title}}' },
    })
    expect(elementType(el)).toBe('Board')
  })
})

describe('[COMP:views/board] interpolateCardSchema', () => {
  it('substitutes {{field}} in text widgets', () => {
    const schema: A2UIWidget = { type: 'text', text: '{{name}}' }
    const out = interpolateCardSchema(schema, { name: 'Buy milk' })
    expect((out as { type: string; text: string }).text).toBe('Buy milk')
  })

  it('substitutes {{field}} for numeric values via String()', () => {
    const schema: A2UIWidget = { type: 'text', text: '{{amount}}' }
    const out = interpolateCardSchema(schema, { amount: 5000 })
    expect((out as { type: string; text: string }).text).toBe('5000')
  })

  it('renders empty string for missing keys', () => {
    const schema: A2UIWidget = { type: 'text', text: 'Owner: {{owner}}' }
    const out = interpolateCardSchema(schema, {})
    expect((out as { type: string; text: string }).text).toBe('Owner: ')
  })

  it('extracts surface text from widget values (badge.text)', () => {
    const schema: A2UIWidget = { type: 'text', text: 'Status: {{status}}' }
    const out = interpolateCardSchema(schema, {
      status: { type: 'badge', text: 'todo' },
    })
    expect((out as { type: string; text: string }).text).toBe('Status: todo')
  })

  it('walks container children recursively', () => {
    const schema: A2UIWidget = {
      type: 'container',
      direction: 'column',
      children: [
        { type: 'text', text: '{{a}}' },
        { type: 'text', text: '{{b}}' },
      ],
    }
    const out = interpolateCardSchema(schema, { a: 'hello', b: 'world' })
    expect(out.type).toBe('container')
    if (out.type !== 'container') return
    expect((out.children[0] as { text: string }).text).toBe('hello')
    expect((out.children[1] as { text: string }).text).toBe('world')
  })

  it('does not mutate the input schema', () => {
    const schema: A2UIWidget = { type: 'text', text: '{{name}}' }
    interpolateCardSchema(schema, { name: 'foo' })
    expect(schema.text).toBe('{{name}}')
  })

  it('substitutes image src + alt', () => {
    const schema: A2UIWidget = {
      type: 'image',
      src: '/avatars/{{userId}}.png',
      alt: 'Avatar of {{userName}}',
    }
    const out = interpolateCardSchema(schema, {
      userId: 'u1',
      userName: 'Alice',
    })
    if (out.type !== 'image') throw new Error('expected image')
    expect(out.src).toBe('/avatars/u1.png')
    expect(out.alt).toBe('Avatar of Alice')
  })
})
